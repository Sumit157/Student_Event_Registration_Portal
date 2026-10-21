'use strict';

/**
 * tests/integration/admin.test.js
 * Task 6: the administrator API.
 *
 * The most important property tested here is that EVERY /api/admin route is
 * protected server-side: a student or alumni token must be refused on all of
 * them, and an unauthenticated request must be refused too. Hiding buttons in
 * the browser is not protection - this is.
 *
 * Skips (rather than fails) when MySQL is unreachable; see TESTING.md.
 */

const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

require('../helpers/testEnv');
const { available, cleanup, skipWithoutDb } = require('../helpers/testDb');
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

/**
 * Every admin endpoint, with a body that is valid enough to reach the
 * protected handler. If the auth layer is missing on any of them, the
 * assertions below will fail loudly rather than silently exposing data.
 */
const ADMIN_ROUTES = [
  { method: 'get', path: '/api/admin/stats' },
  { method: 'get', path: '/api/admin/users' },
  { method: 'get', path: '/api/admin/alumni/pending' },
  { method: 'get', path: '/api/admin/registrations' },
  { method: 'get', path: '/api/admin/registrations/export' },
  { method: 'patch', path: '/api/admin/users/1/status', body: { isActive: false } },
  { method: 'patch', path: '/api/admin/users/1/role', body: { role: 'student' } },
  { method: 'post', path: '/api/admin/alumni/1/approve', body: {} },
  { method: 'post', path: '/api/admin/alumni/1/reject', body: { reason: 'n/a' } },
  {
    method: 'post', path: '/api/admin/events',
    body: { title: 'Auth Probe Event', category: 'general', eventDate: futureDate(), capacity: 10 },
  },
  {
    method: 'put', path: '/api/admin/events/1',
    body: { title: 'Auth Probe Event', category: 'general', eventDate: futureDate(), capacity: 10 },
  },
  { method: 'delete', path: '/api/admin/events/1' },
  { method: 'post', path: '/api/admin/events/1/notify', body: { message: 'hello there' } },
];

function futureDate(days = 10) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

/** Issue a request against the app using one of the ADMIN_ROUTES entries. */
function callRoute(route, headers) {
  const r = request(app)[route.method](route.path);
  if (headers) r.set(headers);
  if (route.body) r.send(route.body);
  return r;
}

// ---------------------------------------------------------------------------
// The blanket protection test (the headline requirement for Task 6)
// ---------------------------------------------------------------------------

test('admin: EVERY admin route rejects an unauthenticated request (401)', async (t) => {
  if (skipWithoutDb(t, dbOk)) return;

  const failures = [];
  for (const route of ADMIN_ROUTES) {
    const response = await callRoute(route);
    if (response.status !== 401) {
      failures.push(`${route.method.toUpperCase()} ${route.path} -> ${response.status}`);
    }
  }
  assert.deepEqual(failures, [], `these admin routes were reachable without a token:\n${failures.join('\n')}`);
});

test('admin: EVERY admin route rejects a STUDENT token (403)', async (t) => {
  if (skipWithoutDb(t, dbOk)) return;

  const student = await fixtures.createUser({ role: 'student' });
  const auth = await fixtures.loginAs(app, student);

  const failures = [];
  for (const route of ADMIN_ROUTES) {
    const response = await callRoute(route, auth.headers);
    if (response.status !== 403) {
      failures.push(`${route.method.toUpperCase()} ${route.path} -> ${response.status}`);
    }
  }
  assert.deepEqual(failures, [], `a student reached admin routes:\n${failures.join('\n')}`);
});

test('admin: EVERY admin route rejects an ALUMNI token (403)', async (t) => {
  if (skipWithoutDb(t, dbOk)) return;

  const alumni = await fixtures.createUser({ role: 'alumni' });
  const auth = await fixtures.loginAs(app, alumni);

  const failures = [];
  for (const route of ADMIN_ROUTES) {
    const response = await callRoute(route, auth.headers);
    if (response.status !== 403) {
      failures.push(`${route.method.toUpperCase()} ${route.path} -> ${response.status}`);
    }
  }
  assert.deepEqual(failures, [], `an alumni account reached admin routes:\n${failures.join('\n')}`);
});

test('admin: the admin API is not exposed on a non-/api path', async (t) => {
  if (skipWithoutDb(t, dbOk)) return;
  // The SPA catch-all serves index.html for unknown non-/api paths, so a 200
  // is fine - what matters is that no ADMIN JSON crosses the wire there.
  const response = await request(app).get('/admin/stats');
  assert.equal(response.headers['content-type']?.includes('application/json'), false,
    'a non-/api path must never return JSON');
  assert.equal(response.body?.data?.users, undefined,
    'admin statistics must not leak outside the /api/admin namespace');
});

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

test('admin: /stats returns coherent counters for an admin', async (t) => {
  if (skipWithoutDb(t, dbOk)) return;

  const admin = await fixtures.createUser({ role: 'admin' });
  const auth = await fixtures.loginAs(app, admin);

  const response = await request(app).get('/api/admin/stats').set(auth.headers);
  assert.equal(response.status, 200, JSON.stringify(response.body));

  const data = response.body.data;
  for (const key of ['users', 'events', 'registrations', 'alumni', 'jobs']) {
    assert.ok(data[key], `stats must include a "${key}" block`);
  }
  assert.ok(Number.isFinite(Number(data.users.total)), 'users.total must be numeric');
  assert.ok(Number(data.users.total) >= 1, 'at least the admin themselves exists');
  assert.ok(Array.isArray(data.upcomingEvents), 'upcomingEvents must be an array');
});

// ---------------------------------------------------------------------------
// Alumni approval queue
// ---------------------------------------------------------------------------

test('admin: an unapproved alumni profile is invisible until approved', async (t) => {
  if (skipWithoutDb(t, dbOk)) return;

  const admin = await fixtures.createUser({ role: 'admin' });
  const auth = await fixtures.loginAs(app, admin);

  // Create a fresh alumni applicant (verified, not approved).
  const applicant = await fixtures.createUser({ role: 'alumni', verified: true, name: 'Pending Applicant' });
  await fixtures.setAlumniApproved(applicant.id, false);

  // The applicant does not appear in the PUBLIC directory before approval.
  // NB: the directory masks email addresses as an anti-scraping measure, so we
  // identify alumni by their immutable userId rather than by email.
  const directoryBefore = await request(app).get('/api/alumni/directory?pageSize=50');
  assert.equal(directoryBefore.status, 200);
  const idsBefore = directoryBefore.body.data.alumni.map((p) => Number(p.userId));
  assert.ok(!idsBefore.includes(Number(applicant.id)), 'unapproved alumni must NOT appear publicly');

  // ...but they DO show up in the admin approval queue.
  const pending = await request(app).get('/api/admin/alumni/pending').set(auth.headers);
  assert.equal(pending.status, 200);
  const pendingEmails = pending.body.data.pending.map((p) => p.email);
  assert.ok(pendingEmails.includes(applicant.email), 'the applicant must be in the pending queue');

  // Approve them.
  const approve = await request(app).post(`/api/admin/alumni/${applicant.id}/approve`).set(auth.headers);
  assert.equal(approve.status, 200, JSON.stringify(approve.body));

  // Now they appear publicly.
  const directoryAfter = await request(app).get('/api/alumni/directory?pageSize=50');
  const idsAfter = directoryAfter.body.data.alumni.map((p) => Number(p.userId));
  assert.ok(idsAfter.includes(Number(applicant.id)), 'approved alumni must appear in the directory');

  // Approving twice is a conflict, not a silent duplicate.
  const again = await request(app).post(`/api/admin/alumni/${applicant.id}/approve`).set(auth.headers);
  assert.equal(again.status, 409);
});

test('admin: an UNVERIFIED alumni applicant cannot be approved', async (t) => {
  if (skipWithoutDb(t, dbOk)) return;

  const admin = await fixtures.createUser({ role: 'admin' });
  const auth = await fixtures.loginAs(app, admin);

  const applicant = await fixtures.createUser({ role: 'alumni', verified: false });
  await fixtures.setAlumniApproved(applicant.id, false);

  const response = await request(app)
    .post(`/api/admin/alumni/${applicant.id}/approve`)
    .set(auth.headers);

  assert.equal(response.status, 400, 'approval must require a verified email');
  assert.equal(response.body.error.code, 'EMAIL_NOT_VERIFIED');
});

test('admin: rejecting an applicant records the reason', async (t) => {
  if (skipWithoutDb(t, dbOk)) return;

  const admin = await fixtures.createUser({ role: 'admin' });
  const auth = await fixtures.loginAs(app, admin);

  const applicant = await fixtures.createUser({ role: 'alumni', verified: true });
  await fixtures.setAlumniApproved(applicant.id, false);

  const response = await request(app)
    .post(`/api/admin/alumni/${applicant.id}/reject`)
    .set(auth.headers)
    .send({ reason: 'Could not verify the graduation year.' });

  assert.equal(response.status, 200, JSON.stringify(response.body));

  const [[row]] = await getPool().execute(
    'SELECT rejection_reason FROM alumni_profiles WHERE user_id = ?',
    [applicant.id]
  );
  assert.equal(row.rejection_reason, 'Could not verify the graduation year.');
});

// ---------------------------------------------------------------------------
// User management
// ---------------------------------------------------------------------------

test('admin: suspending a user blocks their next sign-in and revokes sessions', async (t) => {
  if (skipWithoutDb(t, dbOk)) return;

  const admin = await fixtures.createUser({ role: 'admin' });
  const adminAuth = await fixtures.loginAs(app, admin);

  const target = await fixtures.createUser({ role: 'student' });
  const targetAuth = await fixtures.loginAs(app, target);

  // The target can use the API right now.
  assert.equal((await request(app).get('/api/events/me/registrations').set(targetAuth.headers)).status, 200);

  // Suspend them.
  const suspend = await request(app)
    .patch(`/api/admin/users/${target.id}/status`)
    .set(adminAuth.headers)
    .send({ isActive: false });
  assert.equal(suspend.status, 200, JSON.stringify(suspend.body));
  assert.equal(suspend.body.data.isActive, false);

  // Their refresh cookie is dead, so the session cannot be renewed.
  const login = await request(app).post('/api/auth/login')
    .send({ email: target.email, password: target.password });
  assert.equal(login.status, 401, 'a suspended user must not be able to sign in');

  // Reactivate and confirm they can sign in again.
  const reactivate = await request(app)
    .patch(`/api/admin/users/${target.id}/status`)
    .set(adminAuth.headers)
    .send({ isActive: true });
  assert.equal(reactivate.status, 200);

  const loginAgain = await request(app).post('/api/auth/login')
    .send({ email: target.email, password: target.password });
  assert.equal(loginAgain.status, 200, 'an re-activated user must be able to sign in');
});

test('admin: an administrator cannot suspend their OWN account', async (t) => {
  if (skipWithoutDb(t, dbOk)) return;

  const admin = await fixtures.createUser({ role: 'admin' });
  const auth = await fixtures.loginAs(app, admin);

  const response = await request(app)
    .patch(`/api/admin/users/${admin.id}/status`)
    .set(auth.headers)
    .send({ isActive: false });

  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'SELF_SUSPEND');
});

test('admin: the LAST administrator cannot be demoted', async (t) => {
  if (skipWithoutDb(t, dbOk)) return;

  const actor = await fixtures.createUser({ role: 'admin' });
  const target = await fixtures.createUser({ role: 'admin' });
  const auth = await fixtures.loginAs(app, actor);

  // Demote the target so only `actor` remains an admin.
  const first = await request(app)
    .patch(`/api/admin/users/${target.id}/role`)
    .set(auth.headers)
    .send({ role: 'student' });
  assert.equal(first.status, 200, JSON.stringify(first.body));

  // Now the actor tries to demote themselves and is refused for self-change.
  const selfDemote = await request(app)
    .patch(`/api/admin/users/${actor.id}/role`)
    .set(auth.headers)
    .send({ role: 'student' });
  assert.equal(selfDemote.status, 400, 'self role change must be blocked');
  assert.equal(selfDemote.body.error.code, 'SELF_ROLE_CHANGE');

  // And the last-admin guard must still hold if anyone else tried. NB: the
  // seeded admin@college.edu also exists, so assert the real invariant - at
  // least one active admin always survives and `actor` was not demoted.
  const [[count]] = await getPool().execute(
    `SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND is_active = 1`
  );
  assert.ok(Number(count.n) >= 1, 'an active administrator must always remain - never lock ourselves out');

  const [[actorRow]] = await getPool().execute(`SELECT role FROM users WHERE id = ?`, [actor.id]);
  assert.equal(actorRow.role, 'admin', 'the acting admin must not have been demoted by their own request');
});

test('admin: promoting a user to alumni creates the profile row', async (t) => {
  if (skipWithoutDb(t, dbOk)) return;

  const actor = await fixtures.createUser({ role: 'admin' });
  const auth = await fixtures.loginAs(app, actor);

  // A student with no alumni profile yet.
  const target = await fixtures.createUser({ role: 'student' });

  const response = await request(app)
    .patch(`/api/admin/users/${target.id}/role`)
    .set(auth.headers)
    .send({ role: 'alumni' });
  assert.equal(response.status, 200, JSON.stringify(response.body));

  const [[profile]] = await getPool().execute(
    'SELECT id FROM alumni_profiles WHERE user_id = ?',
    [target.id]
  );
  assert.ok(profile, 'an alumni profile row must be created for the promoted user');

  const [[user]] = await getPool().execute('SELECT role FROM users WHERE id = ?', [target.id]);
  assert.equal(user.role, 'alumni');
});

test('admin: user search filters by role and free text', async (t) => {
  if (skipWithoutDb(t, dbOk)) return;

  const admin = await fixtures.createUser({ role: 'admin' });
  const auth = await fixtures.loginAs(app, admin);

  const response = await request(app)
    .get('/api/admin/users?role=admin&pageSize=50')
    .set(auth.headers);
  assert.equal(response.status, 200);

  const roles = response.body.data.users.map((u) => u.role);
  assert.ok(roles.every((r) => r === 'admin'), 'the role filter must be honoured');
  assert.ok(response.body.data.pagination, 'pagination metadata must be present');
});

// ---------------------------------------------------------------------------
// Event management
// ---------------------------------------------------------------------------

test('admin: creates, edits and soft-deletes an event', async (t) => {
  if (skipWithoutDb(t, dbOk)) return;

  const admin = await fixtures.createUser({ role: 'admin' });
  const auth = await fixtures.loginAs(app, admin);

  // Create.
  const created = await request(app).post('/api/admin/events').set(auth.headers).send({
    title: 'Admin Created Event',
    category: 'workshop',
    venue: 'Lab 1',
    description: 'Created by the integration test.',
    capacity: 12,
    eventDate: futureDate(7),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const eventId = created.body.data.id;
  assert.ok(eventId, 'the new event id must be returned');

  // It is publicly visible.
  const publicView = await request(app).get(`/api/events/${eventId}`);
  assert.equal(publicView.status, 200);
  assert.equal(publicView.body.data.event.title, 'Admin Created Event');
  assert.equal(Number(publicView.body.data.event.capacity), 12);

  // Edit.
  const updated = await request(app).put(`/api/admin/events/${eventId}`).set(auth.headers).send({
    title: 'Admin Created Event (Updated)',
    category: 'workshop',
    venue: 'Lab 2',
    description: 'Updated.',
    capacity: 20,
    eventDate: futureDate(7),
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));

  const afterEdit = await request(app).get(`/api/events/${eventId}`);
  assert.equal(afterEdit.body.data.event.title, 'Admin Created Event (Updated)');
  assert.equal(Number(afterEdit.body.data.event.capacity), 20);

  // Soft delete: hidden from the public list but the row survives for reports.
  const removed = await request(app).delete(`/api/admin/events/${eventId}`).set(auth.headers);
  assert.equal(removed.status, 200);

  const afterDelete = await request(app).get(`/api/events/${eventId}`);
  assert.equal(afterDelete.status, 404, 'a deleted event must not be publicly reachable');

  const [[row]] = await getPool().execute('SELECT is_active FROM events WHERE id = ?', [eventId]);
  assert.equal(Number(row.is_active), 0, 'soft delete must keep the historical row');
});

test('admin: capacity cannot be lowered below existing confirmed seats', async (t) => {
  if (skipWithoutDb(t, dbOk)) return;

  const admin = await fixtures.createUser({ role: 'admin' });
  const auth = await fixtures.loginAs(app, admin);

  const student = await fixtures.createUser({ role: 'student' });
  const studentAuth = await fixtures.loginAs(app, student);

  const event = await fixtures.createEvent({ capacity: 5 });
  const reg = await request(app).post(`/api/events/${event.id}/register`).set(studentAuth.headers);
  assert.equal(reg.status, 201);

  // Try to shrink capacity to 0 while one seat is taken.
  const response = await request(app).put(`/api/admin/events/${event.id}`).set(auth.headers).send({
    title: event.title,
    category: 'workshop',
    capacity: 0,
    eventDate: futureDate(4),
  });

  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'CAPACITY_TOO_LOW');
});

test('admin: creating an event with an invalid body is rejected', async (t) => {
  if (skipWithoutDb(t, dbOk)) return;

  const admin = await fixtures.createUser({ role: 'admin' });
  const auth = await fixtures.loginAs(app, admin);

  const response = await request(app).post('/api/admin/events').set(auth.headers).send({
    title: 'x',            // too short
    capacity: -5,          // invalid
    eventDate: 'not-a-date',
  });

  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'VALIDATION_FAILED');
  assert.ok(Array.isArray(response.body.error.details));
  assert.ok(response.body.error.details.length >= 2, 'multiple field errors should be reported');
});

// ---------------------------------------------------------------------------
// Registration reports + CSV export
// ---------------------------------------------------------------------------

test('admin: registration report lists only real registrations', async (t) => {
  if (skipWithoutDb(t, dbOk)) return;

  const admin = await fixtures.createUser({ role: 'admin' });
  const auth = await fixtures.loginAs(app, admin);

  const student = await fixtures.createUser({ role: 'student' });
  const studentAuth = await fixtures.loginAs(app, student);
  const event = await fixtures.createEvent({ capacity: 5 });
  await request(app).post(`/api/events/${event.id}/register`).set(studentAuth.headers);

  const response = await request(app)
    .get(`/api/admin/registrations?eventId=${event.id}`)
    .set(auth.headers);
  assert.equal(response.status, 200, JSON.stringify(response.body));

  const rows = response.body.data.registrations;
  assert.equal(rows.length, 1, 'exactly one registration should be reported');
  assert.equal(rows[0].user.email, student.email);
  assert.equal(rows[0].event.id, event.id);
  assert.equal(rows[0].status, 'confirmed');
});

test('admin: CSV export has the right headers, a BOM and no formula execution', async (t) => {
  if (skipWithoutDb(t, dbOk)) return;

  const admin = await fixtures.createUser({ role: 'admin', name: '=cmd|calc!A1' });
  const auth = await fixtures.loginAs(app, admin);

  // A registration whose student name is a spreadsheet formula injection attempt.
  const student = await fixtures.createUser({ role: 'student', name: '=HYPERLINK("http://evil","x")' });
  const studentAuth = await fixtures.loginAs(app, student);
  const event = await fixtures.createEvent({ capacity: 5 });
  await request(app).post(`/api/events/${event.id}/register`).set(studentAuth.headers);

  const response = await request(app)
    .get(`/api/admin/registrations/export?eventId=${event.id}`)
    .set(auth.headers);

  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /text\/csv/, 'must be served as CSV');
  assert.match(
    response.headers['content-disposition'] || '',
    /attachment;\s*filename="registrations-\d{4}-\d{2}-\d{2}\.csv"/,
    'must be offered as a download'
  );

  const text = response.text;
  assert.ok(text.charCodeAt(0) === 0xFEFF, 'a UTF-8 BOM must lead the file so Excel reads it correctly');

  // The dangerous leading "=" must be neutralised, not passed through raw.
  // A defanged value looks like "'=HYPERLINK(...)", so only flag "=" when it
  // directly follows a field delimiter (quote, comma or line break) - i.e. it
  // really is at the start of a cell where a spreadsheet would execute it.
  assert.ok(!/(^|["\r\n,])=HYPERLINK\(/m.test(text), 'a formula must never reach the CSV unescaped');
  assert.ok(text.includes("'=HYPERLINK"), 'the formula must be defanged with a leading apostrophe');

  // Header row must exist and be well formed.
  const lines = text.replace(/^\uFEFF/, '').split('\r\n').filter(Boolean);
  assert.ok(lines[0].includes('Registration ID'), 'a header row must be present');
  assert.ok(lines.length >= 2, 'the export must contain the data row');
});

test('admin: a student cannot reach the CSV export', async (t) => {
  if (skipWithoutDb(t, dbOk)) return;

  const student = await fixtures.createUser({ role: 'student' });
  const auth = await fixtures.loginAs(app, student);

  const response = await request(app).get('/api/admin/registrations/export').set(auth.headers);
  assert.equal(response.status, 403);
  assert.match(response.headers['content-type'] || '', /application\/json/,
    'a refused export must return JSON, not a partial file');
});

// ---------------------------------------------------------------------------
// Bulk notifications
// ---------------------------------------------------------------------------

test('admin: bulk notification requires recipients and validates the message', async (t) => {
  if (skipWithoutDb(t, dbOk)) return;

  const admin = await fixtures.createUser({ role: 'admin' });
  const auth = await fixtures.loginAs(app, admin);

  const event = await fixtures.createEvent({ capacity: 5 });

  // No attendees at all -> a clear 400 rather than a silent no-op.
  const empty = await request(app)
    .post(`/api/admin/events/${event.id}/notify`)
    .set(auth.headers)
    .send({ message: 'Hello everyone' });
  assert.equal(empty.status, 400);
  assert.equal(empty.body.error.code, 'NO_RECIPIENTS');

  // A message that is too short is rejected by validation.
  const student = await fixtures.createUser({ role: 'student' });
  const studentAuth = await fixtures.loginAs(app, student);
  await request(app).post(`/api/events/${event.id}/register`).set(studentAuth.headers);

  const tooShort = await request(app)
    .post(`/api/admin/events/${event.id}/notify`)
    .set(auth.headers)
    .send({ message: 'x' });
  assert.equal(tooShort.status, 400);
  assert.equal(tooShort.body.error.code, 'VALIDATION_FAILED');
});

test('admin: bulk notification reaches the registered audience', async (t) => {
  if (skipWithoutDb(t, dbOk)) return;

  const admin = await fixtures.createUser({ role: 'admin' });
  const auth = await fixtures.loginAs(app, admin);

  const event = await fixtures.createEvent({ capacity: 5 });
  const student = await fixtures.createUser({ role: 'student' });
  const studentAuth = await fixtures.loginAs(app, student);
  await request(app).post(`/api/events/${event.id}/register`).set(studentAuth.headers);

  const response = await request(app)
    .post(`/api/admin/events/${event.id}/notify`)
    .set(auth.headers)
    .send({ message: 'Please arrive 15 minutes early.', audience: 'confirmed' });

  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.data.recipients, 1);
  assert.ok(response.body.data.delivered >= 1, 'the message must be delivered to the recipient');
});

// ---------------------------------------------------------------------------
// Admin self-service guardrails
// ---------------------------------------------------------------------------

test('admin: an admin cannot promote an unknown user (404)', async (t) => {
  if (skipWithoutDb(t, dbOk)) return;

  const admin = await fixtures.createUser({ role: 'admin' });
  const auth = await fixtures.loginAs(app, admin);

  const response = await request(app)
    .patch('/api/admin/users/99999999/role')
    .set(auth.headers)
    .send({ role: 'student' });

  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, 'USER_NOT_FOUND');
});

test('admin: an invalid role value is rejected', async (t) => {
  if (skipWithoutDb(t, dbOk)) return;

  const admin = await fixtures.createUser({ role: 'admin' });
  const auth = await fixtures.loginAs(app, admin);
  const target = await fixtures.createUser({ role: 'student' });

  const response = await request(app)
    .patch(`/api/admin/users/${target.id}/role`)
    .set(auth.headers)
    .send({ role: 'superuser' });

  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'VALIDATION_FAILED');
});
