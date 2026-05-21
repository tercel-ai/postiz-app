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
  metricRetweets: number;
  metricQuotes: number;
  metricScore: number;        // Reddit score (upvotes - downvotes)
  metricUpvoteRatio?: number; // Reddit
  metricComments: number;     // Reddit num_comments
}

export interface ScoredPost extends RawPost {
  score: number;
  scoreKeyword: number;
  scoreHeat: number;
  scoreAuthority: number;
  scoreRecency: number;
  scoreTracked: number;
  scoreBreakdown?: Record<string, number>; // future dimensions
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
  const scoreHeat =
    post.platform === 'x'
      ? computeXHeatScore(post)
      : computeCommunityHeatScore(post);
  const scoreAuthority =
    post.platform === 'x'
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

function computeXHeatScore(post: RawPost): number {
  const heat =
    post.metricLikes * 1 +
    post.metricReplies * 3 +
    post.metricRetweets * 2 +
    post.metricQuotes * 2;
  if (heat > 2000) return 35;
  if (heat > 1000) return 26;
  if (heat > 300) return 18;
  if (heat > 80) return 9;
  return 3;
}

function computeCommunityHeatScore(post: RawPost): number {
  // Clamp metricScore to 0 — highly downvoted posts should not produce negative heat
  const score = Math.max(post.metricScore ?? 0, 0);
  const heat = score * (post.metricUpvoteRatio ?? 1) + (post.metricComments ?? 0) * 2;
  if (heat > 800) return 35;
  if (heat > 400) return 26;
  if (heat > 100) return 18;
  if (heat > 30) return 9;
  return 3;
}

// ─── Authority scoring ────────────────────────────────────────────────────────

function computeXAuthorityScore(followers: number | null): number {
  if (!followers) return 3;
  if (followers > 50_000) return 20;
  if (followers > 10_000) return 15;
  if (followers > 1_000) return 8;
  return 3;
}

function computeCommunityAuthorityScore(audienceSize: number | null): number {
  if (!audienceSize) return 3;
  if (audienceSize > 1_000_000) return 20;
  if (audienceSize > 100_000) return 15;
  if (audienceSize > 10_000) return 8;
  return 3;
}

// ─── Recency ──────────────────────────────────────────────────────────────────

function computeRecencyScore(publishedAt: Date): number {
  const ageMs = Date.now() - new Date(publishedAt).getTime();
  const h = ageMs / 3_600_000; // age in hours
  if (h < 1)  return 5;
  if (h < 6)  return 4;
  if (h < 12) return 3;
  if (h < 24) return 2;
  if (h < 48) return 1;
  return 0;
}
