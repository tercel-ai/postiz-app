import { describe, it, expect } from 'vitest';
import {
  assertDraftWithinPlatformLimit,
  downgradedReferencePostTarget,
  normalizeEngagePlatform,
  xReferencePostTarget,
  xReferencePostTierFor,
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

    // outputLength is not accepted by this hard-limit helper: it belongs only
    // to prompt construction and can never alter the provider ceiling.
    it('always enforces the provider ceiling', () => {
      expect(() =>
        assertDraftWithinPlatformLimit('linkedin', text(2000))
      ).not.toThrow();
      expect(() =>
        assertDraftWithinPlatformLimit('linkedin', text(4000))
      ).toThrow(/Generated linkedin draft exceeded 3000 characters/);
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

  // The retry quotes this message back to the model, which has no other way to
  // tell trimming a clause from rewriting the post.
  it('reports the measured length, not just that a limit was passed', () => {
    expect(() => assertDraftWithinPlatformLimit('x', text(341))).toThrow(
      /measured 341/
    );
    expect(() =>
      assertDraftWithinPlatformLimit('reddit', text(REDDIT_HARD_CHAR_LIMIT + 5))
    ).toThrow(/measured 2005/);
    // Weighted, like the ceiling it is compared against.
    expect(() => assertDraftWithinPlatformLimit('x', '中'.repeat(200))).toThrow(
      /measured 400/
    );
  });
});

describe('X reference-post length tiers', () => {
  it('spaces the tiers to leave drift headroom under the 280 ceiling', () => {
    expect(xReferencePostTarget('short', 1)).toBe(65);
    expect(xReferencePostTarget('medium', 1)).toBe(130);
    expect(xReferencePostTarget('long', 1)).toBe(260);
  });

  // Every part faces the ceiling on its own, so a chain is N independent
  // chances to overshoot rather than one.
  it('tightens only the long tier for a thread', () => {
    expect(xReferencePostTarget('long', 3)).toBe(220);
    expect(xReferencePostTarget('medium', 3)).toBe(130);
    expect(xReferencePostTarget('short', 3)).toBe(65);
  });
});

describe('xReferencePostTierFor', () => {
  // outputLength is a client's Short/Medium/Long picker resolved to a number,
  // so it names a tier rather than a literal budget.
  it('snaps down to the largest tier at or below the request', () => {
    expect(xReferencePostTierFor(270, 1)).toBe('long');
    expect(xReferencePostTierFor(260, 1)).toBe('long');
    expect(xReferencePostTierFor(259, 1)).toBe('medium');
    expect(xReferencePostTierFor(130, 1)).toBe('medium');
    expect(xReferencePostTierFor(129, 1)).toBe('short');
    expect(xReferencePostTierFor(65, 1)).toBe('short');
  });

  // Down rather than nearest: 200 is arithmetically closer to 260, but
  // rounding up would land it in the tier with the least headroom.
  it('rounds down even when the wider tier is arithmetically nearer', () => {
    expect(xReferencePostTierFor(200, 1)).toBe('medium');
  });

  it('floors anything below the smallest tier', () => {
    expect(xReferencePostTierFor(2, 1)).toBe('short');
  });

  // A thread's `long` IS 220, so the match is against the targets in force for
  // this request, not against the single-post numbers.
  it('matches against the threaded targets when a thread was asked for', () => {
    expect(xReferencePostTierFor(220, 3)).toBe('long');
    expect(xReferencePostTierFor(219, 3)).toBe('medium');
    // The same 220 is only `medium` for a single post, where `long` is 260.
    expect(xReferencePostTierFor(220, 1)).toBe('medium');
  });
});

describe('downgradedReferencePostTarget', () => {
  it('steps down one tier at a time and stops at the floor', () => {
    expect(downgradedReferencePostTarget('x', 260)).toBe(130);
    expect(downgradedReferencePostTarget('x', 220)).toBe(130);
    expect(downgradedReferencePostTarget('x', 130)).toBe(65);
    expect(downgradedReferencePostTarget('x', 65)).toBeNull();
    expect(downgradedReferencePostTarget('x', 50)).toBeNull();
  });

  // Snaps an arbitrary caller-supplied outputLength onto the same ladder,
  // rather than needing a tier it was never expressed as.
  it('takes the largest tier strictly below an explicit target', () => {
    expect(downgradedReferencePostTarget('x', 200)).toBe(130);
    expect(downgradedReferencePostTarget('x', 131)).toBe(130);
    expect(downgradedReferencePostTarget('twitter', 260)).toBe(130);
  });

  // X's alone: the other platforms' budgets run to the thousands and are
  // rarely reached at all, so a ladder for them would be unvalidated policy.
  it('has no ladder for other platforms', () => {
    expect(downgradedReferencePostTarget('reddit', 1000)).toBeNull();
    expect(downgradedReferencePostTarget('medium', 2550)).toBeNull();
    expect(downgradedReferencePostTarget('linkedin', 3000)).toBeNull();
  });
});
