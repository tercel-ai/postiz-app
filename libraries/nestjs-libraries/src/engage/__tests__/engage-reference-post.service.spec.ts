import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import {
  EngageReferencePostService,
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

    const result = await service.generate(REFERENCE, 'EXPERT_ANSWER', 1, undefined, 260);

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

    await service.generate({ ...REFERENCE, platform: 'reddit' }, 'EXPERT_ANSWER', 1, undefined, undefined);

    // Reddit's default target (1000 chars), not X's (260) — proves platform
    // came from reference.platform, since no outputLength was passed.
    expect(anthropicCreate.mock.calls[0][0].system).toContain('up to about 1000 characters');
  });

  it('embeds the reference inside <original_post> and never frames this as a reply', async () => {
    anthropicCreate.mockResolvedValueOnce(anthropicResponse('An original take on ceramics.'));

    await service.generate(REFERENCE, 'EXPERT_ANSWER', 1, undefined, 260);

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

    await service.generate(REFERENCE, 'QUESTION_LED', 1, undefined, 260);

    const systemPrompt = anthropicCreate.mock.calls[0][0].system;
    expect(systemPrompt).toContain('Open the post with one genuine, open question');
    expect(systemPrompt).not.toContain('Reply with one genuine');
  });

  it('applies the mandatory brand-mention requirement at brandStrength 3, same mechanism as reply drafts', async () => {
    anthropicCreate.mockResolvedValueOnce(anthropicResponse('AISEE makes this so much easier.'));

    const result = await service.generate(
      REFERENCE,
      'EXPERT_ANSWER',
      3,
      ['AISEE'],
      260
    );

    const systemPrompt = anthropicCreate.mock.calls[0][0].system;
    expect(systemPrompt).toContain('Brand requirement (non-negotiable)');
    expect(systemPrompt).toContain('must appear verbatim in the post');
    expect(result.text).toContain('AISEE');
  });

  it('ships a draft missing the mandatory mention with a warning rather than retrying', async () => {
    anthropicCreate.mockResolvedValueOnce(
      anthropicResponse('A perfectly original take on ceramics pricing, no brand mentioned.')
    );

    const result = await service.generate(REFERENCE, 'EXPERT_ANSWER', 3, ['AISEE'], 260);

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

    const result = await service.generate(REFERENCE, 'EXPERT_ANSWER', 1, undefined, 260);

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
      .generate(REFERENCE, 'EXPERT_ANSWER', 1, undefined, 260)
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
      .generate(REFERENCE, 'EXPERT_ANSWER', 1, undefined, 260)
      .catch((e) => e);

    expect(error.message).toBe(
      'Reference-post model call failed after an earlier attempt in the same generation had already succeeded.'
    );
    expect(error.usages).toHaveLength(1);
    expect(error.cause).toBeInstanceOf(Error);
  });

  it('throws when the accepted draft still exceeds the platform hard character limit', async () => {
    const tooLong = 'x'.repeat(400); // over X's 280-weighted hard ceiling
    anthropicCreate.mockResolvedValueOnce(anthropicResponse(tooLong));

    await expect(
      service.generate(REFERENCE, 'EXPERT_ANSWER', 1, undefined, 260)
    ).rejects.toThrow(/280/);
  });

  it('stops early and returns no usages when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await service.generate(
      REFERENCE,
      'EXPERT_ANSWER',
      1,
      undefined,
      260,
      controller.signal
    );

    expect(anthropicCreate).not.toHaveBeenCalled();
    expect(result.usages).toEqual([]);
  });

  it('falls back to 0 usage tokens when the provider omits usage data', async () => {
    anthropicCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'An original take on ceramics pricing trends.' }],
      usage: undefined,
    });

    const result = await service.generate(REFERENCE, 'EXPERT_ANSWER', 1, undefined, 260);
    expect(result.usages).toEqual([]);
  });
});
