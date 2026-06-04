import { EngageKeyword } from '@prisma/client';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RawPost {
  id: string;
  platform: string;         // 'x' | 'reddit' | 'youtube' | ...
  externalPostId: string;
  externalPostUrl: string;
  channelId?: string;
  channelName?: string;
  authorUsername: string;
  authorDisplayName?: string;
  authorFollowers?: number; // X followers; for community: audienceSize
  authorAvatarUrl?: string;
  postContent: string;
  postPublishedAt: Date;
  isFromTrackedAccount?: boolean;
  // Raw platform metrics
  metricLikes: number;
  metricReplies: number;
  metricRetweets: number;   // X retweet | Threads repost | Mastodon reblog | Bluesky repost
  metricQuotes: number;     // X quote | Threads quote | Bluesky quote
  metricBookmarks: number;  // X bookmark_count
  metricViews: number;      // YouTube viewCount | TikTok view_count | Threads views | LinkedIn impressions | Instagram impressions
  metricShares: number;     // TikTok share_count | LinkedIn reshare | Instagram shares
  metricSaves: number;      // Instagram saved | Pinterest SAVE
  metricScore: number;      // Reddit score (upvotes - downvotes)
  metricUpvoteRatio?: number; // Reddit
  metricComments: number;   // Reddit num_comments | YouTube commentCount | TikTok comment_count | LinkedIn comment | Instagram comments
  rawData?: Record<string, unknown>; // original platform API response object
}

export interface ScoredPost extends RawPost {
  score: number;
  scoreKeyword: number;
  scoreHeat: number;
  scoreAuthority: number;
  scoreRecency: number;
  scoreTracked: number;
  // The org's enabled keywords this post actually hit (text, as configured).
  // Per-org by construction — scorePost is called with one org's keyword set —
  // so it stays strictly within that org's keyword scope and is persisted onto
  // the per-org EngageOpportunityState row (never the shared EngageOpportunity).
  matchedKeywords: string[];
  intentTags: string[];
  primaryIntent: string;
  intentScore?: number;
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export function scorePost(
  post: RawPost,
  keywords: Pick<EngageKeyword, 'keyword' | 'type' | 'enabled'>[]
): ScoredPost | null {
  // Layer 1: keyword hard filter — must hit at least one enabled keyword
  const hits = keywords.filter(
    (k) => k.enabled && postMatchesKeyword(post.postContent, k.keyword)
  );
  if (hits.length === 0) return null;

  const scoreKeyword = computeKeywordScore(hits);
  const scoreHeat = (() => {
    switch (post.platform) {
      case 'x':
      case 'threads':
      case 'mastodon':
      case 'bluesky':
        return computeTextHeatScore(post);
      case 'youtube':
      case 'tiktok':
        return computeVideoHeatScore(post);
      case 'linkedin':
      case 'linkedin-page':
      case 'instagram':
      case 'pinterest':
        return computeNetworkHeatScore(post);
      default:
        return computeCommunityHeatScore(post); // reddit and others
    }
  })();
  const scoreAuthority = ['x', 'threads', 'mastodon', 'bluesky'].includes(post.platform)
    ? computeXAuthorityScore(post.authorFollowers ?? null)
    : computeCommunityAuthorityScore(post.authorFollowers ?? null);
  const scoreRecency = computeRecencyScore(post.postPublishedAt);
  const scoreTracked = post.isFromTrackedAccount ? 5 : 0;
  const score =
    scoreKeyword + scoreHeat + scoreAuthority + scoreRecency + scoreTracked;

  return {
    ...post,
    score,
    scoreKeyword,
    matchedKeywords: hits.map((k) => k.keyword),
    scoreHeat,
    scoreAuthority,
    scoreRecency,
    scoreTracked,
    intentTags: [],
    primaryIntent: 'discussion',
    intentScore: 0,
  };
}

// ─── Keyword scoring ──────────────────────────────────────────────────────────

function postMatchesKeyword(content: string, keyword: string): boolean {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // For ASCII keywords, keep \b boundaries to prevent "AI" matching "rail".
  // For keywords containing any non-ASCII character (CJK, accented, emoji),
  // do a case-insensitive substring match. CJK text has no whitespace-based
  // word boundaries, and \b is ASCII-only — using either \b or \p{L}-aware
  // lookarounds on mixed Chinese content (e.g. "SEO媒体" inside "推荐SEO媒体") rejects
  // legitimate hits. Substring is the conventional match semantics for CJK.
  const isAscii = /^[\x00-\x7F]+$/.test(keyword);
  return isAscii
    ? new RegExp(`\\b${escaped}\\b`, 'i').test(content)
    : new RegExp(escaped, 'i').test(content);
}

function computeKeywordScore(
  hits: Pick<EngageKeyword, 'type'>[]
): number {
  const base = Math.min(hits.length * 15, 35);
  const hasBrand = hits.some((k) => k.type === 'BRAND');
  const hasCompetitor = hits.some((k) => k.type === 'COMPETITOR');
  return Math.min(base + (hasBrand ? 5 : 0) + (hasCompetitor ? 3 : 0), 35);
}

// ─── Heat scoring ─────────────────────────────────────────────────────────────

// X, Threads, Mastodon, Bluesky — engagement-based (no view counts)
function computeTextHeatScore(post: RawPost): number {
  const heat =
    post.metricLikes * 1 +
    post.metricReplies * 3 +
    post.metricRetweets * 2 +
    post.metricQuotes * 2 +
    post.metricShares * 2;
  if (heat > 2000) return 45;
  if (heat > 1000) return 33;
  if (heat > 300) return 23;
  if (heat > 80) return 12;
  return 4;
}

// YouTube, TikTok — views-based with engagement weighting
function computeVideoHeatScore(post: RawPost): number {
  const heat =
    post.metricViews * 0.005 +
    post.metricLikes * 2 +
    post.metricComments * 5 +
    post.metricShares * 3;
  if (heat > 2000) return 45;
  if (heat > 800) return 33;
  if (heat > 200) return 23;
  if (heat > 50) return 12;
  return 4;
}

// LinkedIn, Instagram — impression/view weighted
function computeNetworkHeatScore(post: RawPost): number {
  const heat =
    post.metricViews * 0.05 +
    post.metricLikes * 3 +
    post.metricComments * 8 +
    post.metricShares * 5 +
    post.metricSaves * 4;
  if (heat > 1000) return 45;
  if (heat > 400) return 33;
  if (heat > 100) return 23;
  if (heat > 25) return 12;
  return 4;
}

// Reddit — upvote score + comments
function computeCommunityHeatScore(post: RawPost): number {
  // Clamp metricScore to 0 — highly downvoted posts should not produce negative heat
  const score = Math.max(post.metricScore ?? 0, 0);
  const heat = score * (post.metricUpvoteRatio ?? 1) + (post.metricComments ?? 0) * 2;
  if (heat > 800) return 45;
  if (heat > 400) return 33;
  if (heat > 100) return 23;
  if (heat > 30) return 12;
  return 4;
}

// ─── Authority scoring ────────────────────────────────────────────────────────

function computeXAuthorityScore(followers: number | null): number {
  if (!followers) return 2;
  if (followers > 50_000) return 15;
  if (followers > 10_000) return 11;
  if (followers > 1_000) return 6;
  return 2;
}

function computeCommunityAuthorityScore(audienceSize: number | null): number {
  if (!audienceSize) return 2;
  if (audienceSize > 1_000_000) return 15;
  if (audienceSize > 100_000) return 11;
  if (audienceSize > 10_000) return 6;
  return 2;
}

// ─── Recency ──────────────────────────────────────────────────────────────────

function computeRecencyScore(publishedAt: Date): number {
  // Binary per scoring spec: within 24h → 5, otherwise → 0.
  const ageMs = Date.now() - new Date(publishedAt).getTime();
  return ageMs < 24 * 3_600_000 ? 5 : 0;
}
