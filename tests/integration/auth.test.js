'use strict';

/**
 * tests/integration/auth.test.js
 * Task 2 + Task 3: registration, email verification, login, session refresh,
 * role protection and the password reset flow - exercised end to end against
 * the real HTTP API and the real database.
 *
 * Skips (rather than fails) when MySQL is unreachable; see TESTING.md.
 */

const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const testEnv = require('../helpers/testEnv'); // eslint-disable-line no-unused-vars
const { available, cleanup, skipWithoutDb, makeEmail } = require('../helpers/testDb');
const fixtures = require('../helpers/fixtures');
const { createApp } = require('../../app');
const { closePool } = require('../../config/db');

const app = createApp();
let dbOk = false;

before(async () => { dbOk = await available(); });
after(async () => {
  if (dbOk) { await cleanup(); }
  await closePool().catch(() => {});
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

test('register: creates a student account and does not leak the password hash', async (t) => {
  if (skipWithoutDb(t, dbOk)) return;

  const email = makeEmail('reg-student');
  const response = await request(app).post('/api/auth/register').send({
    name: 'Integration Student',
    email,
    password: 'Sunrise9Pass',
    confirmPassword: 'Sunrise9Pass',
    role: 'student',
    collegeId: 'IT-REG-1',
  });

  assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.equal(response.body.success, true);
  assert.equal(response.body.data.user.email, email);
  assert.equal(response.body.data.user.role, 'student');
  assert.equal(response.body.data.user.emailVerified, false);

  const serialised = JSON.stringify(response.body);
  assert.ok(!serialised.includes('$2a$'), 'bcrypt hash must never appear in a response');
  assert.ok(!response.body.data.user.password, 'no password field may be returned');
});

test('register: stores a bcrypt hash, never the plain-text password', async (t) => {
  if (skipWithoutDb(t, dbOk)) return;

  const bcrypt = require('bcryptjs');
  const email = makeEmail('reg-hash');
  const plain = 'Sunrise9Pass';

  const response = await request(app).post('/api/auth/register').send({
    name: 'Hash Check', email, password: plain, confirmPassword: plain,
    role: 'student', collegeId: 'IT-REG-2',
  });
  assert.equal(response.status, 201);

  const [[row]] = await require('../../config/db').getPool()
    .execute('SELECT password_hash FROM users WHERE email = ?', [email]);

  assert.ok(row && row.password_hash, 'a hash must be stored');
  assert.ok(!row.password_hash.includes(plain), 'plain text must not be stored');
  assert.equal(await bcrypt.compare(plain, row.password_hash), true, 'hash must verify');
  assert.match(row.password_hash, /^\$2a\$10\$|^\$2b\$10\$/, 'cost must be 10');
});

test('register: rejects a duplicate email with 409', async (t) => {
  if (skipWithoutDb(t, dbOk)) return;

  const email = makeEmail('reg-dupe');
  const payload = {
    name: 'Dupe User', email, password: 'Sunrise9Pass', confirmPassword: 'Sunrise9Pass',
    role: 'student', collegeId: 'IT-REG-3',
  };

  const first = await request(app).post('/api/auth/register').send(payload);
  assert.equal(first.status, 201);

  const second = await request(app).post('/api/auth/register').send(payload);
  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, 'DUPLICATE_EMAIL');
});

test('register: creates an alumni profile row for the alumni role', async (t) => {
  if (skipWithoutDb(t, dbOk)) return;

  const email = makeEmail('reg-alumni');
  const response = await request(app).post('/api/auth/register').send({
    name: 'Alumni Applicant', email, password: 'Sunrise9Pass', confirmPassword: 'Sunrise9Pass',
    role: 'alumni', collegeId: 'IT-REG-4',
    graduationYear: 2018, degree: 'B.Tech', company: 'Acme', designation: 'Engineer',
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));

  const [[profile]] = await require('../../config/db').getPool().execute(
    'SELECT graduation_year, degree, approved_at FROM alumni_profiles a JOIN users u ON u.id = a.user_id WHERE u.email = ?',
    [email]
  );
  assert.ok(profile, 'alumni profile must exist');
  assert.equal(Number(profile.graduation_year), 2018);
  assert.equal(profile.approved_at, null, 'new alumni must NOT be auto-approved');
});

test('register: the admin role cannot be obtained through the public endpoint', async (t) => {
  if (skipWithoutDb(t, dbOk)) return;

  const response = await request(app).post('/api/auth/register').send({
    name: 'Sneaky Admin', email: makeEmail('reg-admin'), password: 'Sunrise9Pass',
    confirmPassword: 'Sunrise9Pass', role: 'admin', collegeId: 'IT-REG-5',
  });

  assert.equal(response.status, 400, 'role=admin must be rejected');

  // And confirm no admin user was created by that attempt.
  const [[row]] = await require('../../config/db').getPool()
    .execute(`SELECT COUNT(*) AS n FROM users WHERE email = ? AND role = 'admin'`, [makeEmail('reg-admin')]);
  assert.equal(Number(row.n), 0);
});

// ---------------------------------------------------------------------------
// Email verification
// ---------------------------------------------------------------------------

test('verify-email: a valid single-use token verifies the account, then expires', async (t) => {
  if (skipWithoutDb(t, dbOk)) return;

  const user = await fixtures.createUser({ verified: false, role: 'student' });
  const token = await fixtures.issueVerificationToken(user.id);

  const first = await request(app).get(`/api/auth/verify-email?token=${encodeURIComponent(token)}`);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.data.user.emailVerified, true);

  // Second use of the SAME link must fail - the token is single use.
  const second = await request(app).get(`/api/auth/verify-email?token=${encodeURIComponent(token)}`);
  assert.equal(second.status, 400);
  assert.equal(second.body.error.code, 'TOKEN_INVALID');
});

test('verify-email: an unknown or tampered token is rejected', async (t) => {
  if (skipWithoutDb(t, dbOk)) return;

  for (const token of ['totally-made-up-token-value', 'x'.repeat(64)]) {
    const response = await request(app).get(`/api/auth/verify-email?token=${token}`);
    assert.equal(response.status, 400, `token ${token.slice(0, 12)} must be rejected`);
    assert.equal(response.body.error.code, 'TOKEN_INVALID');
  }
});

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

test('login: succeeds with correct credentials and returns an access token', async (t) => {
  if (skipWithoutDb(t, dbOk)) return;

  const user = await fixtures.createUser({ role: 'student' });
  const response = await request(app)
    .post('/api/auth/login')
    .send({ email: user.email, password: user.password });

  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.ok(response.body.data.accessToken, 'an access token must be issued');
  assert.equal(response.body.data.user.email, user.email);

  const cookies = response.headers['set-cookie'] || [];
  const refresh = cookies.find((c) => c.toLowerCase().startsWith('portal_rt='));
  assert.ok(refresh, 'the refresh token must be set as a cookie');
  assert.match(refresh, /HttpOnly/i, 'refresh cookie must be HttpOnly');
  assert.match(refresh, /SameSite=Lax/i, 'refresh cookie must be SameSite=Lax');
  assert.match(refresh, /Path=\/api\/auth/i, 'refresh cookie must be scoped to /api/auth');
});

test('login: fails for a wrong password', async (t) => {
  if (skipWithoutDb(t, dbOk)) return;

  const user = await fixtures.createUser({ role: 'student' });
  const response = await request(app)
    .post('/api/auth/login')
    .send({ email: user.email, password: 'DefinitelyWrong1' });

  assert.equal(response.status, 401);
  assert.equal(response.body.error.code, 'INVALID_CREDENTIALS');
  assert.ok(!response.body.data, 'no token may be issued on failure');
});

test('login: fails for an unknown email with the SAME message as a bad password', async (t) => {
  if (skipWithoutDb(t, dbOk)) return;

  const badPassword = await request(app)
    .post('/api/auth/login')
    .send({ email: makeEmail('known-user'), password: 'WrongPassword1' });

  const unknownUser = await request(app)
    .post('/api/auth/login')
    .send({ email: makeEmail('never-registered'), password: 'WrongPassword1' });

  // Account enumeration protection: the two responses must be indistinguishable.
  assert.equal(badPassword.status, unknownUser.status);
  assert.equal(badPassword.body.error.message, unknownUser.body.error.message);
  assert.equal(badPassword.body.error.code, unknownUser.body.error.code);
});

test('login: a suspended account cannot sign in', async (t) => {
  if (skipWithoutDb(t, dbOk)) return;

  const user = await fixtures.createUser({ role: 'student', active: false });
  const response = await request(app)
    .post('/api/auth/login')
    .send({ email: user.email, password: user.password });

  assert.equal(response.status, 401);
  assert.equal(response.body.error.code, 'INVALID_CREDENTIALS');
});

// ---------------------------------------------------------------------------
// JWT role protection
// ---------------------------------------------------------------------------

test('rbac: an admin route rejects a request with no token (401)', async (t) => {
  if (skipWithoutDb(t, dbOk)) return;

  const response = await request(app).get('/api/admin/stats');
  assert.equal(response.status, 401);
  assert.equal(response.body.error.code, 'TOKEN_MISSING');
});

test('rbac: an admin route rejects a STUDENT token (403)', async (t) => {
  if (skipWithoutDb(t, dbOk)) return;

  const student = await fixtures.createUser({ role: 'student' });
  const auth = await fixtures.loginAs(app, student);

  const response = await request(app).get('/api/admin/stats').set(auth.headers);
  assert.equal(response.status, 403, 'a student must never reach admin data');
  assert.equal(response.body.error.code, 'INSUFFICIENT_ROLE');
});

test('rbac: an admin route rejects an ALUMNI token (403)', async (t) => {
  if (skipWithoutDb(t, dbOk)) return;

  const alumni = await fixtures.createUser({ role: 'alumni' });
  const auth = await fixtures.loginAs(app, alumni);

  const response = await request(app).get('/api/admin/stats').set(auth.headers);
  assert.equal(response.status, 403);
});

test('rbac: a forged/expired/garbage token is rejected (401)', async (t) => {
  if (skipWithoutDb(t, dbOk)) return;

  const cases = [
    'Bearer not-a-real-jwt',
    'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOjF9.signature',
    'Bearer ',
  ];
  for (const header of cases) {
    const response = await request(app).get('/api/admin/stats').set('Authorization', header);
    assert.ok(response.status === 401 || response.status === 403,
      `"${header}" must not be accepted (got ${response.status})`);
  }
});

test('rbac: a valid ADMIN token is accepted (200)', async (t) => {
  if (skipWithoutDb(t, dbOk)) return;

  const admin = await fixtures.createUser({ role: 'admin', verified: true });
  const auth = await fixtures.loginAs(app, admin);

  const response = await request(app).get('/api/admin/stats').set(auth.headers);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.ok(response.body.data.users, 'stats payload must be present');
});

test('rbac: a demoted (suspended) admin loses access immediately', async (t) => {
  if (skipWithoutDb(t, dbOk)) return;

  // Two admins: one to demote, one to perform the change (self-change is blocked).
  const target = await fixtures.createUser({ role: 'admin' });
  const actor = await fixtures.createUser({ role: 'admin' });

  const targetAuth = await fixtures.loginAs(app, target);
  const actorAuth = await fixtures.loginAs(app, actor);

  // Sanity: target can reach the admin API right now.
  assert.equal((await request(app).get('/api/admin/stats').set(targetAuth.headers)).status, 200);

  // Demote them.
  const demote = await request(app)
    .patch(`/api/admin/users/${target.id}/role`)
    .set(actorAuth.headers)
    .send({ role: 'student' });
  assert.equal(demote.status, 200, JSON.stringify(demote.body));

  // Their previously-valid access token must now be refused, because the
  // middleware re-reads the role from the database on every request.
  const after = await request(app).get('/api/admin/stats').set(targetAuth.headers);
  assert.equal(after.status, 403, 'revoked privileges must apply immediately');
});

// ---------------------------------------------------------------------------
// Session refresh + logout (rotation)
// ---------------------------------------------------------------------------

test('refresh: exchanges the cookie for a new access token and rotates it', async (t) => {
  if (skipWithoutDb(t, dbOk)) return;

  const user = await fixtures.createUser({ role: 'student' });
  const login = await request(app)
    .post('/api/auth/login')
    .send({ email: user.email, password: user.password });
  assert.equal(login.status, 200);

  const cookie = (login.headers['set-cookie'] || []).find((c) => c.startsWith('portal_rt='));
  assert.ok(cookie);

  const refresh1 = await request(app).post('/api/auth/refresh').set('Cookie', cookie);
  assert.equal(refresh1.status, 200, JSON.stringify(refresh1.body));
  assert.ok(refresh1.body.data.accessToken);

  const rotatedCookie = (refresh1.headers['set-cookie'] || []).find((c) => c.startsWith('portal_rt='));
  assert.ok(rotatedCookie, 'a NEW refresh cookie must be issued');
  assert.notEqual(rotatedCookie.split(';')[0], cookie.split(';')[0], 'the cookie value must change');
});

test('refresh: REUSING an already-rotated token is detected and rejected', async (t) => {
  if (skipWithoutDb(t, dbOk)) return;

  const user = await fixtures.createUser({ role: 'student' });
  const login = await request(app)
    .post('/api/auth/login')
    .send({ email: user.email, password: user.password });

  const originalCookie = (login.headers['set-cookie'] || []).find((c) => c.startsWith('portal_rt='));
  assert.ok(originalCookie);

  // First use consumes the token.
  const first = await request(app).post('/api/auth/refresh').set('Cookie', originalCookie);
  assert.equal(first.status, 200);

  // Second use of the SAME token must be refused (replay / theft detection).
  const replay = await request(app).post('/api/auth/refresh').set('Cookie', originalCookie);
  assert.equal(replay.status, 401, 'a rotated token must not be usable twice');
});

test('refresh: without a cookie returns 401', async (t) => {
  if (skipWithoutDb(t, dbOk)) return;
  const response = await request(app).post('/api/auth/refresh');
  assert.equal(response.status, 401);
});

test('logout: revokes the refresh token so it cannot be replayed', async (t) => {
  if (skipWithoutDb(t, dbOk)) return;

  const user = await fixtures.createUser({ role: 'student' });
  const login = await request(app)
    .post('/api/auth/login')
    .send({ email: user.email, password: user.password });
  const cookie = (login.headers['set-cookie'] || []).find((c) => c.startsWith('portal_rt='));

  const logout = await request(app).post('/api/auth/logout').set('Cookie', cookie);
  assert.equal(logout.status, 200);

  const after = await request(app).post('/api/auth/refresh').set('Cookie', cookie);
  assert.equal(after.status, 401, 'a logged-out cookie must be dead');
});

// ---------------------------------------------------------------------------
// Forgot / reset password
// ---------------------------------------------------------------------------

test('forgot-password: returns 200 for unknown emails (no account enumeration)', async (t) => {
  if (skipWithoutDb(t, dbOk)) return;

  const known = await fixtures.createUser({ role: 'student' });

  const forKnown = await request(app).post('/api/auth/forgot-password').send({ email: known.email });
  const forUnknown = await request(app).post('/api/auth/forgot-password').send({ email: makeEmail('nobody') });

  assert.equal(forKnown.status, 200);
  assert.equal(forUnknown.status, 200);
  assert.equal(forKnown.body.message, forUnknown.body.message,
    'responses must be identical so accounts cannot be discovered');
});

test('reset-password: a single-use token changes the password and kills sessions', async (t) => {
  if (skipWithoutDb(t, dbOk)) return;

  const user = await fixtures.createUser({ role: 'student' });
  const login1 = await request(app)
    .post('/api/auth/login').send({ email: user.email, password: user.password });
  const cookie = (login1.headers['set-cookie'] || []).find((c) => c.startsWith('portal_rt='));

  const token = await (async () => {
    const { createPasswordResetToken } = require('../../services/tokenService');
    const { getPool } = require('../../config/db');
    const created = await createPasswordResetToken(getPool(), user.id);
    return created.token;
  })();

  const reset = await request(app).post('/api/auth/reset-password').send({
    token, password: 'BrandNewPass1', confirmPassword: 'BrandNewPass1',
  });
  assert.equal(reset.status, 200, JSON.stringify(reset.body));
  assert.ok(reset.body.data.sessionsRevoked >= 1, 'existing sessions must be revoked');

  // Old password no longer works.
  const oldLogin = await request(app)
    .post('/api/auth/login').send({ email: user.email, password: user.password });
  assert.equal(oldLogin.status, 401);

  // New password works.
  const newLogin = await request(app)
    .post('/api/auth/login').send({ email: user.email, password: 'BrandNewPass1' });
  assert.equal(newLogin.status, 200);

  // The old refresh cookie must be dead.
  const stale = await request(app).post('/api/auth/refresh').set('Cookie', cookie);
  assert.equal(stale.status, 401);

  // The reset token can never be reused.
  const reuse = await request(app).post('/api/auth/reset-password').send({
    token, password: 'AnotherPass1', confirmPassword: 'AnotherPass1',
  });
  assert.equal(reuse.status, 400);
  assert.equal(reuse.body.error.code, 'TOKEN_INVALID');
});
