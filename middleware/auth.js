'use strict';

/**
 * middleware/auth.js
 * Authentication and role based authorisation.
 *
 * authenticate() does TWO things on every protected request:
 *   1. Verifies the signed access token (stateless, cheap).
 *   2. Re-reads the user row from the database.
 *
 * Step 2 is deliberate: a JWT alone cannot know that an administrator has
 * since suspended the account or demoted the role. Re-checking the row means
 * suspension and role changes take effect immediately rather than after the
 * token expires.
 */

const { getPool } = require('../config/db');
const { verifyAccessToken } = require('../services/tokenService');
const { ApiError } = require('../utils/errors');
const { asyncHandler } = require('../utils/asyncHandler');

/** Extract "Bearer <token>" from the Authorization header. */
function extractBearer(req) {
  // Defensive: behave sanely even if called with a hand-built object in tests.
  const headers = (req && req.headers) || {};
  const header = headers.authorization || headers.Authorization;
  if (!header || typeof header !== 'string') return null;
  // Tolerate repeated whitespace between the scheme and the token.
  const match = /^\s*Bearer\s+(\S+)\s*$/i.exec(header);
  return match ? match[1] : null;
}

/**
 * Require a valid access token and an active account.
 * Attaches req.user = { id, role, name, email, emailVerified, collegeId }.
 */
const authenticate = asyncHandler(async (req, _res, next) => {
  const token = extractBearer(req);
  if (!token) throw ApiError.unauthorized('You must be signed in to do that.', 'TOKEN_MISSING');

  const payload = verifyAccessToken(token);

  const [rows] = await getPool().execute(
    `SELECT id, name, email, role, college_id, email_verified_at, is_active
       FROM users WHERE id = ? LIMIT 1`,
    [payload.sub]
  );
  const user = rows && rows[0];

  if (!user) {
    throw ApiError.unauthorized('Your account no longer exists.', 'USER_NOT_FOUND');
  }
  if (!user.is_active) {
    throw ApiError.forbidden(
      'This account has been suspended. Please contact the administrator.',
      'ACCOUNT_SUSPENDED'
    );
  }

  req.user = {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    collegeId: user.college_id,
    emailVerified: Boolean(user.email_verified_at),
  };
  next();
});

/**
 * Soft variant used where an anonymous visitor and a signed-in user are both
 * acceptable. Attaches req.user when a valid token is present, otherwise
 * leaves req.user undefined and continues.
 */
const optionalAuthenticate = asyncHandler(async (req, _res, next) => {
  const token = extractBearer(req);
  if (!token) return next();
  try {
    return await authenticate(req, _res, next);
  } catch (_) {
    // An invalid token simply means "anonymous" for optional routes.
    req.user = undefined;
    return next();
  }
});

/**
 * Restrict a route to one or more roles.
 * MUST run after authenticate().
 *
 *   router.delete('/events/:id', authenticate, authorize('admin'), handler);
 */
function authorize(...allowedRoles) {
  return function authorizer(req, _res, next) {
    if (!req.user) {
      return next(ApiError.unauthorized('You must be signed in to do that.', 'TOKEN_MISSING'));
    }
    if (!allowedRoles.includes(req.user.role)) {
      return next(ApiError.forbidden(
        `This area is restricted to: ${allowedRoles.join(', ')}.`,
        'INSUFFICIENT_ROLE'
      ));
    }
    return next();
  };
}

/**
 * Require a confirmed email address. Runs after authenticate().
 * Used for actions that send real email or affect other people.
 */
function requireVerifiedEmail(req, _res, next) {
  if (!req.user) return next(ApiError.unauthorized());
  if (!req.user.emailVerified) {
    return next(ApiError.forbidden(
      'Please confirm your email address before continuing. Check your inbox for the verification link.',
      'EMAIL_NOT_VERIFIED'
    ));
  }
  return next();
}

module.exports = { authenticate, optionalAuthenticate, authorize, requireVerifiedEmail, extractBearer };
