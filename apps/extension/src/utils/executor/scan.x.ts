// X scan executor via internal GraphQL SearchTimeline (Latest tab) using the
// user's session. Mirrors the backend XScanAdapter's intent:
//   keyword scope  → search the firehose for the keyword
//   tracked scope  → `from:<username>` restricted search
//   (no channel scope — X has no community concept here)
// Single-page incremental: SearchTimeline returns newest-first. Each keyword is
// searched ONCE per round-trip — no pagination (maxPages is intentionally NOT
// used for X, to keep request volume minimal for account safety). since_id
// semantics still apply: collection stops at the first tweet not newer than the
// cursor's lastSeenExternalId. The spacing BETWEEN keywords is applied by the
// runner via pageDelay/pageJitter (see selectUnitDelay in pacing.ts).

import {
  EngageScanTask,
  ScanIngestPost,
  ScanRunResult,
  ScanTaskCursor,
} from './executor.types';
import { xGraphqlGet, X_SEARCH_FEATURES } from './x.graphql';
import { parseTweetResult, newerId, isNewerThan } from './x.parse';

// Page size comes from server pacing (task.pacing.pageSize, admin-tunable). X's
// SearchTimeline serves ~20 per page for a real browsing session; this is the
// fallback if the server omits it (old build).
const X_COUNT_FALLBACK = 20;

// Exactly ONE keyword (or one tracked handle) per query — scanKey is never split,
// OR-joined, or batched with other units. Combined with the global single-flight
// serializer in x.graphql (serializeXRequest) and the runner's `scanInFlight`
// guard + `want:1` leasing, this guarantees one keyword is searched at a time.
export function buildRawQuery(task: EngageScanTask): string {
  if (task.scanType === 'tracked') {
    // The account's own posts (original/quote/reply), not what it retweeted.
    return `from:${task.scanKey} -filter:retweets`;
  }
  return task.scanKey; // single keyword, firehose
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
 * Scan one X unit: ONE SearchTimeline request for the keyword (single page, no
 * pagination). `gate` consumes one hourly-budget token. If the cap is hit the
 * scan is skipped and the cursor is preserved (exhausted=false, backlog remains).
 * On a successful fetch the round is complete (exhausted=true) — the next keyword
 * is paced by the runner via pageDelay/pageJitter.
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

  // Hourly cap reached → fetch nothing, keep the cursor, leave the backlog.
  if (!(await gate())) {
    return { posts, nextCursor: cursor, exhausted: false };
  }

  const variables: Record<string, unknown> = {
    rawQuery,
    count: pacing.pageSize || X_COUNT_FALLBACK,
    querySource: 'typed_query',
    product: 'Latest',
  };

  const data = await xGraphqlGet('SearchTimeline', {
    variables,
    features: X_SEARCH_FEATURES,
  });
  if (!data) {
    // 404/400/429/parse error already logged; keep the cursor, retry next round.
    return { posts, nextCursor: cursor, exhausted: false };
  }

  // newest-first: collect until the first tweet we've already seen (since_id).
  const { results } = readPage(data);
  for (const result of results) {
    const t = parseTweetResult(result);
    if (!t) continue;
    if (!isNewerThan(t.id, sinceId)) break; // the rest are older/already seen
    newestId = newerId(newestId, t.id);
    const atMs = new Date(t.createdAt).getTime();
    if (atMs > newestAtMs) newestAtMs = atMs;
    posts.push(toIngestPost(t));
  }

  const nextCursor: ScanTaskCursor = {
    lastSeenExternalId: newestId ?? null,
    lastSeenAt:
      newestAtMs > 0 ? new Date(newestAtMs).toISOString() : cursor.lastSeenAt,
  };
  return { posts, nextCursor, exhausted: true };
}
