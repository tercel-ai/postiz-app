// Fetch live metrics for a published Dev.to article via the Forem public REST
// API and shape them as the AnalyticsData series the backend's extractMetrics /
// traffic pipeline consumes. Dev.to exposes engagement without a session:
//
//   GET https://dev.to/api/articles/{username}/{slug}
//   → { public_reactions_count, comments_count }
//
// Dev.to publishing is owned by the backend's native DevToProvider (the article
// api-key lives on the Integration, server-side), so this reads anonymously —
// reactions + comments are public. page_views_count needs the author's key and
// is left to a future backend-side enrichment.

import { AnalyticsSeries } from './executor.types';

const NOW_ISO = () => new Date().toISOString();

function point(total: number): AnalyticsSeries['data'] {
  return [{ total, date: NOW_ISO() }];
}

/**
 * Parse a dev.to article URL into { username, slug } for the by-path API
 * endpoint. Dev.to article URLs are `https://dev.to/<username>/<slug>` — the
 * slug is the last path segment (it embeds the id suffix but the endpoint keys
 * on the full slug). Returns null for anything that isn't a dev.to article URL.
 */
export function parseDevtoArticlePath(
  releaseURL: string
): { username: string; slug: string } | null {
  let u: URL;
  try {
    u = new URL(String(releaseURL || '').trim());
  } catch {
    return null;
  }
  if (!/(^|\.)dev\.to$/i.test(u.hostname)) return null;
  const parts = u.pathname.split('/').filter(Boolean);
  // /<username>/<slug>  (ignore anything deeper, e.g. /comments).
  if (parts.length < 2) return null;
  const [username, slug] = parts;
  if (!username || !slug) return null;
  return { username, slug };
}

export async function fetchDevtoMetrics(
  releaseURL: string
): Promise<AnalyticsSeries[] | null> {
  const parsed = parseDevtoArticlePath(releaseURL);
  if (!parsed) return null;

  try {
    const res = await fetch(
      `https://dev.to/api/articles/${encodeURIComponent(
        parsed.username
      )}/${encodeURIComponent(parsed.slug)}`,
      {
        headers: { accept: 'application/vnd.forem.api-v1+json' },
        signal: AbortSignal.timeout(15_000),
      }
    );
    if (!res.ok) {
      console.warn(`[aisee][metrics][devto] ${res.status} for ${releaseURL}`);
      return null;
    }
    const a = await res.json();
    if (!a || a.id == null) return null;

    const reactions =
      typeof a.public_reactions_count === 'number'
        ? a.public_reactions_count
        : typeof a.positive_reactions_count === 'number'
          ? a.positive_reactions_count
          : 0;
    const comments =
      typeof a.comments_count === 'number' ? a.comments_count : 0;

    // Anonymous read → reactions + comments only. page_views_count needs the
    // author's api-key (held server-side by the native DevToProvider), so views
    // are intentionally omitted here rather than reported as a misleading 0.
    return [
      { label: 'reactions', data: point(reactions) },
      { label: 'comments', data: point(comments) },
    ];
  } catch (e) {
    console.warn('[aisee][metrics][devto] fetch failed', e);
    return null;
  }
}
