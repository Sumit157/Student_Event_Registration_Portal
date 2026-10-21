'use strict';

/**
 * tests/unit/sanitize.test.js
 * Task 7: user-generated content must be safe to store and render.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/testEnv');
const { stripTags, escapeHtml, isSafeExternalUrl } = require('../../utils/sanitize');

test('stripTags removes every HTML tag', () => {
  assert.equal(stripTags('<b>bold</b> and <i>italic</i>'), 'bold and italic');
  // sanitize-html discards <script>/<style> tags TOGETHER WITH their contents,
  // so the executable payload disappears rather than leaking as visible text.
  assert.equal(stripTags('<script>alert(1)</script>hi'), 'hi');
  assert.equal(stripTags('<b>x</b><i>y</i>'), 'xy');
});

test('stripTags removes event handler attributes along with their tags', () => {
  assert.equal(stripTags('<img src=x onerror="alert(1)">safe'), 'safe');
});

test('stripTags removes control characters that could break logs', () => {
  assert.equal(stripTags('ok\u0000\u0007done'), 'okdone');
});

test('stripTags trims and handles null/undefined', () => {
  assert.equal(stripTags('   spaced   '), 'spaced');
  assert.equal(stripTags(null), '');
  assert.equal(stripTags(undefined), '');
});

test('stripTags enforces a maximum length', () => {
  assert.equal(stripTags('x'.repeat(50), 10).length, 10);
});

test('escapeHtml neutralises the five dangerous characters', () => {
  assert.equal(escapeHtml('<a href="x">&\'</a>'),
    '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
});

test('escapeHtml handles null and undefined', () => {
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
});

test('isSafeExternalUrl accepts normal http and https links', () => {
  assert.equal(isSafeExternalUrl('https://careers.example.com/jobs/1'), true);
  assert.equal(isSafeExternalUrl('http://example.org/path?q=1'), true);
});

test('isSafeExternalUrl rejects javascript:, data: and other active schemes', () => {
  assert.equal(isSafeExternalUrl('javascript:alert(1)'), false);
  assert.equal(isSafeExternalUrl('JavaScript:alert(1)'), false);
  assert.equal(isSafeExternalUrl('data:text/html,<script>alert(1)</script>'), false);
  assert.equal(isSafeExternalUrl('vbscript:msgbox(1)'), false);
  assert.equal(isSafeExternalUrl('file:///etc/passwd'), false);
});

test('isSafeExternalUrl rejects protocol-relative and malformed input', () => {
  assert.equal(isSafeExternalUrl('//evil.com/x'), false);
  assert.equal(isSafeExternalUrl('not a url'), false);
  assert.equal(isSafeExternalUrl(''), false);
  assert.equal(isSafeExternalUrl(null), false);
  assert.equal(isSafeExternalUrl(undefined), false);
});

test('isSafeExternalUrl rejects a scheme with no host', () => {
  assert.equal(isSafeExternalUrl('https://'), false);
});
