'use strict';

/**
 * routes/events.js
 * Public event browsing plus the student registration / cancellation API.
 * (Assignment Task 4.)
 *
 * Route order matters: the specific "/me/registrations" path is declared
 * before the parameterised "/:id" routes so it can never be shadowed.
 */

const express = require('express');
const { body, param, query } = require('express-validator');

const { getPool } = require('../config/db');
const { ApiError } = require('../utils/errors');
const { asyncHandler } = require('../utils/asyncHandler');
const { validate } = require('../middleware/validate');
const { authenticate, optionalAuthenticate, authorize } = require('../middleware/auth');
const eventService = require('../services/eventService');
const mailer = require('../services/mailer');

const router = express.Router();

const parseId = param('id').isInt({ min: 1 }).withMessage('Event id must be a positive integer.').toInt();

// ---------------------------------------------------------------------------
// Public: browse and search
// ---------------------------------------------------------------------------

router.get('/',
  validate([
    query('page').optional().isInt({ min: 1 }).withMessage('Page must be 1 or more.').toInt(),
    query('pageSize').optional().isInt({ min: 1, max: 50 }).withMessage('Page size must be between 1 and 50.').toInt(),
    query('category').optional().trim().isLength({ max: 60 }).escape(),
    query('q').optional().trim().isLength({ max: 120 }).escape(),
  ]),
  asyncHandler(async (req, res) => {
    const result = await eventService.listEvents({
      page: req.query.page,
      pageSize: req.query.pageSize || 10, // 10 per page as required
      category: req.query.category || undefined,
      q: req.query.q || undefined,
      from: req.query.from || undefined,
      to: req.query.to || undefined,
      includePast: req.query.includePast === 'true',
    });
    res.json({ success: true, data: result });
  })
);

router.get('/categories', asyncHandler(async (_req, res) => {
  res.json({ success: true, data: { categories: await eventService.listCategories() } });
}));

/** The signed-in student's own registrations (with event details joined). */
router.get('/me/registrations',
  authenticate,
  asyncHandler(async (req, res) => {
    const [rows] = await getPool().execute(
      `SELECT r.id AS registration_id, r.status, r.waitlist_position, r.registered_at, r.cancelled_at,
              e.id AS event_id, e.title, e.category, e.venue, e.event_date, e.end_date, e.capacity, e.description,
              (SELECT COUNT(*) FROM event_registrations x
                WHERE x.event_id = e.id AND x.status = 'confirmed') AS confirmed_count,
              GREATEST(e.capacity - (SELECT COUNT(*) FROM event_registrations x
                WHERE x.event_id = e.id AND x.status = 'confirmed'), 0) AS seats_remaining
         FROM event_registrations r
         JOIN events e ON e.id = r.event_id
        WHERE r.user_id = ?
        ORDER BY e.event_date DESC, r.id DESC`,
      [req.user.id]
    );

    res.json({
      success: true,
      data: {
        registrations: rows.map((row) => ({
          registrationId: row.registration_id,
          status: row.status,
          waitlistPosition: row.waitlist_position,
          registeredAt: row.registered_at,
          cancelledAt: row.cancelled_at,
          seatsRemaining: Number(row.seats_remaining),
          confirmedCount: Number(row.confirmed_count),
          event: {
            id: row.event_id,
            title: row.title,
            category: row.category,
            venue: row.venue,
            description: row.description,
            eventDate: row.event_date ? new Date(row.event_date).toISOString() : null,
            endDate: row.end_date ? new Date(row.end_date).toISOString() : null,
            capacity: Number(row.capacity),
          },
        })),
      },
    });
  })
);

router.get('/:id',
  validate([parseId]),
  optionalAuthenticate,
  asyncHandler(async (req, res) => {
    const detail = await eventService.getEventDetail(req.params.id, req.user ? req.user.id : null);
    res.json({ success: true, data: { event: detail } });
  })
);

// ---------------------------------------------------------------------------
// Student: register / cancel  (transactional, race-condition safe)
// ---------------------------------------------------------------------------

router.post('/:id/register',
  authenticate,
  authorize('student'),
  validate([parseId]),
  asyncHandler(async (req, res) => {
    const eventId = req.params.id;
    const userId = req.user.id;

    const outcome = await eventService.registerForEvent(eventId, userId);

    // Mail is sent AFTER the transaction commits so SMTP latency never holds
    // a row lock. Failures are logged but do not fail the request.
    try {
      if (outcome.status === eventService.STATUS.CONFIRMED) {
        await mailer.sendRegistrationConfirmationEmail(req.user, outcome.event, outcome.seatsRemaining);
      } else {
        await mailer.sendWaitlistEmail(req.user, outcome.event, outcome.waitlistPosition);
      }
    } catch (mailError) {
      console.error(`[MAIL] Registration notification failed: ${mailError.message}`);
    }

    res.status(201).json({
      success: true,
      message: outcome.status === eventService.STATUS.CONFIRMED
        ? 'Your place is confirmed. A confirmation email is on its way.'
        : `The event is full, so you have been added to the waitlist at position ${outcome.waitlistPosition}.`,
      data: {
        status: outcome.status,
        waitlistPosition: outcome.waitlistPosition,
        seatsRemaining: outcome.seatsRemaining,
      },
    });
  })
);

router.post('/:id/cancel',
  authenticate,
  authorize('student'),
  validate([parseId]),
  asyncHandler(async (req, res) => {
    const eventId = req.params.id;
    const userId = req.user.id;

    const outcome = await eventService.cancelRegistration(eventId, userId);

    // Fetch the event so both emails can reference its real title.
    const [eventRows] = await getPool().execute(
      `SELECT id, title, venue, event_date FROM events WHERE id = ?`,
      [eventId]
    );
    const event = eventRows[0] || { id: eventId, title: 'the event' };

    // If someone was promoted off the waitlist, tell them.
    if (outcome.promoted) {
      try {
        const [promotedUser] = await getPool().execute(
          `SELECT id, name, email FROM users WHERE id = ?`,
          [outcome.promoted.userId]
        );
        if (promotedUser[0] && eventRows[0]) {
          await mailer.sendWaitlistPromotionEmail(promotedUser[0], event);
        }
      } catch (mailError) {
        console.error(`[MAIL] Promotion notification failed: ${mailError.message}`);
      }
    }

    try {
      await mailer.sendCancellationEmail(req.user, event);
    } catch (_) { /* best effort */ }

    res.json({
      success: true,
      message: outcome.promoted
        ? 'Your registration is cancelled and the next person on the waitlist has been promoted.'
        : 'Your registration has been cancelled.',
      data: {
        previousStatus: outcome.previousStatus,
        promotedUserId: outcome.promoted ? outcome.promoted.userId : null,
      },
    });
  })
);

module.exports = router;
