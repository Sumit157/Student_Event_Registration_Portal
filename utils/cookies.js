'use strict';

/**
 * utils/cookies.js
 * One place that decides how the refresh-token cookie is shaped, so the
 * settings cannot drift between login, refresh and logout.
 *
 * The refresh token is the only credential that lives in a cookie, and it is:
 *   HttpOnly  - JavaScript (and therefore any XSS) cannot read it.
 *   Secure    - only sent over HTTPS (enabled automatically in production).
 *   SameSite=Lax - not attached to cross-site POSTs, blocking CSRF for the
 *                  state changing endpoints while still allowing the normal
 *               top-level navigation from emailed links.
 *   Path=/api/auth - the cookie is never sent to any other route, which
 *                  drastically shrinks the surface over which it could leak.
 */

const { env } = require('../config/env');

const REFRESH_COOKIE = 'portal_rt';

function refreshCookieOptions() {
  return {
    httpOnly: true,
    secure: env.isProduction, // localhost is plain http, so keep it off in dev
    sameSite: 'lax',
    path: '/api/auth',
    maxAge: env.jwt.refreshExpiresDays * 24 * 60 * 60 * 1000,
  };
}

function setRefreshCookie(res, token) {
  res.cookie(REFRESH_COOKIE, token, refreshCookieOptions());
}

function clearRefreshCookie(res) {
  res.clearCookie(REFRESH_COOKIE, { ...refreshCookieOptions(), maxAge: undefined });
}

module.exports = { REFRESH_COOKIE, refreshCookieOptions, setRefreshCookie, clearRefreshCookie };
