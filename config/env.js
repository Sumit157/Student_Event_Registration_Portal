'use strict';

/**
 * config/env.js
 * Single source of truth for configuration. Reads process.env (populated by
 * dotenv) and validates it once at boot so that a misconfiguration fails
 * loudly at startup instead of at the first request.
 *
 * No secret is ever logged or returned by an API response.
 */

require('dotenv').config();

const path = require('path');

/** True only when explicitly running under `npm test`. */
const isTest = process.env.NODE_ENV === 'test';

function toBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

function toInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  isProduction: (process.env.NODE_ENV || 'development') === 'production',
  isTest,

  port: toInt(process.env.PORT, 5000),
  clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:5000',

  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: toInt(process.env.DB_PORT, 3306),
    name: process.env.DB_NAME || 'student_portal',
    user: process.env.DB_USER || 'student_portal_app',
    password: process.env.DB_PASSWORD || '',
    connectionLimit: toInt(process.env.DB_CONNECTION_LIMIT, 10),
  },

  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET || '',
    refreshSecret: process.env.JWT_REFRESH_SECRET || '',
    accessExpires: process.env.JWT_ACCESS_EXPIRES || '15m',
    refreshExpiresDays: toInt(process.env.JWT_REFRESH_EXPIRES_DAYS, 7),
  },

  mail: {
    host: process.env.SMTP_HOST || '',
    port: toInt(process.env.SMTP_PORT, 587),
    secure: toBoolean(process.env.SMTP_SECURE, false),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.MAIL_FROM || 'Student Portal <no-reply@student-portal.local>',
  },

  upload: {
    dir: process.env.UPLOAD_DIR || 'uploads',
    maxBytes: toInt(process.env.MAX_UPLOAD_BYTES, 2 * 1024 * 1024), // 2 MB
  },

  rateLimit: {
    windowMs: toInt(process.env.RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
    max: toInt(process.env.RATE_LIMIT_MAX, 100),
    loginWindowMs: toInt(process.env.LOGIN_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
    loginMax: toInt(process.env.LOGIN_RATE_LIMIT_MAX, 5),
  },

  // Absolute filesystem paths derived from the values above.
  paths: {
    root: path.join(__dirname, '..'),
    client: path.join(__dirname, '..', 'client'),
    uploads: path.resolve(path.join(__dirname, '..', process.env.UPLOAD_DIR || 'uploads')),
  },
};

// SMTP is considered "configured" only when a host and user are present.
env.mail.configured = Boolean(env.mail.host && env.mail.user);
// Development email mode prints messages to the console instead of sending.
env.mail.devMode = !env.mail.configured;

/**
 * Validate the configuration. Returns an array of human readable problems.
 * Secrets are described, never printed.
 */
function validateEnv() {
  const problems = [];

  if (env.isProduction) {
    if (env.jwt.accessSecret.length < 32) {
      problems.push('JWT_ACCESS_SECRET must be at least 32 characters in production.');
    }
    if (env.jwt.refreshSecret.length < 32) {
      problems.push('JWT_REFRESH_SECRET must be at least 32 characters in production.');
    }
    if (env.jwt.accessSecret && env.jwt.accessSecret === env.jwt.refreshSecret) {
      problems.push('JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be different values.');
    }
    if (!env.db.password) {
      problems.push('DB_PASSWORD must be set in production.');
    }
    if (env.db.user === 'root') {
      problems.push('Refusing to run in production as the MySQL root user. Create a least-privilege user.');
    }
  } else {
    // Development: still require usable secrets, but allow generated dev values.
    if (!env.jwt.accessSecret || env.jwt.accessSecret.length < 16) {
      problems.push('JWT_ACCESS_SECRET is missing or shorter than 16 characters. Copy .env.example to .env.');
    }
    if (!env.jwt.refreshSecret || env.jwt.refreshSecret.length < 16) {
      problems.push('JWT_REFRESH_SECRET is missing or shorter than 16 characters. Copy .env.example to .env.');
    }
  }

  return problems;
}

module.exports = { env, validateEnv };
