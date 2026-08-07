import { describe, expect, it } from 'vitest';
import {
  isRedditCaptchaError,
  isRedditPostRuleError,
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

// Real /api/submit rejection captured from r/machinelearning — the exact shape
// isRedditPostRuleError routes to the submit tab.
const FLAIR_AND_TAG_REQUIRED_ERRORS = [
  ['SUBMIT_VALIDATION_FLAIR_REQUIRED', 'Your post must contain post flair.', 'flair'],
  [
    'POST_GUIDANCE_VALIDATION_FAILED',
    'Please add a required tag to your title, such as [R], [N], [P], or [D], to prevent automatic removal. See the subreddit rules for the full list of valid tags.',
    'title',
  ],
  [
    'POST_GUIDANCE_VALIDATION_FAILED',
    'Please add a required tag to your title, such as [R], [N], [P], or [D], to prevent automatic removal. See the subreddit rules for the full list of valid tags.',
    'url',
  ],
];

describe('isRedditPostRuleError', () => {
  it('detects the real r/machinelearning flair + title-tag rejection', () => {
    expect(isRedditPostRuleError(FLAIR_AND_TAG_REQUIRED_ERRORS)).toBe(true);
  });

  it('detects a flair-only rejection', () => {
    expect(
      isRedditPostRuleError([
        ['SUBMIT_VALIDATION_FLAIR_REQUIRED', 'Your post must contain post flair.', 'flair'],
      ])
    ).toBe(true);
  });

  it('detects a title-tag-only rejection', () => {
    expect(
      isRedditPostRuleError([
        ['POST_GUIDANCE_VALIDATION_FAILED', 'Please add a required tag to your title', 'title'],
      ])
    ).toBe(true);
  });

  // A rule error routes to the submit TAB; an unrelated error must keep failing
  // fast, so this boundary is what keeps a banned/ratelimited post from parking
  // an unattended tab for minutes.
  it('is false for unrelated submit errors', () => {
    expect(
      isRedditPostRuleError([['RATELIMIT', 'you are doing that too much', 'ratelimit']])
    ).toBe(false);
    expect(
      isRedditPostRuleError([['SUBREDDIT_NOTALLOWED', 'you are banned', 'sr']])
    ).toBe(false);
    expect(isRedditPostRuleError([])).toBe(false);
  });

  it('does not swallow a captcha error (that has its own branch)', () => {
    expect(
      isRedditPostRuleError([
        ['BAD_CAPTCHA', "That was a tricky one. Why don't you try that again.", 'captcha'],
      ])
    ).toBe(false);
  });
});
