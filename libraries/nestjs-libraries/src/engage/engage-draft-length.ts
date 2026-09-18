import { weightedLength } from '@gitroom/helpers/utils/count.length';
import { SCANNABLE_PLATFORMS } from '@gitroom/nestjs-libraries/engage/engage-scan-config.service';
import {
  hardLimitFor,
} from '@gitroom/nestjs-libraries/integrations/platform-content-profile';

// Draft length policy for engage replies — ONE definition, shared by the
// user-driven SSE endpoint and the unattended auto-reply driver. Duplicating it
// would let the two paths drift into generating differently-sized replies for
// the same plan.
//
// (X: 260 target / 280 ceiling = X's exact max — weightedLength uses official
// twitter-text weighting, so no safety margin needed; Reddit: 1000 / 2000).
// Keep these in sync with engage-draft.service.ts.
export const X_WEIGHTED_CHAR_LIMIT = 260;
export const X_HARD_CHAR_LIMIT = 280;
export const REDDIT_TARGET_CHAR_LIMIT = 1000;
export const REDDIT_HARD_CHAR_LIMIT = 2000;

export type ReplyLengthTier = 'short' | 'medium' | 'long';

export function normalizeEngagePlatform(platform: string): string {
  const normalized = platform.toLowerCase();
  return normalized === 'twitter' ? 'x' : normalized;
}

// Length tier → generation target. Used only when the caller doesn't pass an
// explicit outputLength; it only supplies an advisory prompt target.
const LENGTH_TARGETS: Record<ReplyLengthTier, { x: number; reddit: number }> = {
  short: { x: 120, reddit: 400 },
  medium: { x: 200, reddit: REDDIT_TARGET_CHAR_LIMIT },
  long: { x: 255, reddit: 1800 },
};

export function outputLengthForLength(
  platform: string,
  length: ReplyLengthTier
): number {
  const normalized = normalizeEngagePlatform(platform);
  const target = LENGTH_TARGETS[length];
  return normalized === 'x' ? target.x : target.reddit;
}

/** The length vocabulary a reference-post generation for X is written against. */
export type ReferencePostLengthTier = 'short' | 'medium' | 'long';

/**
 * X generation targets for REFERENCE POSTS, which is a different problem from
 * a reply: the reference can be a Medium essay or a Quora answer, so the model
 * is compressing 20x rather than answering in kind, and a numeric budget is
 * the one instruction an LLM cannot verify about its own output.
 *
 * So the tiers are spaced to leave DRIFT HEADROOM under X's 280 ceiling rather
 * than to use as much of it as possible — 65/130 sit at 4.3x/2.15x, wide
 * enough that a model that misjudges its own length still publishes. `long` is
 * the only tier that trades headroom for a fuller post, and it is also the
 * only one that has ever overrun in practice, which is what the downgrade
 * ladder below exists for.
 *
 * These are the numbers a client's Short/Medium/Long picker already resolves
 * to before calling, which is why `xReferencePostTierFor` can read an incoming
 * `outputLength` back as the tier it was — but the values are OWNED here, and
 * a number that matches none of them still lands on a tier.
 */
const X_REFERENCE_POST_TARGETS: Record<ReferencePostLengthTier, number> = {
  short: 65,
  medium: 130,
  long: X_WEIGHTED_CHAR_LIMIT,
};

/**
 * `long` for a THREAD part, rather than the 260 a single post gets.
 *
 * Every part independently faces the 280 ceiling, so a 4-post thread is four
 * independent chances to overshoot rather than one — and it is asked for
 * through a longer prompt (part separator, exact post count, per-part ceiling)
 * that leaves the model less attention for any one of them. Buying headroom
 * back costs 40 characters a part, which on X is not a visible difference.
 */
const X_REFERENCE_POST_THREAD_LONG_TARGET = 220;

export function xReferencePostTarget(
  tier: ReferencePostLengthTier,
  threadPosts: number
): number {
  if (tier === 'long' && threadPosts > 1) {
    return X_REFERENCE_POST_THREAD_LONG_TARGET;
  }
  return X_REFERENCE_POST_TARGETS[tier];
}

// Widest last, so a scan from the end finds the largest tier that fits.
const TIER_ORDER: readonly ReferencePostLengthTier[] = [
  'short',
  'medium',
  'long',
] as const;

/**
 * Which tier a requested character count means.
 *
 * `outputLength` is advisory — a client's Short/Medium/Long picker resolved to
 * a number — so it selects a TIER rather than becoming the target verbatim.
 * That is what keeps the tier adjustments reachable: a request for 260 with a
 * thread lands on `long`, which is 220 per part, where an honoured 260 would
 * have skipped the adjustment entirely.
 *
 * Snaps DOWN — the largest tier at or below the request, floored at `short`.
 * Down rather than nearest because the direction that matters is the one away
 * from the ceiling: 270 means `long` (260), and 200 means `medium` rather than
 * being rounded up into the tier with the least headroom.
 *
 * Resolved against the targets in force for THIS request, so a thread's
 * 220 is what 220 matches, not `medium`.
 */
export function xReferencePostTierFor(
  requestedCharacters: number,
  threadPosts: number
): ReferencePostLengthTier {
  for (let i = TIER_ORDER.length - 1; i >= 0; i--) {
    const tier = TIER_ORDER[i];
    if (requestedCharacters >= xReferencePostTarget(tier, threadPosts)) {
      return tier;
    }
  }
  return 'short';
}

/**
 * The next tier down from whatever target is in force, or `null` at the floor.
 *
 * Answers the retry question "how much shorter" with a NUMBER the prompt can
 * be rebuilt around, instead of the words "make it shorter" — a model that
 * just overran a budget it could not measure has no way to act on the words.
 *
 * Takes the current target rather than a tier so an explicit caller-supplied
 * `outputLength` steps down the same ladder: it snaps to the largest tier
 * strictly below whatever was asked for.
 *
 * Needs no `threadPosts`, unlike its siblings: `long` is the only tier whose
 * value depends on it, and `long` can never be a downgrade DESTINATION.
 *
 * X only. The other platforms' overruns are a different shape — they have
 * budgets in the thousands that the model rarely reaches at all — and
 * inventing a ladder for them here would be a second, unvalidated policy next
 * to the one this was actually measured for.
 */
export function downgradedReferencePostTarget(
  platform: string,
  currentTarget: number
): number | null {
  if (normalizeEngagePlatform(platform) !== 'x') return null;
  const steps = [X_REFERENCE_POST_TARGETS.medium, X_REFERENCE_POST_TARGETS.short];
  return steps.find((step) => step < currentTarget) ?? null;
}

/**
 * The hard character ceiling this module ENFORCES for a platform, or `null`
 * where it enforces none.
 *
 * Split out of `assertDraftWithinPlatformLimit` so that generation can be
 * sized against the very number publication is judged by. A generator that
 * picks its own ceiling — as reference-post generation did, stating the
 * provider's raw `maxLength()` in its prompt while budgeting `max_tokens` off
 * a much smaller advisory target — permits the model an output length it
 * cannot afford to produce, and the response comes back cut off mid-sentence.
 * One number, read by both sides, is what stops that.
 *
 * The counting RULE stays with the caller: x is measured with twitter-text
 * weighting (CJK/emoji 2, URLs 23) and everything else by raw `.length`, so
 * this returns the limit only, never a verdict.
 */
export function platformHardCeilingFor(platform: string): number | null {
  const normalized = normalizeEngagePlatform(platform);
  if (normalized === 'x') return X_HARD_CHAR_LIMIT;
  if (normalized === 'reddit') return REDDIT_HARD_CHAR_LIMIT;
  // Anything outside the scannable set has no engage generation path and no
  // agreed ceiling — see assertDraftWithinPlatformLimit's note.
  if (!(SCANNABLE_PLATFORMS as readonly string[]).includes(normalized)) {
    return null;
  }
  return hardLimitFor(normalized);
}

/**
 * Throws when a generated draft exceeds the PLATFORM's hard ceiling. The
 * requested `outputLength` only steers the prompt — it is a soft target, so a
 * draft that overshoots it is kept as long as the platform would still accept
 * it (see the engage draft-length note in the module docs).
 *
 * Covers EVERY platform engage can generate for, not just x/reddit. It used to
 * check those two and silently pass anything else, which was harmless only
 * while every generation targeted the opportunity's own platform and engage
 * effectively replied on x/reddit alone. Reference-post generation can now be
 * pointed at any of the seven, so a linkedin post at 4000 characters — over
 * LinkedIn's real 3000 ceiling — would otherwise sail through this gate and
 * fail at publish time instead.
 *
 * x and reddit keep their OWN engage numbers rather than the provider's: x's
 * 280 is the provider ceiling anyway, and engage's reddit ceiling (2000) is
 * deliberately stricter than the provider's 10000 — an engage post is a short
 * post, and loosening it here would be a behaviour change nobody asked for.
 * The other five take the provider's `maxLength()` through the shared
 * `hardLimitFor`, so they track the publisher's real limit automatically.
 */
export function assertDraftWithinPlatformLimit(
  platform: string,
  draft: string
) {
  const normalized = normalizeEngagePlatform(platform);
  // Anything outside the scannable set has no engage generation path and no
  // agreed ceiling — staying silent there preserves the previous behaviour
  // for callers passing a platform this module was never taught about,
  // rather than inventing a limit for it.
  const hardLimit = platformHardCeilingFor(normalized);
  if (hardLimit === null) return;
  // The MEASURED length rides along in every message. A model told only that
  // it went over has no idea whether it missed by 5 characters or 400, and
  // that is the difference between trimming a clause and rewriting the post —
  // the reference-post retry quotes this message straight back to it. It is
  // equally the number that was missing from the logs when asking how badly
  // a platform actually overruns in production.
  if (normalized === 'x') {
    const measured = weightedLength(draft);
    if (measured > hardLimit) {
      throw new Error(
        `Generated X draft exceeded ${hardLimit} Twitter-weighted characters (measured ${measured}).`
      );
    }
    return;
  }
  if (normalized === 'reddit') {
    if (draft.length > hardLimit) {
      throw new Error(
        `Generated Reddit draft exceeded ${hardLimit} characters (measured ${draft.length}).`
      );
    }
    return;
  }
  if (draft.length > hardLimit) {
    throw new Error(
      `Generated ${normalized} draft exceeded ${hardLimit} characters (measured ${draft.length}).`
    );
  }
}
