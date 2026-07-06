// Browser-session Reddit collection helpers used by the Options page.
// using Reddit's public .json API with the user's session cookies (credentials:
// 'include'). No tab/interceptor needed; Reddit's WAF is cleared by the loid
// cookie that the browser carries automatically.

import { ScanIngestPost } from './executor.types';

const REDDIT_BASE = 'https://www.reddit.com';
const COLLECTION_LIMIT = 25;

// Reddit `created_utc` (epoch SECONDS) → ms, or null when absent/invalid. The
// publish time MUST come from the post itself — we never fabricate one (a `0`→1970
// fallback corrupts the stored publish date), so an undateable post is dropped.
function redditCreatedAtMs(p: Record<string, any>): number | null {
  const sec = Number(p.created_utc);
  return Number.isFinite(sec) && sec > 0 ? sec * 1000 : null;
}

function toPost(p: Record<string, any>): ScanIngestPost | null {
  const atMs = redditCreatedAtMs(p);
  if (atMs == null) return null; // undateable → drop, never fabricate a publish time
  const sub = String(p.subreddit ?? '');
  const title = String(p.title ?? '');
  const body = p.selftext ? String(p.selftext) : '';
  return {
    platform: 'reddit',
    externalPostId: String(p.id ?? ''),
    externalPostUrl: `${REDDIT_BASE}${String(p.permalink ?? '')}`,
    authorUsername: String(p.author ?? ''),
    channelId: sub,
    channelName: sub ? `r/${sub}` : undefined,
    channelFollowers:
      typeof p.subreddit_subscribers === 'number' ? p.subreddit_subscribers : 0,
    postContent: `${title}${body ? '\n' + body : ''}`.trim(),
    postPublishedAt: new Date(atMs).toISOString(),
    metricScore: typeof p.score === 'number' ? p.score : 0,
    metricUpvoteRatio:
      typeof p.upvote_ratio === 'number' ? p.upvote_ratio : undefined,
    metricComments: typeof p.num_comments === 'number' ? p.num_comments : 0,
  };
}

async function rFetch(url: string): Promise<any> {
  const res = await fetch(url, {
    credentials: 'include',
    headers: {
      Accept: 'application/json, text/javascript, */*; q=0.01',
      Referer: `${REDDIT_BASE}/`,
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Reddit HTTP ${res.status}`);
  return res.json();
}

/** ① Keyword search across all of Reddit (sort=new). */
export async function scanRedditKeyword(
  keyword: string
): Promise<ScanIngestPost[]> {
  const q = encodeURIComponent(keyword);
  const data = await rFetch(
    `${REDDIT_BASE}/search.json?q=${q}&sort=new&limit=${COLLECTION_LIMIT}&type=link`
  );
  const children: any[] = data?.data?.children ?? [];
  return children
    .filter((c) => c.data?.subreddit_type !== 'private')
    .map((c) => toPost(c.data))
    .filter((p): p is ScanIngestPost => p !== null);
}

/**
 * ② Fetch a single Reddit post by full URL or short ID.
 *
 * Accepts:
 *  - Full URL:  https://www.reddit.com/r/sub/comments/ID/title/
 *  - Short ID:  abc123  (Reddit post ID without t3_ prefix)
 */
export async function fetchRedditPost(
  urlOrId: string
): Promise<ScanIngestPost | null> {
  let apiUrl: string;
  if (urlOrId.startsWith('http')) {
    apiUrl = urlOrId.replace(/\/$/, '') + '.json?limit=1';
  } else {
    // ID only — Reddit allows /comments/{id}.json
    apiUrl = `${REDDIT_BASE}/comments/${urlOrId.replace(/^t3_/, '')}.json?limit=1`;
  }
  const data = await rFetch(apiUrl);
  // [0] = post listing, [1] = comment listing
  const postData = Array.isArray(data)
    ? data[0]?.data?.children?.[0]?.data
    : null;
  if (!postData) return null;
  return toPost(postData);
}

// The Reddit comment id is the base36 token in a comment permalink:
//   /r/<sub>/comments/<postId>/<slug-or-"comment">/<commentId>/
// Mirrors the backend's parseRedditCommentId (reddit-url.ts) so the same URL
// resolves to the same id on both sides. Returns null when the URL points at a
// post (no comment segment) — nothing to read metrics for.
const COMMENT_ID_RE = /\/comments\/[^/]+\/[^/]+\/([a-z0-9]+)\/?/;
function parseRedditCommentId(url: string): string | null {
  let path = url.trim();
  try {
    path = new URL(path).pathname;
  } catch {
    try {
      path = new URL(`https://${path}`).pathname;
    } catch {
      /* fall back to the raw string */
    }
  }
  return path.match(COMMENT_ID_RE)?.[1] ?? null;
}

/**
 * Fetch OUR posted reply's metrics — the comment's score and the number of
 * direct child replies under it. A reply is a comment (t1_), not a post (t3_),
 * so this reads the comment thread, NOT fetchRedditPost. Mirrors the backend's
 * syncRedditMetrics public path (browser session cookies clear the WAF, so no
 * loid/proxy juggling is needed here).
 *
 * @param releaseURL  The reply's permalink (comment URL we backfilled on send).
 * @returns { score, comments } or null when the URL has no comment id.
 */
export async function fetchRedditReplyMetrics(
  releaseURL: string
): Promise<{ score: number; comments: number } | null> {
  const commentId = parseRedditCommentId(releaseURL);
  if (!commentId) return null;

  // Comment-level score lives on the t1 object via /api/info.
  const infoJson = await rFetch(
    `${REDDIT_BASE}/api/info.json?id=t1_${commentId}`
  );
  const commentData = infoJson?.data?.children?.[0]?.data;
  if (!commentData) return null;
  const score =
    typeof commentData.score === 'number' ? commentData.score : 0;

  // "comments" for a reply means its direct child replies. The t1 object does
  // not carry that count, so read the comment subtree. depth MUST be >= 2: with
  // comment=<id> the target comment is the tree root (level 1), so its own
  // direct replies live at level 2 (depth=1 collapses them into a "more" stub).
  let comments = 0;
  const threadMatch = releaseURL.match(/\/r\/([^/]+)\/comments\/([a-z0-9]+)\//);
  if (threadMatch) {
    try {
      const [, subreddit, threadId] = threadMatch;
      const threadJson = await rFetch(
        `${REDDIT_BASE}/r/${subreddit}/comments/${threadId}/.json?comment=${commentId}&depth=2&limit=100`
      );
      const childReplies: any[] =
        threadJson?.[1]?.data?.children?.[0]?.data?.replies?.data?.children ??
        [];
      comments = childReplies.filter((r) => r.kind !== 'more').length;
    } catch {
      // Best-effort: a thread fetch failure leaves comments at 0; score still wrote.
    }
  }

  return { score, comments };
}

/**
 * ③ Fetch a Reddit user's recent submissions, optionally filtered by keywords.
 *
 * Since Reddit search has no `from:user` operator, we fetch submitted.json and
 * apply a client-side keyword filter (same as the backend does for channel scans).
 */
export async function scanRedditUser(
  username: string,
  keywords: string[]
): Promise<ScanIngestPost[]> {
  const data = await rFetch(
    `${REDDIT_BASE}/user/${encodeURIComponent(username)}/submitted.json?sort=new&limit=${COLLECTION_LIMIT}`
  );
  const children: any[] = data?.data?.children ?? [];
  let posts = children
    .filter((c) => c.data?.subreddit_type !== 'private')
    .map((c) => toPost(c.data))
    .filter((p): p is ScanIngestPost => p !== null);

  if (keywords.length) {
    const lkws = keywords.map((k) => k.toLowerCase());
    posts = posts.filter((p) =>
      lkws.some((kw) => p.postContent.toLowerCase().includes(kw))
    );
  }
  return posts;
}
