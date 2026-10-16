import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { EngageService } from '../engage.service';
import { SendReplyDto, ScheduleReplyDto } from '../dtos/engage.dto';
const body = {
  draftContent: 'reply',
  strategy: 'EXPERT_ANSWER',
  brandStrength: 0,
  projectId: 'project',
};
afterEach(() => vi.unstubAllEnvs());
describe('OPTIONAL manual reply compatibility', () => {
  it.each([SendReplyDto, ScheduleReplyDto])(
    'accepts an omitted account only on the coordinated path: %j',
    async (Dto) => {
      const instance = plainToInstance(Dto as typeof SendReplyDto, {
        ...body,
        scheduledAt: '2099-01-01T00:00:00Z',
      });
      vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'true');
      expect(
        (await validate(instance)).filter((e) => e.property === 'integrationId')
      ).toHaveLength(0);
      vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'false');
      expect(
        (await validate(instance)).some((e) => e.property === 'integrationId')
      ).toBe(true);
    }
  );
  it.each(['sendReply', 'scheduleReply'] as const)(
    'leaves the account unresolved through %s and preserves the reply target',
    async (method) => {
      vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'true');
      const createPost = vi.fn().mockResolvedValue([{ postId: 'root' }]);
      const service = Object.assign(Object.create(EngageService.prototype), {
        _postsService: { createPost },
        _engageRepository: {
          claimOpportunityForReply: vi
            .fn()
            .mockResolvedValue({
              opportunityId: 'opportunity',
              projectId: 'project',
              opp: {
                platform: 'x',
                externalPostId: 'target',
                matchedKeywords: [],
              },
            }),
          createSentReply: vi.fn().mockResolvedValue({ postId: 'root' }),
        },
      }) as EngageService;
      await service[method]({ id: 'org' } as any, 'user', 'opportunity', {
        ...body,
        scheduledAt: '2099-01-01T00:00:00Z',
      } as any);
      const sent = createPost.mock.calls[0][1].posts[0];
      expect(sent.integration).toBeUndefined();
      expect(sent).toMatchObject({
        providerIdentifier: 'x',
        publishMethod: 'extension',
        settings: { reply_to_tweet_id: 'target' },
      });
    }
  );
  it('still rejects a malformed supplied account', async () => {
    vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'true');
    const instance = plainToInstance(SendReplyDto, {
      ...body,
      integrationId: 42,
    });
    expect(
      (await validate(instance)).some((e) => e.property === 'integrationId')
    ).toBe(true);
  });
});
