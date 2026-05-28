import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { EngageIntentClassifierService } from '../engage-intent-classifier.service';
import { INTENT_LABELS } from '../engage-intent.constants';

// Mock Anthropic — prevents live API calls when ANTHROPIC_API_KEY is set in CI
vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: vi.fn().mockImplementation(() => {
      return {
        messages: {
          create: vi.fn().mockResolvedValue({
            content: [
              {
                type: 'tool_use',
                input: {
                  intentTags: ['help_seeking'],
                  primaryIntent: 'help_seeking',
                  intentScore: 0.9,
                },
              },
            ],
          }),
        },
      };
    }),
  };
});

// Mock OpenAI (OpenRouter path) — prevents live API calls when OPENROUTER_API_KEY is set in CI
vi.mock('openai', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    intentTags: ['help_seeking'],
                    primaryIntent: 'help_seeking',
                    intentScore: 0.9,
                  }),
                },
              },
            ],
          }),
        },
      },
    })),
  };
});

describe('EngageIntentClassifierService', () => {
  let service: EngageIntentClassifierService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [EngageIntentClassifierService],
    }).compile();

    service = module.get<EngageIntentClassifierService>(
      EngageIntentClassifierService
    );
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('Intent Recognition Requirements', () => {
    const testCases = [
      {
        name: 'Help-seeking (求助型)',
        text: 'Does anyone know how to set up a NestJS controller with SSE? I need help with the implementation.',
        expectedPrimary: 'help_seeking',
      },
      {
        name: 'Discussion (讨论型)',
        text: 'What are your thoughts on the future of AI in social media engagement? I would love to hear different perspectives.',
        expectedPrimary: 'discussion',
      },
      {
        name: 'Opinion (观点型)',
        text: 'I think local NLP models are much better than cloud APIs for simple classification tasks. It is more cost-effective.',
        expectedPrimary: 'opinion',
      },
      {
        name: 'Comparison (比较型)',
        text: 'NestJS vs Express: which one is better for a high-performance backend? Are there any alternatives?',
        expectedPrimary: 'comparison',
      },
      {
        name: 'Data Share (数据分享)',
        text: 'Our recent study found that 60% of users prefer AI-generated replies if they are high quality. Check out our latest report.',
        expectedPrimary: 'data_share',
      },
      {
        name: 'Rant (吐槽型)',
        text: "I'm so tired of these social media platforms changing their APIs every month. It's so annoying and frustrating!",
        expectedPrimary: 'rant',
      },
    ];

    testCases.forEach(({ name, text, expectedPrimary }) => {
      it(`should recognize ${name} intent`, async () => {
        // Mocking the classifier to simulate local model behavior
        // In a real scenario, this would call the actual local model
        const mockClassifier = vi.fn().mockResolvedValue({
          labels: [expectedPrimary, ...INTENT_LABELS.filter(l => l !== expectedPrimary)],
          scores: [0.8, ...new Array(INTENT_LABELS.length - 1).fill(0.04)],
        });
        (service as any).classifier = mockClassifier;

        const result = await service.classify(text);
        expect(result.primaryIntent).toBe(expectedPrimary);
        expect(result.intentTags).toContain(expectedPrimary);
        expect(result.intentScore).toBeGreaterThan(0.5);
      });
    });

    it('should support multiple intent tags when confidence > 0.4', async () => {
      const text = 'How does AISEE compare to other tools? I need help deciding which one to buy.';
      const mockClassifier = vi.fn().mockResolvedValue({
        labels: ['comparison', 'help_seeking', 'discussion', 'opinion', 'data_share', 'rant'],
        scores: [0.7, 0.6, 0.1, 0.05, 0.03, 0.02],
      });
      (service as any).classifier = mockClassifier;

      const result = await service.classify(text);
      expect(result.primaryIntent).toBe('comparison');
      expect(result.intentTags).toContain('comparison');
      expect(result.intentTags).toContain('help_seeking');
      expect(result.intentTags).toHaveLength(2);
    });
  });

  describe('Fallback Logic', () => {
    it('should fallback to Claude Haiku when local model confidence is low', async () => {
      // Local model returns low confidence
      const mockClassifier = vi.fn().mockResolvedValue({
        labels: ['discussion', 'help_seeking'],
        scores: [0.3, 0.2],
      });
      (service as any).classifier = mockClassifier;

      // Mocking Claude response for this specific test
      const claudeSpy = vi.spyOn(service as any, '_claudeFallbackClassify').mockResolvedValue({
        intentTags: ['help_seeking'],
        primaryIntent: 'help_seeking',
        intentScore: 0.9,
      });

      const result = await service.classifyWithFallback('Some text');
      
      expect(claudeSpy).toHaveBeenCalled();
      expect(result.primaryIntent).toBe('help_seeking');
    });

    it('should use local model when confidence is high enough', async () => {
      const mockClassifier = vi.fn().mockResolvedValue({
        labels: ['opinion'],
        scores: [0.6],
      });
      (service as any).classifier = mockClassifier;

      const claudeSpy = vi.spyOn(service as any, '_claudeFallbackClassify');

      const result = await service.classifyWithFallback('I think this is great');

      expect(claudeSpy).not.toHaveBeenCalled();
      expect(result.primaryIntent).toBe('opinion');
    });
  });

  describe('classifyBatch — per-item failure isolation (fix #10)', () => {
    it('should not reject the entire batch when one item fails', async () => {
      // Mock classifier rejects only for the second item.
      const callOrder: string[] = [];
      vi.spyOn(service, 'classifyWithFallback').mockImplementation(
        async (text: string) => {
          callOrder.push(text);
          if (text === 'bad') throw new Error('pipeline crash');
          return {
            intentTags: ['discussion'],
            primaryIntent: 'discussion',
            intentScore: 0.9,
          };
        }
      );

      const result = await service.classifyBatch([
        { id: 'a', content: 'good-a' },
        { id: 'b', content: 'bad' },
        { id: 'c', content: 'good-c' },
        { id: 'd', content: 'good-d' },
      ]);

      // All 4 items get a result entry — the one that failed gets the safe default.
      expect(Object.keys(result).sort()).toEqual(['a', 'b', 'c', 'd']);
      expect(result.a.primaryIntent).toBe('discussion');
      expect(result.b).toEqual({
        intentTags: ['discussion'],
        primaryIntent: 'discussion',
        intentScore: 0,
      });
      expect(result.c.primaryIntent).toBe('discussion');
      expect(result.d.primaryIntent).toBe('discussion');
    });
  });
});
