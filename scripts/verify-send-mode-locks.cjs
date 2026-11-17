// Run only with explicit authorization to create/drop a disposable local database.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const dotenv = require('dotenv');
const { Prisma, PrismaClient } = require('@prisma/client');

async function main() {
  const root = path.resolve(__dirname, '..');
  const env = dotenv.parse(fs.readFileSync(path.join(root, '.env')));
  const server = new URL(env.DATABASE_URL);
  if (!['postgres:', 'postgresql:'].includes(server.protocol) ||
      !['localhost', '127.0.0.1', '[::1]'].includes(server.hostname) || server.port !== '5432' ||
      server.hash || [...server.searchParams.keys()].some(key => key !== 'sslmode'))
    throw new Error('Refusing a nonlocal or unexpected PostgreSQL target');
  const name = `aisee_mode_lock_test_${randomUUID().replace(/-/g, '')}`;
  server.pathname = '/postgres';
  const admin = new PrismaClient({ datasources: { db: { url: server.href } } });
  let created = false;
  try {
    const actual = await admin.$queryRaw`SELECT current_database() AS database`;
    if (actual[0].database !== 'postgres') throw new Error('Unexpected maintenance database');
    await admin.$executeRaw`CREATE DATABASE ${Prisma.raw(`"${name}"`)}`;
    created = true;
    console.log(`Created disposable local database: ${name}`);
    server.pathname = `/${name}`;
    const result = spawnSync(process.execPath, [
      path.join(root, 'node_modules/vitest/vitest.mjs'), 'run',
      'libraries/nestjs-libraries/src/extension/__tests__/send-mode-locks.postgres.spec.ts',
      '--minWorkers=1', '--maxWorkers=1', '--reporter=verbose',
    ], { cwd: root, env: { ...process.env, SEND_MODE_LOCK_TEST_URL: server.href }, stdio: 'inherit', timeout: 60000 });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } finally {
    try {
      if (created) {
        await admin.$executeRaw`DROP DATABASE ${Prisma.raw(`"${name}"`)}`;
        console.log(`Removed disposable local database: ${name}`);
      }
    } finally { await admin.$disconnect(); }
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
