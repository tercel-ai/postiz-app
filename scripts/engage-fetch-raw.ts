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
import { redditPublicGet, clearRedditLoidCache } from '@gitroom/nestjs-libraries/engage/reddit-loid';
import { parseRedditCommentId } from '@gitroom/nestjs-libraries/engage/reddit-url';
import { parseXTweetId } from '@gitroom/nestjs-libraries/engage/x-tweet';

@Module({ imports: [DatabaseModule, getTemporalModule(false)] })
class ScriptModule {}

interface CliArgs {
  postId: string | null;
  sentReplyId: string | null;
  url: string | null;
  doReply: boolean;
  write: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const out: CliArgs = { postId: null, sentReplyId: null, url: null, doReply: true, write: false };
  const need = (i: number, flag: string): string => {
    const v = args[i];
    if (!v) { console.error(`${flag} requires a value`); process.exit(1); }
    return v;
  };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--post': out.postId = need(++i, '--post'); break;
      case '--reply': case '--id': out.sentReplyId = need(++i, '--reply'); break;
      case '--url': out.url = need(++i, '--url'); break;
      case '--no-reply': out.doReply = false; break;
      case '--write': out.write = true; break;
      case '--help':
        console.log(
          'Usage: engage-fetch-raw.ts (--post <id> | --reply <id> | --url <postUrl>) [--no-reply] [--write]\n' +
          '  --url tests the RAW platform interface directly — no DB, no Nest. Accepts a\n' +
          '        Reddit post/comment URL or an X status URL (also a t1_/t3_ fullname).'
        );
        process.exit(0);
        break;
      default:
        console.error(`Unknown argument: ${args[i]}`);
        process.exit(1);
    }
  }
  if (!out.postId && !out.sentReplyId && !out.url) {
    console.error('Specify --post <postId> | --reply <sentReplyId> | --url <postUrl>');
    process.exit(1);
  }
  return out;
}

/**
 * --url mode: hit the RAW platform interface for an arbitrary URL, no DB / no
 * NestJS. Reddit → /api/info for the comment (t1) and/or post (t3) in the URL;
 * X → singleTweet for the status id. Use it on the server to audit raw fields
 * when you have no matching local engage row.
 */
async function probeUrl(rawUrl: string): Promise<void> {
  console.log(`=== RAW interface probe (no DB) ===\n  url = ${rawUrl}\n`);

  // X status URL or tweet id.
  const tweetId = parseXTweetId(rawUrl);
  if (tweetId || /^\d{6,}$/.test(rawUrl.trim())) {
    const id = tweetId ?? rawUrl.trim();
    const client = await getAppOnlyXClient();
    if (client) await rawXTweet(client, id, 'tweet');
    return;
  }

  // Reddit fullname passed directly (t1_xxx / t3_xxx).
  const fullname = rawUrl.trim().match(/^(t[13]_[a-z0-9]+)$/i)?.[1];
  if (fullname) { await rawRedditInfo(fullname, fullname.startsWith('t1') ? 'comment' : 'post'); return; }

  // Reddit URL → derive subreddit, comment (t1) and/or post (t3) ids.
  const subreddit = rawUrl.match(/\/r\/([^/]+)\//)?.[1];
  const commentId = parseRedditCommentId(rawUrl);
  const threadId = rawUrl.match(/\/comments\/([a-z0-9]+)\b/)?.[1];
  if (commentId) {
    await rawRedditInfo(`t1_${commentId}`, 'REPLY comment (回帖)');
    // The "how many replied to us" count — the second fetch the workflow makes.
    if (subreddit && threadId) await rawRedditChildReplies(subreddit, threadId, commentId);
  }
  if (threadId) await rawRedditInfo(`t3_${threadId}`, 'ORIGINAL post (原帖)');
  if (!commentId && !threadId && !tweetId) {
    console.log('  ⚠ Unrecognized URL — expected a Reddit /comments/… link or an X /status/… link.');
  }
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
      'tweet.fields': ['text', 'public_metrics', 'created_at', 'author_id', 'conversation_id'],
    });
    if (tweet?.data) {
      if (tweet.data.text) {
        console.log(`\n  ▶ TWEET TEXT (推文内容):\n  ${tweet.data.text}`);
      }
      dump('  data', tweet.data);
    } else {
      console.log('  → No data returned (deleted / restricted / tier block).');
    }
    if (tweet?.errors) dump('  errors', tweet.errors);
  } catch (err: any) {
    if (err?.code === 429 || err?.rateLimit) {
      const rl = err?.rateLimit ?? {};
      const isQuota = typeof rl.remaining === 'number' && rl.remaining < 10;
      console.log(`  → 429 ${isQuota ? 'QUOTA EXHAUSTED' : '(access-level block — quota NOT exhausted, likely protected account / suspension / tier restriction)'}`);
      console.log(`     rateLimit = ${JSON.stringify(rl)}`);
    } else {
      console.log(`  → ERROR ${err?.code ?? ''}: ${err?.message || err}`);
      if (err?.data) dump('  err.data', err.data);
    }
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Raw Reddit /api/info read for a fullname (t1_<comment> or t3_<post>).
 * Dumps the FULL untouched response so you can audit every field Reddit returns
 * vs. what we extract (score / num_comments). Prefers the OAuth path (no WAF)
 * when REDDIT_CLIENT_ID/SECRET are set; otherwise the public loid path, retried
 * with a fresh loid on a 403/timeout (the Cloudflare WAF is intermittent).
 */
async function fetchRedditRaw(
  publicUrl: string,
  oauthUrl: string
): Promise<{ status: number; body: string; viaOAuth: boolean } | null> {
  const token = await getRedditToken();
  const url = token ? oauthUrl : publicUrl;
  console.log(`  ${token ? 'OAuth (no WAF)' : 'public (loid/WAF — flaky)'} GET ${url}`);
  const MAX = token ? 1 : 4;
  let body = '';
  let status = 0;
  for (let attempt = 1; attempt <= MAX; attempt++) {
    try {
      if (token) {
        const r = await fetch(url, { headers: redditAuthHeaders(token) });
        status = r.status; body = await r.text();
      } else {
        if (attempt > 1) await clearRedditLoidCache(); // re-mint loid between tries
        const r = await redditPublicGet(url, {}, { log: (m) => console.warn(`  ${m}`) });
        status = r.status; body = await r.text();
      }
    } catch (err: any) {
      console.log(`  attempt ${attempt}/${MAX} → ERROR: ${err?.message || err}`);
      if (attempt < MAX) { await sleep(1500); continue; }
      return null;
    }
    if (status >= 200 && status < 300) return { status, body, viaOAuth: !!token };
    console.log(`  attempt ${attempt}/${MAX} → HTTP ${status}${status === 403 ? ' (WAF block)' : ''}`);
    if (attempt < MAX) { await sleep(1500); continue; }
    console.log(`  body (first 300): ${body.slice(0, 300)}`);
    return null;
  }
  return null;
}

async function rawRedditInfo(fullname: string, what: string): Promise<void> {
  console.log(`\n── RAW Reddit ${what} (${fullname}) ──`);
  const res = await fetchRedditRaw(
    `https://www.reddit.com/api/info.json?id=${fullname}`,
    `https://oauth.reddit.com/api/info?id=${fullname}`
  );
  if (!res) return;
  console.log(`  → HTTP ${res.status} OK`);
  let json: any;
  try { json = JSON.parse(res.body); }
  catch { console.log(`  → non-JSON body (first 300): ${res.body.slice(0, 300)}`); return; }

  const data = json?.data?.children?.[0]?.data;
  if (!data) {
    console.log('  → empty Listing (deleted / not found). Full response:');
    dump('  raw', json);
    return;
  }
  // FULL field dump — every key Reddit returned for this thing.
  dump('  FULL thing.data', data);
  const kind: string = json.data.children[0].kind;
  console.log(`  thing.kind = ${kind}  (t1=comment, t3=post)`);
  console.log(`  field count = ${Object.keys(data).length}`);
  console.log(
    `  WE EXTRACT → score=${data.score}  num_comments=${data.num_comments ?? '(n/a — t1 comments come from the thread fetch)'}\n` +
    `  context     ups=${data.ups} downs=${data.downs} upvote_ratio=${data.upvote_ratio ?? '-'} ` +
    `removed=${data.removed ?? '?'} removed_by_category=${data.removed_by_category ?? '-'} ` +
    `locked=${data.locked ?? '-'} author=${data.author}`
  );
  // Highlight the actual post/comment content so it's easy to spot.
  if (kind === 't1' && data.body) {
    console.log(`\n  ▶ COMMENT BODY (回帖正文):\n${data.body.slice(0, 500)}${data.body.length > 500 ? '\n  …(truncated)' : ''}`);
  } else if (kind === 't3') {
    console.log(`\n  ▶ POST TITLE  (原帖标题): ${data.title ?? '(none)'}`);
    if (data.selftext) console.log(`  ▶ POST BODY   (原帖正文):\n${data.selftext.slice(0, 500)}${data.selftext.length > 500 ? '\n  …(truncated)' : ''}`);
    else console.log(`  ▶ POST BODY   (原帖正文): (empty — link post or removed)`);
  }
}

/**
 * "How many people replied to OUR comment?" — the answer /api/info CANNOT give
 * (it returns replies:""). This is the SECOND fetch syncRedditMetrics makes: the
 * comment-tree endpoint with ?comment=<id>&depth=1, whose `replies` Listing holds
 * the direct child comments. We count exactly as the workflow does:
 *   childReplies.filter(r => r.kind !== 'more').length
 * Note depth=1 loads direct replies; deeper / overflow replies appear as a `more`
 * node (count shown) and are intentionally NOT counted.
 */
/** Recursively count t1 descendants and flag any unexpanded "more" stubs. */
function countReplyTree(children: Array<{ kind?: string; data?: any }>): {
  direct: number;
  total: number;
  moreStubs: number;
  directNodes: Array<{ author?: string; score?: number; body?: string }>;
} {
  const directNodes = children
    .filter((c) => c.kind === 't1')
    .map((c) => ({ author: c.data?.author, score: c.data?.score, body: c.data?.body }));
  let total = 0;
  let moreStubs = 0;
  const walk = (nodes: Array<{ kind?: string; data?: any }>): void => {
    for (const n of nodes) {
      if (n.kind === 'more') { moreStubs++; continue; }
      if (n.kind !== 't1') continue;
      total++;
      const sub = n.data?.replies;
      if (sub && sub !== '' && sub.data?.children) walk(sub.data.children);
    }
  };
  walk(children);
  return { direct: directNodes.length, total, moreStubs, directNodes };
}

async function rawRedditChildReplies(
  subreddit: string,
  threadId: string,
  commentId: string
): Promise<void> {
  console.log(`\n── RAW Reddit CHILD REPLIES under t1_${commentId} (thread fetch — depth=10) ──`);
  // depth must be >= 2 to load the target comment's OWN replies: with comment=<id>
  // the comment is the root (level 1), so its direct replies live at level 2.
  // Production syncRedditMetrics uses depth=1 — which is why it under-counts to 0.
  const res = await fetchRedditRaw(
    `https://www.reddit.com/r/${subreddit}/comments/${threadId}/.json?comment=${commentId}&depth=10&limit=100`,
    `https://oauth.reddit.com/r/${subreddit}/comments/${threadId}?comment=${commentId}&depth=10&limit=100`
  );
  if (!res) return;
  let thread: any;
  try { thread = JSON.parse(res.body); }
  catch { console.log(`  → non-JSON body (first 300): ${res.body.slice(0, 300)}`); return; }

  const node = thread?.[1]?.data?.children?.[0]?.data;
  const repliesField = node?.replies;
  if (!repliesField || repliesField === '') {
    console.log('  → replies: "" — Reddit reports NO replies under this comment.');
    console.log('  DIRECT replies = 0');
    return;
  }
  const children: Array<{ kind?: string; data?: any }> = repliesField?.data?.children ?? [];
  const { direct, total, moreStubs, directNodes } = countReplyTree(children);
  directNodes.forEach((c, i) =>
    console.log(`    ${i + 1}. u/${c.author}  score=${c.score}  "${String(c.body ?? '').slice(0, 70).replace(/\s+/g, ' ')}"`)
  );
  console.log(`  DIRECT replies (people who replied to us): ${direct}`);
  console.log(`  TOTAL descendants (whole sub-thread): ${total}` + (moreStubs ? `  (${moreStubs} "more" stub(s) still unexpanded)` : ''));
  console.log(`  ⚠ production syncRedditMetrics uses depth=1 → it would count ${0} here (BUG: should be ${direct}).`);
}

async function main(): Promise<void> {
  const args = parseArgs();

  // --url mode: pure raw-interface probe, no DB / no NestJS. Returns early.
  if (args.url) {
    await probeUrl(args.url);
    console.log('\n=== Done ===');
    return;
  }

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
          state: true, source: true, content: true,
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
  console.log(`  post.content   = ${(post.content ?? '').slice(0, 200)}${(post.content ?? '').length > 200 ? '…' : ''}   (← 我们发出去的回帖文本)`);
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

  // ---- 2) RAW probe — dump untouched platform JSON for reply + original ------
  // For X the reply is already covered by Section 1's analytics; here we only
  // probe the original. For Reddit we dump BOTH the reply comment (t1) and the
  // original post (t3) raw, so you can audit every field vs. our extraction.
  console.log('\n\n########## 2) RAW JSON probe (audit every field) ##########');
  console.log('Original metrics have no shared by-id refetch — they refresh only when a re-scan re-surfaces the post.');
  console.log('This dumps the untouched platform response so you can verify what we extract.\n');

  if (opportunity.platform === 'x') {
    const originalTweetId = opportunity.externalPostId;
    const client = await getAppOnlyXClient();
    if (client && originalTweetId) await rawXTweet(client, originalTweetId, 'ORIGINAL (原帖)');
    else if (!originalTweetId) console.log('  ⚠ No opportunity.externalPostId.');
  } else if (opportunity.platform === 'reddit') {
    // Reply comment (t1) — the SAME object syncRedditMetrics reads for score/comments.
    const replyCommentId = parseRedditCommentId(post.releaseURL);
    const subreddit = (post.releaseURL || opportunity.externalPostUrl || '').match(/\/r\/([^/]+)\//)?.[1];
    const threadId =
      (post.releaseURL || opportunity.externalPostUrl || '').match(/\/comments\/([a-z0-9]+)\//)?.[1] ??
      opportunity.externalPostId?.replace(/^t3_/, '');
    if (replyCommentId) {
      await rawRedditInfo(`t1_${replyCommentId}`, 'REPLY comment (回帖)');
      if (subreddit && threadId) await rawRedditChildReplies(subreddit, threadId, replyCommentId);
    } else console.log('  ⚠ Could not parse reply comment id from releaseURL.');

    // Original post (t3).
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
