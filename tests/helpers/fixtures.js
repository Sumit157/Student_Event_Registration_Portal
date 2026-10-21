'use strict';

/**
 * tests/helpers/fixtures.js
 * Builders for integration-test data. Every row this module creates is tagged
 * with the per-run token from testDb.js, so cleanup() can remove exactly what
 * was created and nothing else.
 */

require('./testEnv');

const bcrypt = require('bcryptjs');
const { getPool } = require('../../config/db');
const { makeEmail, makeTitle, RUN } = require('./testDb');
const { createEmailVerificationToken } = require('../../services/tokenService');

const TEST_PASSWORD = 'Integration#1';
const ROUNDS = 10;
let passwordHash = null;

async function hashOnce() {
  if (!passwordHash) passwordHash = await bcrypt.hash(TEST_PASSWORD, ROUNDS);
  return passwordHash;
}

/**
 * Insert a user directly (bypassing HTTP) so a test can focus on the feature
 * under test rather than on the registration flow.
 *
 * @param {{name?:string, role?:string, verified?:boolean, active?:boolean, index?:number}} options
 */
async function createUser(options = {}) {
  const {
    name = `IT User ${Math.floor(Math.random() * 100000)}`,
    role = 'student',
    verified = true,
    active = true,
    index = Math.floor(Math.random() * 1000000),
  } = options;

  const pool = getPool();
  const email = makeEmail(`${role}${index}`);
  const hash = await hashOnce();

  const [result] = await pool.execute(
    `INSERT INTO users (name, email, password_hash, role, college_id, email_verified_at, is_active)
     VALUES (?, ?, ?, ?, ?, ${verified ? 'CURRENT_TIMESTAMP' : 'NULL'}, ${active ? 1 : 0})`,
    [name, email, hash, role, `IT-${index}`]
  );

  const id = result.insertId;

  if (role === 'alumni') {
    await pool.execute(
      `INSERT INTO alumni_profiles (user_id, graduation_year, degree, company, designation)
       VALUES (?, 2020, 'B.Tech Computer Science', 'TestCo', 'Engineer')`,
      [id]
    );
  }

  return { id, email, name, role, password: TEST_PASSWORD };
}

/** Mark a user's email as verified (or not). */
async function setEmailVerified(userId, verified = true) {
  const pool = getPool();
  await pool.execute(
    `UPDATE users SET email_verified_at = ${verified ? 'CURRENT_TIMESTAMP' : 'NULL'} WHERE id = ?`,
    [userId]
  );
}

/** Approve (or clear approval on) an alumni profile. */
async function setAlumniApproved(userId, approved = true) {
  const pool = getPool();
  await pool.execute(
    `UPDATE alumni_profiles SET approved_at = ${approved ? 'CURRENT_TIMESTAMP' : 'NULL'} WHERE user_id = ?`,
    [userId]
  );
}

/**
 * Sign in and return an Authorization header value.
 * Creates the session through the real login endpoint so the JWT is genuine.
 */
async function loginAs(app, user) {
  const request = require('supertest');
  const response = await request(app)
    .post('/api/auth/login')
    .send({ email: user.email, password: user.password });

  if (response.status !== 200) {
    throw new Error(`login failed for ${user.email}: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return {
    accessToken: response.body.data.accessToken,
    headers: { Authorization: `Bearer ${response.body.data.accessToken}` },
    user: response.body.data.user,
  };
}

/** Create an event directly, returning its id. Capacity defaults low on purpose. */
async function createEvent(options = {}) {
  const {
    capacity = 2,
    daysAhead = 5,
    title = makeTitle(`Event ${Math.floor(Math.random() * 100000)}`),
    category = 'workshop',
    active = true,
  } = options;

  const pool = getPool();
  const when = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 19).replace('T', ' ');

  const [result] = await pool.execute(
    `INSERT INTO events (title, description, category, venue, event_date, capacity, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [title, 'Integration test event', category, 'Test Hall', when, capacity, active ? 1 : 0]
  );
  return { id: result.insertId, title, capacity };
}

/** Read a registration row straight from the database. */
async function getRegistration(eventId, userId) {
  const [rows] = await getPool().execute(
    `SELECT id, status, waitlist_position FROM event_registrations WHERE event_id = ? AND user_id = ?`,
    [eventId, userId]
  );
  return rows[0] || null;
}

/** Ordered list of who is currently waitlisted for an event. */
async function getWaitlist(eventId) {
  const [rows] = await getPool().execute(
    `SELECT user_id, waitlist_position FROM event_registrations
      WHERE event_id = ? AND status = 'waitlisted'
      ORDER BY waitlist_position ASC, registered_at ASC, id ASC`,
    [eventId]
  );
  return rows;
}

/** Issue a real (unconsumed) email verification token for a user. */
async function issueVerificationToken(userId) {
  const pool = getPool();
  const { token } = await createEmailVerificationToken(pool, userId);
  return token;
}

module.exports = {
  RUN,
  TEST_PASSWORD,
  makeEmail,
  makeTitle,
  createUser,
  setEmailVerified,
  setAlumniApproved,
  loginAs,
  createEvent,
  getRegistration,
  getWaitlist,
  issueVerificationToken,
};
