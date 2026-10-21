'use strict';

/**
 * utils/passwordPolicy.js
 * The single definition of "acceptable password", shared by the backend.
 *
 * The frontend mirrors these rules for instant feedback, but the backend is
 * always the authority - client side validation is a convenience, never a
 * security control.
 *
 * Policy (per assignment Task 2):
 *   * at least 8 characters
 *   * at least one uppercase letter
 *   * at least one digit
 * Additionally enforced here to reduce weak-but-legal passwords:
 *   * at least one lowercase letter or symbol (so it is not ALLCAPS1 style)
 *   * maximum 128 characters (guards the bcrypt input limit and DoS)
 */

const MIN_LENGTH = 8;
const MAX_LENGTH = 128;

/**
 * @param {string} password
 * @returns {{valid:boolean, problems:string[], checks:{length:boolean, uppercase:boolean, lowercase:boolean, digit:boolean}}}
 */
function checkPassword(password) {
  const value = typeof password === 'string' ? password : '';
  const checks = {
    length: value.length >= MIN_LENGTH && value.length <= MAX_LENGTH,
    uppercase: /[A-Z]/.test(value),
    lowercase: /[a-z]/.test(value) || /[^A-Za-z0-9]/.test(value),
    digit: /[0-9]/.test(value),
  };

  const problems = [];
  if (!checks.length) {
    problems.push(value.length > MAX_LENGTH
      ? `Password must be at most ${MAX_LENGTH} characters.`
      : `Password must be at least ${MIN_LENGTH} characters long.`);
  }
  if (!checks.uppercase) problems.push('Password must contain at least one uppercase letter.');
  if (!checks.lowercase) problems.push('Password must contain at least one lowercase letter or symbol.');
  if (!checks.digit) problems.push('Password must contain at least one number.');

  return { valid: problems.length === 0, problems, checks };
}

module.exports = { checkPassword, MIN_LENGTH, MAX_LENGTH };
