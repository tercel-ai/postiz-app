import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Test } from '@nestjs/testing';

// Force the OpenRouter (JSON) fallback path and feed it an out-of-range score.
process.env.OPENROUTER_API_KEY = 'test-key';

let nextContent = '';
vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: vi.fn(async () => ({
          choices: [{ message: { content: nextContent } }],
        })),
      },
    },
  })),
}));
vi.mock('@anthropic-ai/sdk', () => ({ default: vi.fn() }));

import { EngageIntentClassifierService } from '../engage-intent-classifier.service';

/**
 * Regression for review W3: an LLM may return an intentScore outside [0,1]
 * (or a non-finite value). It must be clamped before it flows past the >=0.45
 * confidence gate and is persisted as the opportunity's confidence.
 */
describe('EngageIntentClassifierService — intentScore clamping', () => {
  let service: EngageIntentClassifierService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [EngageIntentClassifierService],
    }).compile();
    service = moduleRef.get(EngageIntentClassifierService);
    // Local NLI model is unavailable in tests → classifyWithFallback routes to
    // the (mocked) OpenRouter fallback.
    (service as any).classifier = null;
  });

  afterEach(() => vi.clearAllMocks());

  it('clamps an above-range score down to 1', async () => {
    nextContent = JSON.stringify({ intentTags: ['help_seeking'], primaryIntent: 'help_seeking', intentScore: 7 });
    const r = await service.classifyWithFallback('need help');
    expect(r.intentScore).toBe(1);
  });

  it('clamps a negative score up to 0', async () => {
    nextContent = JSON.stringify({ intentTags: ['discussion'], primaryIntent: 'discussion', intentScore: -3 });
    const r = await service.classifyWithFallback('hello');
    expect(r.intentScore).toBe(0);
  });

  it('treats a non-finite/non-number score as 0', async () => {
    nextContent = JSON.stringify({ intentTags: ['discussion'], primaryIntent: 'discussion', intentScore: 'high' });
    const r = await service.classifyWithFallback('hello');
    expect(r.intentScore).toBe(0);
  });

  it('passes an in-range score through unchanged', async () => {
    nextContent = JSON.stringify({ intentTags: ['help_seeking'], primaryIntent: 'help_seeking', intentScore: 0.73 });
    const r = await service.classifyWithFallback('need help');
    expect(r.intentScore).toBeCloseTo(0.73);
  });
});
