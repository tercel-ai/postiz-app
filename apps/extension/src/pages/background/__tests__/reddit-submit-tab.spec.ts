import { describe, expect, it } from 'vitest';
import {
  buildRedditSubmitUrl,
  redditPermalinkFromSubmittedUrl,
} from '../reddit.submit.tab';

describe('buildRedditSubmitUrl', () => {
  it('builds a prefilled reddit.com self-post submit URL', () => {
    const url = new URL(buildRedditSubmitUrl('test', 'My title', 'body text'));
    expect(url.origin).toBe('https://www.reddit.com');
    expect(url.pathname).toBe('/r/test/submit/');
    expect(url.searchParams.get('type')).toBe('TEXT');
    expect(url.searchParams.get('title')).toBe('My title');
    expect(url.searchParams.get('text')).toBe('body text');
  });

  it('strips an r/ prefix and trailing slash from the subreddit', () => {
    const url = new URL(buildRedditSubmitUrl('/r/webdev/', 'T', ''));
    expect(url.pathname).toBe('/r/webdev/submit/');
    // no empty text param when the body is empty
    expect(url.searchParams.has('text')).toBe(false);
  });
});

describe('redditPermalinkFromSubmittedUrl', () => {
  it('returns the canonical www permalink + t3_ id for a comments URL', () => {
    expect(
      redditPermalinkFromSubmittedUrl(
        'https://www.reddit.com/r/test/comments/abc123/a_title/'
      )
    ).toEqual({
      permalink: 'https://www.reddit.com/r/test/comments/abc123/a_title/',
      postId: 't3_abc123',
    });
  });

  it('returns null while still on the submit form', () => {
    expect(
      redditPermalinkFromSubmittedUrl('https://www.reddit.com/r/test/submit/')
    ).toBeNull();
  });

  it('returns null for a non-reddit host', () => {
    expect(
      redditPermalinkFromSubmittedUrl('https://example.com/r/test/comments/x/')
    ).toBeNull();
  });

  it('returns null for an unparseable string', () => {
    expect(redditPermalinkFromSubmittedUrl('not a url')).toBeNull();
  });
});
