import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import {
  EngageEntitlementService,
  ENGAGE_ENTITLEMENTS_KEY,
  ENGAGE_REPLY_CREDITS_KEY,
} from '../engage-entitlement.service';

// ── Mock builders ─────────────────────────────────────────────────────────────
function settingsMock(values: Record<string, unknown> = {}) {
  return {
    get: vi.fn(async (key: string) => values[key] ?? null),
    set: vi.fn(async () => undefined),
  } as any;
}

function usersMock(limits: unknown) {
  return { getUserLimits: vi.fn(async () => limits) } as any;
}

function aiseeMock(opts: { balance?: number | null } = {}) {
  return {
    resolveOwnerUserId: vi.fn(async (orgId: string) => `user_${orgId}`),
    getBalance: vi.fn(async () =>
      opts.balance === undefined ? { total: 1_000_000 } : opts.balance === null ? null : { total: opts.balance }
    ),
    deductReserved: vi.fn(async () => ({ success: true })),
  } as any;
}

const CONFIG_ID = 'cfg1';

// `count` answers the org-wide query (`where.organizationId`); `projectCount`
// answers the per-project one (`where.configId`), defaulting to the same number
// so single-scope tests need not care. When the query carries a
// `where.platform` (per-platform priority-accounts pool) and `byPlatform` is
// provided, that map wins — unknown platforms count 0.
function repoMock(
  name: string,
  count = 0,
  projectCount?: number,
  enabled: boolean | null = false,
  byPlatform?: Record<string, number>
) {
  return {
    model: {
      [name]: {
        count: vi.fn(async (args: any = {}) => {
          const platform = args?.where?.platform;
          if (platform !== undefined && byPlatform) {
            return byPlatform[platform] ?? 0;
          }
          return args?.where?.configId !== undefined
            ? projectCount ?? count
            : count;
        }),
        findFirst: vi.fn(async () =>
          enabled === null
            ? null
            : { enabled, configId: CONFIG_ID, platform: 'x' }
        ),
      },
    },
  } as any;
}

function build(opts: {
  settings?: Record<string, unknown>;
  limits?: unknown;
  balance?: number | null;
  keywordCount?: number;
  trackedCount?: number;
  channelCount?: number;
  keywordProjectCount?: number;
  trackedProjectCount?: number;
  channelProjectCount?: number;
  /** Org-wide enabled counts per platform (used when the query filters one). */
  trackedByPlatform?: Record<string, number>;
  channelByPlatform?: Record<string, number>;
  /** enabled flag the `findFirst` row reports; null = row not found. */
  rowEnabled?: boolean | null;
  billingCount?: number;
  orgData?: Record<string, unknown> | null;
}) {
  const billingRecord = {
    count: vi.fn(async () => opts.billingCount ?? 0),
    create: vi.fn(async ({ data }: any) => data),
    update: vi.fn(async () => ({})),
  };
  const billing = { model: { billingRecord } } as any;
  const organizationModel = {
    findUnique: vi.fn(async () => ({
      data: opts.orgData === undefined ? null : opts.orgData,
    })),
    update: vi.fn(async ({ data }: any) => data),
  };
  const organization = { model: { organization: organizationModel } } as any;
  // PrismaTransaction mock: run the interactive callback with a tx exposing the
  // same billingRecord mock (count + create), mirroring the real Prisma client.
  const tx = {
    model: { $transaction: vi.fn(async (fn: any) => fn({ billingRecord })) },
  } as any;
  const aisee = aiseeMock({ balance: opts.balance });
  return {
    aisee,
    billing,
    billingRecord,
    organizationModel,
    service: new EngageEntitlementService(
      settingsMock(opts.settings),
      usersMock(opts.limits),
      aisee,
      repoMock(
        'engageKeyword',
        opts.keywordCount ?? 0,
        opts.keywordProjectCount,
        opts.rowEnabled === undefined ? false : opts.rowEnabled
      ),
      repoMock(
        'engageTrackedAccount',
        opts.trackedCount ?? 0,
        opts.trackedProjectCount,
        opts.rowEnabled === undefined ? false : opts.rowEnabled,
        opts.trackedByPlatform
      ),
      repoMock(
        'engageMonitoredChannel',
        opts.channelCount ?? 0,
        opts.channelProjectCount,
        opts.rowEnabled === undefined ? false : opts.rowEnabled,
        opts.channelByPlatform
      ),
      billing,
      organization,
      tx
    ),
  };
}

const PRO_LIMITS = {
  name: 'Pro Plan (Monthly)',
  periodStart: '2026-06-01T00:00:00.000Z',
  postChannelLimit: 30,
  postSendLimit: 9999,
  periodEnd: '2026-07-01T00:00:00.000Z',
  interval: 'month',
};
const STARTER_LIMITS = { ...PRO_LIMITS, name: 'Starter Plan' };
const DEV_LIMITS = { ...PRO_LIMITS, name: 'Developer Plan' };

describe('EngageEntitlementService.normalizePlanName', () => {
  it('maps display names to plan codes', () => {
    expect(EngageEntitlementService.normalizePlanName('Starter Plan')).toBe('starter');
    expect(EngageEntitlementService.normalizePlanName('Developer Plan (Monthly)')).toBe('developer');
    expect(EngageEntitlementService.normalizePlanName('Pro')).toBe('pro');
    // "Developer" wins over the "pro"/"starter" substrings if both appear.
    expect(EngageEntitlementService.normalizePlanName('developer pro')).toBe('developer');
    expect(EngageEntitlementService.normalizePlanName('Ultimate')).toBeNull();
    expect(EngageEntitlementService.normalizePlanName(null)).toBeNull();
  });
});

describe('EngageEntitlementService.getReplyCost', () => {
  it('prices Short/Medium/Long as round(base × multiplier) = 2/3/5', async () => {
    const { service } = build({ limits: STARTER_LIMITS });
    expect(await service.getReplyCost('short')).toBe(2);
    expect(await service.getReplyCost('medium')).toBe(3);
    expect(await service.getReplyCost('long')).toBe(5);
  });

  it('honours admin overrides from the settings store', async () => {
    const { service } = build({
      limits: STARTER_LIMITS,
      settings: {
        [ENGAGE_REPLY_CREDITS_KEY]: { base: 4, multipliers: { short: 1, medium: 2, long: 3 } },
      },
    });
    expect(await service.getReplyCost('short')).toBe(4);
    expect(await service.getReplyCost('long')).toBe(12);
  });
});

describe('EngageEntitlementService.getEntitlement', () => {
  it('returns unlimited when billing is disabled (getUserLimits null)', async () => {
    const { service } = build({ limits: null });
    const ent = await service.getEntitlement('org1');
    expect(ent.keywordsMax).toBeNull();
    expect(ent.priorityAccountsMax).toBeNull();
    expect(ent.replyMonthlyCap).toBeNull();
  });

  it('resolves Pro limits from the plan name', async () => {
    const { service } = build({ limits: PRO_LIMITS });
    const ent = await service.getEntitlement('org1');
    expect(ent.keywordsMax).toBe(300);
    expect(ent.priorityAccountsMax).toBeNull(); // unlimited
    expect(ent.keywordsPerProjectMax).toBe(30);
    expect(ent.scanIntervalHours).toBe(6);
  });

  it('falls back to starter limits for an unrecognised plan name', async () => {
    const { service } = build({ limits: { ...PRO_LIMITS, name: 'Mystery Tier' } });
    const ent = await service.getEntitlement('org1');
    expect(ent.keywordsMax).toBe(30);
    expect(ent.keywordsPerProjectMax).toBe(5);
    expect(ent.scanIntervalHours).toBe(24);
  });

  it('prefers the exact aisee-derived plan code over the display name when both are present', async () => {
    // A misleading/unparseable `name` must not matter when `plan` is exact.
    const { service } = build({ limits: { ...PRO_LIMITS, name: 'Something Unrelated', plan: 'developer' } });
    const ent = await service.getEntitlement('org1');
    expect(ent.keywordsMax).toBe(100);
    expect(ent.scanIntervalHours).toBe(24);
  });

  it('ignores an unrecognised `plan` value and falls back to the display name', async () => {
    const { service } = build({ limits: { ...PRO_LIMITS, name: 'Pro Plan (Monthly)', plan: 'enterprise' } });
    const ent = await service.getEntitlement('org1');
    expect(ent.keywordsMax).toBe(300);
  });
});

describe('EngageEntitlementService.getPublicPlanCatalog', () => {
  it('returns all three tiers with default limits and reply credits, no org resolution', async () => {
    const { service, aisee } = build({ limits: PRO_LIMITS });
    const catalog = await service.getPublicPlanCatalog();

    expect(catalog.plans.map((p) => p.code)).toEqual([
      'starter',
      'developer',
      'pro',
    ]);
    const byCode = Object.fromEntries(
      catalog.plans.map((p) => [p.code, p.limits])
    );
    expect(byCode.starter.keywordsMax).toBe(30);
    expect(byCode.starter.replyMonthlyCap).toBe(10);
    expect(byCode.developer.priorityAccountsMax).toBe(60);
    expect(byCode.pro.priorityAccountsMax).toBeNull(); // unlimited
    expect(byCode.pro.scanIntervalHours).toBe(6);
    expect(catalog.replyCredits).toEqual({ short: 2, medium: 3, long: 5 });

    // Public catalog must not touch org/billing state.
    expect(aisee.resolveOwnerUserId).not.toHaveBeenCalled();
  });

  it('applies admin overrides from Settings per plan', async () => {
    const { service } = build({
      limits: PRO_LIMITS,
      settings: {
        [ENGAGE_ENTITLEMENTS_KEY]: { starter: { keywordsMax: 3 } },
      },
    });
    const catalog = await service.getPublicPlanCatalog();
    const starter = catalog.plans.find((p) => p.code === 'starter')!.limits;
    expect(starter.keywordsMax).toBe(3); // overridden
    expect(starter.priorityAccountsMax).toBe(10); // untouched default survives
  });

  it('folds a legacy stored override (subreddits caps) into the shared priority-accounts cap', async () => {
    // A settings row persisted before the caps merged: subredditsMax still
    // present, priorityAccountsMax still excluding channels. The effective cap
    // must be their sum — same capacity as before, channels not blocked.
    const { service } = build({
      limits: PRO_LIMITS,
      settings: {
        [ENGAGE_ENTITLEMENTS_KEY]: {
          starter: {
            priorityAccountsMax: 0,
            subredditsMax: 10,
            priorityAccountsPerProjectMax: 2,
            subredditsPerProjectMax: 2,
          },
          pro: { priorityAccountsMax: 5, subredditsMax: null },
        },
      },
    });
    const catalog = await service.getPublicPlanCatalog();
    const byCode = Object.fromEntries(
      catalog.plans.map((p) => [p.code, p.limits])
    );
    expect(byCode.starter.priorityAccountsMax).toBe(10); // 0 + 10
    expect(byCode.starter.priorityAccountsPerProjectMax).toBe(4); // 2 + 2
    expect(byCode.pro.priorityAccountsMax).toBeNull(); // null (unlimited) wins
    // The removed keys never leak into the merged result.
    expect(byCode.starter).not.toHaveProperty('subredditsMax');
    expect(byCode.starter).not.toHaveProperty('subredditsPerProjectMax');
  });
});

describe('EngageEntitlementService.getMetricsWindowDays', () => {
  it('returns the per-plan ceiling when no user override is set: starter 7 / developer 14 / pro 30', async () => {
    expect(await build({ limits: STARTER_LIMITS }).service.getMetricsWindowDays('o')).toBe(7);
    expect(await build({ limits: DEV_LIMITS }).service.getMetricsWindowDays('o')).toBe(14);
    expect(await build({ limits: PRO_LIMITS }).service.getMetricsWindowDays('o')).toBe(30);
  });

  it('falls back to the generous default (30) when billing is disabled', async () => {
    expect(await build({ limits: null }).service.getMetricsWindowDays('o')).toBe(30);
  });

  it('honours an admin plan-ceiling override from the settings store', async () => {
    const { service } = build({
      limits: PRO_LIMITS,
      settings: { [ENGAGE_ENTITLEMENTS_KEY]: { pro: { metricsWindowDaysMax: 60 } } },
    });
    expect(await service.getMetricsWindowDays('o')).toBe(60);
  });

  it('applies a user override below the plan ceiling verbatim', async () => {
    // Pro ceiling 30, user wants 10 → 10
    const { service } = build({ limits: PRO_LIMITS, orgData: { metricsWindowDays: 10 } });
    expect(await service.getMetricsWindowDays('o')).toBe(10);
  });

  it('clamps a user override above the plan ceiling at read time', async () => {
    // Starter ceiling 7, user set 30 → clamped to 7 (no rewrite needed on downgrade)
    const { service } = build({ limits: STARTER_LIMITS, orgData: { metricsWindowDays: 30 } });
    const setting = await service.getMetricsWindowSetting('o');
    expect(setting).toEqual({ effective: 7, max: 7, override: 30 });
  });

  it('ignores a non-positive / non-integer stored override', async () => {
    const { service } = build({ limits: DEV_LIMITS, orgData: { metricsWindowDays: 0 } });
    expect(await service.getMetricsWindowDays('o')).toBe(14);
  });
});

describe('EngageEntitlementService.getMetricsFetchIntervalHours', () => {
  it('returns the per-plan cadence: starter 24 / developer 12 / pro 6', async () => {
    expect(await build({ limits: STARTER_LIMITS }).service.getMetricsFetchIntervalHours('o')).toBe(24);
    expect(await build({ limits: DEV_LIMITS }).service.getMetricsFetchIntervalHours('o')).toBe(12);
    expect(await build({ limits: PRO_LIMITS }).service.getMetricsFetchIntervalHours('o')).toBe(6);
  });

  it('falls back to the generous default (6h) when billing is disabled', async () => {
    expect(await build({ limits: null }).service.getMetricsFetchIntervalHours('o')).toBe(6);
  });

  it('honours an admin override from the settings store', async () => {
    const { service } = build({
      limits: STARTER_LIMITS,
      settings: { [ENGAGE_ENTITLEMENTS_KEY]: { starter: { metricsFetchIntervalHours: 48 } } },
    });
    expect(await service.getMetricsFetchIntervalHours('o')).toBe(48);
  });
});

describe('EngageEntitlementService.setMetricsWindowOverride', () => {
  it('persists the raw value into Organization.data (merging, not clobbering)', async () => {
    const { service, organizationModel } = build({
      limits: PRO_LIMITS,
      orgData: { somethingElse: true },
    });
    const res = await service.setMetricsWindowOverride('o', 20);
    expect(organizationModel.update).toHaveBeenCalledWith({
      where: { id: 'o' },
      data: { data: { somethingElse: true, metricsWindowDays: 20 } },
    });
    // findUnique mock still returns the old orgData, so effective reflects the
    // stored (pre-update) override here — the merge assertion above is the point.
    expect(res.max).toBe(30);
  });

  it('rejects a zero / negative / fractional window', async () => {
    const { service } = build({ limits: PRO_LIMITS });
    await expect(service.setMetricsWindowOverride('o', 0)).rejects.toMatchObject({
      response: { code: 'engage_invalid_metrics_window' },
    });
    await expect(service.setMetricsWindowOverride('o', -5)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.setMetricsWindowOverride('o', 1.5)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('EngageEntitlementService.getScanIntervalHours', () => {
  it('returns 6h for Pro and 24h for Starter/Developer', async () => {
    expect(await build({ limits: PRO_LIMITS }).service.getScanIntervalHours('o')).toBe(6);
    expect(await build({ limits: STARTER_LIMITS }).service.getScanIntervalHours('o')).toBe(24);
    expect(await build({ limits: DEV_LIMITS }).service.getScanIntervalHours('o')).toBe(24);
  });

  it('defaults to 24h when billing is disabled', async () => {
    expect(await build({ limits: null }).service.getScanIntervalHours('o')).toBe(24);
  });
});

describe('EngageEntitlementService.assertCanActivate', () => {
  it('throws when adding would exceed the keyword cap', async () => {
    const { service } = build({ limits: STARTER_LIMITS, keywordCount: 30 });
    await expect(service.assertCanActivate('org1', 'keyword', 1)).rejects.toBeInstanceOf(
      ForbiddenException
    );
  });

  it('allows activation under the cap', async () => {
    const { service } = build({ limits: STARTER_LIMITS, keywordCount: 2 });
    await expect(service.assertCanActivate('org1', 'keyword', 1)).resolves.toBeUndefined();
  });

  it('charges tracked accounts AND monitored channels against ONE per-platform pool', async () => {
    // Starter's priorityAccountsMax is 10 PER PLATFORM: on X, 4 tracked + 6
    // channels fill it, so adding EITHER type on X is rejected even though
    // neither table alone reaches 10.
    const { service } = build({
      limits: STARTER_LIMITS,
      trackedByPlatform: { x: 4 },
      channelByPlatform: { x: 6 },
    });
    await expect(
      service.assertCanActivate('org1', 'tracked', 1, undefined, 'x')
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.assertCanActivate('org1', 'subreddit', 1, undefined, 'x')
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('leaves other platforms unaffected when one platform is full', async () => {
    // X is at 10/10 but Reddit only holds 2 — Reddit adds still go through,
    // and the X rejection payload names the platform.
    const { service } = build({
      limits: STARTER_LIMITS,
      trackedByPlatform: { x: 4 },
      channelByPlatform: { x: 6, reddit: 2 },
    });
    await expect(
      service.assertCanActivate('org1', 'subreddit', 1, undefined, 'reddit')
    ).resolves.toBeUndefined();
    const err = await service
      .assertCanActivate('org1', 'tracked', 1, undefined, 'x')
      .catch((e) => e);
    expect((err as ForbiddenException).getResponse()).toMatchObject({
      code: 'engage_limit_reached',
      platform: 'x',
      max: 10,
      current: 10,
    });
  });

  it('allows either type while the platform pool has room', async () => {
    const { service } = build({
      limits: STARTER_LIMITS,
      trackedByPlatform: { x: 4 },
      channelByPlatform: { x: 5 }, // combined 9/10 on X
    });
    await expect(
      service.assertCanActivate('org1', 'tracked', 1, undefined, 'x')
    ).resolves.toBeUndefined();
    await expect(
      service.assertCanActivate('org1', 'subreddit', 1, undefined, 'x')
    ).resolves.toBeUndefined();
  });

  it('falls back to counting ALL platforms when no platform is given (fail-closed)', async () => {
    const { service } = build({
      limits: STARTER_LIMITS,
      trackedCount: 4,
      channelCount: 6, // global 10/10, no single platform necessarily full
    });
    await expect(service.assertCanActivate('org1', 'tracked', 1)).rejects.toBeInstanceOf(
      ForbiddenException
    );
  });

  it('is a no-op when the cap is unlimited (null)', async () => {
    const { service } = build({ limits: PRO_LIMITS, trackedCount: 999, channelCount: 999 });
    await expect(service.assertCanActivate('org1', 'tracked', 1)).resolves.toBeUndefined();
    await expect(service.assertCanActivate('org1', 'subreddit', 1)).resolves.toBeUndefined();
  });

  it('rejects a bulk add that overruns the cap', async () => {
    const { service } = build({ limits: DEV_LIMITS, keywordCount: 98 });
    await expect(service.assertCanActivate('org1', 'keyword', 5)).rejects.toBeInstanceOf(
      ForbiddenException
    );
  });
});

// ── Dual limits: org-wide cap AND per-project cap ────────────────────────────
describe('EngageEntitlementService.assertCanActivate — per-project cap', () => {
  // Deliberately loose org caps so the per-project cap is what binds; both are
  // overridden through the same Settings key an admin would use.
  const DUAL_CAPS = {
    [ENGAGE_ENTITLEMENTS_KEY]: {
      pro: {
        keywordsMax: 100,
        keywordsPerProjectMax: 5,
        priorityAccountsMax: 100,
        priorityAccountsPerProjectMax: 3,
      },
    },
  };

  const payload = (err: unknown) =>
    (err as ForbiddenException).getResponse() as Record<string, unknown>;

  it('blocks when the project is full even though the org has room', async () => {
    const { service } = build({
      limits: PRO_LIMITS,
      settings: DUAL_CAPS,
      keywordCount: 40, // org: 40/100, plenty of room
      keywordProjectCount: 5, // project: 5/5, full
    });
    await expect(
      service.assertCanActivate('org1', 'keyword', 1, CONFIG_ID)
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('reports scope="project" with the project cap and count', async () => {
    const { service } = build({
      limits: PRO_LIMITS,
      settings: DUAL_CAPS,
      keywordCount: 40,
      keywordProjectCount: 5,
    });
    const err = await service
      .assertCanActivate('org1', 'keyword', 1, CONFIG_ID)
      .catch((e) => e);
    expect(payload(err)).toMatchObject({
      code: 'engage_limit_reached',
      limit: 'keyword',
      scope: 'project',
      max: 5,
      current: 5,
    });
  });

  it('reports scope="organization" when the org cap binds first', async () => {
    const { service } = build({
      limits: PRO_LIMITS,
      settings: DUAL_CAPS,
      keywordCount: 100, // org full
      keywordProjectCount: 0, // project empty
    });
    const err = await service
      .assertCanActivate('org1', 'keyword', 1, CONFIG_ID)
      .catch((e) => e);
    expect(payload(err)).toMatchObject({ scope: 'organization', max: 100 });
  });

  it('allows an add that fits under BOTH caps', async () => {
    const { service } = build({
      limits: PRO_LIMITS,
      settings: DUAL_CAPS,
      keywordCount: 40,
      keywordProjectCount: 4,
    });
    await expect(
      service.assertCanActivate('org1', 'keyword', 1, CONFIG_ID)
    ).resolves.toBeUndefined();
  });

  it('skips the project check when no configId is passed', async () => {
    const { service } = build({
      limits: PRO_LIMITS,
      settings: DUAL_CAPS,
      keywordCount: 40,
      keywordProjectCount: 99, // way over the project cap, but unscoped
    });
    await expect(service.assertCanActivate('org1', 'keyword', 1)).resolves.toBeUndefined();
  });

  it('is a no-op when the per-project cap is null (unlimited)', async () => {
    const { service } = build({
      limits: PRO_LIMITS,
      settings: {
        [ENGAGE_ENTITLEMENTS_KEY]: {
          pro: { keywordsMax: 100, keywordsPerProjectMax: null },
        },
      },
      keywordCount: 40,
      keywordProjectCount: 999,
    });
    await expect(
      service.assertCanActivate('org1', 'keyword', 1, CONFIG_ID)
    ).resolves.toBeUndefined();
  });

  it('rejects a bulk add that overruns only the project cap', async () => {
    const { service } = build({
      limits: PRO_LIMITS,
      settings: DUAL_CAPS,
      keywordCount: 10,
      keywordProjectCount: 3,
    });
    await expect(
      service.assertCanActivate('org1', 'keyword', 3, CONFIG_ID)
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('applies the shared per-project pool to subreddits and tracked accounts too', async () => {
    // priorityAccountsPerProjectMax = 3 is one pool per platform: within this
    // project, 2 channels + 1 tracked on the platform fill it, blocking BOTH
    // types even though neither alone reaches 3.
    const { service } = build({
      limits: PRO_LIMITS,
      settings: DUAL_CAPS,
      channelCount: 2,
      channelProjectCount: 2,
      trackedCount: 1,
      trackedProjectCount: 1,
    });
    await expect(
      service.assertCanActivate('org1', 'subreddit', 1, CONFIG_ID, 'reddit')
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.assertCanActivate('org1', 'tracked', 1, CONFIG_ID, 'reddit')
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('defaults the per-project caps in when a stored override omits them', async () => {
    // A settings row seeded before per-project caps existed: the per-plan merge
    // must still supply them rather than leaving them undefined (= no cap).
    const { service } = build({
      limits: PRO_LIMITS,
      settings: { [ENGAGE_ENTITLEMENTS_KEY]: { pro: { keywordsMax: 100 } } },
      keywordCount: 40,
      keywordProjectCount: 30, // pro default keywordsPerProjectMax = 30
    });
    expect((await service.getEntitlement('org1')).keywordsPerProjectMax).toBe(30);
    await expect(
      service.assertCanActivate('org1', 'keyword', 1, CONFIG_ID)
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('EngageEntitlementService.assertCanEnable', () => {
  const DUAL_CAPS = {
    [ENGAGE_ENTITLEMENTS_KEY]: {
      pro: { keywordsMax: 100, keywordsPerProjectMax: 5 },
    },
  };

  it('enforces the project cap of the config the row belongs to', async () => {
    const { service } = build({
      limits: PRO_LIMITS,
      settings: DUAL_CAPS,
      rowEnabled: false, // disabled → enabling it consumes a slot
      keywordCount: 10,
      keywordProjectCount: 5, // that project is full
    });
    await expect(service.assertCanEnable('org1', 'keyword', 'kw1')).rejects.toBeInstanceOf(
      ForbiddenException
    );
  });

  it('is a no-op for an already-enabled row (never double-charges)', async () => {
    const { service } = build({
      limits: PRO_LIMITS,
      settings: DUAL_CAPS,
      rowEnabled: true,
      keywordCount: 10,
      keywordProjectCount: 5,
    });
    await expect(service.assertCanEnable('org1', 'keyword', 'kw1')).resolves.toBeUndefined();
  });

  it('is a no-op for an unknown id', async () => {
    const { service } = build({
      limits: PRO_LIMITS,
      settings: DUAL_CAPS,
      rowEnabled: null,
      keywordCount: 10,
      keywordProjectCount: 5,
    });
    await expect(service.assertCanEnable('org1', 'keyword', 'nope')).resolves.toBeUndefined();
  });
});

describe('EngageEntitlementService.reserveReplyGeneration', () => {
  it('hard-blocks Starter at the monthly cap even with credits — and writes no reservation', async () => {
    const { service, billingRecord } = build({ limits: STARTER_LIMITS, balance: 1_000_000, billingCount: 10 });
    await expect(service.reserveReplyGeneration('org1', 'medium', 'opp1')).rejects.toMatchObject({
      response: { code: 'engage_reply_cap_reached' },
    });
    expect(billingRecord.create).not.toHaveBeenCalled();
  });

  it('blocks when the balance is below the reply cost (before any reservation)', async () => {
    const { service, billingRecord } = build({ limits: DEV_LIMITS, balance: 1, billingCount: 0 });
    await expect(service.reserveReplyGeneration('org1', 'long', 'opp1')).rejects.toMatchObject({
      response: { code: 'engage_insufficient_credits' },
    });
    expect(billingRecord.create).not.toHaveBeenCalled();
  });

  it('reserves a counted row up front and returns cost + taskId when cap and balance clear', async () => {
    const { service, billingRecord } = build({ limits: STARTER_LIMITS, balance: 1_000, billingCount: 5 });
    const res = await service.reserveReplyGeneration('org1', 'medium', 'opp1');
    expect(res.cost).toBe(3);
    expect(res.taskId).toMatch(/^postiz_engage_reply_opp1_/);
    // The reservation is the cap-ledger row — written BEFORE generation, counted.
    expect(billingRecord.create).toHaveBeenCalledTimes(1);
    const data = billingRecord.create.mock.calls[0][0].data;
    expect(data.status).toBe('reserved');
    expect(data.businessType).toBe('engage_reply');
    expect(data.amount).toBe('3.000000');
  });

  it('reserves without a cap check when billing is disabled (unlimited)', async () => {
    const { service, billingRecord } = build({ limits: null, balance: null });
    const res = await service.reserveReplyGeneration('org1', 'long', 'opp1');
    expect(res.cost).toBe(5);
    expect(billingRecord.create).toHaveBeenCalledTimes(1);
    expect(billingRecord.create.mock.calls[0][0].data.status).toBe('reserved');
  });
});

describe('EngageEntitlementService.getEntitlementSummary', () => {
  it('returns plan, limits, live usage and reply pricing for the frontend', async () => {
    const { service } = build({
      limits: PRO_LIMITS,
      keywordCount: 7,
      trackedCount: 2,
      channelCount: 4,
      billingCount: 12,
    });
    const summary = await service.getEntitlementSummary('org1');
    expect(summary.plan).toBe('pro');
    expect(summary.limits.keywordsMax).toBe(300);
    expect(summary.usage).toEqual({
      keywords: 7,
      trackedAccounts: 2,
      subreddits: 4,
      repliesThisPeriod: 12,
    });
    expect(summary.replyCredits).toEqual({ short: 2, medium: 3, long: 5 });
  });

  it('reports a null plan (unlimited) when billing is disabled', async () => {
    const { service } = build({ limits: null });
    const summary = await service.getEntitlementSummary('org1');
    expect(summary.plan).toBeNull();
    expect(summary.degraded).toBe(false);
    expect(summary.limits.keywordsMax).toBeNull();
  });

  it('reports a null plan with degraded=true for an unrecognised name — never lies that the org is on Starter', async () => {
    const { service } = build({ limits: { ...PRO_LIMITS, name: 'Mystery Tier' } });
    const summary = await service.getEntitlementSummary('org1');
    expect(summary.plan).toBeNull();
    expect(summary.degraded).toBe(true);
    // Limits still fail-closed to Starter internally, independent of the display plan.
    expect(summary.limits.keywordsMax).toBe(30);
  });
});

describe('EngageEntitlementService.settleReplyGeneration', () => {
  it('charges the reservation in place via deductReserved (no new ledger row)', async () => {
    const { service, aisee } = build({ limits: DEV_LIMITS });
    await service.settleReplyGeneration('org1', 'task-1', 'medium', 3);
    expect(aisee.deductReserved).toHaveBeenCalledTimes(1);
    const arg = aisee.deductReserved.mock.calls[0][0];
    expect(arg.taskId).toBe('task-1');
    expect(arg.costItems[0].amount).toBe('3.000000');
  });

  it('does not charge for a zero-cost reply but still settles the reservation', async () => {
    const { service, aisee, billingRecord } = build({ limits: DEV_LIMITS });
    await service.settleReplyGeneration('org1', 'task-1', 'short', 0);
    expect(aisee.deductReserved).not.toHaveBeenCalled();
    expect(billingRecord.update).toHaveBeenCalledWith({
      where: { taskId: 'task-1' },
      data: { status: 'success' },
    });
  });
});

describe('EngageEntitlementService.releaseReplyGeneration', () => {
  it('marks the reservation released so it no longer counts toward the cap', async () => {
    const { service, billingRecord } = build({ limits: STARTER_LIMITS });
    await service.releaseReplyGeneration('task-1');
    expect(billingRecord.update).toHaveBeenCalledWith({
      where: { taskId: 'task-1' },
      data: { status: 'released' },
    });
  });
});
