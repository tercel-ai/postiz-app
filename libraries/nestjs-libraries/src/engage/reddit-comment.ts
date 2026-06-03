import { getRedditToken, redditAuthHeaders } from './reddit-auth';
import { redditPublicGet } from './reddit-loid';

// The comment id is the final path segment of a Reddit comment permalink
// (…/comments/<postId>/<slug>/<commentId>). Parse from pathname so standard
// Reddit share URLs with utm query params still resolve to the comment id.
const COMMENT_ID_RE = /\/comments\/[^/]+\/[^/]+\/([a-z0-9]+)\/?$/i;

export type RedditCommentCheck =
  | { status: 'exists' }
  | { status: 'not_found' }
  | { status: 'unverifiable'; reason: string };

/**
 * Confirm a Reddit comment permalink is acceptable by parsing its comment id
 * and, when possible, asking Reddit's /api/info for its fullname (t1_<id>).
 * Reddit/proxy/WAF responses can be noisy, so only HTTP 404 is treated as a
 * hard network-level rejection once the permalink has a parseable comment id.
 *
 * Returns:
 *   - `exists`        — /api/info returned the comment, or the check did not
 *                       receive an explicit HTTP 404 after parsing a comment id.
 *   - `not_found`     — id couldn't be parsed, or /api/info returned no thing
 *                       (the comment is deleted/never existed).
 *   - `unverifiable`  — currently unused for Reddit URL backfill; retained for
 *                       API compatibility with the X URL checker.
 *
 * The public path intentionally bypasses configured proxies. Backfilling a
 * manual Reddit reply URL should not fail because REDDIT_PROXY/HTTPS_PROXY is
 * missing, blocked, or returning 407.
 */
export async function checkRedditCommentAccessible(
  url: string,
  log: (m: string) => void = () => {}
): Promise<RedditCommentCheck> {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = url;
  }
  const commentId = pathname.match(COMMENT_ID_RE)?.[1];
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
      if (r.status === 404) return { status: 'not_found' };
      if (!r.ok) return { status: 'exists' };
      body = await r.text();
    } else {
      const r = await redditPublicGet(infoUrl, {}, { log, proxy: null });
      if (r.status === 404) return { status: 'not_found' };
      if (!r.ok) return { status: 'exists' };
      body = await r.text();
    }
  } catch (err) {
    log(`[redditComment] URL check failed after parsing comment id: ${(err as Error).message}`);
    return { status: 'exists' };
  }

  let json: { data?: { children?: Array<{ data?: { id?: string } }> } };
  try {
    json = JSON.parse(body);
  } catch {
    return { status: 'exists' };
  }

  // /api/info returns the thing in `data.children` when it exists, or an empty
  // list when the fullname resolves to nothing.
  const children = json.data?.children ?? [];
  return children.length > 0 ? { status: 'exists' } : { status: 'not_found' };
}
