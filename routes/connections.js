'use strict';

/**
 * routes/connections.js
 * Alumni-to-alumni networking. (Assignment Task 5.)
 *
 * State machine: pending -> accepted | rejected. A rejected request can be
 * withdrawn by the sender and re-sent later. The UNIQUE(requester_id,
 * addressee_id) index prevents duplicate requests, and the service checks the
 * reverse direction too so A->B and B->A cannot both exist as pending.
 */

const express = require('express');
const { param } = require('express-validator');

const { getPool, withTransaction } = require('../config/db');
const { ApiError } = require('../utils/errors');
const { asyncHandler } = require('../utils/asyncHandler');
const { validate } = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const { isApprovedAlumni } = require('../services/alumniService');

const router = express.Router();
router.use(authenticate);

/** Connection actions are an alumni-only feature. */
async function requireApprovedAlumni(req) {
  if (req.user.role !== 'alumni') {
    throw ApiError.forbidden('Connections are an alumni-only feature.', 'ALUMNI_ONLY');
  }
  if (!(await isApprovedAlumni(req.user.id))) {
    throw ApiError.forbidden(
      'Your alumni profile must be approved by an administrator before you can connect with others.',
      'ALUMNI_NOT_APPROVED'
    );
  }
}

const parseId = param('id').isInt({ min: 1 }).withMessage('Invalid id.').toInt();

// ---------------------------------------------------------------------------
// Network overview: accepted connections + pending requests in both directions
// ---------------------------------------------------------------------------

router.get('/', asyncHandler(async (req, res) => {
  await requireApprovedAlumni(req);
  const myId = req.user.id;

  const profileSql = `
    SELECT u.id, u.name, a.graduation_year, a.degree, a.company, a.designation, a.profile_picture
      FROM users u
      LEFT JOIN alumni_profiles a ON a.user_id = u.id
     WHERE u.id = ?`;

  const [acceptedRows] = await getPool().execute(
    `SELECT c.id AS connection_id, c.updated_at,
            CASE WHEN c.requester_id = ? THEN c.addressee_id ELSE c.requester_id END AS other_id
       FROM connections c
      WHERE (c.requester_id = ? OR c.addressee_id = ?) AND c.status = 'accepted'
      ORDER BY c.updated_at DESC`,
    [myId, myId, myId]
  );

  const [incomingRows] = await getPool().execute(
    `SELECT c.id AS connection_id, c.created_at, c.requester_id AS other_id
       FROM connections c WHERE c.addressee_id = ? AND c.status = 'pending'
      ORDER BY c.created_at DESC`,
    [myId]
  );

  const [outgoingRows] = await getPool().execute(
    `SELECT c.id AS connection_id, c.created_at, c.addressee_id AS other_id
       FROM connections c WHERE c.requester_id = ? AND c.status = 'pending'
      ORDER BY c.created_at DESC`,
    [myId]
  );

  // Batch-load the profile of every person involved in a single round trip.
  const allIds = [...new Set([...acceptedRows, ...incomingRows, ...outgoingRows].map((r) => r.other_id))];
  const people = {};
  if (allIds.length > 0) {
    const placeholders = allIds.map(() => '?').join(',');
    const [peopleRows] = await getPool().execute(
      `SELECT u.id, u.name, a.graduation_year, a.degree, a.company, a.designation, a.profile_picture
         FROM users u LEFT JOIN alumni_profiles a ON a.user_id = u.id
        WHERE u.id IN (${placeholders})`,
      allIds
    );
    for (const p of peopleRows) {
      people[p.id] = {
        userId: p.id,
        name: p.name,
        graduationYear: p.graduation_year,
        degree: p.degree,
        company: p.company,
        designation: p.designation,
        avatarUrl: p.profile_picture ? `/uploads/${p.profile_picture}` : null,
      };
    }
  }

  res.json({
    success: true,
    data: {
      connections: acceptedRows.map((r) => ({ connectionId: r.connection_id, since: r.updated_at, person: people[r.other_id] })),
      incoming: incomingRows.map((r) => ({ connectionId: r.connection_id, requestedAt: r.created_at, person: people[r.other_id] })),
      outgoing: outgoingRows.map((r) => ({ connectionId: r.connection_id, requestedAt: r.created_at, person: people[r.other_id] })),
    },
  });
}));

// ---------------------------------------------------------------------------
// Send a request
// ---------------------------------------------------------------------------

router.post('/request/:alumniId',
  validate([param('alumniId').isInt({ min: 1 }).toInt()]),
  asyncHandler(async (req, res) => {
    await requireApprovedAlumni(req);
    const targetId = Number(req.params.alumniId);
    const myId = req.user.id;

    if (targetId === myId) {
      throw ApiError.badRequest('You cannot send a connection request to yourself.', 'SELF_CONNECTION');
    }

    // The target must be a real, approved, verified alumnus.
    const [targetRows] = await getPool().execute(
      `SELECT u.id FROM users u JOIN alumni_profiles a ON a.user_id = u.id
        WHERE u.id = ? AND u.role = 'alumni' AND a.approved_at IS NOT NULL AND u.email_verified_at IS NOT NULL`,
      [targetId]
    );
    if (!targetRows[0]) {
      throw ApiError.notFound('That alumni profile could not be found.', 'ALUMNI_NOT_FOUND');
    }

    const outcome = await withTransaction(async (conn) => {
      // Lock any existing relationship in EITHER direction.
      const [existing] = await conn.execute(
        `SELECT id, requester_id, addressee_id, status FROM connections
          WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)
          FOR UPDATE`,
        [myId, targetId, targetId, myId]
      );

      if (existing.length > 0) {
        const row = existing[0];
        const alreadyConnected = row.status === 'accepted';
        if (alreadyConnected) {
          throw ApiError.conflict('You are already connected with this person.', 'ALREADY_CONNECTED');
        }
        if (row.status === 'pending') {
          // They already asked you: accepting is friendlier than an error.
          if (row.requester_id === targetId) {
            await conn.execute(`UPDATE connections SET status = 'accepted' WHERE id = ?`, [row.id]);
            return { autoAccepted: true, connectionId: row.id };
          }
          throw ApiError.conflict('You have already sent this person a request. Please wait for their response.', 'REQUEST_PENDING');
        }
        // Previously rejected -> flip back to pending as a fresh request.
        await conn.execute(
          `UPDATE connections SET requester_id = ?, addressee_id = ?, status = 'pending' WHERE id = ?`,
          [myId, targetId, row.id]
        );
        return { autoAccepted: false, connectionId: row.id };
      }

      const [result] = await conn.execute(
        `INSERT INTO connections (requester_id, addressee_id, status) VALUES (?, ?, 'pending')`,
        [myId, targetId]
      );
      return { autoAccepted: false, connectionId: result.insertId };
    });

    res.status(201).json({
      success: true,
      message: outcome.autoAccepted
        ? 'They had already sent you a request - you are now connected!'
        : 'Connection request sent.',
      data: { connectionId: outcome.connectionId, status: outcome.autoAccepted ? 'accepted' : 'pending' },
    });
  })
);

// ---------------------------------------------------------------------------
// Accept / reject (addressee only)
// ---------------------------------------------------------------------------

router.post('/:id/accept', validate([parseId]), asyncHandler(async (req, res) => {
  await requireApprovedAlumni(req);
  const [rows] = await getPool().execute(
    `SELECT id, requester_id, addressee_id, status FROM connections WHERE id = ? FOR UPDATE`,
    [req.params.id]
  );
  const connection = rows[0];
  if (!connection) throw ApiError.notFound('That connection request could not be found.', 'NOT_FOUND');
  // Only the person who RECEIVED the request may accept it.
  if (Number(connection.addressee_id) !== req.user.id) {
    throw ApiError.forbidden('Only the recipient of a request can accept it.', 'NOT_RECIPIENT');
  }
  if (connection.status !== 'pending') {
    throw ApiError.conflict(`That request has already been ${connection.status}.`, 'NOT_PENDING');
  }

  await getPool().execute(`UPDATE connections SET status = 'accepted' WHERE id = ?`, [req.params.id]);
  res.json({ success: true, message: 'Connection accepted. They are now in your network.' });
}));

router.post('/:id/reject', validate([parseId]), asyncHandler(async (req, res) => {
  await requireApprovedAlumni(req);
  const [rows] = await getPool().execute(
    `SELECT id, requester_id, addressee_id, status FROM connections WHERE id = ? FOR UPDATE`,
    [req.params.id]
  );
  const connection = rows[0];
  if (!connection) throw ApiError.notFound('That connection request could not be found.', 'NOT_FOUND');
  if (Number(connection.addressee_id) !== req.user.id) {
    throw ApiError.forbidden('Only the recipient of a request can reject it.', 'NOT_RECIPIENT');
  }
  if (connection.status !== 'pending') {
    throw ApiError.conflict(`That request has already been ${connection.status}.`, 'NOT_PENDING');
  }

  await getPool().execute(`UPDATE connections SET status = 'rejected' WHERE id = ?`, [req.params.id]);
  res.json({ success: true, message: 'Request declined.' });
}));

/** Withdraw a request you sent, or remove an existing connection. */
router.delete('/:id', validate([parseId]), asyncHandler(async (req, res) => {
  await requireApprovedAlumni(req);
  const [rows] = await getPool().execute(
    `SELECT id, requester_id, addressee_id, status FROM connections WHERE id = ?`,
    [req.params.id]
  );
  const connection = rows[0];
  if (!connection) throw ApiError.notFound('That connection could not be found.', 'NOT_FOUND');

  const myId = req.user.id;
  const involved = Number(connection.requester_id) === myId || Number(connection.addressee_id) === myId;
  if (!involved) throw ApiError.forbidden('You are not part of that connection.', 'NOT_INVOLVED');

  // A hard delete is right here: a withdrawn request should leave no trace that
  // would block re-sending it later.
  await getPool().execute(`DELETE FROM connections WHERE id = ?`, [req.params.id]);
  res.json({ success: true, message: connection.status === 'accepted' ? 'Connection removed.' : 'Request withdrawn.' });
}));

module.exports = router;
