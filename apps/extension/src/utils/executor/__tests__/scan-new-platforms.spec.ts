import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngageScanTask } from '../executor.types';
import {
  buildDevtoScanUrl,
  scanDevto,
  toDevtoTag,
} from '../scan.devto';
import {
  buildHackernewsScanUrl,
  scanHackernews,
} from '../scan.hackernews';
import {
  buildMediumFeedUrl,
  mediumExternalId,
  parseMediumFeed,
} from '../scan.medium';
import { buildQuoraScanUrl, quoraTimeToMs } from '../scan.quora';

const task = (over: Partial<EngageScanTask>): EngageScanTask => ({
  taskId: 't',
  platform: 'devto',
  scanType: 'keyword',
  scanKey: 'javascript',
  cursor: { lastSeenExternalId: null, lastSeenAt: null },
  pacing: {
    maxPages: 1,
    pageSize: 30,
    pageDelayMs: 0,
    pageJitterMs: 0,
    interUnitDelayMs: 0,
    interUnitJitterMs: 0,
    hourlyRequestCap: 100,
  },
  ...over,
});

const alwaysGate = () => Promise.resolve(true);

describe('dev.to scan', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('builds tag vs username URLs', () => {
    expect(toDevtoTag('Web Dev!')).toBe('webdev');
    expect(buildDevtoScanUrl(task({ scanType: 'keyword', scanKey: 'React' }), 1)).toContain(
      'tag=react'
    );
    expect(
      buildDevtoScanUrl(task({ scanType: 'tracked', scanKey: '@ben' }), 2)
    ).toContain('username=ben&per_page=30&page=2');
  });

  it('maps articles to ingest posts and advances the cursor', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => [
          {
            id: 7,
            title: 'Hello',
            description: 'desc',
            url: 'https://dev.to/ben/hello-7',
            published_at: '2026-07-20T10:00:00Z',
            user: { username: 'ben', name: 'Ben' },
            tag_list: ['javascript'],
            public_reactions_count: 12,
            comments_count: 4,
          },
        ],
      }))
    );
    const r = await scanDevto(task({}), alwaysGate);
    expect(r.posts).toHaveLength(1);
    expect(r.posts[0]).toMatchObject({
      platform: 'devto',
      externalPostId: '7',
      externalPostUrl: 'https://dev.to/ben/hello-7',
      authorUsername: 'ben',
      metricScore: 12,
      metricComments: 4,
    });
    expect(r.nextCursor.lastSeenExternalId).toBe('7');
  });

  it('drops articles at/older than the cursor', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => [
          { id: 1, title: 'old', url: 'u', published_at: '2026-07-01T00:00:00Z', user: {} },
        ],
      }))
    );
    const r = await scanDevto(
      task({ cursor: { lastSeenExternalId: '1', lastSeenAt: '2026-07-10T00:00:00Z' } }),
      alwaysGate
    );
    expect(r.posts).toHaveLength(0);
  });
});

describe('hacker news scan', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('builds keyword vs author queries with a since filter', () => {
    const kw = buildHackernewsScanUrl(task({ platform: 'hackernews', scanKey: 'rust' }), 0, null);
    expect(kw).toContain('tags=story');
    expect(kw).toContain('query=rust');
    const tracked = buildHackernewsScanUrl(
      task({ platform: 'hackernews', scanType: 'tracked', scanKey: 'pg' }),
      0,
      1000
    );
    expect(tracked).toContain('tags=story%2Cauthor_pg');
    expect(tracked).toContain('numericFilters=created_at_i%3E1000');
  });

  it('maps Algolia hits to HN item posts', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          nbPages: 1,
          hits: [
            {
              objectID: '999',
              title: 'Show HN: thing',
              author: 'alice',
              points: 55,
              num_comments: 12,
              created_at_i: 1_700_000_000,
              created_at: '2023-11-14T22:13:20Z',
            },
          ],
        }),
      }))
    );
    const r = await scanHackernews(task({ platform: 'hackernews', scanKey: 'thing' }), alwaysGate);
    expect(r.posts[0]).toMatchObject({
      platform: 'hackernews',
      externalPostId: '999',
      externalPostUrl: 'https://news.ycombinator.com/item?id=999',
      authorUsername: 'alice',
      metricScore: 55,
      metricComments: 12,
    });
  });

  it('returns exhausted with no posts for a channel task', async () => {
    const r = await scanHackernews(task({ platform: 'hackernews', scanType: 'channel' }), alwaysGate);
    expect(r).toEqual({ posts: [], nextCursor: expect.any(Object), exhausted: true });
  });
});

describe('medium scan (RSS parsing)', () => {
  it('builds tag vs author feed URLs', () => {
    expect(buildMediumFeedUrl(task({ platform: 'medium', scanKey: 'Machine Learning' }))).toBe(
      'https://medium.com/feed/tag/machine-learning'
    );
    expect(
      buildMediumFeedUrl(task({ platform: 'medium', scanType: 'tracked', scanKey: 'ben' }))
    ).toBe('https://medium.com/feed/@ben');
  });

  it('parses items from an RSS document without DOMParser', () => {
    const xml = `<rss><channel>
      <item>
        <title><![CDATA[My Post]]></title>
        <link>https://medium.com/@ben/my-post-abc123def456</link>
        <guid>https://medium.com/p/abc123def456</guid>
        <dc:creator><![CDATA[Ben]]></dc:creator>
        <pubDate>Mon, 20 Jul 2026 10:00:00 GMT</pubDate>
        <content:encoded><![CDATA[<p>Hello <b>world</b></p>]]></content:encoded>
      </item>
    </channel></rss>`;
    const items = parseMediumFeed(xml);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      title: 'My Post',
      link: 'https://medium.com/@ben/my-post-abc123def456',
      author: 'Ben',
      contentSnippet: 'Hello world',
    });
    expect(items[0].publishedAtMs).toBe(Date.parse('Mon, 20 Jul 2026 10:00:00 GMT'));
    expect(mediumExternalId(items[0].link, items[0].guid)).toBe('abc123def456');
  });
});

describe('quora scan helpers', () => {
  it('builds search vs profile URLs', () => {
    expect(buildQuoraScanUrl(task({ platform: 'quora', scanKey: 'ai safety' }))).toBe(
      'https://www.quora.com/search?q=ai%20safety&type=answer'
    );
    expect(
      buildQuoraScanUrl(task({ platform: 'quora', scanType: 'tracked', scanKey: 'profile/Jane-Doe' }))
    ).toBe('https://www.quora.com/profile/Jane-Doe');
  });

  it('parses relative + absolute Quora times, drops unparseable', () => {
    const now = Date.parse('2026-07-27T00:00:00Z');
    expect(quoraTimeToMs('answered 2d ago', now)).toBe(now - 2 * 24 * 3600e3);
    expect(quoraTimeToMs('3mo', now)).toBe(now - 3 * 30 * 24 * 3600e3);
    expect(quoraTimeToMs('March 5, 2023', now)).toBe(Date.parse('March 5, 2023'));
    expect(quoraTimeToMs('', now)).toBeNull();
    expect(quoraTimeToMs('recently', now)).toBeNull();
  });
});
