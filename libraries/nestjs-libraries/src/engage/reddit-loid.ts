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

import { Agent, Dispatcher, ProxyAgent, request } from 'undici';
import { hostname } from 'os';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';
import {
  recordRedditEgressFailure,
  recordRedditEgressSuccess,
  redditBackendReadBlockedReason,
  RedditEgressUnavailableError,
} from '@gitroom/nestjs-libraries/engage/reddit-egress';

interface LoidCache {
  cookie: string; // e.g. "loid=000000002fl2...".
  expiresAt: number; // epoch ms
}

// Direct (no-proxy) dispatcher, and the Reddit proxy dispatcher (from
// REDDIT_PROXY, falling back to the general proxy). We use undici's request()
// with an explicit `dispatcher` for all Reddit calls: fetch() in this undici
// version mishandles a per-call `dispatcher`, while request() honours it
// reliably. Both are lazy singletons (env is read on first use, after dotenv).
let _directAgent: Agent | null = null;
function directAgent(): Agent {
  if (!_directAgent) _directAgent = new Agent();
  return _directAgent;
}

function redditProxyUrl(): string | undefined {
  return (
    process.env.REDDIT_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY
  );
}

/**
 * A FRESH ProxyAgent, or null when no proxy is configured.
 *
 * The retry ladder in redditPublicGet exists to rotate the exit IP of a
 * rotating residential proxy, and its comment used to claim that "each retry is
 * a fresh connection". It was not: undici pools connections per Dispatcher, so
 * every attempt through the shared agent above reused the one open CONNECT
 * tunnel and therefore the SAME exit IP. Measured directly against the
 * configured proxy — four attempts, one IP (111.92.124.162) every time — which
 * made the whole 403/429 ladder pure added latency.
 *
 * Building a new agent per attempt is what actually re-runs CONNECT and asks
 * the provider for a new exit. The caller closes each one; a leaked agent would
 * hold its socket open for the pool's keep-alive window.
 */
function freshRedditProxyAgent(): Dispatcher | null {
  const url = redditProxyUrl();
  return url ? new ProxyAgent(url) : null;
}

// Tiered-retry knobs for the proxy → rotate-IP → direct strategy.
const PROXY_MAX_ATTEMPTS = Math.max(
  1,
  Number(process.env.REDDIT_PROXY_MAX_RETRIES ?? 6)
);
// Flat interval between proxy retries (each retry is a fresh exit IP).
const PROXY_RETRY_BACKOFF_MS = Number(
  process.env.REDDIT_PROXY_RETRY_BACKOFF_MS ?? 1000
);
// Statuses that mean "this exit IP is blocked/throttled" — worth rotating IP for.
const BLOCKED_STATUSES = new Set([403, 429]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Errors that mean "the proxy is unreachable or too slow" — both warrant going
// direct rather than retrying the proxy. Timeouts are included: a slow proxy
// won't get faster on retry, so we bail to a direct connection immediately.
function isConnectionError(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string }; message?: string };
  const code = e?.code ?? e?.cause?.code;
  return (
    !!code &&
    [
      'ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT',
      'ECONNRESET', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
      'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
    ].includes(code)
  );
}

// undici's ProxyAgent rejects with this when the upstream proxy refuses the
// CONNECT tunnel — most commonly 407 (Proxy Authentication Required), but any
// non-200 CONNECT response. The proxy itself is the problem (bad/missing creds,
// misconfig), so — like a connection error — we bail to a DIRECT connection
// instead of failing the whole read. Matched by message because undici surfaces
// it as a plain Error without a stable `code`.
function isProxyError(err: unknown): boolean {
  const e = err as { message?: string; cause?: { message?: string } };
  const msg = `${e?.message ?? ''} ${e?.cause?.message ?? ''}`;
  return /Proxy response \(\d+\)/i.test(msg) || /HTTP Tunneling/i.test(msg);
}

let _cache: LoidCache | null = null;
let _inflight: Promise<string | null> | null = null;

const REFRESH_MS = Number(process.env.REDDIT_LOID_TTL_MS ?? 6 * 60 * 60 * 1000); // 6h
const REFRESH_SECONDS = Math.max(1, Math.floor(REFRESH_MS / 1000));
const MINT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// ── L2: per-server shared loid cache (Redis) ───────────────────────────────
// The in-memory _cache above is L1 (per process). This is L2: a host-scoped copy
// in Redis so every process on this server shares ONE loid instead of each
// cold-minting its own. Keyed by hostname() → per-server isolation: a loid that
// gets flagged on one host re-mints there without disturbing the rest of the
// fleet. When REDIS_URL is unset, ioRedis is an in-memory stub and this layer is
// effectively a no-op (the L1 behaviour is preserved). Every call is wrapped so a
// Redis outage degrades to L1-only — never throws into the read path.
const LOID_REDIS_KEY = `postiz:reddit:loid:${hostname()}`;

async function readSharedLoid(): Promise<LoidCache | null> {
  try {
    const raw = await ioRedis.get(LOID_REDIS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw as string) as LoidCache;
    if (parsed?.cookie && parsed.expiresAt > Date.now()) return parsed;
    return null;
  } catch {
    return null; // Redis unavailable → behave as L1-only
  }
}

async function writeSharedLoid(entry: LoidCache): Promise<void> {
  try {
    // EX REFRESH_SECONDS so a stale shared loid self-expires even if no process
    // ever hits a 403 to evict it (the proactive upper bound).
    await ioRedis.set(LOID_REDIS_KEY, JSON.stringify(entry), 'EX', REFRESH_SECONDS);
  } catch {
    /* Redis unavailable → L1 still serves this process */
  }
}

async function deleteSharedLoid(): Promise<void> {
  try {
    await ioRedis.del(LOID_REDIS_KEY);
  } catch {
    /* Redis unavailable → nothing shared to drop */
  }
}

/** Extracts the `loid=...` cookie from a request()'s set-cookie response header. */
function extractLoid(setCookie: string | string[] | undefined): string | null {
  const setCookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
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
  // L2: the per-server shared copy — lets a freshly started/restarted process
  // reuse the host's existing loid instead of paying a cold mint.
  const shared = await readSharedLoid();
  if (shared) {
    _cache = shared;
    return shared.cookie;
  }
  if (_inflight) return _inflight;

  _inflight = (async () => {
    try {
      // Re-check L2 inside the mint section: another process on this host may have
      // minted while we waited — adopt theirs rather than minting a duplicate.
      const raced = await readSharedLoid();
      if (raced) {
        _cache = raced;
        return raced.cookie;
      }
      // POST is handled by snooserv behind the WAF; the response status is
      // irrelevant (it 401/403s our grant) — we only want the loid it sets. The
      // primary attempt uses the global dispatcher (proxy when configured); if
      // the proxy is unreachable, retry once directly so loid (and thus all
      // reddit reads) survive a dead proxy.
      const mint = (dispatcher?: Agent) =>
        request('https://www.reddit.com/api/v1/access_token', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': MINT_UA,
          },
          body: 'grant_type=client_credentials',
          headersTimeout: 10_000,
          bodyTimeout: 10_000,
          ...(dispatcher ? { dispatcher } : {}),
        });

      let res: Awaited<ReturnType<typeof request>>;
      try {
        res = await mint();
      } catch (err) {
        const cause = (err as { cause?: unknown })?.cause ?? err;
        // A dead proxy OR a 407/CONNECT-tunnel rejection both warrant retrying
        // the mint directly, so loid (and thus all reddit reads) survive it.
        if (!isConnectionError(cause) && !isProxyError(err)) throw err;
        res = await mint(directAgent());
      }

      const loid = extractLoid(res.headers['set-cookie']);
      // Drain the body so the connection is released back to the pool.
      await res.body.text().catch(() => undefined);

      if (loid) {
        const entry: LoidCache = { cookie: loid, expiresAt: Date.now() + REFRESH_MS };
        _cache = entry;
        await writeSharedLoid(entry); // share the fresh loid with the rest of this host
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
 * Drops BOTH cache layers so the next getRedditLoidCookie() re-mints. Call this
 * when a request still returns 403 despite carrying the cookie (the id was
 * rotated/flagged by Reddit BEFORE its TTL elapsed — a value Redis still holds).
 *
 * Evicting L2 (the shared Redis key) is REQUIRED, not optional: if only L1 were
 * cleared, the very next getRedditLoidCookie() would read the still-cached bad
 * loid back from L2 and loop on 403 forever. Awaiting the DEL guarantees the
 * subsequent re-mint misses both layers and fetches a genuinely fresh loid.
 */
export async function clearRedditLoidCache(): Promise<void> {
  _cache = null;
  await deleteSharedLoid();
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

/** Minimal response shape returned by redditPublicGet (a subset of fetch's Response). */
export interface RedditResponse {
  status: number;
  ok: boolean;
  /** Resolves the response body as text. */
  text(): Promise<string>;
  /** True when the result came from the direct (proxy-bypassing) fallback. */
  viaDirect: boolean;
}

/** For tests: lets a caller inject fake dispatchers / header builder / knobs. */
export interface RedditGetDeps {
  proxy?: Dispatcher | null;
  direct?: Dispatcher;
  log?: (msg: string) => void;
  buildHeaders?: (extra: Record<string, string>) => Promise<Record<string, string>>;
  maxAttempts?: number;
  backoffMs?: number;
}

async function doGet(
  url: string,
  headers: Record<string, string>,
  dispatcher: Dispatcher
): Promise<{ status: number; body: string }> {
  const res = await request(url, {
    method: 'GET',
    headers,
    dispatcher,
    headersTimeout: 8_000,
    bodyTimeout: 8_000,
  });
  const body = await res.body.text();
  return { status: res.statusCode, body };
}

/**
 * GET a public Reddit URL with a tiered proxy strategy:
 *
 *   1. Proxy unreachable (connection error)      → fall back to direct immediately.
 *   2. Proxy reachable but this exit IP is blocked (403/429) → retry through the
 *      proxy up to REDDIT_PROXY_MAX_RETRIES times. Each retry is a fresh
 *      connection, so a rotating residential proxy hands out a new exit IP; the
 *      loid is re-minted between attempts too.
 *   3. Still blocked after all proxy attempts     → fall back to direct (the
 *      server's own IP + loid still clears the WAF).
 *
 * When no proxy is configured, this is a single direct request. The returned
 * object exposes status/ok/text() like a trimmed fetch Response.
 */
export async function redditPublicGet(
  url: string,
  extra: Record<string, string> = {},
  deps: RedditGetDeps = {}
): Promise<RedditResponse> {
  // Fail fast when this process already knows it has no route to Reddit. The
  // ladder below costs up to maxAttempts × (8s timeout + backoff) before it
  // reaches the same verdict, and callers that can route work to the browser
  // extension ask isRedditBackendReadAvailable() rather than paying for it.
  //
  // Skipped when a transport is injected: that is the test seam, and a caller
  // who supplies its own dispatcher has already decided what the route is. Tying
  // those calls to the ambient REDDIT_PROXY/REDDIT_EGRESS_MODE would make the
  // suite pass or fail on whether a .env happened to be loaded.
  const transportInjected = deps.proxy !== undefined || deps.direct !== undefined;
  if (!transportInjected) {
    const blocked = redditBackendReadBlockedReason();
    if (blocked) throw new RedditEgressUnavailableError(blocked);
  }

  // An explicitly injected proxy is used as given (test seam, and the only way
  // to pin one dispatcher); the default path builds a fresh agent per attempt so
  // a rotating proxy actually rotates — see freshRedditProxyAgent.
  const fixedProxy = deps.proxy !== undefined ? deps.proxy : null;
  const rotating = deps.proxy === undefined && !!redditProxyUrl();
  const direct = deps.direct ?? directAgent();
  const log = deps.log ?? ((m: string) => console.warn(m));
  const buildHeaders = deps.buildHeaders ?? redditPublicHeaders;
  const maxAttempts = Math.max(1, deps.maxAttempts ?? PROXY_MAX_ATTEMPTS);
  const backoffMs = deps.backoffMs ?? PROXY_RETRY_BACKOFF_MS;

  const wrap = (r: { status: number; body: string }, viaDirect: boolean): RedditResponse => {
    // A blocked status after the whole ladder means the egress is refused, not
    // that the resource is missing — that is breaker evidence. Any other status
    // (2xx, 404, 5xx) is Reddit answering us, which proves the route works.
    if (BLOCKED_STATUSES.has(r.status)) {
      recordRedditEgressFailure(`HTTP ${r.status} after all tiers`);
    } else {
      recordRedditEgressSuccess();
    }
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      text: async () => r.body,
      viaDirect,
    };
  };

  // No proxy at all → a single direct request (the global default path).
  if (!fixedProxy && !rotating) {
    const headers = await buildHeaders(extra);
    try {
      return wrap(await doGet(url, headers, direct), true);
    } catch (err) {
      recordRedditEgressFailure(`direct: ${(err as Error).message}`);
      throw err;
    }
  }

  let lastProxy: { status: number; body: string } | null = null;
  let reminted = false;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const headers = await buildHeaders(extra);
    // Fresh tunnel per attempt when rotating; the injected agent otherwise.
    const proxy = fixedProxy ?? freshRedditProxyAgent();
    if (!proxy) break;
    try {
      const r = await doGet(url, headers, proxy);
      if (!BLOCKED_STATUSES.has(r.status)) {
        return wrap(r, false); // 2xx, or a non-block status (404/500) — done
      }
      // Tier 2: blocked on this IP. Re-mint the loid ONCE (covers an
      // expired/flagged loid); further retries just rotate the exit IP via a
      // fresh connection — re-minting every time is wasteful.
      lastProxy = r;
      if (!reminted) {
        // Await: the DEL must land before the next buildHeaders() re-reads L2, or
        // it would pull the just-flagged loid straight back out of Redis.
        await clearRedditLoidCache();
        reminted = true;
      }
      log(
        `[reddit] proxy attempt ${attempt}/${maxAttempts} blocked (HTTP ${r.status}); rotating IP`
      );
      if (attempt < maxAttempts) await sleep(backoffMs);
    } catch (err) {
      const cause = (err as { cause?: unknown })?.cause ?? err;
      if (isConnectionError(cause) || isProxyError(err)) {
        // Tier 1: proxy unreachable, too slow, or rejecting the CONNECT tunnel
        // (e.g. 407 auth) — stop retrying it, go direct.
        log(
          `[reddit] proxy unusable (${(err as { code?: string }).code ?? (err as Error).message ?? 'proxy error'}); falling back to direct`
        );
        break;
      }
      throw err; // a non-connection error (e.g. bad URL) — surface it
    } finally {
      // Only agents built here are ours to close; an injected one belongs to the
      // caller and may be reused across calls.
      if (proxy !== fixedProxy) {
        await (proxy as { close?: () => Promise<void> }).close?.().catch(() => undefined);
      }
    }
  }

  // Tier 3 (or tier 1 break): direct fallback.
  try {
    const headers = await buildHeaders(extra);
    const r = await doGet(url, headers, direct);
    return wrap(r, true);
  } catch (err) {
    // Both routes are gone. This is the exact condition the breaker exists for,
    // and it is recorded on BOTH exits below: returning the proxy's 403 still
    // means we never reached Reddit.
    if (lastProxy) return wrap(lastProxy, false); // direct also failed — return last proxy result
    recordRedditEgressFailure(`proxy and direct both failed: ${(err as Error).message}`);
    throw err;
  }
}
