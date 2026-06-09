/**
 * Engage metrics — black-box opener / RAW fetch diagnostic.
 *
 * Goal: run the EXACT same code the Temporal sync runs, read-only, with every
 * internal warn/error surfaced — so "the script can't fetch it" === "the
 * workflow can't fetch it", and you see WHY.
 *
 * Given a Post id (our reply) — or an EngageSentReply id — it covers:
 *
 *   1. REPLY (回帖) — runs the SHARED workflow functions verbatim:
 *        syncXMetrics / syncRedditMetrics  (engage-metrics-sync.ts)
 *      with instrumented deps. These are the very functions
 *      EngageDataTicksActivity.syncEngageMetrics calls, so the outcome
 *      (written/empty/unreachable/skipped) and every warn line are identical
 *      to production. The X path goes own-token → app-only fallback via
 *      PostsService.checkEngageXAnalyticsWithFallback, exactly like the workflow.
 *
 *   2. ORIGINAL (原帖) — there is NO shared "fetch original by id" method. The
 *      original post's metrics live on EngageOpportunity and are refreshed ONLY
 *      when a re-scan's keyword search re-surfaces that same post (engage-scan
 *      .activity.ts → engageOpportunity.upsert `update: { metric* }`); they are
 *      never refetched by id, so a post that stops matching active keywords just
 *      stops updating (expected, not a bug). This section is therefore an
 *      INDEPENDENT raw probe reading the SAME fields (X public_metrics / Reddit
 *      score+num_comments) to check whether the original is still reachable
 *      (deleted / restricted / WAF) — not the scan's exact path.
 *
 * Read-only by default. The Reddit reply write-back is gated behind --write.
 * NOTE: the X reply path writes back fire-and-forget INSIDE
 * checkEngageXAnalyticsWithFallback (same as the workflow); it is idempotent.
 * Pass --no-reply to skip the reply path entirely (probe original only).
 *
 * Usage:
 *   npx ts-node --project scripts/tsconfig.json scripts/engage-fetch-raw.ts --post <postId>
 *   npx ts-node --project scripts/tsconfig.json scripts/engage-fetch-raw.ts --reply <sentReplyId>
 *   npx ts-node --project scripts/tsconfig.json scripts/engage-fetch-raw.ts --post <postId> --write
 *   npx ts-node --project scripts/tsconfig.json scripts/engage-fetch-raw.ts --post <postId> --no-reply
 */

import * as dotenv from 'dotenv';
dotenv.config();

process.env.NODE_ENV = process.env.NODE_ENV || 'production';
process.env.TZ = 'UTC';

import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { TwitterApi } from 'twitter-api-v2';
import { DatabaseModule } from '@gitroom/nestjs-libraries/database/prisma/database.module';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import { EngageRepository } from '@gitroom/nestjs-libraries/engage/engage.repository';
import { getTemporalModule } from '@gitroom/nestjs-libraries/temporal/temporal.module';
import {
  syncXMetrics,
  syncRedditMetrics,
  type MetricsSyncDeps,
  type MetricsSyncOutcome,
} from '@gitroom/nestjs-libraries/engage/engage-metrics-sync';
import { getRedditToken, redditAuthHeaders } from '@gitroom/nestjs-libraries/engage/reddit-auth';
import { redditPublicGet } from '@gitroom/nestjs-libraries/engage/reddit-loid';
import { parseRedditCommentId } from '@gitroom/nestjs-libraries/engage/reddit-url';
import { parseXTweetId } from '@gitroom/nestjs-libraries/engage/x-tweet';

@Module({ imports: [DatabaseModule, getTemporalModule(false)] })
class ScriptModule {}

interface CliArgs {
  postId: string | null;
  sentReplyId: string | null;
  doReply: boolean;
  write: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const out: CliArgs = { postId: null, sentReplyId: null, doReply: true, write: false };
  const need = (i: number, flag: string): string => {
    const v = args[i];
    if (!v) { console.error(`${flag} requires a value`); process.exit(1); }
    return v;
  };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--post': out.postId = need(++i, '--post'); break;
      case '--reply': case '--id': out.sentReplyId = need(++i, '--reply'); break;
      case '--no-reply': out.doReply = false; break;
      case '--write': out.write = true; break;
      case '--help':
        console.log('Usage: engage-fetch-raw.ts (--post <postId> | --reply <sentReplyId>) [--no-reply] [--write]');
        process.exit(0);
        break;
      default:
        console.error(`Unknown argument: ${args[i]}`);
        process.exit(1);
    }
  }
  if (!out.postId && !out.sentReplyId) {
    console.error('Specify --post <postId> or --reply <sentReplyId>');
    process.exit(1);
  }
  return out;
}

function dump(label: string, value: unknown): void {
  console.log(`${label}:`);
  console.log(JSON.stringify(value, null, 2));
}

/** Build an app-only X client (X_API_KEY/X_API_SECRET, else X_BEARER_TOKEN). */
async function getAppOnlyXClient(): Promise<TwitterApi | null> {
  const appKey = process.env.X_API_KEY;
  const appSecret = process.env.X_API_SECRET;
  if (appKey && appSecret) {
    try { return await new TwitterApi({ appKey, appSecret }).appLogin(); }
    catch (err: any) { console.warn(`  ⚠ appLogin failed: ${err?.message || err}`); }
  }
  if (process.env.X_BEARER_TOKEN) return new TwitterApi(process.env.X_BEARER_TOKEN);
  console.warn('  ⚠ No X_API_KEY/X_API_SECRET and no X_BEARER_TOKEN — cannot probe X original.');
  return null;
}

/** Raw X tweet read — dumps data + errors exactly as the X API returns them. */
async function rawXTweet(client: TwitterApi, tweetId: string, what: string): Promise<void> {
  console.log(`\n── RAW X ${what} (id=${tweetId}) ──`);
  try {
    const tweet = await client.v2.singleTweet(tweetId, {
      'tweet.fields': ['public_metrics', 'created_at', 'author_id', 'conversation_id'],
    });
    if (tweet?.data?.public_metrics) dump('  data', tweet.data);
    else console.log('  → No public_metrics (deleted / restricted / tier block).');
    if (tweet?.errors) dump('  errors', tweet.errors);
  } catch (err: any) {
    if (err?.code === 429 || err?.rateLimit) {
      console.log(`  → RATE-LIMITED (429). rateLimit=${JSON.stringify(err?.rateLimit ?? {})}`);
    } else {
      console.log(`  → ERROR ${err?.code ?? ''}: ${err?.message || err}`);
      if (err?.data) dump('  err.data', err.data);
    }
  }
}

/** Raw Reddit /api/info read for a fullname (t1_<comment> or t3_<post>). */
async function rawRedditInfo(fullname: string, what: string): Promise<void> {
  console.log(`\n── RAW Reddit ${what} (${fullname}) ──`);
  try {
    const token = await getRedditToken();
    const url = token
      ? `https://oauth.reddit.com/api/info?id=${fullname}`
      : `https://www.reddit.com/api/info.json?id=${fullname}`;
    console.log(`  ${token ? 'OAuth' : 'public(loid/WAF)'} GET ${url}`);
    const res = token
      ? await fetch(url, { headers: redditAuthHeaders(token) }).then((r) => ({
          ok: r.ok, status: r.status, text: () => r.text(),
        }))
      : await redditPublicGet(url, {}, { log: (m) => console.warn(`  ${m}`) });
    console.log(`  → HTTP ${res.status}`);
    const body = await res.text();
    if (!res.ok) { console.log(`  body: ${body.slice(0, 500)}`); return; }
    const json = JSON.parse(body);
    const data = json?.data?.children?.[0]?.data;
    if (!data) { console.log('  → empty (deleted / not found).'); return; }
    dump('  thing.data', data);
    console.log(
      `  KEY → score=${data.score} ups=${data.ups} num_comments=${data.num_comments ?? '(n/a for t1)'} ` +
      `removed=${data.removed ?? '?'} author=${data.author}`
    );
  } catch (err: any) {
    console.log(`  → ERROR: ${err?.message || err}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  const prisma = new PrismaClient();

  console.log('=== Engage RAW Fetch Diagnostic ===\n');

  const reply = await prisma.engageSentReply.findFirst({
    where: {
      ...(args.sentReplyId ? { id: args.sentReplyId } : {}),
      ...(args.postId ? { post: { id: args.postId } } : {}),
    },
    select: {
      id: true,
      organizationId: true,
      post: {
        select: {
          id: true, releaseId: true, releaseURL: true,
          impressions: true, trafficScore: true, integrationId: true,
          state: true, source: true,
        },
      },
      opportunity: {
        select: {
          platform: true, externalPostId: true, authorUsername: true,
          externalPostUrl: true,
          metricLikes: true, metricReplies: true, metricRetweets: true,
          metricQuotes: true, metricBookmarks: true,
          metricScore: true, metricComments: true,
        },
      },
    },
  });

  if (!reply || !reply.post) {
    console.error('No EngageSentReply found for that target (or it has no post).');
    await prisma.$disconnect();
    process.exit(1);
  }

  const { post, opportunity } = reply;
  console.log('DB context:');
  console.log(`  sentReplyId    = ${reply.id}`);
  console.log(`  orgId          = ${reply.organizationId}`);
  console.log(`  platform       = ${opportunity.platform}`);
  console.log(`  post.id        = ${post.id}`);
  console.log(`  post.state     = ${post.state}  source=${post.source}`);
  console.log(`  post.releaseId = ${post.releaseId ?? 'NULL'}`);
  console.log(`  post.releaseURL= ${post.releaseURL ?? 'NULL'}   (← 回帖 reply URL)`);
  console.log(`  integrationId  = ${post.integrationId ?? 'NULL'}`);
  console.log(`  stored(reply)  = impressions=${post.impressions ?? 'null'} trafficScore=${post.trafficScore ?? 'null'}`);
  console.log(`  opp.externalId = ${opportunity.externalPostId ?? 'NULL'}   (← 原帖 original id)`);
  console.log(`  opp.url        = ${opportunity.externalPostUrl ?? 'NULL'}`);
  console.log(`  opp.author     = ${opportunity.authorUsername ?? 'NULL'}`);
  console.log(
    `  stored(orig@scan) = likes=${opportunity.metricLikes ?? '-'} replies=${opportunity.metricReplies ?? '-'} ` +
    `rt=${opportunity.metricRetweets ?? '-'} quotes=${opportunity.metricQuotes ?? '-'} ` +
    `bm=${opportunity.metricBookmarks ?? '-'} score=${opportunity.metricScore ?? '-'} comments=${opportunity.metricComments ?? '-'}`
  );

  // ---- 1) REPLY (回帖): run the SHARED workflow functions verbatim ----------
  if (args.doReply) {
    console.log('\n\n########## 1) REPLY (回帖) — SHARED workflow code path ##########');
    console.log('Running the exact functions EngageDataTicksActivity.syncEngageMetrics calls.');
    console.log(`Write-back: ${args.write ? 'ENABLED' : 'DISABLED (Reddit); X path always writes fire-and-forget'}\n`);

    const app = await NestFactory.createApplicationContext(ScriptModule, {
      logger: ['error', 'warn'],
    });
    try {
      const postsService = app.get(PostsService);
      const engageRepo = app.get(EngageRepository);

      // Instrumented deps: identical wiring to EngageDataTicksActivity, but every
      // call is logged and write-back is gated. checkPostAnalytics is the REAL
      // checkEngageXAnalyticsWithFallback (own-token → app-only) — we wrap it only
      // to print the array it returns.
      const deps: MetricsSyncDeps = {
        updatePostMetrics: async (postId, impressions, analytics, trafficScore) => {
          console.log(`  [updatePostMetrics] impressions=${impressions} trafficScore=${trafficScore}`);
          dump('  [updatePostMetrics] analytics', analytics);
          if (args.write) return engageRepo.updatePostMetrics(postId, impressions, analytics, trafficScore);
          console.log('  [updatePostMetrics] (skipped write — pass --write to persist)');
          return undefined;
        },
        markAuthorReplied: async (sentReplyId) => {
          console.log(`  [markAuthorReplied] original author replied to ${sentReplyId}` +
            (args.write ? '' : ' (skipped write)'));
          if (args.write) return engageRepo.markAuthorReplied(sentReplyId);
          return undefined;
        },
        checkPostAnalytics: async (orgId, postId, when) => {
          const out = await postsService.checkEngageXAnalyticsWithFallback(orgId, postId, when);
          console.log(`  [checkEngageXAnalyticsWithFallback] returned ${Array.isArray(out) ? out.length : 0} metric(s)`);
          if (Array.isArray(out) && out.length) dump('  [X analytics]', out);
          return out;
        },
        warn: (m) => console.log(`  ⚠ WARN: ${m}`),
        log: (m) => console.log(`  · ${m}`),
      };

      let outcome: MetricsSyncOutcome = 'skipped';
      if (opportunity.platform === 'reddit' && post.releaseURL) {
        outcome = await syncRedditMetrics(
          post.id, post.releaseURL, reply.id, opportunity.authorUsername ?? '', deps
        );
      } else if (opportunity.platform === 'x' && post.releaseURL) {
        outcome = await syncXMetrics(
          {
            orgId: reply.organizationId,
            sentReplyId: reply.id,
            postDbId: post.id,
            replyTweetUrl: post.releaseURL,
            originalTweetId: opportunity.externalPostId ?? '',
            authorUsername: opportunity.authorUsername ?? '',
          },
          deps
        );
      } else {
        console.log('  ⚠ No releaseURL or unsupported platform — workflow would skip.');
      }
      console.log(`\n  ► OUTCOME: ${outcome}`);
      console.log('    written     = fetched & (would be) persisted');
      console.log('    empty       = platform returned no usable data (deleted / X-tier block / no bearer)');
      console.log('    unreachable = fetch failed (network / WAF / API error) — see WARN above');
      console.log('    skipped     = precondition missing (no comment/tweet id, no integration)');
    } finally {
      await app.close();
    }
  }

  // ---- 2) ORIGINAL (原帖): independent raw probe (no shared by-id method) ----
  console.log('\n\n########## 2) ORIGINAL (原帖) — independent raw probe ##########');
  console.log('No shared "fetch original by id" method — stored metrics refresh only when a re-scan re-surfaces this post.');
  console.log('This reads the SAME fields directly to check the original is still reachable.\n');

  if (opportunity.platform === 'x') {
    const originalTweetId = opportunity.externalPostId;
    const client = await getAppOnlyXClient();
    if (client && originalTweetId) await rawXTweet(client, originalTweetId, 'ORIGINAL (原帖)');
    else if (!originalTweetId) console.log('  ⚠ No opportunity.externalPostId.');
  } else if (opportunity.platform === 'reddit') {
    const threadId =
      (post.releaseURL || opportunity.externalPostUrl || '').match(/\/comments\/([a-z0-9]+)\//)?.[1] ??
      opportunity.externalPostId?.replace(/^t3_/, '');
    if (threadId) await rawRedditInfo(`t3_${threadId}`, 'ORIGINAL post (原帖)');
    else console.log('  ⚠ Could not determine original thread (t3) id.');
  }

  console.log('\n=== Done ===');
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
