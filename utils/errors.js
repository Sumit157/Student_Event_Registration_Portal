'use strict';

/**
 * utils/errors.js
 * A small hierarchy of operational errors. The centralised error handler in
 * middleware/error-handler.js converts these into safe JSON responses.
 *
 * Anything that is NOT an ApiError (a programming bug) is logged in full on the
 * server but returned to the client as a generic 500 with no stack trace.
 */

class ApiError extends Error {
  constructor(statusCode, message, { code = null, details = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;         // stable machine-readable code, e.g. 'DUPLICATE_EMAIL'
    this.details = details;   // optional field-level validation errors
    this.isOperational = true;
  }

  static badRequest(message, code, details) { return new ApiError(400, message, { code, details }); }
  static unauthorized(message = 'Authentication required.', code = 'UNAUTHENTICATED') {
    return new ApiError(401, message, { code });
  }
  static forbidden(message = 'You do not have permission to perform this action.', code = 'FORBIDDEN') {
    return new ApiError(403, message, { code });
  }
  static notFound(message = 'Resource not found.', code = 'NOT_FOUND') {
    return new ApiError(404, message, { code });
  }
  static conflict(message, code, details) { return new ApiError(409, message, { code, details }); }
  static tooMany(message = 'Too many requests. Please try again later.', code = 'RATE_LIMITED') {
    return new ApiError(429, message, { code });
  }
  static internal(message = 'Something went wrong on our side.', code = 'INTERNAL_ERROR') {
    return new ApiError(500, message, { code });
  }
}

module.exports = { ApiError };
