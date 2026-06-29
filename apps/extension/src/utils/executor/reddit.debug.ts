// Debug helpers for Reddit in the Options page — parallel to x.debug.ts but
// using Reddit's public .json API with the user's session cookies (credentials:
// 'include'). No tab/interceptor needed; Reddit's WAF is cleared by the loid
// cookie that the browser carries automatically.

import { ScanIngestPost } from './executor.types';

const REDDIT_BASE = 'https://www.reddit.com';
const DEBUG_LIMIT = 25;

function toPost(p: Record<string, any>): ScanIngestPost {
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
    postPublishedAt: new Date(
      (Number(p.created_utc) || 0) * 1000
    ).toISOString(),
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
export async function debugSearchRedditKeyword(
  keyword: string
): Promise<ScanIngestPost[]> {
  const q = encodeURIComponent(keyword);
  const data = await rFetch(
    `${REDDIT_BASE}/search.json?q=${q}&sort=new&limit=${DEBUG_LIMIT}&type=link`
  );
  const children: any[] = data?.data?.children ?? [];
  return children
    .filter((c) => c.data?.subreddit_type !== 'private')
    .map((c) => toPost(c.data));
}

/**
 * ② Fetch a single Reddit post by full URL or short ID.
 *
 * Accepts:
 *  - Full URL:  https://www.reddit.com/r/sub/comments/ID/title/
 *  - Short ID:  abc123  (Reddit post ID without t3_ prefix)
 */
export async function debugFetchRedditPost(
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

/**
 * ③ Fetch a Reddit user's recent submissions, optionally filtered by keywords.
 *
 * Since Reddit search has no `from:user` operator, we fetch submitted.json and
 * apply a client-side keyword filter (same as the backend does for channel scans).
 */
export async function debugSearchRedditUser(
  username: string,
  keywords: string[]
): Promise<ScanIngestPost[]> {
  const data = await rFetch(
    `${REDDIT_BASE}/user/${encodeURIComponent(username)}/submitted.json?sort=new&limit=${DEBUG_LIMIT}`
  );
  const children: any[] = data?.data?.children ?? [];
  let posts = children
    .filter((c) => c.data?.subreddit_type !== 'private')
    .map((c) => toPost(c.data));

  if (keywords.length) {
    const lkws = keywords.map((k) => k.toLowerCase());
    posts = posts.filter((p) =>
      lkws.some((kw) => p.postContent.toLowerCase().includes(kw))
    );
  }
  return posts;
}
