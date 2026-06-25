import { describe, it, expect } from 'vitest';
import { RedditScanAdapter, parseRedditRateLimit } from '../scan/reddit-scan-adapter';
import type { SearchScopedArgs } from '../scan/platform-scan-adapter';

function oauthRes(
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): any {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])
  );
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (n: string) => lower[n.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function publicRes(status: number, body: unknown): any {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
    viaDirect: true,
  };
}

function child(id: string, createdUtc: number, extra: Record<string, unknown> = {}) {
  return {
    data: {
      id,
      name: `t3_${id}`,
      permalink: `/r/test/comments/${id}/`,
      subreddit: 'test',
      author: 'redditor',
      created_utc: createdUtc,
      score: 10,
      upvote_ratio: 0.9,
      num_comments: 2,
      subreddit_subscribers: 1000,
      ...extra,
    },
  };
}

function listing(children: ReturnType<typeof child>[], after: string | null = null) {
  return { data: { after, children } };
}

function baseArgs(over: Partial<SearchScopedArgs> = {}): SearchScopedArgs {
  return {
    scope: { type: 'keyword' },
    keywords: ['AI'],
    cursor: {},
    budget: { maxCalls: 10 },
    token: 'RDT',
    ...over,
  };
}

describe('RedditScanAdapter', () => {
  it('channel scope hits /r/{sub}/search with restrict_sr & sort=new', async () => {
    let url = '';
    const fetchImpl = (async (u: string) => {
      url = u;
      return oauthRes(200, listing([child('a', 3000)]));
    }) as any;
    await new RedditScanAdapter({ fetchImpl }).searchScoped(
      baseArgs({ scope: { type: 'channel', key: 'startups' } })
    );
    expect(url).toContain('/r/startups/search');
    expect(url).toContain('restrict_sr=true');
    expect(url).toContain('sort=new');
  });

  it('keyword scope hits global /search', async () => {
    let url = '';
    const fetchImpl = (async (u: string) => {
      url = u;
      return oauthRes(200, listing([child('a', 3000)]));
    }) as any;
    await new RedditScanAdapter({ fetchImpl }).searchScoped(baseArgs());
    expect(url).toContain('oauth.reddit.com/search?');
    expect(url).not.toContain('restrict_sr');
  });

  it('maps subreddit_subscribers to channelFollowers, not authorFollowers', async () => {
    // subreddit size is the CHANNEL audience (drives community authority), not the
    // author's followers — which Reddit listings don't carry, so it stays undefined.
    const fetchImpl = (async () =>
      oauthRes(200, listing([child('a', 3000)]))) as any;
    const out = await new RedditScanAdapter({ fetchImpl }).searchScoped(baseArgs());
    expect(out.posts[0].channelFollowers).toBe(1000);
    expect(out.posts[0].authorFollowers).toBeUndefined();
  });

  it('stops at the cursor timestamp (sort=new descending)', async () => {
    // Page is newest→oldest; lastSeenAt = 2000s. Posts at 3000/2500 are new,
    // 1500 is already-seen → must stop there and not paginate further.
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return oauthRes(
        200,
        listing([child('c', 3000), child('b', 2500), child('a', 1500)], 'AFTER')
      );
    }) as any;
    const out = await new RedditScanAdapter({ fetchImpl }).searchScoped(
      baseArgs({ cursor: { lastSeenAt: new Date(2000 * 1000) } })
    );
    expect(out.posts.map((p) => p.externalPostId)).toEqual(['c', 'b']);
    expect(calls).toBe(1); // reached seen → no follow-up page despite after token
    expect(out.nextCursor.lastSeenAt?.getTime()).toBe(3000 * 1000);
  });

  it('paginates via after until exhausted', async () => {
    const pages = [
      oauthRes(200, listing([child('c', 3000)], 'P2')),
      oauthRes(200, listing([child('b', 2000)], null)),
    ];
    let i = 0;
    const urls: string[] = [];
    const fetchImpl = (async (u: string) => {
      urls.push(u);
      return pages[i++];
    }) as any;
    const out = await new RedditScanAdapter({ fetchImpl }).searchScoped(baseArgs());
    expect(urls.length).toBe(2);
    expect(urls[1]).toContain('after=P2');
    expect(out.posts.map((p) => p.externalPostId)).toEqual(['c', 'b']);
  });

  it('falls back to the public path when OAuth returns a non-429 error', async () => {
    let publicCalled = false;
    const fetchImpl = (async () => oauthRes(500, {})) as any;
    const publicGet = (async () => {
      publicCalled = true;
      return publicRes(200, listing([child('z', 3000)]));
    }) as any;
    const out = await new RedditScanAdapter({ fetchImpl, publicGet }).searchScoped(baseArgs());
    expect(publicCalled).toBe(true);
    expect(out.posts.map((p) => p.externalPostId)).toEqual(['z']);
  });

  it('flags limited on OAuth 429 without falling back', async () => {
    const fetchImpl = (async () => oauthRes(429, {}, { 'x-ratelimit-reset': '30' })) as any;
    const publicGet = (async () => { throw new Error('should not fall back on 429'); }) as any;
    const out = await new RedditScanAdapter({ fetchImpl, publicGet }).searchScoped(baseArgs());
    expect(out.rate.limited).toBe(true);
    expect(out.rate.retryAfterMs).toBe(30_000);
  });

  it('uses the public path directly when no token is given', async () => {
    let publicCalled = false;
    const fetchImpl = (async () => { throw new Error('no oauth without token'); }) as any;
    const publicGet = (async () => {
      publicCalled = true;
      return publicRes(200, listing([child('p', 3000)]));
    }) as any;
    const out = await new RedditScanAdapter({ fetchImpl, publicGet }).searchScoped(
      baseArgs({ token: null })
    );
    expect(publicCalled).toBe(true);
    expect(out.posts.map((p) => p.externalPostId)).toEqual(['p']);
  });
});

describe('parseRedditRateLimit', () => {
  it('converts reset-seconds to an absolute resetAt and 429 retryAfter', () => {
    const r = parseRedditRateLimit(
      { status: 429, headers: { get: (n) => ({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '120' } as any)[n] ?? null } },
      10_000
    );
    expect(r.limited).toBe(true);
    expect(r.remaining).toBe(0);
    expect(r.resetAt?.getTime()).toBe(10_000 + 120_000);
    expect(r.retryAfterMs).toBe(120_000);
  });
});

describe('RedditScanAdapter freshness window (stop line = max(cursor, now-window))', () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const H = 3600;

  it('empty cursor: stops at now-window, drops posts older than the window', async () => {
    const fresh = child('fresh', nowSec - 1 * H); // 1h ago — within 24h
    const stale = child('stale', nowSec - 48 * H); // 48h ago — beyond 24h
    const fetchImpl = (async () =>
      oauthRes(200, listing([fresh, stale]))) as any; // sort=new: newest first
    const out = await new RedditScanAdapter({ fetchImpl }).searchScoped(
      baseArgs({ cursor: {}, freshnessWindowMs: 24 * H * 1000 })
    );
    expect(out.posts.map((p) => p.externalPostId)).toEqual(['fresh']);
  });

  it('cursor MORE recent than the window wins (incremental unchanged)', async () => {
    const fresh = child('fresh', nowSec - 1 * H); // newer than the 2h cursor
    const mid = child('mid', nowSec - 5 * H); // older than cursor, within window
    const fetchImpl = (async () => oauthRes(200, listing([fresh, mid]))) as any;
    const out = await new RedditScanAdapter({ fetchImpl }).searchScoped(
      baseArgs({
        cursor: { lastSeenAt: new Date(Date.now() - 2 * H * 1000) },
        freshnessWindowMs: 24 * H * 1000,
      })
    );
    // max(2h-ago, 24h-ago) = 2h-ago → stop at the cursor; `mid` is below it.
    expect(out.posts.map((p) => p.externalPostId)).toEqual(['fresh']);
  });

  it('cursor OLDER than the window: capped at now-window, not the stale cursor', async () => {
    const fresh = child('fresh', nowSec - 1 * H);
    const mid = child('mid', nowSec - 12 * H); // within 24h
    const beyond = child('beyond', nowSec - 48 * H); // 48h: newer than 72h cursor, beyond window
    const fetchImpl = (async () =>
      oauthRes(200, listing([fresh, mid, beyond]))) as any;
    const out = await new RedditScanAdapter({ fetchImpl }).searchScoped(
      baseArgs({
        cursor: { lastSeenAt: new Date(Date.now() - 72 * H * 1000) },
        freshnessWindowMs: 24 * H * 1000,
      })
    );
    // max(72h-ago, 24h-ago) = 24h-ago → `beyond` (48h) is dropped despite the
    // stale 72h cursor that would otherwise have allowed it.
    expect(out.posts.map((p) => p.externalPostId)).toEqual(['fresh', 'mid']);
  });

  it('no freshnessWindowMs ⇒ legacy behaviour (no cutoff)', async () => {
    const old = child('old', nowSec - 72 * H);
    const fetchImpl = (async () => oauthRes(200, listing([old]))) as any;
    const out = await new RedditScanAdapter({ fetchImpl }).searchScoped(
      baseArgs({ cursor: {} })
    );
    expect(out.posts.map((p) => p.externalPostId)).toEqual(['old']); // not cut off
  });
});
