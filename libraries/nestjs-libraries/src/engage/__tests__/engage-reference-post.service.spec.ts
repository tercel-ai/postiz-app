import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import {
  EngageReferencePostService,
  ReferencePostGenerationError,
  TooSimilarToReferenceError,
} from '../engage-reference-post.service';

const anthropicCreate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      messages: { create: anthropicCreate },
    })),
  };
});

vi.mock('openai', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      chat: { completions: { create: vi.fn() } },
    })),
  };
});

function anthropicResponse(text: string, usage = { input_tokens: 100, output_tokens: 40 }) {
  return {
    content: [{ type: 'text', text }],
    usage,
  };
}

const REFERENCE = {
  platform: 'x',
  authorUsername: 'coolwriter',
  postContent:
    'The market for handmade ceramics has quietly tripled in the last two years, and most sellers still price like it is 2019.',
  title: null,
};

describe('EngageReferencePostService', () => {
  let service: EngageReferencePostService;

  beforeEach(async () => {
    // Force the Anthropic branch deterministically — the service picks
    // OpenRouter over Anthropic whenever OPENROUTER_API_KEY is set, which it
    // may be via a locally-loaded .env (see engage-draft.service.spec.ts's
    // own note on this). Restored by unstubAllEnvs in afterEach.
    vi.stubEnv('OPENROUTER_API_KEY', '');
    anthropicCreate.mockReset();
    const module: TestingModule = await Test.createTestingModule({
      providers: [EngageReferencePostService],
    }).compile();
    service = module.get<EngageReferencePostService>(
      EngageReferencePostService
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('returns the generated text and one usage entry on a clean first attempt', async () => {
    anthropicCreate.mockResolvedValueOnce(
      anthropicResponse(
        'Something interesting is happening with artisan pottery: demand keeps climbing, yet a lot of makers have not touched their prices in ages.'
      )
    );

    const result = await service.generate(REFERENCE, { strategy: 'EXPERT_ANSWER', brandStrength: 1, outputLength: 260 });

    expect(anthropicCreate).toHaveBeenCalledTimes(1);
    expect(result.text).toContain('artisan pottery');
    expect(result.usages).toEqual([
      {
        promptTokens: 100,
        completionTokens: 40,
        totalTokens: 140,
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
      },
    ]);
  });

  it('derives the target platform from the reference itself, not a client-supplied value', async () => {
    anthropicCreate.mockResolvedValueOnce(anthropicResponse('An original take on ceramics.'));

    await service.generate({ ...REFERENCE, platform: 'reddit' }, { strategy: 'EXPERT_ANSWER', brandStrength: 1 });

    // Reddit's default target (1000 chars), not X's (260) — proves platform
    // came from reference.platform, since no outputLength was passed.
    expect(anthropicCreate.mock.calls[0][0].system).toContain('up to about 1000 characters');
  });

  it('embeds the reference inside <original_post> and never frames this as a reply', async () => {
    anthropicCreate.mockResolvedValueOnce(anthropicResponse('An original take on ceramics.'));

    await service.generate(REFERENCE, { strategy: 'EXPERT_ANSWER', brandStrength: 1, outputLength: 260 });

    const systemPrompt = anthropicCreate.mock.calls[0][0].system;
    const userContent = anthropicCreate.mock.calls[0][0].messages[0].content;

    expect(userContent).toContain('<original_post author="coolwriter">');
    expect(userContent).toContain('handmade ceramics');
    expect(systemPrompt).toContain('not replying to it');
    expect(systemPrompt).toContain('do not copy');
    expect(systemPrompt.toLowerCase()).not.toContain('reply directly to the central point');
  });

  it('uses reworded, non-reply strategy prompts (e.g. QUESTION_LED never says "Reply")', async () => {
    anthropicCreate.mockResolvedValueOnce(anthropicResponse('A fresh take.'));

    await service.generate(REFERENCE, { strategy: 'QUESTION_LED', brandStrength: 1, outputLength: 260 });

    const systemPrompt = anthropicCreate.mock.calls[0][0].system;
    expect(systemPrompt).toContain('Open the post with one genuine, open question');
    expect(systemPrompt).not.toContain('Reply with one genuine');
  });

  it('applies the mandatory brand-mention requirement at brandStrength 3, same mechanism as reply drafts', async () => {
    anthropicCreate.mockResolvedValueOnce(anthropicResponse('AISEE makes this so much easier.'));

    const result = await service.generate(REFERENCE, {
      strategy: 'EXPERT_ANSWER',
      brandStrength: 3,
      mentions: ['AISEE'],
      outputLength: 260,
    });

    const systemPrompt = anthropicCreate.mock.calls[0][0].system;
    expect(systemPrompt).toContain('Brand requirement (non-negotiable)');
    expect(systemPrompt).toContain('must appear verbatim in the post');
    expect(result.text).toContain('AISEE');
  });

  it('ships a draft missing the mandatory mention with a warning rather than retrying', async () => {
    anthropicCreate.mockResolvedValueOnce(
      anthropicResponse('A perfectly original take on ceramics pricing, no brand mentioned.')
    );

    const result = await service.generate(REFERENCE, { strategy: 'EXPERT_ANSWER', brandStrength: 3, mentions: ['AISEE'], outputLength: 260 });

    expect(anthropicCreate).toHaveBeenCalledTimes(1);
    expect(result.text).toContain('no brand mentioned');
  });

  it('retries once with a corrective prompt when the first draft is too similar, then succeeds', async () => {
    anthropicCreate
      .mockResolvedValueOnce(anthropicResponse(REFERENCE.postContent)) // verbatim copy
      .mockResolvedValueOnce(
        anthropicResponse(
          'Something interesting is happening with artisan pottery: demand keeps climbing, yet a lot of makers have not touched their prices in ages.'
        )
      );

    const result = await service.generate(REFERENCE, { strategy: 'EXPERT_ANSWER', brandStrength: 1, outputLength: 260 });

    expect(anthropicCreate).toHaveBeenCalledTimes(2);
    // The second call's system prompt carries the corrective instruction.
    expect(anthropicCreate.mock.calls[1][0].system).toContain(
      'reused too much of the reference'
    );
    // Both attempts are real spend and must both be billed.
    expect(result.usages).toHaveLength(2);
    expect(result.text).toContain('artisan pottery');
  });

  it('throws TooSimilarToReferenceError when even the retry is still too similar, and still reports both usages', async () => {
    anthropicCreate
      .mockResolvedValueOnce(anthropicResponse(REFERENCE.postContent))
      .mockResolvedValueOnce(anthropicResponse(REFERENCE.postContent));

    const error = await service
      .generate(REFERENCE, { strategy: 'EXPERT_ANSWER', brandStrength: 1, outputLength: 260 })
      .catch((e) => e);

    expect(error).toBeInstanceOf(TooSimilarToReferenceError);
    expect(anthropicCreate).toHaveBeenCalledTimes(2);
    // Both attempts were real, billable spend — losing them because the
    // generation ultimately failed would mean these calls are never charged
    // for at all. See ReferencePostGenerationError.
    expect(error.usages).toHaveLength(2);
  });

  it('still attaches every completed usage when a LATER attempt in the same call fails outright (not just similarity)', async () => {
    anthropicCreate
      .mockResolvedValueOnce(anthropicResponse(REFERENCE.postContent)) // too similar → retry
      .mockRejectedValueOnce(new Error('anthropic 500'));

    const error = await service
      .generate(REFERENCE, { strategy: 'EXPERT_ANSWER', brandStrength: 1, outputLength: 260 })
      .catch((e) => e);

    expect(error.message).toBe(
      'Reference-post model call failed after an earlier attempt in the same generation had already succeeded.'
    );
    expect(error.usages).toHaveLength(1);
    expect(error.cause).toBeInstanceOf(Error);
  });

  it('carries the usages when an over-long draft ALSO missed its mandatory brand mention', async () => {
    // Regression: this case used to take a second, unwrapped length check
    // that threw a bare Error, so EngageService's
    // `instanceof ReferencePostGenerationError` guard skipped billing and a
    // model call that really happened was never charged for.
    const tooLong = 'x'.repeat(400); // over X's 280-weighted hard ceiling
    anthropicCreate.mockResolvedValueOnce(anthropicResponse(tooLong));

    const error = await service
      .generate(REFERENCE, {
        strategy: 'EXPERT_ANSWER',
        brandStrength: 3,
        mentions: ['AISEE'], // never appears in the draft above
        outputLength: 260,
      })
      .catch((e) => e);

    expect(error).toBeInstanceOf(ReferencePostGenerationError);
    expect(error.message).toMatch(/280/);
    expect(error.usages).toHaveLength(1);
  });

  it('throws when the accepted draft still exceeds the platform hard character limit', async () => {
    const tooLong = 'x'.repeat(400); // over X's 280-weighted hard ceiling
    anthropicCreate.mockResolvedValueOnce(anthropicResponse(tooLong));

    await expect(
      service.generate(REFERENCE, { strategy: 'EXPERT_ANSWER', brandStrength: 1, outputLength: 260 })
    ).rejects.toThrow(/280/);
  });

  it('stops early and returns no usages when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await service.generate(REFERENCE, {
      strategy: 'EXPERT_ANSWER',
      brandStrength: 1,
      outputLength: 260,
      signal: controller.signal,
    });

    expect(anthropicCreate).not.toHaveBeenCalled();
    expect(result.usages).toEqual([]);
  });

  describe('source adaptation (how closely the post may follow the reference)', () => {
    it('defaults to REFRAME when the caller does not pick a mode', async () => {
      anthropicCreate.mockResolvedValueOnce(anthropicResponse('An original take.'));

      await service.generate(REFERENCE, {
        strategy: 'EXPERT_ANSWER',
        brandStrength: 1,
        outputLength: 260,
      });

      const systemPrompt = anthropicCreate.mock.calls[0][0].system;
      expect(systemPrompt).toContain('Relationship to the reference:');
      expect(systemPrompt).toContain("Keep the reference's core point, but rebuild it");
    });

    it('asks PRESERVE_STRUCTURE to keep the information order but none of the phrasing', async () => {
      anthropicCreate.mockResolvedValueOnce(anthropicResponse('An original take.'));

      await service.generate(REFERENCE, {
        strategy: 'EXPERT_ANSWER',
        brandStrength: 1,
        outputLength: 260,
        sourceAdaptation: 'PRESERVE_STRUCTURE',
      });

      const systemPrompt = anthropicCreate.mock.calls[0][0].system;
      expect(systemPrompt).toContain('same beats in the same sequence');
      // The whole risk of this mode: structure is not a licence to keep text.
      expect(systemPrompt).toContain('NOT permission to keep its sentences');
      // …and the do-not-copy requirement is still there. It narrows to WORDING
      // under this mode — the blanket version forbids reusing the reference's
      // structure, which would contradict the very thing being asked for —
      // but the part that carries the copyright exposure is untouched.
      expect(systemPrompt).toContain('Hard requirement — do not copy');
      expect(systemPrompt).toContain("reuse the reference's sentences or distinctive phrases");
      expect(systemPrompt).toContain('the ORDER of its ideas ONLY, never its wording');
      expect(systemPrompt).not.toContain('distinctive phrases, or structure');
    });

    it('keeps the blanket do-not-copy clause (structure included) for the other modes', async () => {
      anthropicCreate.mockResolvedValueOnce(anthropicResponse('An original take.'));

      await service.generate(REFERENCE, {
        strategy: 'EXPERT_ANSWER',
        brandStrength: 1,
        outputLength: 260,
        sourceAdaptation: 'REFRAME',
      });

      expect(anthropicCreate.mock.calls[0][0].system).toContain(
        'distinctive phrases, or structure'
      );
    });

    it('tells FRESH_ANGLE to take only the topic and not mirror the structure', async () => {
      anthropicCreate.mockResolvedValueOnce(anthropicResponse('An original take.'));

      await service.generate(REFERENCE, {
        strategy: 'EXPERT_ANSWER',
        brandStrength: 1,
        outputLength: 260,
        sourceAdaptation: 'FRESH_ANGLE',
      });

      const systemPrompt = anthropicCreate.mock.calls[0][0].system;
      expect(systemPrompt).toContain('different angle than the reference does');
      expect(systemPrompt).toContain('not a template');
    });

    it('falls back to the default for an unrecognized mode from an internal caller', async () => {
      // The DTO's @IsIn rejects these at the HTTP boundary; internal callers
      // bypass it, same posture as `strategy`'s own fallback.
      anthropicCreate.mockResolvedValueOnce(anthropicResponse('An original take.'));

      await service.generate(REFERENCE, {
        strategy: 'EXPERT_ANSWER',
        brandStrength: 1,
        outputLength: 260,
        sourceAdaptation: 'CLOSE' as any,
      });

      expect(anthropicCreate.mock.calls[0][0].system).toContain(
        "Keep the reference's core point, but rebuild it"
      );
    });

    it('applies the SAME similarity gate under PRESERVE_STRUCTURE — structure is not a copy licence', async () => {
      anthropicCreate
        .mockResolvedValueOnce(anthropicResponse(REFERENCE.postContent))
        .mockResolvedValueOnce(anthropicResponse(REFERENCE.postContent));

      const error = await service
        .generate(REFERENCE, {
          strategy: 'EXPERT_ANSWER',
          brandStrength: 1,
          outputLength: 260,
          sourceAdaptation: 'PRESERVE_STRUCTURE',
        })
        .catch((e) => e);

      expect(error).toBeInstanceOf(TooSimilarToReferenceError);
      expect(anthropicCreate).toHaveBeenCalledTimes(2);
    });

    it('keeps the corrective retry from silently turning PRESERVE_STRUCTURE into a fresh angle', async () => {
      anthropicCreate
        .mockResolvedValueOnce(anthropicResponse(REFERENCE.postContent))
        .mockResolvedValueOnce(
          anthropicResponse('Artisan pottery demand climbs while prices sit still.')
        );

      await service.generate(REFERENCE, {
        strategy: 'EXPERT_ANSWER',
        brandStrength: 1,
        outputLength: 260,
        sourceAdaptation: 'PRESERVE_STRUCTURE',
      });

      const retryPrompt = anthropicCreate.mock.calls[1][0].system;
      expect(retryPrompt).toContain('may still follow the same order of ideas');
      expect(retryPrompt).not.toContain('Keep only the topic and general angle');
    });
  });

  describe('thread generation', () => {
    it('returns a single-element parts array when no thread was asked for', async () => {
      anthropicCreate.mockResolvedValueOnce(anthropicResponse('One original post.'));

      const result = await service.generate(REFERENCE, {
        strategy: 'EXPERT_ANSWER',
        brandStrength: 1,
        outputLength: 260,
      });

      expect(result.parts).toEqual(['One original post.']);
      expect(result.text).toBe('One original post.');
      expect(anthropicCreate.mock.calls[0][0].system).not.toContain('[[PART]]');
    });

    it('asks for a separated chain and splits the response into parts', async () => {
      anthropicCreate.mockResolvedValueOnce(
        anthropicResponse('Anchor hook.\n[[PART]]\nSecond beat.\n[[PART]]\nThird beat.')
      );

      const result = await service.generate(REFERENCE, {
        strategy: 'EXPERT_ANSWER',
        brandStrength: 1,
        outputLength: 260,
        thread: true,
      });

      const systemPrompt = anthropicCreate.mock.calls[0][0].system;
      expect(systemPrompt).toContain('[[PART]]');
      expect(systemPrompt).toContain('up to 3 follow-up posts');
      expect(systemPrompt).toContain('EACH post of the thread');
      expect(result.parts).toEqual(['Anchor hook.', 'Second beat.', 'Third beat.']);
      // `text` stays the whole thing, so a caller that only renders it is fine.
      expect(result.text).toBe('Anchor hook.\n\nSecond beat.\n\nThird beat.');
    });

    it('raises the token budget with the number of posts asked for', async () => {
      anthropicCreate.mockResolvedValueOnce(anthropicResponse('a\n[[PART]]\nb'));

      await service.generate(REFERENCE, {
        strategy: 'EXPERT_ANSWER',
        brandStrength: 1,
        outputLength: 260,
        thread: true,
        maxThreadParts: 2,
      });

      // 3 posts (anchor + 2) × the per-post budget — a single-post request
      // asks for exactly one post's worth.
      expect(anthropicCreate.mock.calls[0][0].max_tokens).toBe(1500);
    });

    it('truncates a chain that came back longer than the requested ceiling', async () => {
      anthropicCreate.mockResolvedValueOnce(
        anthropicResponse('one\n[[PART]]\ntwo\n[[PART]]\nthree\n[[PART]]\nfour')
      );

      const result = await service.generate(REFERENCE, {
        strategy: 'EXPERT_ANSWER',
        brandStrength: 1,
        outputLength: 260,
        thread: true,
        maxThreadParts: 1,
      });

      expect(result.parts).toEqual(['one', 'two']);
    });

    it('clamps a caller-supplied ceiling above the hard maximum', async () => {
      anthropicCreate.mockResolvedValueOnce(anthropicResponse('one\n[[PART]]\ntwo'));

      await service.generate(REFERENCE, {
        strategy: 'EXPERT_ANSWER',
        brandStrength: 1,
        outputLength: 260,
        thread: true,
        maxThreadParts: 99,
      });

      expect(anthropicCreate.mock.calls[0][0].system).toContain(
        'up to 5 follow-up posts'
      );
    });

    it('joins a threaded response into one post when a thread was not requested, never leaking the separator', async () => {
      anthropicCreate.mockResolvedValueOnce(anthropicResponse('one\n[[PART]]\ntwo'));

      const result = await service.generate(REFERENCE, {
        strategy: 'EXPERT_ANSWER',
        brandStrength: 1,
        outputLength: 260,
      });

      expect(result.parts).toEqual(['one\n\ntwo']);
      expect(result.text).not.toContain('[[PART]]');
    });

    it('holds EVERY part to the platform ceiling, not just the anchor', async () => {
      const tooLong = 'x'.repeat(400); // over X's 280-weighted hard ceiling
      anthropicCreate.mockResolvedValueOnce(
        anthropicResponse(`A fine anchor post.\n[[PART]]\n${tooLong}`)
      );

      await expect(
        service.generate(REFERENCE, {
          strategy: 'EXPERT_ANSWER',
          brandStrength: 1,
          outputLength: 260,
          thread: true,
        })
      ).rejects.toThrow(/thread part 2 of 2/);
    });

    it('runs the similarity gate over the WHOLE chain, not part by part', async () => {
      // Neither half alone trips the gate the way the joined text does —
      // scattering the reference's own wording across parts must not be a way
      // around the anti-plagiarism check.
      const half = Math.ceil(REFERENCE.postContent.length / 2);
      anthropicCreate
        .mockResolvedValueOnce(
          anthropicResponse(
            `${REFERENCE.postContent.slice(0, half)}\n[[PART]]\n${REFERENCE.postContent.slice(half)}`
          )
        )
        .mockResolvedValueOnce(
          anthropicResponse(
            'Artisan pottery demand keeps climbing.\n[[PART]]\nYet plenty of makers have not touched their prices in ages.'
          )
        );

      const result = await service.generate(REFERENCE, {
        strategy: 'EXPERT_ANSWER',
        brandStrength: 1,
        outputLength: 260,
        thread: true,
      });

      expect(anthropicCreate).toHaveBeenCalledTimes(2);
      expect(result.parts).toHaveLength(2);
    });
  });

  it('falls back to 0 usage tokens when the provider omits usage data', async () => {
    anthropicCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'An original take on ceramics pricing trends.' }],
      usage: undefined,
    });

    const result = await service.generate(REFERENCE, { strategy: 'EXPERT_ANSWER', brandStrength: 1, outputLength: 260 });
    expect(result.usages).toEqual([]);
  });
});
