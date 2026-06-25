import { describe, it, expect } from 'vitest';
import { parseXTweetId } from '../x-tweet';

describe('parseXTweetId', () => {
  it.each([
    ['https://x.com/u/status/2061267353544146949?s=20', '2061267353544146949'],
    ['https://x.com/u/status/2061267353544146949', '2061267353544146949'],
    ['https://twitter.com/u/status/123?s=20&t=abc', '123'],
    ['https://mobile.twitter.com/u/status/456/', '456'],
    ['https://x.com/i/web/status/789', '789'],
    ['  x.com/u/status/321 ', '321'],
    ['https://x.com/u/statuses/999', '999'],
  ])('extracts the id from %s', (url, expected) => {
    expect(parseXTweetId(url)).toBe(expected);
  });

  it.each([
    'https://x.com/zhngyq310334',
    'https://x.com',
    'not a url',
    '',
    null,
    undefined,
  ])('returns null when there is no /status/<id>: %s', (url) => {
    expect(parseXTweetId(url as string)).toBeNull();
  });
});
