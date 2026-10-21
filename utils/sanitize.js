'use strict';

/**
 * utils/sanitize.js
 * Defensive escaping of user-generated content before it is rendered in HTML.
 *
 * The client predominantly uses textContent (which cannot execute markup), but
 * server-side sanitisation is applied anyway so that stored content is safe
 * even if a future view renders it as HTML. This is defence in depth against
 * stored XSS.
 */

const sanitizeHtml = require('sanitize-html');

/**
 * Strip every HTML tag and decode nothing - the result is plain text.
 * Intended for storage of names, bios, comments and news bodies.
 * @param {*} input
 * @param {number} maxLength
 * @returns {string}
 */
function stripTags(input, maxLength = 65535) {
  if (input === null || input === undefined) return '';
  const text = sanitizeHtml(String(input), {
    allowedTags: [],
    allowedAttributes: {},
    disallowedTagsMode: 'discard',
  });
  // Collapse control characters that can break terminals / logs.
  // eslint-disable-next-line no-control-regex
  const cleaned = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim();
  return cleaned.slice(0, maxLength);
}

/**
 * Escape text for safe interpolation into an HTML context.
 * Used by the (rare) places that must build markup, e.g. CSV preview tables.
 * @param {*} input
 * @returns {string}
 */
function escapeHtml(input) {
  if (input === null || input === undefined) return '';
  return String(input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Validate that a URL is an absolute http(s) URL owned by an external party.
 * Rejects javascript:, data:, vbscript: and protocol-relative URLs.
 * @param {string} value
 * @returns {boolean}
 */
function isSafeExternalUrl(value) {
  if (!value || typeof value !== 'string') return false;
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch (_) {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  // A URL with no host (e.g. "https://") is not usable.
  if (!parsed.hostname) return false;
  return true;
}

module.exports = { stripTags, escapeHtml, isSafeExternalUrl };
