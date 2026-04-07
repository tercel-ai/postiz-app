/**
 * Repair DataTicks impressions/traffic so they satisfy the "cumulative
 * non-decreasing per integration" invariant the dashboard expects.
 *
 * Why this exists:
 *   DataTicks impressions/traffic are conceptually cumulative. When the
 *   orchestrator goes down for several days, OR when a re-sync hits rate
 *   limits / partial responses / deleted posts, the table ends up with
 *   two classes of damage:
 *
 *     (A) Missing days — gaps where no row was ever written.
 *     (B) Regression days — rows whose value is SMALLER than an earlier
 *         row for the same integration. The dashboard sums per-day, so
 *         these dips break the "later >= earlier" invariant of cumulative
 *         metrics, even when the underlying API measurement is technically
 *         "real" (e.g. a deleted post lowered the per-post lifetime sum).
 *
 *   This script does NOT call any platform API. For each (integration, type)
 *   pair it walks the requested date range and applies BOTH fixes in a
 *   single pass:
 *
 *     Pass 1 (fill):     each MISSING day gets a synthetic row carrying
 *                        the rolling baseline (most recent value seen,
 *                        real or already filled/repaired).
 *     Pass 2 (repair):   each EXISTING day whose value < baseline gets
 *                        overwritten with the baseline value, then the
 *                        baseline rolls forward to that day.
 *
 *   The result for every (integration, type) is a non-decreasing sequence
 *   over the requested range. Synthetic and repaired rows are marked with
 *   `postsAnalyzed = 0`.
 *
 * Trade-off you should know about:
 *   If an integration legitimately RECOVERED to lower values (e.g. all its
 *   high-impression posts were deleted), the script will hide that drop
 *   and pin the curve at the prior peak. That is the correct behavior for
 *   "monotonic cumulative" semantics, but if you have a specific
 *   integration where you want to preserve a real decline, exclude it via
 *   `--integration` and handle that one manually.
 *
 * Usage:
 *   npx ts-node --project scripts/tsconfig.json scripts/forward-fill-data-ticks.ts \
 *     --start-date 2026-04-03 --end-date 2026-04-06 --dry-run
 *   npx ts-node --project scripts/tsconfig.json scripts/forward-fill-data-ticks.ts \
 *     --start-date 2026-04-03 --end-date 2026-04-06 --execute
 *
 * Optional filters:
 *   --org <id>          Limit to one organization
 *   --integration <id>  Limit to one integration
 *   --type <name>       Limit to one type (impressions or traffic)
 */

import * as dotenv from 'dotenv';
dotenv.config();

process.env.NODE_ENV = process.env.NODE_ENV || 'production';
process.env.TZ = 'UTC';

import { PrismaClient } from '@prisma/client';

interface CliArgs {
  startDate: string;
  endDate: string;
  orgId: string | null;
  integrationId: string | null;
  type: string | null;
  dryRun: boolean;
}

const ALL_TYPES = ['impressions', 'traffic'] as const;

function printHelp(): void {
  console.log(`
Usage: npx ts-node --project scripts/tsconfig.json scripts/forward-fill-data-ticks.ts [options]

Required:
  --start-date <YYYY-MM-DD>  First day to repair (inclusive, UTC)
  --end-date <YYYY-MM-DD>    Last day to repair (inclusive, UTC)

Optional:
  --org <id>                 Limit to a single organization
  --integration <id>         Limit to a single integration
  --type <name>              Limit to one type (impressions | traffic)
  --dry-run                  Show planned writes without touching the DB
                             (default — must pass --execute to write)
  --execute                  Actually perform the writes
  --help                     Show this help message

Behavior (always both passes):
  - Walks each (integration, type) pair across the requested range.
  - Pass 1 — fill: each MISSING day gets a synthetic row carrying the
    rolling baseline (the most recent value seen for this integration,
    real or already filled / repaired).
  - Pass 2 — repair: each EXISTING day whose value < baseline is
    overwritten with the baseline value (cumulative invariant).
  - Both written rows are marked postsAnalyzed=0.
  - Healthy days (existing AND value >= baseline) become the new
    baseline and are left untouched.
  - Integrations with no prior data anywhere are skipped (nothing to
    carry forward from).
`);
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let startDate: string | null = null;
  let endDate: string | null = null;
  let orgId: string | null = null;
  let integrationId: string | null = null;
  let type: string | null = null;
  let dryRun = true;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--start-date':
        startDate = args[++i] ?? null;
        break;
      case '--end-date':
        endDate = args[++i] ?? null;
        break;
      case '--org':
        orgId = args[++i] ?? null;
        break;
      case '--integration':
        integrationId = args[++i] ?? null;
        break;
      case '--type':
        type = args[++i] ?? null;
        break;
      case '--repair-regressions':
        // Kept for backwards compatibility — repair is now always on.
        console.warn(
          'NOTE: --repair-regressions is now the default and the flag is ignored.'
        );
        break;
      case '--execute':
        dryRun = false;
        break;
      case '--dry-run':
        dryRun = true;
        break;
      case '--help':
        printHelp();
        process.exit(0);
      default:
        console.error(`Unknown argument: ${args[i]}`);
        printHelp();
        process.exit(1);
    }
  }

  if (!startDate || !endDate) {
    console.error('--start-date and --end-date are required (YYYY-MM-DD).');
    printHelp();
    process.exit(1);
  }
  if (type && !ALL_TYPES.includes(type as any)) {
    console.error(`--type must be one of: ${ALL_TYPES.join(', ')}`);
    process.exit(1);
  }
  return {
    startDate,
    endDate,
    orgId,
    integrationId,
    type,
    dryRun,
  };
}

function parseUtcDay(s: string): Date {
  const d = new Date(`${s}T00:00:00.000Z`);
  if (isNaN(d.getTime())) {
    console.error(`Invalid date: ${s}`);
    process.exit(1);
  }
  return d;
}

function* eachDayUtc(start: Date, end: Date): Generator<Date> {
  const d = new Date(start);
  while (d.getTime() <= end.getTime()) {
    yield new Date(d);
    d.setUTCDate(d.getUTCDate() + 1);
  }
}

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  const args = parseArgs();
  const start = parseUtcDay(args.startDate);
  const end = parseUtcDay(args.endDate);
  if (start.getTime() > end.getTime()) {
    console.error('start-date must be <= end-date.');
    process.exit(1);
  }

  console.log('=== DataTicks Forward-Fill + Monotonic Repair ===\n');
  console.log(`Mode:    ${args.dryRun ? 'DRY RUN (no writes)' : 'EXECUTE'}`);
  console.log(`Range:   ${args.startDate} → ${args.endDate} (UTC, inclusive)`);
  console.log(
    'Behavior: fill missing days from prior baseline, then overwrite ' +
      'any existing day whose value < baseline'
  );
  if (args.orgId) console.log(`Org:     ${args.orgId}`);
  if (args.integrationId) console.log(`Integration: ${args.integrationId}`);
  if (args.type) console.log(`Type:    ${args.type}`);
  console.log('');

  const prisma = new PrismaClient();
  const types = args.type ? [args.type] : [...ALL_TYPES];

  let plannedFills = 0;
  let plannedRepairs = 0;
  let actualWrites = 0;
  let skippedNoPrior = 0;

  for (const type of types) {
    // Pull every row up to and including the end of the range that matches
    // the optional filters. We need everything <= end so we can both detect
    // existing days inside the range AND find a "last good prior" row.
    const allRows = await prisma.dataTicks.findMany({
      where: {
        type,
        timeUnit: 'day',
        statisticsTime: { lte: end },
        ...(args.orgId ? { organizationId: args.orgId } : {}),
        ...(args.integrationId ? { integrationId: args.integrationId } : {}),
      },
      orderBy: { statisticsTime: 'asc' },
      select: {
        organizationId: true,
        integrationId: true,
        platform: true,
        userId: true,
        statisticsTime: true,
        value: true,
      },
    });

    // Group by integrationId
    const byIntegration = new Map<string, typeof allRows>();
    for (const r of allRows) {
      let bucket = byIntegration.get(r.integrationId);
      if (!bucket) {
        bucket = [];
        byIntegration.set(r.integrationId, bucket);
      }
      bucket.push(r);
    }

    console.log(`[${type}] ${byIntegration.size} integration(s) with prior data`);

    for (const [intId, rows] of byIntegration) {
      // Build day → row map for the integration
      const dayMap = new Map<string, (typeof rows)[number]>();
      for (const r of rows) {
        dayMap.set(dayKey(r.statisticsTime), r);
      }

      // Find the latest row strictly before `start` to seed lastGood.
      let lastGood: (typeof rows)[number] | null = null;
      for (const r of rows) {
        if (r.statisticsTime.getTime() < start.getTime()) {
          lastGood = r;
        } else {
          break;
        }
      }

      for (const day of eachDayUtc(start, end)) {
        const key = dayKey(day);
        const existing = dayMap.get(key);

        if (existing) {
          // Existing row in range: healthy or regression?
          if (lastGood === null || existing.value >= lastGood.value) {
            // Healthy: adopt as new baseline, leave row untouched.
            lastGood = existing;
            continue;
          }

          // Regression: existing.value < baseline → overwrite to baseline.
          plannedRepairs++;
          console.log(
            `  ${type} ${key} integration=${intId} ⚠ REPAIR ` +
              `existing=${existing.value} < baseline=${lastGood.value} ` +
              `← carry ${dayKey(lastGood.statisticsTime)}`
          );
          if (!args.dryRun) {
            await prisma.dataTicks.update({
              where: {
                organizationId_integrationId_type_timeUnit_statisticsTime: {
                  organizationId: existing.organizationId,
                  integrationId: existing.integrationId,
                  type,
                  timeUnit: 'day',
                  statisticsTime: day,
                },
              },
              data: {
                value: lastGood.value,
                postsAnalyzed: 0,
              },
            });
            actualWrites++;
          }
          // After repair the synthesized value rolls forward as baseline.
          lastGood = {
            ...lastGood,
            statisticsTime: day,
          };
          continue;
        }

        // Missing day → fill from baseline.
        if (lastGood === null) {
          skippedNoPrior++;
          continue;
        }

        plannedFills++;
        console.log(
          `  ${type} ${key} integration=${intId} ← carry ${dayKey(
            lastGood.statisticsTime
          )} (value=${lastGood.value})`
        );

        if (!args.dryRun) {
          await prisma.dataTicks.upsert({
            where: {
              organizationId_integrationId_type_timeUnit_statisticsTime: {
                organizationId: lastGood.organizationId,
                integrationId: lastGood.integrationId,
                type,
                timeUnit: 'day',
                statisticsTime: day,
              },
            },
            // Defensive: never overwrite an existing row from this branch
            // (we already handled the existing case above).
            update: {},
            create: {
              organizationId: lastGood.organizationId,
              integrationId: lastGood.integrationId,
              platform: lastGood.platform,
              userId: lastGood.userId,
              type,
              timeUnit: 'day',
              statisticsTime: day,
              value: lastGood.value,
              postsAnalyzed: 0,
            },
          });
          actualWrites++;
        }

        // Roll the baseline forward to the synthesized row.
        lastGood = {
          ...lastGood,
          statisticsTime: day,
        };
      }
    }
  }

  console.log('');
  console.log(`Planned fills:   ${plannedFills} missing day(s)`);
  console.log(`Planned repairs: ${plannedRepairs} regression(s)`);
  console.log(`Total planned:   ${plannedFills + plannedRepairs} write(s)`);
  if (!args.dryRun) {
    console.log(`Executed writes: ${actualWrites}`);
  }
  if (skippedNoPrior > 0) {
    console.log(
      `Skipped (no prior data): ${skippedNoPrior} integration-day cell(s)`
    );
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
