'use strict';

/**
 * routes/profile.js
 * "My profile" - lets a signed-in user view and edit their own record and
 * manage their avatar. (Assignment Task 5, profile picture uploads.)
 *
 * Every statement here is scoped to req.user.id; there is no way to address
 * another user's row through this router.
 */

const express = require('express');
const { body } = require('express-validator');

const { getPool } = require('../config/db');
const { env } = require('../config/env');
const { asyncHandler } = require('../utils/asyncHandler');
const { validate } = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const { requireImage, deleteUpload } = require('../middleware/upload');
const { stripTags } = require('../utils/sanitize');
const mailer = require('../services/mailer');

const router = express.Router();
const CURRENT_YEAR = new Date().getFullYear();

router.use(authenticate);

/** Public URL path for a stored avatar filename. */
function avatarUrl(filename) {
  return filename ? `/uploads/${filename}` : null;
}

/** Load the caller's full profile in one query. */
async function loadProfile(userId) {
  const [rows] = await getPool().execute(
    `SELECT u.id, u.name, u.email, u.role, u.college_id, u.email_verified_at, u.is_active, u.created_at,
            a.graduation_year, a.degree, a.company, a.designation, a.bio, a.profile_picture,
            a.approved_at, a.rejection_reason
       FROM users u
       LEFT JOIN alumni_profiles a ON a.user_id = u.id
      WHERE u.id = ?`,
    [userId]
  );
  const row = rows && rows[0];
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    collegeId: row.college_id,
    emailVerified: Boolean(row.email_verified_at),
    createdAt: row.created_at,
    alumni: row.role === 'alumni' ? {
      graduationYear: row.graduation_year,
      degree: row.degree,
      company: row.company,
      designation: row.designation,
      bio: row.bio,
      avatarUrl: avatarUrl(row.profile_picture),
      approved: Boolean(row.approved_at),
      rejectionReason: row.rejection_reason,
    } : null,
  };
}

router.get('/', asyncHandler(async (req, res) => {
  const profile = await loadProfile(req.user.id);
  if (!profile) return res.status(404).json({ success: false, error: { message: 'Profile not found.' } });
  return res.json({ success: true, data: { profile } });
}));

const updateValidators = [
  body('name').optional().trim().isLength({ min: 2, max: 120 }).withMessage('Name must be 2-120 characters.').escape(),
  body('collegeId').optional().trim().isLength({ max: 50 }).escape(),
  body('bio').optional({ nullable: true }).trim().isLength({ max: 2000 }).withMessage('Bio must be under 2000 characters.'),
  body('graduationYear').optional({ nullable: true })
    .isInt({ min: 1950, max: CURRENT_YEAR + 10 })
    .withMessage(`Graduation year must be between 1950 and ${CURRENT_YEAR + 10}.`).toInt(),
  body('degree').optional({ nullable: true }).trim().isLength({ max: 120 }).escape(),
  body('company').optional({ nullable: true }).trim().isLength({ max: 152 }).escape(),
  body('designation').optional({ nullable: true }).trim().isLength({ max: 120 }).escape(),
];

router.put('/', validate(updateValidators), asyncHandler(async (req, res) => {
  const pool = getPool();
  const { id: userId, role } = req.user;

  // Name / college ID live on users.
  const userFields = [];
  const userValues = [];
  if (req.body.name !== undefined) { userFields.push('name = ?'); userValues.push(stripTags(req.body.name, 120)); }
  if (req.body.collegeId !== undefined) { userFields.push('college_id = ?'); userValues.push(stripTags(req.body.collegeId, 50) || null); }
  if (userFields.length > 0) {
    await pool.execute(`UPDATE users SET ${userFields.join(', ')} WHERE id = ?`, [...userValues, userId]);
  }

  // Everything else only applies to alumni, and requires an existing profile row.
  if (role === 'alumni') {
    const set = [];
    const values = [];
    const map = {
      bio: (v) => (v ? stripTags(v, 2000) : null),
      graduationYear: (v) => (v === null || v === '' ? null : Number(v)),
      degree: (v) => (v ? stripTags(v, 120) : null),
      company: (v) => (v ? stripTags(v, 152) : null),
      designation: (v) => (v ? stripTags(v, 120) : null),
    };
    for (const [key, transform] of Object.entries(map)) {
      if (req.body[key] !== undefined) {
        set.push(`${key} = ?`);
        values.push(transform(req.body[key]));
      }
    }
    if (set.length > 0) {
      await pool.execute(`UPDATE alumni_profiles SET ${set.join(', ')} WHERE user_id = ?`, [...values, userId]);
    }
  }

  res.json({ success: true, message: 'Profile updated.', data: { profile: await loadProfile(userId) } });
}));

/**
 * Upload / replace the avatar. Only alumni have an avatar, but the route is
 * available to any signed-in user so a student can set one too.
 */
router.post('/avatar', requireImage, asyncHandler(async (req, res) => {
  const pool = getPool();
  const uploaded = req.uploadedFile;

  // Alumni: store against the profile row. Others: nothing to attach to, so we
  // delete the file and explain.
  if (req.user.role !== 'alumni') {
    deleteUpload(uploaded.filename);
    return res.status(400).json({
      success: false,
      error: { message: 'Profile pictures are currently available for alumni accounts.', code: 'AVATAR_NOT_SUPPORTED' },
    });
  }

  const [existing] = await pool.execute(
    `SELECT profile_picture FROM alumni_profiles WHERE user_id = ?`, [req.user.id]
  );
  const previous = existing[0] ? existing[0].profile_picture : null;

  await pool.execute(
    `UPDATE alumni_profiles SET profile_picture = ? WHERE user_id = ?`,
    [uploaded.filename, req.user.id]
  );

  // Remove the old file only after the row points at the new one.
  if (previous && previous !== uploaded.filename) deleteUpload(previous);

  return res.json({
    success: true,
    message: 'Profile picture updated.',
    data: { avatarUrl: avatarUrl(uploaded.filename), size: uploaded.size, mime: uploaded.mime },
  });
}));

router.delete('/avatar', asyncHandler(async (req, res) => {
  const pool = getPool();
  const [existing] = await pool.execute(
    `SELECT profile_picture FROM alumni_profiles WHERE user_id = ?`, [req.user.id]
  );
  const previous = existing[0] ? existing[0].profile_picture : null;
  if (previous) {
    await pool.execute(`UPDATE alumni_profiles SET profile_picture = NULL WHERE user_id = ?`, [req.user.id]);
    deleteUpload(previous);
  }
  return res.json({ success: true, message: 'Profile picture removed.' });
}));

module.exports = router;
