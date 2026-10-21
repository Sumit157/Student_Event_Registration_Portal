'use strict';

/**
 * tests/unit/rbac.test.js
 * Task 3: role based access control.
 *
 * The authorize() / requireVerifiedEmail() middleware are pure decision
 * functions, so they can be tested exhaustively without a database by feeding
 * them synthetic request objects.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/testEnv');
const { authorize, requireVerifiedEmail, extractBearer } = require('../../middleware/auth');

/** Run middleware and capture what it passed to next(). */
function run(middleware, req) {
  return new Promise((resolve) => {
    middleware(req, {}, (error) => resolve(error || null));
  });
}

test('extractBearer parses a standard Authorization header', () => {
  assert.equal(extractBearer({ headers: { authorization: 'Bearer abc.def.ghi' } }), 'abc.def.ghi');
  assert.equal(extractBearer({ headers: { authorization: 'bearer   spaced  ' } }), 'spaced');
});

test('extractBearer returns null for missing or malformed headers', () => {
  assert.equal(extractBearer({ headers: {} }), null);
  assert.equal(extractBearer({ headers: { authorization: 'Basic dXNlcjpwYXNz' } }), null);
  assert.equal(extractBearer({ headers: { authorization: 'Bearer' } }), null);
  assert.equal(extractBearer({ headers: { authorization: 'Bearer ' } }), null);
  assert.equal(extractBearer({ headers: { authorization: '' } }), null);
  // No headers object at all must not throw.
  assert.equal(extractBearer({}), null);
  assert.equal(extractBearer(null), null);
  assert.equal(extractBearer(undefined), null);
});

test('authorize allows a permitted role', async () => {
  const error = await run(authorize('admin'), { user: { id: 1, role: 'admin' } });
  assert.equal(error, null, 'admin should be allowed');
});

test('authorize blocks a non-permitted role with 403', async () => {
  const error = await run(authorize('admin'), { user: { id: 1, role: 'student' } });
  assert.ok(error, 'must be rejected');
  assert.equal(error.statusCode, 403);
  assert.equal(error.code, 'INSUFFICIENT_ROLE');
});

test('authorize blocks alumni from admin routes', async () => {
  const error = await run(authorize('admin'), { user: { id: 1, role: 'alumni' } });
  assert.equal(error.statusCode, 403);
});

test('authorize allows any of several listed roles', async () => {
  const middleware = authorize('student', 'alumni');
  assert.equal(await run(middleware, { user: { role: 'student' } }), null);
  assert.equal(await run(middleware, { user: { role: 'alumni' } }), null);
  const denied = await run(middleware, { user: { role: 'admin' } });
  assert.equal(denied.statusCode, 403, 'admin is not in the allow list');
});

test('authorize returns 401 when there is no user at all', async () => {
  const error = await run(authorize('admin'), {});
  assert.equal(error.statusCode, 401);
  assert.equal(error.code, 'TOKEN_MISSING');
});

test('authorize does not treat an unknown role as privileged', async () => {
  for (const role of ['root', 'superuser', '', undefined, null]) {
    const error = await run(authorize('admin'), { user: { role } });
    assert.ok(error, `role ${String(role)} must not be allowed`);
    assert.ok(error.statusCode === 401 || error.statusCode === 403);
  }
});

test('requireVerifiedEmail blocks an unconfirmed account with 403', async () => {
  const req = { user: { id: 1, role: 'student', emailVerified: false } };
  const error = await new Promise((resolve) => requireVerifiedEmail(req, {}, resolve));
  assert.ok(error);
  assert.equal(error.statusCode, 403);
  assert.equal(error.code, 'EMAIL_NOT_VERIFIED');
  assert.match(error.message, /confirm your email/i);
});

test('requireVerifiedEmail allows a verified account and passes control on', async () => {
  const req = { user: { id: 1, role: 'student', emailVerified: true } };
  const error = await new Promise((resolve) => requireVerifiedEmail(req, {}, resolve));
  // next() is invoked with no argument on success.
  assert.ok(!error, `expected no error, got ${error}`);
});

test('requireVerifiedEmail returns 401 when unauthenticated', async () => {
  const error = await new Promise((resolve) => requireVerifiedEmail({}, {}, resolve));
  assert.equal(error.statusCode, 401);
});
