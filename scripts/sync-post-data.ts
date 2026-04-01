/**
 * Sync post analytics data and DataTicks for all organizations.
 *
 * Uses the SAME DataTicksService.syncDailyTicks() method as the daily Temporal
 * cron workflow (UTC 00:05). This includes:
 *   1. Fetching post-level analytics from platform APIs
 *   2. Updating individual Post records (impressions, trafficScore, analytics)
 *   3. Upserting aggregated DataTicks (impressions + traffic per integration per day)
 *   4. Invalidating dashboard Redis cache
 *   5. Syncing account-level metrics (followers, etc.)
 *
 * DataTicks use an upsert on (org, integration, type, timeUnit, statisticsTime),
 * so running this multiple times per day safely overwrites the previous values.
 *
 * Usage:
 *   npx ts-node --project scripts/tsconfig.json scripts/sync-post-data.ts --dry-run
 *   npx ts-node --project scripts/tsconfig.json scripts/sync-post-data.ts --execute
 *   npx ts-node --project scripts/tsconfig.json scripts/sync-post-data.ts --date 2026-03-28 --execute
 *   npx ts-node --project scripts/tsconfig.json scripts/sync-post-data.ts --start-date 2026-03-01 --end-date 2026-03-10 --execute
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'production';
process.env.TZ = 'UTC';

import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { DatabaseModule } from '@gitroom/nestjs-libraries/database/prisma/database.module';
import { DataTicksService } from '@gitroom/nestjs-libraries/database/prisma/data-ticks/data-ticks.service';
import { getTemporalModule } from '@gitroom/nestjs-libraries/temporal/temporal.module';

@Module({ imports: [DatabaseModule, getTemporalModule(false)] })
class ScriptModule {}

interface CliArgs {
  date: string | null;
  startDate: string | null;
  endDate: string | null;
  dryRun: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let date: string | null = null;
  let startDate: string | null = null;
  let endDate: string | null = null;
  let dryRun = true;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--date':
        date = args[++i] ?? null;
        if (!date) { console.error('--date requires a value (YYYY-MM-DD)'); process.exit(1); }
        break;
      case '--start-date':
        startDate = args[++i] ?? null;
        if (!startDate) { console.error('--start-date requires a value (YYYY-MM-DD)'); process.exit(1); }
        break;
      case '--end-date':
        endDate = args[++i] ?? null;
        if (!endDate) { console.error('--end-date requires a value (YYYY-MM-DD)'); process.exit(1); }
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
        break;
      default:
        console.error(`Unknown argument: ${args[i]}`);
        printHelp();
        process.exit(1);
    }
  }

  return { date, startDate, endDate, dryRun };
}

function printHelp(): void {
  console.log(`
Usage: npx ts-node --project scripts/tsconfig.json scripts/sync-post-data.ts [options]

Options:
  --date <YYYY-MM-DD>        Sync for a specific date (default: yesterday)
  --start-date <YYYY-MM-DD>  Start of date range (for backfill)
  --end-date <YYYY-MM-DD>    End of date range (for backfill, default: start-date)
  --dry-run                  Show what would be synced without making changes (default)
  --execute                  Actually perform the sync
  --help                     Show this help message

DataTicks use upsert, so running multiple times per day safely overwrites previous values.

Examples:
  npx ts-node --project scripts/tsconfig.json scripts/sync-post-data.ts --dry-run
  npx ts-node --project scripts/tsconfig.json scripts/sync-post-data.ts --execute
  npx ts-node --project scripts/tsconfig.json scripts/sync-post-data.ts --date 2026-03-28 --execute
  npx ts-node --project scripts/tsconfig.json scripts/sync-post-data.ts --start-date 2026-03-01 --end-date 2026-03-10 --execute
`);
}

function buildDateRange(args: CliArgs): Array<Date | undefined> {
  const dates: Array<Date | undefined> = [];

  if (args.startDate) {
    const start = new Date(args.startDate);
    const end = args.endDate ? new Date(args.endDate) : new Date(args.startDate);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      console.error('Invalid date format. Use YYYY-MM-DD.');
      process.exit(1);
    }
    if (start > end) {
      console.error('start-date must be before or equal to end-date.');
      process.exit(1);
    }
    const current = new Date(start);
    while (current <= end) {
      dates.push(new Date(current));
      current.setDate(current.getDate() + 1);
    }
  } else if (args.date) {
    const d = new Date(args.date);
    if (isNaN(d.getTime())) {
      console.error('Invalid date format. Use YYYY-MM-DD.');
      process.exit(1);
    }
    dates.push(d);
  } else {
    // Default: no targetDate passed -> syncDailyTicks defaults to yesterday
    dates.push(undefined);
  }

  return dates;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const dates = buildDateRange(args);

  console.log('=== Post Data & DataTicks Sync Script ===\n');
  console.log(`Mode: ${args.dryRun ? 'DRY RUN (no changes)' : 'EXECUTE'}`);

  const definedDates = dates.filter((d): d is Date => d !== undefined);
  if (definedDates.length === 0) {
    console.log('Date: yesterday (default)');
  } else {
    const labels = definedDates.map((d) => d.toISOString().slice(0, 10));
    console.log(`Date(s): ${labels.length <= 5 ? labels.join(', ') : `${labels[0]} to ${labels[labels.length - 1]} (${labels.length} days)`}`);
  }

  console.log('');
  console.log('This script calls DataTicksService.syncDailyTicks() -- the same method');
  console.log('used by the daily Temporal workflow. It will:');
  console.log('  1. Fetch post analytics from platform APIs (last 30 days of posts)');
  console.log('  2. Update Post.impressions, Post.trafficScore, Post.analytics');
  console.log('  3. Upsert DataTicks (impressions + traffic per integration per day)');
  console.log('  4. Invalidate dashboard Redis cache');
  console.log('  5. Sync account-level metrics (followers, etc.)');
  console.log('');

  if (args.dryRun) {
    console.log('--- DRY RUN complete. Run with --execute to sync. ---');
    return;
  }

  // Bootstrap NestJS app context
  console.log('Bootstrapping NestJS context...\n');
  const app = await NestFactory.createApplicationContext(ScriptModule, {
    logger: ['error', 'warn'],
  });

  const dataTicksService = app.get(DataTicksService);

  let totalUpserted = 0;
  let totalErrors = 0;

  for (const date of dates) {
    const label = date ? date.toISOString().slice(0, 10) : 'yesterday';
    process.stdout.write(`  Syncing ${label} ... `);

    try {
      const result = await dataTicksService.syncDailyTicks(date);
      console.log(
        `OK: ${result.totalUpserted} ticks upserted, ${result.totalErrors} org error(s)`
      );
      totalUpserted += result.totalUpserted;
      totalErrors += result.totalErrors;
    } catch (err: any) {
      console.log(`ERROR: ${err?.message || err}`);
      totalErrors++;
    }
  }

  console.log(`\nDone: ${totalUpserted} total ticks upserted, ${totalErrors} total error(s).`);

  await app.close();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
