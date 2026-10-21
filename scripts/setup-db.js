'use strict';

/**
 * database/setup-db.js  (run with: npm run db:setup)
 *
 * One-time, interactive database bootstrap for Windows / PowerShell.
 *
 * What it does:
 *   1. Reads your MySQL ROOT password from a hidden prompt (or MYSQL_ROOT_PASSWORD env var).
 *   2. Creates the application database (default: student_portal).
 *   3. Creates a LEAST-PRIVILEGE application user and grants it only the
 *      privileges it actually needs. The running app connects as this user,
 *      never as root.
 *   4. Loads database/schema.sql.
 *   5. Optionally seeds development data.
 *
 * It never drops or modifies an existing database unless you explicitly answer
 * "yes" to the reset question, and it will not touch any database whose name is
 * not the configured DB_NAME.
 *
 * Password input is hidden and never echoed or written to disk.
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const MYSQL_EXE = process.env.MYSQL_EXE
  || 'C:\\Program Files\\MySQL\\MySQL Server 8.0\\bin\\mysql.exe';

const DB_NAME = process.env.DB_NAME || 'student_portal';
const DB_HOST = process.env.DB_HOST || '127.0.0.1';
const DB_PORT = Number(process.env.DB_PORT || 3306);
const APP_USER = process.env.DB_USER || 'student_portal_app';
const APP_PASSWORD = process.env.DB_PASSWORD || 'change-me-to-a-strong-password';

const NAME_RE = /^[A-Za-z0-9_]+$/;

function fail(message) {
  console.error(`\n[setup] ERROR: ${message}`);
  process.exit(1);
}

/** Prompt for a line of input. When hidden, keystrokes are not echoed. */
function prompt(question, { hidden = false, defaultValue = '' } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    if (!hidden) {
      const suffix = defaultValue ? ` [${defaultValue}]` : '';
      rl.question(`${question}${suffix}: `, (answer) => {
        rl.close();
        resolve(answer.trim() || defaultValue);
      });
      return;
    }

    // Hidden input: temporarily silence output and restore on each keystroke.
    const originalWrite = rl._writeToOutput;
    let asked = false;
    rl._writeToOutput = (string) => {
      if (!asked) {
        originalWrite.call(rl, string); // print the prompt itself once
        asked = true;
      } else {
        // swallow every echoed character
      }
    };
    rl.stdoutMuted = true;

    rl.question(`${question}: `, (answer) => {
      rl._writeToOutput = originalWrite;
      rl.close();
      process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

/** Spawn the mysql CLI and return { code, stdout, stderr }. */
function runMysql(args, { sql = null, password = null, allowFailure = false } = {}) {
  const { spawnSync } = require('child_process');
  const fullArgs = ['-h', DB_HOST, '-P', String(DB_PORT), '-u', 'root', '--batch', ...args];
  // --password is passed via env var MYSQL_PWD so it never appears in the
  // process list / command line (where other users could read it).
  const env = { ...process.env };
  if (password !== null) env.MYSQL_PWD = password;

  const result = spawnSync(MYSQL_EXE, fullArgs, {
    input: sql === null ? undefined : sql,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env,
  });

  if (result.error) {
    if (result.error.code === 'ENOENT') {
      fail(
        `Could not find the mysql client at:\n  ${MYSQL_EXE}\n` +
        'Set the MYSQL_EXE environment variable to the full path of mysql.exe,\n' +
        'for example in PowerShell:\n  $env:MYSQL_EXE="C:\\Program Files\\MySQL\\MySQL Server 8.0\\bin\\mysql.exe"'
      );
    }
    fail(result.error.message);
  }

  const code = result.status;
  const stderr = (result.stderr || '').toString();
  const stdout = (result.stdout || '').toString();

  if (code !== 0 && !allowFailure) {
    fail(`mysql client exited with code ${code}.\n${stderr}`);
  }
  return { code, stdout, stderr };
}

/** Split an SQL script into statements, ignoring delimiters inside strings/comments. */
function splitSqlStatements(script) {
  const statements = [];
  let current = '';
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let inLineComment = false;
  let inBlockComment = false;

  while (i < script.length) {
    const ch = script[i];
    const next = script[i + 1];

    if (inLineComment) {
      current += ch;
      if (ch === '\n') inLineComment = false;
      i += 1;
      continue;
    }
    if (inBlockComment) {
      current += ch;
      if (ch === '*' && next === '/') {
        current += next;
        inBlockComment = false;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (!inSingle && !inDouble && !inBacktick) {
      if (ch === '-' && next === '-') {
        inLineComment = true; current += ch; i += 1; continue;
      }
      if (ch === '#') {
        inLineComment = true; current += ch; i += 1; continue;
      }
      if (ch === '/' && next === '*') {
        inBlockComment = true; current += ch; i += 1; continue;
      }
    }

    if (ch === "'" && !inDouble && !inBacktick) inSingle = !inSingle;
    else if (ch === '"' && !inSingle && !inBacktick) inDouble = !inDouble;
    else if (ch === '`' && !inSingle && !inDouble) inBacktick = !inBacktick;

    if (ch === ';' && !inSingle && !inDouble && !inBacktick) {
      const trimmed = current.trim();
      if (trimmed.replace(/;/g, '').trim().length > 0) statements.push(trimmed);
      current = '';
      i += 1;
      continue;
    }

    current += ch;
    i += 1;
  }

  const tail = current.trim();
  if (tail.replace(/;/g, '').trim().length > 0) statements.push(tail);
  return statements;
}

/** Escape a value for embedding in a single-quoted MySQL string literal. */
function sqlQuote(value) {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

async function main() {
  console.log('\n==========================================================');
  console.log(' Student Event Registration & Alumni Portal - DB Setup');
  console.log('==========================================================\n');

  if (!NAME_RE.test(DB_NAME)) fail(`DB_NAME "${DB_NAME}" is invalid. Use only letters, digits and underscore.`);
  if (!NAME_RE.test(APP_USER)) fail(`DB_USER "${APP_USER}" is invalid. Use only letters, digits and underscore.`);
  if (APP_PASSWORD === 'change-me-to-a-strong-password') {
    fail(
      'DB_PASSWORD in .env is still the placeholder value.\n' +
      'Edit .env and set a strong DB_PASSWORD first, then re-run npm run db:setup.'
    );
  }

  if (!fs.existsSync(MYSQL_EXE)) {
    fail(
      `mysql.exe not found at:\n  ${MYSQL_EXE}\n` +
      'Set $env:MYSQL_EXE to the correct path and re-run.'
    );
  }

  // 1. Obtain root credentials ------------------------------------------------
  let rootPassword = process.env.MYSQL_ROOT_PASSWORD || '';
  let usingEnv = Boolean(process.env.MYSQL_ROOT_PASSWORD);
  if (!usingEnv) {
    rootPassword = await prompt('MySQL ROOT password (input hidden)', { hidden: true });
  } else {
    console.log('[setup] Using MYSQL_ROOT_PASSWORD from the environment.');
  }

  // 2. Verify connectivity ----------------------------------------------------
  const probe = runMysql(['-e', 'SELECT VERSION();'], { password: rootPassword, allowFailure: true });
  if (probe.code !== 0) {
    if (/Access denied/i.test(probe.stderr)) fail('Access denied: the root password is incorrect.');
    fail(`Could not connect to MySQL at ${DB_HOST}:${DB_PORT}.\n${probe.stderr}`);
  }
  const version = probe.stdout.trim().split('\n').pop();
  console.log(`[setup] Connected to MySQL: ${version}`);

  // 3. Offer a reset only if the target database already exists ---------------
  const dbs = runMysql(['-N', '-B', '-e', 'SHOW DATABASES;'], { password: rootPassword }).stdout
    .split('\n').map((s) => s.trim()).filter(Boolean);

  let shouldCreate = true;
  if (dbs.includes(DB_NAME)) {
    const answer = await prompt(
      `Database "${DB_NAME}" already exists. Recreate it? This DELETES its data. (yes/no)`,
      { defaultValue: 'no' }
    );
    if (/^y(es)?$/i.test(answer)) {
      console.log(`[setup] Dropping database ${DB_NAME} ...`);
      runMysql(['-e', `DROP DATABASE IF EXISTS \`${DB_NAME}\`;`], { password: rootPassword });
    } else {
      console.log(`[setup] Keeping existing database "${DB_NAME}". Schema will be applied idempotently.`);
      shouldCreate = false;
    }
  }

  // 4. Create the database ----------------------------------------------------
  if (shouldCreate || !dbs.includes(DB_NAME)) {
    console.log(`[setup] Creating database ${DB_NAME} (utf8mb4) ...`);
    runMysql(['-e',
      `CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`
    ], { password: rootPassword });
  }

  // 5. Create the least-privilege application user ----------------------------
  // Host is 127.0.0.1 because the app connects over TCP to localhost.
  console.log(`[setup] Creating least-privilege application user ${APP_USER}@127.0.0.1 ...`);
  const userSql = [
    `CREATE USER IF NOT EXISTS '${APP_USER}'@'127.0.0.1' IDENTIFIED BY ${sqlQuote(APP_PASSWORD)};`,
    // Password changed on every run so .env and the server always agree.
    `ALTER USER '${APP_USER}'@'127.0.0.1' IDENTIFIED BY ${sqlQuote(APP_PASSWORD)};`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON \`${DB_NAME}\`.* TO '${APP_USER}'@'127.0.0.1';`,
    'FLUSH PRIVILEGES;'
  ].join('\n');
  runMysql(['-e', userSql], { password: rootPassword });
  console.log(`[setup] Granted SELECT, INSERT, UPDATE, DELETE on ${DB_NAME}.* only (no DDL, no DROP).`);

  // 6. Load the schema --------------------------------------------------------
  const schemaPath = path.join(__dirname, '..', 'database', 'schema.sql');
  if (!fs.existsSync(schemaPath)) fail(`schema.sql not found at ${schemaPath}`);
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');
  const statements = splitSqlStatements(schemaSql).filter(
    (s) => !/^SET\s+(FOREIGN_KEY_CHECKS|NAMES|time_zone)/i.test(s)
  );
  console.log(`[setup] Applying schema (${statements.length} statements) ...`);

  // Applied as the ROOT user because CREATE TABLE / CREATE VIEW require DDL
  // privileges that the application user deliberately does not have.
  runMysql(['-D', DB_NAME, '--force'], { sql: schemaSql, password: rootPassword });
  console.log('[setup] Schema applied.');

  // 7. Confirm the app user can actually connect and read ---------------------
  const { spawnSync } = require('child_process');
  const verify = spawnSync(MYSQL_EXE, [
    '-h', DB_HOST, '-P', String(DB_PORT), '-u', APP_USER, '-D', DB_NAME, '-N', '-B',
    '-e', 'SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE();'
  ], { encoding: 'utf8', env: { ...process.env, MYSQL_PWD: APP_PASSWORD } });

  if (verify.status !== 0) {
    fail(`The application user could not query the database.\n${verify.stderr}`);
  }
  console.log(`[setup] Verified ${APP_USER} can access ${verify.stdout.trim()} table(s).`);

  console.log('\n[setup] DONE.');
  console.log('----------------------------------------------------------');
  console.log('Next steps:');
  console.log('  1. Make sure .env DB_USER / DB_PASSWORD match what you entered.');
  console.log('  2. npm run db:seed      (optional sample data)');
  console.log('  3. npm run create-admin (create the first administrator)');
  console.log('  4. npm run dev          (start the server on http://localhost:5000)');
  console.log('----------------------------------------------------------\n');
}

main().catch((error) => {
  console.error(`\n[setup] Unexpected failure: ${error && error.message ? error.message : error}`);
  process.exit(1);
});
