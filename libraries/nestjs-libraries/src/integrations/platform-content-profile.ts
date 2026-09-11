import { socialIntegrationList } from '@gitroom/nestjs-libraries/integrations/integration.manager';
import { TITLE_REQUIRED_PLATFORMS } from '@gitroom/helpers/extension/post-publish';

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
 * Is this platform's native unit an ARTICLE or a POST?
 *
 * The budgets above are ceilings, and a ceiling alone says nothing about the
 * bottom: told only "max 3000 characters", a model writes 200 and is within
 * budget. On X that is a tweet; on dev.to or Medium it is a stub where a
 * reader expected an article, and it publishes under a title promising one.
 *
 * Only platforms whose native unit really is long-form are marked 'long'.
 * Marking a short-form platform 'long' would be worse than the defect it
 * fixes: it forces padding on a surface where a two-line post is correct.
 */
export type PlatformForm = 'short' | 'long';

/**
 * How much of a long-form platform's budget a post must actually use.
 *
 * A RATIO of the target, not an absolute floor, because the target is not
 * fixed: engage's reference-post generation applies a safety margin, and a
 * caller may pass its own `outputLength`. An absolute floor would eventually
 * sit ABOVE a caller's ceiling and ask for a post between 1500 and 340
 * characters, which is not a constraint but a contradiction.
 */
export const LONG_FORM_MIN_RATIO = 0.5;

/**
 * The floor for a platform, in characters — `0` where the platform has none,
 * which is every short-form surface and anything unprofiled.
 *
 * `target` defaults to the platform's own soft budget; pass the effective one
 * when the caller has narrowed it (a safety margin, an explicit
 * `outputLength`) so the floor stays under the ceiling it is paired with.
 */
export const minTargetFor = (
  platform: string,
  target: number = targetFor(platform)
): number =>
  PLATFORM_NATIVE_FORMATS[platform]?.form === 'long'
    ? Math.round(target * LONG_FORM_MIN_RATIO)
    : 0;

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
  return platforms.map((p) => {
    const target = targetFor(p);
    const floor = minTargetFor(p);
    // A long-form platform gets a RANGE, not a ceiling: "max 3000" alone is
    // satisfied by 200 characters, which publishes as a stub under a title
    // promising an article.
    const budget = floor
      ? `    • ${p}: ${floor}-${target} characters — this is an ARTICLE, not a short post. Under ${floor} reads as a stub; aim for the upper half of the range.`
      : `    • ${p}: max ${target} characters`;
    return (
      budget +
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
  });
}

/**
 * The instruction that makes a cross-platform rewrite a REWRITE rather than a
 * copy-paste. Stated wherever one platform's content seeds another's.
 */
export const CROSS_PLATFORM_ADAPT_INSTRUCTION =
  "ADAPT, don't copy: the same message expressed for a different audience and format. For example, an X thread about a data insight becomes a single LinkedIn post with professional framing, or a longer dev.to article with code examples. Keep the theme and the core point; rewrite the delivery.";

/**
 * Does a body submitted to this platform RENDER markup, or publish it as the
 * literal characters typed?
 *
 * A per-platform property, not a house-style opinion: "**bold**" is a word in
 * bold on dev.to and three asterisks on X. A generator told the wrong one
 * either publishes visible punctuation or writes a wall of prose where the
 * platform expected a structured article.
 *
 * NOT derived from the provider's `editor` field, which is the closest-looking
 * candidate and is wrong: `editor` picks which COMPOSER the Postiz UI shows
 * (`reddit.provider.ts` sets 'normal'), while a Reddit self-post body is
 * markdown at the API. `editor` answers "what does the human type into", this
 * answers "what does the platform do with what was typed".
 */
export type PlatformMarkup = 'none' | 'markdown';

interface PlatformNativeFormat {
  /** How the platform is named in prose to the model. */
  label: string;
  /** Its native format, in the compact form the cross-platform line uses. */
  style: string;
  /**
   * Whether markup renders here. Required, so a platform added to this table
   * cannot silently inherit someone else's answer — the compiler asks.
   */
  markup: PlatformMarkup;
  /**
   * Article platform or post platform. Required for the same reason as
   * `markup`: the answer decides whether generated content gets a length
   * FLOOR, and a platform that never declares one silently gets no floor.
   */
  form: PlatformForm;
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
 *
 * Aliased from the publish side's `TITLE_REQUIRED_PLATFORMS` rather than
 * restated: "needs a title field" and "submits its title separately" are the
 * same property read from the two ends of one pipeline, and the publish list
 * already governs whether operation-plan strips a duplicated title and writes
 * `settings.title` (operation-plan.repository.ts) and whether the extension's
 * publish queue demands one. A second list here would be exactly the private
 * copy this module's header says drifts — and it would drift silently, since
 * nothing links the two: a fifth title-separated platform added to one alone
 * would make the generator's TITLE protocol and the publisher's title handling
 * disagree, with no compiler error and no test spanning both.
 */
export const TITLE_SEPARATED_PLATFORMS: readonly string[] =
  TITLE_REQUIRED_PLATFORMS;

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

const HASHTAG_RULE =
  'Hashtags: a hashtag ENDS at the first space, so a multi-word tag silently breaks — "#MCP protocol" renders as the tag "#MCP" followed by the loose word "protocol". Never hashtag a multi-word keyword: either write it as plain prose (preferred) or close it up into one word ("#MCPprotocol"). Use at most 1-2 hashtags, and only single-word ones.';

const PLATFORM_NATIVE_FORMATS: Record<string, PlatformNativeFormat> = {
  x: {
    label: 'X',
    style: 'short, punchy, conversational',
    markup: 'none',
    form: 'short',
    rules: [HASHTAG_RULE],
  },
  reddit: {
    label: 'Reddit',
    style: 'community-native discussion, no self-promotion',
    // A self-post can run long, but the community-native shape is a question
    // or a short discussion — a floor here would force padding.
    form: 'short',
    // A self-post body is markdown at Reddit's API, whatever the Postiz
    // composer shows (see PlatformMarkup).
    markup: 'markdown',
    rules: [TITLE_VS_BODY_RULE],
  },
  linkedin: {
    label: 'LinkedIn',
    style: 'professional, longer',
    markup: 'none',
    // 'longer' than a tweet, still a post: short LinkedIn posts are normal and
    // perform, so no floor.
    form: 'short',
    rules: [HASHTAG_RULE],
  },
  devto: {
    label: 'dev.to',
    style: 'technical, tutorial-style',
    // An ARTICLE, submitted under its own title. This is the surface the
    // floor exists for.
    form: 'long',
    // The article body IS markdown (Forem's `body_markdown`), which is what
    // makes a tutorial with headings and fenced code the native shape here.
    markup: 'markdown',
    rules: [TITLE_VS_BODY_RULE],
  },
  medium: {
    label: 'Medium',
    style: 'narrative, explanatory',
    markup: 'markdown',
    // Same as dev.to: a story published under its own title, not a post.
    form: 'long',
    rules: [TITLE_VS_BODY_RULE],
  },
  quora: {
    label: 'Quora',
    style: 'direct answer format',
    markup: 'none',
    // Answers range from one honest paragraph to an essay; the short end is
    // legitimate, so no floor.
    form: 'short',
  },
  hackernews: {
    label: 'HackerNews',
    style: 'concise, factual, no fluff',
    // The title carries the submission and the text is commentary — 'concise'
    // is the norm, not a shortfall.
    form: 'short',
    // HN formats nothing but blank-line paragraphs and *italics*; a heading or
    // a bulleted list publishes as the characters themselves.
    markup: 'none',
    rules: [TITLE_VS_BODY_RULE],
  },
};

/**
 * Every platform this module has a profile for. The table itself stays private
 * (callers ask it questions, they do not read it), but "which platforms are
 * profiled at all" is a legitimate question — it is what lets a test assert
 * that every profiled platform has a markup rule rather than re-listing them.
 */
export const PROFILED_PLATFORMS: readonly string[] =
  Object.keys(PLATFORM_NATIVE_FORMATS);

/**
 * The markup sentence for ONE platform, built from its `markup` axis above.
 *
 * Deliberately NOT part of `buildPlatformStyleGuidance`: that block answers
 * "who reads this platform and what is fatal when submitting to it", and
 * engage's reference-post prompt only states it when the target differs from
 * the reference. Whether markup renders is true of the TARGET whether or not
 * anything was adapted, so it is its own always-on asset — folding it into the
 * style guidance would either duplicate it on a cross-platform prompt or lose
 * it on a same-platform one.
 *
 * Empty string for a platform with no profile, same contract as
 * `buildPlatformStyleGuidance`, so a caller can drop the line entirely.
 */
const MARKUP_NONE_BODY =
  '"**bold**", "# heading" and backticks publish as the literal characters, so write plain prose — line breaks between thoughts, at most simple "•" bullets, no headings, no bold, no Markdown lists.';

const MARKUP_MARKDOWN_BODY =
  'use structure only where the content genuinely has it — a real list as a list, a quote as a quote, code in a fenced block, and a subheading only where a piece is long enough that a reader needs one. Do not decorate: bold for emphasis, a heading over two paragraphs, or prose rewritten as bullets all read as padding.';

export function buildMarkupRule(platform: string): string {
  const entry = PLATFORM_NATIVE_FORMATS[platform];
  if (!entry) return '';
  return entry.markup === 'markdown'
    ? `Formatting: ${entry.label} renders Markdown, so ${MARKUP_MARKDOWN_BODY}`
    : `Formatting: ${entry.label} renders NO markup. ${MARKUP_NONE_BODY}`;
}

/**
 * The same rules for a prompt generating for SEVERAL platforms at once (the
 * operation plan), grouped by answer rather than repeated per platform: a
 * six-platform plan would otherwise spend six bullets saying two things.
 *
 * Replaces a hand-written "Write PLAIN TEXT for X: no Markdown" line that
 * named one platform and left the model to guess about the other five — and
 * guess wrong on dev.to and Medium, whose native format IS structured.
 *
 * Unprofiled platforms are skipped rather than guessed at, and a group with no
 * platforms produces no line, so a single-platform plan gets a single line.
 */
export function buildMarkupGuidanceLines(
  platforms: readonly string[]
): string[] {
  const profiled = platforms.filter((p) => PLATFORM_NATIVE_FORMATS[p]);
  const group = (kind: PlatformMarkup) =>
    profiled.filter((p) => PLATFORM_NATIVE_FORMATS[p].markup === kind);

  const plain = group('none');
  const markdown = group('markdown');

  return [
    ...(plain.length
      ? [`Formatting — ${plain.join(', ')} render NO markup: ${MARKUP_NONE_BODY}`]
      : []),
    ...(markdown.length
      ? [
          `Formatting — ${markdown.join(
            ', '
          )} render Markdown: ${MARKUP_MARKDOWN_BODY}`,
        ]
      : []),
  ];
}

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
