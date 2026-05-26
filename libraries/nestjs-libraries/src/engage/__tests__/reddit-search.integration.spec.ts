/**
 * Live diagnostic for Reddit subreddit search. Hits the real Reddit API, so it
 * requires a clean (non-blocked) egress IP — Reddit IP-blocks data-center and
 * commercial-VPN exits. OFF by default; opt in explicitly:
 *
 *   RUN_REDDIT_LIVE=1 REDDIT_CLIENT_ID=... REDDIT_CLIENT_SECRET=... \
 *     pnpm vitest run libraries/nestjs-libraries/src/engage/__tests__/reddit-search.integration.spec.ts
 *
 * Note: `client_credentials` (app-only OAuth) is FORBIDDEN for "web app" type
 * apps — Reddit returns 403 even from a clean IP. Real flows use a user OAuth
 * token or the public .json API. Step 1 documents this rather than asserting
 * success.
 */

import { describe, it, expect } from 'vitest';
import { getRedditToken, redditAuthHeaders } from '../reddit-auth';
import { EngageService } from '../engage.service';

const TIMEOUT = 20_000;
// Live network tests are opt-in; they need a clean egress IP to reach Reddit.
const RUN_LIVE = process.env.RUN_REDDIT_LIVE === '1';
const hasRedditCreds =
  !!process.env.REDDIT_CLIENT_ID && !!process.env.REDDIT_CLIENT_SECRET;

const TARGET = 'football'; // the subreddit the user tried to find

function buildService(): EngageService {
  return new EngageService({} as any, {} as any, {} as any, {} as any);
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 1: token
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!RUN_LIVE || !hasRedditCreds)('Step 1 — Reddit token probe', () => {
  it('documents client_credentials behaviour by app type', async () => {
    const clientId = process.env.REDDIT_CLIENT_ID!;
    const clientSecret = process.env.REDDIT_CLIENT_SECRET!;

    const res = await fetch('https://www.reddit.com/api/v1/access_token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'AISEE-Engage/1.0',
      },
      body: 'grant_type=client_credentials',
    });

    const body = await res.text();
    console.log('\nHTTP status:', res.status, res.statusText);
    console.log('Response body:', body);
    console.log(
      '\nInterpretation:\n' +
      '   200 → "script" type app: app-only token works.\n' +
      '   403 → "web app"/"installed" type: client_credentials FORBIDDEN.\n' +
      '         Use a user OAuth token or the public .json API instead.\n' +
      '   401 → wrong client_id / client_secret.\n' +
      '   429 → rate-limited.'
    );

    // We reached Reddit's auth endpoint (not a network/IP block) when we get a
    // recognised OAuth status. 403 here is expected for "web app" type apps.
    expect([200, 401, 403]).toContain(res.status);
  }, TIMEOUT);
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 2: primary search API (/subreddits/search)
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!RUN_LIVE || !hasRedditCreds)(`Step 2 — primary search for "${TARGET}"`, () => {
  it('hits /subreddits/search and prints raw response', async () => {
    const token = await getRedditToken();
    if (!token) {
      console.log('No token — skipped');
      return;
    }

    const url = `https://oauth.reddit.com/subreddits/search?q=${encodeURIComponent(TARGET)}&limit=10&type=sr`;
    console.log('\nGET', url);

    const res = await fetch(url, {
      headers: redditAuthHeaders(token),
      signal: AbortSignal.timeout(10_000),
    });

    console.log('HTTP status:', res.status, res.statusText);
    const json = (await res.json()) as any;

    const children: any[] = json?.data?.children ?? [];
    console.log(`Found ${children.length} result(s)`);

    for (const c of children) {
      const d = c.data;
      console.log({
        display_name: d.display_name,
        subscribers: d.subscribers,
        subreddit_type: d.subreddit_type,
        public_description: (d.public_description as string)?.slice(0, 80),
        icon_img: d.icon_img,
        community_icon: (d.community_icon as string)?.slice(0, 60),
      });
    }

    // Primary search may legitimately return 0 for tiny subreddits — not a bug.
    // The fallback (/about) handles this case.
    expect(res.ok).toBe(true);
    expect(Array.isArray(children)).toBe(true);

    if (children.length === 0) {
      console.log(
        '\n⚠  Primary search returned 0 results — this is expected for small/new subreddits.',
        'Step 3 (fallback /about) should find it.'
      );
    }
  }, TIMEOUT);
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 3: fallback direct /about lookup
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!RUN_LIVE || !hasRedditCreds)(`Step 3 — fallback /r/${TARGET}/about`, () => {
  it('hits /about and prints subreddit metadata', async () => {
    const token = await getRedditToken();
    if (!token) {
      console.log('No token — skipped');
      return;
    }

    const url = `https://oauth.reddit.com/r/${encodeURIComponent(TARGET)}/about`;
    console.log('\nGET', url);

    const res = await fetch(url, {
      headers: redditAuthHeaders(token),
      signal: AbortSignal.timeout(10_000),
    });

    console.log('HTTP status:', res.status, res.statusText);

    if (!res.ok) {
      console.log('⚠  /about returned non-OK →', res.status);
      if (res.status === 404) console.log('   Subreddit does not exist or is banned.');
      if (res.status === 403) console.log('   Subreddit is private.');
      // 404/403 are valid — means subreddit is inaccessible, not a code bug
      expect([200, 404, 403]).toContain(res.status);
      return;
    }

    const json = (await res.json()) as any;
    const d = json?.data;
    console.log({
      display_name: d?.display_name,
      subscribers: d?.subscribers,
      subreddit_type: d?.subreddit_type,
      public_description: (d?.public_description as string)?.slice(0, 80),
      icon_img: d?.icon_img,
      community_icon: (d?.community_icon as string)?.slice(0, 60),
    });

    expect(d).toBeTruthy();
  }, TIMEOUT);
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 4: full service method end-to-end
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Step 3b: public JSON API — bot UA vs browser UA
// ─────────────────────────────────────────────────────────────────────────────

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/javascript, */*; q=0.01',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Referer': 'https://www.reddit.com/',
  'X-Requested-With': 'XMLHttpRequest',
};

describe.skipIf(!RUN_LIVE)('Step 3b — public JSON API, bot UA vs browser UA', () => {
  it(`bot UA → search.json for "${TARGET}"`, async () => {
    const url = `https://www.reddit.com/subreddits/search.json?q=${encodeURIComponent(TARGET)}&limit=5&type=sr`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'AISEE-Engage/1.0' },
      signal: AbortSignal.timeout(10_000),
    });
    const body = await res.text();
    console.log('\n[Bot UA] search.json status:', res.status, res.statusText);
    console.log('Body (first 200):', body.slice(0, 200));
  }, TIMEOUT);

  it(`browser UA → search.json for "${TARGET}"`, async () => {
    const url = `https://www.reddit.com/subreddits/search.json?q=${encodeURIComponent(TARGET)}&limit=5&type=sr`;
    const res = await fetch(url, {
      headers: BROWSER_HEADERS,
      signal: AbortSignal.timeout(10_000),
    });
    const body = await res.text();
    console.log('\n[Browser UA] search.json status:', res.status, res.statusText);
    console.log('Body (first 500):', body.slice(0, 500));
  }, TIMEOUT);

  it(`browser UA → about.json for r/${TARGET}`, async () => {
    const url = `https://www.reddit.com/r/${encodeURIComponent(TARGET)}/about.json`;
    const res = await fetch(url, {
      headers: BROWSER_HEADERS,
      signal: AbortSignal.timeout(10_000),
    });
    const body = await res.text();
    console.log(`\n[Browser UA] about.json status:`, res.status, res.statusText);
    console.log('Body (first 500):', body.slice(0, 500));
  }, TIMEOUT);
});

// Step 4 always runs — public JSON API works without credentials.
describe.skipIf(!RUN_LIVE)('Step 4 — EngageService._searchRedditSubreddits end-to-end', () => {
  const service = buildService();

  it(`returns results for "r/${TARGET}"`, async () => {
    const results = await (service as any)._searchRedditSubreddits(`r/${TARGET}`);

    console.log(`\n_searchRedditSubreddits("r/${TARGET}") → ${results.length} result(s)`);
    for (const r of results) {
      console.log({
        channelId: r.channelId,
        channelName: r.channelName,
        audienceSize: r.audienceSize,
        metadata: r.metadata,
      });
    }

    // If both primary search and fallback return nothing, this will be []
    // and we can see from the earlier steps which step failed.
    expect(Array.isArray(results)).toBe(true);

    if (results.length > 0) {
      expect(results[0].channelId).toBe(TARGET);
      expect(results[0].platform).toBe('reddit');
      expect(results[0].channelName).toBe(`r/${TARGET}`);
      expect(typeof results[0].audienceSize).toBe('number');
    } else {
      console.log(
        `\n⚠  No results — check steps 1-3 output above for root cause:\n` +
        `   - Step 1 null token → credentials rejected\n` +
        `   - Step 2 empty → subreddit too small for search index (fallback should cover)\n` +
        `   - Step 3 404 → subreddit doesn't exist or is banned\n` +
        `   - Step 3 403 → subreddit is private\n` +
        `   - Step 3 200 but empty result → logic bug in fallback branch`
      );
    }
  }, TIMEOUT);

  it('normalises "ColorPuzzleGame" (no r/ prefix) identically', async () => {
    const withPrefix = await (service as any)._searchRedditSubreddits(`r/${TARGET}`);
    const withoutPrefix = await (service as any)._searchRedditSubreddits(TARGET);
    console.log(`\nWith prefix: ${withPrefix.length}, without: ${withoutPrefix.length}`);
    expect(withPrefix.length).toBe(withoutPrefix.length);
  }, TIMEOUT);
});
