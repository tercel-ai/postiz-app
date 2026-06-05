import { describe, it, expect } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { EngageOpportunity } from '@prisma/client';
import { weightedLength } from '@gitroom/helpers/utils/count.length';
import { EngageDraftService } from '../engage-draft.service';

const maybeDescribe =
  process.env.RUN_REAL_AI_ENGAGE_DRAFT === '1' ? describe : describe.skip;

maybeDescribe('EngageDraftService real AI', () => {
  it(
    'streams a real draft and keeps X output within the weighted limit',
    async () => {
      expect(
        process.env.OPENROUTER_API_KEY ||
          process.env.ANTHROPIC_API_KEY ||
          process.env.CLAUDE_API_KEY
      ).toBeTruthy();

      const module: TestingModule = await Test.createTestingModule({
        providers: [EngageDraftService],
      }).compile();

      const service = module.get<EngageDraftService>(EngageDraftService);
      const opportunity: Partial<EngageOpportunity> = {
        platform: 'x',
        primaryIntent: 'help_seeking',
        authorUsername: 'founder_test',
        postContent:
          'I keep posting product updates but nobody replies. How can I make the posts more useful without sounding salesy?',
      };

      const chunks: string[] = [];
      for await (const chunk of service.generateDraft(
        opportunity as EngageOpportunity,
        'EXPERT_ANSWER',
        1,
        []
      )) {
        chunks.push(chunk);
      }

      const draft = chunks.join('').trim();
      expect(draft.length).toBeGreaterThan(0);
      expect(draft).not.toContain('<original_post');
      expect(weightedLength(draft)).toBeLessThanOrEqual(260);
    },
    60_000
  );
});
