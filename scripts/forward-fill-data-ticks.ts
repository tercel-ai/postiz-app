/**
 * Forward-fill missing DataTicks rows over a date range.
 *
 * Why this exists:
 *   DataTicks impressions/traffic are conceptually cumulative snapshots. When
 *   the orchestrator goes down for several days and we re-run sync scripts
 *   afterwards, some integrations fail (rate limits, token refresh, batch
 *   errors) and their rows for the missing days are never written. The
 *   dashboard time-series query then renders those days as 0 or as a sum
 *   over fewer integrations than adjacent days, breaking the
 *   "later >= earlier" invariant.
 *
 *   This script does NOT call any platform API. For each (integration, type)
 *   pair, it walks the requested date range and, where a day is missing,
 *   inserts a row carrying the most recent prior value forward. Existing
 *   rows are never overwritten.
 *
 * Usage:
 *   npx ts-node --project scripts/tsconfig.json scripts/forward-fill-data-ticks.ts \
 *     --start-date 2026-04-03 --end-date 2026-04-05 --dry-run
 *   npx ts-node --project scripts/tsconfig.json scripts/forward-fill-data-ticks.ts \
 *     --start-date 2026-04-03 --end-date 2026-04-05 --execute
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
  repairRegressions: boolean;
}

const ALL_TYPES = ['impressions', 'traffic'] as const;

function printHelp(): void {
  console.log(`
Usage: npx ts-node --project scripts/tsconfig.json scripts/forward-fill-data-ticks.ts [options]

Required:
  --start-date <YYYY-MM-DD>  First day to fill (inclusive, UTC)
  --end-date <YYYY-MM-DD>    Last day to fill (inclusive, UTC)

Optional:
  --org <id>                 Limit to a single organization
  --integration <id>         Limit to a single integration
  --type <name>              Limit to one type (impressions | traffic)
  --repair-regressions       Also overwrite existing rows whose value is
                             smaller than the rolling carry-forward baseline.
                             Use this to fix monotonicity violations caused
                             by previously botched re-syncs (e.g. partial
                             API responses that produced "smaller than
                             yesterday" cumulative values).
  --dry-run                  Show planned upserts without writing (default)
  --execute                  Actually perform the upserts
  --help                     Show this help message

Behavior:
  - Walks each (integration, type) pair that has any DataTicks row anywhere.
  - For each MISSING day in the range, inserts a row carrying the value from
    the most recent prior row (real or already carried-forward).
  - For each EXISTING day in the range:
      * Without --repair-regressions: leave it untouched and use it as the
        new baseline. Existing rows are NEVER overwritten.
      * With --repair-regressions: if value < baseline, overwrite with the
        baseline value. Otherwise leave untouched and use it as the new
        baseline.
  - postsAnalyzed is set to 0 to mark synthetic / repaired rows.
  - Skips integrations with no prior data at all (cannot carry forward).
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
  let repairRegressions = false;

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
        repairRegressions = true;
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
    repairRegressions,
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

  console.log('=== DataTicks Forward-Fill ===\n');
  console.log(`Mode:    ${args.dryRun ? 'DRY RUN (no writes)' : 'EXECUTE'}`);
  console.log(`Range:   ${args.startDate} → ${args.endDate} (UTC, inclusive)`);
  console.log(
    `Repair:  ${args.repairRegressions ? 'YES (overwrite regressions)' : 'no (missing days only)'}`
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
  let regressionsLeftInPlace = 0;

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
          // Existing row inside the range: check for monotonic regression.
          const isRegression =
            lastGood !== null && existing.value < lastGood.value;

          if (!isRegression) {
            // Healthy row: adopt it as the new baseline.
            lastGood = existing;
            continue;
          }

          // Regression detected (existing < baseline).
          if (args.repairRegressions) {
            plannedRepairs++;
            console.log(
              `  ${type} ${key} integration=${intId} ⚠ REPAIR ` +
                `existing=${existing.value} < baseline=${lastGood!.value} ` +
                `← carry ${dayKey(lastGood!.statisticsTime)}`
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
                  value: lastGood!.value,
                  postsAnalyzed: 0,
                },
              });
              actualWrites++;
            }
            // After repair, the synthesized value becomes the new baseline.
            lastGood = {
              ...lastGood!,
              statisticsTime: day,
            };
          } else {
            // Not repairing — leave the regression in place but DO NOT
            // adopt it as baseline, otherwise subsequent missing days
            // would propagate the lower (wrong) value forward.
            regressionsLeftInPlace++;
            console.warn(
              `  ${type} ${key} integration=${intId} ⚠ regression ` +
                `(existing=${existing.value} < baseline=${lastGood!.value}) ` +
                `left in place — re-run with --repair-regressions to fix`
            );
            // lastGood unchanged
          }
          continue;
        }

        // Missing day → carry-forward.
        if (!lastGood) {
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
            // Defensive: never overwrite an existing row in this branch
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

        // Treat the synthesized row as the new lastGood for subsequent days.
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
  if (!args.dryRun) {
    console.log(`Executed writes: ${actualWrites}`);
  }
  if (regressionsLeftInPlace > 0) {
    console.log(
      `Regressions left in place: ${regressionsLeftInPlace} ` +
        `(re-run with --repair-regressions to fix)`
    );
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
