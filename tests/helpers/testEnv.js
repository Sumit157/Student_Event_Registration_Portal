'use strict';

/**
 * tests/helpers/testEnv.js
 * MUST be required before any application module.
 *
 * config/env.js reads process.env once at import time, so the test harness
 * pins every value it needs here - including real JWT secrets of adequate
 * length - before app.js is ever loaded. NODE_ENV=test also switches off rate
 * limiting so tests cannot trip the 5-attempt login budget.
 */

process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-access-secret-0123456789abcdef0123456789abcdef';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret-fedcba9876543210fedcba9876543210';
process.env.JWT_ACCESS_EXPIRES = '15m';
process.env.JWT_REFRESH_EXPIRES_DAYS = '7';

// Rate limiting is disabled while NODE_ENV === 'test' (see middleware/rate-limit.js).
process.env.RATE_LIMIT_MAX = '1000';
process.env.LOGIN_RATE_LIMIT_MAX = '1000';

// Development email mode: nothing is sent to a real SMTP server in tests.
process.env.SMTP_HOST = '';
process.env.SMTP_USER = '';

module.exports = { ok: true };
