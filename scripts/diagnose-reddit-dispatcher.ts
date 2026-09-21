/**
 * Does the GLOBAL undici dispatcher actually route Reddit through REDDIT_PROXY?
 *
 * Why this is a separate question from diagnose-reddit-egress.ts: that script
 * builds its own ProxyAgent and passes it explicitly, which is what
 * `redditPublicGet` does. But `EngageService._searchRedditSubreddits` takes a
 * DIFFERENT route when the org has a connected Reddit account — a plain
 * `fetch()` to oauth.reddit.com with no explicit dispatcher, relying entirely on
 * the global dispatcher that main.ts installs via setupHttpDispatcher().
 *
 * In production that path returns Reddit's IP-level block page ("whoa there,
 * pardner! / Your request has been blocked due to a network policy", ~1522
 * bytes — NOT the ~190KB Imperva WAF page) while the explicit-dispatcher path
 * returns 200. Only two things can explain that, and this tells them apart:
 *
 *   A. The global dispatcher is not routing Reddit through the proxy at all, so
 *      fetch() goes out on the host's own IP. Signature: the PLAIN fetch of a
 *      PUBLIC endpoint fails while the explicit one succeeds.
 *   B. The proxy is used, and Reddit simply blocks oauth.reddit.com from this
 *      exit even though it allows www.reddit.com. Signature: both public reads
 *      succeed, and only the oauth host fails.
 *
 * Read-only. No credential is printed.
 *
 * Usage (on the server, from the repo root):
 *   npx tsx scripts/diagnose-reddit-dispatcher.ts
 */
import * as dotenv from 'dotenv';
dotenv.config();

// MUST run before any outbound request, exactly as apps/backend/src/main.ts does.
import { setupHttpDispatcher } from '../libraries/helpers/src/proxy/setup-dispatcher';
setupHttpDispatcher();

import { getRedditLoidCookie } from '../libraries/nestjs-libraries/src/engage/reddit-loid';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function classify(status: number, body: string): string {
  if (status === 200) {
    try {
      const j = JSON.parse(body);
      return `200 OK json children=${j?.data?.children?.length ?? (j?.kind === 't5' ? 1 : 0)}`;
    } catch {
      return `200 NOT json (len=${body.length}) [WAF interstitial]`;
    }
  }
  // The two block pages are distinguishable by size and wording, and they mean
  // different things: Imperva = missing/!flagged loid, Reddit's own = IP policy.
  if (/whoa there, pardner/i.test(body)) {
    return `${status} [Reddit IP block — "network policy", len=${body.length}]`;
  }
  if (/network security|Imperva/i.test(body)) {
    return `${status} [Imperva WAF page, len=${body.length}]`;
  }
  return `${status} len=${body.length}`;
}

/** A plain fetch — no explicit dispatcher, so it uses the GLOBAL one. */
async function viaGlobalFetch(url: string, cookie: string | null): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Accept: 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      signal: AbortSignal.timeout(20_000),
    });
    return classify(res.status, await res.text());
  } catch (e) {
    return `ERR ${(e as Error).message}`;
  }
}

async function main() {
  console.log('=== Global-dispatcher routing check ===');
  console.log(
    'REDDIT_PROXY     :',
    process.env.REDDIT_PROXY ? '(set)' : '(none)'
  );
  console.log(
    'HTTPS/HTTP_PROXY :',
    process.env.HTTPS_PROXY || process.env.HTTP_PROXY ? '(set)' : '(none)'
  );

  const loid = await getRedditLoidCookie();
  console.log('loid             :', loid ? `minted (len=${loid.length})` : 'NOT minted');

  console.log('\n── plain fetch(), i.e. the GLOBAL dispatcher ──');
  // The control: a PUBLIC endpoint the explicit-dispatcher script already proved
  // returns 200 through the proxy. If this one fails, the global dispatcher is
  // not sending Reddit through the proxy — explanation (A).
  console.log(
    '  www  /r/ClaudeAI/about.json      →',
    await viaGlobalFetch('https://www.reddit.com/r/ClaudeAI/about.json', loid)
  );
  console.log(
    '  www  /subreddits/search.json     →',
    await viaGlobalFetch(
      'https://www.reddit.com/subreddits/search.json?q=mcp&limit=3&type=sr',
      loid
    )
  );
  // The endpoint the failing API path actually uses. Unauthenticated here on
  // purpose: a 401 would prove we REACHED the OAuth host (so the proxy works and
  // only the stored token is the problem), while the IP-block page proves we did
  // not.
  console.log(
    '  oauth /subreddits/search (no tok)→',
    await viaGlobalFetch(
      'https://oauth.reddit.com/subreddits/search?q=mcp&limit=3&type=sr',
      loid
    )
  );

  console.log('\n=== How to read this ===');
  console.log('www endpoints 200 + oauth blocked  → (B) the proxy works; Reddit');
  console.log('    blocks oauth.reddit.com from this exit. Stop using the OAuth');
  console.log('    route for search; the public+loid route is the working one.');
  console.log('www endpoints blocked              → (A) the global dispatcher is');
  console.log('    NOT routing Reddit through REDDIT_PROXY, so every plain fetch()');
  console.log('    leaves on the host IP. That is a routing bug, not a Reddit one.');
  console.log('oauth answers 401/403 json         → the host is reachable and the');
  console.log('    stored Integration.token is what is wrong.');
}

main().catch((e) => {
  console.error('diagnostic failed:', e);
  process.exit(1);
});
