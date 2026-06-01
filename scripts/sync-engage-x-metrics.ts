/**
 * Trigger a REAL X (Twitter) metrics fetch for published engage replies and
 * print the live breakdown (Replies / Retweets / Likes / Quotes / Bookmarks /
 * Impressions). Targets one reply by id/post/url, or scans by org.
 *
 * This calls the exact same path the 24h Temporal sync uses —
 * PostsService.checkPostAnalytics() — so it reads metrics through the
 * integration's own OAuth token and writes impressions/trafficScore/analytics
 * back onto the Post. Use it to test "can we actually read this tweet's stats?"
 * without waiting 24h. If the X API tier blocks analytics reads, you'll see the
 * error here (e.g. 429 / 403) instead of silent nulls.
 *
 * NOTE: For Reddit replies use scripts/sync-engage-metrics.ts — this one is X-only.
 *
 * Usage:
 *   npx ts-node --project scripts/tsconfig.json scripts/sync-engage-x-metrics.ts --org <orgId> --dry-run
 *   npx ts-node --project scripts/tsconfig.json scripts/sync-engage-x-metrics.ts --id <sentReplyId> --execute
 *   npx ts-node --project scripts/tsconfig.json scripts/sync-engage-x-metrics.ts --post <postId> --execute
 *   npx ts-node --project scripts/tsconfig.json scripts/sync-engage-x-metrics.ts --url https://x.com/.../status/123 --execute
 *   npx ts-node --project scripts/tsconfig.json scripts/sync-engage-x-metrics.ts --org <orgId> --only-missing --execute
 */

import * as dotenv from 'dotenv';
dotenv.config();

process.env.NODE_ENV = process.env.NODE_ENV || 'production';
process.env.TZ = 'UTC';

import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { DatabaseModule } from '@gitroom/nestjs-libraries/database/prisma/database.module';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import { getTemporalModule } from '@gitroom/nestjs-libraries/temporal/temporal.module';

@Module({ imports: [DatabaseModule, getTemporalModule(false)] })
class ScriptModule {}

interface CliArgs {
  sentReplyId: string | null;
  postId: string | null;
  url: string | null;
  orgId: string | null;
  onlyMissing: boolean;
  dryRun: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const out: CliArgs = {
    sentReplyId: null,
    postId: null,
    url: null,
    orgId: null,
    onlyMissing: false,
    dryRun: true,
  };

  const need = (i: number, flag: string): string => {
    const v = args[i];
    if (!v) { console.error(`${flag} requires a value`); process.exit(1); }
    return v;
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--id': out.sentReplyId = need(++i, '--id'); break;
      case '--post': out.postId = need(++i, '--post'); break;
      case '--url': out.url = need(++i, '--url'); break;
      case '--org': out.orgId = need(++i, '--org'); break;
      case '--only-missing': out.onlyMissing = true; break;
      case '--execute': out.dryRun = false; break;
      case '--dry-run': out.dryRun = true; break;
      case '--help': printHelp(); process.exit(0); break;
      default:
        console.error(`Unknown argument: ${args[i]}`);
        printHelp();
        process.exit(1);
    }
  }

  if (!out.sentReplyId && !out.postId && !out.url && !out.orgId) {
    console.error('Specify at least one target: --id | --post | --url | --org\n');
    printHelp();
    process.exit(1);
  }

  return out;
}

function printHelp(): void {
  console.log(`
Usage: npx ts-node --project scripts/tsconfig.json scripts/sync-engage-x-metrics.ts [target] [options]

Target (at least one required):
  --id <sentReplyId>   A specific EngageSentReply id
  --post <postId>      A specific Post id
  --url <releaseURL>   Match by the reply tweet URL (substring)
  --org <orgId>        All X engage replies in an org

Options:
  --only-missing       Only replies whose Post.impressions is still null
  --dry-run            List matched targets without calling the X API (default)
  --execute            Actually fetch live metrics and write them back
  --help               Show this help

Examples:
  ... sync-engage-x-metrics.ts --id 4832ec52-100c-489e-8998-3fed095b1d1b --execute
  ... sync-engage-x-metrics.ts --org f2a8105f-5871-4e88-ab68-dc4a58f05f62 --only-missing --execute
`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Pull the latest "total" out of an AnalyticsData entry for printing. */
function latestTotal(entry: { data?: Array<{ total?: string | number }> }): string {
  const d = entry.data ?? [];
  const last = d[d.length - 1];
  return last?.total != null ? String(last.total) : '—';
}

async function main(): Promise<void> {
  const args = parseArgs();

  console.log('=== Engage X Metrics — Live Fetch ===\n');
  console.log(`Mode:        ${args.dryRun ? 'DRY RUN (no API calls)' : 'EXECUTE (live X API + write-back)'}`);
  console.log(`Target:      ${args.sentReplyId ? `id=${args.sentReplyId}` : args.postId ? `post=${args.postId}` : args.url ? `url~=${args.url}` : `org=${args.orgId}`}`);
  console.log(`Only-missing: ${args.onlyMissing}\n`);

  const prisma = new PrismaClient();

  const targets = await prisma.engageSentReply.findMany({
    where: {
      ...(args.sentReplyId ? { id: args.sentReplyId } : {}),
      ...(args.orgId ? { organizationId: args.orgId } : {}),
      // X-only; published with a release URL so there is something to read.
      opportunity: { platform: 'x' },
      post: {
        source: 'engage',
        state: 'PUBLISHED',
        releaseURL: { not: null },
        ...(args.postId ? { id: args.postId } : {}),
        ...(args.url ? { releaseURL: { contains: args.url } } : {}),
        ...(args.onlyMissing ? { impressions: null } : {}),
      },
    },
    select: {
      id: true,
      organizationId: true,
      post: {
        select: {
          id: true,
          releaseId: true,
          releaseURL: true,
          impressions: true,
          trafficScore: true,
          integrationId: true,
        },
      },
    },
  });

  console.log(`Matched ${targets.length} X engage repl${targets.length === 1 ? 'y' : 'ies'}.\n`);

  for (const t of targets) {
    const p = t.post;
    const flags: string[] = [];
    if (!p?.releaseId) flags.push('NO releaseId (checkPostAnalytics will no-op)');
    if (!p?.integrationId) flags.push('NO integrationId (cannot read analytics)');
    console.log(
      `  sentReplyId=${t.id}\n    postId=${p?.id}  releaseId=${p?.releaseId ?? 'null'}  ` +
      `integrationId=${p?.integrationId ?? 'null'}\n    url=${p?.releaseURL}\n    ` +
      `current: impressions=${p?.impressions ?? 'null'} trafficScore=${p?.trafficScore ?? 'null'}` +
      (flags.length ? `\n    ⚠ ${flags.join('; ')}` : '')
    );
  }

  if (args.dryRun) {
    console.log('\n--- DRY RUN complete. Re-run with --execute to fetch live metrics. ---');
    await prisma.$disconnect();
    return;
  }

  console.log('\nBootstrapping NestJS context...\n');
  const app = await NestFactory.createApplicationContext(ScriptModule, {
    logger: ['error', 'warn'],
  });
  const postsService = app.get(PostsService);

  let ok = 0;
  let empty = 0;
  let errored = 0;

  for (const t of targets) {
    const postId = t.post?.id;
    if (!postId) continue;
    console.log(`\n── ${t.id} (post ${postId}) ──`);

    try {
      // Same call as the 24h Temporal sync. Date.now() also keys the 5-min
      // Redis cache, so each run fetches fresh.
      const analytics = await postsService.checkPostAnalytics(
        t.organizationId,
        postId,
        Date.now()
      );

      if (!analytics || analytics.length === 0) {
        empty++;
        console.log(
          '  → No analytics returned. Likely causes: missing releaseId/integration, ' +
          'token refresh failed, or the X API tier blocks analytics reads ' +
          '(check backend logs for the provider error).'
        );
        continue;
      }

      ok++;
      console.log('  Live metrics from X:');
      for (const entry of analytics as Array<{ label: string; data?: any[] }>) {
        console.log(`    ${String(entry.label).padEnd(14)} ${latestTotal(entry)}`);
      }

      // Write-back is fire-and-forget inside checkPostAnalytics; give it a beat
      // then re-read to confirm it landed on the Post.
      await sleep(1500);
      const after = await prisma.post.findUnique({
        where: { id: postId },
        select: { impressions: true, trafficScore: true, analytics: true },
      });
      console.log(
        `  Written back → impressions=${after?.impressions ?? 'null'} ` +
        `trafficScore=${after?.trafficScore ?? 'null'} ` +
        `analytics=${after?.analytics ? 'set' : 'null'}`
      );
    } catch (err: any) {
      errored++;
      if (err?.code === 429 || err?.rateLimit) {
        console.log(`  → RATE-LIMITED (429). X API tier / quota exhausted. rateLimit=${JSON.stringify(err?.rateLimit ?? {})}`);
      } else {
        console.log(`  → ERROR: ${err?.message || err}`);
      }
    }
  }

  console.log(`\nDone: ${ok} fetched, ${empty} empty, ${errored} error(s).`);

  await app.close();
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
