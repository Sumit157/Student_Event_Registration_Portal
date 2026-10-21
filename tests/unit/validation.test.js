'use strict';

/**
 * tests/unit/validation.test.js
 * Task 2 / Task 7: input validation and sanitisation on the public
 * registration endpoint.
 *
 * express-validator runs BEFORE the route handler, so these assertions hold
 * without a database connection: a rejected payload never reaches the point
 * where SQL would execute. That also proves invalid input cannot reach a query.
 */

const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

require('../helpers/testEnv');
const { createApp } = require('../../app');
const { closePool } = require('../../config/db');

const app = createApp();

// createApp() lazily creates a MySQL connection pool. When a database IS
// reachable, the final test below reaches the handler and opens a live pooled
// connection; without an explicit close the process would hang forever with all
// tests reported as passed but no summary ever printed. Closing here keeps the
// suite self-contained and lets it exit cleanly whether or not MySQL is up.
after(async () => {
  await closePool().catch(() => {});
});

const VALID_PAYLOAD = {
  name: 'Test Student',
  email: 'validation-test@example.com',
  password: 'Sunrise9Pass',
  confirmPassword: 'Sunrise9Pass',
  role: 'student',
  collegeId: 'CS2024-999',
};

/** Assert the response is a 400 carrying a specific field-level error. */
function assertFieldError(body, field, pattern) {
  assert.equal(body.success, false, 'payload must be reported as a failure');
  assert.equal(body.error.code, 'VALIDATION_FAILED');
  assert.ok(Array.isArray(body.error.details), 'details array must be present');
  const match = body.error.details.find((d) => d.field === field);
  assert.ok(match, `expected a detail for field "${field}", got: ${JSON.stringify(body.error.details)}`);
  if (pattern) assert.match(match.message, pattern);
}

test('rejects a password shorter than eight characters', async () => {
  const response = await request(app)
    .post('/api/auth/register')
    .send({ ...VALID_PAYLOAD, password: 'Ab1def', confirmPassword: 'Ab1def' });

  assert.equal(response.status, 400);
  assertFieldError(response.body, 'password', /at least 8/i);
});

test('rejects a password with no uppercase letter', async () => {
  const response = await request(app)
    .post('/api/auth/register')
    .send({ ...VALID_PAYLOAD, password: 'alllowercase1', confirmPassword: 'alllowercase1' });

  assert.equal(response.status, 400);
  assertFieldError(response.body, 'password', /uppercase/i);
});

test('rejects a password with no number', async () => {
  const response = await request(app)
    .post('/api/auth/register')
    .send({ ...VALID_PAYLOAD, password: 'NoDigitsAtAll', confirmPassword: 'NoDigitsAtAll' });

  assert.equal(response.status, 400);
  assertFieldError(response.body, 'password', /number/i);
});

test('rejects mismatched password confirmation', async () => {
  const response = await request(app)
    .post('/api/auth/register')
    .send({ ...VALID_PAYLOAD, confirmPassword: 'Different9Pass' });

  assert.equal(response.status, 400);
  assertFieldError(response.body, 'confirmPassword', /do not match/i);
});

test('rejects a malformed email address', async () => {
  const response = await request(app)
    .post('/api/auth/register')
    .send({ ...VALID_PAYLOAD, email: 'not-an-email' });

  assert.equal(response.status, 400);
  assertFieldError(response.body, 'email');
});

test('rejects a missing college ID', async () => {
  const response = await request(app)
    .post('/api/auth/register')
    .send({ ...VALID_PAYLOAD, collegeId: '' });

  assert.equal(response.status, 400);
  assertFieldError(response.body, 'collegeId', /college id/i);
});

test('rejects a name that is too short', async () => {
  const response = await request(app)
    .post('/api/auth/register')
    .send({ ...VALID_PAYLOAD, name: 'A' });

  assert.equal(response.status, 400);
  assertFieldError(response.body, 'name');
});

/**
 * Task 3: the admin role must be impossible to obtain through public
 * registration. The validator only accepts student|alumni, so role=admin must
 * be refused BEFORE any database work happens.
 */
test('REFUSES the admin role during public registration', async () => {
  const response = await request(app)
    .post('/api/auth/register')
    .send({ ...VALID_PAYLOAD, role: 'admin' });

  assert.equal(response.status, 400, 'role=admin must never be accepted publicly');
  assertFieldError(response.body, 'role', /student|alumni/i);
});

test('REFUSES an unknown or spoofed role value', async () => {
  for (const role of ['root', 'superadmin', 'administrator', '', 'ADMIN']) {
    const response = await request(app)
      .post('/api/auth/register')
      .send({ ...VALID_PAYLOAD, role });
    assert.equal(response.status, 400, `role "${role}" must be rejected`);
  }
});

test('alumni registration without a graduation year is rejected', async () => {
  const payload = { ...VALID_PAYLOAD, role: 'alumni' };
  delete payload.graduationYear;

  const response = await request(app).post('/api/auth/register').send(payload);

  assert.equal(response.status, 400);
  assertFieldError(response.body, 'graduationYear', /graduation year/i);
});

test('a malformed JSON body returns a clean 400, not a stack trace', async () => {
  const response = await request(app)
    .post('/api/auth/register')
    .set('Content-Type', 'application/json')
    .send('{"name": broken');

  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'INVALID_JSON');
  assert.ok(!JSON.stringify(response.body).includes('SyntaxError'), 'no parser error may leak');
});

test('error responses never contain a stack trace or file path', async () => {
  const response = await request(app)
    .post('/api/auth/register')
    .send({ ...VALID_PAYLOAD, email: 'nope' });

  const serialised = JSON.stringify(response.body);
  assert.ok(!/at\s+\w+\s+\(/.test(serialised), 'must not contain stack frames');
  assert.ok(!serialised.includes('.js:'), 'must not contain source locations');
  assert.ok(!serialised.includes('D:\\'), 'must not contain filesystem paths');
});

test('a well-formed payload passes validation (reaches the handler)', async () => {
  const response = await request(app)
    .post('/api/auth/register')
    .send(VALID_PAYLOAD);

  // The handler itself needs MySQL. Whatever happens there, validation must
  // NOT be the thing that rejected it.
  assert.notEqual(response.status, 400, `unexpected validation failure: ${JSON.stringify(response.body)}`);
  if (response.body && response.body.error) {
    assert.notEqual(response.body.error.code, 'VALIDATION_FAILED');
  }
});
