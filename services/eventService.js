'use strict';

/**
 * services/eventService.js
 * All capacity-sensitive event operations.
 *
 * CONCURRENCY DESIGN (assignment Task 4, "prevent race conditions"):
 * Every operation that reads or writes a seat count runs inside a transaction
 * and takes a FOR UPDATE row lock on the event BEFORE counting seats. Because
 * MySQL serialises competing transactions on that row, two students clicking
 * "Register" on the last remaining seat cannot both succeed - the second
 * transaction blocks until the first commits, then re-reads the (now updated)
 * count.
 *
 * Email notifications are deliberately NOT sent inside the transaction. A slow
 * SMTP server must never hold a database row lock. Instead the transaction
 * returns a description of what happened, and the route sends mail afterwards
 * on a best-effort basis.
 */

const { withTransaction, getPool } = require('../config/db');
const { ApiError } = require('../utils/errors');

const STATUS = { CONFIRMED: 'confirmed', WAITLISTED: 'waitlisted', CANCELLED: 'cancelled' };

// ---------------------------------------------------------------------------
// Registration  (confirmed vs waitlisted)
// ---------------------------------------------------------------------------

/**
 * Register a student for an event.
 *
 * @param {number} eventId
 * @param {number} userId
 * @returns {Promise<{status:'confirmed'|'waitlisted', waitlistPosition:number|null, seatsRemaining:number, event:object}>}
 * @throws 404 unknown/inactive event, 409 duplicate registration
 */
async function registerForEvent(eventId, userId) {
  return withTransaction(async (conn) => {
    // 1. Lock the event row first. This serialises every concurrent
    //    registration attempt for THIS event onto one another.
    const [eventRows] = await conn.execute(
      `SELECT id, title, capacity, venue, event_date, is_active
         FROM events WHERE id = ? FOR UPDATE`,
      [eventId]
    );
    const event = eventRows && eventRows[0];
    if (!event || !event.is_active) {
      throw ApiError.notFound('That event does not exist or is no longer open for registration.', 'EVENT_NOT_FOUND');
    }

    // Refuse registration for an event that has already started. This check
    // runs INSIDE the transaction, after the row lock, so it cannot race with
    // the event date passing mid-request.
    if (event.event_date && new Date(event.event_date).getTime() <= Date.now()) {
      throw ApiError.badRequest('This event has already taken place, so registration is closed.', 'EVENT_PASSED');
    }

    // 2. Lock any existing registration for this user (prevents duplicates).
    const [existingRows] = await conn.execute(
      `SELECT id, status FROM event_registrations
        WHERE event_id = ? AND user_id = ? FOR UPDATE`,
      [eventId, userId]
    );
    const existing = existingRows && existingRows[0];

    if (existing && existing.status !== STATUS.CANCELLED) {
      throw ApiError.conflict(
        existing.status === STATUS.CONFIRMED
          ? 'You are already registered for this event.'
          : 'You are already on the waitlist for this event.',
        'DUPLICATE_REGISTRATION'
      );
    }

    // 3. Count CONFIRMED seats now that no other transaction can touch them.
    const [countRows] = await conn.execute(
      `SELECT COUNT(*) AS confirmed FROM event_registrations
        WHERE event_id = ? AND status = ?`,
      [eventId, STATUS.CONFIRMED]
    );
    const confirmedCount = Number(countRows[0].confirmed);

    const hasSeat = confirmedCount < Number(event.capacity);
    const status = hasSeat ? STATUS.CONFIRMED : STATUS.WAITLISTED;
    let waitlistPosition = null;

    if (!hasSeat) {
      const [maxRows] = await conn.execute(
        `SELECT COALESCE(MAX(waitlist_position), 0) AS maxPos
           FROM event_registrations WHERE event_id = ? AND status = ?`,
        [eventId, STATUS.WAITLISTED]
      );
      waitlistPosition = Number(maxRows[0].maxPos) + 1;
    }

    // 4. Re-activate a previously cancelled row, or insert a brand new one.
    //    The UNIQUE(event_id, user_id) index is the ultimate duplicate guard.
    if (existing) {
      await conn.execute(
        `UPDATE event_registrations
            SET status = ?, waitlist_position = ?, registered_at = CURRENT_TIMESTAMP, cancelled_at = NULL
          WHERE id = ?`,
        [status, waitlistPosition, existing.id]
      );
    } else {
      await conn.execute(
        `INSERT INTO event_registrations (event_id, user_id, status, waitlist_position)
         VALUES (?, ?, ?, ?)`,
        [eventId, userId, status, waitlistPosition]
      );
    }

    const seatsRemaining = Math.max(0, Number(event.capacity) - (hasSeat ? confirmedCount + 1 : confirmedCount));

    return { status, waitlistPosition, seatsRemaining, event };
  });
}

// ---------------------------------------------------------------------------
// Cancellation with automatic waitlist promotion
// ---------------------------------------------------------------------------

/**
 * Cancel a registration. If the cancelled place was CONFIRMED and the event is
 * full, the OLDEST eligible waitlisted student (lowest registered_at, then
 * lowest id) is promoted to confirmed automatically.
 *
 * @returns {Promise<{previousStatus:string, promoted:object|null}>}
 */
async function cancelRegistration(eventId, userId) {
  return withTransaction(async (conn) => {
    // Lock this student's registration row.
    const [regRows] = await conn.execute(
      `SELECT id, status FROM event_registrations
        WHERE event_id = ? AND user_id = ? FOR UPDATE`,
      [eventId, userId]
    );
    const registration = regRows && regRows[0];

    if (!registration) {
      throw ApiError.notFound('You are not registered for this event.', 'REGISTRATION_NOT_FOUND');
    }
    if (registration.status === STATUS.CANCELLED) {
      throw ApiError.badRequest('Your registration for this event is already cancelled.', 'ALREADY_CANCELLED');
    }

    const previousStatus = registration.status;

    await conn.execute(
      `UPDATE event_registrations
          SET status = ?, cancelled_at = CURRENT_TIMESTAMP, waitlist_position = NULL
        WHERE id = ?`,
      [STATUS.CANCELLED, registration.id]
    );

    let promoted = null;

    // Only a CONFIRMED seat being freed can create capacity for someone else.
    if (previousStatus === STATUS.CONFIRMED) {
      // Oldest waitlisted first; id breaks ties deterministically.
      const [waitRows] = await conn.execute(
        `SELECT id, user_id FROM event_registrations
          WHERE event_id = ? AND status = ?
          ORDER BY registered_at ASC, id ASC
          LIMIT 1 FOR UPDATE`,
        [eventId, STATUS.WAITLISTED]
      );

      if (waitRows.length > 0) {
        promoted = { id: waitRows[0].id, userId: waitRows[0].user_id };
        await conn.execute(
          `UPDATE event_registrations SET status = ?, waitlist_position = NULL WHERE id = ?`,
          [STATUS.CONFIRMED, promoted.id]
        );

        // Re-number the remaining queue so positions stay 1, 2, 3, ...
        await conn.execute(
          `UPDATE event_registrations r
             JOIN (
               SELECT id, ROW_NUMBER() OVER (ORDER BY registered_at ASC, id ASC) AS rn
                 FROM event_registrations
                WHERE event_id = ? AND status = ?
             ) ranked ON ranked.id = r.id
            SET r.waitlist_position = ranked.rn`,
          [eventId, STATUS.WAITLISTED]
        );
      }
    }

    return { previousStatus, promoted };
  });
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Count confirmed attendees and remaining seats for one event. */
async function getEventCapacity(eventId, db = null) {
  const executor = db || getPool();
  const [rows] = await executor.execute(
    `SELECT e.capacity,
            COALESCE(SUM(r.status = 'confirmed'), 0) AS confirmed,
            COALESCE(SUM(r.status = 'waitlisted'), 0) AS waitlisted
       FROM events e
       LEFT JOIN event_registrations r ON r.event_id = e.id
      WHERE e.id = ?
      GROUP BY e.id, e.capacity`,
    [eventId]
  );
  if (!rows.length) return null;
  const row = rows[0];
  const confirmed = Number(row.confirmed);
  return {
    capacity: Number(row.capacity),
    confirmed,
    waitlisted: Number(row.waitlisted),
    seatsRemaining: Math.max(0, Number(row.capacity) - confirmed),
    isFull: confirmed >= Number(row.capacity),
  };
}

/**
 * List events with search, category filter, date filter and pagination.
 *
 * @param {{q?:string, category?:string, from?:string, to?:string, page?:number, pageSize?:number, includePast?:boolean}} options
 */
async function listEvents(options = {}) {
  const page = Math.max(1, Number(options.page) || 1);
  const pageSize = Math.min(50, Math.max(1, Number(options.pageSize) || 10));
  const offset = (page - 1) * pageSize;

  const where = ['e.is_active = 1'];
  const params = [];

  if (options.q) {
    where.push('(e.title LIKE ? OR e.description LIKE ? OR e.venue LIKE ?)');
    const like = `%${options.q}%`;
    params.push(like, like, like);
  }
  if (options.category) {
    where.push('e.category = ?');
    params.push(options.category);
  }
  if (options.from) {
    where.push('e.event_date >= ?');
    params.push(options.from);
  }
  if (options.to) {
    where.push('e.event_date <= ?');
    params.push(options.to);
  }
  if (!options.includePast) {
    // Default view shows upcoming events; past ones are still reachable.
    where.push('e.event_date >= NOW() - INTERVAL 1 DAY');
  }

  const whereSql = `WHERE ${where.join(' AND ')}`;

  const [countRows] = await getPool().execute(
    `SELECT COUNT(*) AS total FROM events e ${whereSql}`,
    params
  );
  const total = Number(countRows[0].total);

  const [rows] = await getPool().execute(
    `SELECT e.id, e.title, e.description, e.category, e.venue, e.event_date, e.end_date,
            e.capacity, e.image_url,
            COALESCE(SUM(r.status = 'confirmed'), 0)  AS confirmed_count,
            COALESCE(SUM(r.status = 'waitlisted'), 0) AS waitlisted_count,
            GREATEST(e.capacity - COALESCE(SUM(r.status = 'confirmed'), 0), 0) AS seats_remaining
       FROM events e
       LEFT JOIN event_registrations r ON r.event_id = e.id
       ${whereSql}
      GROUP BY e.id, e.title, e.description, e.category, e.venue, e.event_date,
               e.end_date, e.capacity, e.image_url
      ORDER BY e.event_date ASC, e.id ASC
      LIMIT ${pageSize} OFFSET ${offset}`,
    params
  );

  return {
    events: rows.map(shapeEvent),
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      hasNext: page * pageSize < total,
      hasPrev: page > 1,
    },
  };
}

/** Normalise an event row, converting dates to ISO strings for the client. */
function shapeEvent(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    category: row.category,
    venue: row.venue,
    eventDate: row.event_date ? new Date(row.event_date).toISOString() : null,
    endDate: row.end_date ? new Date(row.end_date).toISOString() : null,
    capacity: Number(row.capacity),
    imageUrl: row.image_url || null,
    isActive: Boolean(row.is_active),
    confirmedCount: row.confirmed_count !== undefined ? Number(row.confirmed_count) : undefined,
    waitlistedCount: row.waitlisted_count !== undefined ? Number(row.waitlisted_count) : undefined,
    seatsRemaining: row.seats_remaining !== undefined ? Number(row.seats_remaining) : undefined,
  };
}

/** Full detail for a single event, including the caller's own registration. */
async function getEventDetail(eventId, userId = null) {
  const [rows] = await getPool().execute(
    `SELECT e.id, e.title, e.description, e.category, e.venue, e.event_date, e.end_date,
            e.capacity, e.image_url, e.is_active, e.created_at,
            u.name AS creator_name
       FROM events e
       LEFT JOIN users u ON u.id = e.created_by
      WHERE e.id = ? AND e.is_active = 1`,
    [eventId]
  );
  const event = rows && rows[0];
  if (!event) throw ApiError.notFound('That event could not be found.', 'EVENT_NOT_FOUND');

  const capacity = await getEventCapacity(eventId);

  let myRegistration = null;
  if (userId) {
    const [mine] = await getPool().execute(
      `SELECT id, status, waitlist_position, registered_at, cancelled_at
         FROM event_registrations WHERE event_id = ? AND user_id = ?`,
      [eventId, userId]
    );
    if (mine[0]) {
      myRegistration = {
        status: mine[0].status,
        waitlistPosition: mine[0].waitlist_position,
        registeredAt: mine[0].registered_at,
        cancelledAt: mine[0].cancelled_at,
      };
    }
  }

  return { ...shapeEvent(event), createdBy: event.creator_name, capacityInfo: capacity, myRegistration };
}

/** Distinct categories, for populating the filter dropdown. */
async function listCategories() {
  const [rows] = await getPool().execute(
    `SELECT category, COUNT(*) AS count FROM events WHERE is_active = 1 GROUP BY category ORDER BY category ASC`
  );
  return rows.map((r) => ({ category: r.category, count: Number(r.count) }));
}

module.exports = {
  STATUS,
  registerForEvent,
  cancelRegistration,
  getEventCapacity,
  listEvents,
  getEventDetail,
  listCategories,
  shapeEvent,
};
