/**
 * Reddit subreddit-search diagnostic.
 *
 * The engage "search channels" flow returns [] because Reddit now hard-blocks
 * the unauthenticated public JSON endpoints (www/old .json) with a 403
 * "network security" page — regardless of exit IP or User-Agent. This script
 * walks every realistic access path and prints a result matrix so we can find
 * the one that actually returns subreddits:
 *
 *   1. OAuth token acquisition
 *        a. client_credentials   (needs a "script"-type app)
 *        b. installed_client     (device_id grant — works for "web"/"installed" apps)
 *      ...each tried both directly and through REDDIT_PROXY.
 *   2. Authenticated search via oauth.reddit.com using whichever token we got.
 *   3. Unauthenticated public JSON (www/old) as a control — expected to 403.
 *
 * It also varies the User-Agent (browser string vs Reddit's recommended
 * "platform:appid:version (by /u/user)" format) to answer "do we need to switch
 * the UA?" empirically.
 *
 * Read-only. Nothing is persisted.
 *
 * Usage:
 *   npx tsx scripts/diagnose-reddit-search.ts                 # query defaults to "mba"
 *   npx tsx scripts/diagnose-reddit-search.ts seo             # custom query
 *   REDDIT_PROXY=http://user:pass@host:port npx tsx scripts/diagnose-reddit-search.ts mba
 *
 * Env:
 *   REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET   from .env (auto-loaded)
 *   REDDIT_PROXY                              optional; also falls back to HTTPS_PROXY
 */
import * as dotenv from 'dotenv';
dotenv.config();

import { Agent, Dispatcher, ProxyAgent, request } from 'undici';

const QUERY = process.argv[2] || 'mba';
const CLIENT_ID = process.env.REDDIT_CLIENT_ID;
const CLIENT_SECRET = process.env.REDDIT_CLIENT_SECRET;
const PROXY_URL = process.env.REDDIT_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;

// ── User-Agent candidates ───────────────────────────────────────────────────
// Reddit's API docs ask for: <platform>:<app id>:<version> (by /u/<username>)
// A generic browser UA tends to get routed to the same anti-bot page on the
// public site; the OAuth API is more lenient but still rejects empty/blocked UAs.
const UA = {
  browser:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
  redditApi: `web:aisee-engage:1.0 (by /u/aisee_bot)`,
  current: 'AISEE-Engage/1.0', // what reddit-auth.ts uses today
} as const;

const directAgent = new Agent();
const proxyAgent: Dispatcher | null = PROXY_URL ? new ProxyAgent(PROXY_URL) : null;

function maskProxy(url?: string): string {
  if (!url) return '(none)';
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return url;
  }
}

interface Probe {
  status: number | 'ERR';
  len: number;
  note: string;
  body: string;
}

async function http(
  url: string,
  opts: {
    method?: string;
    headers: Record<string, string>;
    body?: string;
    agent: Dispatcher;
  }
): Promise<Probe> {
  try {
    const { statusCode, body } = await request(url, {
      method: (opts.method as Dispatcher.HttpMethod) || 'GET',
      headers: opts.headers,
      body: opts.body,
      dispatcher: opts.agent,
      headersTimeout: 15000,
      bodyTimeout: 15000,
    });
    const text = await body.text();
    return { status: statusCode, len: text.length, note: '', body: text };
  } catch (err) {
    return { status: 'ERR', len: 0, note: (err as Error).message, body: '' };
  }
}

// ── 1. Token acquisition ────────────────────────────────────────────────────
async function fetchToken(
  grant: 'client_credentials' | 'installed_client',
  ua: string,
  agent: Dispatcher
): Promise<{ token: string | null; probe: Probe }> {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    return { token: null, probe: { status: 'ERR', len: 0, note: 'no client id/secret', body: '' } };
  }
  const body =
    grant === 'client_credentials'
      ? 'grant_type=client_credentials'
      : 'grant_type=https://oauth.reddit.com/grants/installed_client&device_id=DO_NOT_TRACK_THIS_DEVICE';
  const probe = await http('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': ua,
    },
    body,
    agent,
  });
  let token: string | null = null;
  if (probe.status === 200) {
    try {
      token = (JSON.parse(probe.body) as { access_token?: string }).access_token ?? null;
    } catch {
      /* leave null */
    }
  }
  return { token, probe };
}

// ── 2. Authenticated search ─────────────────────────────────────────────────
async function searchOAuth(token: string, ua: string, agent: Dispatcher): Promise<Probe> {
  const url = `https://oauth.reddit.com/subreddits/search?q=${encodeURIComponent(QUERY)}&limit=5&type=sr`;
  const probe = await http(url, {
    headers: { Authorization: `Bearer ${token}`, 'User-Agent': ua, Accept: 'application/json' },
    agent,
  });
  if (probe.status === 200) {
    try {
      const kids = (JSON.parse(probe.body)?.data?.children ?? []) as Array<{ data: { display_name: string; subscribers: number } }>;
      probe.note = `children=${kids.length} :: ${kids.slice(0, 5).map((c) => `r/${c.data.display_name}(${c.data.subscribers})`).join(', ')}`;
    } catch {
      probe.note = 'parse-fail';
    }
  }
  return probe;
}

// ── 3. Public JSON control ──────────────────────────────────────────────────
async function searchPublic(host: 'www' | 'old', ua: string, agent: Dispatcher): Promise<Probe> {
  const url = `https://${host}.reddit.com/subreddits/search.json?q=${encodeURIComponent(QUERY)}&limit=5&type=sr`;
  const probe = await http(url, {
    headers: { 'User-Agent': ua, Accept: 'application/json' },
    agent,
  });
  if (probe.status === 200) {
    try {
      probe.note = `children=${(JSON.parse(probe.body)?.data?.children ?? []).length}`;
    } catch {
      probe.note = 'parse-fail';
    }
  }
  return probe;
}

function line(label: string, p: Probe): void {
  const status = String(p.status).padEnd(4);
  const len = String(p.len).padEnd(7);
  console.log(`  ${label.padEnd(42)} status=${status} len=${len} ${p.note}`);
}

async function main() {
  console.log('=== Reddit search diagnostic ===');
  console.log('query        :', QUERY);
  console.log('client id    :', CLIENT_ID ? `${CLIENT_ID.slice(0, 6)}…` : '(missing)');
  console.log('client secret:', CLIENT_SECRET ? '(set)' : '(missing)');
  console.log('proxy        :', maskProxy(PROXY_URL));

  const agents: Array<[string, Dispatcher]> = [['direct', directAgent]];
  if (proxyAgent) agents.push(['proxy', proxyAgent]);

  let workingToken: string | null = null;

  console.log('\n── 1. Token acquisition (POST /api/v1/access_token) ──');
  for (const [aName, agent] of agents) {
    for (const grant of ['client_credentials', 'installed_client'] as const) {
      for (const [uaName, ua] of Object.entries(UA)) {
        const { token, probe } = await fetchToken(grant, ua, agent);
        if (token) probe.note = `TOKEN OK (${token.slice(0, 10)}…)`;
        line(`${aName} | ${grant} | ua=${uaName}`, probe);
        if (token && !workingToken) workingToken = token;
      }
    }
  }

  console.log('\n── 2. Authenticated search (oauth.reddit.com) ──');
  if (workingToken) {
    for (const [aName, agent] of agents) {
      for (const [uaName, ua] of Object.entries(UA)) {
        line(`${aName} | ua=${uaName}`, await searchOAuth(workingToken, ua, agent));
      }
    }
  } else {
    console.log('  (skipped — no token obtained in step 1)');
  }

  console.log('\n── 3. Public JSON control (expected 403) ──');
  for (const [aName, agent] of agents) {
    for (const host of ['www', 'old'] as const) {
      line(`${aName} | ${host}.reddit.com | ua=browser`, await searchPublic(host, UA.browser, agent));
    }
  }

  console.log('\n=== Verdict ===');
  if (workingToken) {
    console.log('✅ An OAuth token was obtained. The fix is to make the engage flow use it');
    console.log('   (oauth.reddit.com), not the public JSON API. See note printed in step 2 for');
    console.log('   which agent/UA combination returned subreddits.');
  } else {
    console.log('❌ No token obtained. Either the app type forbids the grant, the credentials are');
    console.log('   wrong, or even /api/v1/access_token is IP-blocked. Inspect the status codes above:');
    console.log('   - 401 → bad client id/secret');
    console.log('   - 403 + huge len → anti-bot block page (IP/fingerprint); try REDDIT_PROXY');
    console.log('   - installed_client 200 but client_credentials 403 → app is "web/installed" type');
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  }
);
