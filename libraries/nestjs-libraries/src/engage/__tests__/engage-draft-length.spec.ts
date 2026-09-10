import { describe, it, expect } from 'vitest';
import {
  assertDraftWithinPlatformLimit,
  normalizeEngagePlatform,
  REDDIT_HARD_CHAR_LIMIT,
  X_HARD_CHAR_LIMIT,
} from '@gitroom/nestjs-libraries/engage/engage-draft-length';
import { hardLimitFor } from '@gitroom/nestjs-libraries/integrations/platform-content-profile';

const text = (n: number) => 'a'.repeat(n);

describe('assertDraftWithinPlatformLimit', () => {
  // x and reddit keep engage's own numbers. Reddit's 2000 is deliberately
  // STRICTER than the provider's 10000 ceiling and is not relaxed by the
  // seven-platform rollout below.
  describe('x and reddit (unchanged)', () => {
    it('accepts an X draft at the ceiling and rejects one past it', () => {
      expect(() => assertDraftWithinPlatformLimit('x', text(X_HARD_CHAR_LIMIT))).not.toThrow();
      expect(() =>
        assertDraftWithinPlatformLimit('x', text(X_HARD_CHAR_LIMIT + 1))
      ).toThrow(/Twitter-weighted characters/);
    });

    it('applies X weighted counting, not raw length', () => {
      // CJK counts 2, so half as many characters reach the same ceiling.
      expect(() =>
        assertDraftWithinPlatformLimit('x', '中'.repeat(X_HARD_CHAR_LIMIT / 2 + 1))
      ).toThrow();
    });

    it('maps the legacy twitter identifier onto x', () => {
      expect(normalizeEngagePlatform('twitter')).toBe('x');
      expect(() =>
        assertDraftWithinPlatformLimit('twitter', text(X_HARD_CHAR_LIMIT + 1))
      ).toThrow(/Twitter-weighted characters/);
    });

    it("keeps engage's stricter reddit ceiling rather than the provider's", () => {
      expect(REDDIT_HARD_CHAR_LIMIT).toBeLessThan(hardLimitFor('reddit'));
      expect(() =>
        assertDraftWithinPlatformLimit('reddit', text(REDDIT_HARD_CHAR_LIMIT))
      ).not.toThrow();
      expect(() =>
        assertDraftWithinPlatformLimit('reddit', text(REDDIT_HARD_CHAR_LIMIT + 1))
      ).toThrow(/Generated Reddit draft exceeded 2000 characters/);
    });
  });

  // These five used to pass ANY length silently — the gate only knew x and
  // reddit — so a cross-platform generation could hand back a LinkedIn post
  // that the publisher would later refuse.
  describe('the five platforms that were previously unchecked', () => {
    it.each([
      ['linkedin', 3000],
      ['devto', 100000],
      ['medium', 100000],
      ['quora', 20000],
      ['hackernews', 20000],
    ])("enforces %s's provider ceiling of %i", (platform, ceiling) => {
      expect(hardLimitFor(platform)).toBe(ceiling);
      expect(() => assertDraftWithinPlatformLimit(platform, text(ceiling))).not.toThrow();
      expect(() => assertDraftWithinPlatformLimit(platform, text(ceiling + 1))).toThrow(
        new RegExp(`Generated ${platform} draft exceeded ${ceiling} characters`)
      );
    });

    it('counts raw characters, not X weighting', () => {
      // 2000 CJK characters weigh 4000 on X but are 2000 characters here, so a
      // LinkedIn draft of them stays comfortably inside the 3000 ceiling.
      expect(() =>
        assertDraftWithinPlatformLimit('linkedin', '中'.repeat(2000))
      ).not.toThrow();
    });

    // Same soft-target/hard-ceiling posture as x and reddit: outputLength only
    // steers the prompt, so it can raise the gate but never tighten it.
    it('treats an explicit outputLength as a floor of the ceiling, never a cap', () => {
      expect(() =>
        assertDraftWithinPlatformLimit('linkedin', text(2000), 500)
      ).not.toThrow();
      expect(() =>
        assertDraftWithinPlatformLimit('linkedin', text(4000), 5000)
      ).not.toThrow();
    });
  });

  // Unchanged behaviour for anything the module was never taught about:
  // inventing a ceiling for it would reject drafts that used to pass.
  it('stays silent for a platform outside the scannable set', () => {
    expect(() =>
      assertDraftWithinPlatformLimit('facebook', text(200000))
    ).not.toThrow();
    expect(() =>
      assertDraftWithinPlatformLimit('not-a-platform', text(200000))
    ).not.toThrow();
  });
});
