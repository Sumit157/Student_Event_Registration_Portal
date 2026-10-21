'use strict';

/**
 * utils/csv.js
 * RFC 4180 compliant CSV generation.
 *
 * Correct escaping is a security requirement as well as a correctness one: a
 * cell beginning with =, +, - or @ can be interpreted as a FORMULA by Excel /
 * LibreOffice and can execute code on the reviewer's machine. Every such cell
 * is prefixed with a single quote and every field is quoted.
 */

/**
 * Escape a single CSV field per RFC 4180, plus spreadsheet-formula defanging.
 * @param {*} value
 * @returns {string}
 */
function escapeCsvField(value) {
  if (value === null || value === undefined) return '""';

  let str = value instanceof Date
    ? value.toISOString().replace('T', ' ').replace('Z', '')
    : String(value);

  // Neutralise formula injection: prefix with an apostrophe when the cell
  // would otherwise start with a formula trigger character.
  if (/^[=+\-@\t\r]/.test(str)) {
    str = `'${str}`;
  }

  // Double any embedded quotes, then wrap the whole field in quotes.
  return `"${str.replace(/"/g, '""')}"`;
}

/**
 * Build a complete CSV document.
 * @param {string[]} headers  column titles
 * @param {Array<Array<*>>} rows  rows of cell values (same order as headers)
 * @returns {string}
 */
function buildCsv(headers, rows) {
  const lines = [];
  lines.push(headers.map(escapeCsvField).join(','));
  for (const row of rows) {
    lines.push(row.map(escapeCsvField).join(','));
  }
  // CRLF line endings per RFC 4180, and a trailing newline.
  return `${lines.join('\r\n')}\r\n`;
}

module.exports = { buildCsv, escapeCsvField };
