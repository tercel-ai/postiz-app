/**
 * verify-send-mode-locks.cjs — REAL-POSTGRES verification of send-mode locks.
 *
 * WHAT IT DOES
 *   Creates ONE uniquely named, throwaway database on the LOCAL PostgreSQL
 *   instance, runs `send-mode-locks.postgres.spec.ts` against it (single worker,
 *   verbose), and prints the result. These tests exercise row-lock / advisory-lock
 *   semantics that mocks cannot prove, so they need a real server.
 *
 * SAFETY CONTRACT — read this before changing anything.
 *   1. LOCAL ONLY.
 *      The script reads DATABASE_URL from postiz-app/.env and deliberately
 *      IGNORES the shell environment, so an exported staging/production URL can
 *      never be picked up by accident. It refuses to run unless the URL is
 *      postgres:// or postgresql:// on localhost / 127.0.0.1 / [::1], port 5432,
 *      with no fragment and no query parameter other than sslmode.
 *   2. NEVER TOUCHES THE CONFIGURED DATABASE.
 *      The URL in DATABASE_URL is read only to learn the local server and
 *      credentials. The script connects to the `postgres` maintenance database,
 *      asserts that, and only then talks to the new throwaway database.
 *   3. NO DESTRUCTIVE CLEANUP.
 *      The only write is `CREATE DATABASE aisee_mode_lock_test_<random>`, which
 *      fails if the name already exists. There is intentionally NO `DROP
 *      DATABASE` here: a bug in this script must not be able to destroy a
 *      database on its own. Cleanup is manual (see 5).
 *   4. EXPLICIT CONFIRMATION.
 *      `--confirm` is required, so a stray `node scripts/verify-send-mode-locks.cjs`
 *      in a shell loop / CI job stops before doing anything. `--dry-run` is the
 *      safe preview: it validates the target and prints what would happen without
 *      connecting to the server or creating anything.
 *   5. THE THROWAWAY DATABASE IS LEFT BEHIND ON PURPOSE.
 *      When the run ends (pass or fail) the script prints the exact `DROP`
 *      command; run it yourself once you no longer need the database.
 *
 * USAGE (local development only)
 *   1. Point postiz-app/.env at your LOCAL postgres, for example:
 *        DATABASE_URL="postgresql://postgres:postgres@localhost:5432/aisee_postiz_dev"
 *   2. Preview (no connection, no writes):
 *        node scripts/verify-send-mode-locks.cjs --dry-run
 *   3. Run:
 *        node scripts/verify-send-mode-locks.cjs --confirm
 *   4. Copy the printed `DROP DATABASE` command to remove the throwaway DB.
 *
 * EXIT CODES
 *   0 test run passed (or dry-run accepted) · 1 setup or test run failed · 2 refused to run.
 */
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const dotenv = require('dotenv');
const { Prisma, PrismaClient } = require('@prisma/client');

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const TEST_DATABASE_PREFIX = 'aisee_mode_lock_test_';
const TEST_SPEC = 'libraries/nestjs-libraries/src/extension/__tests__/send-mode-locks.postgres.spec.ts';

/** Stop before creating anything; exit code 2 means "refused", not "failed". */
function refuse(reason) {
  console.error(`REFUSED: ${reason}`);
  console.error('No database connection was opened and nothing was created or dropped.');
  process.exit(2);
}

/**
 * Reject every target that is not unambiguously the LOCAL server.
 *
 * This is a URL check, not a network check: it exists so a copied staging or
 * production DATABASE_URL cannot reach Prisma. Keep it strict — widening
 * LOCAL_HOSTS or the port is how a destructive accident becomes possible.
 */
function localServerFromEnv(root) {
  const envPath = path.join(root, '.env');
  if (!fs.existsSync(envPath)) refuse(`missing ${envPath}`);

  const env = dotenv.parse(fs.readFileSync(envPath));
  if (!env.DATABASE_URL) refuse('.env has no DATABASE_URL');

  let server;
  try {
    server = new URL(env.DATABASE_URL);
  } catch {
    refuse('.env DATABASE_URL is not a valid URL');
  }
  if (!['postgres:', 'postgresql:'].includes(server.protocol))
    refuse('DATABASE_URL must use postgres:// or postgresql://');
  if (!LOCAL_HOSTS.has(server.hostname))
    refuse(`DATABASE_URL host "${server.hostname}" is not local (${[...LOCAL_HOSTS].join(', ')})`);
  if (server.port !== '5432') refuse(`DATABASE_URL port "${server.port}" is not 5432`);
  if (server.hash) refuse('DATABASE_URL must not contain a fragment');
  if (server.username !== 'postgres')
    refuse(`DATABASE_URL user "${server.username}" is not the local "postgres" user`);

  const unexpected = [...server.searchParams.keys()].filter((key) => key !== 'sslmode');
  if (unexpected.length) refuse(`DATABASE_URL has unexpected parameters: ${unexpected.join(', ')}`);

  return server;
}

/** Tell the operator exactly how to remove the throwaway database by hand. */
function printManualCleanup(name) {
  console.warn('');
  console.warn('='.repeat(78));
  console.warn('MANUAL CLEANUP REQUIRED — this script never drops databases.');
  console.warn(`Throwaway database (local): ${name}`);
  console.warn('Remove it yourself when you are done (psql will prompt for the password):');
  console.warn(`  psql -h localhost -U postgres -d postgres -c 'DROP DATABASE "${name}";'`);
  console.warn('='.repeat(78));
  console.warn('');
}

async function main() {
  const root = path.resolve(__dirname, '..');

  const server = localServerFromEnv(root);
  // Read-only context for the operator; the configured database is never opened.
  const configuredDatabase = server.pathname.replace(/^\//, '') || '(none)';
  const name = `${TEST_DATABASE_PREFIX}${randomUUID().replace(/-/g, '')}`;
  if (!name.startsWith(TEST_DATABASE_PREFIX)) refuse('internal error: unexpected test database name');

  if (process.argv.includes('--dry-run')) {
    console.log('DRY RUN — no connection made, nothing created.');
    console.log(`Local target accepted: ${server.hostname}:${server.port}`);
    console.log(`Configured database (would NOT be opened): ${configuredDatabase}`);
    console.log(`Would create: ${name}`);
    console.log('Cleanup afterwards (manual):');
    console.log(`  psql -h localhost -U postgres -d postgres -c 'DROP DATABASE "${name}";'`);
    return;
  }

  if (!process.argv.includes('--confirm')) {
    refuse(
      'pass --confirm to acknowledge that a throwaway LOCAL database will be created ' +
        '(or --dry-run to preview without connecting)'
    );
  }

  // Connect to the maintenance database, NOT the configured application database.
  server.pathname = '/postgres';
  const admin = new PrismaClient({ datasources: { db: { url: server.href } } });
  // Once CREATE has been attempted the database may exist, even if the process
  // dies before the next line. Print cleanup in that case too.
  let mayExist = false;

  try {
    const actual = await admin.$queryRaw`SELECT current_database() AS database`;
    if (actual[0].database !== 'postgres')
      throw new Error('Refusing to continue: maintenance connection is not the "postgres" database');

    console.log(`Local server accepted: ${server.hostname}:${server.port}`);
    console.log(`Configured database (NOT opened): ${configuredDatabase}`);
    console.log(`Creating throwaway database: ${name}`);

    mayExist = true;
    await admin.$executeRaw`CREATE DATABASE ${Prisma.raw(`"${name}"`)}`;
    console.log(`Created. Running: ${TEST_SPEC}`);

    server.pathname = `/${name}`;
    const result = spawnSync(
      process.execPath,
      [
        path.join(root, 'node_modules/vitest/vitest.mjs'),
        'run',
        TEST_SPEC,
        '--minWorkers=1',
        '--maxWorkers=1',
        '--reporter=verbose',
      ],
      {
        cwd: root,
        env: { ...process.env, SEND_MODE_LOCK_TEST_URL: server.href },
        stdio: 'inherit',
        timeout: 60000,
      }
    );
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } finally {
    await admin.$disconnect();
    if (mayExist) printManualCleanup(name);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
