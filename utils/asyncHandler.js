'use strict';

/**
 * utils/asyncHandler.js
 * Wraps an async route handler so a rejected promise is forwarded to the
 * centralised error handler instead of hanging the request.
 *
 *   router.get('/', asyncHandler(async (req, res) => { ... }));
 */

function asyncHandler(fn) {
  return function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = { asyncHandler };
