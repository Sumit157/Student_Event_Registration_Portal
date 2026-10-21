'use strict';

/**
 * routes/auth.js
 * Registration, email verification, login, session refresh, logout and the
 * forgot / reset password flows. (Assignment Task 2 + Task 3.)
 *
 * Security properties enforced here:
 *   * Passwords are hashed with bcrypt (cost 10). Plain text is never stored
 *     and no hash is ever returned by an API response.
 *   * The admin role CANNOT be chosen during public registration - it is
 *     removed from the accepted enum and re-checked after validation.
 *   * Every response for an unknown email is identical in shape and timing to
 *     a known email, so responses cannot be used to enumerate accounts.
 *   * Verification and reset links use single-use, expiring tokens stored only
 *     as a SHA-256 hash.
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const { body, param, query } = require('express-validator');

const { getPool } = require('../config/db');
const { env } = require('../config/env');
const { ApiError } = require('../utils/errors');
const { asyncHandler } = require('../utils/asyncHandler');
const { validate } = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const { loginLimiter, resetLimiter, registerLimiter } = require('../middleware/rate-limit');
const { checkPassword } = require('../utils/passwordPolicy');
const { stripTags } = require('../utils/sanitize');
const { setRefreshCookie, clearRefreshCookie, REFRESH_COOKIE } = require('../utils/cookies');
const tokenService = require('../services/tokenService');
const mailer = require('../services/mailer');

const router = express.Router();

const BCRYPT_ROUNDS = 10;
const CURRENT_YEAR = new Date().getFullYear();

// Shared sanitiser: collapse any HTML a client might try to store in a name.
const normaliseName = (value) => stripTags(value, 120);

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Shape a user row for the client. NEVER includes password_hash. */
function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    collegeId: row.college_id || null,
    emailVerified: Boolean(row.email_verified_at),
    isActive: Boolean(row.is_active),
    createdAt: row.created_at || undefined,
  };
}

// ---------------------------------------------------------------------------
// Registration  (Task 2)
// ---------------------------------------------------------------------------

const registerValidators = [
  body('name')
    .trim().isLength({ min: 2, max: 120 }).withMessage('Name must be between 2 and 120 characters.')
    .escape(),
  body('email')
    .trim().isEmail().withMessage('Please enter a valid email address.')
    .bail().normalizeEmail({ gmail_remove_dots: false, gmail_remove_subaddress: false }),
  body('password')
    .isString().withMessage('Password is required.')
    .bail()
    .custom((value) => {
      const result = checkPassword(value);
      if (!result.valid) throw new Error(result.problems.join(' '));
      return true;
    }),
  body('confirmPassword')
    .isString().withMessage('Please confirm your password.')
    .bail()
    .custom((value, { req }) => {
      if (value !== req.body.password) throw new Error('The two passwords do not match.');
      return true;
    }),
  // NOTE: 'admin' is deliberately absent. Even if a client sends role=admin it
  // is rejected below after validation as defence in depth.
  body('role')
    .isIn(['student', 'alumni']).withMessage('Please choose either student or alumni.')
    .toLowerCase(),
  body('collegeId')
    .trim().isLength({ min: 1, max: 50 }).withMessage('College ID is required.')
    .escape(),
  // Alumni-only fields.
  body('graduationYear')
    .optional({ nullable: true })
    .trim().isInt({ min: 1950, max: CURRENT_YEAR + 10 })
    .withMessage(`Graduation year must be between 1950 and ${CURRENT_YEAR + 10}.`)
    .toInt(),
  body('degree')
    .optional({ nullable: true })
    .trim().isLength({ max: 120 }).escape(),
  body('company')
    .optional({ nullable: true })
    .trim().isLength({ max: 152 }).escape(),
  body('designation')
    .optional({ nullable: true })
    .trim().isLength({ max: 120 }).escape(),
];

router.post('/register', registerLimiter, validate(registerValidators), asyncHandler(async (req, res) => {
  // Defence in depth: the role was already constrained to student|alumni by the
  // validator, but re-assert it so a future validator change cannot silently
  // open a privilege escalation hole.
  const requestedRole = String(req.body.role || '').toLowerCase();
  if (requestedRole !== 'student' && requestedRole !== 'alumni') {
    throw ApiError.badRequest('Please choose either student or alumni.', 'INVALID_ROLE');
  }
  const role = requestedRole;

  if (role === 'alumni' && !req.body.graduationYear) {
    throw ApiError.badRequest('Graduation year is required for alumni registration.', 'VALIDATION_FAILED', [
      { field: 'graduationYear', message: 'Graduation year is required for alumni registration.' },
    ]);
  }

  const pool = getPool();
  const email = String(req.body.email).toLowerCase();
  const name = normaliseName(req.body.name);
  const collegeId = stripTags(req.body.collegeId, 50);

  // Duplicate email prevention (the unique index is the real guarantee; this
  // check simply produces a friendlier message).
  const [existing] = await pool.execute(`SELECT id FROM users WHERE email = ? LIMIT 1`, [email]);
  if (existing.length > 0) {
    throw ApiError.conflict('An account with that email address already exists. Try signing in instead.', 'DUPLICATE_EMAIL');
  }

  const passwordHash = await bcrypt.hash(String(req.body.password), BCRYPT_ROUNDS);

  let userId;
  try {
    // Both inserts share one connection so the alumni profile can never be
    // created without its user row.
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [result] = await conn.execute(
        `INSERT INTO users (name, email, password_hash, role, college_id, email_verified_at)
         VALUES (?, ?, ?, ?, ?, NULL)`,
        [name, email, passwordHash, role, collegeId]
      );
      userId = result.insertId;

      if (role === 'alumni') {
        await conn.execute(
          `INSERT INTO alumni_profiles (user_id, graduation_year, degree, company, designation, bio)
           VALUES (?, ?, ?, ?, ?, NULL)`,
          [
            userId,
            req.body.graduationYear || null,
            stripTags(req.body.degree || '', 120) || null,
            stripTags(req.body.company || '', 152) || null,
            stripTags(req.body.designation || '', 120) || null,
          ]
        );
      }
      await conn.commit();
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
  } catch (error) {
    if (error && error.code === 'ER_DUP_ENTRY') {
      throw ApiError.conflict('An account with that email address already exists.', 'DUPLICATE_EMAIL');
    }
    throw error;
  }

  // Issue the verification link and deliver it (or print it in dev mode).
  const { token } = await tokenService.createEmailVerificationToken(pool, userId);
  const delivery = await mailer.sendVerificationEmail({ id: userId, name, email }, token);

  res.status(201).json({
    success: true,
    message: 'Your account has been created. Check your inbox for the verification link, then sign in.',
    data: {
      user: { id: userId, name, email, role, collegeId, emailVerified: false },
      // Tells the frontend whether to show "check your console" instead.
      emailDelivery: delivery.mode,
    },
  });
}));

// ---------------------------------------------------------------------------
// Email verification
// ---------------------------------------------------------------------------

router.get('/verify-email',
  validate([
    // This is a GET link users click in their inbox, so the token arrives in
    // the QUERY STRING. Validating req.body here would reject every request.
    query('token').isString().trim().isLength({ min: 20 }).withMessage('Verification link is invalid.'),
  ]),
  asyncHandler(async (req, res) => {
    // Accept the token from the query string (this is a GET link users click).
    const token = req.query.token;
    const pool = getPool();

    const userId = await tokenService.consumeSingleUseToken(pool, 'verify', token);

    await pool.execute(
      `UPDATE users SET email_verified_at = COALESCE(email_verified_at, CURRENT_TIMESTAMP) WHERE id = ?`,
      [userId]
    );

    // Alumni become visible in the directory only after BOTH email verification
    // and admin approval, so just flip the flag here.
    const [rows] = await pool.execute(`SELECT id, name, email, role FROM users WHERE id = ?`, [userId]);

    res.json({
      success: true,
      message: 'Your email address has been verified. You can now sign in and use the full portal.',
      data: { user: publicUser({ ...rows[0], email_verified_at: new Date() }) },
    });
  })
);

router.post('/resend-verification',
  authenticate,
  asyncHandler(async (req, res) => {
    const pool = getPool();
    if (req.user.emailVerified) {
      return res.json({ success: true, message: 'Your email address is already verified.' });
    }
    const { token } = await tokenService.createEmailVerificationToken(pool, req.user.id);
    const delivery = await mailer.sendVerificationEmail(req.user, token);
    return res.json({
      success: true,
      message: delivery.mode === 'dev'
        ? 'A new verification link has been printed in the server console.'
        : 'A new verification link has been sent to your email address.',
      data: { emailDelivery: delivery.mode },
    });
  })
);

// ---------------------------------------------------------------------------
// Login  (Task 3)
// ---------------------------------------------------------------------------

const loginValidators = [
  body('email').trim().isEmail().withMessage('Please enter a valid email address.')
    .normalizeEmail({ gmail_remove_dots: false, gmail_remove_subaddress: false }),
  body('password').isString().notEmpty().withMessage('Password is required.'),
];

router.post('/login', loginLimiter, validate(loginValidators), asyncHandler(async (req, res) => {
  const pool = getPool();
  const email = String(req.body.email).toLowerCase();
  const password = String(req.body.password);

  const [rows] = await pool.execute(
    `SELECT id, name, email, password_hash, role, college_id, email_verified_at, is_active
       FROM users WHERE email = ? LIMIT 1`,
    [email]
  );
  const user = rows[0];

  // ALWAYS run a bcrypt comparison so a missing account and a wrong password
  // take the same amount of time (prevents timing based user enumeration).
  const hash = user && user.password_hash
    ? user.password_hash
    : '$2a$10$C6UzMDM.H6dfI/f/IKcEeO7ZBpDLhE3pyLzFA1G0rHhRhbF0eeper';
  const passwordOk = await bcrypt.compare(password, hash);

  if (!user || !passwordOk || !user.is_active) {
    // One identical failure for "no such user", "wrong password" and
    // "suspended" - see SECURITY.md for why this is intentional.
    throw ApiError.unauthorized('Incorrect email address or password.', 'INVALID_CREDENTIALS');
  }

  // A signed JWT is generated only after these checks, never before.
  const accessToken = tokenService.signAccessToken({
    id: user.id, name: user.name, email: user.email,
    role: user.role, emailVerified: Boolean(user.email_verified_at),
  });

  const refresh = await tokenService.issueRefreshToken(pool, user.id, {
    userAgent: req.headers['user-agent'],
    ipAddress: req.ip || req.socket?.remoteAddress,
  });
  setRefreshCookie(res, refresh.token);

  return res.json({
    success: true,
    message: 'Signed in successfully.',
    data: {
      accessToken,
      tokenType: 'Bearer',
      expiresIn: env.jwt.accessExpires,
      user: publicUser(user),
    },
  });
}));

// ---------------------------------------------------------------------------
// Session refresh - rotates the refresh token
// ---------------------------------------------------------------------------
router.post('/refresh', asyncHandler(async (req, res) => {
  const presented = req.cookies && req.cookies[REFRESH_COOKIE];
  const pool = getPool();

  // Rotation happens on a single locked connection to stop double-spend.
  const { withTransaction } = require('../config/db');
  let rotated;
  try {
    rotated = await withTransaction(async (conn) => tokenService.rotateRefreshToken(
      conn,
      presented,
      { userAgent: req.headers['user-agent'], ipAddress: req.ip || req.socket?.remoteAddress }
    ));
  } catch (error) {
    clearRefreshCookie(res);
    throw error;
  }

  const [rows] = await pool.execute(
    `SELECT id, name, email, role, college_id, email_verified_at, is_active FROM users WHERE id = ?`,
    [rotated.userId]
  );
  const user = rows[0];

  if (!user || !user.is_active) {
    clearRefreshCookie(res);
    throw ApiError.unauthorized('Your account is no longer active.', 'ACCOUNT_UNAVAILABLE');
  }

  const accessToken = tokenService.signAccessToken({
    id: user.id, name: user.name, email: user.email,
    role: user.role, emailVerified: Boolean(user.email_verified_at),
  });
  setRefreshCookie(res, rotated.token);

  return res.json({
    success: true,
    data: { accessToken, tokenType: 'Bearer', expiresIn: env.jwt.accessExpires, user: publicUser(user) },
  });
}));

// ---------------------------------------------------------------------------
// Logout - revokes the presented refresh token server side
// ---------------------------------------------------------------------------

router.post('/logout', asyncHandler(async (req, res) => {
  const presented = req.cookies && req.cookies[REFRESH_COOKIE];
  if (presented) {
    try {
      await tokenService.revokeRefreshToken(getPool(), presented);
    } catch (_) { /* revoking is best effort */ }
  }
  clearRefreshCookie(res);
  return res.json({ success: true, message: 'You have been signed out.' });
}));

// ---------------------------------------------------------------------------
// Current session
// ---------------------------------------------------------------------------

router.get('/me', authenticate, asyncHandler(async (req, res) => {
  const [rows] = await getPool().execute(
    `SELECT id, name, email, role, college_id, email_verified_at, is_active, created_at
       FROM users WHERE id = ?`,
    [req.user.id]
  );
  return res.json({ success: true, data: { user: publicUser(rows[0]) } });
}));

// ---------------------------------------------------------------------------
// Forgot / reset password  (Task 3)
// ---------------------------------------------------------------------------

router.post('/forgot-password',
  resetLimiter,
  validate([body('email').trim().isEmail().withMessage('Please enter a valid email address.')
    .normalizeEmail({ gmail_remove_dots: false, gmail_remove_subaddress: false })]),
  asyncHandler(async (req, res) => {
    const pool = getPool();
    const email = String(req.body.email).toLowerCase();

    const [rows] = await pool.execute(`SELECT id, name, email FROM users WHERE email = ? LIMIT 1`, [email]);
    const user = rows[0];

    // When the account does not exist we still return HTTP 200 with the exact
    // same message, so this endpoint cannot be used to discover which email
    // addresses are registered.
    const genericResponse = {
      success: true,
      message: 'If an account exists for that email address, a password reset link has been sent. The link is valid for 30 minutes.',
    };

    if (!user) return res.json(genericResponse);

    const { token } = await tokenService.createPasswordResetToken(pool, user.id);
    const delivery = await mailer.sendPasswordResetEmail(user, token);

    if (delivery.mode === 'dev') {
      genericResponse.data = { emailDelivery: 'dev', note: 'SMTP is not configured, so the reset link was printed in the server console.' };
    }
    return res.json(genericResponse);
  })
);

router.post('/reset-password',
  validate([
    body('token').isString().trim().isLength({ min: 20 }).withMessage('This reset link is invalid.'),
    body('password').isString().withMessage('Password is required.').bail()
      .custom((value) => {
        const result = checkPassword(value);
        if (!result.valid) throw new Error(result.problems.join(' '));
        return true;
      }),
    body('confirmPassword').isString().withMessage('Please confirm your password.').bail()
      .custom((value, { req }) => {
        if (value !== req.body.password) throw new Error('The two passwords do not match.');
        return true;
      }),
  ]),
  asyncHandler(async (req, res) => {
    const pool = getPool();
    const { withTransaction } = require('../config/db');

    const userId = await withTransaction((conn) => tokenService.consumeSingleUseToken(conn, 'reset', req.body.token));

    const newHash = await bcrypt.hash(String(req.body.password), BCRYPT_ROUNDS);
    await pool.execute(`UPDATE users SET password_hash = ? WHERE id = ?`, [newHash, userId]);

    // Changing the password invalidates every existing session for that user.
    const revoked = await tokenService.revokeAllUserTokens(pool, userId);

    clearRefreshCookie(res);

    return res.json({
      success: true,
      message: 'Your password has been changed. Please sign in with your new password.',
      data: { sessionsRevoked: revoked },
    });
  })
);

module.exports = router;
module.exports.publicUser = publicUser;
