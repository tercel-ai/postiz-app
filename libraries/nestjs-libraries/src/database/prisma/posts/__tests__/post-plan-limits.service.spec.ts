import { describe, it, expect, vi } from 'vitest';
import {
  PostPlanLimitsService,
  POST_PLAN_LIMITS_KEY,
  DEFAULT_DRAFT_PLATFORM_COUNT,
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
        starter: { postSendLimit: 0, postChannelLimit: null, draftsPerPlatformMax: 5000, draftsPerPlatformPerProjectMax: 500 },
        developer: { postSendLimit: 0, postChannelLimit: null, draftsPerPlatformMax: 5000, draftsPerPlatformPerProjectMax: 500 },
        pro: { postSendLimit: 0, postChannelLimit: null, draftsPerPlatformMax: 5000, draftsPerPlatformPerProjectMax: 500 },
        'growth-loop': { postSendLimit: 0, postChannelLimit: null, draftsPerPlatformMax: 5000, draftsPerPlatformPerProjectMax: 500 },
      },
      expect.objectContaining({ type: 'object' })
    );
  });

  it('does not reseed when every plan is already stored', async () => {
    const settings = settingsMock({
      [POST_PLAN_LIMITS_KEY]: {
        starter: { postSendLimit: 5, postChannelLimit: null, draftsPerPlatformMax: 5000, draftsPerPlatformPerProjectMax: 500 },
        developer: { postSendLimit: 5, postChannelLimit: null, draftsPerPlatformMax: 5000, draftsPerPlatformPerProjectMax: 500 },
        pro: { postSendLimit: 5, postChannelLimit: null, draftsPerPlatformMax: 5000, draftsPerPlatformPerProjectMax: 500 },
        'growth-loop': { postSendLimit: 5, postChannelLimit: null, draftsPerPlatformMax: 5000, draftsPerPlatformPerProjectMax: 500 },
      },
    });
    await new PostPlanLimitsService(settings).onModuleInit();
    expect(settings.set).not.toHaveBeenCalled();
  });

  it('backfills a plan the stored row predates, leaving tuned plans intact', async () => {
    // The production row was written before 'growth-loop' was a plan code, and
    // the admin settings UI renders the STORED object — so the only tier still
    // being sold was missing from the page every admin tunes.
    const settings = settingsMock({
      [POST_PLAN_LIMITS_KEY]: {
        starter: { postSendLimit: 7, postChannelLimit: 3 },
        developer: { postSendLimit: 0, postChannelLimit: null },
        pro: { postSendLimit: 0, postChannelLimit: null },
      },
    });
    await new PostPlanLimitsService(settings).onModuleInit();
    const written = settings.set.mock.calls[0][1] as Record<string, unknown>;
    expect(written['growth-loop']).toEqual({
      postSendLimit: 0,
      postChannelLimit: null,
      draftsPerPlatformMax: 5000, draftsPerPlatformPerProjectMax: 500,
    });
    // An admin's tuning outranks a default and must survive verbatim — the
    // fields it did not set are filled in around it.
    expect(written.starter).toEqual({
      postSendLimit: 7,
      postChannelLimit: 3,
      draftsPerPlatformMax: 5000,
      draftsPerPlatformPerProjectMax: 500,
    });
  });

  it('backfills a FIELD the stored plan predates, not just a whole plan', async () => {
    // The draft caps were added to PostPlanLimits after this row was written.
    // Plan-level backfill alone could never reach them, so the knob stayed
    // invisible in the admin UI even though the runtime enforced it.
    const settings = settingsMock({
      [POST_PLAN_LIMITS_KEY]: {
        starter: { postSendLimit: 7, postChannelLimit: 3 },
        developer: { postSendLimit: 0, postChannelLimit: null },
        pro: { postSendLimit: 0, postChannelLimit: null },
        'growth-loop': { postSendLimit: 0, postChannelLimit: null },
      },
    });
    await new PostPlanLimitsService(settings).onModuleInit();
    const written = settings.set.mock.calls[0][1] as Record<string, any>;
    expect(written['growth-loop'].draftsPerPlatformPerProjectMax).toBe(500);
    expect(written.starter.draftsPerPlatformMax).toBe(5000);
    expect(written.starter.postSendLimit).toBe(7); // tuning survives
  });

  it('treats an explicit null as a real value, not a missing field', async () => {
    // null means "no limit" — backfilling over it would silently impose one.
    const complete: Record<string, number | null> = {
      postSendLimit: 0,
      postChannelLimit: null,
      draftsPerPlatformMax: 5000,
      draftsPerPlatformPerProjectMax: 500,
    };
    const settings = settingsMock({
      [POST_PLAN_LIMITS_KEY]: {
        starter: {
          postSendLimit: null,
          postChannelLimit: null,
          draftsPerPlatformMax: null,
          draftsPerPlatformPerProjectMax: null,
        },
        developer: complete,
        pro: complete,
        'growth-loop': complete,
      },
    });
    await new PostPlanLimitsService(settings).onModuleInit();
    expect(settings.set).not.toHaveBeenCalled();
  });

  it('leaves a non-object stored value alone rather than overwriting it', async () => {
    const settings = settingsMock({ [POST_PLAN_LIMITS_KEY]: 'corrupted' });
    await new PostPlanLimitsService(settings).onModuleInit();
    expect(settings.set).not.toHaveBeenCalled();
  });
});

describe('PostPlanLimitsService.getAll', () => {
  it('absent fields fall back to defaults (send 0 / channel null); explicit null = no limit', async () => {
    const service = new PostPlanLimitsService(
      settingsMock({
        [POST_PLAN_LIMITS_KEY]: {
          starter: { postSendLimit: 30 },
          developer: { postSendLimit: null },
        },
      })
    );
    const all = await service.getAll();
    expect(all.starter).toMatchObject({ postSendLimit: 30, postChannelLimit: null });
    // Explicit null = unlimited free posts.
    expect(all.developer).toMatchObject({
      postSendLimit: null,
      postChannelLimit: null,
    });
    // Entirely unset plan gets the product default: zero free posts,
    // unlimited channels.
    expect(all.pro).toMatchObject({ postSendLimit: 0, postChannelLimit: null });
  });
});

describe('PostPlanLimitsService.getAll — sanitisation', () => {
  it('accepts 0 as a real quota; junk falls back to the field DEFAULT, never to null', async () => {
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
    // Junk channel (-5, '50') → channel default null; junk send (1.5) → send
    // default 0 — a typo must not silently grant an unlimited send quota.
    expect(all.starter).toMatchObject({ postSendLimit: 0, postChannelLimit: null });
    expect(all.developer).toMatchObject({ postSendLimit: 0,
      postChannelLimit: null,
    });
    expect(all.pro).toMatchObject({ postSendLimit: 300, postChannelLimit: null });
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

  it('applies the defaults when the plan has no stored entry (send 0, channel unlimited)', async () => {
    const service = new PostPlanLimitsService(
      settingsMock({ [POST_PLAN_LIMITS_KEY]: {} })
    );
    const result = await service.applyOverrides(pkg());
    expect(result.postSendLimit).toBe(0); // default: no free posts
    expect(result.postChannelLimit).toBeNull(); // default: no channel limit
  });

  it('REPLACES the aisee numbers once the plan resolves; null = no limit', async () => {
    const service = new PostPlanLimitsService(
      settingsMock({
        [POST_PLAN_LIMITS_KEY]: {
          pro: { postSendLimit: 500, postChannelLimit: null },
        },
      })
    );
    const result = await service.applyOverrides(pkg());
    expect(result.postSendLimit).toBe(500);
    // aisee's postChannelLimit=10 is superseded by the configured "no limit".
    expect(result.postChannelLimit).toBeNull();
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

describe('PostPlanLimitsService.resolveDraftLimits', () => {
  const ALLOWLIST_KEY = 'operation_plan.allowed_platforms';
  // The production allowlist: linkedin-page counts as its own platform, which
  // the product accepted rather than special-casing a merge with linkedin.
  const PROD_ALLOWLIST = [
    'x', 'linkedin', 'reddit', 'linkedin-page',
    'medium', 'devto', 'hackernews', 'quora',
  ];

  it('multiplies the per-platform caps by the POST-domain allowlist', async () => {
    const service = new PostPlanLimitsService(
      settingsMock({ [ALLOWLIST_KEY]: PROD_ALLOWLIST })
    );
    expect(await service.resolveDraftLimits('growth-loop')).toEqual({
      orgMax: 5000 * 8,
      projectMax: 500 * 8,
      platformCount: 8,
    });
  });

  it('follows the allowlist rather than a frozen number', async () => {
    // Widening the allowlist must widen the budget, not squeeze every existing
    // platform's share of a fixed total.
    const service = new PostPlanLimitsService(
      settingsMock({ [ALLOWLIST_KEY]: ['x', 'reddit'] })
    );
    const limits = await service.resolveDraftLimits('growth-loop');
    expect(limits.platformCount).toBe(2);
    expect(limits.projectMax).toBe(1000);
  });

  it('treats an empty allowlist as the default count, never as zero platforms', async () => {
    // Empty means "no extra restriction" for the allowlist itself; reading it as
    // zero platforms would collapse the cap and refuse every draft.
    const service = new PostPlanLimitsService(settingsMock({ [ALLOWLIST_KEY]: [] }));
    const limits = await service.resolveDraftLimits('growth-loop');
    expect(limits.platformCount).toBe(DEFAULT_DRAFT_PLATFORM_COUNT);
    expect(limits.projectMax).toBe(500 * DEFAULT_DRAFT_PLATFORM_COUNT);
  });

  it('dedupes a repeated platform', async () => {
    const service = new PostPlanLimitsService(
      settingsMock({ [ALLOWLIST_KEY]: ['x', 'X', ' x ', 'reddit'] })
    );
    expect((await service.resolveDraftLimits('pro')).platformCount).toBe(2);
  });

  it('keeps null (unlimited) unlimited through the multiplication', async () => {
    const service = new PostPlanLimitsService(
      settingsMock({
        [ALLOWLIST_KEY]: PROD_ALLOWLIST,
        [POST_PLAN_LIMITS_KEY]: {
          'growth-loop': { draftsPerPlatformMax: null, draftsPerPlatformPerProjectMax: null },
        },
      })
    );
    expect(await service.resolveDraftLimits('growth-loop')).toMatchObject({
      orgMax: null,
      projectMax: null,
    });
  });

  it('enforces nothing when no plan code resolves', async () => {
    const service = new PostPlanLimitsService(settingsMock({}));
    expect(await service.resolveDraftLimits(null)).toMatchObject({
      orgMax: null,
      projectMax: null,
    });
  });
});
