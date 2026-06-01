// Reddit "loid" (logged-out id) cookie cache.
//
// Why this exists: Reddit fronts its public *.reddit.com/*.json endpoints with
// an Imperva anti-bot WAF that returns a 403 "network security" page to any
// client lacking a valid `loid` cookie — regardless of IP, User-Agent, or TLS
// fingerprint. A real browser passes because normal browsing issues a long-lived
// `loid`. We mint the same cookie cheaply: a plain POST to the OAuth
// access_token endpoint is handled by Reddit's app server (snooserv) *behind*
// the WAF, so even though it answers 403 for our grant, it still sets a usable
// `loid` in the response. Carrying that single cookie on subsequent requests
// satisfies the WAF and the .json endpoints return 200.
//
// The real loid TTL is ~400 days; we refresh far more often (default 6h) so a
// flagged/rotated id self-heals quickly. Both backend and orchestrator are
// separate processes — each keeps its own cache.

interface LoidCache {
  cookie: string; // e.g. "loid=000000002fl2...".
  expiresAt: number; // epoch ms
}

let _cache: LoidCache | null = null;
let _inflight: Promise<string | null> | null = null;

const REFRESH_MS = Number(process.env.REDDIT_LOID_TTL_MS ?? 6 * 60 * 60 * 1000); // 6h
const MINT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Extracts the `loid=...` cookie from a response's Set-Cookie headers. */
function extractLoid(res: Response): string | null {
  // undici exposes getSetCookie(); fall back to the single-header form.
  const setCookies: string[] =
    typeof (res.headers as { getSetCookie?: () => string[] }).getSetCookie === 'function'
      ? (res.headers as { getSetCookie: () => string[] }).getSetCookie()
      : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie') as string] : []);

  for (const sc of setCookies) {
    if (sc.startsWith('loid=')) {
      const value = sc.split(';')[0]; // "loid=<value>"
      if (value.length > 'loid='.length) return value;
    }
  }
  return null;
}

/**
 * Returns a cached `loid=<value>` cookie string, minting a fresh one when the
 * cache is empty or stale. Returns null if Reddit issued no loid (caller should
 * proceed without it rather than fail hard). Concurrent callers share a single
 * in-flight mint.
 */
export async function getRedditLoidCookie(): Promise<string | null> {
  if (_cache && _cache.expiresAt > Date.now()) {
    return _cache.cookie;
  }
  if (_inflight) return _inflight;

  _inflight = (async () => {
    try {
      // POST is handled by snooserv behind the WAF; the 403 body is irrelevant —
      // we only want the loid it sets. No auth header needed.
      const res = await fetch('https://www.reddit.com/api/v1/access_token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': MINT_UA,
        },
        body: 'grant_type=client_credentials',
        signal: AbortSignal.timeout(10_000),
      });
      const loid = extractLoid(res);
      if (loid) {
        _cache = { cookie: loid, expiresAt: Date.now() + REFRESH_MS };
        return loid;
      }
      return null;
    } catch {
      return null;
    } finally {
      _inflight = null;
    }
  })();

  return _inflight;
}

/**
 * Drops the cached loid so the next getRedditLoidCookie() re-mints. Call this
 * when a request still returns 403 despite carrying the cookie (the id may have
 * been rotated or flagged).
 */
export function clearRedditLoidCache(): void {
  _cache = null;
}

/**
 * Builds headers for an unauthenticated public reddit request, transparently
 * attaching the loid cookie when one is available. Pass any extra headers to
 * merge (e.g. Accept overrides).
 */
export async function redditPublicHeaders(
  extra: Record<string, string> = {}
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    'User-Agent': MINT_UA,
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    ...extra,
  };
  const loid = await getRedditLoidCookie();
  if (loid) headers['Cookie'] = loid;
  return headers;
}
