'use strict';

/**
 * tests/unit/tokens.test.js
 * Task 3: JWT signing/verification, opaque token generation and hashing.
 *
 * These cover the pure functions only - refresh rotation and single-use token
 * consumption need a database and live in tests/integration/.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/testEnv');
const jwt = require('jsonwebtoken');

const tokens = require('../../services/tokenService');
const { env } = require('../../config/env');

test('generateOpaqueToken returns a high-entropy hex string', () => {
  const a = tokens.generateOpaqueToken(48);
  const b = tokens.generateOpaqueToken(48);
  assert.match(a, /^[0-9a-f]{96}$/, '48 bytes must render as 96 hex characters');
  assert.notEqual(a, b, 'two tokens must never collide');
});

test('generateOpaqueToken is unique across many draws', () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i += 1) seen.add(tokens.generateOpaqueToken(16));
  assert.equal(seen.size, 2000, 'expected 2000 distinct tokens');
});

test('hashToken is deterministic, 64 hex chars and not reversible-looking', () => {
  const token = tokens.generateOpaqueToken(32);
  const first = tokens.hashToken(token);
  assert.equal(first, tokens.hashToken(token), 'same input must hash identically');
  assert.match(first, /^[0-9a-f]{64}$/, 'SHA-256 must be 64 hex characters');
  assert.notEqual(first, token, 'the stored value must not be the token itself');
  assert.ok(!first.includes(token), 'the hash must not contain the raw token');
});

test('hashToken differs for a single-character change', () => {
  assert.notEqual(tokens.hashToken('aaaa'), tokens.hashToken('aaab'));
});

test('signAccessToken produces a verifiable token carrying the role claim', () => {
  const user = { id: 42, name: 'Test User', email: 't@example.com', role: 'student', emailVerified: true };
  const token = tokens.signAccessToken(user);

  const decoded = jwt.verify(token, env.jwt.accessSecret, {
    issuer: 'student-portal', audience: 'student-portal-client',
  });

  assert.equal(decoded.sub, 42);
  assert.equal(decoded.role, 'student');
  assert.equal(decoded.ev, 1);
  assert.equal(decoded.typ, 'access');
});

test('verifyAccessToken rejects a token signed with the wrong secret', () => {
  const forged = jwt.sign({ sub: 1, role: 'admin', typ: 'access' }, 'not-the-real-secret');
  assert.throws(() => tokens.verifyAccessToken(forged), (error) => {
    assert.equal(error.statusCode, 401);
    assert.equal(error.code, 'TOKEN_INVALID');
    return true;
  });
});

test('verifyAccessToken rejects a token whose role was tampered with', () => {
  const user = { id: 7, name: 'X', email: 'x@example.com', role: 'student', emailVerified: false };
  const original = tokens.signAccessToken(user);

  // Decode WITHOUT verifying, escalate the role, re-encode. Signature no longer
  // matches, so verification must fail - this is the privilege-escalation test.
  const parts = original.split('.');
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  payload.role = 'admin';
  const tampered = `${parts[0]}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${parts[2]}`;

  assert.throws(() => tokens.verifyAccessToken(tampered), (error) => error.statusCode === 401);
});

test('verifyAccessToken rejects an expired token', () => {
  const stale = jwt.sign(
    { sub: 1, role: 'student', typ: 'access' },
    env.jwt.accessSecret,
    { expiresIn: '-1s', issuer: 'student-portal', audience: 'student-portal-client' }
  );
  assert.throws(() => tokens.verifyAccessToken(stale), (error) => {
    assert.equal(error.statusCode, 401);
    assert.equal(error.code, 'TOKEN_EXPIRED');
    return true;
  });
});

test('verifyAccessToken rejects a token of the wrong type (refresh used as access)', () => {
  const wrongType = jwt.sign(
    { sub: 1, role: 'admin', typ: 'refresh' },
    env.jwt.accessSecret,
    { expiresIn: '5m' }
  );
  assert.throws(() => tokens.verifyAccessToken(wrongType), (error) => error.statusCode === 401);
});

test('verifyAccessToken rejects empty and malformed input', () => {
  assert.throws(() => tokens.verifyAccessToken(''), (e) => e.code === 'TOKEN_MISSING');
  assert.throws(() => tokens.verifyAccessToken(null), (e) => e.code === 'TOKEN_MISSING');
  assert.throws(() => tokens.verifyAccessToken('not-a-jwt'), (e) => e.code === 'TOKEN_INVALID');
});

test('access token expiry matches the configured ~15 minute lifetime', () => {
  const user = { id: 1, name: 'A', email: 'a@b.c', role: 'student', emailVerified: true };
  const decoded = jwt.decode(tokens.signAccessToken(user));
  const lifetimeSeconds = decoded.exp - decoded.iat;
  assert.ok(lifetimeSeconds > 0);
  assert.ok(lifetimeSeconds <= 20 * 60, `expected <= 20 min, got ${lifetimeSeconds}s`);
  assert.equal(env.jwt.accessExpires, '15m');
});
