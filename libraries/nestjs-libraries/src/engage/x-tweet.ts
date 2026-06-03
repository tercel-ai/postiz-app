// The reply tweet id is the numeric snowflake in a /status/<id> permalink. The
// caller has already format-validated the URL, so this only pulls the id.
const TWEET_ID_RE = /\/status\/(\d+)/;

export type XTweetCheck =
  | { status: 'exists' }
  | { status: 'not_found' }
  | { status: 'unverifiable'; reason: string };

/**
 * Confirm an X reply URL points to a real, reachable tweet by looking it up via
 * the X API v2 (app-only bearer). Used to reject invalid backfilled reply URLs
 * before they are persisted.
 *
 * Returns:
 *   - `exists`       — the lookup returned the tweet.
 *   - `not_found`    — id couldn't be parsed, a 404, or a 200 whose body carries
 *                      only `errors` (deleted / never existed).
 *   - `unverifiable` — the check itself couldn't complete (no bearer configured,
 *                      rate limit / 5xx, network error, timeout, unparseable
 *                      body). Strict callers treat this as a rejection.
 */
export async function checkXTweetAccessible(
  url: string,
  _log: (m: string) => void = () => {}
): Promise<XTweetCheck> {
  const tweetId = url.match(TWEET_ID_RE)?.[1];
  if (!tweetId) return { status: 'not_found' };

  const bearer = process.env.X_BEARER_TOKEN;
  if (!bearer) return { status: 'unverifiable', reason: 'X bearer token not configured' };

  try {
    const res = await fetch(`https://api.twitter.com/2/tweets/${tweetId}`, {
      headers: { Authorization: `Bearer ${bearer}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404) return { status: 'not_found' };
    if (!res.ok) return { status: 'unverifiable', reason: `HTTP ${res.status}` };

    let json: { data?: { id?: string }; errors?: Array<{ title?: string }> };
    try {
      json = (await res.json()) as typeof json;
    } catch {
      return { status: 'unverifiable', reason: 'unparseable response' };
    }
    if (json.data?.id) return { status: 'exists' };
    // X returns HTTP 200 with an `errors` array (and no `data`) for a tweet that
    // is deleted, protected, or never existed.
    return { status: 'not_found' };
  } catch (err) {
    return { status: 'unverifiable', reason: (err as Error).message };
  }
}
