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
 *   - HOST      oauth.reddit.com vs www.reddit.com (different IP-reputation rules)
 *   - UA        the provider's Reddit-style UA vs a browser UA. Reddit's own
 *               block page singles out User-Agent, and the provider is the only
 *               caller that sets REDDIT_USER_AGENT, so it has never been tested.
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

// The provider's own default (reddit.provider.ts). Reddit's API docs ask for
// `<platform>:<app id>:<version> (by /u/<username>)`.
const PROVIDER_UA =
  process.env.REDDIT_USER_AGENT || 'web:postiz:v1.0 (by /u/postiz-app)';
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

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
async function viaProviderFetch(url: string, ua: string): Promise<Probe> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': ua },
      signal: AbortSignal.timeout(20_000),
    });
    return { status: res.status, body: await res.text(), note: '' };
  } catch (e) {
    return { status: 'ERR', body: '', note: (e as Error).message };
  }
}

/** redditPublicGet's transport: npm undici with an explicit ProxyAgent. */
async function viaExplicitProxy(url: string, ua: string): Promise<Probe> {
  if (!PROXY_URL) return { status: 'ERR', body: '', note: 'no proxy configured' };
  const agent = new ProxyAgent(PROXY_URL);
  try {
    const res = await request(url, {
      headers: { 'User-Agent': ua },
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
  console.log('(no token is used — we are testing reachability, not auth)\n');

  for (const [label, url] of TARGETS) {
    console.log(`── ${label} ──`);
    console.log(
      '  globalThis.fetch + provider UA  →',
      verdict(await viaProviderFetch(url, PROVIDER_UA))
    );
    console.log(
      '  globalThis.fetch + browser  UA  →',
      verdict(await viaProviderFetch(url, BROWSER_UA))
    );
    console.log(
      '  explicit proxy   + provider UA  →',
      verdict(await viaExplicitProxy(url, PROVIDER_UA))
    );
  }

  console.log('\n=== How to read this ===');
  console.log('Any row REACHED on oauth /api/v1/me');
  console.log('    → the provider CAN talk to Reddit; API publishing is viable.');
  console.log('    If only the browser-UA row reached, REDDIT_USER_AGENT is the');
  console.log('    problem — set it to a browser string and the provider works.');
  console.log('    If only the explicit-proxy row reached, the provider needs its');
  console.log('    own dispatcher (authenticate() already does this; the other');
  console.log('    methods do not).');
  console.log('Every oauth row BLOCKED but www REACHED');
  console.log('    → Reddit refuses oauth.reddit.com from this exit regardless of');
  console.log('      UA or transport. API publishing cannot work from this host;');
  console.log('      Reddit posts must go out through the browser extension.');
}

main().catch((e) => {
  console.error('diagnostic failed:', e);
  process.exit(1);
});
