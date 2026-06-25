import { describe, it, expect, beforeAll } from 'vitest';
import { XScanAdapter } from '../scan/x-scan-adapter';
import type { ScanResult } from '../scan/platform-scan-adapter';

// ─── REAL integration test (hits the live X API) ──────────────────────────────
//
// Unlike x-scan-adapter.spec.ts (fully mocked), this file makes REAL calls to
// `GET /2/tweets/search/recent` to prove the per-account `from:<user> <keyword>`
// strategy (incl. multi-keyword OR-batching) works end-to-end against prod X.
//
// AUTH: search/recent works with an APP-ONLY bearer token. We obtain one in this
// priority order (vitest loads .env via setupFiles: ['dotenv/config']):
//   1. X_BEARER_TOKEN, if already set; else
//   2. derive it from X_API_KEY + X_API_SECRET (consumer key/secret) via
//      POST /oauth2/token (grant_type=client_credentials).
// (X_CLIENT_ID / X_CLIENT_SECRET are OAuth2 user-context creds — not used here.)
//
// Run:
//   npx vitest run x-scan-adapter.integration       # uses .env automatically
//
// SUCCESS CRITERIA (asserted below):
//   A. HTTP 200 — auth + project tier allow search/recent (401/403 fails clearly,
//      so a tier/permission problem is NOT silently read as "0 results").
//   B. NOT rate-limited → out.rate.limited === false (429 fails with reset hint).
//   C. The query sent is `from:<account> <kw-clause> -is:retweet`, where a single
//      keyword is bare and multiple keywords OR-batch into `(a OR b)`.
//   D. Every returned post is authored by the target account (case-insensitive).
//   E. (informational) how many returned posts literally contain ANY keyword — X
//      decides the match server-side, so this is logged, not hard-asserted.
//   F. 0 results is a VALID outcome (search/recent only covers ~7 days). It does
//      NOT fail the test — A/B/C still prove the integration path works.

const CASES: { account: string; keywords: string[] }[] = [
  { account: 'aipartnerup', keywords: ['apcore'] },
  { account: 'aiperceivable', keywords: ['apcore'] },
  // Multi-keyword OR: NOTE `apcore-cli` is unquoted — X may parse the hyphen as
  // the exclude operator (`apcore -cli`). This case exists to observe that live.
  { account: 'aipartnerup', keywords: ['apcore', 'apcore-cli'] },
];

const HAS_BEARER = !!process.env.X_BEARER_TOKEN;
const HAS_CONSUMER = !!(process.env.X_API_KEY && process.env.X_API_SECRET);
const CAN_AUTH = HAS_BEARER || HAS_CONSUMER;

// Exchange consumer key/secret for an app-only bearer token (OAuth2
// client_credentials). Basic auth = base64(urlencode(key):urlencode(secret)).
async function fetchAppOnlyBearer(key: string, secret: string): Promise<string> {
  const basic = Buffer.from(
    `${encodeURIComponent(key)}:${encodeURIComponent(secret)}`
  ).toString('base64');
  const res = await fetch('https://api.twitter.com/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '<unreadable>');
    throw new Error(`oauth2/token ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as { token_type?: string; access_token?: string };
  if (json.token_type !== 'bearer' || !json.access_token) {
    throw new Error(`oauth2/token unexpected response: ${JSON.stringify(json).slice(0, 200)}`);
  }
  return json.access_token;
}

// Wrap real fetch so we can hit the network AND capture the URL + HTTP status of
// the search call. Reading res.status does NOT consume the body, so the adapter
// can still parse json/text from the returned Response.
function captureFetch(): {
  fetch: typeof fetch;
  lastUrl: () => string;
  lastStatus: () => number;
} {
  let url = '';
  let status = 0;
  const wrapped = (async (input: any, init?: any) => {
    url = typeof input === 'string' ? input : String(input);
    const res = await (globalThis.fetch as any)(input, init);
    status = res.status;
    return res;
  }) as unknown as typeof fetch;
  return { fetch: wrapped, lastUrl: () => url, lastStatus: () => status };
}

// Shared bearer token for every describe in this file.
let token = '';
beforeAll(async () => {
  if (!CAN_AUTH) return;
  if (HAS_BEARER) {
    token = process.env.X_BEARER_TOKEN!;
    return;
  }
  token = await fetchAppOnlyBearer(
    process.env.X_API_KEY!,
    process.env.X_API_SECRET!
  );
  console.log('Derived app-only bearer token from X_API_KEY/X_API_SECRET.');
}, 20_000);

// X wants second-granularity RFC3339 (`...ssZ`), not the millisecond form
// `...sss Z` that toISOString() emits — strip the milliseconds.
function isoSeconds(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// Raw search/recent call (the adapter doesn't support start_time yet — we verify
// the parameter's behaviour directly before wiring it in).
async function rawSearch(
  query: string,
  startTimeIso: string | null,
  tkn: string
): Promise<{ status: number; posts: Array<{ id: string; created_at: string; text: string }> }> {
  const params = new URLSearchParams({
    query,
    max_results: '100',
    'tweet.fields': 'created_at,text',
  });
  if (startTimeIso) params.set('start_time', startTimeIso);
  const res = await fetch(
    `https://api.twitter.com/2/tweets/search/recent?${params}`,
    { headers: { Authorization: `Bearer ${tkn}` }, signal: AbortSignal.timeout(15_000) }
  );
  const json = res.ok ? ((await res.json()) as any) : null;
  return { status: res.status, posts: json?.data ?? [] };
}

describe.skipIf(!CAN_AUTH)('XScanAdapter (REAL X API — from:account keyword)', () => {
  for (const { account, keywords } of CASES) {
    const kwLabel = keywords.join(' OR ');
    it(
      `from:${account} (${kwLabel}) → only ${account}'s posts, HTTP 200, not rate-limited`,
      async () => {
        const { fetch: fetchImpl, lastUrl, lastStatus } = captureFetch();
        const adapter = new XScanAdapter({ fetchImpl });

        const out: ScanResult = await adapter.searchScoped({
          scope: { type: 'tracked', key: account },
          keywords,
          cursor: {}, // no since_id → full recent (≤7 day) window
          budget: { maxCalls: 1 }, // one page, max_results=100
          token,
          log: {
            log: (m) => console.log(`[${account}|${kwLabel}] ${m}`),
            warn: (m) => console.warn(`[${account}|${kwLabel}] ${m}`),
          },
        });

        // ── C: the query sent ──
        const sentQuery = new URL(lastUrl()).searchParams.get('query') ?? '';
        console.log(`[${account}|${kwLabel}] query sent: ${sentQuery}`);
        expect(sentQuery).toContain(`from:${account}`);
        for (const kw of keywords) expect(sentQuery).toContain(kw);
        expect(sentQuery).toContain('-is:retweet');

        // ── A: HTTP 200 (catch 401/403 tier/permission problems explicitly) ──
        if (lastStatus() !== 200) {
          throw new Error(
            `[${account}|${kwLabel}] X search returned HTTP ${lastStatus()} (not 200). ` +
              `401/403 ⇒ token invalid or project tier lacks search/recent access.`
          );
        }

        // ── B: not rate-limited ──
        if (out.rate.limited) {
          throw new Error(
            `[${account}|${kwLabel}] X API rate-limited (429). ` +
              `resetAt=${out.rate.resetAt?.toISOString() ?? 'n/a'} ` +
              `retryAfterMs=${out.rate.retryAfterMs ?? 'n/a'}.`
          );
        }
        expect(out.rate.limited).toBe(false);

        // ── Report (F: 0 is valid) ──
        console.log(
          `[${account}|${kwLabel}] returned ${out.posts.length} post(s); ` +
            `nextCursor.lastSeenExternalId=${out.nextCursor.lastSeenExternalId ?? 'null'}`
        );
        for (const p of out.posts) {
          console.log(
            `  • ${p.externalPostId} @${p.authorUsername} ` +
              `${p.postPublishedAt.toISOString()} ` +
              `likes=${p.metricLikes} replies=${p.metricReplies} rt=${p.metricRetweets} | ` +
              `${p.postContent.replace(/\s+/g, ' ').slice(0, 140)}`
          );
          console.log(`    ${p.externalPostUrl}`);
        }

        // ── D: every post is authored by the target account ──
        for (const p of out.posts) {
          expect(p.authorUsername.toLowerCase()).toBe(account.toLowerCase());
        }

        // ── E (informational): literal keyword presence (ANY keyword) ──
        const lc = keywords.map((k) => k.toLowerCase());
        const withKeyword = out.posts.filter((p) =>
          lc.some((k) => p.postContent.toLowerCase().includes(k))
        ).length;
        console.log(
          `[${account}|${kwLabel}] ${withKeyword}/${out.posts.length} post(s) literally contain a keyword.`
        );

        if (out.posts.length === 0) {
          console.warn(
            `[${account}|${kwLabel}] 0 results — valid: search/recent only covers ~7 days. ` +
              `Integration path (A+B+C) still verified.`
          );
        }
      },
      30_000 // real network: allow up to 30s
    );
  }
});

// ─── start_time freshness window (raw search/recent) ──────────────────────────
//
// Demonstrates that `start_time` (oldest, inclusive) narrows the result to a
// fresh window. We query `from:aiperceivable -is:retweet` at three windows and
// expect a strict subset relation: 3h ⊆ 24h ⊆ 7d (no start_time). This is the
// behaviour we'd wire into XScanAdapter as the freshness cap (alongside since_id).
describe.skipIf(!CAN_AUTH)('search/recent start_time window (from:aiperceivable)', () => {
  it(
    '3h ⊆ 24h ⊆ 7d (no start_time), all HTTP 200',
    async () => {
      const query = 'from:aiperceivable -is:retweet';
      const now = Date.now();
      const start3h = isoSeconds(now - 3 * 3_600_000);
      const start24h = isoSeconds(now - 24 * 3_600_000);
      const start72h = isoSeconds(now - 72 * 3_600_000);

      const r3 = await rawSearch(query, start3h, token);
      const r24 = await rawSearch(query, start24h, token);
      const r72 = await rawSearch(query, start72h, token);
      const r7d = await rawSearch(query, null, token); // no start_time → full ~7d

      for (const [label, r, start] of [
        ['3h', r3, start3h],
        ['24h', r24, start24h],
        ['72h', r72, start72h],
        ['7d', r7d, '(none)'],
      ] as const) {
        expect(r.status, `${label} HTTP`).toBe(200);
        console.log(`[start_time=${start}] window=${label}: ${r.posts.length} post(s)`);
        for (const p of r.posts) {
          console.log(`  • ${p.id} ${p.created_at} | ${p.text.replace(/\s+/g, ' ').slice(0, 100)}`);
        }
      }

      // A tighter window can never return MORE posts than a wider one.
      expect(r3.posts.length).toBeLessThanOrEqual(r24.posts.length);
      expect(r24.posts.length).toBeLessThanOrEqual(r72.posts.length);
      expect(r72.posts.length).toBeLessThanOrEqual(r7d.posts.length);

      // Every post in the 24h window must actually be within the last 24h
      // (proves start_time is an inclusive lower bound, not ignored).
      const cutoff24 = now - 24 * 3_600_000;
      for (const p of r24.posts) {
        expect(new Date(p.created_at).getTime()).toBeGreaterThanOrEqual(cutoff24);
      }
    },
    40_000
  );
});
