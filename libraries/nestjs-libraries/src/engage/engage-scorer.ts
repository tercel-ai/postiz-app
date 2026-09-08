import { EngageKeyword } from '@prisma/client';
import { getKeywordAbbreviations } from './keyword-abbreviations-loader';

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
  authorFollowers?: number;  // post author's real follower count (X); null on Reddit
  channelFollowers?: number; // community/channel audience size (Reddit subreddit_subscribers)
  authorAvatarUrl?: string;
  /**
   * The post's own title, where the platform has one (Quora question, Reddit /
   * HN / dev.to / Medium headline). Undefined on X and LinkedIn, and on rows
   * stored before the field existed — in those the title, if any, is still
   * folded into postContent. Read it through postSearchText(), never on its own.
   */
  title?: string;
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

/**
 * The post's full searchable text: title first, then body.
 *
 * Every text consumer — the keyword hard filter, the keyword hit counters, the
 * intent classifier, the reply drafter — MUST go through this. The title used
 * to be concatenated into postContent by each scanner, so reading postContent
 * alone was equivalent; now that it is a column of its own, reading postContent
 * alone silently drops a Quora question or a Reddit headline from the match,
 * and a post whose keyword only appears in its title stops being an
 * opportunity at all.
 */
export function postSearchText(
  post: Pick<RawPost, 'title' | 'postContent'>
): string {
  const title = (post.title ?? '').trim();
  const body = post.postContent ?? '';
  if (!title) return body;
  return body ? `${title}\n${body}` : title;
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export function scorePost(
  post: RawPost,
  keywords: Pick<EngageKeyword, 'keyword' | 'type' | 'enabled'>[]
): ScoredPost | null {
  // Layer 1: keyword hard filter — must hit at least one enabled keyword,
  // exactly or loosely (see matchKeywordStrength).
  const searchText = postSearchText(post);
  const hits = keywords
    .filter((k) => k.enabled)
    .map((k) => ({ keyword: k, strength: matchKeywordStrength(searchText, k.keyword) }))
    .filter(
      (h): h is { keyword: (typeof keywords)[number]; strength: KeywordMatchStrength } =>
        h.strength !== null
    );
  if (hits.length === 0) return null;

  const scoreKeyword = computeKeywordScore(
    hits.map((h) => ({ type: h.keyword.type, strength: h.strength }))
  );
  const scoreHeat = (() => {
    switch (post.platform) {
      case 'x':
        return computeXHeatScore(post);
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
  // Authority: X-family uses the post author's real follower count; community
  // platforms (Reddit/etc.) use the CHANNEL audience size (subreddit_subscribers),
  // which the scan listing carries for free — no per-author lookup. The "this
  // community is on my monitored list" signal is separate (scoreTracked +5).
  const scoreAuthority = ['x', 'threads', 'mastodon', 'bluesky'].includes(post.platform)
    ? computeXAuthorityScore(post.authorFollowers ?? null)
    : computeCommunityAuthorityScore(post.channelFollowers ?? null);
  const scoreRecency = computeRecencyScore(post.postPublishedAt);
  const scoreTracked = post.isFromTrackedAccount ? 5 : 0;
  // Ceiling is 105, not 100, and that is deliberate: the four base dimensions
  // (keyword 35 + heat 45 + authority 15 + recency 5) already sum to 100, and
  // scoreTracked is a +5 bonus stacked on top of a perfect base — a post that
  // maxes out every dimension scores 105. Do not "fix" this with a min(…, 100)
  // clamp: it would collapse tracked and non-tracked perfect posts onto the
  // same total and silently shift every stored score against the >=60 ingest
  // gate and the feed's default min-score.
  const score =
    scoreKeyword + scoreHeat + scoreAuthority + scoreRecency + scoreTracked;

  return {
    ...post,
    score,
    scoreKeyword,
    matchedKeywords: hits.map((h) => h.keyword.keyword),
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

// Exported so the matchedKeywords backfill script reuses the EXACT same match
// semantics as live scoring (word-boundary for ASCII, substring for CJK) —
// re-implementing it in the script would risk drift between scan-time and
// backfill-time keyword hits.
export function postMatchesKeyword(content: string, keyword: string): boolean {
  return matchKeywordStrength(content, keyword) !== null;
}

export type KeywordMatchStrength = 'exact' | 'loose';

/**
 * How strongly `content` hits `keyword`:
 *  - 'exact' — the literal phrase (space/hyphen/underscore interchangeable,
 *              see exactPhraseMatches), or one of its abbreviation/expansion
 *              equivalents (the repo-root keyword-abbreviations.json / the
 *              auto-derived acronym) — those are the SAME term, just spelled
 *              differently, never a weaker signal.
 *  - 'loose' — only a same-root English inflection of the keyword's last
 *              word (see loosePattern) — the configured phrase itself never
 *              appears.
 *  -  null   — no hit at all.
 *
 * A LinkedIn search for "ai agents" routinely surfaces posts that only ever
 * write "AI agent" (singular), and an "ai governance" scan misses posts that
 * spell out "Model Context Protocol" instead of "MCP" — on-topic both times,
 * but not the exact string a plain substring test requires. Rejecting those
 * outright was dropping most of a keyword's real hits, one lease at a time,
 * forever (a scan never retries a post it already saw). 'loose' hits still
 * count, just at a reduced keyword weight (see computeKeywordScore) instead
 * of either extreme — reject, or score them the same as a real exact hit.
 */
export function matchKeywordStrength(
  content: string,
  keyword: string
): KeywordMatchStrength | null {
  if (exactPhraseMatches(content, keyword)) return 'exact';
  for (const variant of keywordVariants(keyword)) {
    if (exactPhraseMatches(content, variant)) return 'exact';
  }
  return looseSuffixMatches(content, keyword) ? 'loose' : null;
}

function exactPhraseMatches(content: string, phrase: string): boolean {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // A space INSIDE a multi-word phrase also matches a hyphen/dash/underscore
  // joiner: the same phrase is spelled both ways in the wild, and the platform
  // search that surfaced the post does not distinguish them. A Quora scan for
  // "open source AI" came back with ten answers, six of them on-topic, but only
  // the two that happened to use a literal space were kept — "open-source AI"
  // was rejected four times over purely on the hyphen.
  const flexible = escaped.replace(/\s+/g, '[\\s\\-–—_]+');
  // For ASCII phrases, keep \b boundaries to prevent "AI" matching "rail".
  // For phrases containing any non-ASCII character (CJK, accented, emoji),
  // do a case-insensitive substring match. CJK text has no whitespace-based
  // word boundaries, and \b is ASCII-only — using either \b or \p{L}-aware
  // lookarounds on mixed Chinese content (e.g. "SEO媒体" inside "推荐SEO媒体") rejects
  // legitimate hits. Substring is the conventional match semantics for CJK.
  const isAscii = /^[\x00-\x7F]+$/.test(phrase);
  return isAscii
    ? new RegExp(`\\b${flexible}\\b`, 'i').test(content)
    : new RegExp(flexible, 'i').test(content);
}

// ─── Abbreviation / expansion equivalents ────────────────────────────────────

// The table itself lives in keyword-abbreviations.json at the REPO ROOT
// (hot-reloaded by content hash, see keyword-abbreviations-loader.ts) rather
// than here, so adding a term is a data-file edit reviewed on its own, not a
// diff to this scoring logic. It is maintained by hand, not inferred: an
// abbreviation is ambiguous outside its own domain ("AI" is never anything
// but "artificial intelligence" here, but "MCP" or "RAG" could easily mean
// something else in a different industry), so it is scoped to the
// AI/dev-tooling vocabulary this product's own keyword configs actually draw
// from — not a general-purpose dictionary. A wrong guess there would
// silently match an unrelated post, so it stays short and reviewed rather
// than broad.

/**
 * Every equivalent phrase for `keyword` (never including `keyword` itself):
 * lookups from the abbreviations table above, plus an acronym mechanically
 * derived from `keyword` when it is itself a multi-word phrase ("model
 * context protocol" → "mcp"). Only that direction is derivable automatically
 * — an acronym can be spelled out only one way, but a bare acronym could
 * stand for many phrases, which is why the reverse direction needs the
 * hand-maintained table instead.
 */
// A 2-letter acronym collides with real English words far too often to be
// safe unconditionally ("open source" → "os", "day one" → "do" — both would
// then count ANY mention of an operating system, or the word "do", as an
// exact hit for a completely unrelated keyword). Requiring 3+ letters (so
// 3+ words) cuts the collision rate sharply; STOP_ACRONYMS is a second net
// under that for the handful of common short words that still happen to
// land on a real 3-letter word ("the", "for", …) if some future keyword's
// initials spell one out.
const STOP_ACRONYMS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'has',
  'was', 'one', 'our', 'out', 'day', 'get', 'him', 'his', 'how',
  'man', 'new', 'now', 'old', 'see', 'two', 'way', 'who', 'boy', 'did',
  'its', 'let', 'put', 'say', 'she', 'too', 'use',
]);

function keywordVariants(keyword: string): string[] {
  const lower = keyword.trim().toLowerCase();
  const variants = [...(getKeywordAbbreviations()[lower] ?? [])];
  const words = lower.split(/[\s\-–—_]+/).filter(Boolean);
  if (words.length >= 3) {
    const acronym = words.map((w) => w[0]).join('');
    if (acronym.length >= 3 && !STOP_ACRONYMS.has(acronym)) {
      variants.push(acronym);
    }
  }
  return variants;
}

// ─── Loose (inflection-only) matching ────────────────────────────────────────

/**
 * True for a word that is itself an abbreviation/initialism — inflecting one
 * ("mcps", "aiing") is meaningless, so loose matching skips it entirely
 * (keywordVariants above is the only widening an abbreviation keyword gets).
 * Three signals, case-insensitively: it's a configured abbreviation-table
 * entry ("rag" is one whether typed upper- or lower-case — the ORIGINAL
 * all-caps-only check missed a lower-case config entirely); all-caps as
 * typed; or short with no vowel. None of this is reachable for anything
 * loosePattern would touch anyway once LOOSE_MIN_WORD_LENGTH excludes it,
 * but a keyword this short should never even reach the stemming logic below.
 */
function looksLikeAbbreviation(word: string): boolean {
  const lower = word.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(getKeywordAbbreviations(), lower)) {
    return true;
  }
  if (/^[a-z0-9]+$/.test(lower) && word === word.toUpperCase()) return true;
  return word.length <= 4 && !/[aeiou]/i.test(word);
}

// Below this length, stripping a word down to its stem is too likely to land
// on an unrelated real word rather than a spelling variant of the SAME word:
// "rate" → stem "rat" → "rat"+"ion" = "ration" (a real, unrelated word);
// "use" → stem "us" → the bare stem "us" is already a real, unrelated word.
// Every case that motivated loose matching (agent/agents, govern/governing)
// clears this comfortably; short words just don't get the widening.
const LOOSE_MIN_WORD_LENGTH = 5;

/**
 * A same-root English inflection of `word`: plural/singular (agent/agents)
 * and verb forms (govern/governs/governing/governed). Built by stripping
 * `word`'s own trailing s/es (if any) down to a stem, then allowing a small,
 * purely-inflectional suffix set back onto it. Deliberately NOT a stemmer
 * for DERIVATIONAL forms (govern→governance, regulate→regulation): dropping
 * a trailing "e" and adding "-ance"/"-ation"/"-ion" back covered those, but
 * the same mechanism is what turns "rate" into "ration" — a derived form's
 * stem collides with unrelated real words far more often than a plain
 * plural/tense stem does, so that coverage was cut rather than fenced
 * further; govern/governing/governed still match, governance no longer
 * does. Returns null for a word too short to stem safely — see
 * LOOSE_MIN_WORD_LENGTH — and no general dictionary or irregular forms
 * either way, so any match can only ever be a spelling variant of THIS
 * word, never a different word that happens to share a stem.
 */
function loosePattern(word: string): string | null {
  if (word.length < LOOSE_MIN_WORD_LENGTH) return null;
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let stem = escaped;
  if (/[^aeiou]es$/i.test(stem)) stem = stem.slice(0, -2);
  else if (/s$/i.test(stem) && !/ss$/i.test(stem)) stem = stem.slice(0, -1);
  return `${stem}(?:s|es|ed|ing)?`;
}

/**
 * Loose match: every word but the LAST stays an exact, literal token (the
 * "open source AI" fixture must still reject "open sourcing AI" — only
 * "source" itself gates that, and it is not the last word), and the last
 * word is widened via loosePattern. ASCII keywords only, same reasoning as
 * exactPhraseMatches: CJK has no word-boundary/inflection concept this
 * suffix logic applies to.
 */
function looseSuffixMatches(content: string, keyword: string): boolean {
  if (!/^[\x00-\x7F]+$/.test(keyword)) return false;
  const words = keyword.trim().split(/[\s\-–—_]+/).filter(Boolean);
  const lastWord = words[words.length - 1];
  if (!lastWord || looksLikeAbbreviation(lastWord)) return false;
  const lastPattern = loosePattern(lastWord);
  if (!lastPattern) return false;
  const leadingWords = words
    .slice(0, -1)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = [...leadingWords, lastPattern].join('[\\s\\-–—_]+');
  return new RegExp(`\\b${pattern}\\b`, 'i').test(content);
}

// Roughly half an exact hit: a same-root inflection or an abbreviation/
// expansion equivalent (the latter still scores EXACT — see
// matchKeywordStrength) is real signal, but not the literal phrase the org
// configured, so it should not compete on equal footing with a post that
// used the exact keyword.
const EXACT_KEYWORD_SCORE = 15;
const LOOSE_KEYWORD_SCORE = 7;

function computeKeywordScore(
  hits: Array<Pick<EngageKeyword, 'type'> & { strength: KeywordMatchStrength }>
): number {
  const base = Math.min(
    hits.reduce(
      (sum, h) =>
        sum + (h.strength === 'exact' ? EXACT_KEYWORD_SCORE : LOOSE_KEYWORD_SCORE),
      0
    ),
    35
  );
  const hasBrand = hits.some((k) => k.type === 'BRAND');
  const hasCompetitor = hits.some((k) => k.type === 'COMPETITOR');
  return Math.min(base + (hasBrand ? 5 : 0) + (hasCompetitor ? 3 : 0), 35);
}

// ─── Heat scoring ─────────────────────────────────────────────────────────────

// X — views (30 points) + weighted engagement (20 points)
function computeXHeatScore(post: RawPost): number {
  const views = post.metricViews;
  const viewScore =
    views > 50_000 ? 30 :
    views > 20_000 ? 25 :
    views > 5_000 ? 19 :
    views > 1_000 ? 12 :
    views > 300 ? 6 : 2;

  const engagement =
    post.metricLikes +
    post.metricReplies * 3 +
    post.metricRetweets * 2 +
    post.metricQuotes * 2;
  const engagementScore =
    engagement > 2_000 ? 20 :
    engagement > 1_000 ? 15 :
    engagement > 300 ? 10 :
    engagement > 80 ? 5 : 2;

  return viewScore + engagementScore;
}

// Threads, Mastodon, Bluesky — engagement-based (no view counts)
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

// Reddit, Quora and the other community platforms — upvote score + comments,
// plus shares where the platform exposes them. Reddit and X pin metricShares to
// 0 and the article platforms never set it, so today the share term only moves
// Quora, whose answer cards carry a real reshare counter.
function computeCommunityHeatScore(post: RawPost): number {
  // Clamp metricScore to 0 — highly downvoted posts should not produce negative heat
  const score = Math.max(post.metricScore ?? 0, 0);
  const heat =
    score * (post.metricUpvoteRatio ?? 1) +
    (post.metricComments ?? 0) * 2 +
    (post.metricShares ?? 0) * 3;
  if (heat > 800) return 45;
  if (heat > 400) return 33;
  if (heat > 100) return 23;
  if (heat > 30) return 12;
  return 4;
}

// ─── Authority scoring ────────────────────────────────────────────────────────

// X-family account authority — the post author's own follower count.
function computeXAuthorityScore(followers: number | null): number {
  if (!followers) return 2;
  if (followers > 50_000) return 15;
  if (followers > 10_000) return 11;
  if (followers > 1_000) return 6;
  return 2;
}

// Community-platform authority — the CHANNEL audience size (Reddit subreddit
// members, YouTube subscribers, etc.), not the individual author's followers.
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
