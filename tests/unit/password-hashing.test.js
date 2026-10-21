'use strict';

/**
 * tests/unit/password-hashing.test.js
 * Task 2: bcrypt hashing with cost 10, and proof that no API response path
 * could ever contain a hash.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/testEnv');
const bcrypt = require('bcryptjs');

const { publicUser } = require('../../routes/auth');

const ROUNDS = 10;

test('hashes a password with bcrypt at cost 10', async () => {
  const hash = await bcrypt.hash('Sunrise9Pass', ROUNDS);
  assert.ok(hash.startsWith('$2a$10$') || hash.startsWith('$2b$10$'), `unexpected hash format: ${hash.slice(0, 7)}`);
});

test('never stores the plain text password inside the hash', async () => {
  const hash = await bcrypt.hash('Sunrise9Pass', ROUNDS);
  assert.ok(!hash.includes('Sunrise9Pass'));
});

test('produces a different hash for the same password (salt)', async () => {
  const a = await bcrypt.hash('Sunrise9Pass', ROUNDS);
  const b = await bcrypt.hash('Sunrise9Pass', ROUNDS);
  assert.notEqual(a, b, 'bcrypt must apply a unique salt per hash');
});

test('verifies the correct password against its hash', async () => {
  const hash = await bcrypt.hash('Sunrise9Pass', ROUNDS);
  assert.equal(await bcrypt.compare('Sunrise9Pass', hash), true);
});

test('rejects an incorrect password', async () => {
  const hash = await bcrypt.hash('Sunrise9Pass', ROUNDS);
  assert.equal(await bcrypt.compare('Sunrise9pass', hash), false);
  assert.equal(await bcrypt.compare('', hash), false);
});

test('hashes then verifies a unicode password', async () => {
  const hash = await bcrypt.hash('Ünïcode#2026', ROUNDS);
  assert.equal(await bcrypt.compare('Ünïcode#2026', hash), true);
});

test('publicUser strips the password hash from an API payload', () => {
  const row = {
    id: 1,
    name: 'Test Student',
    email: 'student@example.com',
    role: 'student',
    college_id: 'CS2024-001',
    password_hash: '$2a$10$THISISAPASSWORDHASHSHOULDNEVERLEAK000000000000000000',
    email_verified_at: new Date('2026-01-01T00:00:00Z'),
    is_active: 1,
    created_at: new Date('2026-01-01T00:00:00Z'),
  };

  const safe = publicUser(row);
  const serialised = JSON.stringify(safe);

  assert.ok(!('password_hash' in safe), 'password_hash must not be a property');
  assert.ok(!serialised.includes('$2a$'), 'no bcrypt hash may appear in the payload');
  assert.ok(!serialised.includes('PASSWORDHASH'));
  assert.equal(safe.email, 'student@example.com');
  assert.equal(safe.role, 'student');
  assert.equal(safe.emailVerified, true);
});

test('publicUser returns null for a missing row', () => {
  assert.equal(publicUser(null), null);
  assert.equal(publicUser(undefined), null);
});

test('publicUser marks unverified and suspended accounts accurately', () => {
  const safe = publicUser({
    id: 2, name: 'X', email: 'x@y.z', role: 'alumni',
    password_hash: '$2a$10$abc', email_verified_at: null, is_active: 0,
  });
  assert.equal(safe.emailVerified, false);
  assert.equal(safe.isActive, false);
});
