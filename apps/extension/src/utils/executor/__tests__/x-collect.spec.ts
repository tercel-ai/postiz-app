import { describe, it, expect } from 'vitest';
import {
  parseUserTweets,
  collectUserRecent,
} from '@gitroom/extension/utils/executor/x.user-collect';
import {
  parseSearchList,
  parseTweetDetailFocal,
  extractTweetId,
} from '@gitroom/extension/utils/executor/x.collect';

// A minimal tweet_results.result node that parseTweetResult accepts.
function tweetNode(id: string, screen = 'alice', over: any = {}) {
  return {
    rest_id: id,
    legacy: {
      id_str: id,
      full_text: 't' + id,
      created_at: 'Wed Jun 18 12:00:00 +0000 2025',
      favorite_count: 1,
      reply_count: 2,
      retweet_count: 3,
      quote_count: 4,
      bookmark_count: 5,
      ...(over.legacy || {}),
    },
    core: {
      user_results: { result: { legacy: { screen_name: screen, name: screen } } },
    },
    views: { count: '99' },
    ...over,
  };
}

const tweetEntry = (id: string, node: any) => ({
  entryId: 'tweet-' + id,
  content: { itemContent: { tweet_results: { result: node } } },
});
const searchResultEntry = (id: string) => ({
  entryId: 'tweet-' + id,
  content: {
    entryType: 'TimelineTimelineItem',
    clientEventInfo: { component: 'result', element: 'tweet' },
    itemContent: {
      __typename: 'TimelineTweet',
      itemType: 'TimelineTweet',
      tweet_results: { result: tweetNode(id) },
    },
  },
});
const cursorEntry = (value: string) => ({
  entryId: 'cursor-bottom-1',
  content: { cursorType: 'Bottom', value },
});

function userTweetsData(addEntries: any[], pinned?: any) {
  const instructions: any[] = [];
  if (pinned) instructions.push({ type: 'TimelinePinEntry', entry: pinned });
  instructions.push({ type: 'TimelineAddEntries', entries: addEntries });
  return { user: { result: { timeline_v2: { timeline: { instructions } } } } };
}

describe('parseUserTweets', () => {
  it('parses own tweets, skips pinned, retweets and cursors', () => {
    const rt = tweetNode('200', 'bob', {
      legacy: { retweeted_status_result: { result: {} } },
    });
    const data = userTweetsData(
      [
        tweetEntry('300', tweetNode('300')),
        tweetEntry('200', rt), // retweet → skipped
        cursorEntry('NEXT'),
      ],
      tweetEntry('100', tweetNode('100')) // pinned → skipped
    );
    const { tweets, bottomCursor } = parseUserTweets(data);
    expect(tweets.map((t) => t.id)).toEqual(['300']);
    expect(bottomCursor).toBe('NEXT');
  });

  it('reads the alternate timeline (non-_v2) path', () => {
    const data = {
      user: {
        result: {
          timeline: {
            timeline: {
              instructions: [
                { type: 'TimelineAddEntries', entries: [tweetEntry('5', tweetNode('5'))] },
              ],
            },
          },
        },
      },
    };
    expect(parseUserTweets(data).tweets.map((t) => t.id)).toEqual(['5']);
  });

  it('returns empty for garbage', () => {
    expect(parseUserTweets(null).tweets).toEqual([]);
    expect(parseUserTweets({}).tweets).toEqual([]);
  });
});

describe('collectUserRecent', () => {
  const sessionWith = (data: any) =>
    ({
      navigateAndCapture: async (): Promise<unknown> => ({ data }),
      close: async (): Promise<void> => {},
    } as any);

  it('returns up to limit, newest-first, and advances newestId over ALL tweets', async () => {
    const data = userTweetsData([
      tweetEntry('30', tweetNode('30')),
      tweetEntry('20', tweetNode('20')),
      tweetEntry('10', tweetNode('10')),
    ]);
    const r = await collectUserRecent(sessionWith(data), 'alice', undefined, 2);
    expect(r.tweets.map((t) => t.id)).toEqual(['30', '20']);
    expect(r.newestId).toBe('30');
  });

  it('drops tweets not newer than sinceId (incremental)', async () => {
    const data = userTweetsData([
      tweetEntry('30', tweetNode('30')),
      tweetEntry('20', tweetNode('20')),
    ]);
    const r = await collectUserRecent(sessionWith(data), 'alice', '20', 10);
    expect(r.tweets.map((t) => t.id)).toEqual(['30']);
    expect(r.newestId).toBe('30');
  });

  it('returns empty (not throw) when capture fails', async () => {
    const session = {
      navigateAndCapture: async (): Promise<unknown> => null,
      close: async (): Promise<void> => {},
    } as any;
    const r = await collectUserRecent(session, 'alice', undefined, 10);
    expect(r.tweets).toEqual([]);
  });
});

describe('parseSearchList', () => {
  it('extracts tweets from a SearchTimeline payload', () => {
    const data = {
      search_by_raw_query: {
        search_timeline: {
          timeline: {
            instructions: [
              { entries: [searchResultEntry('7'), cursorEntry('C')] },
            ],
          },
        },
      },
    };
    expect(parseSearchList(data).map((t) => t.id)).toEqual(['7']);
  });

  it('keeps only official result tweet entries from the Top timeline', () => {
    const nonResultTweet = {
      entryId: 'tweet-8',
      content: {
        entryType: 'TimelineTimelineItem',
        clientEventInfo: { component: 'conversation', element: 'tweet' },
        itemContent: {
          __typename: 'TimelineTweet',
          itemType: 'TimelineTweet',
          tweet_results: { result: tweetNode('8') },
        },
      },
    };
    const module = {
      entryId: 'search-grid-0',
      content: {
        items: [
          {
            item: {
              itemContent: { tweet_results: { result: tweetNode('9') } },
            },
          },
        ],
      },
    };
    const frame = {
      entryId: 'frame-JetfuelTopTabFrame',
      content: {
        entryType: 'TimelineTimelineItem',
        itemContent: { __typename: 'TimelineFrame', itemType: 'TimelineFrame' },
      },
    };
    const data = {
      search_by_raw_query: {
        search_timeline: {
          timeline: {
            instructions: [
              {
                entries: [
                  frame,
                  searchResultEntry('7'),
                  nonResultTweet,
                  module,
                ],
              },
            ],
          },
        },
      },
    };

    expect(parseSearchList(data).map((t) => t.id)).toEqual(['7']);
  });

  it('returns empty for garbage', () => {
    expect(parseSearchList(null)).toEqual([]);
    expect(parseSearchList({})).toEqual([]);
  });
});

describe('parseTweetDetailFocal', () => {
  const detail = (entries: any[]) => ({
    threaded_conversation_with_injections_v2: { instructions: [{ entries }] },
  });

  it('returns the entry matching the focal id', () => {
    const data = detail([
      tweetEntry('900', tweetNode('900')),
      tweetEntry('901', tweetNode('901')),
    ]);
    expect(parseTweetDetailFocal(data, '901')?.id).toBe('901');
  });

  it('falls back to the first tweet when id not found', () => {
    const data = detail([tweetEntry('900', tweetNode('900'))]);
    expect(parseTweetDetailFocal(data, '999')?.id).toBe('900');
  });

  it('returns null when there are no tweets', () => {
    expect(parseTweetDetailFocal(detail([]), '1')).toBeNull();
    expect(parseTweetDetailFocal(null, '1')).toBeNull();
  });
});

describe('extractTweetId', () => {
  it('reads a raw numeric id', () => {
    expect(extractTweetId('1800000000000000001')).toBe('1800000000000000001');
  });
  it('reads an id from a status url', () => {
    expect(extractTweetId('https://x.com/alice/status/123456789?s=20')).toBe('123456789');
  });
  it('falls back to digit-stripping', () => {
    expect(extractTweetId('  98765  ')).toBe('98765');
  });
});
