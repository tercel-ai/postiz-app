import { describe, it, expect } from 'vitest';
import { parseTweetResult } from '@gitroom/extension/utils/executor/x.parse';

// A minimal tweet_results.result node parseTweetResult accepts. `over.legacy`
// merges into legacy so individual fields (e.g. created_at) can be dropped.
function node(over: any = {}) {
  return {
    rest_id: '123',
    legacy: {
      id_str: '123',
      full_text: 'hello',
      created_at: 'Wed Jun 18 12:00:00 +0000 2025',
      favorite_count: 1,
      reply_count: 2,
      retweet_count: 3,
      quote_count: 4,
      bookmark_count: 5,
      ...(over.legacy ?? {}),
    },
    core: { user_results: { result: { legacy: { screen_name: 'alice', name: 'Alice' } } } },
    views: { count: '99' },
    ...over,
  };
}

describe('parseTweetResult — publish time never fabricated', () => {
  it('parses created_at into an ISO postPublishedAt', () => {
    const t = parseTweetResult(node());
    expect(t?.createdAt).toBe(new Date('Wed Jun 18 12:00:00 +0000 2025').toISOString());
  });

  it('drops a tweet with a MISSING created_at instead of stamping "now"', () => {
    // A "now" fallback would silently store the scan moment as the publish time —
    // the exact bug this guards against. Undateable → null (dropped).
    const t = parseTweetResult(node({ legacy: { created_at: undefined } }));
    expect(t).toBeNull();
  });

  it('drops a tweet with an UNPARSEABLE created_at', () => {
    const t = parseTweetResult(node({ legacy: { created_at: 'not-a-date' } }));
    expect(t).toBeNull();
  });
});
