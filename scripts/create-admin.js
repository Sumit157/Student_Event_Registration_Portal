'use strict';

/**
 * scripts/create-admin.js  (run with: npm run create-admin)
 *
 * The ONLY supported way to create an administrator account.
 *
 * Rationale (assignment Task 3): the public registration endpoint accepts only
 * `student` and `alumni`, so there is no HTTP path that can ever mint an admin.
 * The first administrator is created out-of-band, exactly like a MySQL root
 * account: deliberately, interactively, and auditable.
 *
 * Password input is hidden and never echoed. The password is not written to
 * disk, to the log, or to the command line (where other users could read it).
 *
 * NON-INTERACTIVE MODE (automation / CI / test harnesses):
 *   Provide CA_EMAIL and CA_PASSWORD as environment variables and the script
 *   skips every prompt. Optional: CA_NAME, CA_COLLEGE_ID, and CA_PROMOTE=yes
 *   to auto-confirm promoting an existing non-admin account.
 *
 *     CA_EMAIL=admin@college.edu CA_PASSWORD='Str0ngPass!' npm run create-admin
 *
 * The password is still validated against the policy and hashed with bcrypt
 * (cost 10) before storage. This mode is intended for development and CI; the
 * interactive hidden prompt remains the recommended way on a live server.
 *
 * Safety guards:
 *   * Refuses to run when NODE_ENV=production unless --i-understand is passed.
 *   * Never overwrites an existing administrator's password silently.
 */

require('dotenv').config();

const readline = require('readline');
const bcrypt = require('bcryptjs');

const { env } = require('../config/env');
const { getPool, closePool, testConnection } = require('../config/db');
const { checkPassword } = require('../utils/passwordPolicy');

const BCRYPT_ROUNDS = 10;

function ask(question, { hidden = false, defaultValue = '' } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (!hidden) {
      const suffix = defaultValue ? ` [${defaultValue}]` : '';
      rl.question(`${question}${suffix}: `, (answer) => { rl.close(); resolve(answer.trim() || defaultValue); });
      return;
    }
    const originalWrite = rl._writeToOutput;
    let printed = false;
    rl._writeToOutput = (string) => {
      if (!printed) { originalWrite.call(rl, string); printed = true; }
    };
    rl.question(`${question}: `, (answer) => {
      rl._writeToOutput = originalWrite;
      rl.close();
      process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

function fail(message) {
  console.error(`\n[create-admin] ERROR: ${message}\n`);
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);

  console.log('\n==========================================================');
  console.log(' Create the first administrator account');
  console.log('==========================================================\n');

  // --- Guard: production -----------------------------------------------------
  if (env.isProduction && !args.includes('--i-understand')) {
    fail(
      'NODE_ENV is "production". Creating an admin from a script in production is\n' +
      'risky, so it requires an explicit acknowledgement:\n\n' +
      '    npm run create-admin -- --i-understand\n\n' +
      'Prefer creating the admin from an already-trusted admin session instead.'
    );
  }

  // --- Database -------------------------------------------------------------
  try {
    const status = await testConnection();
    console.log(`[create-admin] Connected to ${status.database} at ${status.host}:${status.port}\n`);
  } catch (error) {
    fail(`Cannot reach the database: ${error.code || error.message}\nRun "npm run db:setup" first.`);
  }

  // --- Collect details ------------------------------------------------------
  // Non-interactive mode: CA_EMAIL / CA_PASSWORD supplied via the environment
  // (see the header comment). Every value still passes the same validation.
  const email = (process.env.CA_EMAIL || (await ask('Administrator email address'))).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('That does not look like a valid email address.');

  const pool = getPool();
  const [existing] = await pool.execute(`SELECT id, role, name FROM users WHERE email = ? LIMIT 1`, [email]);

  if (existing.length > 0) {
    const user = existing[0];
    if (user.role === 'admin') {
      await closePool();
      console.log(`[create-admin] "${user.name}" is already an administrator. Nothing to do.\n`);
      process.exit(0);
    }
    const promote = process.env.CA_PROMOTE || await ask(
      `"${user.name}" already exists with the role "${user.role}". Promote this account to admin? (yes/no)`,
      { defaultValue: 'no' }
    );
    if (!/^y(es)?$/i.test(promote)) {
      await closePool();
      console.log('[create-admin] Cancelled. No changes were made.\n');
      process.exit(0);
    }

    // Promote without touching their password, then revoke live sessions so
    // the new permissions take effect on their next sign-in.
    await pool.execute(`UPDATE users SET role = 'admin' WHERE id = ?`, [user.id]);
    await pool.execute(
      `UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL`,
      [user.id]
    );

    await closePool();
    console.log(`\n[create-admin] DONE. "${user.name}" is now an administrator.\n`);
    process.exit(0);
  }

  const name = (process.env.CA_NAME || (await ask('Administrator display name', { defaultValue: 'Portal Administrator' }))) || 'Portal Administrator';
  const collegeId = (process.env.CA_COLLEGE_ID || (await ask('Employee / staff ID (optional)', { defaultValue: 'ADMIN-001' }))) || null;

  // --- Password (hidden, confirmed, policy checked) -------------------------
  // In non-interactive mode the password arrives via CA_PASSWORD, so there is
  // nothing to confirm against; it is still policy-checked below.
  const fromEnv = Boolean(process.env.CA_PASSWORD);
  const password = fromEnv ? process.env.CA_PASSWORD : await ask('Password (hidden)', { hidden: true });
  const confirm = fromEnv ? password : await ask('Confirm password (hidden)', { hidden: true });

  if (password !== confirm) fail('The two passwords do not match.');
  const policy = checkPassword(password);
  if (!policy.valid) fail(`Password rejected:\n  - ${policy.problems.join('\n  - ')}`);

  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  try {
    await pool.execute(
      `INSERT INTO users (name, email, password_hash, role, college_id, email_verified_at, is_active)
       VALUES (?, ?, ?, 'admin', ?, CURRENT_TIMESTAMP, 1)`,
      [name, email, hash, collegeId]
    );
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') fail('An account with that email already exists.');
    if (error.code === 'ER_BAD_FIELD_ERROR') fail(`Database schema mismatch: ${error.message}\nRun "npm run db:setup".`);
    fail(error.message);
  } finally {
    await closePool();
  }

  console.log('\n[create-admin] DONE.');
  console.log('----------------------------------------------------------');
  console.log(`  Email:    ${email}`);
  console.log('  Role:     admin');
  console.log('  Password: stored only as a bcrypt hash (cost 10)');
  console.log('\n  Sign in at http://localhost:5000/login.html');
  console.log('----------------------------------------------------------\n');
}

main().catch(async (error) => {
  console.error(`\n[create-admin] Unexpected failure: ${error && error.message ? error.message : error}`);
  try { await closePool(); } catch (_) { /* ignore */ }
  process.exit(1);
});
