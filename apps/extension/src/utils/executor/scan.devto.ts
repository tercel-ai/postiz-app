// Dev.to scan executor via the Forem public REST API (no session needed):
//   keyword / channel → GET /api/articles?tag=<tag>       (tag firehose, newest)
//   tracked           → GET /api/articles?username=<user> (that author's posts)
// The listing sorts newest-first, so incremental is TIME-based (mirrors the
// Reddit scanner): page via `page`, stop once an article is older than the
// cursor's lastSeenAt. Each article carries its reactions + comments, so the
// ingested post scores without a follow-up metrics fetch.

import {
  EngageScanTask,
  ScanIngestPost,
  ScanRunResult,
  ScanTaskCursor,
} from './executor.types';
import { applyDelay } from './pacing';

const DEVTO_API = 'https://dev.to/api/articles';
const DEVTO_PER_PAGE_FALLBACK = 30;

/** Normalize a keyword into a dev.to tag token (alnum, lowercased). */
export function toDevtoTag(raw: string): string {
  return String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/** Build the listing URL for a task + 1-based page. */
export function buildDevtoScanUrl(task: EngageScanTask, page: number): string {
  const perPage = task.pacing.pageSize || DEVTO_PER_PAGE_FALLBACK;
  if (task.scanType === 'tracked') {
    const user = encodeURIComponent(task.scanKey.replace(/^@/, ''));
    return `${DEVTO_API}?username=${user}&per_page=${perPage}&page=${page}`;
  }
  // keyword / channel → tag listing.
  const tag = toDevtoTag(task.scanKey);
  return `${DEVTO_API}?tag=${encodeURIComponent(tag)}&per_page=${perPage}&page=${page}`;
}

function devtoPublishedAtMs(a: Record<string, any>): number | null {
  const raw = a.published_at || a.published_timestamp || a.created_at;
  if (!raw) return null;
  const ms = Date.parse(String(raw));
  return Number.isFinite(ms) ? ms : null;
}

function toIngestPost(a: Record<string, any>, atMs: number): ScanIngestPost {
  const tags = Array.isArray(a.tag_list)
    ? a.tag_list.join(', ')
    : String(a.tag_list ?? '');
  const title = String(a.title ?? '');
  const desc = a.description ? String(a.description) : '';
  return {
    platform: 'devto',
    externalPostId: a.id != null ? String(a.id) : '',
    externalPostUrl: String(a.url ?? ''),
    authorUsername: String(a.user?.username ?? ''),
    authorDisplayName: a.user?.name ? String(a.user.name) : undefined,
    authorAvatarUrl: a.user?.profile_image_90 || a.user?.profile_image || undefined,
    channelId: tags || undefined,
    channelName: tags ? `#${tags}` : undefined,
    postContent: `${title}${desc ? '\n' + desc : ''}`.trim(),
    postPublishedAt: new Date(atMs).toISOString(),
    metricScore:
      typeof a.public_reactions_count === 'number'
        ? a.public_reactions_count
        : typeof a.positive_reactions_count === 'number'
          ? a.positive_reactions_count
          : 0,
    metricComments: typeof a.comments_count === 'number' ? a.comments_count : 0,
  };
}

export async function scanDevto(
  task: EngageScanTask,
  gate: () => Promise<boolean>
): Promise<ScanRunResult> {
  if (task.scanType === 'keyword' && !toDevtoTag(task.scanKey)) {
    // A multi-word/free-text keyword has no dev.to tag equivalent — nothing to
    // scan (tag listings are single-token). Don't re-lease.
    return { posts: [], nextCursor: task.cursor, exhausted: true };
  }

  const { pacing, cursor } = task;
  const stopBefore = cursor.lastSeenAt ? Date.parse(cursor.lastSeenAt) : null;
  const posts: ScanIngestPost[] = [];
  let newestAtMs = stopBefore ?? 0;
  let newestId: string | null = cursor.lastSeenExternalId ?? null;
  let firstSeen = false;
  let exhausted = true;

  for (let page = 1; page <= Math.max(1, pacing.maxPages); page++) {
    if (!(await gate())) {
      exhausted = false; // hourly cap hit; backlog remains
      break;
    }
    if (page > 1) await applyDelay(pacing.pageDelayMs, pacing.pageJitterMs);

    let list: any[] = [];
    try {
      const res = await fetch(buildDevtoScanUrl(task, page), {
        headers: { accept: 'application/vnd.forem.api-v1+json' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        console.warn(`[aisee][scan][devto] ${res.status} for ${task.scanKey}`);
        exhausted = false;
        break;
      }
      const body = await res.json();
      list = Array.isArray(body) ? body : [];
    } catch (e) {
      console.warn('[aisee][scan][devto] fetch failed', e);
      exhausted = false;
      break;
    }

    if (!list.length) break; // no more articles

    let sawStale = false;
    for (const a of list) {
      const atMs = devtoPublishedAtMs(a);
      if (atMs == null) continue; // undateable → drop
      if (stopBefore != null && atMs <= stopBefore) {
        sawStale = true;
        continue; // already seen/older
      }
      if (!firstSeen || atMs > newestAtMs) {
        newestId = a.id != null ? String(a.id) : newestId;
        newestAtMs = atMs;
      }
      firstSeen = true;
      posts.push(toIngestPost(a, atMs));
    }

    // A short page (fewer than requested) means the listing is exhausted; a
    // stale item means we've caught up to already-seen data.
    if (sawStale || list.length < (pacing.pageSize || DEVTO_PER_PAGE_FALLBACK)) break;
  }

  const nextCursor: ScanTaskCursor = {
    lastSeenExternalId: newestId,
    lastSeenAt: newestAtMs > 0 ? new Date(newestAtMs).toISOString() : cursor.lastSeenAt,
  };
  console.debug('[aisee][scan][devto] complete', {
    scanType: task.scanType,
    scanKey: task.scanKey,
    posts: posts.length,
    exhausted,
  });
  return { posts, nextCursor, exhausted };
}
