import { getRedditToken, redditAuthHeaders } from './reddit-auth';
import { redditPublicGet } from './reddit-loid';

// The comment id is the final path segment of a Reddit comment permalink
// (…/comments/<postId>/<slug>/<commentId>). The caller has already format-
// validated the URL, so this only needs to pull the trailing id.
const COMMENT_ID_RE = /\/comments\/[^/]+\/[^/]+\/([a-z0-9]+)\/?$/i;

export type RedditCommentCheck =
  | { status: 'exists' }
  | { status: 'not_found' }
  | { status: 'unverifiable'; reason: string };

/**
 * Confirm a Reddit comment permalink points to a real, reachable comment by
 * asking Reddit's /api/info for its fullname (t1_<id>). Used to reject invalid
 * backfilled reply URLs before they are persisted.
 *
 * Returns:
 *   - `exists`        — /api/info returned the comment.
 *   - `not_found`     — id couldn't be parsed, or /api/info returned no thing
 *                       (the comment is deleted/never existed).
 *   - `unverifiable`  — the check itself couldn't complete (network error,
 *                       Reddit WAF 403, timeout, unparseable body). Callers in
 *                       strict mode treat this as a rejection.
 *
 * Mirrors the metrics-sync fetch path: authenticated oauth.reddit.com when an
 * app token is available, otherwise the public endpoint via redditPublicGet
 * (loid cookie + tiered proxy to clear the anti-bot WAF).
 */
export async function checkRedditCommentAccessible(
  url: string,
  log: (m: string) => void = () => {}
): Promise<RedditCommentCheck> {
  const commentId = url.match(COMMENT_ID_RE)?.[1];
  if (!commentId) return { status: 'not_found' };

  const token = await getRedditToken();
  const infoUrl = token
    ? `https://oauth.reddit.com/api/info?id=t1_${commentId}`
    : `https://www.reddit.com/api/info.json?id=t1_${commentId}`;

  let body: string;
  try {
    if (token) {
      const r = await fetch(infoUrl, {
        headers: redditAuthHeaders(token),
        signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok) return { status: 'unverifiable', reason: `HTTP ${r.status}` };
      body = await r.text();
    } else {
      const r = await redditPublicGet(infoUrl, {}, { log });
      if (!r.ok) return { status: 'unverifiable', reason: `HTTP ${r.status}` };
      body = await r.text();
    }
  } catch (err) {
    return { status: 'unverifiable', reason: (err as Error).message };
  }

  let json: { data?: { children?: Array<{ data?: { id?: string } }> } };
  try {
    json = JSON.parse(body);
  } catch {
    return { status: 'unverifiable', reason: 'unparseable response' };
  }

  // /api/info returns the thing in `data.children` when it exists, or an empty
  // list when the fullname resolves to nothing.
  const children = json.data?.children ?? [];
  return children.length > 0 ? { status: 'exists' } : { status: 'not_found' };
}
