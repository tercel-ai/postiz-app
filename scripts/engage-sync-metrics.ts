/**
 * Manually wake up engage reply-metrics collection AND print a stats summary.
 *
 * One command does the whole "why is the sent-list empty?" fix:
 *   1. Backfill Post.integrationId for X replies that have none, by resolving a
 *      usable X account (author-handle → engage reply account → any live account).
 *      Without it, checkPostAnalytics can't read X metrics.            [X only]
 *   2. Re-fetch metrics for every PUBLISHED engage reply whose impressions are
 *      still null — via EngageService.resyncEngageMetrics, the SAME shared logic
 *      the 24h Temporal sync and POST /engage/admin/resync-metrics use
 *      (X → checkPostAnalytics OAuth token; Reddit → loid/WAF public fetch).
 *   3. Print a before/after stats table (per platform: published / with-metrics /
 *      missing / Σ impressions / Σ traffic).
 *
 * Safe to run repeatedly — every step is idempotent (upserts metrics, fills only
 * null integrationId). Defaults to a read-only DRY RUN.
 *
 * Usage:
 *   npx ts-node --project scripts/tsconfig.json scripts/engage-sync-metrics.ts --dry-run
 *   npx ts-node --project scripts/tsconfig.json scripts/engage-sync-metrics.ts --execute
 *   npx ts-node --project scripts/tsconfig.json scripts/engage-sync-metrics.ts --org <orgId> --execute
 *   npx ts-node --project scripts/tsconfig.json scripts/engage-sync-metrics.ts --platform x --execute
 *   npx ts-node --project scripts/tsconfig.json scripts/engage-sync-metrics.ts --stats     # stats only, no sync
 *   npx ts-node --project scripts/tsconfig.json scripts/engage-sync-metrics.ts --no-backfill --execute
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
import { EngageService } from '@gitroom/nestjs-libraries/engage/engage.service';
import { EngageRepository } from '@gitroom/nestjs-libraries/engage/engage.repository';
import {
  classifyReplyMetric,
  ReplyMetricStatus,
} from '@gitroom/nestjs-libraries/engage/engage-metrics-stats';

@Module({ imports: [DatabaseModule, getTemporalModule(false)] })
class ScriptModule {}

interface CliArgs {
  orgId: string | null;
  platform: 'x' | 'reddit' | null;
  backfill: boolean;
  statsOnly: boolean;
  dryRun: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const out: CliArgs = {
    orgId: null,
    platform: null,
    backfill: true,
    statsOnly: false,
    dryRun: true,
  };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--org':
        out.orgId = args[++i] ?? null;
        if (!out.orgId) { console.error('--org requires a value'); process.exit(1); }
        break;
      case '--platform': {
        const p = args[++i];
        if (p !== 'x' && p !== 'reddit') { console.error('--platform must be x|reddit'); process.exit(1); }
        out.platform = p;
        break;
      }
      case '--no-backfill': out.backfill = false; break;
      case '--stats': out.statsOnly = true; break;
      case '--execute': out.dryRun = false; break;
      case '--dry-run': out.dryRun = true; break;
      case '--help':
        console.log(
          'Usage: engage-sync-metrics.ts [--org <id>] [--platform x|reddit] ' +
          '[--no-backfill] [--stats] [--dry-run|--execute]'
        );
        process.exit(0);
        break;
      default:
        console.error(`Unknown argument: ${args[i]}`);
        process.exit(1);
    }
  }
  return out;
}

interface PlatformStat {
  published: number;
  withMetrics: number;
  missing: number;
  noReleaseURL: number; // needs PATCH /sent/:id/reply-url
  noIntegration: number; // X — run integration backfill
  noReleaseId: number; // X — URL has no /status/<id>
  syncable: number; // ready, but fetch returned nothing (tier/WAF/pending)
  sumImpressions: number;
  sumTraffic: number;
}

interface MissingItem {
  platform: string;
  status: ReplyMetricStatus;
  url: string | null;
}

/** Snapshot of published engage replies grouped by platform, plus the list of
 *  missing replies tagged with WHY they're missing. Bounded data set. */
async function collectStats(
  prisma: PrismaClient,
  orgId: string | null,
  platform: 'x' | 'reddit' | null
): Promise<{ stats: Record<string, PlatformStat>; missing: MissingItem[] }> {
  const rows = await prisma.engageSentReply.findMany({
    where: {
      ...(orgId ? { organizationId: orgId } : {}),
      ...(platform ? { opportunity: { platform } } : {}),
      post: { source: 'engage', state: 'PUBLISHED' },
    },
    select: {
      post: {
        select: {
          impressions: true,
          trafficScore: true,
          integrationId: true,
          releaseURL: true,
          releaseId: true,
        },
      },
      opportunity: { select: { platform: true } },
    },
  });

  const stats: Record<string, PlatformStat> = {};
  const missing: MissingItem[] = [];
  for (const r of rows) {
    const p = r.opportunity.platform;
    const s = (stats[p] ??= {
      published: 0, withMetrics: 0, missing: 0,
      noReleaseURL: 0, noIntegration: 0, noReleaseId: 0, syncable: 0,
      sumImpressions: 0, sumTraffic: 0,
    });
    s.published++;
    const status = classifyReplyMetric({
      platform: p,
      impressions: r.post?.impressions,
      releaseURL: r.post?.releaseURL,
      releaseId: r.post?.releaseId,
      integrationId: r.post?.integrationId,
    });
    if (status === 'has_metrics') {
      s.withMetrics++;
      s.sumImpressions += r.post?.impressions ?? 0;
      s.sumTraffic += r.post?.trafficScore ?? 0;
    } else {
      s.missing++;
      if (status === 'no_release_url') s.noReleaseURL++;
      else if (status === 'no_integration') s.noIntegration++;
      else if (status === 'no_release_id') s.noReleaseId++;
      else s.syncable++;
      missing.push({ platform: p, status, url: r.post?.releaseURL ?? null });
    }
  }
  return { stats, missing };
}

function printStats(label: string, stats: Record<string, PlatformStat>): void {
  console.log(`\n── ${label} ──`);
  const platforms = Object.keys(stats).sort();
  if (platforms.length === 0) {
    console.log('  (no published engage replies)');
    return;
  }
  for (const p of platforms) {
    const s = stats[p];
    const blockers = [
      s.noReleaseURL ? `noURL=${s.noReleaseURL}` : '',
      s.noIntegration ? `noIntegration=${s.noIntegration}` : '',
      s.noReleaseId ? `noReleaseId=${s.noReleaseId}` : '',
      s.syncable ? `syncable=${s.syncable}` : '',
    ].filter(Boolean).join(' ');
    console.log(
      `  [${p.padEnd(6)}] published=${s.published}  withMetrics=${s.withMetrics}  ` +
      `missing=${s.missing}${blockers ? ` (${blockers})` : ''}  ` +
      `Σimpr=${s.sumImpressions}  Σtraffic=${Math.round(s.sumTraffic)}`
    );
  }
}

const BLOCKER_HINT: Record<ReplyMetricStatus, string> = {
  has_metrics: '',
  no_release_url: 'add the reply link: PATCH /engage/sent/:id/reply-url',
  no_integration: 'run integration backfill (default on)',
  no_release_id: 'reply URL has no /status/<id> — fix the link',
  syncable: 'ready — fetch returned nothing (X API tier / Reddit WAF / not run yet)',
};

function printMissing(missing: MissingItem[]): void {
  if (missing.length === 0) return;
  console.log(`\n── MISSING breakdown (${missing.length}) ──`);
  for (const m of missing) {
    console.log(
      `  [${m.platform.padEnd(6)}] ${m.status.padEnd(15)} ${m.url ?? '(no url)'}\n` +
      `           ↳ ${BLOCKER_HINT[m.status]}`
    );
  }
}

async function main(): Promise<void> {
  const args = parseArgs();

  console.log('=== Engage Sync Metrics (manual wake-up) ===\n');
  console.log(`Mode:     ${args.statsOnly ? 'STATS ONLY' : args.dryRun ? 'DRY RUN (no changes)' : 'EXECUTE'}`);
  console.log(`Org:      ${args.orgId ?? 'all'}`);
  console.log(`Platform: ${args.platform ?? 'all'}`);
  if (!args.statsOnly) console.log(`Backfill X integrationId: ${args.backfill ? 'yes' : 'no'}`);

  const prisma = new PrismaClient();

  const before = await collectStats(prisma, args.orgId, args.platform);
  printStats('BEFORE', before.stats);
  printMissing(before.missing);

  if (args.statsOnly) {
    await prisma.$disconnect();
    return;
  }

  // Bootstrap the real DI context so we reuse production sync logic verbatim.
  console.log('\nBootstrapping NestJS context...');
  const app = await NestFactory.createApplicationContext(ScriptModule, {
    logger: ['error', 'warn'],
  });
  const engageService = app.get(EngageService, { strict: false });
  const engageRepository = app.get(EngageRepository, { strict: false });

  // Step 1 — backfill X integrationId (resolve author/reply-account/any). Only
  // matters for X; Reddit metrics never need an integration.
  if (args.backfill && args.platform !== 'reddit') {
    const pendingX = await prisma.engageSentReply.findMany({
      where: {
        ...(args.orgId ? { organizationId: args.orgId } : {}),
        opportunity: { platform: 'x' },
        post: { source: 'engage', integrationId: null },
      },
      select: { organizationId: true, post: { select: { id: true, releaseURL: true } } },
    });
    let filled = 0, unresolved = 0;
    for (const r of pendingX) {
      if (!r.post) continue;
      const pick = await engageRepository.resolveXReplyIntegrationId(
        r.organizationId,
        r.post.releaseURL
      );
      if (!pick) { unresolved++; continue; }
      if (!args.dryRun) {
        await prisma.post.update({
          where: { id: r.post.id },
          data: { integrationId: pick.integrationId },
        });
      }
      filled++;
      console.log(
        `  backfill [${pick.matchedBy.padEnd(8)}] post=${r.post.id} -> integration=${pick.integrationId}`
      );
    }
    console.log(
      `Backfill: ${args.dryRun ? 'would fill' : 'filled'} ${filled}, ` +
      `unresolved (org has no X account) ${unresolved}`
    );
  }

  // Step 2 — re-fetch metrics for replies with null impressions (X + Reddit),
  // using the exact shared logic of the 24h Temporal sync.
  const result = await engageService.resyncEngageMetrics({
    orgId: args.orgId ?? undefined,
    platform: args.platform ?? undefined,
    dryRun: args.dryRun,
  });
  if (args.dryRun) {
    console.log(
      `\nResync: ${result.found} repl${result.found === 1 ? 'y' : 'ies'} with a fetchable link ` +
      `would be re-fetched (run with --execute).`
    );
  } else {
    console.log(
      `\nResync: found ${result.found}  →  written ${result.written}, empty ${result.empty}, ` +
      `unreachable ${result.unreachable}, skipped ${result.skipped}, errors ${result.errors}`
    );
    console.log(
      '  written=metrics landed; empty=API returned nothing (X tier block / deleted); ' +
      'unreachable=network/WAF; skipped=missing prerequisite.'
    );
  }

  await app.close();

  const after = await collectStats(prisma, args.orgId, args.platform);
  printStats(args.dryRun ? 'AFTER (unchanged — dry run)' : 'AFTER', after.stats);
  if (!args.dryRun) printMissing(after.missing);
  if (args.dryRun) {
    console.log('\n--- DRY RUN complete. Re-run with --execute to sync. ---');
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
