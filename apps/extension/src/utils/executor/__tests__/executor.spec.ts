import { describe, it, expect } from 'vitest';
import {
  parseTweetResult,
  unwrapTweet,
  newerId,
  isNewerThan,
} from '@gitroom/extension/utils/executor/x.parse';
import { statusIdFromUrl } from '@gitroom/extension/utils/executor/metrics.x';
import { jitteredDelayMs } from '@gitroom/extension/utils/executor/pacing';

// A minimal legacy-shaped tweet result node.
function legacyTweet(overrides: any = {}) {
  return {
    __typename: 'Tweet',
    rest_id: '1800000000000000001',
    legacy: {
      id_str: '1800000000000000001',
      full_text: 'hello world',
      created_at: 'Wed Jun 18 12:00:00 +0000 2025',
      favorite_count: 5,
      reply_count: 2,
      retweet_count: 3,
      quote_count: 1,
      bookmark_count: 4,
    },
    core: {
      user_results: {
        result: {
          legacy: {
            screen_name: 'alice',
            name: 'Alice',
            profile_image_url_https: 'https://x/abc_normal.jpg',
            followers_count: 1234,
          },
        },
      },
    },
    views: { count: '999' },
    ...overrides,
  };
}

describe('parseTweetResult', () => {
  it('parses a legacy tweet with metrics + author', () => {
    const t = parseTweetResult(legacyTweet());
    expect(t).not.toBeNull();
    expect(t!.id).toBe('1800000000000000001');
    expect(t!.text).toBe('hello world');
    expect(t!.authorUsername).toBe('alice');
    expect(t!.authorDisplayName).toBe('Alice');
    expect(t!.authorFollowers).toBe(1234);
    expect(t!.authorAvatarUrl).toBe('https://x/abc_400x400.jpg'); // upscaled
    expect(t!.likes).toBe(5);
    expect(t!.replies).toBe(2);
    expect(t!.retweets).toBe(3);
    expect(t!.quotes).toBe(1);
    expect(t!.bookmarks).toBe(4);
    expect(t!.views).toBe(999);
  });

  it('unwraps a TweetWithVisibilityResults node', () => {
    const wrapped = {
      __typename: 'TweetWithVisibilityResults',
      tweet: legacyTweet(),
    };
    expect(unwrapTweet(wrapped)).toBe(wrapped.tweet);
    expect(parseTweetResult(wrapped)!.id).toBe('1800000000000000001');
  });

  it('prefers note_tweet text over legacy.full_text (longform)', () => {
    const t = parseTweetResult(
      legacyTweet({
        note_tweet: {
          note_tweet_results: { result: { text: 'the full long body' } },
        },
      })
    );
    expect(t!.text).toBe('the full long body');
  });

  it('reads newer core user fields when legacy author is absent', () => {
    const node = legacyTweet({
      core: {
        user_results: {
          result: {
            core: { screen_name: 'bob', name: 'Bob' },
            avatar: { image_url: 'https://x/z_normal.png' },
          },
        },
      },
    });
    const t = parseTweetResult(node);
    expect(t!.authorUsername).toBe('bob');
    expect(t!.authorAvatarUrl).toBe('https://x/z_400x400.png');
    expect(t!.authorFollowers).toBeUndefined();
  });

  it('returns null for an unreadable node', () => {
    expect(parseTweetResult(null)).toBeNull();
    expect(parseTweetResult({ rest_id: '1' })).toBeNull(); // no legacy
  });
});

describe('newerId / isNewerThan', () => {
  it('compares snowflake ids without precision loss', () => {
    expect(newerId('1800000000000000002', '1800000000000000001')).toBe(
      '1800000000000000002'
    );
    expect(newerId(undefined, '5')).toBe('5');
    expect(newerId('5', undefined)).toBe('5');
  });

  it('isNewerThan is strict and true when no sinceId', () => {
    expect(isNewerThan('10', '9')).toBe(true);
    expect(isNewerThan('9', '9')).toBe(false);
    expect(isNewerThan('8', '9')).toBe(false);
    expect(isNewerThan('8', null)).toBe(true);
  });
});

describe('statusIdFromUrl', () => {
  it('extracts the id from canonical and i/web URLs', () => {
    expect(statusIdFromUrl('https://x.com/alice/status/123456')).toBe('123456');
    expect(statusIdFromUrl('https://twitter.com/x/statuses/789')).toBe('789');
    expect(statusIdFromUrl('https://x.com/i/web/status/42')).toBe('42');
    expect(statusIdFromUrl('https://x.com/alice')).toBeNull();
    expect(statusIdFromUrl('not a url')).toBeNull();
  });
});

describe('jitteredDelayMs', () => {
  it('stays within [base, base+jitter)', () => {
    for (let i = 0; i < 200; i++) {
      const ms = jitteredDelayMs(1000, 500);
      expect(ms).toBeGreaterThanOrEqual(1000);
      expect(ms).toBeLessThan(1500);
    }
  });

  it('returns base when jitter is 0 and 0 for non-positive base', () => {
    expect(jitteredDelayMs(800, 0)).toBe(800);
    expect(jitteredDelayMs(0, 0)).toBe(0);
    expect(jitteredDelayMs(-5, 0)).toBe(0);
  });
});
