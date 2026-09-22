import { weightedLength } from '@gitroom/helpers/utils/count.length';
import { SCANNABLE_PLATFORMS } from '@gitroom/nestjs-libraries/engage/engage-scan-config.service';
import { hardLimitFor } from '@gitroom/nestjs-libraries/integrations/platform-content-profile';
import {
  allowsLongForm,
  X_FREE_MAX_WEIGHTED,
} from '@gitroom/nestjs-libraries/integrations/x-account-ceiling';

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

/**
 * The tier ladders for an account that is ALLOWED long-form posts.
 *
 * X's ceiling is a property of the account's SUBSCRIPTION — 280 weighted
 * characters without one, 25000 with one (measured 2026-09-22) — so a
 * subscribed account can be written for at lengths the free ladders cannot
 * express at all. These are whole ladders rather than a widened `long`,
 * because moving only the top tier leaves a 30x hole between `medium` and
 * `long` that no picker setting can land in.
 *
 * WHY 4096 AND NOT 25000, which is what the account can actually publish:
 * `long` is bounded by what the request can PAY to produce, not by what X
 * accepts. resolveGenerationBudget derives `max_tokens` from the target and
 * states a ceiling back to the model at TOKENS_PER_CEILING_CHARACTER; with
 * MAX_TOKENS_PER_POST at 16384 that ceiling stops growing at 8192 characters.
 * Measured across the real curve:
 *
 *   target 3000  → stated ceiling 6000, 2.00x headroom
 *   target 4096  → stated ceiling 8192, 2.00x headroom   ← the last full-headroom target
 *   target 8192  → stated ceiling 8192, 1.00x headroom
 *   target 22500 → stated ceiling 8192, 0.36x — the prompt would name a ceiling
 *                  BELOW the target it just asked for, and the answer comes
 *                  back truncated mid-sentence
 *
 * Reaching 22500 needs ~49000 output tokens, past MAX_TOKENS_PER_REQUEST
 * (32000) — itself set by the tightest model's 32768 output cap. So 4096 is
 * not a matter of taste: it is the largest target that keeps the 2x headroom
 * every other number in this file is sized for.
 *
 * And the usual "leave 8-10% under the limit" reasoning does NOT transfer up
 * here. That gap exists because a model asked for 240 characters DRIFTS past
 * it (measured: 7/16 over 240, max 260). At four thousand it does not overrun,
 * it stops early — a buffer sized for overshoot would be guarding a failure
 * that does not happen at this scale.
 */
const X_LONG_FORM_REFERENCE_POST_TARGETS: Record<
  ReferencePostLengthTier,
  number
> = {
  // One full standard tweet — the ceiling a free account lives under, and the
  // length everyone already recognises as "a post".
  short: 280,
  medium: 1500,
  long: 4096,
};

/**
 * The same ladder for REPLIES, and deliberately a third of the size.
 *
 * A reply is a reply. Several thousand characters aimed at someone else's post
 * is a different social act from a long-form original, and nobody who picked
 * "long reply" is asking for an essay. `long` at 2000 also sits well inside
 * the 2x headroom band rather than at the edge of it.
 */
const X_LONG_FORM_REPLY_TARGETS: Record<ReplyLengthTier, number> = {
  short: 200,
  medium: 600,
  long: 2000,
};

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

/**
 * `maxWeighted` is the ACCOUNT's X ceiling, when the caller resolved one. It
 * moves the `long` tier and nothing else — the same rule, and the same
 * reasoning, as xReferencePostTarget: how long a reply SHOULD be is a content
 * decision, and being entitled to 25000 characters is not a reason to turn a
 * reply someone asked to be short into an essay.
 *
 * Defaults to X's free tier, so the unattended auto-reply driver — which never
 * resolves an account — keeps the exact targets it has always had.
 */
export function outputLengthForLength(
  platform: string,
  length: ReplyLengthTier,
  maxWeighted: number = X_FREE_MAX_WEIGHTED
): number {
  const normalized = normalizeEngagePlatform(platform);
  const target = LENGTH_TARGETS[length];
  if (normalized !== 'x') return target.reddit;
  if (allowsLongForm(maxWeighted)) {
    return Math.min(X_LONG_FORM_REPLY_TARGETS[length], maxWeighted);
  }
  return target.x;
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


/**
 * `maxWeighted` is the ACCOUNT's ceiling. It defaults to X's free-tier 280, so
 * every existing caller keeps the targets it has always had, and only a caller
 * that has actually resolved an account ceiling can widen them.
 */
export function xReferencePostTarget(
  tier: ReferencePostLengthTier,
  threadPosts: number,
  maxWeighted: number = X_FREE_MAX_WEIGHTED
): number {
  if (tier === 'long' && threadPosts > 1) {
    // A THREAD stays a thread on a long-form account. Every part is still an
    // individual post that readers scroll through, so the reason for the
    // shorter per-part target (see above) is unchanged by the entitlement —
    // and someone who wanted one long post would not have asked for a thread.
    return X_REFERENCE_POST_THREAD_LONG_TARGET;
  }
  if (allowsLongForm(maxWeighted)) {
    // Never above what the account can actually publish. No current tier binds
    // here, but a future grant smaller than the ladder must not be handed a
    // target its own posts would fail.
    return Math.min(X_LONG_FORM_REFERENCE_POST_TARGETS[tier], maxWeighted);
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
  threadPosts: number,
  maxWeighted: number = X_FREE_MAX_WEIGHTED
): ReferencePostLengthTier {
  for (let i = TIER_ORDER.length - 1; i >= 0; i--) {
    const tier = TIER_ORDER[i];
    if (
      requestedCharacters >= xReferencePostTarget(tier, threadPosts, maxWeighted)
    ) {
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
  currentTarget: number,
  maxWeighted: number = X_FREE_MAX_WEIGHTED
): number | null {
  if (normalizeEngagePlatform(platform) !== 'x') return null;
  // Step down this ACCOUNT's own ladder. Handing a long-form generation the
  // free tier's 130 would not be a downgrade, it would be a collapse — the
  // retry is meant to land one rung lower, not to abandon the length the
  // caller asked for.
  const ladder = allowsLongForm(maxWeighted)
    ? X_LONG_FORM_REFERENCE_POST_TARGETS
    : X_REFERENCE_POST_TARGETS;
  const steps = [ladder.medium, ladder.short];
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
export function platformHardCeilingFor(
  platform: string,
  maxWeighted: number = X_FREE_MAX_WEIGHTED
): number | null {
  const normalized = normalizeEngagePlatform(platform);
  // X's ceiling belongs to the ACCOUNT, not to X: 280 weighted without a
  // subscription, 25000 with one. `maxWeighted` defaults to the free tier, so
  // a caller that has not resolved an account is held to the limit every X
  // account has — which is the safe direction, since a draft refused here
  // costs a retry while one wrongly allowed through fills X's composer and can
  // never send.
  if (normalized === 'x') return Math.max(X_HARD_CHAR_LIMIT, maxWeighted);
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
  draft: string,
  maxWeighted: number = X_FREE_MAX_WEIGHTED
) {
  const normalized = normalizeEngagePlatform(platform);
  // Anything outside the scannable set has no engage generation path and no
  // agreed ceiling — staying silent there preserves the previous behaviour
  // for callers passing a platform this module was never taught about,
  // rather than inventing a limit for it.
  const hardLimit = platformHardCeilingFor(normalized, maxWeighted);
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
