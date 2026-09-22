import { describe, it, expect } from 'vitest';
import {
  assertDraftWithinPlatformLimit,
  outputLengthForLength,
  downgradedReferencePostTarget,
  normalizeEngagePlatform,
  xReferencePostTarget,
  xReferencePostTierFor,
  REDDIT_HARD_CHAR_LIMIT,
  X_HARD_CHAR_LIMIT,
  X_WEIGHTED_CHAR_LIMIT,
  platformHardCeilingFor,
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

// X's ceiling belongs to the ACCOUNT's subscription, not to X: 280 weighted
// characters without one, 25000 with one (measured on x.com, 2026-09-22, by
// filling the composer and reading its countdown ring and Post button). These
// tests pin the two things that must stay true of that: a caller who has not
// resolved an account keeps exactly the behaviour it had, and a caller who has
// gets a target and a ceiling that agree with each other.
describe('a per-account X ceiling', () => {
  it('leaves every existing caller on the free tier', () => {
    // The default is the whole safety story: an unresolved account is held to
    // the limit every X account has.
    expect(xReferencePostTarget('long', 1)).toBe(X_WEIGHTED_CHAR_LIMIT);
    expect(platformHardCeilingFor('x')).toBe(X_HARD_CHAR_LIMIT);
    expect(() =>
      assertDraftWithinPlatformLimit('x', 'a'.repeat(281))
    ).toThrow(/280/);
  });

  it('gives a long-form account its own ladder, not a widened top tier', () => {
    // Moving only `long` would leave a 30x hole between `medium` (130) and
    // `long` that no picker setting can land in.
    expect(xReferencePostTarget('short', 1, 25000)).toBe(280);
    expect(xReferencePostTarget('medium', 1, 25000)).toBe(1500);
    expect(xReferencePostTarget('long', 1, 25000)).toBe(4096);
  });

  it('keeps `long` at the last target that still has 2x prompt headroom', () => {
    // resolveGenerationBudget states a ceiling back to the model derived from
    // max_tokens, and that ceiling stops growing at 8192 characters. Measured:
    // target 4096 -> ceiling 8192 (2.00x); target 8192 -> 8192 (1.00x);
    // target 22500 -> 8192 (0.36x), i.e. a ceiling BELOW the target, which
    // comes back truncated. 4096 is the last one with full headroom.
    expect(xReferencePostTarget('long', 1, 25000)).toBeLessThanOrEqual(4096);
  });

  it('gives REPLIES a ladder about a third the size', () => {
    // A reply is a reply. Several thousand characters aimed at someone else's
    // post is a different social act from a long-form original.
    expect(outputLengthForLength('x', 'short', 25000)).toBe(200);
    expect(outputLengthForLength('x', 'medium', 25000)).toBe(600);
    expect(outputLengthForLength('x', 'long', 25000)).toBe(2000);
    // Every rung strictly below the original-post rung of the same name.
    for (const tier of ['short', 'medium', 'long'] as const) {
      expect(outputLengthForLength('x', tier, 25000)).toBeLessThan(
        xReferencePostTarget(tier, 1, 25000)
      );
    }
  });

  it('leaves every free-tier caller exactly where it was', () => {
    expect(xReferencePostTarget('short', 1)).toBe(65);
    expect(xReferencePostTarget('medium', 1)).toBe(130);
    expect(xReferencePostTarget('long', 1)).toBe(X_WEIGHTED_CHAR_LIMIT);
    expect(outputLengthForLength('x', 'short')).toBe(120);
    expect(outputLengthForLength('x', 'medium')).toBe(200);
    expect(outputLengthForLength('x', 'long')).toBe(255);
  });

  it('leaves the unattended auto-reply driver on the free tier', () => {
    // engage-auto-reply.service.ts calls this WITHOUT a ceiling, and the
    // operation-plan track is deliberately outside this feature: it generates
    // ahead of time and the browser may have switched X accounts by then.
    expect(outputLengthForLength('x', 'long')).toBe(255);
    expect(outputLengthForLength('twitter', 'long')).toBe(255);
  });

  it('does not widen reply targets on other platforms', () => {
    expect(outputLengthForLength('reddit', 'long', 25000)).toBe(
      outputLengthForLength('reddit', 'long')
    );
  });

  it('keeps a thread a thread on a long-form account', () => {
    // Every part is still an individual post readers scroll through, and
    // someone who wanted one long post would not have asked for a thread.
    expect(xReferencePostTarget('long', 4, 25000)).toBe(
      xReferencePostTarget('long', 4)
    );
  });

  it('snaps a requested length onto the ladder in force for the account', () => {
    // Without the ceiling, 1500 would read as `long` (>= 260) on an account
    // whose `long` is really 4096.
    expect(xReferencePostTierFor(1500, 1, 25000)).toBe('medium');
    expect(xReferencePostTierFor(4096, 1, 25000)).toBe('long');
    expect(xReferencePostTierFor(1500, 1)).toBe('long');
  });

  it('steps DOWN the account"s own ladder on a retry', () => {
    // Handing a long-form generation the free tier's 130 would not be a
    // downgrade, it would be a collapse.
    expect(downgradedReferencePostTarget('x', 4096, 25000)).toBe(1500);
    expect(downgradedReferencePostTarget('x', 1500, 25000)).toBe(280);
    expect(downgradedReferencePostTarget('x', 280, 25000)).toBeNull();
    // Unchanged for a free account.
    expect(downgradedReferencePostTarget('x', 260)).toBe(130);
  });

  it('raises the hard ceiling to the account ceiling', () => {
    expect(platformHardCeilingFor('x', 25000)).toBe(25000);
    // 12500 Han = 25000 weighted = MEASURED as the last draft X's Post button
    // still enabled for.
    expect(() =>
      assertDraftWithinPlatformLimit('x', '中'.repeat(12500), 25000)
    ).not.toThrow();
    expect(() =>
      assertDraftWithinPlatformLimit('x', '中'.repeat(12501), 25000)
    ).toThrow(/25000/);
  });

  it('never lets an account ceiling LOWER what X already allows', () => {
    // A garbled or under-reported reading must not start refusing ordinary
    // 280-character posts that have always been publishable.
    expect(platformHardCeilingFor('x', 0)).toBe(X_HARD_CHAR_LIMIT);
    expect(platformHardCeilingFor('x', 100)).toBe(X_HARD_CHAR_LIMIT);
  });

  it('does not touch any other platform', () => {
    expect(platformHardCeilingFor('reddit', 25000)).toBe(REDDIT_HARD_CHAR_LIMIT);
    expect(() =>
      assertDraftWithinPlatformLimit('reddit', 'a'.repeat(2001), 25000)
    ).toThrow(/2000/);
  });
});
