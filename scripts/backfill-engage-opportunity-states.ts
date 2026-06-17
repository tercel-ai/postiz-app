/**
 * One-time backfill: populate per-org EngageOpportunityState from EXISTING global
 * opportunities, for orgs that subscribed (keywords/subreddits/tracked accounts)
 * before the extension scan path existed.
 *
 * In the extension scan model, a unit is fetched once GLOBALLY and fanned out to
 * every subscribing org on each scan. But an org that already had keywords when
 * the global opportunities were collected has no per-org state for them — and an
 * incremental scan won't surface those older posts. This script re-scores recent
 * global opportunities against each org's CURRENT enabled keywords/scope and
 * writes only the per-org state (no fetch, no global re-write) — exactly what
 * EngageScanTasksService.backfillFromExisting does, run across all enabled orgs.
 *
 * Idempotent: re-running refreshes scores; user state (status/bookmark) is
 * preserved by the upsert.
 *
 * Usage:
 *   npx ts-node --project scripts/tsconfig.json scripts/backfill-engage-opportunity-states.ts --dry-run
 *   npx ts-node --project scripts/tsconfig.json scripts/backfill-engage-opportunity-states.ts --execute
 *   npx ts-node --project scripts/tsconfig.json scripts/backfill-engage-opportunity-states.ts --org <orgId> --execute
 *   npx ts-node --project scripts/tsconfig.json scripts/backfill-engage-opportunity-states.ts --execute --window-days 30 --limit 1000 --concurrency 4
 */

import * as dotenv from 'dotenv';
dotenv.config();

process.env.NODE_ENV = process.env.NODE_ENV || 'production';
process.env.TZ = 'UTC';

import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { DatabaseModule } from '@gitroom/nestjs-libraries/database/prisma/database.module';
import { getTemporalModule } from '@gitroom/nestjs-libraries/temporal/temporal.module';
import { EngageScanTasksService } from '@gitroom/nestjs-libraries/engage/engage-scan-tasks.service';

@Module({ imports: [DatabaseModule, getTemporalModule(false)] })
class ScriptModule {}

interface CliArgs {
  orgId: string | null;
  dryRun: boolean;
  windowDays?: number;
  limit?: number;
  concurrency: number;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const out: CliArgs = { orgId: null, dryRun: true, concurrency: 4 };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--org':
        out.orgId = args[++i] ?? null;
        if (!out.orgId) { console.error('--org requires a value'); process.exit(1); }
        break;
      case '--execute': out.dryRun = false; break;
      case '--dry-run': out.dryRun = true; break;
      case '--window-days': out.windowDays = Number(args[++i]); break;
      case '--limit': out.limit = Number(args[++i]); break;
      case '--concurrency': out.concurrency = Math.max(1, Number(args[++i]) || 4); break;
      case '--help':
        console.log('Usage: backfill-engage-opportunity-states.ts [--org <id>] [--window-days N] [--limit N] [--concurrency N] [--dry-run|--execute]');
        process.exit(0);
        break;
      default:
        console.error(`Unknown argument: ${args[i]}`);
        process.exit(1);
    }
  }
  return out;
}

/** Run async tasks over `items` with a bounded number in flight. */
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  );
  return results;
}

async function main(): Promise<void> {
  const args = parseArgs();

  console.log('=== Backfill EngageOpportunityState from existing global opportunities ===\n');
  console.log(`Mode:        ${args.dryRun ? 'DRY RUN (no writes)' : 'EXECUTE'}`);
  console.log(`Org:         ${args.orgId ?? 'all enabled'}`);
  console.log(`Window days: ${args.windowDays ?? 'per-plan (from entitlement)'}`);
  console.log(`Limit/org:   ${args.limit ?? 1000}`);
  console.log(`Concurrency: ${args.concurrency}\n`);

  const prisma = new PrismaClient();

  // Enabled orgs to process (one config row per org).
  const configs = await prisma.engageConfig.findMany({
    where: { enabled: true, ...(args.orgId ? { organizationId: args.orgId } : {}) },
    select: { organizationId: true },
  });
  const orgIds = Array.from(new Set(configs.map((c) => c.organizationId)));
  console.log(`Found ${orgIds.length} enabled org${orgIds.length === 1 ? '' : 's'}.\n`);
  await prisma.$disconnect();

  if (args.dryRun) {
    orgIds.forEach((id) => console.log(`  would backfill org ${id}`));
    console.log(`\n--- DRY RUN. Re-run with --execute to write. ---`);
    return;
  }

  const app = await NestFactory.createApplicationContext(ScriptModule, {
    logger: ['error', 'warn'],
  });
  const scanTasks = app.get(EngageScanTasksService, { strict: false });

  let totalStates = 0;
  let failed = 0;
  const opts = { windowDays: args.windowDays, limit: args.limit };

  await mapWithConcurrency(orgIds, args.concurrency, async (orgId, i) => {
    try {
      const written = await scanTasks.backfillFromExisting(orgId, opts);
      totalStates += written;
      console.log(`  [${i + 1}/${orgIds.length}] org ${orgId}: ${written} state(s)`);
    } catch (e) {
      failed++;
      console.error(`  [${i + 1}/${orgIds.length}] org ${orgId} FAILED: ${(e as Error).message}`);
    }
  });

  console.log(
    `\nDone. orgs: ${orgIds.length}, states written: ${totalStates}, failed: ${failed}`
  );

  await app.close();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
