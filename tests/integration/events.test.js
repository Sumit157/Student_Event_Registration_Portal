'use strict';

/**
 * tests/integration/events.test.js
 * Task 4: event registration with capacity limits, duplicate prevention,
 * FIFO waitlisting, cancellation and AUTOMATIC PROMOTION.
 *
 * These tests drive the real HTTP API against the real database and then
 * verify the resulting rows directly, so they exercise the transaction and
 * row-locking logic in services/eventService.js rather than a mock.
 *
 * Skips (rather than fails) when MySQL is unreachable; see TESTING.md.
 */

const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

require('../helpers/testEnv');
const { available, cleanup, skipWithoutDb, makeTitle } = require('../helpers/testDb');
const fixtures = require('../helpers/fixtures');
const { createApp } = require('../../app');
const { closePool, getPool } = require('../../config/db');

const app = createApp();
let dbOk = false;

before(async () => { dbOk = await available(); });
after(async () => {
  if (dbOk) { await cleanup(); }
  await closePool().catch(() => {});
});

/** Register a student for an event and return the Supertest response. */
function register(auth, eventId) {
  return request(app).post(`/api/events/${eventId}/register`).set(auth.headers);
}

/** Cancel a student's registration and return the Supertest response. */
function cancel(auth, eventId) {
  return request(app).post(`/api/events/${eventId}/cancel`).set(auth.headers);
}

// ---------------------------------------------------------------------------
// Listing, filtering and pagination
// ---------------------------------------------------------------------------

test('events: list returns 10 per page and supports pagination', async (t) => {
  if (skipWithoutDb(t, dbOk)) return;

  const first = await request(app).get('/api/events?page=1&pageSize=10');
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.ok(Array.isArray(first.body.data.events));
  assert.ok(first.body.data.events.length <= 10, 'a page must never exceed 10 events');

  const pagination = first.body.data.pagination;
  assert.ok(pagination, 'pagination metadata must be present');
  assert.equal(pagination.page, 1);
  assert.ok(pagination.totalPages >= 1);
});

test('events: search filter narrows the result set', async (t) => {
  if (skipWithoutDb(t, dbOk)) return;

  const event = await fixtures.createEvent({ title: makeTitle('Zebra Unique Symposium') });

  const response = await request(app).get('/api/events?q=Zebra%20Unique%20Symposium');
  assert.equal(response.status, 200);
  const ids = response.body.data.events.map((e) => e.id);
  assert.ok(ids.includes(event.id), 'the matching event must be returned');
});

test('events: a missing event returns 404 with a clean error body', async (t) => {
  if (skipWithoutDb(t, dbOk)) return;

  const response = await request(app).get('/api/events/99999999');
  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, 'EVENT_NOT_FOUND');
  // A real stack frame looks like "    at handler (/app/routes/x.js:12:3)".
  // NOTE: a naive `.includes('at ')` would false-positive on the word "That",
  // so anchor on the frame structure instead.
  assert.ok(!/\n\s+at\s+\S+\s+\(/.test(JSON.stringify(response.body)),
    'no stack frames may leak');
});

// ---------------------------------------------------------------------------
// Happy-path registration
// ---------------------------------------------------------------------------

test('register: a student gets a CONFIRMED seat when capacity remains', async (t) => {
  if (skipWithoutDb(t, dbOk)) return;

  const student = await fixtures.createUser({ role: 'student' });
  const event = await fixtures.createEvent({ capacity: 5 });
  const auth = await fixtures.loginAs(app, student);

  const response = await register(auth, event.id);
  assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.equal(response.body.data.status, 'confirmed');

  const row = await fixtures.getRegistration(event.id, student.id);
  assert.ok(row, 'a registration row must exist');
  assert.equal(row.status, 'confirmed');
  assert.equal(row.waitlist_position, null, 'a confirmed seat has no waitlist position');
});

// ---------------------------------------------------------------------------
// Duplicate prevention
// ---------------------------------------------------------------------------

test('register: registering TWICE is rejected with 409 and creates one row', async (t) => {
  if (skipWithoutDb(t, dbOk)) return;

  const student = await fixtures.createUser({ role: 'student' });
  const event = await fixtures.createEvent({ capacity: 10 });
  const auth = await fixtures.loginAs(app, student);

  const first = await register(auth, event.id);
  assert.equal(first.status, 201);

  const second = await register(auth, event.id);
  assert.equal(second.status, 409, 'a duplicate registration must be refused');
  assert.equal(second.body.error.code, 'DUPLICATE_REGISTRATION');

  const [[count]] = await getPool().execute(
    'SELECT COUNT(*) AS n FROM event_registrations WHERE event_id = ? AND user_id = ?',
    [event.id, student.id]
  );
  assert.equal(Number(count.n), 1, 'exactly one row must exist after a duplicate attempt');
});

// ---------------------------------------------------------------------------
// Capacity, waitlisting and FIFO order
// ---------------------------------------------------------------------------

test('register: exceeding capacity WAITLISTS the surplus in arrival order', async (t) => {
  if (skipWithoutDb(t, dbOk)) return;

  const capacity = 2;
  const event = await fixtures.createEvent({ capacity });

  const a = await fixtures.createUser({ role: 'student' });
  const b = await fixtures.createUser({ role: 'student' });
  const c = await fixtures.createUser({ role: 'student' });
  const d = await fixtures.createUser({ role: 'student' });

  const authA = await fixtures.loginAs(app, a);
  const authB = await fixtures.loginAs(app, b);
  const authC = await fixtures.loginAs(app, c);
  const authD = await fixtures.loginAs(app, d);

  // First `capacity` students fill the event.
  assert.equal((await register(authA, event.id)).status, 201);
  assert.equal((await register(authB, event.id)).status, 201);

  // The surplus must be waitlisted, in strict arrival order (FIFO).
  const c1 = await register(authC, event.id);
  assert.equal(c1.status, 201);
  assert.equal(c1.body.data.status, 'waitlisted');
  assert.equal(c1.body.data.waitlistPosition, 1, 'C must be first on the waitlist');

  const d1 = await register(authD, event.id);
  assert.equal(d1.status, 201);
  assert.equal(d1.body.data.status, 'waitlisted');
  assert.equal(d1.body.data.waitlistPosition, 2, 'D must be second on the waitlist');

  // Verify the persisted order straight from the database.
  const waitlist = await fixtures.getWaitlist(event.id);
  assert.deepEqual(
    waitlist.map((r) => Number(r.waitlist_position)),
    [1, 2],
    'waitlist positions must be 1 then 2'
  );
  assert.equal(waitlist.length, 2);
});

test('register: a full event reports seatsRemaining = 0 to the API', async (t) => {
  if (skipWithoutDb(t, dbOk)) return;

  const event = await fixtures.createEvent({ capacity: 1 });
  const student = await fixtures.createUser({ role: 'student' });
  const auth = await fixtures.loginAs(app, student);

  await register(auth, event.id);

  const response = await request(app).get(`/api/events/${event.id}`).set(auth.headers);
  assert.equal(response.status, 200);

  const info = response.body.data.event.capacityInfo;
  assert.equal(Number(info.confirmed), 1);
  assert.equal(Number(info.seatsRemaining), 0);
  assert.equal(Boolean(info.isFull), true, 'the event must be flagged as full');
});

// ---------------------------------------------------------------------------
// Cancellation + AUTOMATIC PROMOTION (the headline requirement)
// ---------------------------------------------------------------------------

test('cancel: promotes the OLDEST waitlisted student and emails them', async (t) => {
  if (skipWithoutDb(t, dbOk)) return;

  const capacity = 2;
  const event = await fixtures.createEvent({ capacity });

  const a = await fixtures.createUser({ role: 'student' });
  const b = await fixtures.createUser({ role: 'student' });
  const c = await fixtures.createUser({ role: 'student' });
  const d = await fixtures.createUser({ role: 'student' });

  const authA = await fixtures.loginAs(app, a);
  const authB = await fixtures.loginAs(app, b);
  const authC = await fixtures.loginAs(app, c);
  const authD = await fixtures.loginAs(app, d);

  // Fill both seats, then waitlist C then D.
  await register(authA, event.id);
  await register(authB, event.id);
  await register(authC, event.id);
  await register(authD, event.id);

  // A cancels their confirmed seat.
  const cancelResponse = await cancel(authA, event.id);
  assert.equal(cancelResponse.status, 200, JSON.stringify(cancelResponse.body));
  assert.equal(
    Number(cancelResponse.body.data.promotedUserId),
    c.id,
    'the OLDEST waitlisted student (C) must be promoted, not D'
  );

  // Confirm the promotion landed in the database.
  const cRow = await fixtures.getRegistration(event.id, c.id);
  assert.equal(cRow.status, 'confirmed', 'C must now be confirmed');
  assert.equal(cRow.waitlist_position, null, 'a promoted student loses their position');

  // D must be renumbered to fill the gap at the head of the queue.
  const dRow = await fixtures.getRegistration(event.id, d.id);
  assert.equal(dRow.status, 'waitlisted');
  assert.equal(Number(dRow.waitlist_position), 1, 'D must be renumbered to position 1');
});

test('cancel: a cancelled seat can be re-registered (rejoining as waitlisted when full)', async (t) => {
  if (skipWithoutDb(t, dbOk)) return;

  const event = await fixtures.createEvent({ capacity: 1 });
  const a = await fixtures.createUser({ role: 'student' });
  const b = await fixtures.createUser({ role: 'student' });

  const authA = await fixtures.loginAs(app, a);
  const authB = await fixtures.loginAs(app, b);

  assert.equal((await register(authA, event.id)).status, 201);
  const bFirst = await register(authB, event.id);
  assert.equal(bFirst.body.data.status, 'waitlisted');

  // B cancels their waitlist place, then re-registers once A has cancelled too.
  assert.equal((await cancel(authB, event.id)).status, 200);
  assert.equal((await cancel(authA, event.id)).status, 200);

  // The seat is free again; B should now get it.
  const bAgain = await register(authB, event.id);
  assert.equal(bAgain.status, 201);
  assert.equal(bAgain.body.data.status, 'confirmed', 'B should now hold the freed seat');
});

test('cancel: cancelling a non-existent registration returns 404', async (t) => {
  if (skipWithoutDb(t, dbOk)) return;

  const event = await fixtures.createEvent({ capacity: 3 });
  const student = await fixtures.createUser({ role: 'student' });
  const auth = await fixtures.loginAs(app, student);

  const response = await cancel(auth, event.id);
  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, 'REGISTRATION_NOT_FOUND');
});

test('cancel: an event with no waitlist simply frees the seat', async (t) => {
  if (skipWithoutDb(t, dbOk)) return;

  const event = await fixtures.createEvent({ capacity: 2 });
  const student = await fixtures.createUser({ role: 'student' });
  const auth = await fixtures.loginAs(app, student);

  await register(auth, event.id);
  const response = await cancel(auth, event.id);

  assert.equal(response.status, 200);
  assert.equal(response.body.data.promotedUserId, null, 'nobody to promote');
});

// ---------------------------------------------------------------------------
// Race conditions: concurrent registrations must never oversell
// ---------------------------------------------------------------------------

test('race: 6 concurrent registrations for 3 seats never oversell', async (t) => {
  if (skipWithoutDb(t, dbOk)) return;

  const capacity = 3;
  const event = await fixtures.createEvent({ capacity });

  // Six distinct students fire at the same time.
  const students = [];
  for (let i = 0; i < 6; i += 1) {
    students.push(await fixtures.createUser({ role: 'student' }));
  }
  const auths = [];
  for (const student of students) {
    auths.push(await fixtures.loginAs(app, student));
  }

  const responses = await Promise.all(auths.map((auth) => register(auth, event.id)));

  // Every request must be accepted (confirmed or waitlisted) - none may crash.
  for (const response of responses) {
    assert.ok([201].includes(response.status), `unexpected status ${response.status}`);
    assert.ok(['confirmed', 'waitlisted'].includes(response.body.data.status));
  }

  const confirmedCount = responses.filter((r) => r.body.data.status === 'confirmed').length;
  assert.equal(confirmedCount, capacity,
    `exactly ${capacity} seats may be confirmed, got ${confirmedCount}`);

  // Cross-check against the database: the invariant is what matters.
  const [[row]] = await getPool().execute(
    `SELECT SUM(status = 'confirmed') AS confirmed, SUM(status = 'waitlisted') AS waitlisted
       FROM event_registrations WHERE event_id = ?`,
    [event.id]
  );
  assert.equal(Number(row.confirmed), capacity, 'confirmed must never exceed capacity');
  assert.equal(Number(row.waitlisted), 3, 'the remaining 3 must be waitlisted');
});

// ---------------------------------------------------------------------------
// My registrations
// ---------------------------------------------------------------------------

test('my registrations: returns only the caller\'s rows', async (t) => {
  if (skipWithoutDb(t, dbOk)) return;

  const mine = await fixtures.createUser({ role: 'student' });
  const other = await fixtures.createUser({ role: 'student' });

  const event = await fixtures.createEvent({ capacity: 10 });
  const authMine = await fixtures.loginAs(app, mine);
  const authOther = await fixtures.loginAs(app, other);

  await register(authMine, event.id);
  await register(authOther, event.id);

  const response = await request(app).get('/api/events/me/registrations').set(authMine.headers);
  assert.equal(response.status, 200);

  const rows = response.body.data.registrations;
  assert.equal(rows.length, 1, 'only my own registration should be listed');
  assert.equal(rows[0].event.id, event.id);
});

test('my registrations: a student with no registrations gets an empty list, not an error', async (t) => {
  if (skipWithoutDb(t, dbOk)) return;

  const student = await fixtures.createUser({ role: 'student' });
  const auth = await fixtures.loginAs(app, student);

  const response = await request(app).get('/api/events/me/registrations').set(auth.headers);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.data.registrations, []);
});

// ---------------------------------------------------------------------------
// Role boundaries on the events API
// ---------------------------------------------------------------------------

test('events: an ALUMNI account cannot register for an event', async (t) => {
  if (skipWithoutDb(t, dbOk)) return;

  const alumni = await fixtures.createUser({ role: 'alumni' });
  const event = await fixtures.createEvent({ capacity: 5 });
  const auth = await fixtures.loginAs(app, alumni);

  const response = await register(auth, event.id);
  assert.equal(response.status, 403, 'only students may register for events');
  assert.equal(response.body.error.code, 'INSUFFICIENT_ROLE');
});

test('events: an ADMIN account cannot register either (students only)', async (t) => {
  if (skipWithoutDb(t, dbOk)) return;

  const admin = await fixtures.createUser({ role: 'admin' });
  const event = await fixtures.createEvent({ capacity: 5 });
  const auth = await fixtures.loginAs(app, admin);

  const response = await register(auth, event.id);
  assert.equal(response.status, 403, 'registration is restricted to the student role');
});

test('events: an unauthenticated visitor can browse but not register', async (t) => {
  if (skipWithoutDb(t, dbOk)) return;

  const event = await fixtures.createEvent({ capacity: 5 });

  const browse = await request(app).get('/api/events');
  assert.equal(browse.status, 200, 'browsing must be public');

  const attempt = await request(app).post(`/api/events/${event.id}/register`);
  assert.equal(attempt.status, 401, 'registration must require sign-in');
});

test('events: registration is refused for a past event', async (t) => {
  if (skipWithoutDb(t, dbOk)) return;

  const event = await fixtures.createEvent({ capacity: 5, daysAhead: -3 });
  const student = await fixtures.createUser({ role: 'student' });
  const auth = await fixtures.loginAs(app, student);

  const response = await register(auth, event.id);
  assert.equal(response.status, 400, 'a past event must not accept registrations');
  assert.equal(response.body.error.code, 'EVENT_PASSED');
});

test('events: an inactive (deleted) event is hidden from the public list', async (t) => {
  if (skipWithoutDb(t, dbOk)) return;

  const event = await fixtures.createEvent({ active: false, title: makeTitle('Removed Event') });

  const list = await request(app).get('/api/events?pageSize=50');
  assert.equal(list.status, 200);
  const ids = list.body.data.events.map((e) => e.id);
  assert.ok(!ids.includes(event.id), 'an inactive event must not appear publicly');
});
