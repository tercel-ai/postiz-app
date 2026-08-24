/**
 * Manually ingest a single X (Twitter) post into the engage opportunity pool for a
 * given org, so you can walk the full reply/send flow through the UI without waiting
 * for a scan to surface it.
 *
 * Mirrors the scan's two-phase persist (engage-scan.activity.ts:_persistOpportunities):
 *   phase 1 — upsert the global EngageOpportunity row (content + objective metrics)
 *   phase 2 — upsert this org's EngageOpportunityState (status + score)
 * Bypasses the keyword filter and MIN_SCORE threshold so the post always lands.
 *
 * Usage:
 *   npx ts-node --project scripts/tsconfig.json scripts/ingest-engage-post.ts \
 *     --url=https://x.com/user/status/123 --org=<orgId>
 *
 *   # Optional: override the per-org score / starting status
 *   npx ts-node --project scripts/tsconfig.json scripts/ingest-engage-post.ts \
 *     --url=... --org=<orgId> --score=90 --status=NEW
 *
 * Requires in .env: DATABASE_URL, and X_BEARER_TOKEN (or X_API_KEY + X_API_SECRET).
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { PrismaClient, EngageOpportunityStatus } from '@prisma/client';
import { expandXTweetText } from '@gitroom/nestjs-libraries/engage/scan/x-scan-adapter';

interface CliArgs {
  url: string;
  orgId: string;
  score: number;
  status: EngageOpportunityStatus;
}

function parseArgs(): CliArgs {
  const get = (flag: string) =>
    process.argv.find((a) => a.startsWith(`${flag}=`))?.split('=').slice(1).join('=') ?? null;
  const url = get('--url');
  const orgId = get('--org');
  if (!url || !orgId) {
    console.error('Usage: --url=<tweetUrl> --org=<orgId> [--score=70] [--status=NEW]');
    process.exit(1);
  }
  const status = (get('--status') ?? 'NEW') as EngageOpportunityStatus;
  return { url, orgId, score: Number(get('--score') ?? 70), status };
}

async function getBearerToken(): Promise<string> {
  const token = process.env.X_BEARER_TOKEN;
  if (token) return token;
  const key = process.env.X_API_KEY;
  const secret = process.env.X_API_SECRET;
  if (!key || !secret) throw new Error('Set X_BEARER_TOKEN or both X_API_KEY and X_API_SECRET in .env');
  const credentials = Buffer.from(`${encodeURIComponent(key)}:${encodeURIComponent(secret)}`).toString('base64');
  const res = await fetch('https://api.twitter.com/oauth2/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`Failed to get Bearer Token (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error('No access_token in X OAuth2 response');
  return json.access_token;
}

interface XTweet {
  id: string;
  text: string;
  created_at: string;
  author_id: string;
  reply_settings?: string;
  referenced_tweets?: Array<{ type: string; id: string }>;
  // entities carries each t.co's real destination; note_tweet the untruncated
  // body of a >280-char tweet. Both are required to store the body the way
  // x.com displays it rather than X's wire format.
  entities?: Record<string, unknown>;
  note_tweet?: { text?: string; entities?: Record<string, unknown> };
  attachments?: { media_keys?: string[] };
  public_metrics?: {
    like_count: number;
    reply_count: number;
    retweet_count: number;
    quote_count: number;
    bookmark_count: number;
    impression_count: number;
  };
}
interface XUser {
  id: string;
  username: string;
  name: string;
  profile_image_url?: string;
  public_metrics?: { followers_count: number };
}

interface XMedia {
  media_key?: string;
  type?: string;
  url?: string;
  variants?: Array<{ content_type?: string; bit_rate?: number; url?: string }>;
}

/**
 * Attachment URLs for one tweet: a photo's `url`, or the highest-bitrate MP4 for
 * a video/GIF. The body cannot carry these — it only ever held a t.co
 * placeholder, which the normalisation below strips.
 */
function mediaUrlsFor(tweet: XTweet, media: XMedia[]): string[] {
  const byKey = new Map(media.filter((m) => m.media_key).map((m) => [m.media_key!, m]));
  const urls: string[] = [];
  for (const key of tweet.attachments?.media_keys ?? []) {
    const m = byKey.get(key);
    if (!m) continue;
    if (m.type === 'video' || m.type === 'animated_gif') {
      const best = (m.variants ?? [])
        .filter((v) => v?.content_type === 'video/mp4' && typeof v?.url === 'string')
        .sort((a, b) => (Number(b?.bit_rate) || 0) - (Number(a?.bit_rate) || 0))[0]?.url;
      if (best) urls.push(best);
      continue;
    }
    if (typeof m.url === 'string' && m.url) urls.push(m.url);
  }
  return Array.from(new Set(urls));
}

async function fetchTweet(
  tweetId: string,
  bearer: string
): Promise<{ tweet: XTweet; author?: XUser; media: XMedia[] }> {
  const params = new URLSearchParams({
    ids: tweetId,
    'tweet.fields':
      'public_metrics,author_id,created_at,text,reply_settings,referenced_tweets,entities,note_tweet,attachments',
    'user.fields': 'public_metrics,name,username,profile_image_url',
    'media.fields': 'url,variants,type',
    expansions: 'author_id,attachments.media_keys',
  });
  const res = await fetch(`https://api.twitter.com/2/tweets?${params}`, {
    headers: { Authorization: `Bearer ${bearer}` },
  });
  if (!res.ok) throw new Error(`X API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as {
    data?: XTweet[];
    includes?: { users?: XUser[]; media?: XMedia[] };
    errors?: Array<{ detail?: string; title?: string }>;
  };
  const tweet = json.data?.[0];
  if (!tweet) {
    const reason = json.errors?.map((e) => e.detail ?? e.title).join('; ') ?? 'not found';
    throw new Error(`Tweet ${tweetId} not retrievable: ${reason}`);
  }
  const author = json.includes?.users?.find((u) => u.id === tweet.author_id);
  return { tweet, author, media: json.includes?.media ?? [] };
}

async function main() {
  const args = parseArgs();

  const platform = /reddit\.com/i.test(args.url) ? 'reddit' : 'x';
  if (platform !== 'x') {
    console.error('Only X (Twitter) URLs are supported by this script for now.');
    process.exit(1);
  }
  const m = args.url.match(/status(?:es)?\/(\d+)/);
  if (!m) {
    console.error(`Could not extract a tweet ID from URL: ${args.url}`);
    process.exit(1);
  }
  const tweetId = m[1];

  const prisma = new PrismaClient();
  try {
    // Verify the org exists so we fail loudly rather than orphan a state row.
    const org = await prisma.organization.findUnique({ where: { id: args.orgId }, select: { id: true } });
    if (!org) {
      console.error(`Organization ${args.orgId} not found.`);
      process.exit(1);
    }

    const bearer = await getBearerToken();
    const { tweet, author, media } = await fetchTweet(tweetId, bearer);

    const retweetOf = tweet.referenced_tweets?.find((r) => r.type === 'retweeted');
    if (retweetOf) {
      console.warn(`⚠ This is a RETWEET of ${retweetOf.id}. X does not allow replying to retweets via API — the send step will fail.`);
    }
    if (tweet.reply_settings && tweet.reply_settings !== 'everyone') {
      console.warn(`⚠ reply_settings=${tweet.reply_settings} — replies are restricted; the send step may fail.`);
    }

    const pm = tweet.public_metrics;
    const externalPostUrl = `https://x.com/${author?.username ?? 'i'}/status/${tweet.id}`;

    // Store the body the way x.com displays it, not X's wire format: t.co
    // shortlinks resolved, the attachment placeholder stripped, HTML entities
    // decoded. Calls the scanner's own normaliser so a row ingested here is
    // identical to one a scan would have produced.
    const postContent = expandXTweetText(
      tweet.note_tweet?.text ?? tweet.text,
      tweet.entities,
      tweet.note_tweet?.entities
    );
    // The attachment URLs the body no longer mentions. Archived alongside the
    // raw payload under the key the API derives `mediaUrls` from.
    const mediaUrls = mediaUrlsFor(tweet, media);

    // Phase 1 — global opportunity row.
    const opp = await prisma.engageOpportunity.upsert({
      where: { platform_externalPostId: { platform: 'x', externalPostId: tweet.id } },
      create: {
        platform: 'x',
        externalPostId: tweet.id,
        externalPostUrl,
        authorUsername: author?.username ?? tweet.author_id,
        authorDisplayName: author?.name ?? null,
        authorFollowers: author?.public_metrics?.followers_count ?? null,
        authorAvatarUrl: author?.profile_image_url?.replace('_normal', '_400x400') ?? null,
        postContent,
        postPublishedAt: new Date(tweet.created_at),
        scoreHeat: 0,
        scoreAuthority: 0,
        scoreRecency: 0,
        intentTags: [],
        primaryIntent: 'discussion',
        intentScore: 0,
        metricLikes: pm?.like_count ?? 0,
        metricReplies: pm?.reply_count ?? 0,
        metricRetweets: pm?.retweet_count ?? 0,
        metricQuotes: pm?.quote_count ?? 0,
        metricBookmarks: pm?.bookmark_count ?? 0,
        metricViews: pm?.impression_count ?? 0,
        metricScore: 0,
        metricComments: 0,
        rawData: { tweet, author, mediaUrls } as object,
      },
      update: {
        // Re-ingesting is an explicit "fetch this post again", so the body and
        // its attachments are refreshed too — that is what repairs a row stored
        // by an older build with t.co links still in it. Classification/state
        // stay untouched.
        postContent,
        rawData: { tweet, author, mediaUrls } as object,
        // Refresh metrics on re-ingest; leave classification/state untouched.
        metricLikes: pm?.like_count ?? 0,
        metricReplies: pm?.reply_count ?? 0,
        metricRetweets: pm?.retweet_count ?? 0,
        metricQuotes: pm?.quote_count ?? 0,
        metricBookmarks: pm?.bookmark_count ?? 0,
        metricViews: pm?.impression_count ?? 0,
      },
      select: { id: true },
    });

    // Phase 2 — per-org state. The row is identified by
    // (organizationId, projectId, opportunityId), and this script ingests with
    // projectId = null. A compound unique cannot match on a NULL column in
    // Postgres, so the upsert has to be findFirst + create/update — the same
    // shape EngageScanIngestService._upsertOpportunityState uses. (The previous
    // `organizationId_opportunityId` key does not exist and failed at runtime.)
    const existingState = await prisma.engageOpportunityState.findFirst({
      where: { organizationId: args.orgId, projectId: null, opportunityId: opp.id },
      select: { id: true },
    });
    if (existingState) {
      await prisma.engageOpportunityState.update({
        where: { id: existingState.id },
        data: { status: args.status, score: args.score },
      });
    } else {
      await prisma.engageOpportunityState.create({
        data: {
          organizationId: args.orgId,
          projectId: null,
          opportunityId: opp.id,
          status: args.status,
          score: args.score,
          scoreKeyword: 0,
          scoreTracked: 0,
        },
      });
    }

    console.log('\n✓ Ingested.');
    console.log(`  opportunityId: ${opp.id}`);
    console.log(`  org:           ${args.orgId}`);
    console.log(`  author:        @${author?.username} (${author?.name})`);
    console.log(`  status:        ${args.status}   score: ${args.score}`);
    console.log(`  url:           ${externalPostUrl}`);
    console.log('\nIt should now appear in the engage UI for this org. (status NEW = in the main list.)');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
