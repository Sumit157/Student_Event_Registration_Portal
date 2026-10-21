'use strict';

/**
 * routes/alumni.js
 * The public alumni directory. (Assignment Task 5.)
 *
 * Visibility rule: an alumni profile appears in the directory ONLY when BOTH
 *   * the account's email address is verified, AND
 *   * an administrator has approved the profile (approved_at IS NOT NULL).
 * Unapproved or unverified alumni are never returned, so the WHERE clause here
 * is the real access control - hiding cards in the browser would not be enough.
 */

const express = require('express');
const { query, param } = require('express-validator');

const { getPool } = require('../config/db');
const { asyncHandler } = require('../utils/asyncHandler');
const { validate } = require('../middleware/validate');
const { optionalAuthenticate } = require('../middleware/auth');

const router = express.Router();

const APPROVED_PREDICATE = 'a.approved_at IS NOT NULL AND u.email_verified_at IS NOT NULL';

router.get('/directory',
  optionalAuthenticate,
  validate([
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('pageSize').optional().isInt({ min: 1, max: 50 }).toInt(),
    query('q').optional().trim().isLength({ max: 120 }).escape(),
    query('graduationYear').optional().isInt({ min: 1950, max: 2100 }).toInt(),
    query('degree').optional().trim().isLength({ max: 120 }).escape(),
    query('company').optional().trim().isLength({ max: 152 }).escape(),
  ]),
  asyncHandler(async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(50, Math.max(1, Number(req.query.pageSize) || 12));
    const offset = (page - 1) * pageSize;

    const where = [APPROVED_PREDICATE];
    const params = [];

    if (req.query.q) {
      where.push('(u.name LIKE ? OR a.company LIKE ? OR a.degree LIKE ? OR a.designation LIKE ?)');
      const like = `%${req.query.q}%`;
      params.push(like, like, like, like);
    }
    if (req.query.graduationYear) {
      where.push('a.graduation_year = ?');
      params.push(req.query.graduationYear);
    }
    if (req.query.degree) {
      where.push('a.degree = ?');
      params.push(req.query.degree);
    }
    if (req.query.company) {
      where.push('a.company = ?');
      params.push(req.query.company);
    }

    const whereSql = `WHERE ${where.join(' AND ')}`;

    const [countRows] = await getPool().execute(
      `SELECT COUNT(*) AS total FROM alumni_profiles a JOIN users u ON u.id = a.user_id ${whereSql}`,
      params
    );
    const total = Number(countRows[0].total);

    const [rows] = await getPool().execute(
      `SELECT u.id, u.name, u.email, a.graduation_year, a.degree, a.company, a.designation,
              a.bio, a.profile_picture, a.approved_at
         FROM alumni_profiles a
         JOIN users u ON u.id = a.user_id
         ${whereSql}
        ORDER BY a.graduation_year DESC, u.name ASC
        LIMIT ${pageSize} OFFSET ${offset}`,
      params
    );

    // When a signed-in user browses the directory, include the state of any
    // connection between them and each profile so the UI can render the right
    // button without a second round trip.
    let connectionStates = {};
    if (req.user) {
      const ids = rows.map((r) => r.id);
      if (ids.length > 0) {
        const placeholders = ids.map(() => '?').join(',');
        const [conns] = await getPool().execute(
          `SELECT requester_id, addressee_id, status FROM connections
            WHERE (requester_id = ? AND addressee_id IN (${placeholders}))
               OR (addressee_id = ? AND requester_id IN (${placeholders}))`,
          [req.user.id, ...ids, req.user.id, ...ids]
        );
        for (const c of conns) {
          const otherId = c.requester_id === req.user.id ? c.addressee_id : c.requester_id;
          connectionStates[otherId] = {
            status: c.status,
            direction: c.requester_id === req.user.id ? 'outgoing' : 'incoming',
          };
        }
      }
    }

    res.json({
      success: true,
      data: {
        alumni: rows.map((row) => ({
          userId: row.id,
          name: row.name,
          // Email is masked in the public directory to reduce scraping; the
          // full address is visible once a connection is accepted.
          email: maskEmail(row.email),
          graduationYear: row.graduation_year,
          degree: row.degree,
          company: row.company,
          designation: row.designation,
          bio: row.bio,
          avatarUrl: row.profile_picture ? `/uploads/${row.profile_picture}` : null,
          connection: connectionStates[row.id] || null,
        })),
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

/** Filter options for the directory sidebar. */
router.get('/directory/filters', asyncHandler(async (_req, res) => {
  const [degrees] = await getPool().execute(
    `SELECT a.degree, COUNT(*) AS count FROM alumni_profiles a
       JOIN users u ON u.id = a.user_id
      WHERE ${APPROVED_PREDICATE} AND a.degree IS NOT NULL
      GROUP BY a.degree ORDER BY a.degree ASC`
  );
  const [companies] = await getPool().execute(
    `SELECT a.company, COUNT(*) AS count FROM alumni_profiles a
       JOIN users u ON u.id = a.user_id
      WHERE ${APPROVED_PREDICATE} AND a.company IS NOT NULL
      GROUP BY a.company ORDER BY count DESC, a.company ASC LIMIT 60`
  );
  const [years] = await getPool().execute(
    `SELECT a.graduation_year AS year, COUNT(*) AS count FROM alumni_profiles a
       JOIN users u ON u.id = a.user_id
      WHERE ${APPROVED_PREDICATE} AND a.graduation_year IS NOT NULL
      GROUP BY a.graduation_year ORDER BY a.graduation_year DESC`
  );
  res.json({
    success: true,
    data: {
      degrees: degrees.map((d) => ({ value: d.degree, count: Number(d.count) })),
      companies: companies.map((c) => ({ value: c.company, count: Number(c.count) })),
      years: years.map((y) => ({ value: y.year, count: Number(y.count) })),
    },
  });
}));

router.get('/:id',
  validate([param('id').isInt({ min: 1 }).toInt()]),
  asyncHandler(async (req, res) => {
    const [rows] = await getPool().execute(
      `SELECT u.id, u.name, u.email, a.graduation_year, a.degree, a.company, a.designation,
              a.bio, a.profile_picture, a.approved_at
         FROM alumni_profiles a
         JOIN users u ON u.id = a.user_id
        WHERE u.id = ? AND ${APPROVED_PREDICATE}`,
      [req.params.id]
    );
    if (!rows[0]) {
      return res.status(404).json({ success: false, error: { message: 'That alumni profile could not be found.' } });
    }
    const row = rows[0];
    return res.json({
      success: true,
      data: {
        alumni: {
          userId: row.id,
          name: row.name,
          email: maskEmail(row.email),
          graduationYear: row.graduation_year,
          degree: row.degree,
          company: row.company,
          designation: row.designation,
          bio: row.bio,
          avatarUrl: row.profile_picture ? `/uploads/${row.profile_picture}` : null,
        },
      },
    });
  })
);

/** a***@example.com style masking for the public directory. */
function maskEmail(email) {
  if (!email || !email.includes('@')) return email || null;
  const [local, domain] = email.split('@');
  const head = local.slice(0, 1);
  return `${head}${'*'.repeat(Math.max(1, local.length - 1))}@${domain}`;
}

module.exports = router;
module.exports.maskEmail = maskEmail;
