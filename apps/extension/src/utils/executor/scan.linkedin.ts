// LinkedIn scan executor. Opens a real (background) linkedin.com tab and scrapes
// the rendered DOM of a content-search / recent-activity page with the user's
// own session (the only reliable way — LinkedIn has no public search API and
// flags automation aggressively). Gated OFF by default via LINKEDIN_EXECUTOR_ENABLED.
//
//   keyword scope  → /search/results/content/?keywords=<kw> (sorted by date)
//   tracked scope  → /in/<handle>/recent-activity/all/
//   (no channel scope — LinkedIn has no community concept here)
//
// LinkedIn feed timestamps are relative ("2h", "3d"), so incremental scanning is
// best-effort: posts are deduped within the run and the backend upserts on
// (platform, externalPostId), so re-seeing a post is harmless. The cursor tracks
// the newest scraped id for observability, not strict since-id filtering.

import {
  EngageScanTask,
  ScanIngestPost,
  ScanRunResult,
  ScanTaskCursor,
} from './executor.types';
import {
  relativeTimeToIso,
  toScanIngestPost,
} from '@gitroom/extension/utils/linkedin/dom';
import { readLinkedinPosts } from '@gitroom/extension/utils/linkedin/tab-reader';

const LINKEDIN_BASE = 'https://www.linkedin.com';

/** Build the search / activity URL for a task. */
export function buildLinkedinScanUrl(task: EngageScanTask): string {
  if (task.scanType === 'tracked') {
    const handle = task.scanKey.replace(/^@/, '').replace(/\/+$/, '');
    return `${LINKEDIN_BASE}/in/${encodeURIComponent(handle)}/recent-activity/all/`;
  }
  // keyword (rawQuery wins when the backend pre-built a combined query).
  const q = encodeURIComponent(task.rawQuery || task.scanKey);
  return `${LINKEDIN_BASE}/search/results/content/?keywords=${q}&sortBy=%22date_posted%22`;
}

/**
 * Scan one LinkedIn unit through a background linkedin.com tab. `gate` consumes
 * one hourly-budget token (one tab open = one unit of work). A missing tab /
 * auth-wall preserves the cursor and reports exhausted=false so callers can tell
 * it apart from a successful empty result.
 */
export async function scanLinkedin(
  task: EngageScanTask,
  gate: () => Promise<boolean>
): Promise<ScanRunResult> {
  const { cursor } = task;
  if (task.scanType === 'channel') {
    // LinkedIn has no channel/community scope — nothing to scan, don't re-lease.
    return { posts: [], nextCursor: cursor, exhausted: true };
  }

  if (!(await gate())) {
    return { posts: [], nextCursor: cursor, exhausted: false };
  }

  const url = buildLinkedinScanUrl(task);
  const maxPages = Math.max(1, Math.floor(task.pacing.maxPages || 1));
  const result = await readLinkedinPosts(url, {
    maxPages,
    pageDelayMs: task.pacing.pageDelayMs,
  });

  if (result.tabError || result.authWall || !result.payload) {
    // Auth-wall / tab failure: don't advance the cursor, and report not-exhausted
    // so the backend keeps the unit due (a signed-in retry can still find posts).
    return { posts: [], nextCursor: cursor, exhausted: false };
  }

  const nowMs = Date.now();
  const posts: ScanIngestPost[] = [];
  const seen = new Set<string>();
  let newestId = cursor.lastSeenExternalId ?? null;
  for (const row of result.payload.rows) {
    const publishedAt = relativeTimeToIso(row.posted_at, nowMs);
    if (!publishedAt) continue; // undateable → drop, never fabricate a publish time
    const post = toScanIngestPost(row, publishedAt);
    if (!post) continue;
    if (seen.has(post.externalPostId)) continue;
    seen.add(post.externalPostId);
    posts.push(post);
    // Search is date-sorted, so the first row is the newest — record it.
    if (newestId === cursor.lastSeenExternalId && posts.length === 1) {
      newestId = post.externalPostId;
    }
  }

  const nextCursor: ScanTaskCursor = {
    lastSeenExternalId: newestId,
    lastSeenAt: posts[0]?.postPublishedAt ?? cursor.lastSeenAt,
  };
  console.debug('[aisee][scan][linkedin] complete', {
    scanType: task.scanType,
    scanKey: task.scanKey,
    scraped: result.payload.rows.length,
    posts: posts.length,
  });
  return { posts, nextCursor, exhausted: true };
}
