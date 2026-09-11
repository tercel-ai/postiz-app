import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { EngageReferencePostService } from '../engage-reference-post.service';
import { SCANNABLE_PLATFORMS } from '../engage-scan-config.service';
import {
  buildMarkupRule,
  minTargetFor,
} from '@gitroom/nestjs-libraries/integrations/platform-content-profile';

// ---------------------------------------------------------------------------
// Whether the generated post may use headings, bold and lists is a property of
// the TARGET platform, and it used to be a flat ban inside the service's own
// style block: "no bold, no bullet points, no headers". That was written when
// a generated post could only be for x or reddit. With `targetPlatform` the
// same prompt now asks for "a longer dev.to article with code examples" and
// forbade the structure such an article is made of, in the same breath.
//
// The rule now comes from the shared platform profile (`buildMarkupRule`), and
// is stated on EVERY generation — a platform renders Markdown or it does not,
// regardless of whether anything was adapted across platforms.
// ---------------------------------------------------------------------------

const anthropicCreate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: anthropicCreate },
  })),
}));

vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => ({
    chat: { completions: { create: vi.fn() } },
  })),
}));

const REFERENCE = {
  platform: 'x',
  authorUsername: 'coolwriter',
  postContent:
    'The market for handmade ceramics has quietly tripled in the last two years, and most sellers still price like it is 2019.',
  title: null,
};

describe('reference-post formatting rules', () => {
  let service: EngageReferencePostService;

  beforeEach(async () => {
    // Same reason as the sibling specs: a locally-loaded .env with
    // OPENROUTER_API_KEY would take the other provider branch.
    vi.stubEnv('OPENROUTER_API_KEY', '');
    anthropicCreate.mockReset();
    anthropicCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'Small studios price off a market that stopped existing.' }],
      usage: { input_tokens: 100, output_tokens: 40 },
    });
    const module: TestingModule = await Test.createTestingModule({
      providers: [EngageReferencePostService],
    }).compile();
    service = module.get(EngageReferencePostService);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const promptFor = async (targetPlatform?: string, reference = REFERENCE) => {
    await service.generate(reference as any, {
      strategy: 'EXPERT_ANSWER',
      brandStrength: 0,
      ...(targetPlatform ? { targetPlatform } : {}),
    });
    return anthropicCreate.mock.calls[0][0].system as string;
  };

  it.each(['x', 'linkedin', 'quora', 'hackernews'])(
    'tells a %s post that markup publishes as literal characters',
    async (platform) => {
      const prompt = await promptFor(platform);

      expect(prompt).toContain('renders NO markup');
      expect(prompt).toContain('no headings');
    }
  );

  it.each(['reddit', 'devto', 'medium'])(
    'lets a %s post use the structure its native format is made of',
    async (platform) => {
      const prompt = await promptFor(platform);

      expect(prompt).toContain('renders Markdown');
      // The contradiction this fixes: dev.to is asked for a tutorial with code
      // examples, so the prompt must not forbid headings and lists.
      expect(prompt).not.toContain('no headings');
      expect(prompt).not.toContain('no bullet points, no headers');
    }
  );

  it('drops the blanket structure ban from the shared style block', async () => {
    // The prose tells stay shared (they are identical on every platform); only
    // the markup half became per-platform.
    const prompt = await promptFor('devto');

    expect(prompt).toContain('Write the way one specific person types');
    expect(prompt).toContain('No semicolons.');
    expect(prompt).not.toContain('no bold, no bullet points, no headers');
  });

  it('states the rule on a same-platform generation too', async () => {
    // It hangs off the target, not off "the platforms differ" — an X post is
    // plain text whether or not anything was adapted.
    const prompt = await promptFor();

    expect(prompt).toContain(buildMarkupRule('x'));
    expect(prompt).not.toContain('Cross-platform adaptation');
  });

  describe('article-length floor', () => {
    // "up to 2550 characters" is satisfied by 200, and on dev.to or Medium
    // that publishes as a stub under a title promising an article. The
    // ceiling was the only number in the prompt, so the model had no reason
    // to write more.
    it.each(['devto', 'medium'])(
      'gives a %s post a floor as well as a ceiling',
      async (platform) => {
        const prompt = await promptFor(platform);
        const floor = minTargetFor(platform, 2550);

        expect(floor).toBeGreaterThan(0);
        expect(prompt).toContain(`between ${floor} and 2550 characters`);
        expect(prompt).toContain('this is an ARTICLE, not a short post');
      }
    );

    it.each(['x', 'reddit', 'linkedin', 'quora', 'hackernews'])(
      'leaves a %s post with no floor — a two-line post is correct there',
      async (platform) => {
        const prompt = await promptFor(platform);

        expect(minTargetFor(platform)).toBe(0);
        expect(prompt).not.toContain('this is an ARTICLE, not a short post');
      }
    );

    it('scales the floor with an explicit outputLength instead of contradicting it', async () => {
      // A caller asking for a 400-character dev.to post must not be told to
      // write "between 1275 and 340" — the floor is a ratio of the ceiling
      // actually in force, so the two narrow together.
      await service.generate(REFERENCE as any, {
        strategy: 'EXPERT_ANSWER',
        brandStrength: 0,
        targetPlatform: 'devto',
        outputLength: 400,
      });
      const prompt = anthropicCreate.mock.calls[0][0].system as string;

      expect(prompt).toContain('between 170 and 340 characters');
    });

    it('delivers a short article anyway, and says so', async () => {
      // The floor is prompt-side only. Every other gate in the generate loop
      // can throw a draft away; this one must not — a short article is a
      // usable, already-billed post.
      const warn = vi.spyOn((service as any).logger, 'warn');

      const result = await service.generate(REFERENCE as any, {
        strategy: 'EXPERT_ANSWER',
        brandStrength: 0,
        targetPlatform: 'devto',
      });

      expect(result.text).not.toBe('');
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('under the 1275-character article floor')
      );
    });
  });

  it('carries a rule for every platform engage can target', async () => {
    for (const platform of SCANNABLE_PLATFORMS) {
      anthropicCreate.mockClear();
      const prompt = await promptFor(platform);
      const rule = buildMarkupRule(platform);

      expect(rule, `${platform} has no markup rule`).not.toBe('');
      expect(prompt, `${platform} prompt omits its markup rule`).toContain(rule);
    }
  });
});
