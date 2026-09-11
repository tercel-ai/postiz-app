import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CONTENT_LIMIT,
  DEFAULT_TITLE_LENGTH_TARGET,
  MAX_CONTENT_TARGET,
  PROFILED_PLATFORMS,
  TITLE_SEPARATED_PLATFORMS,
  buildCharacterLimitLines,
  buildMarkupGuidanceLines,
  buildMarkupRule,
  minTargetFor,
  buildPlatformNativeFormatLine,
  buildPlatformStyleGuidance,
  hardLimitFor,
  isTitleSeparatedPlatform,
  targetFor,
  titleLengthTargetFor,
  CROSS_PLATFORM_ADAPT_INSTRUCTION,
} from '@gitroom/nestjs-libraries/integrations/platform-content-profile';

// These limits and prompt fragments were private to OperationPlanService until
// engage's reference-post generation needed the identical rules for its
// cross-platform mode. The strings below are asserted VERBATIM on purpose:
// they are what the operation plan has always sent, and this file is what
// stops the shared version from drifting away from it.

describe('hardLimitFor', () => {
  // The authority is each provider's own maxLength(), never a table here.
  it('reads each provider ceiling', () => {
    expect(hardLimitFor('x')).toBe(280);
    expect(hardLimitFor('reddit')).toBe(10000);
    expect(hardLimitFor('linkedin')).toBe(3000);
    expect(hardLimitFor('devto')).toBe(100000);
    expect(hardLimitFor('medium')).toBe(100000);
    expect(hardLimitFor('quora')).toBe(20000);
    expect(hardLimitFor('hackernews')).toBe(20000);
  });

  it('falls back for a platform no provider is registered for', () => {
    expect(hardLimitFor('not-a-platform')).toBe(DEFAULT_CONTENT_LIMIT);
  });
});

describe('targetFor', () => {
  it('keeps X on its hand-tuned soft target, under its real 280 ceiling', () => {
    expect(targetFor('x')).toBe(240);
    expect(targetFor('x')).toBeLessThan(hardLimitFor('x'));
  });

  it('caps every large ceiling so a generated post stays a post', () => {
    for (const platform of ['reddit', 'devto', 'medium', 'quora', 'hackernews']) {
      expect(targetFor(platform)).toBe(MAX_CONTENT_TARGET);
    }
  });

  it("uses a platform's own ceiling when it sits under the cap", () => {
    expect(targetFor('linkedin')).toBe(3000);
  });
});

describe('buildCharacterLimitLines', () => {
  it('states a plain budget line per platform', () => {
    expect(buildCharacterLimitLines(['linkedin', 'quora'])).toEqual([
      '    • linkedin: max 3000 characters',
      '    • quora: max 3000 characters',
    ]);
  });

  it('explains X weighted counting, and only for X', () => {
    expect(buildCharacterLimitLines(['x'])).toEqual([
      "    • x: max 240 characters (X WEIGHTED counting: every URL counts as 23 characters regardless of its real length; CJK characters and emoji count as 2 each.)",
    ]);
  });

  // A ceiling alone is satisfied by 200 characters. On an article platform
  // that publishes as a stub under a title promising an article, so those
  // platforms get both ends of the range.
  it('states a range on an article platform', () => {
    expect(buildCharacterLimitLines(['devto'])).toEqual([
      '    • devto: 1500-3000 characters — this is an ARTICLE, not a short post. Under 1500 reads as a stub; aim for the upper half of the range.',
    ]);
  });

  // The operation plan's MAIN generation prompt states the margin; its narrow
  // coverage-backfill prompt does not.
  it('adds the margin sentence only when asked for', () => {
    expect(buildCharacterLimitLines(['x'], { statedMargin: true })).toEqual([
      "    • x: max 240 characters (X WEIGHTED counting: every URL counts as 23 characters regardless of its real length; CJK characters and emoji count as 2 each. X's own ceiling is 280 — 240 is your budget, so you have margin.)",
    ]);
  });
});

describe('buildPlatformNativeFormatLine', () => {
  it('renders the five long-form platforms in one sentence, verbatim', () => {
    expect(buildPlatformNativeFormatLine()).toBe(
      "Adapt content to each platform's native format: LinkedIn = professional, longer; dev.to = technical, tutorial-style; Medium = narrative, explanatory; Quora = direct answer format; HackerNews = concise, factual, no fluff."
    );
  });

  it('drops a platform it has no profile for rather than emitting a blank pair', () => {
    expect(buildPlatformNativeFormatLine(['linkedin', 'not-a-platform'])).toBe(
      "Adapt content to each platform's native format: LinkedIn = professional, longer."
    );
  });
});

describe('CROSS_PLATFORM_ADAPT_INSTRUCTION', () => {
  it('is the ADAPT-do-not-copy clause both generators send', () => {
    expect(CROSS_PLATFORM_ADAPT_INSTRUCTION).toBe(
      "ADAPT, don't copy: the same message expressed for a different audience and format. For example, an X thread about a data insight becomes a single LinkedIn post with professional framing, or a longer dev.to article with code examples. Keep the theme and the core point; rewrite the delivery."
    );
  });
});

describe('buildPlatformStyleGuidance', () => {
  // The point of the single-platform form: a prompt writing ONE post should
  // not be handed six other platforms' conventions to blend in.
  it('returns only the requested platform', () => {
    const linkedin = buildPlatformStyleGuidance('linkedin');
    expect(linkedin).toContain("LinkedIn's native format: professional, longer.");
    expect(linkedin).not.toContain('Medium');
    expect(linkedin).not.toContain('HackerNews');
  });

  it('carries the format rule that is fatal on that platform', () => {
    // Title-separated surfaces: the body must not repeat the title.
    for (const platform of ['reddit', 'hackernews', 'medium', 'devto']) {
      expect(buildPlatformStyleGuidance(platform)).toContain('BODY ONLY');
    }
    // X's "renders no Markdown" rule is NOT here — it moved to buildMarkupRule,
    // which callers state on every generation rather than only a
    // cross-platform one. See the tests for it below.
    expect(buildPlatformStyleGuidance('x')).not.toContain('renders NO markup');
    // ...and platforms without one say nothing extra.
    expect(buildPlatformStyleGuidance('quora')).toBe(
      "Quora's native format: direct answer format."
    );
  });

  it('is empty for a platform with no profile, so a caller can drop the block', () => {
    expect(buildPlatformStyleGuidance('not-a-platform')).toBe('');
  });
});

describe('minTargetFor', () => {
  it('floors the article platforms at half their budget', () => {
    for (const platform of ['devto', 'medium']) {
      expect(minTargetFor(platform)).toBe(1500);
    }
  });

  it('leaves every short-form platform unfloored', () => {
    // Not an oversight: a two-line X post, a one-paragraph Quora answer and a
    // short LinkedIn post are all correct on their platform. A floor there
    // would buy length with padding.
    for (const platform of ['x', 'reddit', 'linkedin', 'quora', 'hackernews']) {
      expect(minTargetFor(platform), platform).toBe(0);
    }
    expect(minTargetFor('not-a-platform')).toBe(0);
  });

  it('follows the caller down when the ceiling narrows', () => {
    // The whole reason it is a ratio: an absolute floor would eventually ask
    // for a post "between 1500 and 340 characters".
    expect(minTargetFor('devto', 340)).toBe(170);
    expect(minTargetFor('devto', 340)).toBeLessThan(340);
  });
});

describe('buildMarkupGuidanceLines', () => {
  // Replaces a hand-written "Write PLAIN TEXT for X: no Markdown" line in the
  // operation-plan prompt, which named one platform and left the model to
  // guess about the rest of the plan's platforms.
  it('groups the plan’s platforms by what the platform does with markup', () => {
    const lines = buildMarkupGuidanceLines(['x', 'devto', 'linkedin', 'medium']);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('x, linkedin render NO markup');
    expect(lines[1]).toContain('devto, medium render Markdown');
  });

  it('emits only the groups the platforms actually fall into', () => {
    expect(buildMarkupGuidanceLines(['x'])).toHaveLength(1);
    expect(buildMarkupGuidanceLines(['devto'])).toHaveLength(1);
    expect(buildMarkupGuidanceLines([])).toEqual([]);
  });

  it('skips a platform it has no profile for rather than guessing', () => {
    const lines = buildMarkupGuidanceLines(['x', 'not-a-platform']);

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('not-a-platform');
  });

  it('says the same thing as the single-platform rule', () => {
    // Two builders, one wording — a plan and a reference-post must not be
    // told subtly different things about the same platform.
    const grouped = buildMarkupGuidanceLines(['devto'])[0];
    const single = buildMarkupRule('devto');
    const body = 'use structure only where the content genuinely has it';

    expect(grouped).toContain(body);
    expect(single).toContain(body);
  });
});

describe('buildMarkupRule', () => {
  // The rule this replaced was a flat "no bold, no bullet points, no headers"
  // inside engage's own style block, written when a generated post could only
  // be for x or reddit. The moment the same prompt could target dev.to it was
  // asking for a tutorial and forbidding the structure a tutorial is made of.
  it('tells a plain-text platform that markup publishes as characters', () => {
    for (const platform of ['x', 'linkedin', 'quora', 'hackernews']) {
      const rule = buildMarkupRule(platform);
      expect(rule).toContain('renders NO markup');
      expect(rule).toContain('no headings');
    }
  });

  it('lets a Markdown platform use the structure its format is made of', () => {
    for (const platform of ['reddit', 'devto', 'medium']) {
      const rule = buildMarkupRule(platform);
      expect(rule).toContain('renders Markdown');
      // The whole point: a dev.to tutorial may carry a fenced code block and a
      // subheading. What it may not do is decorate.
      expect(rule).not.toContain('no headings');
      expect(rule).toContain('Do not decorate');
    }
  });

  it('names only the platform asked for', () => {
    expect(buildMarkupRule('devto')).toContain('dev.to');
    expect(buildMarkupRule('devto')).not.toContain('Medium');
  });

  it('is empty for a platform with no profile, so a caller can drop the line', () => {
    expect(buildMarkupRule('not-a-platform')).toBe('');
  });

  it('covers every platform in the profile table', () => {
    // `markup` is a required field, so this cannot silently regress — but a
    // platform added with a profile and no rule would still be a prompt with
    // nothing to say about its formatting.
    for (const platform of PROFILED_PLATFORMS) {
      expect(buildMarkupRule(platform), platform).not.toBe('');
    }
  });
});

describe('isTitleSeparatedPlatform', () => {
  it('names the four platforms that submit a title of their own', () => {
    expect(TITLE_SEPARATED_PLATFORMS).toEqual([
      'reddit',
      'hackernews',
      'medium',
      'devto',
    ]);
    for (const platform of TITLE_SEPARATED_PLATFORMS) {
      expect(isTitleSeparatedPlatform(platform)).toBe(true);
    }
  });

  // The platforms whose post IS its text: a generator must not ask them for a
  // title line, and must not parse their response for one.
  it('excludes the platforms with no separate title field', () => {
    for (const platform of ['x', 'linkedin', 'quora', 'not-a-platform']) {
      expect(isTitleSeparatedPlatform(platform)).toBe(false);
    }
  });
});

describe('titleLengthTargetFor', () => {
  // Reddit/HN/dev.to are the platforms' own hard title ceilings; Medium has
  // none worth stating, so it gets an editorial length instead.
  it('states each title-separated platform its own budget', () => {
    expect(titleLengthTargetFor('reddit')).toBe(300);
    expect(titleLengthTargetFor('hackernews')).toBe(80);
    expect(titleLengthTargetFor('medium')).toBe(100);
    expect(titleLengthTargetFor('devto')).toBe(128);
  });

  it('falls back for anything else', () => {
    expect(titleLengthTargetFor('not-a-platform')).toBe(DEFAULT_TITLE_LENGTH_TARGET);
  });
});
