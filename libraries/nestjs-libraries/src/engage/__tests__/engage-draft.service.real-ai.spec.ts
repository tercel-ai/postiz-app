import { describe, it, expect } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { EngageOpportunity } from '@prisma/client';
import { weightedLength } from '@gitroom/helpers/utils/count.length';
import { EngageDraftService } from '../engage-draft.service';

const maybeDescribe =
  process.env.RUN_REAL_AI_ENGAGE_DRAFT === '1' ? describe : describe.skip;

function logRealDraft(platform: string, draft: string, lengthLabel: string, length: number) {
  const provider = process.env.OPENROUTER_API_KEY ? 'openrouter' : 'anthropic';
  const model = process.env.OPENROUTER_API_KEY
    ? process.env.OPENROUTER_TEXT_MODEL ?? 'anthropic/claude-sonnet-4-6'
    : 'claude-sonnet-4-6';

  process.stdout.write(
    [
      '',
      `[EngageDraftService real AI: ${platform}]`,
      `provider=${provider}`,
      `model=${model}`,
      `${lengthLabel}=${length}`,
      `draft=${draft}`,
      '',
      '',
    ].join('\n')
  );
}

maybeDescribe('EngageDraftService real AI', () => {
  it(
    'generates a real X draft and keeps output within the weighted limit',
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
      const length = weightedLength(draft);
      logRealDraft('x', draft, 'weightedLength', length);

      expect(draft.length).toBeGreaterThan(0);
      expect(draft).not.toContain('<original_post');
      expect(length).toBeLessThanOrEqual(260);
    },
    60_000
  );

  it(
    'generates a real Reddit draft and keeps output within 1000 characters',
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
        platform: 'reddit',
        primaryIntent: 'help_seeking',
        authorUsername: 'reddit_test_user',
        postContent:
          'I built a small SaaS and people keep saying my posts feel too promotional. How can I reply in a useful way when someone asks for advice?',
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
      logRealDraft('reddit', draft, 'characters', draft.length);

      expect(draft.length).toBeGreaterThan(0);
      expect(draft).not.toContain('<original_post');
      expect(draft.length).toBeLessThanOrEqual(1000);
    },
    60_000
  );
});
