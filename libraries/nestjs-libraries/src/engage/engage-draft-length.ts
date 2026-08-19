import { weightedLength } from '@gitroom/helpers/utils/count.length';

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
// explicit outputLength; the model clamps to the platform ceiling regardless.
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

/**
 * Throws when a generated draft exceeds the PLATFORM's hard ceiling. The
 * requested `outputLength` only steers the prompt — it is a soft target, so a
 * draft that overshoots it is kept as long as the platform would still accept
 * it (see the engage draft-length note in the module docs).
 */
export function assertDraftWithinPlatformLimit(
  platform: string,
  draft: string,
  outputLength?: number
) {
  const normalized = normalizeEngagePlatform(platform);
  if (normalized === 'x') {
    // Mirror the draft service: reject only above the hard ceiling, with the
    // requested target as the soft floor of that ceiling.
    const hardLimit = Math.max(outputLength ?? X_WEIGHTED_CHAR_LIMIT, X_HARD_CHAR_LIMIT);
    if (weightedLength(draft) > hardLimit) {
      throw new Error(
        `Generated X draft exceeded ${hardLimit} Twitter-weighted characters.`
      );
    }
  }
  if (normalized === 'reddit') {
    const hardLimit = Math.max(
      outputLength ?? REDDIT_TARGET_CHAR_LIMIT,
      REDDIT_HARD_CHAR_LIMIT
    );
    if (draft.length > hardLimit) {
      throw new Error(`Generated Reddit draft exceeded ${hardLimit} characters.`);
    }
  }
}
