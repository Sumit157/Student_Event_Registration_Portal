'use strict';

/**
 * tests/unit/csv.test.js
 * Task 6: CSV export must be RFC 4180 compliant AND safe against spreadsheet
 * formula injection, which can execute code on the reviewer's machine.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/testEnv');
const { buildCsv, escapeCsvField } = require('../../utils/csv');

test('quotes and doubles embedded quotes', () => {
  assert.equal(escapeCsvField('say "hi"'), '"say ""hi"""');
});

test('quotes fields containing commas', () => {
  assert.equal(escapeCsvField('a,b'), '"a,b"');
});

test('quotes fields containing newlines', () => {
  assert.equal(escapeCsvField('line1\nline2'), '"line1\nline2"');
});

test('renders null and undefined as an empty quoted field', () => {
  assert.equal(escapeCsvField(null), '""');
  assert.equal(escapeCsvField(undefined), '""');
});

test('neutralises formula injection for = + - @ prefixes', () => {
  // Without the leading apostrophe Excel would EXECUTE these.
  assert.equal(escapeCsvField('=1+1'), '"\'=1+1"');
  assert.equal(escapeCsvField('+cmd'), '"\'+cmd"');
  assert.equal(escapeCsvField('-2'), '"\'-2"');
  assert.equal(escapeCsvField('@SUM(A1)'), '"\'@SUM(A1)"');
});

test('does not alter ordinary text', () => {
  assert.equal(escapeCsvField('Priya Sharma'), '"Priya Sharma"');
});

test('buildCsv produces a header line and one line per row', () => {
  const csv = buildCsv(['Name', 'Email'], [['Aarav', 'a@b.com'], ['Diya', 'c@d.com']]);
  const lines = csv.split('\r\n').filter((l) => l.length > 0);
  assert.equal(lines.length, 3);
  assert.equal(lines[0], '"Name","Email"');
  assert.equal(lines[1], '"Aarav","a@b.com"');
  assert.equal(lines[2], '"Diya","c@d.com"');
});

test('buildCsv escapes hostile cell content end to end', () => {
  const csv = buildCsv(['Note'], [['=HYPERLINK("http://evil","click")']]);
  assert.ok(csv.includes('"\'=HYPERLINK'), 'formula must be defanged');
  assert.ok(csv.includes('""'), 'quotes inside the cell must be doubled');
});

test('buildCsv ends with a trailing newline (RFC 4180)', () => {
  const csv = buildCsv(['A'], [['1']]);
  assert.ok(csv.endsWith('\r\n'));
});

test('buildCsv handles an empty dataset', () => {
  const csv = buildCsv(['A', 'B'], []);
  const lines = csv.split('\r\n').filter(Boolean);
  assert.equal(lines.length, 1, 'only the header should be present');
});
