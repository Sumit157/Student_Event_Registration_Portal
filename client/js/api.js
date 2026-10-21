'use strict';

/**
 * js/api.js
 * The single HTTP client for the whole portal.
 *
 * Session model (mirrors the backend design):
 *   * The ACCESS token lives in a JavaScript variable only - never in
 *     localStorage or sessionStorage. Any injected script can read those, so
 *     keeping the short lived token in memory means an XSS bug cannot mint a
 *     durable session.
 *   * The REFRESH token is in an HttpOnly cookie that JavaScript cannot reach.
 *     On page load (or after a 401) we call /api/auth/refresh, which rotates
 *     that cookie and hands back a fresh access token.
 *
 * When the access token expires mid-session the client transparently refreshes
 * once and replays the original request, so the user never sees a spurious
 * "please sign in again" while they are working.
 */

const Api = (() => {
  /** In-memory only. Deliberately not persisted anywhere a script can read. */
  let accessToken = null;
  let refreshInFlight = null;

  const BASE = '/api';

  // -------------------------------------------------------------------------
  // Token handling
  // -------------------------------------------------------------------------

  function setAccessToken(token) {
    accessToken = token || null;
  }

  function getAccessToken() {
    return accessToken;
  }

  function hasSession() {
    return accessToken !== null;
  }

  /**
   * Exchange the HttpOnly refresh cookie for a new access token.
   * Concurrent callers share one in-flight promise so a burst of parallel
   * requests does not trigger several rotations (which would trip the
   * server-side reuse detector and sign the user out).
   */
  async function refreshSession() {
    if (refreshInFlight) return refreshInFlight;

    refreshInFlight = (async () => {
      try {
        const response = await fetch(`${BASE}/auth/refresh`, {
          method: 'POST',
          credentials: 'include', // required to send the HttpOnly cookie
          headers: { 'Content-Type': 'application/json' },
        });
        const body = await safeJson(response);
        if (response.ok && body && body.success && body.data && body.data.accessToken) {
          accessToken = body.data.accessToken;
          if (body.data.user) {
            Auth.setCachedUser(body.data.user);
          }
          return { ok: true, user: body.data.user };
        }
        accessToken = null;
        Auth.clearCachedUser();
        return { ok: false, error: body };
      } catch (error) {
        accessToken = null;
        return { ok: false, error: { message: 'Could not reach the server.' } };
      } finally {
        // Release the shared promise on the next tick so late callers still
        // see the settled value.
        setTimeout(() => { refreshInFlight = null; }, 0);
      }
    })();

    return refreshInFlight;
  }

  // -------------------------------------------------------------------------
  // Core request
  // -------------------------------------------------------------------------

  async function safeJson(response) {
    const text = await response.text();
    if (!text) return null;
    try { return JSON.parse(text); } catch (_) { return null; }
  }

  /**
   * Perform a request.
   * @param {string} path  path under /api, e.g. "/events"
   * @param {{method?:string, body?:any, auth?:boolean, retry?:boolean, raw?:boolean}} options
   */
  async function request(path, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    const headers = {};
    const init = { method, credentials: 'include', headers };

    if (options.auth !== false && accessToken) {
      headers.Authorization = `Bearer ${accessToken}`;
    }

    if (options.body instanceof FormData) {
      // Let the browser set the multipart boundary itself.
      init.body = options.body;
    } else if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }

    let response;
    try {
      response = await fetch(`${BASE}${path}`, init);
    } catch (networkError) {
      const err = new Error('Could not reach the server. Please check your connection and try again.');
      err.code = 'NETWORK_ERROR';
      err.status = 0;
      throw err;
    }

    // 401 -> try one silent refresh, then replay the request exactly once.
    if (response.status === 401 && options.retry !== false && options.auth !== false) {
      const refreshed = await refreshSession();
      if (refreshed.ok) {
        return request(path, { ...options, retry: false });
      }
    }

    if (options.raw) return response; // caller handles it (e.g. CSV download)

    const body = await safeJson(response);

    if (!response.ok) {
      const error = new Error(
        (body && body.error && body.error.message) || `Request failed (${response.status}).`
      );
      error.status = response.status;
      error.code = body && body.error ? body.error.code : 'ERROR';
      error.details = body && body.error ? body.error.details : undefined;
      throw error;
    }

    return body;
  }

  // -------------------------------------------------------------------------
  // Convenience verbs
  // -------------------------------------------------------------------------

  return {
    get: (path, options) => request(path, { ...options, method: 'GET' }),
    post: (path, body, options) => request(path, { ...options, method: 'POST', body }),
    put: (path, body, options) => request(path, { ...options, method: 'PUT', body }),
    patch: (path, body, options) => request(path, { ...options, method: 'PATCH', body }),
    del: (path, options) => request(path, { ...options, method: 'DELETE' }),
    request,
    refreshSession,
    setAccessToken,
    getAccessToken,
    hasSession,
  };
})();
