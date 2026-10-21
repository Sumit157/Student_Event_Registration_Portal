'use strict';

/**
 * services/tokenService.js
 * Central authority for every token the application issues.
 *
 * Three distinct token kinds:
 *   1. ACCESS tokens  - short lived signed JWTs (~15 min). Stateless.
 *   2. REFRESH tokens - long lived OPAQUE random strings kept in an HttpOnly
 *                       cookie. Only their SHA-256 hash is stored server-side,
 *                       so a database leak cannot be replayed as a session.
 *   3. SINGLE-USE tokens - email verification and password reset. Same
 *                       hash-at-rest design, plus a hard expiry and a used_at
 *                       column so each link works exactly once.
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { env } = require('../config/env');
const { ApiError } = require('../utils/errors');

// ---------------------------------------------------------------------------
// Low level helpers
// ---------------------------------------------------------------------------

/** Cryptographically strong opaque token (URL safe, 128 chars = 512 bits). */
function generateOpaqueToken(bytes = 48) {
  return crypto.randomBytes(bytes).toString('hex');
}

/** SHA-256 hex digest. Used so plaintext tokens are never persisted. */
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Access tokens (JWT)
// ---------------------------------------------------------------------------

/**
 * Sign a short lived access token.
 * @param {{id:number, role:string, name:string, email:string, emailVerified:boolean}} user
 */
function signAccessToken(user) {
  const payload = {
    sub: user.id,
    role: user.role,
    name: user.name,
    email: user.email,
    // Included so middleware can enforce "verified email" rules without a
    // database round trip on every request.
    ev: user.emailVerified ? 1 : 0,
    typ: 'access',
  };
  return jwt.sign(payload, env.jwt.accessSecret, {
    expiresIn: env.jwt.accessExpires,
    issuer: 'student-portal',
    audience: 'student-portal-client',
  });
}

/**
 * Verify an access token's signature, expiry and claims.
 * @throws {ApiError} 401 when the token is missing, malformed or expired.
 */
function verifyAccessToken(token) {
  if (!token || typeof token !== 'string') {
    throw ApiError.unauthorized('Authentication required.', 'TOKEN_MISSING');
  }
  try {
    const decoded = jwt.verify(token, env.jwt.accessSecret, {
      issuer: 'student-portal',
      audience: 'student-portal-client',
    });
    if (decoded.typ !== 'access') {
      throw new Error('wrong token type');
    }
    return decoded;
  } catch (error) {
    const expired = error && error.name === 'TokenExpiredError';
    throw ApiError.unauthorized(
      expired ? 'Your session has expired. Please refresh and try again.' : 'Invalid authentication token.',
      expired ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID'
    );
  }
}

// ---------------------------------------------------------------------------
// Refresh tokens (opaque, database backed, rotatable)
// ---------------------------------------------------------------------------

/**
 * Persist a new refresh token and return its plaintext (which only the client
 * ever sees; the caller sets it as an HttpOnly cookie).
 *
 * @param {import('mysql2/promise').Pool|*} db  pool or connection
 * @param {number} userId
 * @param {{userAgent?:string, ipAddress?:string}} meta
 * @returns {Promise<{token:string, id:number, expiresAt:Date}>}
 */
async function issueRefreshToken(db, userId, meta = {}) {
  const token = generateOpaqueToken(48);
  const expiresAt = new Date(Date.now() + env.jwt.refreshExpiresDays * 24 * 60 * 60 * 1000);

  const [result] = await db.execute(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, user_agent, ip_address)
     VALUES (?, ?, ?, ?, ?)`,
    [
      userId,
      hashToken(token),
      expiresAt,
      (meta.userAgent || '').slice(0, 255) || null,
      (meta.ipAddress || '').slice(0, 45) || null,
    ]
  );

  return { token, id: result.insertId, expiresAt };
}

/**
 * Validate a presented refresh token and ROTATE it.
 *
 * Rotation rules:
 *   * unknown hash            -> 401 (never issued, or already purged)
 *   * revoked_at set          -> 401 REUSE DETECTED: revoke every other token
 *                                belonging to that user (the family), because
 *                                a stolen token that was already rotated would
 *                                otherwise stay live.
 *   * replaced_by_id set      -> same as revoked: it was consumed already.
 *   * expired                 -> 401
 *   * otherwise               -> revoke it, issue a replacement, link the two.
 *
 * @returns {Promise<{userId:number, token:string, id:number, expiresAt:Date}>}
 */
async function rotateRefreshToken(db, presentedToken, meta = {}) {
  if (!presentedToken || typeof presentedToken !== 'string') {
    throw ApiError.unauthorized('No active session.', 'REFRESH_MISSING');
  }

  const hash = hashToken(presentedToken);

  // Lock the row so two concurrent refreshes cannot both succeed.
  const [rows] = await db.execute(
    `SELECT id, user_id, expires_at, revoked_at, replaced_by_id
       FROM refresh_tokens
      WHERE token_hash = ?
      FOR UPDATE`,
    [hash]
  );

  const record = rows && rows[0];
  if (!record) {
    throw ApiError.unauthorized('Your session is no longer valid. Please sign in again.', 'REFRESH_UNKNOWN');
  }

  const now = new Date();

  if (record.revoked_at || record.replaced_by_id) {
    // Token replay: assume compromise and kill the whole family.
    await db.execute(
      `UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, ?)
        WHERE user_id = ? AND revoked_at IS NULL`,
      [now, record.user_id]
    );
    throw ApiError.unauthorized('Your session was refreshed elsewhere and has been signed out for safety. Please sign in again.', 'REFRESH_REUSED');
  }

  if (new Date(record.expires_at).getTime() <= now.getTime()) {
    await db.execute(`UPDATE refresh_tokens SET revoked_at = ? WHERE id = ?`, [now, record.id]);
    throw ApiError.unauthorized('Your session has expired. Please sign in again.', 'REFRESH_EXPIRED');
  }

  // Consume the presented token, then issue its successor.
  const replacement = await issueRefreshToken(db, record.user_id, meta);
  await db.execute(
    `UPDATE refresh_tokens SET revoked_at = ?, replaced_by_id = ? WHERE id = ?`,
    [now, replacement.id, record.id]
  );

  return { userId: record.user_id, token: replacement.token, id: replacement.id, expiresAt: replacement.expiresAt };
}

/** Revoke a single refresh token (used by logout). */
async function revokeRefreshToken(db, presentedToken) {
  if (!presentedToken) return false;
  const [result] = await db.execute(
    `UPDATE refresh_tokens SET revoked_at = CURRENT_TIMESTAMP
      WHERE token_hash = ? AND revoked_at IS NULL`,
    [hashToken(presentedToken)]
  );
  return result.affectedRows > 0;
}

/** Revoke every live refresh token for a user (password change, suspension). */
async function revokeAllUserTokens(db, userId, exceptToken = null) {
  const params = [new Date(), userId];
  let sql = `UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`;
  if (exceptToken) {
    sql += ` AND token_hash <> ?`;
    params.push(hashToken(exceptToken));
  }
  const [result] = await db.execute(sql, params);
  return result.affectedRows;
}

// ---------------------------------------------------------------------------
// Single-use tokens (email verification + password reset)
// ---------------------------------------------------------------------------

const VERIFICATION_TTL_HOURS = 24;
const RESET_TTL_MINUTES = 30;

/**
 * Create a single-use token row.
 * @param {'verify'|'reset'} kind
 */
async function createSingleUseToken(db, kind, userId, ttl) {
  const table = kind === 'reset' ? 'password_reset_tokens' : 'email_verification_tokens';
  const token = generateOpaqueToken(32);
  const expiresAt = new Date(Date.now() + ttl * 60 * 1000);

  // Invalidate any earlier unconsumed tokens of the same kind so only the
  // most recent link works.
  await db.execute(
    `UPDATE ${table} SET used_at = CURRENT_TIMESTAMP
      WHERE user_id = ? AND used_at IS NULL`,
    [userId]
  );

  await db.execute(
    `INSERT INTO ${table} (user_id, token_hash, expires_at) VALUES (?, ?, ?)`,
    [userId, hashToken(token), expiresAt]
  );

  return { token, expiresAt };
}

async function createEmailVerificationToken(db, userId) {
  return createSingleUseToken(db, 'verify', userId, VERIFICATION_TTL_HOURS * 60);
}

async function createPasswordResetToken(db, userId) {
  return createSingleUseToken(db, 'reset', userId, RESET_TTL_MINUTES);
}

/**
 * Consume a single-use token. Returns the owning user id, or throws.
 * Both the "not found" and "already used" cases return the SAME message so an
 * attacker cannot tell whether a token exists (account/token enumeration).
 */
async function consumeSingleUseToken(db, kind, token) {
  const table = kind === 'reset' ? 'password_reset_tokens' : 'email_verification_tokens';
  const invalidMessage = 'This link is invalid or has expired. Please request a new one.';

  if (!token || typeof token !== 'string' || token.length < 20) {
    throw ApiError.badRequest(invalidMessage, 'TOKEN_INVALID');
  }

  const [rows] = await db.execute(
    `SELECT id, user_id, expires_at, used_at FROM ${table} WHERE token_hash = ? FOR UPDATE`,
    [hashToken(token)]
  );
  const record = rows && rows[0];

  if (!record || record.used_at || new Date(record.expires_at).getTime() <= Date.now()) {
    throw ApiError.badRequest(invalidMessage, 'TOKEN_INVALID');
  }

  await db.execute(`UPDATE ${table} SET used_at = CURRENT_TIMESTAMP WHERE id = ?`, [record.id]);
  return record.user_id;
}

/** Housekeeping: delete tokens that expired more than `days` ago. */
async function purgeExpiredTokens(db, days = 30) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const results = [];
  for (const table of ['refresh_tokens', 'email_verification_tokens', 'password_reset_tokens']) {
    const [r] = await db.execute(`DELETE FROM ${table} WHERE expires_at < ?`, [cutoff]);
    results.push({ table, removed: r.affectedRows });
  }
  return results;
}

module.exports = {
  generateOpaqueToken,
  hashToken,
  signAccessToken,
  verifyAccessToken,
  issueRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
  revokeAllUserTokens,
  createEmailVerificationToken,
  createPasswordResetToken,
  consumeSingleUseToken,
  purgeExpiredTokens,
  VERIFICATION_TTL_HOURS,
  RESET_TTL_MINUTES,
};
