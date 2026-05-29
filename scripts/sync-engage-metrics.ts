/**
 * Re-fetch Reddit/X metrics for published engage replies that have null impressions.
 *
 * Calls the same logic as POST /engage/admin/resync-metrics.
 * Safe to run repeatedly — upserts impressions/analytics on each run.
 *
 * Usage:
 *   npx ts-node --project scripts/tsconfig.json scripts/sync-engage-metrics.ts --dry-run
 *   npx ts-node --project scripts/tsconfig.json scripts/sync-engage-metrics.ts --execute
 *   npx ts-node --project scripts/tsconfig.json scripts/sync-engage-metrics.ts --platform reddit --execute
 *   npx ts-node --project scripts/tsconfig.json scripts/sync-engage-metrics.ts --org <orgId> --execute
 */

import * as dotenv from 'dotenv';
dotenv.config();

process.env.NODE_ENV = process.env.NODE_ENV || 'production';
process.env.TZ = 'UTC';

import { PrismaClient } from '@prisma/client';

// getRedditToken / redditAuthHeaders are plain functions — no NestJS DI needed
import { getRedditToken, redditAuthHeaders } from '@gitroom/nestjs-libraries/engage/reddit-auth';

interface CliArgs {
  orgId: string | null;
  platform: string | null;
  dryRun: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let orgId: string | null = null;
  let platform: string | null = null;
  let dryRun = true;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--org':
        orgId = args[++i] ?? null;
        if (!orgId) { console.error('--org requires a value'); process.exit(1); }
        break;
      case '--platform':
        platform = args[++i] ?? null;
        if (!platform) { console.error('--platform requires a value (reddit|x)'); process.exit(1); }
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

  return { orgId, platform, dryRun };
}

function printHelp(): void {
  console.log(`
Usage: npx ts-node --project scripts/tsconfig.json scripts/sync-engage-metrics.ts [options]

Options:
  --org <orgId>       Only resync a specific organization
  --platform <name>   Filter by platform: reddit | x
  --dry-run           Show what would be synced without making changes (default)
  --execute           Actually perform the sync
  --help              Show this help message

Examples:
  npx ts-node --project scripts/tsconfig.json scripts/sync-engage-metrics.ts --dry-run
  npx ts-node --project scripts/tsconfig.json scripts/sync-engage-metrics.ts --execute
  npx ts-node --project scripts/tsconfig.json scripts/sync-engage-metrics.ts --platform reddit --execute
  npx ts-node --project scripts/tsconfig.json scripts/sync-engage-metrics.ts --org f2a8105f-5871-4e88-ab68-dc4a58f05f62 --execute
`);
}

function extractRedditCommentId(url: string): string | null {
  return url.match(/\/comments\/[^/]+\/[^/]+\/([a-z0-9]+)\/?/)?.[1] ?? null;
}

async function syncRedditMetrics(
  prisma: PrismaClient,
  postId: string,
  releaseURL: string,
  sentReplyId: string,
  authorUsername: string
): Promise<'updated' | 'skipped' | 'error'> {
  const commentId = extractRedditCommentId(releaseURL);
  if (!commentId) return 'skipped';

  try {
    const token = await getRedditToken();
    const infoUrl = token
      ? `https://oauth.reddit.com/api/info?id=t1_${commentId}`
      : `https://www.reddit.com/api/info.json?id=t1_${commentId}`;
    const infoHeaders = token ? redditAuthHeaders(token) : { 'User-Agent': 'AISEE-Engage/1.0' };

    const infoRes = await fetch(infoUrl, { headers: infoHeaders });
    if (!infoRes.ok) {
      const body = await infoRes.text().catch(() => '');
      console.warn(`  Reddit API ${infoRes.status} for t1_${commentId}: ${body.slice(0, 120)}`);
      return 'error';
    }

    const infoJson = (await infoRes.json()) as {
      data?: { children?: Array<{ data: { score: number; num_comments: number } }> };
    };
    const commentData = infoJson.data?.children?.[0]?.data;
    if (!commentData) {
      console.warn(`  Reddit: no data for t1_${commentId} (deleted?)`);
      return 'skipped';
    }

    const today = new Date().toISOString().slice(0, 10);
    const analytics = [
      { label: 'score', data: [{ total: String(commentData.score), date: today }], percentageChange: 0 },
      { label: 'comments', data: [{ total: String(commentData.num_comments), date: today }], percentageChange: 0 },
    ];

    await prisma.post.update({
      where: { id: postId },
      data: {
        impressions: Math.round((commentData.score + commentData.num_comments) * 20),
        analytics: analytics as never,
      },
    });

    // Check if original author replied
    const threadMatch = releaseURL.match(/\/r\/([^/]+)\/comments\/([a-z0-9]+)\//);
    if (threadMatch && authorUsername) {
      const [, subreddit, postId_] = threadMatch;
      const threadToken = await getRedditToken();
      const threadUrl = threadToken
        ? `https://oauth.reddit.com/r/${subreddit}/comments/${postId_}?comment=${commentId}&depth=1&limit=25`
        : `https://www.reddit.com/r/${subreddit}/comments/${postId_}/.json?comment=${commentId}&depth=1&limit=25`;
      const threadRes = await fetch(threadUrl, {
        headers: threadToken ? redditAuthHeaders(threadToken) : { 'User-Agent': 'AISEE-Engage/1.0' },
      });
      if (threadRes.ok) {
        const threadJson = (await threadRes.json()) as Array<{
          data?: { children?: Array<{ data?: { replies?: { data?: { children?: Array<{ data?: { author?: string } }> } } } }> };
        }>;
        const childReplies = threadJson[1]?.data?.children?.[0]?.data?.replies?.data?.children ?? [];
        if (childReplies.some((r) => r.data?.author === authorUsername)) {
          await prisma.engageSentReply.update({ where: { id: sentReplyId }, data: { authorReplied: true } });
        }
      }
    }

    return 'updated';
  } catch (err) {
    console.warn(`  Reddit sync error: ${(err as Error).message}`);
    return 'error';
  }
}

async function checkXAuthorReplied(
  prisma: PrismaClient,
  sentReplyId: string,
  replyTweetUrl: string,
  originalTweetId: string,
  authorUsername: string
): Promise<'updated' | 'skipped' | 'error'> {
  const bearerToken = process.env.X_BEARER_TOKEN;
  if (!bearerToken) { console.warn('  X_BEARER_TOKEN not set, skipping X check'); return 'skipped'; }

  const replyTweetId = replyTweetUrl.match(/\/status\/(\d+)/)?.[1];
  if (!replyTweetId) return 'skipped';

  try {
    const authorRes = await fetch(`https://api.twitter.com/2/users/by/username/${authorUsername}`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    if (!authorRes.ok) return 'error';
    const authorJson = (await authorRes.json()) as { data?: { id: string } };
    const originalAuthorId = authorJson.data?.id;
    if (!originalAuthorId) return 'skipped';

    const res = await fetch(
      `https://api.twitter.com/2/tweets/search/recent?query=conversation_id:${originalTweetId}&tweet.fields=author_id&max_results=50`,
      { headers: { Authorization: `Bearer ${bearerToken}` } }
    );
    if (!res.ok) return 'error';
    const json = (await res.json()) as { data?: Array<{ id: string; author_id: string }> };
    if ((json.data ?? []).some((t) => t.author_id === originalAuthorId && BigInt(t.id) > BigInt(replyTweetId))) {
      await prisma.engageSentReply.update({ where: { id: sentReplyId }, data: { authorReplied: true } });
      return 'updated';
    }
    return 'skipped';
  } catch (err) {
    console.warn(`  X sync error: ${(err as Error).message}`);
    return 'error';
  }
}

async function main(): Promise<void> {
  const args = parseArgs();

  console.log('=== Engage Metrics Resync Script ===\n');
  console.log(`Mode:     ${args.dryRun ? 'DRY RUN (no changes)' : 'EXECUTE'}`);
  console.log(`Org:      ${args.orgId ?? 'all'}`);
  console.log(`Platform: ${args.platform ?? 'all'}\n`);

  const prisma = new PrismaClient();

  const pending = await prisma.engageSentReply.findMany({
    where: {
      ...(args.orgId ? { organizationId: args.orgId } : {}),
      post: { source: 'engage', state: 'PUBLISHED', releaseURL: { not: null }, impressions: null },
      ...(args.platform ? { opportunity: { platform: args.platform } } : {}),
    },
    select: {
      id: true,
      authorReplied: true,
      post: { select: { id: true, releaseURL: true } },
      opportunity: { select: { platform: true, externalPostId: true, authorUsername: true } },
    },
  });

  console.log(`Found ${pending.length} published engage replies with missing metrics.\n`);

  if (args.dryRun) {
    for (const r of pending) {
      console.log(`  [${r.opportunity.platform.padEnd(6)}] sentReplyId=${r.id}  postId=${r.post?.id}  url=${r.post?.releaseURL?.slice(0, 60)}...`);
    }
    console.log('\n--- DRY RUN complete. Run with --execute to sync. ---');
    await prisma.$disconnect();
    return;
  }

  let updated = 0;
  let skipped = 0;
  let errors = 0;

  for (const reply of pending) {
    const platform = reply.opportunity.platform;
    const label = `sentReplyId=${reply.id}`;
    process.stdout.write(`  [${platform.padEnd(6)}] ${label} ... `);

    let result: 'updated' | 'skipped' | 'error';

    if (platform === 'reddit' && reply.post?.releaseURL) {
      result = await syncRedditMetrics(
        prisma,
        reply.post.id,
        reply.post.releaseURL,
        reply.id,
        reply.opportunity.authorUsername ?? ''
      );
    } else if (platform === 'x' && reply.post?.releaseURL) {
      result = await checkXAuthorReplied(
        prisma,
        reply.id,
        reply.post.releaseURL,
        reply.opportunity.externalPostId ?? '',
        reply.opportunity.authorUsername ?? ''
      );
    } else {
      result = 'skipped';
    }

    console.log(result);
    if (result === 'updated') updated++;
    else if (result === 'skipped') skipped++;
    else errors++;
  }

  console.log(`\nDone: ${updated} updated, ${skipped} skipped, ${errors} error(s).`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
