'use strict';

/**
 * middleware/rate-limit.js
 * Two tiers of throttling, both backed by the default in-memory store.
 *
 * IMPORTANT LIMITATION (documented in SECURITY.md): the memory store is
 * per-process. In a multi-instance deployment you would swap in a shared store
 * such as `rate-limit-redis`. For the single-process local deployment this
 * assignment targets it is sufficient and adds no external dependency.
 */

const rateLimit = require('express-rate-limit');
const { env } = require('../config/env');

/** Disable entirely while running automated tests so they never trip it. */
const disabled = env.isTest;

function makeLimiter(name, windowMs, max, message) {
  return rateLimit({
    windowMs,
    max: disabled ? Number.MAX_SAFE_INTEGER : max,
    standardHeaders: true,   // RateLimit-* draft-6 headers
    legacyHeaders: false,
    handler(req, res, _next, options) {
      res.status(options.statusCode).json({
        success: false,
        error: {
          message,
          code: 'RATE_LIMITED',
          retryAfterSeconds: Math.ceil(options.windowMs / 1000),
        },
      });
    },
    keyGenerator(req) {
      // Behind a reverse proxy you would trust X-Forwarded-For here; for the
      // local deployment the socket address is the correct key.
      return req.ip || req.socket?.remoteAddress || 'unknown';
    },
    // Skip the health probe so monitoring never consumes budget.
    skip: (req) => req.path === '/api/health',
  });
}

/** Global budget: 100 requests / 15 minutes per IP. */
const globalLimiter = makeLimiter(
  'global',
  env.rateLimit.windowMs,
  env.rateLimit.max,
  'Too many requests from this device. Please wait a moment and try again.'
);

/** Strict budget for credential endpoints: 5 attempts / 15 minutes per IP. */
const loginLimiter = makeLimiter(
  'login',
  env.rateLimit.loginWindowMs,
  env.rateLimit.loginMax,
  'Too many sign-in attempts. Please wait 15 minutes before trying again.'
);

/** Budget for the forgot-password endpoint so it cannot be used to spam inboxes. */
const resetLimiter = makeLimiter(
  'reset',
  env.rateLimit.loginWindowMs,
  env.rateLimit.loginMax,
  'Too many password reset requests. Please wait 15 minutes before trying again.'
);

/** Budget for account creation. */
const registerLimiter = makeLimiter(
  'register',
  env.rateLimit.windowMs,
  Math.min(env.rateLimit.max, 20),
  'Too many accounts created from this device. Please wait and try again.'
);

module.exports = { globalLimiter, loginLimiter, resetLimiter, registerLimiter };
