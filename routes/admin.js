'use strict';

/**
 * routes/admin.js
 * The administrator API. (Assignment Task 6.)
 *
 * EVERY route in this file is wrapped by authenticate + authorize('admin'),
 * which re-reads the caller's role from the database on each request. Hiding
 * admin buttons in the browser is a convenience only - the server is the real
 * gate, and a forged or stale admin token is rejected here.
 */

const express = require('express');
const { body, param, query } = require('express-validator');

const { getPool, withTransaction } = require('../config/db');
const { ApiError } = require('../utils/errors');
const { asyncHandler } = require('../utils/asyncHandler');
const { validate } = require('../middleware/validate');
const { authenticate, authorize } = require('../middleware/auth');
const { buildCsv } = require('../utils/csv');
const { stripTags } = require('../utils/sanitize');
const { revokeAllUserTokens } = require('../services/tokenService');
const { sendAccountStatusEmail, sendBulkEventNotification } = require('../services/mailer');
const eventService = require('../services/eventService');

const router = express.Router();

// Every handler below this line requires a verified administrator session.
router.use(authenticate, authorize('admin'));

const parseId = param('id').isInt({ min: 1 }).withMessage('Invalid id.').toInt();

// ---------------------------------------------------------------------------
// Dashboard statistics
// ---------------------------------------------------------------------------

router.get('/stats', asyncHandler(async (_req, res) => {
  const pool = getPool();

  const [[userCounts]] = await pool.execute(
    `SELECT COUNT(*) AS total_users,
            SUM(role = 'student') AS students,
            SUM(role = 'alumni')  AS alumni,
            SUM(role = 'admin')   AS admins,
            SUM(is_active = 0)    AS suspended
       FROM users`
  );

  const [[eventCounts]] = await pool.execute(
    `SELECT COUNT(*) AS total_events,
            SUM(is_active = 1) AS active_events,
            SUM(event_date >= NOW()) AS upcoming_events
       FROM events`
  );

  const [[regCounts]] = await pool.execute(
    `SELECT SUM(status = 'confirmed')  AS confirmed_registrations,
            SUM(status = 'waitlisted') AS waitlisted,
            SUM(status = 'cancelled')  AS cancelled
       FROM event_registrations`
  );

  const [[alumniCounts]] = await pool.execute(
    `SELECT COUNT(*) AS total_profiles,
            SUM(approved_at IS NOT NULL) AS approved_alumni,
            SUM(approved_at IS NULL)     AS pending_alumni
       FROM alumni_profiles`
  );

  const [[jobCounts]] = await pool.execute(
    `SELECT COUNT(*) AS total_jobs, SUM(is_active = 1) AS active_jobs FROM job_posts`
  );

  // Upcoming events with live seat counts, for the dashboard table.
  const [upcoming] = await pool.execute(
    `SELECT e.id, e.title, e.event_date, e.capacity,
            COALESCE(SUM(r.status = 'confirmed'), 0) AS confirmed_count,
            COALESCE(SUM(r.status = 'waitlisted'), 0) AS waitlisted_count
       FROM events e
       LEFT JOIN event_registrations r ON r.event_id = e.id
      WHERE e.is_active = 1 AND e.event_date >= NOW()
      GROUP BY e.id, e.title, e.event_date, e.capacity
      ORDER BY e.event_date ASC
      LIMIT 8`
  );

  res.json({
    success: true,
    data: {
      users: {
        total: Number(userCounts.total_users),
        students: Number(userCounts.students),
        alumni: Number(userCounts.alumni),
        admins: Number(userCounts.admins),
        suspended: Number(userCounts.suspended),
      },
      events: {
        total: Number(eventCounts.total_events),
        active: Number(eventCounts.active_events),
        upcoming: Number(eventCounts.upcoming_events),
      },
      registrations: {
        confirmed: Number(regCounts.confirmed_registrations),
        waitlisted: Number(regCounts.waitlisted),
        cancelled: Number(regCounts.cancelled),
      },
      alumni: {
        total: Number(alumniCounts.total_profiles),
        approved: Number(alumniCounts.approved_alumni),
        pending: Number(alumniCounts.pending_alumni),
      },
      jobs: {
        total: Number(jobCounts.total_jobs),
        active: Number(jobCounts.active_jobs),
      },
      upcomingEvents: upcoming.map((e) => ({
        id: e.id,
        title: e.title,
        eventDate: e.event_date,
        capacity: Number(e.capacity),
        confirmed: Number(e.confirmed_count),
        waitlisted: Number(e.waitlisted_count),
        seatsRemaining: Math.max(0, Number(e.capacity) - Number(e.confirmed_count)),
      })),
    },
  });
}));

// ---------------------------------------------------------------------------
// User management
// ---------------------------------------------------------------------------

router.get('/users',
  validate([
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('pageSize').optional().isInt({ min: 1, max: 100 }).toInt(),
    query('q').optional().trim().isLength({ max: 120 }).escape(),
    query('role').optional().isIn(['student', 'alumni', 'admin']),
    query('status').optional().isIn(['active', 'suspended', 'all']),
  ]),
  asyncHandler(async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
    const offset = (page - 1) * pageSize;

    const where = [];
    const params = [];

    if (req.query.q) {
      where.push('(u.name LIKE ? OR u.email LIKE ? OR u.college_id LIKE ?)');
      const like = `%${req.query.q}%`;
      params.push(like, like, like);
    }
    if (req.query.role) { where.push('u.role = ?'); params.push(req.query.role); }
    if (req.query.status === 'active') where.push('u.is_active = 1');
    if (req.query.status === 'suspended') where.push('u.is_active = 0');

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [countRows] = await getPool().execute(
      `SELECT COUNT(*) AS total FROM users u ${whereSql}`, params
    );
    const total = Number(countRows[0].total);

    const [rows] = await getPool().execute(
      `SELECT u.id, u.name, u.email, u.role, u.college_id, u.email_verified_at, u.is_active, u.created_at,
              a.graduation_year, a.company, a.approved_at
         FROM users u
         LEFT JOIN alumni_profiles a ON a.user_id = u.id
         ${whereSql}
        ORDER BY u.created_at DESC, u.id DESC
        LIMIT ${pageSize} ${offset > 0 ? `OFFSET ${offset}` : ''}`,
      params
    );

    res.json({
      success: true,
      data: {
        users: rows.map((row) => ({
          id: row.id,
          name: row.name,
          email: row.email,
          role: row.role,
          collegeId: row.college_id,
          emailVerified: Boolean(row.email_verified_at),
          isActive: Boolean(row.is_active),
          createdAt: row.created_at,
          graduationYear: row.graduation_year,
          company: row.company,
          alumniApproved: row.approved_at ? Boolean(row.approved_at) : null,
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

/** Activate or suspend an account. */
router.patch('/users/:id/status',
  validate([
    parseId,
    body('isActive').isBoolean().withMessage('isActive must be true or false.').toBoolean(),
  ]),
  asyncHandler(async (req, res) => {
    const targetId = Number(req.params.id);
    const isActive = req.body.isActive === true;

    // An administrator must never lock themselves out.
    if (targetId === req.user.id && !isActive) {
      throw ApiError.badRequest('You cannot suspend your own administrator account.', 'SELF_SUSPEND');
    }

    const [rows] = await getPool().execute(`SELECT id, name, role, is_active FROM users WHERE id = ?`, [targetId]);
    if (!rows[0]) throw ApiError.notFound('That user could not be found.', 'USER_NOT_FOUND');

    await getPool().execute(`UPDATE users SET is_active = ? WHERE id = ?`, [isActive ? 1 : 0, targetId]);

    let sessionsRevoked = 0;
    if (!isActive) {
      // Suspension must take effect immediately, so kill every live session.
      sessionsRevoked = await revokeAllUserTokens(getPool(), targetId);
    }

    res.json({
      success: true,
      message: isActive
        ? `${rows[0].name} has been re-activated.`
        : `${rows[0].name} has been suspended${sessionsRevoked ? ` and ${sessionsRevoked} live session(s) revoked` : ''}.`,
      data: { id: targetId, isActive, sessionsRevoked },
    });
  })
);

/**
 * Controlled role management.
 * Guardrails:
 *   * A user cannot change their own role (prevents self-promotion / the last
 *     admin demoting themselves into a locked-out state).
 *   * An admin cannot be demoted if they are the only remaining admin.
 *   * Promoting to alumni auto-creates the profile row so the schema stays
 *     consistent.
 */
router.patch('/users/:id/role',
  validate([
    parseId,
    body('role').isIn(['student', 'alumni', 'admin']).withMessage('Role must be student, alumni or admin.'),
  ]),
  asyncHandler(async (req, res) => {
    const targetId = Number(req.params.id);
    const newRole = req.body.role;

    if (targetId === req.user.id) {
      throw ApiError.badRequest('You cannot change your own role.', 'SELF_ROLE_CHANGE');
    }

    const [rows] = await getPool().execute(`SELECT id, name, role FROM users WHERE id = ?`, [targetId]);
    if (!rows[0]) throw ApiError.notFound('That user could not be found.', 'USER_NOT_FOUND');
    const currentRole = rows[0].role;

    if (currentRole === newRole) {
      return res.json({ success: true, message: `${rows[0].name} already has that role.`, data: { id: targetId, role: newRole } });
    }

    // Never leave the system without a single administrator.
    if (currentRole === 'admin' && newRole !== 'admin') {
      const [[countRow]] = await getPool().execute(
        `SELECT COUNT(*) AS admins FROM users WHERE role = 'admin' AND is_active = 1`
      );
      if (Number(countRow.admins) <= 1) {
        throw ApiError.conflict('This is the only active administrator. Promote another admin first.', 'LAST_ADMIN');
      }
    }

    await withTransaction(async (conn) => {
      await conn.execute(`UPDATE users SET role = ? WHERE id = ?`, [newRole, targetId]);

      // Creating an alumni profile keeps foreign keys and the directory happy.
      if (newRole === 'alumni') {
        await conn.execute(
          `INSERT IGNORE INTO alumni_profiles (user_id) VALUES (?)`,
          [targetId]
        );
      }
    });

    // Changing role invalidates existing tokens so the new permissions apply
    // on the next request rather than after up to 15 minutes.
    const sessionsRevoked = await revokeAllUserTokens(getPool(), targetId);

    res.json({
      success: true,
      message: `${rows[0].name} is now a ${newRole}. They will need to sign in again.`,
      data: { id: targetId, role: newRole, sessionsRevoked },
    });
  })
);

// ---------------------------------------------------------------------------
// Alumni approval queue
// ---------------------------------------------------------------------------

router.get('/alumni/pending',
  validate([query('page').optional().isInt({ min: 1 }).toInt()]),
  asyncHandler(async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = 20;
    const offset = (page - 1) * pageSize;

    const [countRows] = await getPool().execute(
      `SELECT COUNT(*) AS total FROM alumni_profiles WHERE approved_at IS NULL`
    );
    const total = Number(countRows[0].total);

    const [rows] = await getPool().execute(
      `SELECT u.id, u.name, u.email, u.email_verified_at, u.created_at,
              a.graduation_year, a.degree, a.company, a.designation, a.bio
         FROM alumni_profiles a
         JOIN users u ON u.id = a.user_id
        WHERE a.approved_at IS NULL
        ORDER BY u.created_at ASC
        LIMIT ${pageSize} OFFSET ${offset}`
    );

    res.json({
      success: true,
      data: {
        pending: rows.map((row) => ({
          userId: row.id,
          name: row.name,
          email: row.email,
          emailVerified: Boolean(row.email_verified_at),
          registeredAt: row.created_at,
          graduationYear: row.graduation_year,
          degree: row.degree,
          company: row.company,
          designation: row.designation,
          bio: row.bio,
        })),
        pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
      },
    });
  })
);

router.post('/alumni/:id/approve',
  validate([parseId]),
  asyncHandler(async (req, res) => {
    const targetId = Number(req.params.id);

    const [rows] = await getPool().execute(
      `SELECT u.id, u.name, u.email, u.email_verified_at, a.approved_at
         FROM alumni_profiles a JOIN users u ON u.id = a.user_id WHERE a.user_id = ?`,
      [targetId]
    );
    if (!rows[0]) throw ApiError.notFound('That alumni profile could not be found.', 'ALUMNI_NOT_FOUND');
    if (rows[0].approved_at) throw ApiError.conflict('That alumni profile is already approved.', 'ALREADY_APPROVED');
    if (!rows[0].email_verified_at) {
      throw ApiError.badRequest(
        'This applicant has not verified their email address yet, so they cannot be approved.',
        'EMAIL_NOT_VERIFIED'
      );
    }

    await getPool().execute(
      `UPDATE alumni_profiles SET approved_at = CURRENT_TIMESTAMP, approved_by = ?, rejection_reason = NULL
        WHERE user_id = ?`,
      [req.user.id, targetId]
    );

    try { await sendAccountStatusEmail(rows[0], 'approved'); }
    catch (mailError) { console.error(`[MAIL] Approval notice failed: ${mailError.message}`); }

    res.json({ success: true, message: `${rows[0].name} has been approved and now appears in the alumni directory.` });
  })
);

router.post('/alumni/:id/reject',
  validate([
    parseId,
    body('reason').optional().trim().isLength({ max: 255 }).escape(),
  ]),
  asyncHandler(async (req, res) => {
    const targetId = Number(req.params.id);
    const reason = req.body.reason ? stripTags(req.body.reason, 255) : null;

    const [rows] = await getPool().execute(
      `SELECT u.id, u.name, u.email, a.approved_at FROM alumni_profiles a
         JOIN users u ON u.id = a.user_id WHERE a.user_id = ?`,
      [targetId]
    );
    if (!rows[0]) throw ApiError.notFound('That alumni profile could not be found.', 'ALUMNI_NOT_FOUND');
    if (rows[0].approved_at) throw ApiError.conflict('That alumni profile is already approved.', 'ALREADY_APPROVED');

    await getPool().execute(
      `UPDATE alumni_profiles SET approved_at = NULL, approved_by = NULL, rejection_reason = ? WHERE user_id = ?`,
      [reason, targetId]
    );

    try { await sendAccountStatusEmail(rows[0], 'rejected', reason); }
    catch (mailError) { console.error(`[MAIL] Rejection notice failed: ${mailError.message}`); }

    res.json({ success: true, message: `${rows[0].name}'s application has been rejected.` });
  })
);

// ---------------------------------------------------------------------------
// Event management
// ---------------------------------------------------------------------------

const eventValidators = [
  body('title').trim().isLength({ min: 3, max: 200 }).withMessage('Title must be 3-200 characters.').escape(),
  body('description').optional({ nullable: true }).trim().isLength({ max: 10000 }),
  body('category').optional().trim().isLength({ min: 1, max: 60 }).escape(),
  body('venue').optional({ nullable: true }).trim().isLength({ max: 200 }).escape(),
  body('eventDate').isISO8601().withMessage('Event date must be a valid date/time.').toDate(),
  body('endDate').optional({ nullable: true }).isISO8601().withMessage('End date must be a valid date/time.').toDate(),
  body('capacity').isInt({ min: 0, max: 100000 }).withMessage('Capacity must be between 0 and 100000.').toInt(),
  body('imageUrl').optional({ nullable: true }).trim().isLength({ max: 255 }),
];

router.post('/events', validate(eventValidators), asyncHandler(async (req, res) => {
  if (req.body.endDate && new Date(req.body.endDate) < new Date(req.body.eventDate)) {
    throw ApiError.badRequest('End date cannot be before the start date.', 'VALIDATION_FAILED', [
      { field: 'endDate', message: 'End date cannot be before the start date.' },
    ]);
  }

  const [result] = await getPool().execute(
    `INSERT INTO events (title, description, category, venue, event_date, end_date, capacity, image_url, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      stripTags(req.body.title, 200),
      req.body.description ? stripTags(req.body.description, 10000) : null,
      req.body.category || 'general',
      req.body.venue ? stripTags(req.body.venue, 200) : null,
      toSqlDateTime(req.body.eventDate),
      req.body.endDate ? toSqlDateTime(req.body.endDate) : null,
      req.body.capacity,
      req.body.imageUrl || null,
      req.user.id,
    ]
  );

  res.status(201).json({
    success: true,
    message: 'Event created.',
    data: { id: result.insertId },
  });
}));

router.put('/events/:id', validate([parseId, ...eventValidators]), asyncHandler(async (req, res) => {
  const [rows] = await getPool().execute(`SELECT id, capacity FROM events WHERE id = ?`, [req.params.id]);
  if (!rows[0]) throw ApiError.notFound('That event could not be found.', 'EVENT_NOT_FOUND');

  // Capacity can never be lowered below the number of already-confirmed seats.
  const [[confirmedRow]] = await getPool().execute(
    `SELECT COUNT(*) AS confirmed FROM event_registrations WHERE event_id = ? AND status = 'confirmed'`,
    [req.params.id]
  );
  const confirmed = Number(confirmedRow.confirmed);
  if (Number(req.body.capacity) < confirmed) {
    throw ApiError.badRequest(
      `Capacity cannot be lower than the ${confirmed} confirmed registration(s). Cancel some first or raise capacity.`,
      'CAPACITY_TOO_LOW',
      [{ field: 'capacity', message: `Capacity must be at least ${confirmed}.` }]
    );
  }

  await getPool().execute(
    `UPDATE events SET title = ?, description = ?, category = ?, venue = ?, event_date = ?, end_date = ?, capacity = ?, image_url = ?
      WHERE id = ?`,
    [
      stripTags(req.body.title, 200),
      req.body.description ? stripTags(req.body.description, 10000) : null,
      req.body.category || 'general',
      req.body.venue ? stripTags(req.body.venue, 200) : null,
      toSqlDateTime(req.body.eventDate),
      req.body.endDate ? toSqlDateTime(req.body.endDate) : null,
      req.body.capacity,
      req.body.imageUrl || null,
      req.params.id,
    ]
  );

  res.json({ success: true, message: 'Event updated.' });
}));

router.delete('/events/:id', validate([parseId]), asyncHandler(async (req, res) => {
  const [rows] = await getPool().execute(`SELECT id, title FROM events WHERE id = ?`, [req.params.id]);
  if (!rows[0]) throw ApiError.notFound('That event could not be found.', 'EVENT_NOT_FOUND');

  // Soft delete: registrations and reports stay historically accurate.
  await getPool().execute(`UPDATE events SET is_active = 0 WHERE id = ?`, [req.params.id]);
  res.json({ success: true, message: `"${rows[0].title}" has been removed from the public listings.` });
}));

// ---------------------------------------------------------------------------
// Registration reports + CSV export
// ---------------------------------------------------------------------------

/** Shared WHERE builder so the on-screen report and the CSV match exactly. */
function buildReportFilter(query) {
  const where = [];
  const params = [];
  if (query.eventId) { where.push('r.event_id = ?'); params.push(Number(query.eventId)); }
  if (query.status) { where.push('r.status = ?'); params.push(query.status); }
  if (query.from) { where.push('r.registered_at >= ?'); params.push(query.from); }
  if (query.to) { where.push('r.registered_at <= ?'); params.push(query.to); }
  return { whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

const REPORT_SELECT = `
  SELECT r.id, r.status, r.waitlist_position, r.registered_at, r.cancelled_at,
         e.id AS event_id, e.title AS event_title, e.event_date, e.capacity,
         u.id AS user_id, u.name, u.email, u.role, u.college_id
    FROM event_registrations r
    JOIN events e ON e.id = r.event_id
    JOIN users u ON u.id = r.user_id`;

router.get('/registrations',
  validate([
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('pageSize').optional().isInt({ min: 1, max: 200 }).toInt(),
    query('eventId').optional().isInt({ min: 1 }).toInt(),
    query('status').optional().isIn(['confirmed', 'waitlisted', 'cancelled']),
  ]),
  asyncHandler(async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize) || 25));
    const offset = (page - 1) * pageSize;
    const { whereSql, params } = buildReportFilter(req.query);

    const [countRows] = await getPool().execute(
      `SELECT COUNT(*) AS total FROM event_registrations r JOIN events e ON e.id = r.event_id JOIN users u ON u.id = r.user_id ${whereSql}`,
      params
    );
    const total = Number(countRows[0].total);

    const [rows] = await getPool().execute(
      `${REPORT_SELECT} ${whereSql} ORDER BY r.registered_at DESC, r.id DESC LIMIT ${pageSize} OFFSET ${offset}`,
      params
    );

    res.json({
      success: true,
      data: {
        registrations: rows.map(shapeRegistration),
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

/**
 * CSV export. Uses the RFC 4180 writer in utils/csv.js, which quotes every
 * field and neutralises leading =, +, - and @ so a spreadsheet cannot be
 * tricked into executing a formula built from user-supplied names.
 */
router.get('/registrations/export',
  validate([
    query('eventId').optional().isInt({ min: 1 }).toInt(),
    query('status').optional().isIn(['confirmed', 'waitlisted', 'cancelled']),
  ]),
  asyncHandler(async (req, res) => {
    const { whereSql, params } = buildReportFilter(req.query);
    const [rows] = await getPool().execute(
      `${REPORT_SELECT} ${whereSql} ORDER BY e.event_date DESC, r.registered_at DESC LIMIT 50000`,
      params
    );

    const headers = [
      'Registration ID', 'Status', 'Waitlist Position', 'Registered At', 'Cancelled At',
      'Event ID', 'Event Title', 'Event Date', 'Capacity',
      'Student ID', 'Student Name', 'Email', 'Role', 'College ID',
    ];

    const body = rows.map((row) => [
      row.id,
      row.status,
      row.waitlist_position ?? '',
      formatDateTime(row.registered_at),
      formatDateTime(row.cancelled_at),
      row.event_id,
      row.event_title,
      formatDateTime(row.event_date),
      row.capacity,
      row.user_id,
      row.name,
      row.email,
      row.role,
      row.college_id ?? '',
    ]);

    const csv = buildCsv(headers, body);

    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    // filename is fixed + numeric filters only, so it cannot be header-injected.
    res.setHeader('Content-Disposition', `attachment; filename="registrations-${stamp}.csv"`);
    res.setHeader('Cache-Control', 'no-store');
    // UTF-8 BOM so Excel opens accented characters correctly.
    res.send(`\uFEFF${csv}`);
  })
);

// ---------------------------------------------------------------------------
// Bulk event notification
// ---------------------------------------------------------------------------

router.post('/events/:id/notify',
  validate([
    parseId,
    body('message').trim().isLength({ min: 3, max: 2000 })
      .withMessage('Please write a message of between 3 and 2000 characters.'),
    body('subjectSuffix').optional({ nullable: true }).trim().isLength({ max: 80 }).escape(),
    body('audience').optional().isIn(['confirmed', 'waitlisted', 'all']).withMessage('Invalid audience.'),
  ]),
  asyncHandler(async (req, res) => {
    const eventId = Number(req.params.id);
    const audience = req.body.audience || 'confirmed';

    const [eventRows] = await getPool().execute(
      `SELECT id, title, event_date FROM events WHERE id = ?`, [eventId]
    );
    if (!eventRows[0]) throw ApiError.notFound('That event could not be found.', 'EVENT_NOT_FOUND');

    const statuses = audience === 'all' ? ['confirmed', 'waitlisted'] : [audience];
    const placeholders = statuses.map(() => '?').join(',');

    const [recipients] = await getPool().execute(
      `SELECT DISTINCT u.id, u.name, u.email
         FROM event_registrations r
         JOIN users u ON u.id = r.user_id
        WHERE r.event_id = ? AND r.status IN (${placeholders}) AND u.is_active = 1`,
      [eventId, ...statuses]
    );

    if (recipients.length === 0) {
      throw ApiError.badRequest(`There are no ${audience} attendees registered for this event.`, 'NO_RECIPIENTS');
    }

    const message = stripTags(req.body.message, 2000);
    const results = await sendBulkEventNotification(
      recipients,
      eventRows[0],
      req.body.subjectSuffix || '',
      message
    );

    const delivered = results.filter((r) => r.sent).length;

    res.json({
      success: true,
      message: `Notification sent to ${delivered} of ${recipients.length} attendee(s).${results.length > delivered && results.some((r) => r.mode === 'dev') ? ' (Dev email mode: printed to the server console.)' : ''}`,
      data: { recipients: recipients.length, delivered, failed: results.length - delivered },
    });
  })
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function shapeRegistration(row) {
  return {
    id: row.id,
    status: row.status,
    waitlistPosition: row.waitlist_position,
    registeredAt: row.registered_at,
    cancelledAt: row.cancelled_at,
    event: { id: row.event_id, title: row.event_title, eventDate: row.event_date, capacity: row.capacity },
    user: { id: row.user_id, name: row.name, email: row.email, role: row.role, collegeId: row.college_id },
  };
}

/** Format a date for CSV output without leaking timezone surprises. */
function formatDateTime(value) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

/** JS Date -> 'YYYY-MM-DD HH:MM:SS' for MySQL DATETIME columns (UTC). */
function toSqlDateTime(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

module.exports = router;
