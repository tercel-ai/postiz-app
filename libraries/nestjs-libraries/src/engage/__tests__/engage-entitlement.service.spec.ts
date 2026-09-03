import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import {
  EngageEntitlementService,
  ENGAGE_ENTITLEMENTS_KEY,
  ENGAGE_REPLY_CREDITS_KEY,
  DEFAULT_SCAN_INTERVAL_HOURS,
  DEFAULT_METRICS_WINDOW_DAYS,
  DEFAULT_METRICS_FETCH_INTERVAL_HOURS,
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

/**
 * engageTrackedAccount holds BOTH scan-target scopes since the merge, so one
 * mock answers three different query shapes:
 *   - `platform: 'x'`            → the per-platform priority-accounts pool
 *   - `platform: { in: [...] }`  → the channel-scope breakdown
 *   - `platform: { notIn: ... }` → the author-scope breakdown
 *   - no platform predicate      → the cap query, i.e. both scopes together
 * The tests keep naming the two scopes separately (trackedCount/channelCount);
 * this is where they are added up the way storage now does.
 */
function targetRepoMock(opts: {
  trackedCount?: number;
  channelCount?: number;
  trackedProjectCount?: number;
  channelProjectCount?: number;
  enabled?: boolean | null;
  byPlatform?: Record<string, number>;
}) {
  const tracked = opts.trackedCount ?? 0;
  const channel = opts.channelCount ?? 0;
  const trackedProject = opts.trackedProjectCount ?? tracked;
  const channelProject = opts.channelProjectCount ?? channel;
  const enabled = opts.enabled ?? false;
  return {
    model: {
      engageTrackedAccount: {
        count: vi.fn(async (args: any = {}) => {
          const platform = args?.where?.platform;
          const perProject = args?.where?.configId !== undefined;
          if (typeof platform === 'string') {
            if (opts.byPlatform) return opts.byPlatform[platform] ?? 0;
            return perProject ? trackedProject + channelProject : tracked + channel;
          }
          if (Array.isArray(platform?.in)) return perProject ? channelProject : channel;
          if (Array.isArray(platform?.notIn)) return perProject ? trackedProject : tracked;
          return perProject ? trackedProject + channelProject : tracked + channel;
        }),
        groupBy: vi.fn(async () =>
          Object.entries(opts.byPlatform ?? {}).map(([platform, n]) => ({
            platform,
            _count: { _all: n },
          }))
        ),
        findFirst: vi.fn(async () =>
          enabled === null
            ? null
            : { enabled, configId: CONFIG_ID, platform: 'x' }
        ),
      },
    },
  } as any;
}

/** Sum two per-platform maps into the single pool the merged table reports. */
function mergePlatformCounts(
  a?: Record<string, number>,
  b?: Record<string, number>
): Record<string, number> {
  const out: Record<string, number> = { ...(a ?? {}) };
  for (const [platform, n] of Object.entries(b ?? {})) {
    out[platform] = (out[platform] ?? 0) + n;
  }
  return out;
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
      targetRepoMock({
        trackedCount: opts.trackedCount,
        channelCount: opts.channelCount,
        trackedProjectCount: opts.trackedProjectCount,
        channelProjectCount: opts.channelProjectCount,
        enabled: opts.rowEnabled === undefined ? false : opts.rowEnabled,
        // One table → one per-platform map. Tests that used to stub the two
        // scopes separately have their platform counts summed here.
        byPlatform:
          opts.trackedByPlatform || opts.channelByPlatform
            ? mergePlatformCounts(opts.trackedByPlatform, opts.channelByPlatform)
            : undefined,
      }),
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
      'growth-loop',
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

  it('keeps a stored priorityAccounts cap of null unlimited when folding a legacy subreddits cap', async () => {
    // The other side of "null wins": unlimited on the SURVIVING key, finite on
    // the legacy one. Pro's pre-merge defaults were exactly this shape
    // (priorityAccountsMax null + subredditsMax 150), so coalescing the null to
    // 0 before summing would silently cap every pre-merge pro row at 150.
    const { service } = build({
      limits: PRO_LIMITS,
      settings: {
        [ENGAGE_ENTITLEMENTS_KEY]: {
          pro: {
            priorityAccountsMax: null,
            subredditsMax: 150,
            priorityAccountsPerProjectMax: null,
            subredditsPerProjectMax: 15,
          },
        },
      },
    });
    const catalog = await service.getPublicPlanCatalog();
    const pro = catalog.plans.find((p) => p.code === 'pro')!.limits;
    expect(pro.priorityAccountsMax).toBeNull();
    expect(pro.priorityAccountsPerProjectMax).toBeNull();
  });

  it('treats an absent priorityAccounts cap as 0 so the legacy subreddits cap carries the pair', async () => {
    // Distinguishes absent from null: with no surviving key to sum against, the
    // legacy value IS the merged cap (it still overrides the plan default).
    const { service } = build({
      limits: PRO_LIMITS,
      settings: {
        [ENGAGE_ENTITLEMENTS_KEY]: {
          pro: { subredditsMax: 7, subredditsPerProjectMax: 3 },
        },
      },
    });
    const catalog = await service.getPublicPlanCatalog();
    const pro = catalog.plans.find((p) => p.code === 'pro')!.limits;
    expect(pro.priorityAccountsMax).toBe(7);
    expect(pro.priorityAccountsPerProjectMax).toBe(3);
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

describe('EngageEntitlementService.onModuleInit — per-plan backfill', () => {
  // onModuleInit touches only the settings store, so the rest of the graph can
  // stay empty here — build() constructs its own settings mock internally and
  // does not hand it back.
  function seedBuild(stored?: unknown) {
    const settings = settingsMock(
      stored === undefined ? {} : { [ENGAGE_ENTITLEMENTS_KEY]: stored }
    );
    const service = new EngageEntitlementService(
      settings,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any
    );
    const writes = () =>
      settings.set.mock.calls.filter(
        (c: unknown[]) => c[0] === ENGAGE_ENTITLEMENTS_KEY
      );
    return { service, settings, writes };
  }

  // The production row was written before 'growth-loop' existed, so it carried
  // only the three legacy tiers — and the admin settings UI renders the STORED
  // object, which meant it showed three unsellable tiers and hid the only one
  // being sold.
  const LEGACY_ROW = {
    pro: { keywordsMax: 300, subredditsMax: 150, scanIntervalHours: 6 },
    starter: { keywordsMax: 30, subredditsMax: 10, scanIntervalHours: 24 },
    developer: { keywordsMax: 100, subredditsMax: 50, scanIntervalHours: 24 },
  };

  it('adds the missing plan without touching the stored ones', async () => {
    const { service, writes } = seedBuild(LEGACY_ROW);
    await service.onModuleInit();

    expect(writes()).toHaveLength(1);
    const value = writes()[0][1] as Record<string, any>;
    expect(Object.keys(value).sort()).toEqual([
      'developer',
      'growth-loop',
      'pro',
      'starter',
    ]);
    // Admin tuning outranks a default: every stored value survives verbatim.
    // The fields it never set are filled in AROUND it — plan-level backfill
    // alone would leave a field added to the shape later permanently invisible
    // in the admin UI, which renders this stored object.
    for (const code of ['pro', 'starter', 'developer'] as const) {
      expect(value[code]).toMatchObject(LEGACY_ROW[code]);
      expect(value[code].keywordsPerProjectMax).toBeDefined();
    }
    // ...and the backfilled plan carries the sold spec.
    expect(value['growth-loop']).toMatchObject({
      keywordsPerProjectMax: 30,
      priorityAccountsPerProjectMax: 20,
      scanIntervalHours: 24,
    });
  });

  it('writes nothing when every plan AND field is already stored', async () => {
    const complete = Object.fromEntries(
      (['starter', 'developer', 'pro', 'growth-loop'] as const).map((code) => [
        code,
        {
          keywordsMax: 1,
          priorityAccountsMax: 1,
          keywordsPerProjectMax: 1,
          priorityAccountsPerProjectMax: 1,
          scanIntervalHours: 1,
          replyMonthlyCap: null,
          metricsWindowDaysMax: 1,
          metricsFetchIntervalHours: 1,
        },
      ])
    );
    const { service, writes } = seedBuild(complete);
    await service.onModuleInit();
    expect(writes()).toHaveLength(0);
  });

  it('backfills a FIELD the stored plan predates, not just a whole plan', async () => {
    // `null` stays untouched — it is a real value (unlimited), not a gap.
    const { service, writes } = seedBuild({
      ...LEGACY_ROW,
      'growth-loop': { keywordsMax: 42, replyMonthlyCap: null },
    });
    await service.onModuleInit();
    const value = writes()[0][1] as Record<string, any>;
    expect(value['growth-loop'].keywordsMax).toBe(42); // tuning survives
    expect(value['growth-loop'].replyMonthlyCap).toBeNull(); // null preserved
    expect(value['growth-loop'].priorityAccountsPerProjectMax).toBe(20); // filled
  });

  it('seeds the full default map when the key is absent entirely', async () => {
    const { service, writes } = seedBuild();
    await service.onModuleInit();
    expect(Object.keys(writes()[0][1] as object).sort()).toEqual([
      'developer',
      'growth-loop',
      'pro',
      'starter',
    ]);
  });

  it('refuses to overwrite a stored value that is not an object', async () => {
    const { service, writes } = seedBuild('corrupted');
    await service.onModuleInit();
    expect(writes()).toHaveLength(0);
  });
});

describe('EngageEntitlementService.onModuleInit — unreachable project caps', () => {
  function warnBuild(stored: unknown) {
    const settings = settingsMock({ [ENGAGE_ENTITLEMENTS_KEY]: stored });
    const service = new EngageEntitlementService(
      settings,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any
    );
    const warn = vi
      .spyOn((service as any).logger, 'warn')
      .mockImplementation(() => undefined);
    return { service, warn };
  }

  const complete = (extra: Record<string, unknown>) => ({
    starter: {},
    developer: {},
    pro: {},
    'growth-loop': {},
    ...extra,
  });

  it('warns when the org cap sits below the per-project cap', async () => {
    // The exact shape that reached production: growth-loop filled in from
    // starter, so a 10-keyword org budget against a 30-keyword project cap.
    const { service, warn } = warnBuild(
      complete({ 'growth-loop': { keywordsMax: 10, priorityAccountsMax: 10 } })
    );
    await service.onModuleInit();

    const message = warn.mock.calls.map(String).join('\n');
    expect(message).toContain('growth-loop');
    expect(message).toContain('keywordsMax=10 < keywordsPerProjectMax=30');
    expect(message).toContain(
      'priorityAccountsMax=10 < priorityAccountsPerProjectMax=20'
    );
  });

  it('stays quiet on a well-formed map', async () => {
    const { service, warn } = warnBuild(complete({}));
    await service.onModuleInit();
    expect(
      warn.mock.calls.filter((c) => String(c[0]).includes('PerProjectMax'))
    ).toHaveLength(0);
  });

  it('treats an unlimited org cap as reachable, not as zero', async () => {
    // null means unlimited; comparing it numerically would flag every pro row.
    const { service, warn } = warnBuild(
      complete({ pro: { priorityAccountsMax: null, keywordsMax: null } })
    );
    await service.onModuleInit();
    expect(
      warn.mock.calls.filter((c) => String(c[0]).includes('pro:'))
    ).toHaveLength(0);
  });
});

describe('growth-loop tracks the named cadence/window defaults', () => {
  // The sold plan must not repeat these numbers as literals — a second copy is
  // how it and the no-billing fallback drift apart. Asserting identity rather
  // than a value keeps this test true when the defaults are retuned.
  it('reads its cadence and metrics window from the shared constants', async () => {
    const settings = settingsMock({});
    const service = new EngageEntitlementService(
      settings,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any
    );
    const growthLoop = (await service.getPublicPlanCatalog()).plans.find(
      (p) => p.code === 'growth-loop'
    )!.limits;

    expect(growthLoop.scanIntervalHours).toBe(DEFAULT_SCAN_INTERVAL_HOURS);
    expect(growthLoop.metricsWindowDaysMax).toBe(DEFAULT_METRICS_WINDOW_DAYS);
    expect(growthLoop.metricsFetchIntervalHours).toBe(
      DEFAULT_METRICS_FETCH_INTERVAL_HOURS
    );
  });

  it('leaves the legacy ladder on its own literals', async () => {
    const settings = settingsMock({});
    const service = new EngageEntitlementService(
      settings,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any
    );
    const byCode = Object.fromEntries(
      (await service.getPublicPlanCatalog()).plans.map((p) => [p.code, p.limits])
    );
    // starter/developer sit BELOW the shared defaults by design; binding them
    // to the constants would collapse the ladder on the next retune.
    expect(byCode.starter.metricsWindowDaysMax).toBeLessThan(
      DEFAULT_METRICS_WINDOW_DAYS
    );
    expect(byCode.developer.metricsWindowDaysMax).toBeLessThan(
      DEFAULT_METRICS_WINDOW_DAYS
    );
  });
});
