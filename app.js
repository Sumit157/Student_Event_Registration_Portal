'use strict';

/**
 * app.js
 * Express application assembly. Exported as a factory so the automated tests
 * can build an app instance WITHOUT binding a port or starting the scheduler.
 *
 * Security layering (outermost first):
 *   Helmet security headers -> CORS allow-list -> global rate limit ->
 *   body parsing -> cookies -> static assets -> API routes -> error handler.
 */

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');

const { env } = require('./config/env');
const { globalLimiter } = require('./middleware/rate-limit');
const { errorHandler, notFoundHandler } = require('./middleware/error-handler');

function createApp() {
  const app = express();

  // We are behind our own static server; trust the first proxy hop only if one
  // is configured. Keeping this off by default means req.ip is the real peer.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // ---- Security headers ---------------------------------------------------
  app.use(helmet({
    // The frontend is served from this same origin, so a strict same-origin
    // policy is safe and blocks injected third party scripts.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"], // inline <style> used for countdowns
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: env.isProduction ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    hsts: env.isProduction ? { maxAge: 15552000, includeSubDomains: true } : false,
  }));

  // ---- CORS: explicit allow-list only -------------------------------------
  app.use(cors({
    origin(origin, callback) {
      // Allow same-origin / server-side requests that send no Origin header.
      if (!origin) return callback(null, true);
      // Only the configured client origin is permitted; everything else is
      // refused rather than echoed back.
      if (origin === env.clientOrigin) return callback(null, origin);
      return callback(null, false);
    },
    credentials: true,               // needed for the HttpOnly refresh cookie
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 600,
  }));

  // ---- Global rate limiting ----------------------------------------------
  app.use('/api', globalLimiter);

  // ---- Parsers ------------------------------------------------------------
  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));
  app.use(cookieParser());

  // ---- Static frontend ----------------------------------------------------
  // Every HTML file lives in /client and is served at the site root.
  app.use(express.static(env.paths.client, {
    extensions: ['html'],
    index: 'index.html',
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) {
        // HTML must always be revalidated so a deploy is picked up instantly.
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  }));

  // ---- Uploaded avatars ---------------------------------------------------
  // Served from a dedicated route (not the static root) so we can force
  // nosniff and a restrictive content type on user-supplied content.
  app.use('/uploads', express.static(env.paths.uploads, {
    index: false,
    dotfiles: 'deny',
    setHeaders(res) {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; sandbox");
      res.setHeader('Cache-Control', 'public, max-age=86400');
    },
  }));

  // ---- Health probe (Task 1) ---------------------------------------------
  app.get('/api/health', asyncHandlerHealth());

  // ---- API routes ---------------------------------------------------------
  app.use('/api/auth', require('./routes/auth'));
  app.use('/api/events', require('./routes/events'));
  app.use('/api/alumni', require('./routes/alumni'));
  app.use('/api/jobs', require('./routes/jobs'));
  app.use('/api/connections', require('./routes/connections'));
  app.use('/api/news', require('./routes/news'));
  app.use('/api/admin', require('./routes/admin'));
  app.use('/api/profile', require('./routes/profile'));

  // ---- Fallbacks ----------------------------------------------------------
  // Unknown /api paths return JSON, not the SPA.
  app.use('/api', notFoundHandler);
  // Any other GET falls back to the SPA shell so deep links work on reload.
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    return res.sendFile(path.join(env.paths.client, 'index.html'));
  });

  app.use(errorHandler);
  return app;
}

/**
 * Health endpoint. Reports status WITHOUT leaking credentials or config secrets.
 * The DB password is never included; only the redacted describeConfig() output.
 */
function asyncHandlerHealth() {
  const { testConnection } = require('./config/db');
  return async function health(req, res) {
    const payload = {
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
      environment: env.nodeEnv,
      mailMode: env.mail.devMode ? 'dev-console' : 'smtp',
    };
    try {
      payload.database = await testConnection();
    } catch (error) {
      payload.status = 'degraded';
      payload.database = { ok: false, error: error.code || 'CONNECTION_FAILED' };
      return res.status(503).json(payload);
    }
    return res.json(payload);
  };
}

module.exports = { createApp };
