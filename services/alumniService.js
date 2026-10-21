'use strict';

/**
 * services/alumniService.js
 * Shared alumni helpers used by several routers. Keeping this here avoids one
 * route file reaching into another for a helper.
 */

const { getPool } = require('../config/db');

/** WHERE clause that admits only approved, email-verified alumni profiles. */
const APPROVED_PREDICATE = 'a.approved_at IS NOT NULL AND u.email_verified_at IS NOT NULL';

/**
 * True when the user owns an alumni profile that an administrator has approved
 * AND whose email address has been verified. Used to gate job posting and
 * networking features.
 * @param {number} userId
 * @returns {Promise<boolean>}
 */
async function isApprovedAlumni(userId) {
  if (!userId) return false;
  const [rows] = await getPool().execute(
    `SELECT a.approved_at FROM alumni_profiles a
       JOIN users u ON u.id = a.user_id
      WHERE a.user_id = ? AND ${APPROVED_PREDICATE}`,
    [userId]
  );
  return Boolean(rows[0] && rows[0].approved_at);
}

/** Load an alumni profile row by user id, or null. */
async function getAlumniProfileByUser(userId) {
  const [rows] = await getPool().execute(
    `SELECT a.*, u.name, u.email FROM alumni_profiles a
       JOIN users u ON u.id = a.user_id WHERE a.user_id = ?`,
    [userId]
  );
  return rows[0] || null;
}

module.exports = { isApprovedAlumni, getAlumniProfileByUser, APPROVED_PREDICATE };
