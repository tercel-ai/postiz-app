/**
 * Can reddit.provider.ts actually reach oauth.reddit.com from this host?
 *
 * That provider is the API publishing route: post(), comment(), media upload,
 * /api/v1/me and analytics all call `this.fetch('https://oauth.reddit.com/...')`,
 * which lands on the base class's plain `globalThis.fetch` (social.abstract.ts)
 * with one header of its own — REDDIT_USER_AGENT.
 *
 * A previous probe found the oauth host returning an HTML block page from this
 * deployment while www.reddit.com returned JSON through the same proxy. This
 * pins down WHICH of the differences is responsible, because they were never
 * varied independently:
 *
 *   - LOID      with vs without. The decisive one, and the one an earlier
 *               version of this script forgot: Reddit's WAF refuses EVERY caller
 *               that has no loid cookie, so a run without it returns the same
 *               403 for every host and cannot tell a blocked endpoint from a
 *               reachable one. reddit.provider.ts sends no loid, so the
 *               "NO loid" rows are what production does today.
 *   - HOST      oauth.reddit.com vs www.reddit.com (different IP-reputation rules)
 *   - UA        the browser UA the provider now sends vs the Reddit-documented
 *               `<platform>:<app id>:<version> (by /u/<user>)` format it used to.
 *   - TRANSPORT globalThis.fetch (what the provider uses, subject to whatever
 *               setGlobalDispatcher does to it) vs an explicit npm-undici
 *               ProxyAgent (what redditPublicGet uses, which demonstrably works)
 *
 * NO TOKEN IS NEEDED and none is read. The question is whether the request is
 * refused BEFORE authentication is considered, and the two answers are easy to
 * tell apart:
 *
 *   JSON body (401/403 {"message":...})  → we REACHED Reddit. The host is fine;
 *                                          only the credential would be at issue.
 *   HTML body (any status, incl. 200)    → we were BLOCKED. Reddit never looked
 *                                          at the request. No token would help.
 *
 * Read-only: every endpoint probed is a GET or an unauthenticated POST that
 * cannot create anything (no token ⇒ Reddit rejects before acting).
 *
 * Usage (on the server, from the repo root):
 *   npx tsx scripts/diagnose-reddit-provider.ts
 */
import * as dotenv from 'dotenv';
dotenv.config();

// Exactly as apps/backend/src/main.ts does, before any outbound request — the
// provider inherits whatever this installs.
import { setupHttpDispatcher } from '../libraries/helpers/src/proxy/setup-dispatcher';
setupHttpDispatcher();

import { ProxyAgent, request } from 'undici';
import {
  getRedditLoidCookie,
  REDDIT_BROWSER_UA,
} from '../libraries/nestjs-libraries/src/engage/reddit-loid';

// What reddit.provider.ts actually sends now: the shared browser UA.
const PROVIDER_UA = process.env.REDDIT_USER_AGENT || REDDIT_BROWSER_UA;
// The format Reddit's API docs (and its block page) ask for, kept purely as the
// comparison arm. It used to be the provider's default and was changed because
// it self-identifies as a script and names an account — the exact shape
// anti-abuse scoring keys on. This row shows whether that trade is real.
const SCRIPT_UA = 'web:postiz:v1.0 (by /u/postiz-app)';

const PROXY_URL =
  process.env.REDDIT_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;

interface Probe {
  status: number | 'ERR';
  body: string;
  note: string;
}

/**
 * The verdict that matters: did Reddit ANSWER us, or block us before it looked?
 * A JSON body — even an error one — means the request was evaluated.
 */
function verdict(p: Probe): string {
  if (p.status === 'ERR') return `ERR ${p.note}`;
  const body = p.body.trim();
  if (body.startsWith('{') || body.startsWith('[')) {
    try {
      const j = JSON.parse(body);
      const summary =
        j?.message ?? j?.error ?? j?.json?.errors?.[0]?.[1] ?? Object.keys(j).slice(0, 4).join(',');
      return `${p.status} REACHED — json (${String(summary).slice(0, 60)})`;
    } catch {
      /* fall through to the HTML classifiers */
    }
  }
  if (/whoa there, pardner/i.test(body)) {
    return `${p.status} BLOCKED — Reddit IP policy page (len=${body.length})`;
  }
  if (/network security|Imperva|_Incapsula_/i.test(body)) {
    return `${p.status} BLOCKED — Imperva WAF (len=${body.length})`;
  }
  return `${p.status} BLOCKED? — non-json (len=${body.length}) "${body.slice(0, 60).replace(/\s+/g, ' ')}"`;
}

/** The provider's transport: plain globalThis.fetch, one UA header. */
async function viaProviderFetch(
  url: string,
  ua: string,
  cookie?: string | null
): Promise<Probe> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': ua, ...(cookie ? { Cookie: cookie } : {}) },
      signal: AbortSignal.timeout(20_000),
    });
    return { status: res.status, body: await res.text(), note: '' };
  } catch (e) {
    return { status: 'ERR', body: '', note: (e as Error).message };
  }
}

/** redditPublicGet's transport: npm undici with an explicit ProxyAgent. */
async function viaExplicitProxy(
  url: string,
  ua: string,
  cookie?: string | null
): Promise<Probe> {
  if (!PROXY_URL) return { status: 'ERR', body: '', note: 'no proxy configured' };
  const agent = new ProxyAgent(PROXY_URL);
  try {
    const res = await request(url, {
      headers: { 'User-Agent': ua, ...(cookie ? { Cookie: cookie } : {}) },
      dispatcher: agent,
      headersTimeout: 20_000,
      bodyTimeout: 20_000,
    });
    return { status: res.statusCode, body: await res.body.text(), note: '' };
  } catch (e) {
    return { status: 'ERR', body: '', note: (e as Error).message };
  } finally {
    await agent.close().catch(() => undefined);
  }
}

// /api/v1/me is the cheapest oauth endpoint and the one EVERY provider path
// starts from (authenticate, refreshToken and the analytics pass all call it),
// so if it is blocked the whole provider is. www.reddit.com/api/v1/me.json is
// the control: same question, host that is known to work.
const TARGETS: Array<[string, string]> = [
  ['oauth /api/v1/me', 'https://oauth.reddit.com/api/v1/me'],
  ['oauth /api/submit', 'https://oauth.reddit.com/api/submit'],
  ['www  /api/v1/me.json', 'https://www.reddit.com/api/v1/me.json'],
];

async function main() {
  console.log('=== reddit.provider.ts route diagnostic ===');
  console.log('REDDIT_PROXY  :', PROXY_URL ? '(set)' : '(none)');
  console.log('provider UA   :', PROVIDER_UA);
  console.log('(no token is used — we are testing reachability, not auth)');

  // The loid is its OWN dimension, and the most important one: Reddit's WAF
  // refuses every caller without it, so a run that omits it returns an
  // identical 403 for every host and makes a reachable endpoint
  // indistinguishable from a blocked one. The provider does NOT send a loid
  // (its fetch override injects only a User-Agent), so the "no loid" rows are
  // what production actually does — and the "loid" rows show what it would get
  // if it did.
  const loid = await getRedditLoidCookie();
  console.log('loid          :', loid ? `minted (len=${loid.length})` : 'NOT minted');
  console.log();

  for (const [label, url] of TARGETS) {
    console.log(`── ${label} ──`);
    console.log(
      '  fetch + providerUA, NO loid  (= production)  →',
      verdict(await viaProviderFetch(url, PROVIDER_UA))
    );
    console.log(
      '  fetch + providerUA, loid                     →',
      verdict(await viaProviderFetch(url, PROVIDER_UA, loid))
    );
    console.log(
      '  fetch + scriptUA,   loid  (old default)      →',
      verdict(await viaProviderFetch(url, SCRIPT_UA, loid))
    );
    console.log(
      '  explicit proxy + providerUA, loid            →',
      verdict(await viaExplicitProxy(url, PROVIDER_UA, loid))
    );
  }

  console.log('\n=== How to read this ===');
  console.log('FIRST check the www control rows. If even those are BLOCKED, the');
  console.log('    run proves nothing — the exit IP is being refused outright');
  console.log('    right now. Re-run; residential exits rotate.');
  console.log('');
  console.log('NO-loid blocked but loid REACHED (on any host)');
  console.log('    → the missing loid is what stops the provider, not the host or');
  console.log('      the UA. Fix: send the loid from the provider, the same way');
  console.log('      redditPublicGet does.');
  console.log('oauth blocked WITH loid but www reached WITH loid');
  console.log('    → Reddit refuses oauth.reddit.com from this exit regardless.');
  console.log('      API publishing cannot work from this host; Reddit posts must');
  console.log('      go out through the browser extension.');
  console.log('oauth REACHED (json 401/403) with loid');
  console.log('    → the host is fine and only the credential is at issue; the');
  console.log('      provider is viable once it sends a loid.');
}

main().catch((e) => {
  console.error('diagnostic failed:', e);
  process.exit(1);
});
