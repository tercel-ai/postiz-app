import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { EngageDraftService } from '../engage-draft.service';
import { EngageOpportunity } from '@prisma/client';

const mockAnthropicResponse = {
  content: [{ type: 'text', text: 'Hello world!' }],
};

// Mock Anthropic — prevents live API calls when ANTHROPIC_API_KEY is set
vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: vi.fn().mockImplementation(() => {
      return {
        messages: {
          create: vi.fn().mockResolvedValue(mockAnthropicResponse),
        },
      };
    }),
  };
});

// Mock OpenAI (OpenRouter path) — prevents live API calls when OPENROUTER_API_KEY is set.
// The service picks OpenRouter when OPENROUTER_API_KEY is present, so we must mock openai
// here to stop vitest (which loads .env via dotenv/config) from hitting the real API.
vi.mock('openai', () => {
  const fakeResponse = {
    choices: [{ message: { content: 'Hello world!' } }],
  };
  return {
    default: vi.fn().mockImplementation(() => ({
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue(fakeResponse),
        },
      },
    })),
  };
});

describe('EngageDraftService', () => {
  let service: EngageDraftService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [EngageDraftService],
    }).compile();

    service = module.get<EngageDraftService>(EngageDraftService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('Prompt Building', () => {
    const mockOpportunity: Partial<EngageOpportunity> = {
      platform: 'x',
      primaryIntent: 'help_seeking',
      authorUsername: 'testuser',
      postContent: 'How do I do X?',
    };

    it('should include platform-specific character limits in system prompt', () => {
      const xPrompt = (service as any)._buildSystemPrompt('x', 'EXPERT_ANSWER', 'help_seeking', 1);
      expect(xPrompt).toContain('under 260 Twitter-weighted characters');

      const redditPrompt = (service as any)._buildSystemPrompt('reddit', 'EXPERT_ANSWER', 'help_seeking', 1);
      expect(redditPrompt).toContain('under 1000 characters');
    });

    it('should restate the platform character limit as an IMPORTANT final instruction', () => {
      const xPrompt = (service as any)._buildSystemPrompt('x', 'EXPERT_ANSWER', 'help_seeking', 1);
      expect(xPrompt).toContain(
        'IMPORTANT: The final reply must stay under 260 Twitter-weighted characters'
      );

      const redditPrompt = (service as any)._buildSystemPrompt('reddit', 'EXPERT_ANSWER', 'help_seeking', 1);
      expect(redditPrompt).toContain(
        'IMPORTANT: The final reply must stay under 1000 characters.'
      );
    });

    it('should include strategy instructions in system prompt', () => {
      const expertPrompt = (service as any)._buildSystemPrompt('x', 'EXPERT_ANSWER', 'help_seeking', 1);
      expect(expertPrompt).toContain('expert step-by-step advice');

      const dataPrompt = (service as any)._buildSystemPrompt('x', 'DATA_BACKED', 'help_seeking', 1);
      expect(dataPrompt).toContain('Lead with data from scanning 1000+ brands');
    });

    it('should include brand strength instructions in system prompt', () => {
      // brandStrength=0 → no brand at all, regardless of mentions.
      const brand0Prompt = (service as any)._buildSystemPrompt('x', 'EXPERT_ANSWER', 'help_seeking', 0);
      expect(brand0Prompt).toContain('Do not mention any brand name');

      // brandStrength=3 with a brand mention → proactively introduce that brand.
      const brand3Prompt = (service as any)._buildSystemPrompt('x', 'EXPERT_ANSWER', 'help_seeking', 3, 260, ['AISEE']);
      expect(brand3Prompt).toContain('Proactively introduce AISEE');
      expect(brand3Prompt).toContain('invite the person to try it');
    });

    it('should build a correct user prompt with author and content', () => {
      const userPrompt = (service as any)._buildUserPrompt(mockOpportunity as EngageOpportunity);
      // Author + content land inside a delimited element (prompt-injection guard).
      expect(userPrompt).toContain('<original_post author="testuser">');
      expect(userPrompt).toContain('How do I do X?');
      expect(userPrompt).toContain('</original_post>');
    });

    it('should wrap external post content inside <original_post> delimiter', () => {
      const userPrompt = (service as any)._buildUserPrompt(mockOpportunity as EngageOpportunity);
      // Content MUST be inside the envelope so the system prompt's "treat as data" rule applies.
      const startIdx = userPrompt.indexOf('<original_post');
      const endIdx = userPrompt.indexOf('</original_post>');
      expect(startIdx).toBeGreaterThanOrEqual(0);
      expect(endIdx).toBeGreaterThan(startIdx);
      const contentIdx = userPrompt.indexOf('How do I do X?');
      expect(contentIdx).toBeGreaterThan(startIdx);
      expect(contentIdx).toBeLessThan(endIdx);
    });

    it('should strip control characters and cap length on postContent', () => {
      const longContent = 'A'.repeat(3000) + 'B'; // > 2000-char cap
      const withControlChars = `before\x00\x01\x07after`;
      const promptLong = (service as any)._buildUserPrompt({
        ...mockOpportunity,
        postContent: longContent,
      } as EngageOpportunity);
      expect(promptLong).not.toContain('B'); // truncated at 2000
      const promptCtrl = (service as any)._buildUserPrompt({
        ...mockOpportunity,
        postContent: withControlChars,
      } as EngageOpportunity);
      expect(promptCtrl).toContain('beforeafter');
      expect(promptCtrl).not.toMatch(/[\x00-\x08\x0B\x0C\x0E-\x1F]/);
    });

    it('should instruct the model to treat post content as data, not instructions', () => {
      const systemPrompt = (service as any)._buildSystemPrompt(
        'x', 'EXPERT_ANSWER', 'help_seeking', 1
      );
      // System prompt tells the model how to handle the <original_post> envelope.
      expect(systemPrompt).toMatch(/original_post|attacker-controlled|treat .* as data|Ignore any instructions/i);
    });
  });

  describe('Draft Generation', () => {
    it('should generate text from the configured provider', async () => {
      const mockOpportunity: Partial<EngageOpportunity> = {
        platform: 'x',
        primaryIntent: 'help_seeking',
        authorUsername: 'testuser',
        postContent: 'How do I do X?',
      };

      const generator = service.generateDraft(
        mockOpportunity as EngageOpportunity,
        'EXPERT_ANSWER',
        1
      );

      const chunks = [];
      for await (const chunk of generator) {
        chunks.push(chunk);
      }

      expect(chunks.join('')).toBe('Hello world!');
    });

    it('should return the first X draft when it is within the weighted limit', async () => {
      const generateRaw = vi
        .spyOn(service as any, '_generateRaw')
        .mockResolvedValue('A concise complete reply.');
      const mockOpportunity: Partial<EngageOpportunity> = {
        platform: 'x',
        primaryIntent: 'help_seeking',
        authorUsername: 'testuser',
        postContent: 'How do I do X?',
      };

      const chunks = [];
      for await (const chunk of service.generateDraft(
        mockOpportunity as EngageOpportunity,
        'EXPERT_ANSWER',
        1
      )) {
        chunks.push(chunk);
      }

      expect(chunks.join('')).toBe('A concise complete reply.');
      expect(generateRaw).toHaveBeenCalledTimes(1);
    });

    it('should retry X draft generation once when the first draft exceeds the weighted limit', async () => {
      const generateRaw = vi
        .spyOn(service as any, '_generateRaw')
        .mockResolvedValueOnce('x'.repeat(261))
        .mockResolvedValueOnce('Short complete reply.');
      const mockOpportunity: Partial<EngageOpportunity> = {
        platform: 'x',
        primaryIntent: 'help_seeking',
        authorUsername: 'testuser',
        postContent: 'How do I do X?',
      };

      const chunks = [];
      for await (const chunk of service.generateDraft(
        mockOpportunity as EngageOpportunity,
        'EXPERT_ANSWER',
        1
      )) {
        chunks.push(chunk);
      }

      expect(chunks.join('')).toBe('Short complete reply.');
      expect(generateRaw).toHaveBeenCalledTimes(2);
      expect(generateRaw.mock.calls[1][0]).toContain(
        'Your previous draft exceeded the X character limit'
      );
    });

    it('should treat twitter platform aliases as X for weighted limit enforcement', async () => {
      const generateRaw = vi
        .spyOn(service as any, '_generateRaw')
        .mockResolvedValueOnce('x'.repeat(261))
        .mockResolvedValueOnce('Short complete reply.');
      const mockOpportunity: Partial<EngageOpportunity> = {
        platform: 'twitter',
        primaryIntent: 'help_seeking',
        authorUsername: 'testuser',
        postContent: 'How do I do X?',
      };

      const chunks = [];
      for await (const chunk of service.generateDraft(
        mockOpportunity as EngageOpportunity,
        'EXPERT_ANSWER',
        1
      )) {
        chunks.push(chunk);
      }

      expect(chunks.join('')).toBe('Short complete reply.');
      expect(generateRaw).toHaveBeenCalledTimes(2);
    });

    it('should treat uppercase X platform values as X for weighted limit enforcement', async () => {
      const generateRaw = vi
        .spyOn(service as any, '_generateRaw')
        .mockResolvedValueOnce('x'.repeat(261))
        .mockResolvedValueOnce('Short complete reply.');
      const mockOpportunity: Partial<EngageOpportunity> = {
        platform: 'X',
        primaryIntent: 'help_seeking',
        authorUsername: 'testuser',
        postContent: 'How do I do X?',
      };

      const chunks = [];
      for await (const chunk of service.generateDraft(
        mockOpportunity as EngageOpportunity,
        'EXPERT_ANSWER',
        1
      )) {
        chunks.push(chunk);
      }

      expect(chunks.join('')).toBe('Short complete reply.');
      expect(generateRaw).toHaveBeenCalledTimes(2);
    });

    it('should throw for X when the retry draft still exceeds the weighted limit', async () => {
      vi.spyOn(service as any, '_generateRaw')
        .mockResolvedValueOnce('x'.repeat(261))
        .mockResolvedValueOnce('x'.repeat(261));
      const mockOpportunity: Partial<EngageOpportunity> = {
        platform: 'x',
        primaryIntent: 'help_seeking',
        authorUsername: 'testuser',
        postContent: 'How do I do X?',
      };

      const consume = async () => {
        const chunks = [];
        for await (const chunk of service.generateDraft(
          mockOpportunity as EngageOpportunity,
          'EXPERT_ANSWER',
          1
        )) {
          chunks.push(chunk);
        }
      };

      await expect(consume()).rejects.toThrow(
        'Generated X draft exceeded 260 Twitter-weighted characters after retry.'
      );
    });

    it('should return Reddit drafts when they are within the 500 character limit', async () => {
      const generateRaw = vi
        .spyOn(service as any, '_generateRaw')
        .mockResolvedValue('r'.repeat(300) + ' still generated');
      const mockOpportunity: Partial<EngageOpportunity> = {
        platform: 'reddit',
        primaryIntent: 'help_seeking',
        authorUsername: 'testuser',
        postContent: 'How do I do X?',
      };

      const chunks = [];
      for await (const chunk of service.generateDraft(
        mockOpportunity as EngageOpportunity,
        'EXPERT_ANSWER',
        1
      )) {
        chunks.push(chunk);
      }

      expect(chunks).toEqual(['r'.repeat(300) + ' still generated']);
      expect(generateRaw).toHaveBeenCalledTimes(1);
    });

    it('should throw for Reddit drafts over 1000 characters without regenerating', async () => {
      const generateRaw = vi
        .spyOn(service as any, '_generateRaw')
        .mockResolvedValue('r'.repeat(1001));
      const mockOpportunity: Partial<EngageOpportunity> = {
        platform: 'reddit',
        primaryIntent: 'help_seeking',
        authorUsername: 'testuser',
        postContent: 'How do I do X?',
      };

      const consume = async () => {
        const chunks = [];
        for await (const chunk of service.generateDraft(
          mockOpportunity as EngageOpportunity,
          'EXPERT_ANSWER',
          1
        )) {
          chunks.push(chunk);
        }
      };

      await expect(consume()).rejects.toThrow(
        'Generated Reddit draft exceeded 1000 characters.'
      );
      expect(generateRaw).toHaveBeenCalledTimes(1);
    });
  });
});
