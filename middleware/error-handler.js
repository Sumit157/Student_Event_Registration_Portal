'use strict';

/**
 * middleware/error-handler.js
 * The single exit point for every error in the application.
 *
 * Guarantees:
 *   * The client NEVER receives a stack trace, SQL text or file path.
 *   * Operational errors (ApiError) return their own message and status.
 *   * Anything else is logged in full on the server and replaced with a
 *     generic 500 message.
 *   * Malformed JSON bodies become a clean 400 rather than an HTML error page.
 */

const { env } = require('../config/env');
const { ApiError } = require('../utils/errors');

/** Map a mysql2 driver error code onto a friendly HTTP response. */
function fromDatabaseError(error) {
  const code = error && error.code;

  switch (code) {
    case 'ER_DUP_ENTRY': {
      // Surface which unique constraint fired when we can tell.
      const message = /email/i.test(error.message || '')
        ? 'That email address is already registered.'
        : 'That record already exists.';
      return ApiError.conflict(message, 'DUPLICATE_RECORD');
    }
    case 'ER_NO_REFERENCED_ROW_2':
      return ApiError.badRequest('A referenced record does not exist.', 'INVALID_REFERENCE');
    case 'ER_ROW_IS_REFERENCED_2':
      return ApiError.conflict('That record is in use and cannot be removed.', 'RECORD_IN_USE');
    case 'ER_BAD_FIELD_ERROR':
    case 'ER_PARSE_ERROR':
      return ApiError.internal('A database query was malformed.', 'DB_QUERY_ERROR');
    case 'ECONNREFUSED':
    case 'ETIMEDOUT':
    case 'PROTOCOL_CONNECTION_LOST':
      return ApiError.internal('The database is currently unavailable. Please try again shortly.', 'DB_UNAVAILABLE');
    default:
      return null;
  }
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, _next) {
  let error = err;

  // Normalise well known non-ApiError failures.
  if (!(error instanceof ApiError)) {
    const dbError = fromDatabaseError(error);
    if (dbError) {
      error = dbError;
    } else if (error && error.type === 'entity.parse.failed') {
      error = ApiError.badRequest('The request body contains malformed JSON.', 'INVALID_JSON');
    } else if (error && error.type === 'entity.too.large') {
      error = ApiError.badRequest('The request body is too large.', 'PAYLOAD_TOO_LARGE');
    } else if (error && error.name === 'MulterError') {
      const map = {
        LIMIT_FILE_SIZE: 'That file is too large.',
        LIMIT_UNEXPECTED_FILE: 'Unexpected file field.',
        LIMIT_FILE_COUNT: 'Too many files.',
      };
      error = ApiError.badRequest(map[error.code] || 'File upload failed.', 'UPLOAD_ERROR');
    } else if (error && error.status && error.status < 500) {
      error = ApiError.badRequest(error.message || 'Bad request.', 'BAD_REQUEST');
    }
  }

  const status = (error && error.statusCode) || 500;

  // 5xx is always a server-side fault: log it properly for the operators.
  if (status >= 500) {
    console.error(`\n[ERROR] ${req.method} ${req.originalUrl} -> ${status}`);
    console.error(error && error.stack ? error.stack : error);
  } else if (env.nodeEnv !== 'test') {
    // 4xx are expected; keep a one line breadcrumb without noisy stacks.
    console.warn(`[warn] ${req.method} ${req.originalUrl} -> ${status} ${error.code || ''} ${error.message || ''}`);
  }

  const body = {
    success: false,
    error: {
      message: status >= 500
        ? 'Something went wrong on our side. Please try again later.'
        : (error && error.message) || 'Request failed.',
      code: (error && error.code) || (status >= 500 ? 'INTERNAL_ERROR' : 'ERROR'),
    },
  };

  // Only ever expose field level detail for 4xx validation failures.
  if (status < 500 && error && error.details) {
    body.error.details = error.details;
  }

  res.status(status).json(body);
}

/** 404 fallback for unknown API routes, mounted after all routers. */
function notFoundHandler(req, res, next) {
  if (res.headersSent) return next(res);
  return res.status(404).json({
    success: false,
    error: { message: `No API route matches ${req.method} ${req.path}.`, code: 'ROUTE_NOT_FOUND' },
  });
}

module.exports = { errorHandler, notFoundHandler };
