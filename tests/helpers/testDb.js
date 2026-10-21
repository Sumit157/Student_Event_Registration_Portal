'use strict';

/**
 * tests/helpers/testDb.js
 * Test database connectivity and ISOLATED fixture cleanup.
 *
 * SAFETY RULES OBSERVED HERE:
 *   * This helper never runs DROP DATABASE, TRUNCATE or any other statement
 *     that could touch data it did not create.
 *   * Every fixture row this helper creates carries a unique, machine-readable
 *     marker (a per-run token embedded in email addresses, event titles and
 *     news titles).
 *   * cleanup() deletes ONLY rows whose marker matches the current run, and it
 *     does so in foreign-key safe order. Pre-existing data is left untouched.
 *   * If TEST_DB_NAME is set, that separate database is used instead, which is
 *     the preferred arrangement for repeatable runs.
 */

require('./testEnv');

const { getPool, testConnection, closePool } = require('../../config/db');

/** Unique marker for this test process. */
const RUN = `it${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
const EMAIL_DOMAIN = 'portal-test.local';

function makeEmail(index) {
  return `${RUN}-${index}@${EMAIL_DOMAIN}`;
}
function makeTitle(label) {
  return `[${RUN}] ${label}`;
}

/** True when a value was produced by this run. */
function isRunScoped(value) {
  return typeof value === 'string' && value.includes(RUN);
}

/** Probe the database without throwing. */
async function available() {
  try {
    await testConnection();
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Remove every row this run created, in FK-safe order.
 * Safe to call when nothing was created.
 */
async function cleanup() {
  const pool = getPool();
  const emailLike = `%@${EMAIL_DOMAIN}`.replace('%', `${RUN}-%`);
  const titleLike = `[${RUN}]%`;

  const statements = [
    // Comments on test news (children first).
    [`DELETE c FROM comments c JOIN news n ON n.id = c.news_id WHERE n.title LIKE ?`, [titleLike]],
    [`DELETE FROM news WHERE title LIKE ?`, [titleLike]],
    // Event registrations cascade with their events, but clear them explicitly
    // first so the intent is obvious when reading the log.
    [`DELETE r FROM event_registrations r JOIN events e ON e.id = r.event_id WHERE e.title LIKE ?`, [titleLike]],
    [`DELETE FROM events WHERE title LIKE ?`, [titleLike]],
    [`DELETE FROM job_posts WHERE title LIKE ?`, [titleLike]],
    // Connections and profiles hang off users and cascade, but be explicit.
    [`DELETE c FROM connections c JOIN users u ON u.id = c.requester_id WHERE u.email LIKE ?`, [emailLike]],
    [`DELETE j FROM job_posts j JOIN users u ON u.id = j.poster_id WHERE u.email LIKE ?`, [emailLike]],
    [`DELETE FROM users WHERE email LIKE ?`, [emailLike]],
  ];

  const results = [];
  for (const [sql, params] of statements) {
    try {
      const [result] = await pool.execute(sql, params);
      results.push(result.affectedRows);
    } catch (error) {
      // A missing table during partial setup is not a test failure by itself.
      results.push(0);
    }
  }
  return results;
}

/**
 * Build the standard Supertest agent factory once the DB is confirmed usable.
 */
async function requireDb() {
  const ok = await available();
  return ok;
}

module.exports = {
  RUN, EMAIL_DOMAIN, makeEmail, makeTitle, isRunScoped,
  available, cleanup, requireDb, skipWithoutDb,
};

/**
 * Convenience guard for an integration test body.
 * Returns true (and marks the test skipped) when MySQL is not reachable, so
 * the caller can return early instead of failing on a missing dependency.
 *
 *   test('registers a user', async (t) => {
 *     if (skipWithoutDb(t, dbOk)) return;
 *     ...
 *   });
 */
function skipWithoutDb(t, dbOk) {
  if (dbOk) return false;
  t.skip('MySQL is not available - integration test skipped. See TESTING.md.');
  return true;
}
