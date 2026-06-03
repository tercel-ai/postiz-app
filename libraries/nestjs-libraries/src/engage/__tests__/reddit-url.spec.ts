import { describe, it, expect } from 'vitest';
import { parseRedditCommentId } from '../reddit-url';

describe('parseRedditCommentId', () => {
  it.each([
    // new /comment/<id>/ permalink with share params
    [
      'https://www.reddit.com/r/SEO/comments/1skxs73/comment/og2vc34/?utm_source=share&utm_medium=web3x',
      'og2vc34',
    ],
    [
      'https://www.reddit.com/r/SEO/comments/1skxs73/comment/opgs5z0/?utm_source=share',
      'opgs5z0',
    ],
    // legacy title-slug permalink
    [
      'https://www.reddit.com/r/nba/comments/tdfnx6/some_title_slug/abc123/',
      'abc123',
    ],
    // missing scheme + whitespace
    ['  reddit.com/r/x/comments/p1/comment/cmt99/ ', 'cmt99'],
  ])('extracts the comment id from %s', (url, expected) => {
    expect(parseRedditCommentId(url)).toBe(expected);
  });

  it.each([
    // truncated link — the real BcuzRacecar row that became un-syncable
    'https://www.reddit.com/r/nba/comments/d',
    // link to the POST, not a comment (no <commentId> segment)
    'https://www.reddit.com/r/SEO/comments/1n7glmq/understanding_geo_in_seo/',
    'https://www.reddit.com/r/SEO',
    'not a url',
    '',
    null,
    undefined,
  ])('returns null when there is no comment id: %s', (url) => {
    expect(parseRedditCommentId(url as string)).toBeNull();
  });
});
