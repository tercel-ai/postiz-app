/**
 * Idempotent engage upgrade: settings init + schema verification for the
 * demand-driven-fetch / paced-scan release. Safe to run repeatedly — it only
 * fills what is missing and never overwrites admin-tuned values.
 *
 * What it does (no side effects on re-run):
 *   1. Verify the new nullable columns exist (read-only). If any is missing it
 *      tells you to run `pnpm run prisma-db-push` and exits non-zero — it does
 *      NOT alter schema itself (that is db push's job).
 *   2. Seed `engage_scan_pacing` IF MISSING (the new Settings key). Existing
 *      value is left untouched so admin tuning survives.
 *   3. Report `engage_entitlements` — its new fields (metricsWindowDaysMax /
 *      metricsFetchIntervalHours) merge from defaults at READ time, so no row
 *      migration is needed; reported for visibility only.
 *
 * Data backfill for existing orgs is a SEPARATE (also idempotent) step:
 *   scripts/backfill-engage-opportunity-states.ts
 *
 * Usage:
 *   npx ts-node --project scripts/tsconfig.json scripts/upgrade-engage.ts             # check + seed-if-missing
 *   npx ts-node --project scripts/tsconfig.json scripts/upgrade-engage.ts --check-only # read-only (no writes)
 */

import 'reflect-metadata';
import * as dotenv from 'dotenv';
dotenv.config();

process.env.NODE_ENV = process.env.NODE_ENV || 'production';
process.env.TZ = 'UTC';

import { PrismaClient } from '@prisma/client';
import {
  DEFAULT_SCAN_PACING,
  ENGAGE_SCAN_PACING_KEY,
} from '@gitroom/nestjs-libraries/engage/engage-scan-config.service';
import { ENGAGE_ENTITLEMENTS_KEY } from '@gitroom/nestjs-libraries/engage/engage-entitlement.service';

// Expected new columns (model table → column). None are @map'd, so the column
// name equals the Prisma field name and the table equals the model name.
const REQUIRED_COLUMNS: Array<{ table: string; column: string }> = [
  { table: 'Organization', column: 'data' },
  { table: 'Post', column: 'lastMetricsFetchAt' },
  { table: 'EngageScanCursor', column: 'leaseToken' },
];

function parseArgs(): { checkOnly: boolean } {
  const args = process.argv.slice(2);
  let checkOnly = false;
  for (const a of args) {
    if (a === '--check-only') checkOnly = true;
    else if (a === '--help') {
      console.log(
        'Usage: upgrade-engage.ts [--check-only]\n' +
          '  (default) verify schema + seed engage_scan_pacing if missing\n' +
          '  --check-only  read-only: report schema + settings, write nothing'
      );
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(1);
    }
  }
  return { checkOnly };
}

/** Read-only check that every required new column exists. */
async function verifySchema(prisma: PrismaClient): Promise<boolean> {
  const tables = [...new Set(REQUIRED_COLUMNS.map((c) => c.table))];
  const columns = [...new Set(REQUIRED_COLUMNS.map((c) => c.column))];
  const rows = await prisma.$queryRaw<Array<{ table_name: string; column_name: string }>>`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_name = ANY(${tables}) AND column_name = ANY(${columns})
  `;
  const present = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));

  let allOk = true;
  for (const { table, column } of REQUIRED_COLUMNS) {
    const ok = present.has(`${table}.${column}`);
    console.log(`  ${ok ? '✓' : '✗'} ${table}.${column}`);
    if (!ok) allOk = false;
  }
  return allOk;
}

/** Seed engage_scan_pacing only if absent (idempotent). Returns 'created' | 'exists'. */
async function seedPacing(
  prisma: PrismaClient,
  checkOnly: boolean
): Promise<'created' | 'exists' | 'would-create'> {
  const existing = await prisma.settings.findUnique({
    where: { key: ENGAGE_SCAN_PACING_KEY },
  });
  if (existing) return 'exists';
  if (checkOnly) return 'would-create';
  await prisma.settings.create({
    data: {
      key: ENGAGE_SCAN_PACING_KEY,
      value: DEFAULT_SCAN_PACING as object,
      type: 'object',
      description:
        'Engage scan pagination pacing (maxPages + page/inter-unit delays + jitter + per-session cap), split by workflow vs extension path and by platform/phase.',
      default: DEFAULT_SCAN_PACING as object,
    },
  });
  return 'created';
}

async function main(): Promise<void> {
  const { checkOnly } = parseArgs();
  console.log('=== Engage upgrade (idempotent) ===\n');
  console.log(`Mode: ${checkOnly ? 'CHECK-ONLY (no writes)' : 'CHECK + SEED-IF-MISSING'}\n`);

  const prisma = new PrismaClient();
  try {
    console.log('1) Schema columns:');
    const schemaOk = await verifySchema(prisma);
    if (!schemaOk) {
      console.error(
        '\n✗ Missing column(s). Run `pnpm run prisma-db-push` first, then re-run this script.'
      );
      process.exitCode = 1;
      return;
    }

    console.log('\n2) Settings — engage_scan_pacing:');
    const pacing = await seedPacing(prisma, checkOnly);
    console.log(
      `  ${pacing === 'created' ? '✓ seeded default' : pacing === 'exists' ? '✓ already present (left untouched)' : '• would seed (check-only)'}`
    );

    console.log('\n3) Settings — engage_entitlements:');
    const ent = await prisma.settings.findUnique({
      where: { key: ENGAGE_ENTITLEMENTS_KEY },
    });
    console.log(
      ent
        ? '  ✓ present — new fields (metricsWindowDaysMax / metricsFetchIntervalHours) merge from defaults at read time; no row migration needed'
        : '  • absent — will be auto-seeded on first backend boot (EngageEntitlementService.onModuleInit)'
    );

    console.log(
      `\n${checkOnly ? '✓ Check complete (no writes).' : '✓ Upgrade init complete.'}` +
        '\nNext (optional, also idempotent): backfill existing orgs\n' +
        '  npx ts-node --project scripts/tsconfig.json scripts/backfill-engage-opportunity-states.ts --execute'
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
