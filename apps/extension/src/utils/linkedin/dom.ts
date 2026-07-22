// Node-side (service-worker) helpers for the LinkedIn executor: pure text /
// metric normalisers plus mappers from a scraped page row to the shared ingest
// shapes. The DOM extraction itself runs IN the page (see page-scripts.ts) — the
// extension has no direct Voyager API access; it reads what LinkedIn's own web
// app renders for the logged-in user (mirrors ../opencli/clis/linkedin).
//
// These functions are deliberately kept out of the page scripts so they can be
// unit-tested without a DOM (the page scripts are self-contained by necessity —
// chrome.scripting.executeScript serialises them away from module scope).

import { ScanIngestPost } from '@gitroom/extension/utils/executor/executor.types';
import { AnalyticsSeries } from '@gitroom/extension/utils/executor/executor.types';

/** Collapse NBSP/narrow-NBSP + runs of whitespace, trim. */
export function normalizeWhitespace(value: unknown): string {
  return String(value ?? '')
    .replace(/[  ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "1,234" | "3.4K" | "2M" → integer count (mirrors opencli parseMetric). */
export function parseMetric(value: unknown): number {
  const raw = normalizeWhitespace(value).toLowerCase().replace(/,/g, '');
  const match = raw.match(/(\d+(?:\.\d+)?)(k|m)?/i);
  if (!match) return 0;
  const base = Number(match[1]);
  if (match[2]?.toLowerCase() === 'k') return Math.round(base * 1000);
  if (match[2]?.toLowerCase() === 'm') return Math.round(base * 1_000_000);
  return Math.round(base);
}

/**
 * LinkedIn renders the reaction count in several shapes ("42 reactions",
 * "Jane Doe and 12 others", "5 · 3 comments"). Mirrors opencli parseReactionText
 * so the scraped number matches what a human sees.
 */
export function parseReactionText(value: unknown): number {
  const text = normalizeWhitespace(value);
  const explicit = text.match(/(\d[\d,.]*\s*(?:k|m)?\s+reactions?)/i);
  if (explicit) return parseMetric(explicit[1]);
  const namedOthers = text.match(
    /(?:^|\s)(\d[\d,.]*\s*(?:k|m)?)\s+[A-Z][^.!?\n]{0,100}\s+and\s+\d[\d,.]*\s+others/i
  );
  if (namedOthers) return parseMetric(namedOthers[1]);
  const beforeComments = text.match(
    /(?:^|\s)(\d[\d,.]*\s*(?:k|m)?)\s+(?:\d[\d,.]*\s+comments?|\d[\d,.]*\s+reposts?)/i
  );
  if (beforeComments) return parseMetric(beforeComments[1]);
  // "<Name> and N others" (no leading total) → the named reactor + N others.
  const andOthers = text.match(/\band\s+(\d[\d,.]*\s*(?:k|m)?)\s+others?\b/i);
  if (andOthers) return parseMetric(andOthers[1]) + 1;
  const trailing = text.match(/(?:^|\s)(\d[\d,.]*\s*(?:k|m)?)\s*$/i);
  return trailing ? parseMetric(trailing[1]) : 0;
}

/** True when the scraped text looks like a LinkedIn login / auth-wall page. */
export function looksLinkedInAuthWall(value: unknown): boolean {
  const text = normalizeWhitespace(value).toLowerCase();
  if (!text) return false;
  return (
    /linkedin\.com\/(?:login|checkpoint|authwall|uas)/i.test(text) ||
    /\b(sign in|log in|join linkedin|captcha|verification required)\b/i.test(
      text
    ) ||
    /(请登录|登录领英|安全验证)/.test(text)
  );
}

/** A raw post row as scraped in-page by extractLinkedinPosts (page-scripts.ts). */
export interface RawLinkedinPost {
  author?: string;
  authorProfileUrl?: string;
  authorAvatarUrl?: string;
  posted_at?: string;
  body?: string;
  reactions?: number;
  comments?: number;
  reposts?: number;
  impressions?: number;
  url?: string;
  urn?: string;
  raw_text?: string;
}

/** Raw single-post metric counters scraped in-page by extractLinkedinPostMetrics. */
export interface RawLinkedinMetrics {
  reactions?: number;
  comments?: number;
  reposts?: number;
  impressions?: number;
}

/** Pull the activity id out of a LinkedIn permalink or urn, for a stable id. */
export function activityIdFromUrl(url: string): string | null {
  const raw = normalizeWhitespace(url);
  if (!raw) return null;
  // urn:li:activity:123 | .../feed/update/urn:li:activity:123/ | .../posts/...-123-
  const urn = raw.match(/urn:li:(?:activity|ugcPost|share):(\d+)/i);
  if (urn) return urn[1];
  const digits = raw.match(/(\d{10,})/);
  return digits ? digits[1] : null;
}

/**
 * Map a scraped post row to the shared ScanIngestPost. Rows without a resolvable
 * external id OR content are dropped by the caller (returns null here). LinkedIn
 * has no per-post follower count in the feed, so authority is left to the
 * backend scorer; author handle comes from the /in/<handle> profile link.
 */
export function toScanIngestPost(
  row: RawLinkedinPost,
  publishedAtIso: string
): ScanIngestPost | null {
  const body = normalizeWhitespace(row.body);
  const url = normalizeWhitespace(row.url);
  const externalPostId =
    activityIdFromUrl(row.urn || '') || activityIdFromUrl(url) || '';
  if (!externalPostId || (!body && !url)) return null;

  const handle = handleFromProfileUrl(row.authorProfileUrl) || '';
  return {
    platform: 'linkedin',
    externalPostId,
    externalPostUrl: url,
    authorUsername: handle,
    authorDisplayName: normalizeWhitespace(row.author) || undefined,
    authorAvatarUrl: normalizeWhitespace(row.authorAvatarUrl) || undefined,
    postContent: body,
    postPublishedAt: publishedAtIso,
    metricLikes: Number(row.reactions) || 0,
    metricComments: Number(row.comments) || 0,
    metricShares: Number(row.reposts) || 0,
    metricViews: Number(row.impressions) || 0,
  };
}

/**
 * LinkedIn feed timestamps are RELATIVE ("2h", "3d", "5m", "1w", "2mo", "1yr").
 * Convert to an approximate absolute ISO by subtracting from `nowMs`. Returns
 * null when the string carries no recognisable unit (caller drops the post
 * rather than fabricating a publish time — mirrors the Reddit scanner).
 */
export function relativeTimeToIso(
  rel: unknown,
  nowMs: number = Date.now()
): string | null {
  const raw = normalizeWhitespace(rel).toLowerCase();
  const m = raw.match(/(\d+)\s*(s|min|m|h|d|w|mo|yr|y)\b/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = m[2];
  const SEC = 1000;
  const MIN = 60 * SEC;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  const WEEK = 7 * DAY;
  const MONTH = 30 * DAY;
  const YEAR = 365 * DAY;
  const perUnit: Record<string, number> = {
    s: SEC,
    min: MIN,
    m: MIN,
    h: HOUR,
    d: DAY,
    w: WEEK,
    mo: MONTH,
    yr: YEAR,
    y: YEAR,
  };
  const ms = perUnit[unit];
  if (ms == null) return null;
  return new Date(nowMs - n * ms).toISOString();
}

/** `/in/john-doe/` → `john-doe`; company/other links yield ''. */
export function handleFromProfileUrl(url: unknown): string {
  const raw = normalizeWhitespace(url);
  if (!raw) return '';
  const m = raw.match(/\/in\/([^/?#]+)/i);
  return m ? decodeURIComponent(m[1]) : '';
}

/**
 * Shape scraped single-post counters as the AnalyticsData series the backend
 * extractMetrics/traffic pipeline consumes. Labels are chosen to match the
 * backend traffic.calculator `linkedin` weights EXACTLY (impressions, likes,
 * comments, shares) so the scraped numbers fold into the Traffic score — a
 * reposts→shares rename here would otherwise leave the repost count unweighted.
 * `reactions` map to `likes`; `reposts` to `shares` (LinkedIn's repost = share).
 */
export function buildLinkedinAnalytics(
  raw: RawLinkedinMetrics
): AnalyticsSeries[] {
  const nowIso = new Date().toISOString();
  const point = (total: number) => [{ total, date: nowIso }];
  return [
    { label: 'impressions', data: point(Number(raw.impressions) || 0) },
    { label: 'likes', data: point(Number(raw.reactions) || 0) },
    { label: 'comments', data: point(Number(raw.comments) || 0) },
    { label: 'shares', data: point(Number(raw.reposts) || 0) },
  ];
}
