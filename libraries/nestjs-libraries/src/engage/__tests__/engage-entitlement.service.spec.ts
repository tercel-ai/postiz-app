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

function repoMock(name: string, count = 0, enabled: boolean | null = false) {
  return {
    model: {
      [name]: {
        count: vi.fn(async () => count),
        findFirst: vi.fn(async () =>
          enabled === null ? null : { enabled }
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
      repoMock('engageKeyword', opts.keywordCount ?? 0),
      repoMock('engageTrackedAccount', opts.trackedCount ?? 0),
      repoMock('engageMonitoredChannel', opts.channelCount ?? 0),
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
    expect(ent.keywordsMax).toBe(30);
    expect(ent.priorityAccountsMax).toBeNull(); // unlimited
    expect(ent.scanIntervalHours).toBe(6);
  });

  it('falls back to starter limits for an unrecognised plan name', async () => {
    const { service } = build({ limits: { ...PRO_LIMITS, name: 'Mystery Tier' } });
    const ent = await service.getEntitlement('org1');
    expect(ent.keywordsMax).toBe(3);
    expect(ent.scanIntervalHours).toBe(24);
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
    const { service } = build({ limits: STARTER_LIMITS, keywordCount: 3 });
    await expect(service.assertCanActivate('org1', 'keyword', 1)).rejects.toBeInstanceOf(
      ForbiddenException
    );
  });

  it('allows activation under the cap', async () => {
    const { service } = build({ limits: STARTER_LIMITS, keywordCount: 2 });
    await expect(service.assertCanActivate('org1', 'keyword', 1)).resolves.toBeUndefined();
  });

  it('blocks tracked accounts entirely on Starter (max 0)', async () => {
    const { service } = build({ limits: STARTER_LIMITS, trackedCount: 0 });
    await expect(service.assertCanActivate('org1', 'tracked', 1)).rejects.toBeInstanceOf(
      ForbiddenException
    );
  });

  it('is a no-op when the cap is unlimited (null)', async () => {
    const { service } = build({ limits: PRO_LIMITS, trackedCount: 999 });
    await expect(service.assertCanActivate('org1', 'tracked', 1)).resolves.toBeUndefined();
  });

  it('rejects a bulk add that overruns the cap', async () => {
    const { service } = build({ limits: DEV_LIMITS, keywordCount: 8 });
    await expect(service.assertCanActivate('org1', 'keyword', 5)).rejects.toBeInstanceOf(
      ForbiddenException
    );
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
    expect(summary.limits.keywordsMax).toBe(30);
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
    expect(summary.limits.keywordsMax).toBeNull();
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
