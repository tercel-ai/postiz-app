import { describe, it, expect, vi } from 'vitest';
import {
  PostPlanLimitsService,
  POST_PLAN_LIMITS_KEY,
} from '../post-plan-limits.service';
import { AiseeUserCreditPackage } from '@gitroom/nestjs-libraries/database/prisma/ai-pricing/aisee.client';

function settingsMock(values: Record<string, unknown> = {}) {
  return {
    get: vi.fn(async (key: string) => values[key] ?? null),
    set: vi.fn(async () => undefined),
  } as any;
}

function pkg(overrides: Partial<AiseeUserCreditPackage> = {}): AiseeUserCreditPackage {
  return {
    postSendLimit: 100,
    postChannelLimit: 10,
    interval: 'month',
    periodStart: '2026-06-01T00:00:00.000Z',
    periodEnd: '2026-07-01T00:00:00.000Z',
    name: 'Pro Plan (Monthly)',
    status: 'active',
    ...overrides,
  };
}

describe('PostPlanLimitsService.onModuleInit', () => {
  it('seeds zero free posts (channel deferred to aisee) when the key is missing', async () => {
    const settings = settingsMock();
    await new PostPlanLimitsService(settings).onModuleInit();
    expect(settings.set).toHaveBeenCalledWith(
      POST_PLAN_LIMITS_KEY,
      {
        starter: { postSendLimit: 0, postChannelLimit: null },
        developer: { postSendLimit: 0, postChannelLimit: null },
        pro: { postSendLimit: 0, postChannelLimit: null },
      },
      expect.objectContaining({ type: 'object' })
    );
  });

  it('does not reseed when a value exists', async () => {
    const settings = settingsMock({ [POST_PLAN_LIMITS_KEY]: {} });
    await new PostPlanLimitsService(settings).onModuleInit();
    expect(settings.set).not.toHaveBeenCalled();
  });
});

describe('PostPlanLimitsService.getAll', () => {
  it('absent fields fall back to defaults (send 0 / channel null); explicit null stays null', async () => {
    const service = new PostPlanLimitsService(
      settingsMock({
        [POST_PLAN_LIMITS_KEY]: {
          starter: { postSendLimit: 30 },
          developer: { postSendLimit: null },
        },
      })
    );
    const all = await service.getAll();
    expect(all.starter).toEqual({ postSendLimit: 30, postChannelLimit: null });
    // Explicit null = defer to the aisee package value, NOT the 0 default.
    expect(all.developer).toEqual({
      postSendLimit: null,
      postChannelLimit: null,
    });
    // Entirely unset plan gets the product default: zero free posts.
    expect(all.pro).toEqual({ postSendLimit: 0, postChannelLimit: null });
  });
});

describe('PostPlanLimitsService.getAll — sanitisation', () => {
  it('accepts 0 as a real quota; rejects negatives, non-integers, and strings (become null)', async () => {
    const service = new PostPlanLimitsService(
      settingsMock({
        [POST_PLAN_LIMITS_KEY]: {
          starter: { postSendLimit: 0, postChannelLimit: -5 },
          developer: { postSendLimit: 1.5, postChannelLimit: '50' },
          pro: { postSendLimit: 300, postChannelLimit: null },
        },
      })
    );
    const all = await service.getAll();
    expect(all.starter).toEqual({ postSendLimit: 0, postChannelLimit: null });
    expect(all.developer).toEqual({
      postSendLimit: null,
      postChannelLimit: null,
    });
    expect(all.pro).toEqual({ postSendLimit: 300, postChannelLimit: null });
  });
});

describe('PostPlanLimitsService.applyOverrides', () => {
  it('returns the package unchanged when the Settings read throws', async () => {
    const settings = {
      get: vi.fn(async () => {
        throw new Error('db down');
      }),
      set: vi.fn(async () => undefined),
    } as any;
    const original = pkg();
    const result = await new PostPlanLimitsService(settings).applyOverrides(
      original
    );
    expect(result).toEqual(original);
  });

  it('applies the zero-free-quota default when the plan has no stored entry', async () => {
    const service = new PostPlanLimitsService(
      settingsMock({ [POST_PLAN_LIMITS_KEY]: {} })
    );
    const result = await service.applyOverrides(pkg());
    expect(result.postSendLimit).toBe(0); // default: no free posts
    expect(result.postChannelLimit).toBe(10); // channel deferred to aisee
  });

  it('replaces only configured values; null keeps the aisee number', async () => {
    const service = new PostPlanLimitsService(
      settingsMock({
        [POST_PLAN_LIMITS_KEY]: {
          pro: { postSendLimit: 500, postChannelLimit: null },
        },
      })
    );
    const result = await service.applyOverrides(pkg());
    expect(result.postSendLimit).toBe(500); // overridden
    expect(result.postChannelLimit).toBe(10); // aisee value kept
  });

  it('resolves the plan from the exact `plan` field over the display name', async () => {
    const service = new PostPlanLimitsService(
      settingsMock({
        [POST_PLAN_LIMITS_KEY]: {
          developer: { postSendLimit: 200, postChannelLimit: 20 },
          pro: { postSendLimit: 999, postChannelLimit: 99 },
        },
      })
    );
    const result = await service.applyOverrides(
      pkg({ name: 'Pro Plan (Monthly)', plan: 'developer' })
    );
    expect(result.postSendLimit).toBe(200);
    expect(result.postChannelLimit).toBe(20);
  });

  it('passes an unresolvable plan through unchanged', async () => {
    const service = new PostPlanLimitsService(
      settingsMock({
        [POST_PLAN_LIMITS_KEY]: {
          starter: { postSendLimit: 1, postChannelLimit: 1 },
        },
      })
    );
    const original = pkg({ name: 'Mystery Tier' });
    const result = await service.applyOverrides(original);
    expect(result).toEqual(original);
  });
});
