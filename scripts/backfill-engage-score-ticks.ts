/**
 * Backfill EngageScoreTick from EngageOpportunityState for a historical range.
 *
 * Why this exists:
 *   EngageScoreTick (the engage score-distribution telemetry, surfaced at
 *   GET /admin/api-cost/engage-scores) only started being written once the
 *   recordScoreDistribution hooks shipped. Scans that ran before that left the
 *   table empty even though the opportunities themselves were persisted. The
 *   persisted-opportunity distribution is a PURE DERIVATION of stored rows:
 *
 *     date     = EngageOpportunityState.createdAt (start-of-day, UTC)
 *     org      = EngageOpportunityState.organizationId
 *     platform = EngageOpportunity.platform
 *     bucket   = scoreBucket(EngageOpportunityState.score)
 *     quantity = COUNT(*) per (date, org, platform, bucket)
 *
 *   so the 'persisted' phase can be reconstructed at any time. This writes one
 *   EngageScoreTick row per group, phase='persisted'.
 *
 * 'scanned' phase (--with-scanned):
 *   The 'scanned' phase counts EVERY keyword-matched scored post, BEFORE the
 *   ENGAGE_MIN_SCORE persist gate. It is reconstructable from
 *   EngageOpportunityState **only if the gate was 0 over the whole range** —
 *   then nothing was filtered, so persisted == scanned and the same counts are
 *   valid for both phases. If ENGAGE_MIN_SCORE was ever > 0 in the range, the
 *   below-gate posts were discarded at scan time and are gone; --with-scanned
 *   would then UNDER-count the low buckets. Off by default; opt in only when you
 *   know the gate stayed 0 (the script prints a warning).
 *
 * Fidelity notes (read before trusting the numbers):
 *   - score is the LATEST value: EngageOpportunityState.score is re-upserted on
 *     every re-scan, so a hot post's bucket may have drifted up since first
 *     ingest. The result is a "current-score distribution bucketed by ingest
 *     day", not a true as-of-day snapshot.
 *   - DISTINCT count: one row per (org, opportunity). This is distinct
 *     valid-post inventory — NOT the scan-EVENT count the live forward hook
 *     records (which counts every re-scan). Do not mix the two units: only
 *     backfill dates the live worker has NOT yet written.
 *
 * Idempotency:
 *   upsert OVERWRITES quantity (SET, not increment), so re-running over a fixed
 *   EngageOpportunityState is idempotent. BUT this means you must NOT run it over
 *   dates the restarted worker already incremented live — the SET would clobber
 *   those. Cap --end-date to the day before the fix was deployed.
 *
 * Usage:
 *   npx ts-node --project scripts/tsconfig.json scripts/backfill-engage-score-ticks.ts \
 *     --start-date 2026-05-01 --end-date 2026-06-24 --dry-run
 *   npx ts-node --project scripts/tsconfig.json scripts/backfill-engage-score-ticks.ts \
 *     --start-date 2026-05-01 --end-date 2026-06-24 --with-scanned --execute
 *
 * Optional filters:
 *   --org <id>            Limit to one organization
 *   --platform <name>     Limit to one platform (x | reddit)
 *   --with-scanned        Also write the 'scanned' phase (assumes gate stayed 0)
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
  platform: string | null;
  withScanned: boolean;
  dryRun: boolean;
}

// Fixed, non-overlapping score bands. MUST stay in sync with engageScoreBucket
// in libraries/.../api-usage/api-usage.service.ts. Lower-exclusive /
// upper-inclusive (first band 0-inclusive); the top band is a catch-all that
// also covers 101-105 (the scorer's true max).
function scoreBucket(score: number): string {
  if (score <= 50) return '0-50';
  if (score <= 60) return '50-60';
  if (score <= 70) return '60-70';
  if (score <= 85) return '70-85';
  return '85-100';
}

function printHelp(): void {
  console.log(`
Usage: npx ts-node --project scripts/tsconfig.json scripts/backfill-engage-score-ticks.ts [options]

Required:
  --start-date <YYYY-MM-DD>  First ingest day to aggregate (inclusive, UTC)
  --end-date <YYYY-MM-DD>    Last ingest day to aggregate (inclusive, UTC)

Optional:
  --org <id>                 Limit to a single organization
  --platform <name>          Limit to one platform (x | reddit)
  --with-scanned             Also write the 'scanned' phase (only correct if
                             ENGAGE_MIN_SCORE was 0 for the whole range)
  --dry-run                  Show planned writes without touching the DB (default)
  --execute                  Actually perform the upserts
  --help                     Show this help message

Behavior:
  For each UTC day in the range, groups EngageOpportunityState rows (joined to
  EngageOpportunity for platform) by (org, platform, scoreBucket) and upserts one
  EngageScoreTick row per group, phase='persisted' (plus 'scanned' with
  --with-scanned). Quantity is the DISTINCT opportunity count and is OVERWRITTEN
  on each run (idempotent). Do NOT overlap with dates the live worker already
  recorded after the fix shipped.
`);
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let startDate: string | null = null;
  let endDate: string | null = null;
  let orgId: string | null = null;
  let platform: string | null = null;
  let withScanned = false;
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
      case '--with-scanned':
        withScanned = true;
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
  return { startDate, endDate, orgId, platform, withScanned, dryRun };
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

  const phases = args.withScanned
    ? (['persisted', 'scanned'] as const)
    : (['persisted'] as const);

  console.log('=== EngageScoreTick Backfill (from EngageOpportunityState) ===\n');
  console.log(`Mode:    ${args.dryRun ? 'DRY RUN (no writes)' : 'EXECUTE'}`);
  console.log(`Range:   ${args.startDate} → ${args.endDate} (UTC, inclusive)`);
  console.log(`Phases:  ${phases.join(', ')}`);
  if (args.orgId) console.log(`Org:     ${args.orgId}`);
  if (args.platform) console.log(`Platform: ${args.platform}`);
  if (args.withScanned) {
    console.log(
      `\n⚠️  --with-scanned: 'scanned' counts are valid ONLY if ENGAGE_MIN_SCORE\n` +
        `    was 0 across this range (nothing filtered → persisted == scanned).\n` +
        `    If the gate was ever > 0, low buckets will be under-counted.`
    );
  }
  console.log('');

  const prisma = new PrismaClient();

  let plannedWrites = 0;
  let actualWrites = 0;
  let daysWithData = 0;

  for (const day of eachDayUtc(start, end)) {
    const dayStart = new Date(day);
    const dayEnd = new Date(day);
    dayEnd.setUTCHours(23, 59, 59, 999);

    const states = await prisma.engageOpportunityState.findMany({
      where: {
        createdAt: { gte: dayStart, lte: dayEnd },
        ...(args.orgId ? { organizationId: args.orgId } : {}),
        ...(args.platform ? { opportunity: { platform: args.platform } } : {}),
      },
      select: {
        organizationId: true,
        score: true,
        opportunity: { select: { platform: true } },
      },
    });

    if (!states.length) continue;
    daysWithData++;

    // Group by (org, platform, bucket) → distinct opportunity count.
    const counts = new Map<string, { org: string; platform: string; bucket: string; n: number }>();
    for (const s of states) {
      const platform = s.opportunity?.platform ?? 'unknown';
      const bucket = scoreBucket(s.score);
      const key = `${s.organizationId} ${platform} ${bucket}`;
      const slot = counts.get(key) ?? { org: s.organizationId, platform, bucket, n: 0 };
      slot.n += 1;
      counts.set(key, slot);
    }

    for (const { org, platform, bucket, n } of counts.values()) {
      for (const phase of phases) {
        const quantity = BigInt(n);
        plannedWrites++;
        console.log(
          `  ${dayKey(day)} org=${org} platform=${platform} phase=${phase} ${bucket}=${quantity}`
        );
        if (!args.dryRun) {
          await prisma.engageScoreTick.upsert({
            where: {
              date_organizationId_platform_phase_bucket: {
                date: dayStart,
                organizationId: org,
                platform,
                phase,
                bucket,
              },
            },
            create: {
              date: dayStart,
              organizationId: org,
              platform,
              phase,
              bucket,
              quantity,
            },
            update: { quantity }, // SET (overwrite) → idempotent
          });
          actualWrites++;
        }
      }
    }
  }

  console.log('');
  console.log(`Days with opportunities: ${daysWithData}`);
  console.log(`Planned writes:          ${plannedWrites}`);
  if (!args.dryRun) {
    console.log(`Executed writes:         ${actualWrites}`);
  } else {
    console.log('(dry run — pass --execute to write)');
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
