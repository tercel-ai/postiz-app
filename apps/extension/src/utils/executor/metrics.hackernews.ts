// Fetch live metrics for a Hacker News submission via the official public
// Firebase API (no session, no key) and shape them as the AnalyticsData series
// the backend's extractMetrics / traffic pipeline consumes:
//
//   GET https://hacker-news.firebaseio.com/v0/item/<id>.json
//   → { score, descendants (comment count), ... }
//
// HN has no per-post impression/view figure, so we report score + comments.

import { AnalyticsSeries } from './executor.types';

const HN_ITEM_BASE = 'https://hacker-news.firebaseio.com/v0/item';

const NOW_ISO = () => new Date().toISOString();

function point(total: number): AnalyticsSeries['data'] {
  return [{ total, date: NOW_ISO() }];
}

/**
 * Parse the numeric item id out of a Hacker News URL. HN links are
 * `https://news.ycombinator.com/item?id=<id>` (both stories and comments).
 * Returns null for anything that isn't an HN item URL.
 */
export function parseHackernewsItemId(releaseURL: string): string | null {
  let u: URL;
  try {
    u = new URL(String(releaseURL || '').trim());
  } catch {
    return null;
  }
  if (!/(^|\.)ycombinator\.com$/i.test(u.hostname)) return null;
  const id = u.searchParams.get('id');
  return id && /^\d+$/.test(id) ? id : null;
}

export async function fetchHackernewsMetrics(
  releaseURL: string
): Promise<AnalyticsSeries[] | null> {
  const id = parseHackernewsItemId(releaseURL);
  if (!id) return null;

  try {
    const res = await fetch(`${HN_ITEM_BASE}/${id}.json`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      console.warn(`[aisee][metrics][hn] ${res.status} for item ${id}`);
      return null;
    }
    const item = await res.json();
    // Deleted / dead items come back as null or with a `deleted` flag.
    if (!item || item.deleted || item.dead) return null;

    const score = typeof item.score === 'number' ? item.score : 0;
    // `descendants` is the total comment count on a story; a comment item has no
    // descendants field, so it reports 0 comments (only its score matters).
    const comments =
      typeof item.descendants === 'number' ? item.descendants : 0;

    return [
      { label: 'score', data: point(score) },
      { label: 'comments', data: point(comments) },
    ];
  } catch (e) {
    console.warn('[aisee][metrics][hn] fetch failed', e);
    return null;
  }
}
