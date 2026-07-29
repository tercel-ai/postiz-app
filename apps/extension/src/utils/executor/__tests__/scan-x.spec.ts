import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngageScanTask } from '../executor.types';

const {
  navigateAndCapture,
  scrollAndCapture,
  navigate,
  close,
  withSharedXTab,
  readViaProfile,
} = vi.hoisted(
  () => {
    const navigateAndCapture = vi.fn();
    const scrollAndCapture = vi.fn();
    const navigate = vi.fn();
    const close = vi.fn();
    return {
      navigateAndCapture,
      scrollAndCapture,
      navigate,
      close,
      // Mirrors the real helper: hands the caller a session bound to the shared
      // warm tab. `close` is wired in so tests can assert scanX never calls it —
      // the shared tab is reclaimed by the idle timer, not by the scan.
      withSharedXTab: vi.fn(async (fn: (session: unknown) => Promise<unknown>) =>
        fn({ navigateAndCapture, scrollAndCapture, navigate, close })
      ),
      readViaProfile: vi.fn(),
    };
  }
);

vi.mock('../x.tab-reader', () => ({
  withSharedXTab,
  readViaProfile,
}));

import { scanX } from '../scan.x';

function task(over: Partial<EngageScanTask> = {}): EngageScanTask {
  return {
    taskId: 'lease-token',
    platform: 'x',
    scanType: 'keyword',
    scanKey: 'artificial intelligence',
    cursor: { lastSeenExternalId: null, lastSeenAt: null },
    pacing: {
      maxPages: 1,
      pageSize: 20,
      pageDelayMs: 8_000,
      pageJitterMs: 60_000,
      interUnitDelayMs: 60_000,
      interUnitJitterMs: 60_000,
      hourlyRequestCap: 60,
    },
    ...over,
  };
}

function tweet(id: string, text = `tweet-${id}`) {
  return {
    __typename: 'Tweet',
    rest_id: id,
    legacy: {
      id_str: id,
      full_text: text,
      created_at: 'Wed Jun 18 12:00:00 +0000 2025',
      favorite_count: 1,
      reply_count: 2,
      retweet_count: 3,
      quote_count: 4,
      bookmark_count: 5,
    },
    core: {
      user_results: {
        result: { legacy: { screen_name: 'alice', name: 'Alice' } },
      },
    },
    views: { count: '6' },
  };
}

function searchResponse(...ids: string[]) {
  return {
    data: {
      search_by_raw_query: {
        search_timeline: {
          timeline: {
            instructions: [
              {
                entries: ids.map((id) => ({
                  entryId: `tweet-${id}`,
                  content: {
                    entryType: 'TimelineTimelineItem',
                    clientEventInfo: {
                      component: 'result',
                      element: 'tweet',
                    },
                    itemContent: {
                      __typename: 'TimelineTweet',
                      itemType: 'TimelineTweet',
                      tweet_results: { result: tweet(id) },
                    },
                  },
                })),
              },
            ],
          },
        },
      },
    },
  };
}

describe('scanX real-page execution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    navigateAndCapture.mockResolvedValue({
      data: {
        search_by_raw_query: {
          search_timeline: { timeline: { instructions: [] } },
        },
      },
    });
    scrollAndCapture.mockResolvedValue(null);
  });

  it('runs a keyword scan through x.com Top SearchTimeline results', async () => {
    const result = await scanX(task(), async () => true);

    expect(withSharedXTab).toHaveBeenCalledOnce();
    expect(navigateAndCapture).toHaveBeenCalledWith(
      'https://x.com/search?q=artificial%20intelligence&src=typed_query',
      'SearchTimeline'
    );
    // The shared tab outlives the scan — it is closed by the idle timer in
    // x.tab-reader, never by scanX itself.
    expect(close).not.toHaveBeenCalled();
    expect(result).toEqual({
      posts: [],
      nextCursor: { lastSeenExternalId: null, lastSeenAt: null },
      exhausted: true,
    });
  });

  it('runs a tracked scan through profile-first navigation using the task rawQuery', async () => {
    readViaProfile.mockResolvedValue(searchResponse('30'));

    const result = await scanX(
      task({
        scanType: 'tracked',
        scanKey: 'alice',
        rawQuery: 'from:alice (ai OR agents)',
      }),
      async () => true
    );

    expect(readViaProfile).toHaveBeenCalledWith(
      'https://x.com/alice',
      'https://x.com/search?q=from%3Aalice%20(ai%20OR%20agents)&src=typed_query',
      'SearchTimeline'
    );
    expect(withSharedXTab).not.toHaveBeenCalled();
    expect(result.posts.map((post) => post.externalPostId)).toEqual(['30']);
  });

  it('does not cursor-filter keyword Top results because relevant older posts can surface later', async () => {
    navigateAndCapture.mockResolvedValue(searchResponse('30', '20', '10'));

    const result = await scanX(
      task({
        cursor: {
          lastSeenExternalId: '20',
          lastSeenAt: '2025-06-17T12:00:00.000Z',
        },
      }),
      async () => true
    );

    expect(result.posts.map((post) => post.externalPostId)).toEqual(['30', '20', '10']);
    expect(result.nextCursor).toEqual({
      lastSeenExternalId: '30',
      lastSeenAt: '2025-06-18T12:00:00.000Z',
    });
  });

  it('keeps only posts newer than the cursor for tracked scans', async () => {
    readViaProfile.mockResolvedValue(searchResponse('30', '20', '10'));

    const result = await scanX(
      task({
        scanType: 'tracked',
        scanKey: 'alice',
        cursor: {
          lastSeenExternalId: '20',
          lastSeenAt: '2025-06-17T12:00:00.000Z',
        },
      }),
      async () => true
    );

    expect(result.posts.map((post) => post.externalPostId)).toEqual(['30']);
    expect(result.nextCursor).toEqual({
      lastSeenExternalId: '30',
      lastSeenAt: '2025-06-18T12:00:00.000Z',
    });
  });

  it('still collects a newer tweet ranked BELOW an old one when cursor filtering is enabled', async () => {
    // '10' (old, below cursor) is listed first, '30' (genuinely new) second —
    // a naive "break at the first non-newer tweet" would stop at '10' and
    // silently miss '30'.
    readViaProfile.mockResolvedValue(searchResponse('10', '30'));

    const result = await scanX(
      task({
        scanType: 'tracked',
        scanKey: 'alice',
        cursor: {
          lastSeenExternalId: '20',
          lastSeenAt: '2025-06-17T12:00:00.000Z',
        },
      }),
      async () => true
    );

    expect(result.posts.map((post) => post.externalPostId)).toEqual(['30']);
    expect(result.nextCursor.lastSeenExternalId).toBe('30');
  });

  it('uses maxPages to collect additional keyword SearchTimeline responses via scrolling', async () => {
    navigateAndCapture.mockResolvedValue(searchResponse('30', '20'));
    scrollAndCapture
      .mockResolvedValueOnce(searchResponse('40', '20'))
      .mockResolvedValueOnce(searchResponse('50'));

    const result = await scanX(
      task({
        pacing: {
          ...task().pacing,
          maxPages: 3,
          pageDelayMs: 0,
          pageJitterMs: 0,
        },
      }),
      async () => true
    );

    expect(navigateAndCapture).toHaveBeenCalledOnce();
    expect(scrollAndCapture).toHaveBeenCalledTimes(2);
    expect(scrollAndCapture).toHaveBeenNthCalledWith(1, 'SearchTimeline');
    expect(result.posts.map((post) => post.externalPostId)).toEqual([
      '30',
      '20',
      '40',
      '50',
    ]);
    expect(result.nextCursor.lastSeenExternalId).toBe('50');
  });

  it('does not open an X tab when the hourly request gate rejects the scan', async () => {
    const current = task({
      cursor: {
        lastSeenExternalId: '20',
        lastSeenAt: '2025-06-17T12:00:00.000Z',
      },
    });

    await expect(scanX(current, async () => false)).resolves.toEqual({
      posts: [],
      nextCursor: current.cursor,
      exhausted: false,
    });
    expect(withSharedXTab).not.toHaveBeenCalled();
    expect(readViaProfile).not.toHaveBeenCalled();
  });

  it('reports an unsuccessful capture as non-exhausted without closing the shared tab', async () => {
    navigateAndCapture.mockResolvedValue(null);

    const result = await scanX(task(), async () => true);

    expect(result.exhausted).toBe(false);
    expect(result.posts).toEqual([]);
    expect(close).not.toHaveBeenCalled();
  });

  it('reports non-exhausted when the shared X tab cannot be created', async () => {
    withSharedXTab.mockResolvedValueOnce(null);
    const current = task();

    const result = await scanX(current, async () => true);

    expect(result).toEqual({
      posts: [],
      nextCursor: current.cursor,
      exhausted: false,
    });
    expect(navigateAndCapture).not.toHaveBeenCalled();
  });
});
