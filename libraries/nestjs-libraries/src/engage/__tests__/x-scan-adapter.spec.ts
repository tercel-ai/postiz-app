import { describe, it, expect } from 'vitest';
import { XScanAdapter } from '../scan/x-scan-adapter';
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
});
