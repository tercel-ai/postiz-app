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

    // Reddit's default target (1000 chars, prompted at the 0.85 safety margin
    // = 850), not X's (260) — proves platform came from reference.platform,
    // since no outputLength was passed.
    expect(anthropicCreate.mock.calls[0][0].system).toContain('under 850 characters');
  });

  // engage-draft.service.ts measured the model returning 251–294 chars on a
  // 250 target, so the prompt asks for less than the ceiling. X gets its margin
  // structurally (260 target under a 280 ceiling) and is only told to leave
  // room; elsewhere the requested length IS the ceiling, so the target shrinks.
  it('prompts X for the full target but tells it to leave a safety margin', async () => {
    anthropicCreate.mockResolvedValueOnce(anthropicResponse('An original take.'));

    await service.generate(REFERENCE, { strategy: 'EXPERT_ANSWER', brandStrength: 1, outputLength: 260 });

    const systemPrompt = anthropicCreate.mock.calls[0][0].system;
    expect(systemPrompt).toContain('under 260 Twitter-weighted characters');
    expect(systemPrompt).toContain('leave a safety margin');
  });

  it('shrinks the prompted target to 85% on platforms where the request IS the ceiling', async () => {
    anthropicCreate.mockResolvedValueOnce(anthropicResponse('An original take.'));

    await service.generate(
      { ...REFERENCE, platform: 'reddit' },
      { strategy: 'EXPERT_ANSWER', brandStrength: 1, outputLength: 400 }
    );

    expect(anthropicCreate.mock.calls[0][0].system).toContain('under 340 characters');
  });

  // The one rule whose violation is fatal — an over-long post is rejected
  // outright — so it is stated first, restated mid-prompt, and repeated last,
  // the same sandwich engage-draft.service.ts uses. Stated once in the middle
  // of a long prompt is exactly where an instruction gets lost.
  describe('length emphasis in the prompt', () => {
    it('states the limit at the top, in the middle, and at the very end', async () => {
      anthropicCreate.mockResolvedValueOnce(anthropicResponse('An original take.'));

      await service.generate(REFERENCE, { strategy: 'EXPERT_ANSWER', brandStrength: 1, outputLength: 260 });

      const systemPrompt: string = anthropicCreate.mock.calls[0][0].system;
      const occurrences = systemPrompt.split('under 260 Twitter-weighted characters').length - 1;
      expect(occurrences).toBe(3);
      expect(systemPrompt).toContain('HARD LENGTH LIMIT — THIS OUTRANKS EVERY OTHER INSTRUCTION');
      expect(systemPrompt.trimEnd().endsWith('never truncate mid-thought.')).toBe(true);
    });

    it('says length wins over strategy and the brand mention', async () => {
      anthropicCreate.mockResolvedValueOnce(anthropicResponse('An original take.'));

      await service.generate(REFERENCE, { strategy: 'EXPERT_ANSWER', brandStrength: 1, outputLength: 260 });

      const systemPrompt: string = anthropicCreate.mock.calls[0][0].system;
      expect(systemPrompt).toContain(
        'If the strategy, the brand mention, or finishing a thought would push a post past it, cut the content instead'
      );
    });

    // Length used to outrank "the thread length" too, which under an EXACT
    // part count would license the model to drop a post the caller asked for.
    // It still outranks everything about what a post SAYS.
    it('tells a thread to cut what a post says, never the number of posts', async () => {
      anthropicCreate.mockResolvedValueOnce(anthropicResponse('a\n[[PART]]\nb'));

      await service.generate(REFERENCE, {
        strategy: 'EXPERT_ANSWER',
        brandStrength: 1,
        outputLength: 260,
        thread: true,
        maxThreadParts: 2,
      });

      const systemPrompt: string = anthropicCreate.mock.calls[0][0].system;
      expect(systemPrompt).toContain(
        'cut what a post SAYS, never the number of posts, which is fixed below'
      );
      expect(systemPrompt).not.toContain('the thread length');
    });

    it('scopes the limit to EACH post when a thread was asked for', async () => {
      anthropicCreate.mockResolvedValueOnce(anthropicResponse('a\n[[PART]]\nb'));

      await service.generate(REFERENCE, {
        strategy: 'EXPERT_ANSWER',
        brandStrength: 1,
        outputLength: 260,
        thread: true,
        maxThreadParts: 2,
      });

      const systemPrompt: string = anthropicCreate.mock.calls[0][0].system;
      expect(systemPrompt).toContain('keep EACH post of the thread under 260');
      expect(systemPrompt).toContain('a thread is not a licence to spend more characters per post');
    });

    it('repeats the limit in the user message, the last thing the model reads', async () => {
      // The reference post sits between the system prompt and the answer, and
      // is often far longer than the limit — an unrepeated constraint competes
      // with that example.
      anthropicCreate.mockResolvedValueOnce(anthropicResponse('An original take.'));

      await service.generate(REFERENCE, { strategy: 'EXPERT_ANSWER', brandStrength: 1, outputLength: 260 });

      const userContent: string = anthropicCreate.mock.calls[0][0].messages[0].content;
      expect(userContent).toContain('Length is the hard constraint');
      expect(userContent).toContain('under 260 Twitter-weighted characters');
      expect(userContent).toContain('regardless of how long the reference post above is');
    });

    it('keeps the length rule in the similarity corrective', async () => {
      // "Rewrite with entirely new phrasing" is exactly the instruction that
      // makes a model run long, so the retry must not drop the limit.
      anthropicCreate
        .mockResolvedValueOnce(anthropicResponse(REFERENCE.postContent))
        .mockResolvedValueOnce(anthropicResponse('A short original post.'));

      await service.generate(REFERENCE, { strategy: 'EXPERT_ANSWER', brandStrength: 1, outputLength: 260 });

      const retryPrompt: string = anthropicCreate.mock.calls[1][0].system;
      expect(retryPrompt).toContain(
        'The hard length limit stated above still applies to the rewrite'
      );
    });

    it('carries the mandatory brand mention into the closing reminder too', async () => {
      anthropicCreate.mockResolvedValueOnce(anthropicResponse('An original take from AISEE.'));

      await service.generate(REFERENCE, {
        strategy: 'EXPERT_ANSWER',
        brandStrength: 3,
        mentions: ['AISEE'],
        outputLength: 260,
      });

      const systemPrompt: string = anthropicCreate.mock.calls[0][0].system;
      expect(systemPrompt).toContain('must stay under 260 Twitter-weighted characters (CJK/emoji count as 2, URLs as 23 — leave a safety margin) and must name "AISEE"');
    });
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
    anthropicCreate
      .mockResolvedValueOnce(anthropicResponse(tooLong))
      .mockResolvedValueOnce(anthropicResponse(tooLong));

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
    // Both attempts — the shortening retry is a real model call too.
    expect(error.usages).toHaveLength(2);
  });

  it('throws when even the shortening retry exceeds the platform hard character limit', async () => {
    const tooLong = 'x'.repeat(400); // over X's 280-weighted hard ceiling
    anthropicCreate
      .mockResolvedValueOnce(anthropicResponse(tooLong))
      .mockResolvedValueOnce(anthropicResponse(tooLong));

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
      expect(systemPrompt).toContain('EXACTLY 3 posts');
      expect(systemPrompt).toContain('exactly 2 follow-up posts');
      expect(systemPrompt).toContain('EACH post of the thread');
      expect(result.parts).toEqual(['Anchor hook.', 'Second beat.', 'Third beat.']);
      // `text` stays the whole thing, so a caller that only renders it is fine.
      expect(result.text).toBe('Anchor hook.\n\nSecond beat.\n\nThird beat.');
    });

    it('raises the token budget with the number of posts asked for', async () => {
      anthropicCreate.mockResolvedValueOnce(
        anthropicResponse('a\n[[PART]]\nb\n[[PART]]\nc')
      );

      await service.generate(REFERENCE, {
        strategy: 'EXPERT_ANSWER',
        brandStrength: 1,
        outputLength: 260,
        thread: true,
        maxThreadParts: 3,
      });

      // maxThreadParts counts the anchor, so 3 posts × the per-post budget — a
      // single-post request asks for exactly one post's worth.
      expect(anthropicCreate.mock.calls[0][0].max_tokens).toBe(1500);
    });

    it('truncates a chain that came back longer than the requested count', async () => {
      anthropicCreate.mockResolvedValueOnce(
        anthropicResponse('one\n[[PART]]\ntwo\n[[PART]]\nthree\n[[PART]]\nfour')
      );

      const result = await service.generate(REFERENCE, {
        strategy: 'EXPERT_ANSWER',
        brandStrength: 1,
        outputLength: 260,
        thread: true,
        maxThreadParts: 2,
      });

      // Truncation lands ON the requested count, so this is not a shortfall.
      expect(result.parts).toEqual(['one', 'two']);
      expect(result.requestedParts).toBeUndefined();
    });

    it('clamps a caller-supplied count above the hard maximum', async () => {
      // Not mockResolvedValueOnce: 2 posts is short of the clamped 5, so the
      // part-count corrective runs and needs a second response.
      anthropicCreate.mockResolvedValue(anthropicResponse('one\n[[PART]]\ntwo'));

      await service.generate(REFERENCE, {
        strategy: 'EXPERT_ANSWER',
        brandStrength: 1,
        outputLength: 260,
        thread: true,
        maxThreadParts: 99,
      });

      expect(anthropicCreate.mock.calls[0][0].system).toContain(
        'EXACTLY 5 posts'
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
      // Twice: an over-long part earns a shortening retry first. The chain
      // then comes back truncated to its valid prefix — which can only
      // happen if part 2 was length-checked at all.
      anthropicCreate
        .mockResolvedValueOnce(
          anthropicResponse(`A fine anchor post.\n[[PART]]\n${tooLong}`)
        )
        .mockResolvedValueOnce(
          anthropicResponse(`A fine anchor post.\n[[PART]]\n${tooLong}`)
        );

      const result = await service.generate(REFERENCE, {
        strategy: 'EXPERT_ANSWER',
        brandStrength: 1,
        outputLength: 260,
        thread: true,
        maxThreadParts: 2,
      });

      expect(result.parts).toEqual(['A fine anchor post.']);
      expect(result.droppedParts).toBe(1);
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
        maxThreadParts: 2,
      });

      expect(anthropicCreate).toHaveBeenCalledTimes(2);
      expect(result.parts).toHaveLength(2);
    });
  });

  // maxThreadParts is an EXACT count, not a ceiling. It used to be one, and the
  // prompt told the model to "use only as many follow-ups as the topic
  // genuinely earns" — so 2 and 3 both produced 2 posts while 4 and 5 both
  // produced 5, and nothing in the response explained why. These pin the
  // count down: the model is told the exact number, retried once if it comes
  // back short, and the shortfall is REPORTED when even that does not work.
  describe('exact part count', () => {
    const four = 'one\n[[PART]]\ntwo\n[[PART]]\nthree\n[[PART]]\nfour';

    it('delivers exactly the count asked for in one call when the model complies', async () => {
      anthropicCreate.mockResolvedValueOnce(anthropicResponse(four));

      const result = await service.generate(REFERENCE, {
        strategy: 'EXPERT_ANSWER',
        brandStrength: 1,
        outputLength: 260,
        thread: true,
        maxThreadParts: 4,
      });

      expect(anthropicCreate).toHaveBeenCalledTimes(1);
      expect(result.parts).toHaveLength(4);
      expect(result.requestedParts).toBeUndefined();
    });

    it('retries with a corrective when the model writes fewer posts than asked', async () => {
      anthropicCreate
        .mockResolvedValueOnce(anthropicResponse('one\n[[PART]]\ntwo'))
        .mockResolvedValueOnce(anthropicResponse(four));

      const result = await service.generate(REFERENCE, {
        strategy: 'EXPERT_ANSWER',
        brandStrength: 1,
        outputLength: 260,
        thread: true,
        maxThreadParts: 4,
      });

      expect(anthropicCreate).toHaveBeenCalledTimes(2);
      expect(result.parts).toHaveLength(4);
      expect(result.requestedParts).toBeUndefined();
      // Both attempts are real spend, so both must be billable.
      expect(result.usages).toHaveLength(2);

      const corrective: string = anthropicCreate.mock.calls[1][0].system;
      expect(corrective).toContain('Your previous draft was only 2 post(s)');
      expect(corrective).toContain('EXACTLY 4 posts');
      // Says WHERE the extra posts come from. Told only "write 4 posts", a
      // model that considers the topic finished pads with restatement.
      expect(corrective).toContain('Do not pad with restatement');
      expect(corrective).toContain('break it down further');
    });

    it('ships the short thread and reports the shortfall when the corrective does not take', async () => {
      anthropicCreate.mockResolvedValue(anthropicResponse('one\n[[PART]]\ntwo'));

      const result = await service.generate(REFERENCE, {
        strategy: 'EXPERT_ANSWER',
        brandStrength: 1,
        outputLength: 260,
        thread: true,
        maxThreadParts: 4,
      });

      // One corrective, then the draft ships: a coherent, already-billed
      // thread is not worth failing over a post that would have been filler.
      expect(anthropicCreate).toHaveBeenCalledTimes(2);
      expect(result.parts).toEqual(['one', 'two']);
      expect(result.requestedParts).toBe(4);
    });

    // The retry is SHARED (MAX_ATTEMPTS = 2), so the count corrective spends
    // it and a length overrun on the final attempt gets no corrective of its
    // own. What matters is that it still takes its TERMINAL branch — the
    // valid-prefix salvage — instead of continuing into a spent budget and
    // falling out of the loop.
    it('spends the shared retry on the count, then salvages a later length overrun', async () => {
      const LONG = 'x'.repeat(300);
      anthropicCreate
        // 1: short → part-count corrective spends the only retry
        .mockResolvedValueOnce(anthropicResponse('one\n[[PART]]\ntwo'))
        // 2: right count now, but the tail is too long — no retry left
        .mockResolvedValueOnce(
          anthropicResponse(`one\n[[PART]]\ntwo\n[[PART]]\n${LONG}`)
        );

      const result = await service.generate(REFERENCE, {
        strategy: 'EXPERT_ANSWER',
        brandStrength: 1,
        outputLength: 260,
        thread: true,
        maxThreadParts: 3,
      });

      expect(anthropicCreate).toHaveBeenCalledTimes(2);
      // Truncated to the valid prefix, not failed and not returned over-long.
      expect(result.parts).toEqual(['one', 'two']);
      expect(result.droppedParts).toBe(1);
      expect(result.requestedParts).toBe(3);
      // Both attempts are real spend and must both be billable.
      expect(result.usages).toHaveLength(2);
    });

    // The whole budget is 2 calls, whichever combination of problems shows
    // up. This is what bounds the cost of one generation, which is billed per
    // token — a regression here is a silent spend increase.
    it('never exceeds the two-call budget, even when a second problem appears', async () => {
      const LONG = 'x'.repeat(300);
      anthropicCreate.mockResolvedValue(
        anthropicResponse(`one\n[[PART]]\n${LONG}`)
      );

      const result = await service.generate(REFERENCE, {
        strategy: 'EXPERT_ANSWER',
        brandStrength: 1,
        outputLength: 260,
        thread: true,
        maxThreadParts: 3,
      });

      expect(anthropicCreate).toHaveBeenCalledTimes(2);
      expect(result.usages).toHaveLength(2);
    });

    it('keeps the exact count in the shortening corrective, so length never costs a post', async () => {
      const LONG = 'x'.repeat(300);
      anthropicCreate
        .mockResolvedValueOnce(anthropicResponse(`one\n[[PART]]\ntwo\n[[PART]]\n${LONG}`))
        .mockResolvedValueOnce(anthropicResponse('one\n[[PART]]\ntwo\n[[PART]]\nthree'));

      await service.generate(REFERENCE, {
        strategy: 'EXPERT_ANSWER',
        brandStrength: 1,
        outputLength: 260,
        thread: true,
        maxThreadParts: 3,
      });

      expect(anthropicCreate.mock.calls[1][0].system).toContain(
        'Keep the thread at EXACTLY 3 posts'
      );
    });

    it('treats a one-post thread as a single post, with no chain instructions', async () => {
      anthropicCreate.mockResolvedValueOnce(anthropicResponse('One original post.'));

      const result = await service.generate(REFERENCE, {
        strategy: 'EXPERT_ANSWER',
        brandStrength: 1,
        outputLength: 260,
        thread: true,
        maxThreadParts: 1,
      });

      expect(anthropicCreate).toHaveBeenCalledTimes(1);
      expect(anthropicCreate.mock.calls[0][0].system).not.toContain('[[PART]]');
      expect(result.parts).toEqual(['One original post.']);
      expect(result.requestedParts).toBeUndefined();
    });

    it('never runs the count corrective for a single-post request', async () => {
      anthropicCreate.mockResolvedValueOnce(anthropicResponse('One original post.'));

      const result = await service.generate(REFERENCE, {
        strategy: 'EXPERT_ANSWER',
        brandStrength: 1,
        outputLength: 260,
      });

      expect(anthropicCreate).toHaveBeenCalledTimes(1);
      expect(result.requestedParts).toBeUndefined();
    });
  });

  // A four-post thread is four independent chances to overshoot 280. Failing
  // outright there threw away a complete, already-BILLED draft over one long
  // part, and surfaced to the client as an opaque generation_failed.
  describe('platform length ceiling', () => {
    const LONG = 'x'.repeat(300);

    it('retries with a shortening corrective instead of failing outright', async () => {
      anthropicCreate
        .mockResolvedValueOnce(anthropicResponse(`Anchor hook.\n[[PART]]\n${LONG}`))
        .mockResolvedValueOnce(anthropicResponse('Anchor hook.\n[[PART]]\nA short second beat.'));

      const result = await service.generate(REFERENCE, {
        strategy: 'EXPERT_ANSWER',
        brandStrength: 1,
        outputLength: 260,
        thread: true,
        maxThreadParts: 2,
      });

      expect(anthropicCreate).toHaveBeenCalledTimes(2);
      expect(result.parts).toEqual(['Anchor hook.', 'A short second beat.']);
      const retryPrompt = anthropicCreate.mock.calls[1][0].system;
      expect(retryPrompt).toContain('too long');
      // Cutting content, not typography — a model told only "be shorter"
      // strips spaces and mashes words to squeeze under the count.
      expect(retryPrompt).toContain('never compress by removing spaces');
    });

    it('bills BOTH attempts when the retry succeeds', async () => {
      anthropicCreate
        .mockResolvedValueOnce(anthropicResponse(LONG))
        .mockResolvedValueOnce(anthropicResponse('A short original post.'));

      const result = await service.generate(REFERENCE, {
        strategy: 'EXPERT_ANSWER',
        brandStrength: 1,
        outputLength: 260,
      });

      expect(result.usages).toHaveLength(2);
    });

    it('gives up with the usages attached once the retry is also too long', async () => {
      anthropicCreate
        .mockResolvedValueOnce(anthropicResponse(LONG))
        .mockResolvedValueOnce(anthropicResponse(LONG));

      await expect(
        service.generate(REFERENCE, {
          strategy: 'EXPERT_ANSWER',
          brandStrength: 1,
          outputLength: 260,
        })
      ).rejects.toMatchObject({
        name: 'ReferencePostGenerationError',
        usages: expect.arrayContaining([expect.objectContaining({ provider: 'anthropic' })]),
      });
      expect(anthropicCreate).toHaveBeenCalledTimes(2);
    });

    // A thread is a linear argument, so the salvage keeps a PREFIX. Dropping
    // only the offending part would leave the ones after it referring back to
    // a beat the reader never saw.
    it('truncates to the valid prefix rather than failing the whole generation', async () => {
      const chain = `a\n[[PART]]\nb\n[[PART]]\n${LONG}\n[[PART]]\nd`;
      anthropicCreate
        .mockResolvedValueOnce(anthropicResponse(chain))
        .mockResolvedValueOnce(anthropicResponse(chain));

      const result = await service.generate(REFERENCE, {
        strategy: 'EXPERT_ANSWER',
        brandStrength: 1,
        outputLength: 260,
        thread: true,
        maxThreadParts: 4,
      });

      // 'd' goes too — it followed the dropped beat.
      expect(result.parts).toEqual(['a', 'b']);
      expect(result.droppedParts).toBe(2);
      expect(result.text).toBe('a\n\nb');
      // A dropped tail always leaves the chain short of the count asked for.
      expect(result.requestedParts).toBe(4);
    });

    it('still fails when the ANCHOR is the over-long part — there is no prefix to keep', async () => {
      const chain = `${LONG}\n[[PART]]\nb`;
      anthropicCreate
        .mockResolvedValueOnce(anthropicResponse(chain))
        .mockResolvedValueOnce(anthropicResponse(chain));

      await expect(
        service.generate(REFERENCE, {
          strategy: 'EXPERT_ANSWER',
          brandStrength: 1,
          outputLength: 260,
          thread: true,
          maxThreadParts: 2,
        })
      ).rejects.toThrow('thread part 1 of 2');
    });

    // The correctives SHARE one retry (MAX_ATTEMPTS = 2). The hazard that
    // creates: a corrective issued on the final attempt would `continue` into
    // nothing, the loop would end, and control would fall through to the
    // throw after it — reporting THAT line's error (historically
    // "too similar") for whatever problem was really left unfixed, after
    // billing every attempt. `canRetry` keys off the attempt index precisely
    // so the final attempt takes a terminal branch instead.
    it('reports the problem that actually remains, not the one that spent the retry', async () => {
      anthropicCreate
        // 1: plagiarised → similarity corrective spends the only retry
        .mockResolvedValueOnce(anthropicResponse(REFERENCE.postContent))
        // 2: original now, but too long — and no retry left to shorten it
        .mockResolvedValueOnce(anthropicResponse(LONG));

      const error = await service
        .generate(REFERENCE, {
          strategy: 'EXPERT_ANSWER',
          brandStrength: 1,
          outputLength: 260,
        })
        .catch((err) => err);

      expect(anthropicCreate).toHaveBeenCalledTimes(2);
      // The LENGTH failure, not TooSimilarToReferenceError — the draft that
      // came back was original, so blaming plagiarism would be a lie the
      // client surfaces as `too_similar_to_reference`.
      expect(error.name).toBe('ReferencePostGenerationError');
      expect(error).not.toBeInstanceOf(TooSimilarToReferenceError);
      expect(error.message).toMatch(/character|length|limit/i);
      // Both paid attempts still reach the caller for billing.
      expect(error.usages).toHaveLength(2);
    });

    it('reports no droppedParts on a clean generation', async () => {
      anthropicCreate.mockResolvedValueOnce(anthropicResponse('a\n[[PART]]\nb'));

      const result = await service.generate(REFERENCE, {
        strategy: 'EXPERT_ANSWER',
        brandStrength: 1,
        outputLength: 260,
        thread: true,
        maxThreadParts: 2,
      });

      expect(result.droppedParts).toBeUndefined();
      expect(result.requestedParts).toBeUndefined();
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
