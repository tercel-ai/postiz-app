import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EngageService } from '@gitroom/nestjs-libraries/engage/engage.service';

/**
 * Regression coverage for the batch-reply blockers (review B1/B2):
 * a batch of N items against one opportunity must record N tracking rows
 * (one per post), not collapse to one because of a per-opportunity unique
 * constraint. Tracking is now keyed per-post, and the phase-2 record loop is
 * isolated (Promise.allSettled) so one transient failure cannot drop the rest.
 */
describe('EngageService batch reply — per-post tracking', () => {
  const org = { id: 'org-1' } as any;

  let createSentReply: ReturnType<typeof vi.fn>;
  let createPost: ReturnType<typeof vi.fn>;
  let claim: ReturnType<typeof vi.fn>;
  let deletePostById: ReturnType<typeof vi.fn>;
  let releaseClaim: ReturnType<typeof vi.fn>;
  let service: EngageService;

  beforeEach(() => {
    // Simulate the NEW model: tracking is unique by postId. Distinct postIds
    // never collide, so N items → N rows.
    const seenPostIds = new Set<string>();
    createSentReply = vi.fn(async (data: any) => {
      if (seenPostIds.has(data.postId)) {
        throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
      }
      seenPostIds.add(data.postId);
      return { id: `reply-${data.postId}`, ...data };
    });

    let postSeq = 0;
    createPost = vi.fn(async () => [{ postId: `post-${++postSeq}` }]);
    claim = vi.fn(async () => ({
      opp: { externalPostId: 'tweet-original' },
      priorStatus: 'NEW',
    }));
    deletePostById = vi.fn(async () => undefined);
    releaseClaim = vi.fn(async () => undefined);

    const engageRepository = {
      claimOpportunityForReply: claim,
      createSentReply,
      deletePostById,
      releaseOpportunityClaim: releaseClaim,
    } as any;
    const postsService = { createPost } as any;
    // No temporal client → startMetricsSyncForReply is a no-op.
    const temporalService = { client: undefined } as any;
    const overageService = {} as any;

    service = new EngageService(
      engageRepository,
      temporalService,
      postsService,
      overageService,
      {} as any
    );
  });

  const items = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      integrationId: `int-${i}`,
      draftContent: `reply ${i}`,
      strategy: 'expert_answer',
      brandStrength: 1,
      mentions: [],
    }));

  it('batchSendReply records one tracking row per item (3 items → 3 rows)', async () => {
    const results = await service.batchSendReply(org, 'user-1', 'opp-1', {
      items: items(3),
    } as any);

    expect(createPost).toHaveBeenCalledTimes(3);
    expect(createSentReply).toHaveBeenCalledTimes(3);
    expect(results).toHaveLength(3);
    // Every row shares the opportunity but carries a distinct postId.
    const postIds = createSentReply.mock.calls.map((c) => c[0].postId);
    expect(new Set(postIds).size).toBe(3);
    expect(createSentReply.mock.calls.every((c) => c[0].opportunityId === 'opp-1')).toBe(true);
  });

  it('batchScheduleReply records one tracking row per scheduled item', async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const scheduled = items(2).map((it) => ({ ...it, scheduledAt: future }));

    const results = await service.batchScheduleReply(org, 'user-1', 'opp-2', {
      items: scheduled,
    } as any);

    expect(createSentReply).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(2);
  });

  it('isolates a single record failure — the rest are still tracked and returned', async () => {
    // Make the 2nd createSentReply reject; allSettled must keep the other two.
    let call = 0;
    createSentReply.mockImplementation(async (data: any) => {
      call += 1;
      if (call === 2) throw new Error('transient DB error');
      return { id: `reply-${data.postId}`, ...data };
    });

    const results = await service.batchSendReply(org, 'user-1', 'opp-3', {
      items: items(3),
    } as any);

    expect(createSentReply).toHaveBeenCalledTimes(3);
    // 3 live posts, 2 tracked (one transient failure isolated, not swallowed-all).
    expect(results).toHaveLength(2);
  });
});
