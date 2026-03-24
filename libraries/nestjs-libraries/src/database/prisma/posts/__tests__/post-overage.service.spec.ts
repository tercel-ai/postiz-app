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

  it('does NOT deduct when postSendLimit is 0 (no subscription)', async () => {
    mocks.usersService.getUserLimits.mockResolvedValue({
      postChannelLimit: 0,
      postSendLimit: 0,
    });

    await service.deductIfOverage('org-1', 'user-1', 'post-blocked');

    expect(mocks.postsRepository.countPostsFromDay).not.toHaveBeenCalled();
    expect(mocks.aiseeCreditService.deductAndConfirm).not.toHaveBeenCalled();
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
