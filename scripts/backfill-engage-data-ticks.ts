/**
 * Backfill EngageDataTicks from the Post table for a historical date range.
 *
 * Why this exists:
 *   The daily `engageDataTicksWorkflow` (Temporal) is DISABLED by default
 *   (see libraries/.../temporal/infinite.workflow.register.ts) because the
 *   table is currently write-only — the engage dashboard endpoints read the
 *   Post table directly. The aggregate is a PURE DERIVATION of Post:
 *
 *     statisticsTime = Post.publishDate (start-of-day, UTC)
 *     value(replies)     = COUNT(engage posts published that day)
 *     value(impressions) = SUM(Post.impressions)   for that (org, platform, day)
 *     value(traffic)     = SUM(Post.trafficScore)   for that (org, platform, day)
 *
 *   so it can be reconstructed at any time as long as the underlying engage
 *   Post rows are retained. This script does exactly what the Temporal
 *   activity `aggregateDailyEngageTicks` does, but parameterised over an
 *   arbitrary date range instead of just "yesterday".
 *
 * Fidelity note (read before trusting the numbers):
 *   `replies` is an exact count → perfectly reconstructable.
 *   `impressions` / `traffic` are CUMULATIVE snapshots stored on Post. The
 *   live daily job froze the value ~1 day after publish; a backfill instead
 *   uses the CURRENT Post value bucketed by publish day. That yields a
 *   "current totals by publish date" series (the same semantic the live
 *   dashboard shows) — NOT a true as-of-day historical snapshot. If you need
 *   the latter you must run the daily job going forward; it cannot be
 *   reconstructed after the fact.
 *
 * Platform / type parity with the activity:
 *   - platform = Post.integration.providerIdentifier, falling back to 'reddit'.
 *   - a synthetic platform='all' row is written per org/day/type (cross-platform sum).
 *   - timeUnit is always 'day'; value is BigInt(Math.round(...)).
 *   - upsert overwrites value, so re-running is idempotent for a fixed Post state.
 *
 * Usage:
 *   npx ts-node --project scripts/tsconfig.json scripts/backfill-engage-data-ticks.ts \
 *     --start-date 2026-04-01 --end-date 2026-05-31 --dry-run
 *   npx ts-node --project scripts/tsconfig.json scripts/backfill-engage-data-ticks.ts \
 *     --start-date 2026-04-01 --end-date 2026-05-31 --execute
 *
 * Optional filters:
 *   --org <id>            Limit to one organization
 *   --platform <name>     Limit written rows to one platform (x | reddit); 'all' is
 *                         still derived from the unfiltered per-platform sums
 *   --type <name>         Limit to one type (replies | impressions | traffic)
 */

import * as dotenv from 'dotenv';
dotenv.config();

process.env.NODE_ENV = process.env.NODE_ENV || 'production';
process.env.TZ = 'UTC';

import { PrismaClient } from '@prisma/client';

const ALL_TYPES = ['replies', 'impressions', 'traffic'] as const;
type TickType = (typeof ALL_TYPES)[number];

interface CliArgs {
  startDate: string;
  endDate: string;
  orgId: string | null;
  platform: string | null;
  type: TickType | null;
  dryRun: boolean;
}

function printHelp(): void {
  console.log(`
Usage: npx ts-node --project scripts/tsconfig.json scripts/backfill-engage-data-ticks.ts [options]

Required:
  --start-date <YYYY-MM-DD>  First publish day to aggregate (inclusive, UTC)
  --end-date <YYYY-MM-DD>    Last publish day to aggregate (inclusive, UTC)

Optional:
  --org <id>                 Limit to a single organization
  --platform <name>          Limit written rows to one platform (x | reddit)
  --type <name>              Limit to one type (replies | impressions | traffic)
  --dry-run                  Show planned writes without touching the DB (default)
  --execute                  Actually perform the upserts
  --help                     Show this help message

Behavior:
  For each UTC day in the range, sums engage Post rows (source='engage',
  state='PUBLISHED') by (org, platform) and upserts EngageDataTicks rows for
  replies/impressions/traffic plus a platform='all' cross-platform total —
  identical to the Temporal activity aggregateDailyEngageTicks.
`);
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let startDate: string | null = null;
  let endDate: string | null = null;
  let orgId: string | null = null;
  let platform: string | null = null;
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
      case '--platform':
        platform = args[++i] ?? null;
        break;
      case '--type':
        type = args[++i] ?? null;
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
  if (type && !ALL_TYPES.includes(type as TickType)) {
    console.error(`--type must be one of: ${ALL_TYPES.join(', ')}`);
    process.exit(1);
  }
  return {
    startDate,
    endDate,
    orgId,
    platform,
    type: (type as TickType) ?? null,
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

interface Agg {
  count: number;
  impressions: number;
  traffic: number;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const start = parseUtcDay(args.startDate);
  const end = parseUtcDay(args.endDate);
  if (start.getTime() > end.getTime()) {
    console.error('start-date must be <= end-date.');
    process.exit(1);
  }

  console.log('=== EngageDataTicks Backfill (from Post) ===\n');
  console.log(`Mode:    ${args.dryRun ? 'DRY RUN (no writes)' : 'EXECUTE'}`);
  console.log(`Range:   ${args.startDate} → ${args.endDate} (UTC, inclusive)`);
  if (args.orgId) console.log(`Org:     ${args.orgId}`);
  if (args.platform) console.log(`Platform: ${args.platform}`);
  if (args.type) console.log(`Type:    ${args.type}`);
  console.log('');

  const prisma = new PrismaClient();
  const types: TickType[] = args.type ? [args.type] : [...ALL_TYPES];

  let plannedWrites = 0;
  let actualWrites = 0;
  let daysWithData = 0;

  for (const day of eachDayUtc(start, end)) {
    const dayStart = new Date(day);
    const dayEnd = new Date(day);
    dayEnd.setUTCHours(23, 59, 59, 999);

    const posts = await prisma.post.findMany({
      where: {
        source: 'engage',
        state: 'PUBLISHED',
        publishDate: { gte: dayStart, lte: dayEnd },
        ...(args.orgId ? { organizationId: args.orgId } : {}),
      },
      select: {
        organizationId: true,
        impressions: true,
        trafficScore: true,
        integration: { select: { providerIdentifier: true } },
      },
    });

    if (!posts.length) continue;
    daysWithData++;

    // Group by org → platform — identical to aggregateDailyEngageTicks.
    const byOrgPlatform = new Map<string, Map<string, Agg>>();
    for (const post of posts) {
      const platform = post.integration?.providerIdentifier ?? 'reddit';
      const orgMap =
        byOrgPlatform.get(post.organizationId) ?? new Map<string, Agg>();
      const curr = orgMap.get(platform) ?? { count: 0, impressions: 0, traffic: 0 };
      orgMap.set(platform, {
        count: curr.count + 1,
        impressions: curr.impressions + (post.impressions ?? 0),
        traffic: curr.traffic + (post.trafficScore ?? 0),
      });
      byOrgPlatform.set(post.organizationId, orgMap);
    }

    for (const [orgId, platformMap] of byOrgPlatform) {
      // Cross-platform "all" total (derived from the full per-platform sums,
      // before any --platform display filter).
      const allAgg = [...platformMap.values()].reduce(
        (a, b) => ({
          count: a.count + b.count,
          impressions: a.impressions + b.impressions,
          traffic: a.traffic + b.traffic,
        }),
        { count: 0, impressions: 0, traffic: 0 }
      );
      platformMap.set('all', allAgg);

      for (const [platform, agg] of platformMap) {
        if (args.platform && platform !== args.platform && platform !== 'all') {
          continue;
        }
        const valueByType: Record<TickType, number> = {
          replies: agg.count,
          impressions: agg.impressions,
          traffic: agg.traffic,
        };

        for (const type of types) {
          const value = BigInt(Math.round(valueByType[type]));
          plannedWrites++;
          console.log(
            `  ${dayKey(day)} org=${orgId} platform=${platform} ${type}=${value}`
          );
          if (!args.dryRun) {
            await prisma.engageDataTicks.upsert({
              where: {
                organizationId_platform_type_timeUnit_statisticsTime: {
                  organizationId: orgId,
                  platform,
                  type,
                  timeUnit: 'day',
                  statisticsTime: dayStart,
                },
              },
              create: {
                organizationId: orgId,
                platform,
                type,
                timeUnit: 'day',
                statisticsTime: dayStart,
                value,
              },
              update: { value },
            });
            actualWrites++;
          }
        }
      }
    }
  }

  console.log('');
  console.log(`Days with engage posts: ${daysWithData}`);
  console.log(`Planned writes:         ${plannedWrites}`);
  if (!args.dryRun) {
    console.log(`Executed writes:        ${actualWrites}`);
  } else {
    console.log('(dry run — pass --execute to write)');
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
