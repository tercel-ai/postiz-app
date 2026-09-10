import { socialIntegrationList } from '@gitroom/nestjs-libraries/integrations/integration.manager';

/**
 * ONE definition of "how long may a generated post be on platform X, and how
 * does that platform want to be written for" — shared by every feature that
 * generates content FOR a platform rather than reading content FROM one.
 *
 * Lives here, beside thread-capability.ts, for exactly the same reason that
 * module does: this is per-platform CAPABILITY derived from the providers, and
 * the moment two features keep private copies of it they drift. Both of the
 * current callers already proved that:
 *
 *  - OperationPlanService (cross-platform campaign generation) owned all of
 *    this privately: the limits, the "ADAPT, don't copy" instruction, and the
 *    per-platform native-format mapping.
 *  - Engage's reference-post generation (a→any) needs the identical rules the
 *    moment it can target a platform other than the reference's own, and a
 *    second copy of "linkedin = professional, longer" is a second copy that can
 *    disagree with the first.
 *
 * Everything here is keyed by PROVIDER IDENTIFIER (`x`, `reddit`, `linkedin`,
 * `devto`, `hackernews`, `medium`, `quora`, …). Callers holding a platform in
 * another vocabulary normalize first — e.g. engage's `normalizeEngagePlatform`
 * maps its legacy `twitter` onto `x`.
 */

export const DEFAULT_CONTENT_LIMIT = 3000;

/**
 * Hard per-platform content ceiling for generated posts — content over this can
 * never publish. The SINGLE SOURCE OF TRUTH is each provider's own `maxLength()`
 * (the exact ceiling the publisher enforces), so this never drifts as providers
 * are added/changed and it automatically covers every provider AND its variants
 * (linkedin-page, mastodon-custom, instagram-standalone inherit their base's
 * maxLength). Unknown/unregistered platform → DEFAULT_CONTENT_LIMIT. X's
 * maxLength takes an isTwitterPremium flag; we omit it → the conservative
 * non-premium 280, measured with twitter-text WEIGHTED counting (every URL
 * counts as 23 regardless of real length; CJK/emoji count 2), matching
 * EngageDraftService's ceiling.
 */
export const hardLimitFor = (platform: string): number =>
  socialIntegrationList.find((p) => p.identifier === platform)?.maxLength() ??
  DEFAULT_CONTENT_LIMIT;

/**
 * What we INSTRUCT the model to stay within — deliberately BELOW the hard
 * ceiling, and the gap is the whole point.
 *
 * The model treats a stated budget as a soft aim and DRIFTS past it: with 240
 * declared (twice — prompt head and tail), measured runs came back at 0/13 over
 * 240 (max 239) and 7/16 over 240 (max 260). The 40-char gap to X's real 280 is
 * sized to absorb that drift, and it did: 0/29 posts exceeded 280.
 *
 * So do NOT "tidy" this by making the target the hard limit (a 260-char post is
 * perfectly publishable — rejecting it would throw away an entire paid
 * generation over nothing), and do NOT close the gap by raising the target to
 * 280 (drift would then land above X's real ceiling and the post WOULD fail).
 * Same soft-target/hard-ceiling split as EngageDraftService (260/280).
 *
 * Only X needs a hand-tuned soft target. For every other platform the soft
 * budget is its hard limit, but CAPPED at MAX_CONTENT_TARGET so a platform with
 * a huge ceiling (facebook 63206, blog providers 100000, listmonk 100000000)
 * does not invite a novel — a generated post stays concise. The cap equals the
 * largest real target under the previous hardcoded table (linkedin 3000).
 */
export const MAX_CONTENT_TARGET = 3000;
export const PLATFORM_CONTENT_TARGETS: Record<string, number> = {
  x: 240,
};
export const targetFor = (platform: string): number =>
  Math.min(
    PLATFORM_CONTENT_TARGETS[platform] ?? hardLimitFor(platform),
    MAX_CONTENT_TARGET
  );

/**
 * The per-platform character budget lines a prompt states as a hard gate.
 *
 * `statedMargin` additionally tells the model that X's budget sits under X's
 * real ceiling — worth saying when the prompt writes the FULL plan (the model
 * is more willing to trim when it knows the budget is not the cliff edge), and
 * deliberately omitted where the prompt is a narrow top-up.
 */
export function buildCharacterLimitLines(
  platforms: readonly string[],
  options: { statedMargin?: boolean } = {}
): string[] {
  return platforms.map(
    (p) =>
      `    • ${p}: max ${targetFor(p)} characters` +
      (p === 'x'
        ? ` (X WEIGHTED counting: every URL counts as 23 characters regardless of its real length; CJK characters and emoji count as 2 each.${
            options.statedMargin
              ? ` X's own ceiling is ${hardLimitFor('x')} — ${targetFor(
                  'x'
                )} is your budget, so you have margin.`
              : ''
          })`
        : '')
  );
}

/**
 * The instruction that makes a cross-platform rewrite a REWRITE rather than a
 * copy-paste. Stated wherever one platform's content seeds another's.
 */
export const CROSS_PLATFORM_ADAPT_INSTRUCTION =
  "ADAPT, don't copy: the same message expressed for a different audience and format. For example, an X thread about a data insight becomes a single LinkedIn post with professional framing, or a longer dev.to article with code examples. Keep the theme and the core point; rewrite the delivery.";

interface PlatformNativeFormat {
  /** How the platform is named in prose to the model. */
  label: string;
  /** Its native format, in the compact form the cross-platform line uses. */
  style: string;
  /**
   * Format rules that are FATAL to get wrong on this platform, if any — a
   * post that breaks one publishes badly rather than not at all, so they are
   * stated per-platform instead of as a wall of every platform's rules.
   */
  rules?: string[];
}

/**
 * A post on `reddit`, `hackernews`, `medium` and `devto` is submitted as a
 * TITLE plus a BODY, through two separate fields. A generator that opens the
 * body with the title makes the platform display it twice.
 */
export const TITLE_SEPARATED_PLATFORMS: readonly string[] = [
  'reddit',
  'hackernews',
  'medium',
  'devto',
];

/** Whether `platform` submits its title through a field of its own. */
export const isTitleSeparatedPlatform = (platform: string): boolean =>
  TITLE_SEPARATED_PLATFORMS.includes(platform);

/**
 * The title LENGTH a prompt asks for on each title-separated platform.
 *
 * Reddit (300), Hacker News (80) and dev.to (128) are those platforms' own
 * hard title ceilings — a submission over them is rejected by the platform,
 * not merely ugly. Medium enforces no ceiling worth stating, so it gets an
 * editorial length instead: a headline much past ~100 characters is truncated
 * in its feed anyway.
 *
 * A prompt-side budget only. Nothing clamps a returned title to it, because a
 * clamp is a mid-word truncation — the very defect that generating the title
 * explicitly (instead of slicing the body's first 280 characters) exists to
 * remove. A model that overruns publishes a long title; a model that is
 * truncated publishes a broken one.
 */
export const TITLE_LENGTH_TARGETS: Record<string, number> = {
  reddit: 300,
  hackernews: 80,
  medium: 100,
  devto: 128,
};
export const DEFAULT_TITLE_LENGTH_TARGET = 120;
export const titleLengthTargetFor = (platform: string): number =>
  TITLE_LENGTH_TARGETS[platform] ?? DEFAULT_TITLE_LENGTH_TARGET;

const TITLE_VS_BODY_RULE =
  'The title is submitted SEPARATELY from the body, so write the BODY ONLY — never open with the title, or with a heading or bold restatement of it, or the platform displays it twice.';

const X_PLAIN_TEXT_RULE =
  'Write PLAIN TEXT: no Markdown. `**bold**`, headings and backticks are NOT rendered — they appear literally as asterisks. Plain prose, line breaks and simple bullets ("•") only.';

const HASHTAG_RULE =
  'Hashtags: a hashtag ENDS at the first space, so a multi-word tag silently breaks — "#MCP protocol" renders as the tag "#MCP" followed by the loose word "protocol". Never hashtag a multi-word keyword: either write it as plain prose (preferred) or close it up into one word ("#MCPprotocol"). Use at most 1-2 hashtags, and only single-word ones.';

const PLATFORM_NATIVE_FORMATS: Record<string, PlatformNativeFormat> = {
  x: {
    label: 'X',
    style: 'short, punchy, conversational',
    rules: [X_PLAIN_TEXT_RULE, HASHTAG_RULE],
  },
  reddit: {
    label: 'Reddit',
    style: 'community-native discussion, no self-promotion',
    rules: [TITLE_VS_BODY_RULE],
  },
  linkedin: {
    label: 'LinkedIn',
    style: 'professional, longer',
    rules: [HASHTAG_RULE],
  },
  devto: {
    label: 'dev.to',
    style: 'technical, tutorial-style',
    rules: [TITLE_VS_BODY_RULE],
  },
  medium: {
    label: 'Medium',
    style: 'narrative, explanatory',
    rules: [TITLE_VS_BODY_RULE],
  },
  quora: {
    label: 'Quora',
    style: 'direct answer format',
  },
  hackernews: {
    label: 'HackerNews',
    style: 'concise, factual, no fluff',
    rules: [TITLE_VS_BODY_RULE],
  },
};

/**
 * The platforms the cross-platform native-format line has always enumerated —
 * the five long-form/professional surfaces whose format differs most from the
 * short-form default a generator falls into. X and Reddit are omitted on
 * purpose: their rules are stated at length elsewhere in the same prompts.
 */
export const CROSS_PLATFORM_NATIVE_FORMAT_PLATFORMS: readonly string[] = [
  'linkedin',
  'devto',
  'medium',
  'quora',
  'hackernews',
];

/**
 * One sentence mapping SEVERAL platforms to their native format. For a prompt
 * that generates for many platforms at once (the operation plan).
 */
export function buildPlatformNativeFormatLine(
  platforms: readonly string[] = CROSS_PLATFORM_NATIVE_FORMAT_PLATFORMS
): string {
  const pairs = platforms
    .map((p) => PLATFORM_NATIVE_FORMATS[p])
    .filter((entry): entry is PlatformNativeFormat => !!entry)
    .map((entry) => `${entry.label} = ${entry.style}`);
  return `Adapt content to each platform's native format: ${pairs.join('; ')}.`;
}

/**
 * The style + format guidance for ONE platform — for a prompt that generates
 * for a single known target (engage's reference-post generation). Deliberately
 * NOT the seven-platform line above: naming six platforms the model is not
 * writing for is six chances to blend their conventions into the one it is.
 *
 * Returns an empty string for a platform with no profile, so a caller can drop
 * the block entirely rather than emit a dangling header.
 */
export function buildPlatformStyleGuidance(platform: string): string {
  const entry = PLATFORM_NATIVE_FORMATS[platform];
  if (!entry) return '';
  return [
    `${entry.label}'s native format: ${entry.style}.`,
    ...(entry.rules ?? []),
  ].join(' ');
}
