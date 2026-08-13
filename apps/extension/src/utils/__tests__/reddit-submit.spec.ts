import { describe, expect, it } from 'vitest';
import {
  isRedditCaptchaError,
  isRedditPostRuleError,
  parseRedditSubmitResponse,
  redditPostRuleFromErrors,
  toAbsoluteRedditUrl,
} from '../reddit.poster';
import { canAutoSubmitReddit } from '../../pages/background/reddit.submit.tab';

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

  // Observed in production: the submit succeeded but `url` came back as the
  // bare path, which was stored verbatim as releaseURL — a dead link.
  it('absolutizes a host-relative url', () => {
    const data = {
      json: {
        errors: [],
        data: {
          url: '/r/football/comments/1vhwjma/tactical_deepdive/',
          name: 't3_1vhwjma',
        },
      },
    };
    expect(parseRedditSubmitResponse(data)).toEqual({
      permalink:
        'https://www.reddit.com/r/football/comments/1vhwjma/tactical_deepdive/',
      postId: 't3_1vhwjma',
    });
  });

  it('falls back to permalink when the response carries no url', () => {
    const data = {
      json: {
        errors: [],
        data: {
          permalink: '/r/test/comments/abc123/a_title/',
          name: 't3_abc123',
        },
      },
    };
    expect(parseRedditSubmitResponse(data)).toEqual({
      permalink: 'https://www.reddit.com/r/test/comments/abc123/a_title/',
      postId: 't3_abc123',
    });
  });
});

describe('toAbsoluteRedditUrl', () => {
  it('passes an absolute URL through untouched', () => {
    expect(
      toAbsoluteRedditUrl('https://old.reddit.com/r/test/comments/abc/x/')
    ).toBe('https://old.reddit.com/r/test/comments/abc/x/');
  });

  it('prefixes host-relative and scheme-relative forms', () => {
    expect(toAbsoluteRedditUrl('/r/test/comments/abc/x/')).toBe(
      'https://www.reddit.com/r/test/comments/abc/x/'
    );
    expect(toAbsoluteRedditUrl('//www.reddit.com/r/test/comments/abc/x/')).toBe(
      'https://www.reddit.com/r/test/comments/abc/x/'
    );
  });

  it('distinguishes a scheme-less host from a slash-less path', () => {
    expect(toAbsoluteRedditUrl('www.reddit.com/r/test/comments/abc/x/')).toBe(
      'https://www.reddit.com/r/test/comments/abc/x/'
    );
    expect(toAbsoluteRedditUrl('r/test/comments/abc/x/')).toBe(
      'https://www.reddit.com/r/test/comments/abc/x/'
    );
  });

  it('returns undefined for empty input', () => {
    expect(toAbsoluteRedditUrl('')).toBeUndefined();
    expect(toAbsoluteRedditUrl('   ')).toBeUndefined();
    expect(toAbsoluteRedditUrl(null)).toBeUndefined();
    expect(toAbsoluteRedditUrl(undefined)).toBeUndefined();
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

describe('redditPostRuleFromErrors', () => {
  it('reports flair and title-tag rules separately on the real r/machinelearning rejection', () => {
    expect(redditPostRuleFromErrors(FLAIR_AND_TAG_REQUIRED_ERRORS)).toEqual({
      flairRequired: true,
      titleTagRequired: true,
    });
  });

  it('reports a flair-only rejection', () => {
    expect(
      redditPostRuleFromErrors([
        ['SUBMIT_VALIDATION_FLAIR_REQUIRED', 'Your post must contain post flair.', 'flair'],
      ])
    ).toEqual({ flairRequired: true, titleTagRequired: false });
  });

  it('reports a title-tag-only rejection', () => {
    expect(
      redditPostRuleFromErrors([
        ['POST_GUIDANCE_VALIDATION_FAILED', 'Please add a required tag to your title', 'title'],
      ])
    ).toEqual({ flairRequired: false, titleTagRequired: true });
  });

  it('reports neither for unrelated errors', () => {
    expect(
      redditPostRuleFromErrors([['RATELIMIT', 'you are doing that too much', 'ratelimit']])
    ).toEqual({ flairRequired: false, titleTagRequired: false });
  });
});

describe('canAutoSubmitReddit', () => {
  // The captcha route carries no postRule: the pre-existing behaviour there is
  // "nothing proposed = nothing to confirm", and must not regress.
  it('allows an unattended click when no flair was proposed and no rule bounced the post', () => {
    expect(
      canAutoSubmitReddit({ flairProposed: false, flairApplied: false })
    ).toBe(true);
  });

  it('blocks when a flair was proposed but never observed to commit', () => {
    expect(
      canAutoSubmitReddit({ flairProposed: true, flairApplied: false })
    ).toBe(false);
  });

  it('allows when the proposed flair was observed to commit', () => {
    expect(
      canAutoSubmitReddit({ flairProposed: true, flairApplied: true })
    ).toBe(true);
  });

  // The case this exists for: a subreddit whose custom flair set has no "no
  // flair" option. Nothing is proposed, nothing can be picked unattended, and
  // Reddit already rejected this exact submission once — clicking Post again
  // only burns the confirm window before the same hand-off.
  it('blocks a flair-required subreddit when no flair was proposed', () => {
    expect(
      canAutoSubmitReddit({
        flairProposed: false,
        flairApplied: false,
        postRule: { flairRequired: true, titleTagRequired: false },
      })
    ).toBe(false);
  });

  it('blocks a flair-required subreddit when the proposed label matched nothing', () => {
    expect(
      canAutoSubmitReddit({
        flairProposed: true,
        flairApplied: false,
        postRule: { flairRequired: true, titleTagRequired: false },
      })
    ).toBe(false);
  });

  it('allows a flair-required subreddit once the flair actually committed', () => {
    expect(
      canAutoSubmitReddit({
        flairProposed: true,
        flairApplied: true,
        postRule: { flairRequired: true, titleTagRequired: false },
      })
    ).toBe(true);
  });

  // applyTitleTag folds the tag in upstream, so a rejection means none was ever
  // proposed — a committed flair does not make the post publishable.
  it('blocks a title-tag rejection even when the flair committed', () => {
    expect(
      canAutoSubmitReddit({
        flairProposed: true,
        flairApplied: true,
        postRule: { flairRequired: true, titleTagRequired: true },
      })
    ).toBe(false);
  });
});
