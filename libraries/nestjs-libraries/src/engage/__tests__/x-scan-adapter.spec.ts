import { describe, it, expect } from 'vitest';
import {
  XScanAdapter,
  clampXMaxResults,
  expandXTweetText,
} from '../scan/x-scan-adapter';
import type { SearchScopedArgs } from '../scan/platform-scan-adapter';

// Minimal fetch Response stub.
function res(
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

function tweet(id: string, text = 'AI is great', extra: Record<string, unknown> = {}) {
  return {
    id,
    text,
    created_at: '2026-01-01T00:00:00.000Z',
    author_id: 'u1',
    reply_settings: 'everyone',
    public_metrics: {
      like_count: 1,
      reply_count: 0,
      retweet_count: 0,
      quote_count: 0,
      bookmark_count: 0,
    },
    ...extra,
  };
}
const USERS = { users: [{ id: 'u1', username: 'alice', name: 'Alice' }] };

function baseArgs(over: Partial<SearchScopedArgs> = {}): SearchScopedArgs {
  return {
    scope: { type: 'keyword' },
    keywords: ['AI'],
    cursor: {},
    budget: { maxCalls: 10 },
    token: 'TKN',
    ...over,
  };
}

describe('XScanAdapter', () => {
  it('returns empty without a token or without keywords', async () => {
    const a = new XScanAdapter({ fetchImpl: (() => { throw new Error('no call'); }) as any });
    expect((await a.searchScoped(baseArgs({ token: null }))).posts).toEqual([]);
    expect((await a.searchScoped(baseArgs({ keywords: [] }))).posts).toEqual([]);
  });

  it('drops reply-restricted tweets, keeps everyone', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      return res(200, {
        data: [tweet('100'), tweet('99', 'AI', { reply_settings: 'following' })],
        includes: USERS,
        meta: { result_count: 2 },
      });
    }) as any;
    const out = await new XScanAdapter({ fetchImpl }).searchScoped(baseArgs());
    expect(out.posts.map((p) => p.externalPostId)).toEqual(['100']);
    expect(out.nextCursor.lastSeenExternalId).toBe('100'); // newest id incl. dropped
  });

  it('passes since_id from the cursor and advances to the newest id', async () => {
    let seenUrl = '';
    const fetchImpl = (async (url: string) => {
      seenUrl = url;
      return res(200, { data: [tweet('500'), tweet('400')], includes: USERS });
    }) as any;
    const out = await new XScanAdapter({ fetchImpl }).searchScoped(
      baseArgs({ cursor: { lastSeenExternalId: '300' } })
    );
    expect(seenUrl).toContain('since_id=300');
    expect(out.nextCursor.lastSeenExternalId).toBe('500');
  });

  it('OR-batches multiple keywords into one query', async () => {
    let seenUrl = '';
    const fetchImpl = (async (url: string) => {
      seenUrl = url;
      return res(200, { data: [], includes: USERS });
    }) as any;
    await new XScanAdapter({ fetchImpl }).searchScoped(
      baseArgs({ keywords: ['AI', 'GEO'] })
    );
    // URLSearchParams encodes spaces as '+'.
    expect(decodeURIComponent(seenUrl).replace(/\+/g, ' ')).toContain('(AI OR GEO)');
  });

  it('prefixes from:username for tracked scope', async () => {
    let seenUrl = '';
    const fetchImpl = (async (url: string) => {
      seenUrl = url;
      return res(200, { data: [], includes: USERS });
    }) as any;
    await new XScanAdapter({ fetchImpl }).searchScoped(
      baseArgs({ scope: { type: 'tracked', key: 'bob' }, keywords: ['AI'] })
    );
    expect(decodeURIComponent(seenUrl).replace(/\+/g, ' ')).toContain('from:bob AI');
  });

  it('follows next_token pagination then stops', async () => {
    const bodies = [
      res(200, { data: [tweet('200')], includes: USERS, meta: { next_token: 'PAGE2' } }),
      res(200, { data: [tweet('150')], includes: USERS, meta: {} }),
    ];
    let i = 0;
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return bodies[i++];
    }) as any;
    const out = await new XScanAdapter({ fetchImpl }).searchScoped(baseArgs());
    expect(urls.length).toBe(2);
    expect(urls[1]).toContain('pagination_token=PAGE2');
    expect(out.posts.map((p) => p.externalPostId)).toEqual(['200', '150']);
  });

  it('stops and flags limited on 429', async () => {
    const fetchImpl = (async () =>
      res(429, {}, { 'x-rate-limit-reset': String(Math.floor(Date.now() / 1000) + 60) })) as any;
    const out = await new XScanAdapter({ fetchImpl }).searchScoped(baseArgs());
    expect(out.rate.limited).toBe(true);
    expect(out.rate.retryAfterMs).toBeGreaterThan(0);
    expect(out.posts).toEqual([]);
  });

  it('respects the call budget across pagination', async () => {
    const fetchImpl = (async () =>
      res(200, { data: [tweet('1')], includes: USERS, meta: { next_token: 'NEXT' } })) as any;
    const out = await new XScanAdapter({ fetchImpl }).searchScoped(
      baseArgs({ budget: { maxCalls: 2 } })
    );
    // Would paginate forever; budget caps it at 2 calls (2 posts).
    expect(out.posts.length).toBe(2);
  });

  it('requests the referenced_tweets expansion (resolve originals inline)', async () => {
    let seenUrl = '';
    const fetchImpl = (async (url: string) => {
      seenUrl = url;
      return res(200, { data: [], includes: { users: [] } });
    }) as any;
    await new XScanAdapter({ fetchImpl }).searchScoped(baseArgs());
    const u = decodeURIComponent(seenUrl);
    expect(u).toContain('referenced_tweets.id');
    expect(u).toContain('referenced_tweets.id.author_id');
  });

  it('resolves a retweet to its original post; cursor still tracks the RT id', async () => {
    const rt = tweet('900', 'RT @author: original content', {
      author_id: 'RTER',
      referenced_tweets: [{ type: 'retweeted', id: '500' }],
    });
    const original = tweet('500', 'original content', { author_id: 'AUTH1' });
    const fetchImpl = (async () =>
      res(200, {
        data: [rt],
        includes: {
          users: [
            { id: 'RTER', username: 'retweeter', name: 'RT' },
            { id: 'AUTH1', username: 'author', name: 'Author' },
          ],
          tweets: [original],
        },
      })) as any;
    const out = await new XScanAdapter({ fetchImpl }).searchScoped(baseArgs());
    expect(out.posts).toHaveLength(1);
    expect(out.posts[0].externalPostId).toBe('500'); // original, not the RT
    expect(out.posts[0].postContent).toBe('original content');
    expect(out.posts[0].authorUsername).toBe('author'); // original author
    // Cursor advances by the top-level search result (the RT), not the original.
    expect(out.nextCursor.lastSeenExternalId).toBe('900');
  });

  it('drops a retweet whose original is unavailable (deleted/protected)', async () => {
    const rt = tweet('901', 'RT @x: gone', {
      author_id: 'RTER',
      referenced_tweets: [{ type: 'retweeted', id: 'GONE' }],
    });
    const fetchImpl = (async () =>
      res(200, {
        data: [rt],
        includes: { users: [{ id: 'RTER', username: 'r', name: 'R' }], tweets: [] },
      })) as any;
    const out = await new XScanAdapter({ fetchImpl }).searchScoped(baseArgs());
    expect(out.posts).toEqual([]);
    expect(out.nextCursor.lastSeenExternalId).toBe('901'); // cursor still advances
  });

  it('keeps a quote tweet as-is (does NOT resolve to the quoted original)', async () => {
    const quote = tweet('902', 'my hot take', {
      author_id: 'u1',
      referenced_tweets: [{ type: 'quoted', id: '400' }],
    });
    const quoted = tweet('400', 'quoted original', { author_id: 'AUTH2' });
    const fetchImpl = (async () =>
      res(200, {
        data: [quote],
        includes: {
          users: [{ id: 'u1', username: 'alice', name: 'Alice' }],
          tweets: [quoted],
        },
      })) as any;
    const out = await new XScanAdapter({ fetchImpl }).searchScoped(baseArgs());
    expect(out.posts).toHaveLength(1);
    expect(out.posts[0].externalPostId).toBe('902'); // the quote tweet itself
    expect(out.posts[0].postContent).toBe('my hot take');
    expect(out.posts[0].authorUsername).toBe('alice');
  });

  it('merges multiple tracked usernames into one (from:a OR from:b) query', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return res(200, { data: [], includes: { users: [] } });
    }) as any;
    await new XScanAdapter({ fetchImpl }).searchScoped(
      baseArgs({
        scope: { type: 'tracked', keys: ['alice', 'bob', 'carol'] },
        keywords: ['AI'],
      })
    );
    // A small bucket of accounts collapses to ONE query, not one per account.
    expect(urls.length).toBe(1);
    const q = decodeURIComponent(urls[0]).replace(/\+/g, ' ');
    expect(q).toContain('(from:alice OR from:bob OR from:carol) AI');
    expect(q).toContain('-is:retweet');
  });

  it('attributes merged tracked results to each author', async () => {
    const fetchImpl = (async () =>
      res(200, {
        data: [tweet('10', 'from alice', { author_id: 'ua' }), tweet('9', 'from bob', { author_id: 'ub' })],
        includes: {
          users: [
            { id: 'ua', username: 'alice', name: 'Alice' },
            { id: 'ub', username: 'bob', name: 'Bob' },
          ],
        },
      })) as any;
    const out = await new XScanAdapter({ fetchImpl }).searchScoped(
      baseArgs({ scope: { type: 'tracked', keys: ['alice', 'bob'] }, keywords: ['AI'] })
    );
    expect(out.posts.map((p) => p.authorUsername).sort()).toEqual(['alice', 'bob']);
  });

  it('still supports a single tracked username via scope.key (back-compat)', async () => {
    let seenUrl = '';
    const fetchImpl = (async (url: string) => {
      seenUrl = url;
      return res(200, { data: [], includes: { users: [] } });
    }) as any;
    await new XScanAdapter({ fetchImpl }).searchScoped(
      baseArgs({ scope: { type: 'tracked', key: 'bob' }, keywords: ['AI'] })
    );
    const q = decodeURIComponent(seenUrl).replace(/\+/g, ' ');
    // Single author keeps the un-parenthesised `from:bob AI` form.
    expect(q).toContain('from:bob AI');
    expect(q).not.toContain('(from:bob)');
  });

  it('tracked scope appends -is:retweet to the query', async () => {
    let seenUrl = '';
    const fetchImpl = (async (url: string) => {
      seenUrl = url;
      return res(200, { data: [], includes: { users: [] } });
    }) as any;
    await new XScanAdapter({ fetchImpl }).searchScoped(
      baseArgs({ scope: { type: 'tracked', key: 'bob' }, keywords: ['AI'] })
    );
    expect(decodeURIComponent(seenUrl).replace(/\+/g, ' ')).toContain('-is:retweet');
  });
});

describe('XScanAdapter freshness window (start_time = max(cursor, now-window))', () => {
  const H = 3_600_000;

  it('cursor WITHIN window: keeps since_id, sends no start_time', async () => {
    let seenUrl = '';
    const fetchImpl = (async (url: string) => {
      seenUrl = url;
      return res(200, { data: [], includes: USERS });
    }) as any;
    await new XScanAdapter({ fetchImpl }).searchScoped(
      baseArgs({
        cursor: { lastSeenExternalId: '300', lastSeenAt: new Date(Date.now() - 2 * H) },
        freshnessWindowMs: 24 * H,
      })
    );
    // max picked the cursor → incremental via since_id, no start_time floor.
    expect(seenUrl).toContain('since_id=300');
    expect(seenUrl).not.toContain('start_time=');
  });

  it('cursor BEYOND window: drops since_id, sends start_time, keeps persisted cursor', async () => {
    let seenUrl = '';
    const fetchImpl = (async (url: string) => {
      seenUrl = url;
      return res(200, { data: [], includes: USERS });
    }) as any;
    const out = await new XScanAdapter({ fetchImpl }).searchScoped(
      baseArgs({
        cursor: { lastSeenExternalId: '300', lastSeenAt: new Date(Date.now() - 48 * H) },
        freshnessWindowMs: 24 * H,
      })
    );
    // max picked now-window → floor via start_time; stale since_id dropped from
    // the REQUEST (else X precedence walks past the window). Persisted cursor id
    // is preserved when the run returns nothing newer.
    expect(seenUrl).not.toContain('since_id=');
    expect(seenUrl).toContain('start_time=');
    expect(out.nextCursor.lastSeenExternalId).toBe('300');
  });

  it('client cutoff drops posts older than the window; cursor still advances over all seen', async () => {
    const fresh = tweet('1000', 'AI now', {
      created_at: new Date(Date.now() - 1 * H).toISOString(),
    });
    const stale = tweet('999', 'AI old', {
      created_at: new Date(Date.now() - 48 * H).toISOString(),
    });
    const fetchImpl = (async () => res(200, { data: [fresh, stale], includes: USERS })) as any;
    const out = await new XScanAdapter({ fetchImpl }).searchScoped(
      baseArgs({
        cursor: { lastSeenExternalId: '300', lastSeenAt: new Date(Date.now() - 2 * H) },
        freshnessWindowMs: 24 * H,
      })
    );
    expect(out.posts.map((p) => p.externalPostId)).toEqual(['1000']); // stale dropped
    expect(out.nextCursor.lastSeenExternalId).toBe('1000'); // cursor over ALL seen
  });

  it('no freshnessWindowMs ⇒ legacy behaviour (no start_time, no cutoff)', async () => {
    let seenUrl = '';
    const old = tweet('999', 'AI old', {
      created_at: new Date(Date.now() - 72 * H).toISOString(),
    });
    const fetchImpl = (async (url: string) => {
      seenUrl = url;
      return res(200, { data: [old], includes: USERS });
    }) as any;
    const out = await new XScanAdapter({ fetchImpl }).searchScoped(
      baseArgs({ cursor: { lastSeenExternalId: '300' } })
    );
    expect(seenUrl).not.toContain('start_time=');
    expect(out.posts.map((p) => p.externalPostId)).toEqual(['999']); // not cut off
  });
});

describe('clampXMaxResults', () => {
  it('clamps into X\'s [10, 100] range, rounds, and defaults on junk', () => {
    expect(clampXMaxResults(50)).toBe(50);
    expect(clampXMaxResults(10)).toBe(10);
    expect(clampXMaxResults(100)).toBe(100);
    expect(clampXMaxResults(3)).toBe(10); // below floor → 10
    expect(clampXMaxResults(500)).toBe(100); // above ceiling → 100
    expect(clampXMaxResults(33.6)).toBe(34); // rounded
    expect(clampXMaxResults(null)).toBe(10); // default
    expect(clampXMaxResults(undefined)).toBe(10);
    expect(clampXMaxResults(Number.NaN)).toBe(10);
  });
});

describe('XScanAdapter max_results (per-call page size)', () => {
  // Capture the max_results query param the adapter actually sends to X.
  function capture() {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return res(200, { data: [], includes: USERS, meta: { result_count: 0 } });
    }) as any;
    return {
      fetchImpl,
      maxResults: () => new URL(urls[0]).searchParams.get('max_results'),
    };
  }

  it('defaults to 10 when no maxResults is passed', async () => {
    const c = capture();
    await new XScanAdapter({ fetchImpl: c.fetchImpl }).searchScoped(baseArgs());
    expect(c.maxResults()).toBe('10');
  });

  it('honours an explicit maxResults (settings-resolved value)', async () => {
    const c = capture();
    await new XScanAdapter({ fetchImpl: c.fetchImpl }).searchScoped(
      baseArgs({ maxResults: 50 })
    );
    expect(c.maxResults()).toBe('50');
  });

  it('clamps an out-of-range maxResults to the X API ceiling/floor', async () => {
    const hi = capture();
    await new XScanAdapter({ fetchImpl: hi.fetchImpl }).searchScoped(
      baseArgs({ maxResults: 500 })
    );
    expect(hi.maxResults()).toBe('100');

    const lo = capture();
    await new XScanAdapter({ fetchImpl: lo.fetchImpl }).searchScoped(
      baseArgs({ maxResults: 3 })
    );
    expect(lo.maxResults()).toBe('10');
  });

  it('uses note_tweet.text as postContent for long-form tweets (>280 chars)', async () => {
    const fullText = 'A'.repeat(300);
    const truncatedText = 'A'.repeat(280) + '… https://t.co/shortlink';
    const fetchImpl = (async () =>
      res(200, {
        data: [
          tweet('999', truncatedText, {
            note_tweet: { text: fullText },
          }),
        ],
        includes: USERS,
      })) as any;
    const out = await new XScanAdapter({ fetchImpl }).searchScoped(baseArgs());
    expect(out.posts).toHaveLength(1);
    expect(out.posts[0].postContent).toBe(fullText);
  });

  it('falls back to tweet.text when note_tweet is absent', async () => {
    const text = 'Short tweet without note_tweet';
    const fetchImpl = (async () =>
      res(200, { data: [tweet('998', text)], includes: USERS })) as any;
    const out = await new XScanAdapter({ fetchImpl }).searchScoped(baseArgs());
    expect(out.posts[0].postContent).toBe(text);
  });
});

// X's `text` is its WIRE format, not what the site renders: every link is a t.co
// shortlink whose destination lives in entities.urls, and an attachment gets a
// t.co placeholder the site shows as an image rather than as text.
describe('expandXTweetText', () => {
  it('expands a t.co link to its real destination', () => {
    expect(
      expandXTweetText('audit here, free: https://t.co/Pn764BHwyL', {
        urls: [
          {
            url: 'https://t.co/Pn764BHwyL',
            expanded_url: 'https://seo-stuff.com/free-audit',
            display_url: 'seo-stuff.com/free-audit',
          },
        ],
      })
    ).toBe('audit here, free: https://seo-stuff.com/free-audit');
  });

  it('expands every occurrence, and several distinct shortlinks', () => {
    expect(
      expandXTweetText('https://t.co/a x https://t.co/b y https://t.co/a', {
        urls: [
          { url: 'https://t.co/a', expanded_url: 'https://one.example' },
          { url: 'https://t.co/b', expanded_url: 'https://two.example' },
        ],
      })
    ).toBe('https://one.example x https://two.example y https://one.example');
  });

  it('drops an attachment placeholder (the entry carrying media_key)', () => {
    expect(
      expandXTweetText('First, the confirmed part. https://t.co/imgAAA', {
        urls: [
          {
            url: 'https://t.co/imgAAA',
            expanded_url: 'https://x.com/alex/status/209/photo/1',
            display_url: 'pic.x.com/abc',
            media_key: '3_209',
          },
        ],
      })
    ).toBe('First, the confirmed part.');
  });

  it('reads a longform note tweet’s own entities', () => {
    expect(
      expandXTweetText(
        'the long body with https://t.co/note1',
        undefined,
        { urls: [{ url: 'https://t.co/note1', expanded_url: 'https://long.example/post' }] }
      )
    ).toBe('the long body with https://long.example/post');
  });

  it('leaves a shortlink with no entity untouched', () => {
    expect(expandXTweetText('mystery https://t.co/unknown1', { urls: [] })).toBe(
      'mystery https://t.co/unknown1'
    );
  });

  it('decodes the HTML entities X escapes', () => {
    expect(expandXTweetText('R&amp;D on &lt;script&gt; tags')).toBe(
      'R&D on <script> tags'
    );
  });

  it('tolerates a missing/!array entities payload', () => {
    expect(expandXTweetText('plain body')).toBe('plain body');
    expect(expandXTweetText('plain body', { urls: 'nope' } as any)).toBe('plain body');
  });
});
