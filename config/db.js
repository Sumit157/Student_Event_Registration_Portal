'use strict';

/**
 * config/db.js
 * A shared MySQL connection pool built with mysql2/promise.
 *
 * Design notes:
 *   * Every query helper in this project uses PARAMETERISED statements
 *     (? placeholders). No string concatenation of user input into SQL.
 *   * The pool logs its status without ever printing the password.
 *   * getConnection() exposes a single connection so callers can run several
 *     statements inside one transaction with consistent row locking.
 */

const mysql = require('mysql2/promise');
const { env } = require('./env');

let pool = null;

/** Redact anything that looks like a credential before it reaches a log. */
function describeConfig() {
  return {
    host: env.db.host,
    port: env.db.port,
    database: env.db.name,
    user: env.db.user,
    password: env.db.password ? '***redacted***' : '(empty)',
    connectionLimit: env.db.connectionLimit,
  };
}

function createPool() {
  if (pool) return pool;

  pool = mysql.createPool({
    host: env.db.host,
    port: env.db.port,
    database: env.db.name,
    user: env.db.user,
    password: env.db.password,
    waitForConnections: true,
    connectionLimit: env.db.connectionLimit,
    queueLimit: 0,
    // Dates come back as JS Date objects; the app serialises them explicitly.
    dateStrings: false,
    charset: 'utf8mb4',
    // Reject any statement that is not parameterised by accident? mysql2 has no
    // such flag, so instead we keep namedPlaceholders off and rely on the
    // code-review rule: every query uses "?" placeholders.
    multipleStatements: false,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
  });

  return pool;
}

function getPool() {
  return pool || createPool();
}

/**
 * Verify connectivity with a lightweight query.
 * Resolves with a short status object; never includes credentials.
 */
async function testConnection() {
  const [rows] = await getPool().query('SELECT VERSION() AS version, NOW() AS server_time');
  const row = rows && rows[0] ? rows[0] : {};
  return {
    ok: true,
    version: row.version || 'unknown',
    serverTime: row.server_time || null,
    ...describeConfig(),
  };
}

/**
 * Run a set of statements inside a single transaction on ONE connection.
 *
 * usage:
 *   await withTransaction(async (conn) => {
 *     await conn.query('SELECT ... FOR UPDATE');
 *     await conn.query('INSERT ...', [a, b]);
 *   });
 *
 * The callback MUST use the supplied `conn`, not the pool, or the isolation
 * guarantee is lost. Any throw (or returned rejected promise) rolls back.
 */
async function withTransaction(work) {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const result = await work(conn);
    await conn.commit();
    return result;
  } catch (error) {
    try { await conn.rollback(); } catch (_) { /* ignore rollback failure */ }
    throw error;
  } finally {
    conn.release();
  }
}

/** Close the pool. Used on shutdown and in tests. */
async function closePool() {
  if (!pool) return;
  const current = pool;
  pool = null;
  await current.end();
}

module.exports = {
  createPool,
  getPool,
  testConnection,
  withTransaction,
  closePool,
  describeConfig,
};
