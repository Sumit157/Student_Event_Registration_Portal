'use strict';

/**
 * tests/unit/upload.test.js
 * Task 5 / Task 7: profile picture uploads must be rejected unless the file's
 * CONTENT is a genuine image. Checking the extension or the Content-Type header
 * alone is trivially bypassed, so the middleware sniffs magic bytes.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

require('../helpers/testEnv');
const { sniffImageType } = require('../../middleware/upload');

// Real leading bytes for each accepted format. Every buffer must be at least
// 12 bytes long, because sniffImageType() refuses anything shorter.
const JPEG = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01]);
const PNG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D]);
const GIF = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(12, 0x2C)]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'latin1'),
  Buffer.from([0x24, 0x00, 0x00, 0x00]),
  Buffer.from('WEBPVP8 ', 'latin1'),
]);

test('detects a genuine JPEG', () => {
  assert.deepEqual(sniffImageType(JPEG), { ext: 'jpg', mime: 'image/jpeg' });
});

test('detects a genuine PNG', () => {
  assert.deepEqual(sniffImageType(PNG), { ext: 'png', mime: 'image/png' });
});

test('detects a genuine GIF', () => {
  assert.deepEqual(sniffImageType(GIF), { ext: 'gif', mime: 'image/gif' });
});

test('detects a genuine WebP', () => {
  assert.deepEqual(sniffImageType(WEBP), { ext: 'webp', mime: 'image/webp' });
});

test('rejects a script disguised with an image extension', () => {
  const script = Buffer.from('<script>alert(document.cookie)</script>', 'utf8');
  assert.equal(sniffImageType(script), null);
});

test('rejects an HTML file renamed to .png', () => {
  const html = Buffer.from('<!DOCTYPE html><html><body>hi</body></html>', 'utf8');
  assert.equal(sniffImageType(html), null);
});

test('rejects an executable / arbitrary binary', () => {
  const exe = Buffer.from([0x4D, 0x5A, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00]);
  assert.equal(sniffImageType(exe), null);
});

test('rejects empty, null and too-short buffers instead of throwing', () => {
  assert.equal(sniffImageType(null), null);
  assert.equal(sniffImageType(undefined), null);
  assert.equal(sniffImageType(Buffer.alloc(0)), null);
  assert.equal(sniffImageType(Buffer.from([0xFF, 0xD8])), null);
});

test('rejects a PPM/POISON header that only mimics a prefix', () => {
  // Starts like a JPEG marker but is not; our check requires byte 2 === 0xFF too.
  const fake = Buffer.from([0xFF, 0xD8, 0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99]);
  assert.equal(sniffImageType(fake), null);
});
