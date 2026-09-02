import { describe, it, expect } from 'vitest';
import {
  isThreadCapablePlatform,
  threadCapablePlatforms,
} from '../thread-capability';
import { SCANNABLE_PLATFORMS } from '@gitroom/nestjs-libraries/engage/engage-scan-config.service';

// Pins the ONE thread-capability rule. Its whole point is that neither publish
// path alone answers the question, so the cases below are written per PATH,
// not per platform: a provider gaining/losing `comment()`, or a platform
// moving in or out of SINGLE_SEGMENT_PLATFORMS, must show up here.
describe('isThreadCapablePlatform', () => {
  it('accepts platforms whose provider can chain via comment() on the API path', () => {
    expect(isThreadCapablePlatform('x')).toBe(true);
    expect(isThreadCapablePlatform('reddit')).toBe(true);
    expect(isThreadCapablePlatform('linkedin')).toBe(true);
    expect(isThreadCapablePlatform('mastodon')).toBe(true);
  });

  it('accepts a platform only the EXTENSION can chain (Hacker News has no write API at all)', () => {
    // The regression this rule exists for: judging by comment() alone called
    // HN unthreadable, even though every HN post goes out through the
    // extension, which chains follow-up comments fine.
    expect(isThreadCapablePlatform('hackernews')).toBe(true);
  });

  it('rejects the single-segment article surfaces on every path', () => {
    expect(isThreadCapablePlatform('medium')).toBe(false);
    expect(isThreadCapablePlatform('quora')).toBe(false);
    expect(isThreadCapablePlatform('devto')).toBe(false);
  });

  it('rejects an unknown or empty platform rather than guessing', () => {
    expect(isThreadCapablePlatform('')).toBe(false);
    expect(isThreadCapablePlatform('not-a-platform')).toBe(false);
    // Takes provider identifiers — engage's legacy `twitter` is normalized by
    // its callers (normalizeEngagePlatform), never here.
    expect(isThreadCapablePlatform('twitter')).toBe(false);
  });

  it('covers every scannable engage platform with an explicit verdict', () => {
    // Guards the pairing the engage reference-post feature depends on: a new
    // SCANNABLE_PLATFORMS entry must get a thread verdict here, not inherit
    // one by accident.
    expect(
      Object.fromEntries(
        SCANNABLE_PLATFORMS.map((p) => [p, isThreadCapablePlatform(p)])
      )
    ).toEqual({
      x: true,
      reddit: true,
      linkedin: true,
      hackernews: true,
      medium: false,
      quora: false,
      devto: false,
    });
  });

  it('filters a list while preserving order', () => {
    expect(
      threadCapablePlatforms(['medium', 'x', 'devto', 'reddit'])
    ).toEqual(['x', 'reddit']);
  });
});
