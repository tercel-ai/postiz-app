import { describe, expect, it } from 'vitest';
import {
  isRedditCaptchaError,
  parseRedditSubmitResponse,
} from '../reddit.poster';

describe('parseRedditSubmitResponse', () => {
  it('extracts url and fullname from an api_type=json submit response', () => {
    const data = {
      json: {
        errors: [],
        data: {
          url: 'https://www.reddit.com/r/test/comments/abc123/a_title/',
          id: 'abc123',
          name: 't3_abc123',
        },
      },
    };
    expect(parseRedditSubmitResponse(data)).toEqual({
      permalink: 'https://www.reddit.com/r/test/comments/abc123/a_title/',
      postId: 't3_abc123',
    });
  });

  it('returns empty fields on missing or malformed responses', () => {
    expect(parseRedditSubmitResponse(undefined)).toEqual({
      permalink: undefined,
      postId: undefined,
    });
    expect(parseRedditSubmitResponse({ json: {} })).toEqual({
      permalink: undefined,
      postId: undefined,
    });
    expect(parseRedditSubmitResponse({ json: { data: { url: 42 } } })).toEqual({
      permalink: undefined,
      postId: undefined,
    });
  });
});

describe('isRedditCaptchaError', () => {
  it('detects a BAD_CAPTCHA error tuple from /api/submit', () => {
    // The exact shape Reddit returns for a captcha-gated submission.
    expect(
      isRedditCaptchaError([
        ['BAD_CAPTCHA', "That was a tricky one. Why don't you try that again.", 'captcha'],
      ])
    ).toBe(true);
  });

  it('is false for unrelated submit errors', () => {
    expect(
      isRedditCaptchaError([['RATELIMIT', 'you are doing that too much', 'ratelimit']])
    ).toBe(false);
    expect(isRedditCaptchaError([])).toBe(false);
  });
});
