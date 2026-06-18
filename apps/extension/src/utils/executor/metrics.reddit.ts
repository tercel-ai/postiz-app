// Fetch live metrics for a published Reddit post with the user's session and
// shape them as AnalyticsData the backend's extractMetrics/traffic pipeline
// understands. Reddit weights (traffic.calculator): score 0.5, upvotes 1,
// comments 3; impressions label for reddit = "score".

import { AnalyticsSeries } from './executor.types';

const NOW_ISO = () => new Date().toISOString();

function point(total: number): AnalyticsSeries['data'] {
  return [{ total, date: NOW_ISO() }];
}

/** Append `.json` to a Reddit permalink (stripping query/trailing slash). */
function toJsonUrl(url: string): string | null {
  try {
    const u = new URL(url);
    u.search = '';
    u.pathname = u.pathname.replace(/\/+$/, '');
    return `${u.origin}${u.pathname}.json`;
  } catch {
    return null;
  }
}

export async function fetchRedditMetrics(
  releaseURL: string
): Promise<AnalyticsSeries[] | null> {
  const jsonUrl = toJsonUrl(releaseURL);
  if (!jsonUrl) return null;
  try {
    const res = await fetch(jsonUrl, {
      credentials: 'include',
      headers: {
        Accept: 'application/json, text/javascript, */*; q=0.01',
        Referer: 'https://www.reddit.com/',
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      console.warn(`[aisee][metrics][reddit] ${res.status} for ${jsonUrl}`);
      return null;
    }
    const json = await res.json();
    // A post permalink returns [postListing, commentsListing].
    const listing = Array.isArray(json) ? json[0] : json;
    const p = listing?.data?.children?.[0]?.data;
    if (!p) return null;

    const score = typeof p.score === 'number' ? p.score : 0;
    const comments = typeof p.num_comments === 'number' ? p.num_comments : 0;
    const upvotes =
      typeof p.ups === 'number'
        ? p.ups
        : typeof p.upvote_ratio === 'number'
          ? Math.round(score * p.upvote_ratio)
          : score;

    return [
      { label: 'score', data: point(score) },
      { label: 'upvotes', data: point(upvotes) },
      { label: 'comments', data: point(comments) },
    ];
  } catch (e) {
    console.warn('[aisee][metrics][reddit] fetch failed', e);
    return null;
  }
}
