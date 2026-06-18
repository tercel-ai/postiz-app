// X scan executor via internal GraphQL SearchTimeline (Latest tab) using the
// user's session. Mirrors the backend XScanAdapter's intent:
//   keyword scope  → search the firehose for the keyword
//   tracked scope  → `from:<username>` restricted search
//   (no channel scope — X has no community concept here)
// Incremental: SearchTimeline returns newest-first; we page via the bottom
// cursor up to pacing.maxPages and stop once a tweet is not newer than the
// cursor's lastSeenExternalId (since_id semantics).

import {
  EngageScanTask,
  ScanIngestPost,
  ScanRunResult,
  ScanTaskCursor,
} from './executor.types';
import { applyDelay } from './pacing';
import { xGraphqlGet, X_SEARCH_FEATURES } from './x.graphql';
import { parseTweetResult, newerId, isNewerThan } from './x.parse';

// Page size comes from server pacing (task.pacing.pageSize, admin-tunable). X's
// SearchTimeline serves ~20 per page for a real browsing session; this is the
// fallback if the server omits it (old build).
const X_COUNT_FALLBACK = 20;

function buildRawQuery(task: EngageScanTask): string {
  if (task.scanType === 'tracked') {
    // The account's own posts (original/quote/reply), not what it retweeted.
    return `from:${task.scanKey} -filter:retweets`;
  }
  return task.scanKey; // keyword firehose
}

interface SearchEntry {
  entryId?: string;
  content?: any;
}

/** Pull tweet result nodes + the bottom cursor from a SearchTimeline payload. */
function readPage(data: any): { results: any[]; bottomCursor?: string } {
  const instructions =
    data?.search_by_raw_query?.search_timeline?.timeline?.instructions ?? [];
  const results: any[] = [];
  let bottomCursor: string | undefined;
  for (const instr of instructions) {
    const entries: SearchEntry[] = instr?.entries ?? [];
    for (const entry of entries) {
      const id = entry.entryId ?? '';
      if (id.startsWith('tweet-')) {
        const result = entry.content?.itemContent?.tweet_results?.result;
        if (result) results.push(result);
      } else if (id.startsWith('cursor-bottom-')) {
        bottomCursor = entry.content?.value;
      }
    }
  }
  return { results, bottomCursor };
}

function toIngestPost(
  t: NonNullable<ReturnType<typeof parseTweetResult>>
): ScanIngestPost {
  return {
    platform: 'x',
    externalPostId: t.id,
    externalPostUrl: `https://x.com/${t.authorUsername || 'i'}/status/${t.id}`,
    authorUsername: t.authorUsername || '',
    authorDisplayName: t.authorDisplayName,
    authorAvatarUrl: t.authorAvatarUrl,
    authorFollowers: t.authorFollowers,
    postContent: t.text,
    postPublishedAt: t.createdAt,
    metricLikes: t.likes,
    metricReplies: t.replies,
    metricRetweets: t.retweets,
    metricQuotes: t.quotes,
    metricBookmarks: t.bookmarks,
    metricViews: t.views,
  };
}

/**
 * Scan one X unit. `gate` consumes one hourly-budget token per page fetch and
 * returns false when the cap is hit (the scan stops, backlog remains).
 */
export async function scanX(
  task: EngageScanTask,
  gate: () => Promise<boolean>
): Promise<ScanRunResult> {
  const { pacing, cursor } = task;
  const sinceId = cursor.lastSeenExternalId ?? undefined;
  const rawQuery = buildRawQuery(task);

  const posts: ScanIngestPost[] = [];
  let newestId: string | undefined = sinceId;
  let newestAtMs = cursor.lastSeenAt ? new Date(cursor.lastSeenAt).getTime() : 0;
  let pageCursor: string | undefined;
  let exhausted = true;
  let reachedSeen = false;

  for (let page = 0; page < Math.max(1, pacing.maxPages); page++) {
    if (!(await gate())) {
      exhausted = false; // hourly cap hit; backlog remains
      break;
    }
    if (page > 0) await applyDelay(pacing.pageDelayMs, pacing.pageJitterMs);

    const variables: Record<string, unknown> = {
      rawQuery,
      count: pacing.pageSize || X_COUNT_FALLBACK,
      querySource: 'typed_query',
      product: 'Latest',
    };
    if (pageCursor) variables.cursor = pageCursor;

    const data = await xGraphqlGet('SearchTimeline', {
      variables,
      features: X_SEARCH_FEATURES,
    });
    if (!data) {
      // 404/400/429/parse error already logged; preserve partial progress.
      exhausted = false;
      break;
    }

    const { results, bottomCursor } = readPage(data);
    if (!results.length) break; // no more tweets

    for (const result of results) {
      const t = parseTweetResult(result);
      if (!t) continue;
      if (!isNewerThan(t.id, sinceId)) {
        reachedSeen = true; // newest-first → the rest are older/seen
        break;
      }
      newestId = newerId(newestId, t.id);
      const atMs = new Date(t.createdAt).getTime();
      if (atMs > newestAtMs) newestAtMs = atMs;
      posts.push(toIngestPost(t));
    }

    pageCursor = bottomCursor;
    if (reachedSeen || !pageCursor) break;
  }

  const nextCursor: ScanTaskCursor = {
    lastSeenExternalId: newestId ?? null,
    lastSeenAt:
      newestAtMs > 0 ? new Date(newestAtMs).toISOString() : cursor.lastSeenAt,
  };
  return { posts, nextCursor, exhausted };
}
