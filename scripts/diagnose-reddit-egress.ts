/**
 * Reddit EGRESS diagnostic — can this host actually read reddit.com?
 *
 * The companion to diagnose-reddit-search.ts, which covers the OAuth route and
 * treats the public .json endpoints as a control it expects to 403. That
 * expectation is the blind spot this script exists to fill: production does NOT
 * read Reddit over OAuth. With no REDDIT_CLIENT_ID/SECRET configured (the
 * common case) every backend Reddit read goes through `redditPublicGet`, whose
 * whole trick is minting a `loid` cookie that clears Reddit's Imperva WAF. A
 * bare 403 on /r/x/about.json therefore proves nothing — it is the EXPECTED
 * answer without a loid, and says nothing about whether the route works.
 *
 * So this walks the real production path, on both routes:
 *
 *   exit IP  →  mint loid (a credential-free POST; the grant is refused, the
 *               Set-Cookie is the point)  →  read the four endpoints with it
 *
 * Reading the verdicts:
 *   200 + json          route works; Reddit is readable from here.
 *   403 + [WAF page]    reached Reddit, refused. If the loid minted, the cookie
 *                       is flagged or this exit IP is blocked — rotate it.
 *   200 + NOT json      a WAF interstitial wearing a success status; same as 403.
 *   ERR ECONNRESET      never reached Reddit. Either the proxy is dead or the
 *                       hop to it is being filtered (see: if an UNCENSORED host
 *                       succeeds through the same proxy, the hop is the problem,
 *                       not the proxy).
 *   ERR Connect Timeout the host cannot route/resolve reddit.com at all.
 *
 * A route that works here is a route `redditPublicGet` can use, which is what
 * decides whether the backend resolves operation-plan subreddits itself or
 * parks them for the browser extension (see engage/reddit-egress.ts).
 *
 * Read-only. Nothing is persisted, and no credential is ever printed.
 *
 * Scope: this answers "does this host have a ROUTE to Reddit at all" — direct
 * vs proxy, exit IP, and whether a loid can be minted on each. For "which
 * ENDPOINTS answer, under what conditions" (read + write paths, loid/UA/transport
 * matrix) run scripts/diagnose-reddit-provider.ts instead.
 *
 * Usage:
 *   npx tsx scripts/diagnose-reddit-egress.ts
 *
 * Env (auto-loaded from .env):
 *   REDDIT_PROXY  optional; falls back to HTTPS_PROXY / HTTP_PROXY
 */
import * as dotenv from 'dotenv';
dotenv.config();

import { Agent, Dispatcher, ProxyAgent, request } from 'undici';

const PROXY_URL =
  process.env.REDDIT_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;

// The same UA reddit-loid.ts mints with. Kept identical on purpose: a diagnostic
// that passes with a different fingerprint than production uses is a diagnostic
// that can disagree with production.
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const TARGETS: Array<[string, string]> = [
  [
    'subreddits/search.json',
    'https://www.reddit.com/subreddits/search.json?q=mcp&limit=3&type=sr',
  ],
  ['r/ClaudeAI/about.json', 'https://www.reddit.com/r/ClaudeAI/about.json'],
  ['r/ClaudeAI/new.json', 'https://www.reddit.com/r/ClaudeAI/new.json?limit=1'],
  ['search.json (link)', 'https://www.reddit.com/search.json?q=mcp&limit=2&type=link'],
];

// A host Reddit has nothing to do with, used to tell "the proxy is dead" apart
// from "the proxy refuses reddit specifically".
const CONTROL_URL = 'https://api.ipify.org?format=json';

function maskProxy(url?: string): string {
  if (!url) return '(none)';
  try {
    const u = new URL(url);
    if (u.username) u.username = '***';
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return '(unparseable)';
  }
}

interface HttpResult {
  status: number | 'ERR';
  body: string;
  setCookie: string[];
  note: string;
}

async function http(
  url: string,
  opts: {
    method?: string;
    headers: Record<string, string>;
    body?: string;
    agent: Dispatcher;
  }
): Promise<HttpResult> {
  try {
    const res = await request(url, {
      method: (opts.method as Dispatcher.HttpMethod) || 'GET',
      headers: opts.headers,
      body: opts.body,
      dispatcher: opts.agent,
      headersTimeout: 20_000,
      bodyTimeout: 20_000,
    });
    const raw = res.headers['set-cookie'];
    return {
      status: res.statusCode,
      body: await res.body.text(),
      setCookie: Array.isArray(raw) ? raw : raw ? [String(raw)] : [],
      note: '',
    };
  } catch (err) {
    return { status: 'ERR', body: '', setCookie: [], note: (err as Error).message };
  }
}

/**
 * Exactly the mint in reddit-loid.ts: an unauthenticated POST to the token
 * endpoint. Reddit refuses the grant, but the request is handled by its app
 * server BEHIND the WAF, so the response still sets a usable loid.
 */
async function mintLoid(agent: Dispatcher): Promise<string | null> {
  const res = await http('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': UA,
    },
    body: 'grant_type=client_credentials',
    agent,
  });
  for (const sc of res.setCookie) {
    if (sc.startsWith('loid=')) {
      const value = sc.split(';')[0];
      if (value.length > 'loid='.length) return value;
    }
  }
  return null;
}

async function exitIp(agent: Dispatcher): Promise<string> {
  const r = await http(CONTROL_URL, { headers: { 'User-Agent': UA }, agent });
  if (r.status !== 200) return `unreachable (${r.status} ${r.note})`.trim();
  try {
    return String(JSON.parse(r.body).ip);
  } catch {
    return '(unparseable)';
  }
}

/** Classify a response so a WAF page cannot be mistaken for data. */
function verdict(r: HttpResult): string {
  if (r.status === 'ERR') return `ERR ${r.note}`;
  if (r.status !== 200) {
    const waf = /network security|Imperva/i.test(r.body) ? ' [WAF page]' : '';
    return `${r.status}${waf} len=${r.body.length}`;
  }
  try {
    const j = JSON.parse(r.body);
    const n = j?.data?.children?.length ?? (j?.kind === 't5' ? 1 : 0);
    return `200 OK json children=${n}`;
  } catch {
    return `200 NOT json (len=${r.body.length}) [WAF interstitial]`;
  }
}

async function runRoute(label: string, agent: Dispatcher): Promise<boolean> {
  console.log(`\n══ route: ${label} ══`);
  console.log('  exit ip      :', await exitIp(agent));

  const loid = await mintLoid(agent);
  console.log(
    '  loid minted  :',
    loid ? `yes (len=${loid.length})` : 'NO — the mint itself could not complete'
  );

  let anyOk = false;
  for (const [name, url] of TARGETS) {
    const headers: Record<string, string> = {
      'User-Agent': UA,
      Accept: 'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
    };
    if (loid) headers['Cookie'] = loid;
    const r = await http(url, { headers, agent });
    const v = verdict(r);
    if (v.startsWith('200 OK json')) anyOk = true;
    console.log(`  ${name.padEnd(26)} → ${v}`);
  }
  return anyOk;
}

async function main() {
  console.log('=== Reddit egress diagnostic (loid path — what production uses) ===');
  console.log('proxy configured :', maskProxy(PROXY_URL));

  const directOk = await runRoute('DIRECT', new Agent());

  let proxyOk = false;
  if (PROXY_URL) {
    // A FRESH agent, as redditPublicGet now builds per attempt: undici pools
    // per-Dispatcher, so reusing one would also reuse the exit IP.
    proxyOk = await runRoute('PROXY (REDDIT_PROXY)', new ProxyAgent(PROXY_URL));
  } else {
    console.log('\n(no REDDIT_PROXY / HTTPS_PROXY configured — proxy route not tested)');
  }

  console.log('\n=== Verdict ===');
  if (directOk || proxyOk) {
    const which = [directOk && 'direct', proxyOk && 'proxy'].filter(Boolean).join(' + ');
    console.log(`✅ Reddit is readable from this host via: ${which}.`);
    console.log('   redditPublicGet will work; the backend can resolve subreddits itself.');
    if (directOk && !PROXY_URL) {
      console.log('   Direct works with no proxy — set REDDIT_DIRECT_READ=true so the');
      console.log('   egress gate stops treating "no proxy" as "no route".');
    }
  } else {
    console.log('❌ No route to Reddit from this host.');
    console.log('   The backend will park operation-plan Reddit posts for the browser');
    console.log('   extension and report needsExtension on channel search — by design.');
    console.log('   To restore the backend path, fix ONE of the routes above:');
    console.log('   • ERR on the proxy but the exit ip resolved → the proxy reaches some');
    console.log('     hosts and not reddit: rotate the exit, or the hop to the proxy is');
    console.log('     being filtered (a plaintext HTTP proxy leaks the CONNECT hostname).');
    console.log('   • 403 [WAF page] with a loid → that exit IP is flagged; rotate it.');
    console.log('   • Connect Timeout on direct → DNS/routing for reddit.com is broken.');
  }
}

main().catch((e) => {
  console.error('diagnostic failed:', e);
  process.exit(1);
});
