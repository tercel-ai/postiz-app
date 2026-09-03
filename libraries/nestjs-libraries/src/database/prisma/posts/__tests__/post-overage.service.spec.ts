import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PostOverageService } from '../post-overage.service';
import { AiseeBusinessType } from '../../ai-pricing/aisee.client';

// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------

function createMocks() {
  return {
    settingsService: {
      get: vi.fn().mockResolvedValue(25),
      set: vi.fn().mockResolvedValue(undefined),
    },
    postsRepository: {
      countPostsFromDay: vi.fn().mockResolvedValue(0),
    },
    aiseeCreditService: {
      deductAndConfirm: vi.fn().mockResolvedValue(undefined),
    },
    usersService: {
      getUserLimits: vi.fn().mockResolvedValue({
        postChannelLimit: 10,
        postSendLimit: 10,
        periodStart: '2026-03-01T00:00:00.000Z',
        periodEnd: '2026-04-01T00:00:00.000Z',
        name: 'Pro',
        interval: 'monthly',
      }),
    },
  };
}

function createService(mocks: ReturnType<typeof createMocks>) {
  return new PostOverageService(
    mocks.settingsService as any,
    mocks.postsRepository as any,
    mocks.aiseeCreditService as any,
    mocks.usersService as any,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PostOverageService', () => {
  let mocks: ReturnType<typeof createMocks>;
  let service: PostOverageService;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks = createMocks();
    service = createService(mocks);
  });

  // -------------------------------------------------------------------------
  // Core scenario: over limit → should deduct
  // -------------------------------------------------------------------------

  it('deducts 25 credits when post count exceeds postSendLimit', async () => {
    // limit=10, count after creation=11
    mocks.usersService.getUserLimits.mockResolvedValue({
      postChannelLimit: 10,
      postSendLimit: 10,
      periodStart: '2026-03-01T00:00:00.000Z',
      periodEnd: '2026-04-01T00:00:00.000Z',
    });
    mocks.postsRepository.countPostsFromDay.mockResolvedValue(11);
    mocks.settingsService.get.mockResolvedValue(25);

    await service.deductIfOverage('org-1', 'user-1', 'post-abc');

    expect(mocks.aiseeCreditService.deductAndConfirm).toHaveBeenCalledTimes(1);
    expect(mocks.aiseeCreditService.deductAndConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'org-1',
        taskId: 'postiz_post_overage_post-abc',
        businessType: AiseeBusinessType.POST_OVERAGE,
        relatedId: 'post-abc',
        costItems: [
          expect.objectContaining({ amount: '25.000000' }),
        ],
      }),
    );
  });

  it('deducts when postSendLimit equals published count (count > limit after new post)', async () => {
    // This is the exact bug scenario: limit=10, already published 10,
    // new post makes count=11 → should deduct
    mocks.usersService.getUserLimits.mockResolvedValue({
      postChannelLimit: 10,
      postSendLimit: 10,
      periodStart: '2026-03-01T00:00:00.000Z',
      periodEnd: '2026-04-01T00:00:00.000Z',
    });
    mocks.postsRepository.countPostsFromDay.mockResolvedValue(11);

    await service.deductIfOverage('org-1', 'user-1', 'post-xyz');

    expect(mocks.aiseeCreditService.deductAndConfirm).toHaveBeenCalledTimes(1);
  });

  it('deducts when already far over limit', async () => {
    // limit=5, count=20
    mocks.usersService.getUserLimits.mockResolvedValue({
      postChannelLimit: 10,
      postSendLimit: 5,
      periodStart: '2026-03-01T00:00:00.000Z',
      periodEnd: '2026-04-01T00:00:00.000Z',
    });
    mocks.postsRepository.countPostsFromDay.mockResolvedValue(20);

    await service.deductIfOverage('org-1', 'user-1', 'post-999');

    expect(mocks.aiseeCreditService.deductAndConfirm).toHaveBeenCalledTimes(1);
    expect(mocks.aiseeCreditService.deductAndConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        description: expect.stringContaining('20/5'),
      }),
    );
  });

  // -------------------------------------------------------------------------
  // No deduction cases
  // -------------------------------------------------------------------------

  it('does NOT deduct when count is within the limit', async () => {
    // limit=10, count=5
    mocks.usersService.getUserLimits.mockResolvedValue({
      postChannelLimit: 10,
      postSendLimit: 10,
      periodStart: '2026-03-01T00:00:00.000Z',
      periodEnd: '2026-04-01T00:00:00.000Z',
    });
    mocks.postsRepository.countPostsFromDay.mockResolvedValue(5);

    await service.deductIfOverage('org-1', 'user-1', 'post-ok');

    expect(mocks.aiseeCreditService.deductAndConfirm).not.toHaveBeenCalled();
  });

  it('does NOT deduct when count exactly equals the limit', async () => {
    // limit=10, count=10 → at the limit, not over it
    mocks.usersService.getUserLimits.mockResolvedValue({
      postChannelLimit: 10,
      postSendLimit: 10,
      periodStart: '2026-03-01T00:00:00.000Z',
      periodEnd: '2026-04-01T00:00:00.000Z',
    });
    mocks.postsRepository.countPostsFromDay.mockResolvedValue(10);

    await service.deductIfOverage('org-1', 'user-1', 'post-boundary');

    expect(mocks.aiseeCreditService.deductAndConfirm).not.toHaveBeenCalled();
  });

  it('does NOT deduct on the no-active-subscription sentinel', async () => {
    mocks.usersService.getUserLimits.mockResolvedValue({
      postChannelLimit: 0,
      postSendLimit: 0,
      noActiveSubscription: true,
    });

    await service.deductIfOverage('org-1', 'user-1', 'post-blocked');

    expect(mocks.postsRepository.countPostsFromDay).not.toHaveBeenCalled();
    expect(mocks.aiseeCreditService.deductAndConfirm).not.toHaveBeenCalled();
  });

  it('does NOT deduct when postSendLimit is null (no limit) on an active plan', async () => {
    mocks.usersService.getUserLimits.mockResolvedValue({
      postChannelLimit: null,
      postSendLimit: null,
      periodStart: '2026-03-01T00:00:00.000Z',
      periodEnd: '2026-04-01T00:00:00.000Z',
    });

    await service.deductIfOverage('org-1', 'user-1', 'post-unlimited');

    expect(mocks.postsRepository.countPostsFromDay).not.toHaveBeenCalled();
    expect(mocks.aiseeCreditService.deductAndConfirm).not.toHaveBeenCalled();
  });

  it('deducts from the FIRST post when postSendLimit is 0 on an active plan (zero free quota)', async () => {
    mocks.usersService.getUserLimits.mockResolvedValue({
      postChannelLimit: 10,
      postSendLimit: 0,
      periodStart: '2026-03-01T00:00:00.000Z',
      periodEnd: '2026-04-01T00:00:00.000Z',
    });
    mocks.postsRepository.countPostsFromDay.mockResolvedValue(1);

    await service.deductIfOverage('org-1', 'user-1', 'post-first');

    expect(mocks.aiseeCreditService.deductAndConfirm).toHaveBeenCalledTimes(1);
    expect(mocks.aiseeCreditService.deductAndConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        description: expect.stringContaining('1/0'),
      }),
    );
  });

  it('does NOT deduct when periodStart is missing', async () => {
    mocks.usersService.getUserLimits.mockResolvedValue({
      postChannelLimit: 10,
      postSendLimit: 10,
      // no periodStart
    });

    await service.deductIfOverage('org-1', 'user-1', 'post-no-period');

    expect(mocks.postsRepository.countPostsFromDay).not.toHaveBeenCalled();
    expect(mocks.aiseeCreditService.deductAndConfirm).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Configurable overage cost
  // -------------------------------------------------------------------------

  it('uses custom overage cost from settings', async () => {
    mocks.settingsService.get.mockResolvedValue(50);
    mocks.usersService.getUserLimits.mockResolvedValue({
      postChannelLimit: 10,
      postSendLimit: 10,
      periodStart: '2026-03-01T00:00:00.000Z',
      periodEnd: '2026-04-01T00:00:00.000Z',
    });
    mocks.postsRepository.countPostsFromDay.mockResolvedValue(11);

    await service.deductIfOverage('org-1', 'user-1', 'post-custom');

    expect(mocks.aiseeCreditService.deductAndConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        costItems: [expect.objectContaining({ amount: '50.000000' })],
      }),
    );
  });

  it('falls back to default 25 when settings returns null', async () => {
    mocks.settingsService.get.mockResolvedValue(null);
    mocks.usersService.getUserLimits.mockResolvedValue({
      postChannelLimit: 10,
      postSendLimit: 10,
      periodStart: '2026-03-01T00:00:00.000Z',
      periodEnd: '2026-04-01T00:00:00.000Z',
    });
    mocks.postsRepository.countPostsFromDay.mockResolvedValue(11);

    await service.deductIfOverage('org-1', 'user-1', 'post-default');

    expect(mocks.aiseeCreditService.deductAndConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        costItems: [expect.objectContaining({ amount: '25.000000' })],
      }),
    );
  });

  // -------------------------------------------------------------------------
  // Source attribution — the data.source field reflects the originating Post.source
  // -------------------------------------------------------------------------

  it('attributes the overage record to source="calendar" by default', async () => {
    mocks.usersService.getUserLimits.mockResolvedValue({
      postChannelLimit: 10,
      postSendLimit: 5,
      periodStart: '2026-03-01T00:00:00.000Z',
      periodEnd: '2026-04-01T00:00:00.000Z',
    });
    mocks.postsRepository.countPostsFromDay.mockResolvedValue(6);

    await service.deductIfOverage('org-1', 'user-1', 'post-cal');

    expect(mocks.aiseeCreditService.deductAndConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ data: { source: 'calendar' } }),
    );
  });

  it('attributes the overage record to source="engage" for Engage replies', async () => {
    mocks.usersService.getUserLimits.mockResolvedValue({
      postChannelLimit: 10,
      postSendLimit: 5,
      periodStart: '2026-03-01T00:00:00.000Z',
      periodEnd: '2026-04-01T00:00:00.000Z',
    });
    mocks.postsRepository.countPostsFromDay.mockResolvedValue(6);

    await service.deductIfOverage('org-1', 'user-1', 'post-eng', 'engage');

    expect(mocks.aiseeCreditService.deductAndConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ data: { source: 'engage' } }),
    );
  });

  // -------------------------------------------------------------------------
  // Idempotency — taskId is deterministic
  // -------------------------------------------------------------------------

  it('generates a deterministic taskId based on postId', async () => {
    mocks.usersService.getUserLimits.mockResolvedValue({
      postChannelLimit: 10,
      postSendLimit: 5,
      periodStart: '2026-03-01T00:00:00.000Z',
      periodEnd: '2026-04-01T00:00:00.000Z',
    });
    mocks.postsRepository.countPostsFromDay.mockResolvedValue(6);

    await service.deductIfOverage('org-1', 'user-1', 'post-idempotent');

    expect(mocks.aiseeCreditService.deductAndConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'postiz_post_overage_post-idempotent',
      }),
    );
  });

  // -------------------------------------------------------------------------
  // Error handling — should not throw
  // -------------------------------------------------------------------------

  it('does not throw when getUserLimits fails', async () => {
    mocks.usersService.getUserLimits.mockRejectedValue(new Error('API down'));

    await expect(
      service.deductIfOverage('org-1', 'user-1', 'post-err')
    ).resolves.toBeUndefined();
  });

  it('does not throw when deductAndConfirm fails', async () => {
    mocks.usersService.getUserLimits.mockResolvedValue({
      postChannelLimit: 10,
      postSendLimit: 5,
      periodStart: '2026-03-01T00:00:00.000Z',
      periodEnd: '2026-04-01T00:00:00.000Z',
    });
    mocks.postsRepository.countPostsFromDay.mockResolvedValue(10);
    mocks.aiseeCreditService.deductAndConfirm.mockRejectedValue(
      new Error('Aisee timeout')
    );

    await expect(
      service.deductIfOverage('org-1', 'user-1', 'post-err2')
    ).resolves.toBeUndefined();
  });
});

describe('PostOverageService.assertDraftQuota', () => {
  // 500 per platform x 8 platforms.
  const ORG_MAX = 40_000;
  const PROJECT_MAX = 4_000;

  function draftBuild(
    counts: { org?: number; project?: number } = {},
    limits?: unknown
  ) {
    const mocks = createMocks();
    mocks.usersService.getUserLimits = vi.fn().mockResolvedValue(
      limits === undefined
        ? { plan: 'growth-loop', postSendLimit: 0, postChannelLimit: null }
        : limits
    );
    (mocks.postsRepository as any).countLiveDrafts = vi.fn(
      async (_org: string, projectId?: string | null) =>
        projectId ? (counts.project ?? 0) : (counts.org ?? 0)
    );
    const postPlanLimits = {
      resolveDraftLimits: vi.fn(async () => ({
        orgMax: ORG_MAX,
        projectMax: PROJECT_MAX,
        platformCount: 8,
      })),
    };
    const service = new PostOverageService(
      mocks.settingsService as any,
      mocks.postsRepository as any,
      mocks.aiseeCreditService as any,
      mocks.usersService as any,
      postPlanLimits as any
    );
    return { service, mocks, postPlanLimits };
  }

  it('admits a batch that fits both caps', async () => {
    const { service } = draftBuild({ org: 10, project: 5 });
    await expect(
      service.assertDraftQuota('org-1', 'user-1', 3, 'proj-1')
    ).resolves.toBeUndefined();
  });

  it('refuses when the batch would cross the ORG cap', async () => {
    // The org cap is what actually bounds an account: growth-loop's project
    // limit in aisee-core is null, so a per-project cap alone is cap x infinity.
    const { service } = draftBuild({ org: ORG_MAX - 1, project: 0 });
    await expect(
      service.assertDraftQuota('org-1', 'user-1', 5, 'proj-1')
    ).rejects.toMatchObject({
      response: { code: 'post_draft_limit_reached', scope: 'organization' },
    });
  });

  it('refuses when the batch would cross the PROJECT cap', async () => {
    const { service } = draftBuild({ org: 10, project: PROJECT_MAX });
    await expect(
      service.assertDraftQuota('org-1', 'user-1', 1, 'proj-1')
    ).rejects.toMatchObject({
      response: { code: 'post_draft_limit_reached', scope: 'project' },
    });
  });

  it('checks only the org cap when no project scopes the call', async () => {
    const { service, mocks } = draftBuild({ org: 10, project: PROJECT_MAX });
    await expect(
      service.assertDraftQuota('org-1', 'user-1', 1)
    ).resolves.toBeUndefined();
    expect((mocks.postsRepository as any).countLiveDrafts).toHaveBeenCalledTimes(1);
  });

  it('counts nothing for an empty batch', async () => {
    const { service, mocks } = draftBuild({ org: ORG_MAX });
    await service.assertDraftQuota('org-1', 'user-1', 0, 'proj-1');
    expect((mocks.postsRepository as any).countLiveDrafts).not.toHaveBeenCalled();
  });

  it('does not gate a plan with no active subscription', async () => {
    // Already refused by the permissions gate — a second, differently-worded
    // refusal here would only obscure the real reason.
    const { service, postPlanLimits } = draftBuild(
      { org: ORG_MAX },
      { postSendLimit: 0, postChannelLimit: 0, noActiveSubscription: true }
    );
    await expect(
      service.assertDraftQuota('org-1', 'user-1', 100, 'proj-1')
    ).resolves.toBeUndefined();
    expect(postPlanLimits.resolveDraftLimits).not.toHaveBeenCalled();
  });

  it('does not gate when billing is off (null limits)', async () => {
    const { service } = draftBuild({ org: ORG_MAX }, null);
    await expect(
      service.assertDraftQuota('org-1', 'user-1', 100, 'proj-1')
    ).resolves.toBeUndefined();
  });

  it('is a no-op when the plan-limits service is not wired', async () => {
    const mocks = createMocks();
    const service = new PostOverageService(
      mocks.settingsService as any,
      mocks.postsRepository as any,
      mocks.aiseeCreditService as any,
      mocks.usersService as any
    );
    await expect(
      service.assertDraftQuota('org-1', 'user-1', 1_000_000, 'proj-1')
    ).resolves.toBeUndefined();
  });
});
