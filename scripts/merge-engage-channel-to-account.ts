/**
 * One-shot data migration: fold EngageMonitoredChannel into EngageTrackedAccount.
 *
 * Runs the hand-written SQL in
 *   libraries/nestjs-libraries/src/database/prisma/migrations/
 *     merge-monitored-channel-into-tracked-account.sql
 * and reports what it did. The SQL is the source of truth — this wrapper exists
 * so the operator gets ordered phases, readable counts, and a non-zero exit on
 * any failed guard, instead of scrolling psql output for a RAISE NOTICE.
 *
 * ╔════════════════════════════════════════════════════════════════════════╗
 * ║  ⚠  RUN THIS BEFORE `pnpm run prisma-db-push`.                         ║
 * ║                                                                        ║
 * ║  db push is `--accept-data-loss` and EngageMonitoredChannel has been   ║
 * ║  removed from schema.prisma, so pushing first DROPS the source table   ║
 * ║  and every monitored channel with it. This script aborts (exit 2) if   ║
 * ║  it detects that already happened.                                     ║
 * ╚════════════════════════════════════════════════════════════════════════╝
 *
 * Order:
 *   1. npx ts-node --project scripts/tsconfig.json scripts/merge-engage-channel-to-account.ts
 *   2. (same command) --drop-source        ← only after step 1 reports OK
 *   3. pnpm run prisma-db-push             ← or the full pnpm run pm2-run:prod
 *
 * Idempotent: safe to re-run between steps 1 and 2. After --drop-source the
 * precondition check turns a re-run into a clean "nothing to do" (exit 0).
 *
 * Usage:
 *   ... merge-engage-channel-to-account.ts               # audit + apply
 *   ... merge-engage-channel-to-account.ts --check-only  # audit only, writes nothing
 *   ... merge-engage-channel-to-account.ts --drop-source # apply, then DROP the old table
 */

import 'reflect-metadata';
import * as dotenv from 'dotenv';
dotenv.config();

process.env.NODE_ENV = process.env.NODE_ENV || 'production';
process.env.TZ = 'UTC';

import { readFileSync } from 'fs';
import { join } from 'path';
import { PrismaClient } from '@prisma/client';

const MIGRATION_SQL = join(
  __dirname,
  '../libraries/nestjs-libraries/src/database/prisma/migrations/merge-monitored-channel-into-tracked-account.sql'
);

// Exit codes are distinct so CI / a wrapper can branch on them.
const EXIT_OK = 0;
const EXIT_AUDIT_FAILED = 1;
const EXIT_SOURCE_GONE = 2;
const EXIT_APPLY_FAILED = 3;

function parseArgs(): { checkOnly: boolean; dropSource: boolean } {
  const args = process.argv.slice(2);
  let checkOnly = false;
  let dropSource = false;
  for (const a of args) {
    if (a === '--check-only') checkOnly = true;
    else if (a === '--drop-source') dropSource = true;
    else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: merge-engage-channel-to-account.ts [--check-only | --drop-source]\n' +
          '  (default)       audit, then apply STEP 1/2/2b/2c\n' +
          '  --check-only    audit only; writes nothing\n' +
          '  --drop-source   apply, then DROP "EngageMonitoredChannel"\n\n' +
          'Run this BEFORE `pnpm run prisma-db-push` — db push drops the source table.'
      );
      process.exit(EXIT_OK);
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(EXIT_APPLY_FAILED);
    }
  }
  if (checkOnly && dropSource) {
    console.error('--check-only and --drop-source are mutually exclusive.');
    process.exit(EXIT_APPLY_FAILED);
  }
  return { checkOnly, dropSource };
}

/**
 * Split the migration into executable statements. Postgres' extended protocol
 * (which Prisma uses) rejects multi-statement strings, so the file cannot be
 * sent as one blob. Dollar-quoted bodies (`$$ … $$`) contain semicolons, so a
 * naive split on ';' would cut a DO block in half — this tracks quoting state.
 */
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = '';
  let inDollar = false;
  let inLineComment = false;
  let inSingle = false;

  for (let i = 0; i < sql.length; i++) {
    const two = sql.slice(i, i + 2);

    if (inLineComment) {
      buf += sql[i];
      if (sql[i] === '\n') inLineComment = false;
      continue;
    }
    if (!inDollar && !inSingle && two === '--') {
      inLineComment = true;
      buf += two;
      i++;
      continue;
    }
    if (!inDollar && sql[i] === "'") {
      inSingle = !inSingle;
      buf += sql[i];
      continue;
    }
    if (!inSingle && two === '$$') {
      inDollar = !inDollar;
      buf += two;
      i++;
      continue;
    }
    if (!inDollar && !inSingle && sql[i] === ';') {
      const stmt = buf.trim();
      if (stmt) out.push(stmt);
      buf = '';
      continue;
    }
    buf += sql[i];
  }
  const tail = buf.trim();
  if (tail) out.push(tail);

  // Drop statements that are only comments (the file documents heavily, and the
  // STEP 3 DROP is deliberately commented out — this script owns that decision).
  return out.filter((s) =>
    s.split('\n').some((line) => line.trim() && !line.trim().startsWith('--'))
  );
}

/** Label a statement for progress output without dumping the whole body. */
function describe(stmt: string): string {
  const head = stmt.replace(/^\s*(--[^\n]*\n\s*)+/, '').slice(0, 90);
  return head.replace(/\s+/g, ' ').trim();
}

/** Strip `--` line comments so classification never keys on prose. */
function stripComments(stmt: string): string {
  return stmt
    .split('\n')
    .map((line) => {
      // Only whole-line and trailing comments; this file has no `--` inside a
      // string literal, and a false negative here fails CLOSED (treated as a
      // write) rather than open.
      const idx = line.indexOf('--');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
}

/**
 * Does this statement modify ROWS? --check-only must execute nothing that does.
 *
 * Classified from the comment-stripped body, never from the surrounding prose:
 * an earlier version matched `/STEP 0/` against the raw text, and the backfill
 * INSERT — whose leading comment mentions "STEP 0c" — was misread as an audit
 * statement and executed in check-only mode. Detected only because the target
 * column did not exist yet.
 *
 * Fails CLOSED: anything not provably read-only counts as a write.
 */
function isWriteStatement(stmt: string): boolean {
  const body = stripComments(stmt);
  return /\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER\s+TABLE|CREATE\s+(UNIQUE\s+)?INDEX|DROP\s+TABLE)\b/i.test(
    body
  );
}

/** Human-facing bucket for progress output. Cosmetic — never gates execution. */
function phaseOf(stmt: string): string {
  const body = stripComments(stmt);
  if (/CREATE OR REPLACE FUNCTION/i.test(body)) return 'function';
  if (/ALTER\s+TABLE|CREATE\s+(UNIQUE\s+)?INDEX/i.test(body)) return 'schema';
  if (/INSERT\s+INTO/i.test(body)) return 'backfill';
  if (/"EngageScanCursor"/.test(body)) return 'cursors';
  if (/UPDATE\s+"EngageTrackedAccount"|DELETE\s+FROM\s+"EngageTrackedAccount"/i.test(body))
    return 'canonicalise';
  return 'audit';
}

async function tableExists(prisma: PrismaClient, table: string): Promise<boolean> {
  const [row] = await prisma.$queryRawUnsafe<{ exists: boolean }[]>(
    `SELECT to_regclass($1) IS NOT NULL AS exists`,
    `"${table}"`
  );
  return row.exists;
}

async function count(prisma: PrismaClient, sql: string): Promise<number> {
  const [row] = await prisma.$queryRawUnsafe<{ n: bigint }[]>(sql);
  return Number(row.n);
}

async function main() {
  const { checkOnly, dropSource } = parseArgs();
  const prisma = new PrismaClient();
  let exitCode = EXIT_OK;

  try {
    console.log('=== merge engage channel → account ===');
    console.log(`mode      : ${checkOnly ? 'check-only' : dropSource ? 'apply + drop source' : 'apply'}`);
    console.log(`migration : ${MIGRATION_SQL}`);
    console.log('');

    // ── Precondition ────────────────────────────────────────────────────────
    const sourceExists = await tableExists(prisma, 'EngageMonitoredChannel');
    const targetHasChannels = (await tableExists(prisma, 'EngageTrackedAccount'))
      ? await count(
          prisma,
          `SELECT count(*) AS n FROM "EngageTrackedAccount" WHERE lower("platform") = 'reddit'`
        )
      : 0;

    if (!sourceExists) {
      if (targetHasChannels > 0) {
        console.log(
          `Nothing to do: "EngageMonitoredChannel" is gone and ` +
            `${targetHasChannels} channel-scope row(s) are already in EngageTrackedAccount.`
        );
        console.log('The merge has completed. Proceed with `pnpm run prisma-db-push`.');
        return; // exit 0
      }
      console.error(
        'ABORT: "EngageMonitoredChannel" does not exist and EngageTrackedAccount holds no\n' +
          'channel-scope rows. A `prisma db push` most likely ran BEFORE this migration and\n' +
          'destroyed the source rows (db push is --accept-data-loss and the model was\n' +
          'removed from schema.prisma).\n\n' +
          'Restore the database from a backup taken before that push, then re-run this script.'
      );
      exitCode = EXIT_SOURCE_GONE;
      return;
    }

    const sourceRows = await count(
      prisma,
      `SELECT count(*) AS n FROM "EngageMonitoredChannel"`
    );
    console.log(`source rows        : ${sourceRows}`);
    console.log(`already migrated   : ${targetHasChannels}`);
    console.log('');

    // ── Execute ─────────────────────────────────────────────────────────────
    const statements = splitStatements(readFileSync(MIGRATION_SQL, 'utf8'));
    let ran = 0;
    let skipped = 0;

    for (const stmt of statements) {
      const phase = phaseOf(stmt);

      // --check-only stops at the FIRST write and runs nothing after it.
      //
      // Not "skip the writes and keep going": the statements that follow are
      // either writes or POST-CONDITIONS of those writes, and a post-condition
      // is read-only yet meaningless without them — STEP 2's verify block would
      // dutifully report "9 rows did not land" after we skipped the backfill,
      // failing the audit for a condition the audit did not create.
      //
      // The migration is ordered audit → schema → backfill → verify …, so
      // "everything before the first write" is exactly the audit.
      if (checkOnly && isWriteStatement(stmt)) {
        skipped = statements.length - statements.indexOf(stmt);
        break;
      }

      try {
        await prisma.$executeRawUnsafe(stmt);
        ran++;
        console.log(`  ✓ [${phase}] ${describe(stmt)}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`\n  ✗ [${phase}] ${describe(stmt)}\n`);
        console.error(message.trim());
        console.error(
          phase === 'audit'
            ? '\nThe audit rejected this database. Resolve the reported condition by hand;\n' +
                'do NOT run the backfill or deploy until it passes.'
            : '\nThe migration stopped part-way. It is idempotent — fix the cause and re-run.'
        );
        exitCode = phase === 'audit' ? EXIT_AUDIT_FAILED : EXIT_APPLY_FAILED;
        return;
      }
    }

    console.log('');
    console.log(
      `statements executed: ${ran}` +
        (skipped ? ` (stopped before ${skipped} apply statements)` : '')
    );

    if (checkOnly) {
      console.log('\ncheck-only: audit passed, no row was written.');
      console.log('Re-run without --check-only to apply.');
      return;
    }

    // ── Verify ──────────────────────────────────────────────────────────────
    const migrated = await count(
      prisma,
      `SELECT count(*) AS n FROM "EngageTrackedAccount" WHERE lower("platform") = 'reddit'`
    );
    const missing = await count(
      prisma,
      `SELECT count(*) AS n FROM "EngageMonitoredChannel" c
       LEFT JOIN "EngageTrackedAccount" t ON t."id" = c."id"
       WHERE t."id" IS NULL`
    );
    console.log('');
    console.log(`channel rows now in EngageTrackedAccount : ${migrated}`);
    console.log(`source rows that did NOT land            : ${missing}`);

    if (missing > 0) {
      console.error(
        '\nABORT: some channels did not land. The SQL guard should have caught this —\n' +
          'list them with:\n' +
          '  SELECT c."id", c."configId", c."platform", c."channelId"\n' +
          '  FROM "EngageMonitoredChannel" c\n' +
          '  LEFT JOIN "EngageTrackedAccount" t ON t."id" = c."id"\n' +
          '  WHERE t."id" IS NULL;'
      );
      exitCode = EXIT_APPLY_FAILED;
      return;
    }

    // ── Optional drop ───────────────────────────────────────────────────────
    if (dropSource) {
      await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS "EngageMonitoredChannel"');
      console.log('\nDropped "EngageMonitoredChannel".');
      console.log('Next: `pnpm run prisma-db-push` (or the full `pnpm run pm2-run:prod`).');
    } else {
      console.log('\nMigration applied. Source table is still present.');
      console.log(
        'Next: re-run with --drop-source, THEN `pnpm run prisma-db-push`.\n' +
          'Dropping now (rather than letting db push do it) is what makes a stray re-run\n' +
          'of this script a no-op instead of resurrecting channels a user has since deleted.'
      );
    }
  } finally {
    await prisma.$disconnect();
    if (exitCode !== EXIT_OK) process.exit(exitCode);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(EXIT_APPLY_FAILED);
});
