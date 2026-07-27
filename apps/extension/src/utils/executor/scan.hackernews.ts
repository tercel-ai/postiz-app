// Hacker News scan executor via the official Algolia HN Search API (public, no
// session):
//   keyword → search_by_date?query=<kw>&tags=story
//   tracked → search_by_date?tags=story,author_<user>
//   (no channel scope — HN has no community concept)
// search_by_date returns strictly newest-first, so incremental is efficient:
// we pass numericFilters=created_at_i>{sinceSec} AND defensively stop paging
// once a hit is at/older than the cursor. Every hit carries points + comments,
// so the ingested post scores without a follow-up metrics fetch.

import {
  EngageScanTask,
  ScanIngestPost,
  ScanRunResult,
  ScanTaskCursor,
} from './executor.types';
import { applyDelay } from './pacing';

const HN_ALGOLIA = 'https://hn.algolia.com/api/v1/search_by_date';
const HN_ITEM = 'https://news.ycombinator.com/item?id=';
const HN_PER_PAGE_FALLBACK = 20;

/** Build the Algolia query URL for a task + 0-based page + optional since. */
export function buildHackernewsScanUrl(
  task: EngageScanTask,
  page: number,
  sinceSec: number | null
): string {
  const perPage = task.pacing.pageSize || HN_PER_PAGE_FALLBACK;
  const params = new URLSearchParams();
  const tags =
    task.scanType === 'tracked'
      ? `story,author_${task.scanKey.replace(/^@/, '')}`
      : 'story';
  params.set('tags', tags);
  if (task.scanType !== 'tracked') {
    params.set('query', task.rawQuery || task.scanKey);
  }
  params.set('hitsPerPage', String(perPage));
  params.set('page', String(page));
  if (sinceSec != null) params.set('numericFilters', `created_at_i>${sinceSec}`);
  return `${HN_ALGOLIA}?${params.toString()}`;
}

function toIngestPost(hit: Record<string, any>): ScanIngestPost | null {
  const id = hit.objectID != null ? String(hit.objectID) : '';
  if (!id) return null;
  const sec = Number(hit.created_at_i);
  const atMs = Number.isFinite(sec) && sec > 0 ? sec * 1000 : Date.parse(hit.created_at);
  if (!Number.isFinite(atMs)) return null;
  const title = String(hit.title ?? '');
  const storyText = hit.story_text ? String(hit.story_text) : '';
  return {
    platform: 'hackernews',
    externalPostId: id,
    externalPostUrl: `${HN_ITEM}${id}`,
    authorUsername: String(hit.author ?? ''),
    postContent: `${title}${storyText ? '\n' + storyText : ''}`.trim(),
    postPublishedAt: new Date(atMs).toISOString(),
    metricScore: typeof hit.points === 'number' ? hit.points : 0,
    metricComments: typeof hit.num_comments === 'number' ? hit.num_comments : 0,
  };
}

export async function scanHackernews(
  task: EngageScanTask,
  gate: () => Promise<boolean>
): Promise<ScanRunResult> {
  if (task.scanType === 'channel') {
    return { posts: [], nextCursor: task.cursor, exhausted: true }; // no channels on HN
  }

  const { pacing, cursor } = task;
  const sinceSec = cursor.lastSeenAt
    ? Math.floor(Date.parse(cursor.lastSeenAt) / 1000)
    : null;

  const posts: ScanIngestPost[] = [];
  let newestAtMs = cursor.lastSeenAt ? Date.parse(cursor.lastSeenAt) : 0;
  let newestId: string | null = cursor.lastSeenExternalId ?? null;
  let firstSeen = false;
  let exhausted = true;

  for (let page = 0; page < Math.max(1, pacing.maxPages); page++) {
    if (!(await gate())) {
      exhausted = false;
      break;
    }
    if (page > 0) await applyDelay(pacing.pageDelayMs, pacing.pageJitterMs);

    let body: any = null;
    try {
      const res = await fetch(buildHackernewsScanUrl(task, page, sinceSec), {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        console.warn(`[aisee][scan][hn] ${res.status} for ${task.scanKey}`);
        exhausted = false;
        break;
      }
      body = await res.json();
    } catch (e) {
      console.warn('[aisee][scan][hn] fetch failed', e);
      exhausted = false;
      break;
    }

    const hits: any[] = Array.isArray(body?.hits) ? body.hits : [];
    if (!hits.length) break;

    for (const hit of hits) {
      const post = toIngestPost(hit);
      if (!post) continue;
      const atMs = Date.parse(post.postPublishedAt);
      if (sinceSec != null && atMs <= sinceSec * 1000) continue; // already seen
      if (!firstSeen || atMs > newestAtMs) {
        newestId = post.externalPostId;
        newestAtMs = atMs;
      }
      firstSeen = true;
      posts.push(post);
    }

    // Algolia reports total pages; stop when we've consumed them all.
    const nbPages = Number(body?.nbPages ?? 1);
    if (page + 1 >= nbPages) break;
  }

  const nextCursor: ScanTaskCursor = {
    lastSeenExternalId: newestId,
    lastSeenAt: newestAtMs > 0 ? new Date(newestAtMs).toISOString() : cursor.lastSeenAt,
  };
  console.debug('[aisee][scan][hn] complete', {
    scanType: task.scanType,
    scanKey: task.scanKey,
    posts: posts.length,
    exhausted,
  });
  return { posts, nextCursor, exhausted };
}
