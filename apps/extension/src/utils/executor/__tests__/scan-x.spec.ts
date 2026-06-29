import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngageScanTask } from '../executor.types';

const { navigateAndCapture, close, openXReadTab, readViaProfile } = vi.hoisted(
  () => {
    const navigateAndCapture = vi.fn();
    const close = vi.fn();
    return {
      navigateAndCapture,
      close,
      openXReadTab: vi.fn(async () => ({ navigateAndCapture, close })),
      readViaProfile: vi.fn(),
    };
  }
);

vi.mock('../x.tab-reader', () => ({
  openXReadTab,
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
                    itemContent: { tweet_results: { result: tweet(id) } },
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
  });

  it('runs a keyword scan through an x.com tab and captured SearchTimeline response', async () => {
    const result = await scanX(task(), async () => true);

    expect(openXReadTab).toHaveBeenCalledOnce();
    expect(navigateAndCapture).toHaveBeenCalledWith(
      'https://x.com/search?q=artificial%20intelligence&src=typed_query',
      'SearchTimeline'
    );
    expect(close).toHaveBeenCalledOnce();
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
    expect(openXReadTab).not.toHaveBeenCalled();
    expect(result.posts.map((post) => post.externalPostId)).toEqual(['30']);
  });

  it('keeps only posts newer than the cursor and advances to the newest capture', async () => {
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

    expect(result.posts.map((post) => post.externalPostId)).toEqual(['30']);
    expect(result.nextCursor).toEqual({
      lastSeenExternalId: '30',
      lastSeenAt: '2025-06-18T12:00:00.000Z',
    });
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
    expect(openXReadTab).not.toHaveBeenCalled();
    expect(readViaProfile).not.toHaveBeenCalled();
  });

  it('reports an unsuccessful capture as non-exhausted and closes the tab', async () => {
    navigateAndCapture.mockResolvedValue(null);

    const result = await scanX(task(), async () => true);

    expect(result.exhausted).toBe(false);
    expect(result.posts).toEqual([]);
    expect(close).toHaveBeenCalledOnce();
  });
});
