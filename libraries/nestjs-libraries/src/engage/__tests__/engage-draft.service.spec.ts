import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { EngageDraftService } from '../engage-draft.service';
import { EngageOpportunity } from '@prisma/client';

// Shared mock stream — two text chunks followed by a stop event.
const mockStream = {
  [Symbol.asyncIterator]: async function* () {
    yield {
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: 'Hello ' },
    };
    yield {
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: 'world!' },
    };
  },
};

// Mock Anthropic — prevents live API calls when ANTHROPIC_API_KEY is set
vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: vi.fn().mockImplementation(() => {
      return {
        messages: {
          create: vi.fn().mockResolvedValue(mockStream),
        },
      };
    }),
  };
});

// Mock OpenAI (OpenRouter path) — prevents live API calls when OPENROUTER_API_KEY is set.
// The service picks OpenRouter when OPENROUTER_API_KEY is present, so we must mock openai
// here to stop vitest (which loads .env via dotenv/config) from hitting the real API.
vi.mock('openai', () => {
  const fakeStream = {
    [Symbol.asyncIterator]: async function* () {
      yield { choices: [{ delta: { content: 'Hello ' } }] };
      yield { choices: [{ delta: { content: 'world!' } }] };
    },
  };
  return {
    default: vi.fn().mockImplementation(() => ({
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue(fakeStream),
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
      expect(redditPrompt).toContain('up to 500 words');
    });

    it('should include strategy instructions in system prompt', () => {
      const expertPrompt = (service as any)._buildSystemPrompt('x', 'EXPERT_ANSWER', 'help_seeking', 1);
      expect(expertPrompt).toContain('expert step-by-step advice');

      const dataPrompt = (service as any)._buildSystemPrompt('x', 'DATA_BACKED', 'help_seeking', 1);
      expect(dataPrompt).toContain('Lead with data from scanning 500+ brands');
    });

    it('should include brand strength instructions in system prompt', () => {
      const brand0Prompt = (service as any)._buildSystemPrompt('x', 'EXPERT_ANSWER', 'help_seeking', 0);
      expect(brand0Prompt).toContain('Do not mention AISEE');

      const brand3Prompt = (service as any)._buildSystemPrompt('x', 'EXPERT_ANSWER', 'help_seeking', 3);
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
    it('should stream chunks of text from Claude', async () => {
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

      expect(chunks).toEqual(['Hello ', 'world!']);
    });
  });
});
