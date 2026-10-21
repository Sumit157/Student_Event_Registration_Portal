'use strict';

/**
 * server.js
 * Process entry point. Validates configuration, verifies database connectivity,
 * then starts Express. Fails fast with a readable message rather than starting
 * in a half-working state.
 */

const { env, validateEnv } = require('./config/env');
const { createApp } = require('./app');
const { testConnection, closePool } = require('./config/db');

async function main() {
  // 1. Configuration must be sane before anything else happens.
  const problems = validateEnv();
  if (problems.length > 0) {
    console.error('\n[server] Refusing to start - configuration problems:');
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error('\nCopy .env.example to .env and fill in the required values.\n');
    process.exit(1);
  }

  // 2. Confirm the database is reachable. Report status without credentials.
  try {
    const status = await testConnection();
    console.log(`[server] Database OK   : MySQL ${status.version} @ ${status.host}:${status.port}/${status.database} (user: ${status.user})`);
  } catch (error) {
    console.error(`\n[server] Cannot reach MySQL at ${env.db.host}:${env.db.port}/${env.db.name}.`);
    console.error(`[server] Reason: ${error.code || error.message}`);
    console.error('[server] Run "npm run db:setup" to create the database, then check the DB_* values in .env.\n');
    process.exit(1);
  }

  // 3. Email mode is important enough to announce at boot.
  console.log(`[server] Email mode    : ${env.mail.devMode
    ? 'DEV (SMTP not configured - verification/reset links print to this console)'
    : `SMTP via ${env.mail.host}:${env.mail.port}`}`);

  // 4. Start listening.
  const app = createApp();
  const server = app.listen(env.port, () => {
    console.log('----------------------------------------------------------');
    console.log(`[server] Campus Portal running at http://localhost:${env.port}`);
    console.log(`[server] Health check  : http://localhost:${env.port}/api/health`);
    console.log(`[server] Environment   : ${env.nodeEnv}`);
    console.log('----------------------------------------------------------\n');
  });

  // Graceful shutdown so pooled connections are closed cleanly.
  const shutdown = async (signal) => {
    console.log(`\n[server] Received ${signal}, shutting down gracefully ...`);
    server.close(async () => {
      await closePool();
      console.log('[server] Closed. Goodbye.');
      process.exit(0);
    });
    // Do not hang forever on a stuck socket.
    setTimeout(() => process.exit(0), 8000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    console.error('[server] Unhandled promise rejection:', reason);
  });
  process.on('uncaughtException', (error) => {
    console.error('[server] Uncaught exception:', error);
    process.exit(1);
  });
}

main().catch((error) => {
  console.error('[server] Fatal startup error:', error);
  process.exit(1);
});
