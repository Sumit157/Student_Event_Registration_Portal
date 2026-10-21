'use strict';

/**
 * tests/unit/password-policy.test.js
 * Task 2: password rules are enforced identically wherever they are checked.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/testEnv');
const { checkPassword, MIN_LENGTH, MAX_LENGTH } = require('../../utils/passwordPolicy');

test('accepts a compliant password', () => {
  const result = checkPassword('Sunrise9Pass');
  assert.equal(result.valid, true, `expected valid, got problems: ${result.problems.join('; ')}`);
  assert.deepEqual(result.problems, []);
});

test('rejects a password shorter than eight characters', () => {
  const result = checkPassword('Ab1def');
  assert.equal(result.valid, false);
  assert.ok(result.problems.some((p) => /at least 8/i.test(p)), 'should mention the length rule');
  assert.equal(result.checks.length, false);
});

test('rejects a password with no uppercase letter', () => {
  const result = checkPassword('alllowercase1');
  assert.equal(result.valid, false);
  assert.ok(result.problems.some((p) => /uppercase/i.test(p)));
  assert.equal(result.checks.uppercase, false);
});

test('rejects a password with no digit', () => {
  const result = checkPassword('NoNumbersHere');
  assert.equal(result.valid, false);
  assert.ok(result.problems.some((p) => /number/i.test(p)));
  assert.equal(result.checks.digit, false);
});

test('rejects an all-uppercase password with no lowercase', () => {
  const result = checkPassword('PASSWORD123');
  assert.equal(result.valid, false);
  assert.ok(result.problems.some((p) => /lowercase/i.test(p)));
});

test('rejects an empty or non-string password', () => {
  assert.equal(checkPassword('').valid, false);
  assert.equal(checkPassword(null).valid, false);
  assert.equal(checkPassword(undefined).valid, false);
});

test('accepts a symbol in place of a lowercase letter', () => {
  // "PASSWORD#1" is legal: uppercase, digit, and a symbol counts as non-upper.
  const result = checkPassword('PASSWORD#1');
  assert.equal(result.valid, true, result.problems.join('; '));
});

test('rejects a password beyond the maximum length', () => {
  const result = checkPassword(`Aa1${'x'.repeat(MAX_LENGTH)}`);
  assert.equal(result.valid, false);
  assert.ok(result.problems.some((p) => new RegExp(`at most ${MAX_LENGTH}`, 'i').test(p)));
});

test('reports every failing rule at once', () => {
  const result = checkPassword('abc');
  assert.equal(result.valid, false);
  assert.ok(result.problems.length >= 3, `expected several problems, got ${result.problems.length}`);
});

test('exports the documented minimum length', () => {
  assert.equal(MIN_LENGTH, 8);
});
