import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EngageScanTask } from '../executor.types';
import { scanReddit } from '../scan.reddit';

function task(over: Partial<EngageScanTask> = {}): EngageScanTask {
  return {
    taskId: 'lease-token',
    platform: 'reddit',
    scanType: 'keyword',
    scanKey: 'openai',
    cursor: { lastSeenExternalId: null, lastSeenAt: null },
    pacing: {
      maxPages: 1,
      pageSize: 25,
      pageDelayMs: 0,
      pageJitterMs: 0,
      interUnitDelayMs: 0,
      interUnitJitterMs: 0,
      hourlyRequestCap: 60,
    },
    ...over,
  };
}

function child(over: Record<string, any>) {
  return {
    data: {
      id: 'p1',
      name: 't3_p1',
      permalink: '/r/test/comments/p1/x/',
      subreddit: 'test',
      author: 'alice',
      title: 'hello',
      created_utc: 1_750_000_000, // 2025-06-15T…Z
      score: 5,
      num_comments: 2,
      ...over,
    },
  };
}

function mockFetchOnce(children: any[]) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: { after: null, children } }),
  })) as any;
}

const gateOpen = async () => true;

afterEach(() => vi.restoreAllMocks());

describe('scanReddit — publish time never fabricated', () => {
  it('ingests a post using its real created_utc as postPublishedAt', async () => {
    vi.stubGlobal('fetch', mockFetchOnce([child({ id: 'p1', name: 't3_p1' })]));

    const { posts } = await scanReddit(task(), gateOpen);

    expect(posts).toHaveLength(1);
    expect(posts[0].postPublishedAt).toBe(new Date(1_750_000_000 * 1000).toISOString());
  });

  it('DROPS a post with a missing created_utc instead of stamping 1970/now', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchOnce([
        child({ id: 'good', name: 't3_good', created_utc: 1_750_000_000 }),
        child({ id: 'bad', name: 't3_bad', created_utc: undefined }),
      ])
    );

    const { posts } = await scanReddit(task(), gateOpen);

    expect(posts.map((p) => p.externalPostId)).toEqual(['good']);
    // No fabricated 1970 epoch leaked in.
    expect(posts.every((p) => new Date(p.postPublishedAt).getUTCFullYear() > 2000)).toBe(true);
  });
});
