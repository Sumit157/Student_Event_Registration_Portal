'use strict';

/**
 * routes/jobs.js
 * Job board: browsing is open to everyone; posting requires an APPROVED
 * alumni account. (Assignment Task 5.)
 *
 * The external apply URL is validated with URL parsing and restricted to
 * http/https, which blocks javascript: and data: payloads that would otherwise
 * execute when a user clicks the link.
 */

const express = require('express');
const { body, param, query } = require('express-validator');

const { getPool } = require('../config/db');
const { ApiError } = require('../utils/errors');
const { asyncHandler } = require('../utils/asyncHandler');
const { validate } = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const { stripTags, isSafeExternalUrl } = require('../utils/sanitize');
const { isApprovedAlumni } = require('../services/alumniService');

const router = express.Router();

const JOB_TYPES = ['full_time', 'part_time', 'internship', 'contract'];

// ---------------------------------------------------------------------------
// Browse
// ---------------------------------------------------------------------------

router.get('/',
  validate([
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('pageSize').optional().isInt({ min: 1, max: 50 }).toInt(),
    query('q').optional().trim().isLength({ max: 120 }).escape(),
    query('jobType').optional().isIn(JOB_TYPES),
    query('company').optional().trim().isLength({ max: 152 }).escape(),
    query('hideExpired').optional().isBoolean().toBoolean(),
  ]),
  asyncHandler(async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(50, Math.max(1, Number(req.query.pageSize) || 10));
    const offset = (page - 1) * pageSize;

    const where = ['j.is_active = 1'];
    const params = [];

    if (req.query.q) {
      where.push('(j.title LIKE ? OR j.company LIKE ? OR j.location LIKE ? OR j.description LIKE ?)');
      const like = `%${req.query.q}%`;
      params.push(like, like, like, like);
    }
    if (req.query.jobType) { where.push('j.job_type = ?'); params.push(req.query.jobType); }
    if (req.query.company) { where.push('j.company = ?'); params.push(req.query.company); }
    if (req.query.hideExpired !== false) {
      // Default hides anything whose deadline has passed.
      where.push('(j.deadline IS NULL OR j.deadline >= CURDATE())');
    }

    const whereSql = `WHERE ${where.join(' AND ')}`;

    const [countRows] = await getPool().execute(`SELECT COUNT(*) AS total FROM job_posts j ${whereSql}`, params);
    const total = Number(countRows[0].total);

    const [rows] = await getPool().execute(
      `SELECT j.id, j.title, j.company, j.location, j.job_type, j.apply_url, j.deadline,
              j.created_at, u.name AS poster_name, u.id AS poster_id
         FROM job_posts j
         JOIN users u ON u.id = j.poster_id
         ${whereSql}
        ORDER BY j.created_at DESC, j.id DESC
        LIMIT ${pageSize} OFFSET ${offset}`,
      params
    );

    res.json({
      success: true,
      data: {
        jobs: rows.map(shapeJob),
        pagination: {
          page, pageSize, total,
          totalPages: Math.max(1, Math.ceil(total / pageSize)),
          hasNext: page * pageSize < total,
          hasPrev: page > 1,
        },
      },
    });
  })
);

router.get('/:id',
  validate([param('id').isInt({ min: 1 }).toInt()]),
  asyncHandler(async (req, res) => {
    const [rows] = await getPool().execute(
      `SELECT j.*, u.name AS poster_name, u.id AS poster_id
         FROM job_posts j JOIN users u ON u.id = j.poster_id
        WHERE j.id = ? AND j.is_active = 1`,
      [req.params.id]
    );
    if (!rows[0]) throw ApiError.notFound('That job posting could not be found.', 'JOB_NOT_FOUND');

    const [poster] = await getPool().execute(
      `SELECT a.graduation_year, a.company AS alumni_company, a.designation, a.profile_picture
         FROM alumni_profiles a WHERE a.user_id = ?`,
      [rows[0].poster_id]
    );

    res.json({
      success: true,
      data: {
        job: {
          ...shapeJob(rows[0]),
          description: rows[0].description,
          poster: {
            userId: rows[0].poster_id,
            name: rows[0].poster_name,
            graduationYear: poster[0] ? poster[0].graduation_year : null,
            company: poster[0] ? poster[0].alumni_company : null,
            designation: poster[0] ? poster[0].designation : null,
            avatarUrl: poster[0] && poster[0].profile_picture ? `/uploads/${poster[0].profile_picture}` : null,
          },
        },
      },
    });
  })
);

// ---------------------------------------------------------------------------
// Create / update / delete
// ---------------------------------------------------------------------------

const jobValidators = [
  body('title').trim().isLength({ min: 3, max: 200 }).withMessage('Job title must be 3-200 characters.').escape(),
  body('company').trim().isLength({ min: 2, max: 152 }).withMessage('Company is required (max 152 characters).').escape(),
  body('location').optional({ nullable: true }).trim().isLength({ max: 152 }).escape(),
  body('description').optional({ nullable: true }).trim().isLength({ max: 5000 }).escape(),
  body('jobType').optional().isIn(JOB_TYPES).withMessage(`Job type must be one of: ${JOB_TYPES.join(', ')}.`),
  body('applyUrl').trim().isURL({ protocols: ['http', 'https'], require_protocol: true, require_host: true })
    .withMessage('Please provide a valid http(s) link to apply.')
    .bail()
    .custom((value) => {
      if (!isSafeExternalUrl(value)) throw new Error('That link is not allowed.');
      return true;
    }),
  body('deadline').optional({ nullable: true })
    .isISO8601().withMessage('Deadline must be a valid date (YYYY-MM-DD).').toDate(),
];

router.post('/',
  authenticate,
  validate(jobValidators),
  asyncHandler(async (req, res) => {
    if (!(await isApprovedAlumni(req.user.id))) {
      throw ApiError.forbidden(
        'Only approved alumni can post jobs. Your profile is awaiting administrator approval.',
        'ALUMNI_NOT_APPROVED'
      );
    }

    const [result] = await getPool().execute(
      `INSERT INTO job_posts (poster_id, title, company, location, description, job_type, apply_url, deadline)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.user.id,
        stripTags(req.body.title, 200),
        stripTags(req.body.company, 152),
        req.body.location ? stripTags(req.body.location, 152) : null,
        req.body.description ? stripTags(req.body.description, 5000) : null,
        req.body.jobType || 'full_time',
        String(req.body.applyUrl).trim(),
        req.body.deadline ? toSqlDate(req.body.deadline) : null,
      ]
    );

    res.status(201).json({
      success: true,
      message: 'Your job posting is now live.',
      data: { id: result.insertId },
    });
  })
);

router.put('/:id',
  authenticate,
  validate([param('id').isInt({ min: 1 }).toInt(), ...jobValidators]),
  asyncHandler(async (req, res) => {
    const [rows] = await getPool().execute(`SELECT poster_id FROM job_posts WHERE id = ?`, [req.params.id]);
    if (!rows[0]) throw ApiError.notFound('That job posting could not be found.', 'JOB_NOT_FOUND');

    // Only the original poster may edit; administrators use the admin routes.
    if (Number(rows[0].poster_id) !== req.user.id && req.user.role !== 'admin') {
      throw ApiError.forbidden('You can only edit job postings you created.', 'NOT_POSTER');
    }

    await getPool().execute(
      `UPDATE job_posts SET title = ?, company = ?, location = ?, description = ?, job_type = ?, apply_url = ?, deadline = ?
        WHERE id = ?`,
      [
        stripTags(req.body.title, 200),
        stripTags(req.body.company, 152),
        req.body.location ? stripTags(req.body.location, 152) : null,
        req.body.description ? stripTags(req.body.description, 5000) : null,
        req.body.jobType || 'full_time',
        String(req.body.applyUrl).trim(),
        req.body.deadline ? toSqlDate(req.body.deadline) : null,
        req.params.id,
      ]
    );

    res.json({ success: true, message: 'Job posting updated.' });
  })
);

router.delete('/:id',
  authenticate,
  validate([param('id').isInt({ min: 1 }).toInt()]),
  asyncHandler(async (req, res) => {
    const [rows] = await getPool().execute(`SELECT poster_id FROM job_posts WHERE id = ?`, [req.params.id]);
    if (!rows[0]) throw ApiError.notFound('That job posting could not be found.', 'JOB_NOT_FOUND');
    if (Number(rows[0].poster_id) !== req.user.id && req.user.role !== 'admin') {
      throw ApiError.forbidden('You can only remove job postings you created.', 'NOT_POSTER');
    }
    // Soft delete keeps historical links intact.
    await getPool().execute(`UPDATE job_posts SET is_active = 0 WHERE id = ?`, [req.params.id]);
    res.json({ success: true, message: 'Job posting removed.' });
  })
);

/** Jobs the signed-in alumni posted (their dashboard list). */
router.get('/mine/posted', authenticate, asyncHandler(async (req, res) => {
  const [rows] = await getPool().execute(
    `SELECT * FROM job_posts WHERE poster_id = ? ORDER BY created_at DESC`,
    [req.user.id]
  );
  res.json({ success: true, data: { jobs: rows.map(shapeJob) } });
}));

function shapeJob(row) {
  return {
    id: row.id,
    title: row.title,
    company: row.company,
    location: row.location,
    jobType: row.job_type,
    applyUrl: row.apply_url,
    deadline: row.deadline ? String(row.deadline).slice(0, 10) : null,
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
    posterName: row.poster_name,
  };
}

/** Convert a JS Date (from express-validator .toDate()) to YYYY-MM-DD. */
function toSqlDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

module.exports = router;
