import { describe, it, expect, vi } from 'vitest';
import { UsersService } from '../users.service';

function build(opts: {
  enabled?: boolean;
  pkg?: unknown;
  applied?: unknown;
}) {
  const aiseeClient = {
    enabled: opts.enabled ?? true,
    getUserCreditPackage: vi.fn(async () => opts.pkg ?? null),
  } as any;
  const postPlanLimits = {
    applyOverrides: vi.fn(async (pkg: unknown) => opts.applied ?? pkg),
  } as any;
  const service = new UsersService(
    {} as any,
    {} as any,
    aiseeClient,
    postPlanLimits
  );
  return { service, aiseeClient, postPlanLimits };
}

const ACTIVE_PKG = {
  postSendLimit: 100,
  postChannelLimit: 10,
  interval: 'month',
  periodStart: '2026-06-01T00:00:00.000Z',
  periodEnd: '2999-01-01T00:00:00.000Z',
  name: 'Pro Plan (Monthly)',
  status: 'active',
};

describe('UsersService.getUserLimits', () => {
  it('returns null when billing is disabled (no overrides applied)', async () => {
    const { service, postPlanLimits } = build({ enabled: false });
    expect(await service.getUserLimits('u1')).toBeNull();
    expect(postPlanLimits.applyOverrides).not.toHaveBeenCalled();
  });

  it('returns the marked sentinel when there is no package — never overridable', async () => {
    const { service, postPlanLimits } = build({ pkg: null });
    expect(await service.getUserLimits('u1')).toEqual({
      postChannelLimit: 0,
      postSendLimit: 0,
      noActiveSubscription: true,
    });
    expect(postPlanLimits.applyOverrides).not.toHaveBeenCalled();
  });

  it('returns the marked sentinel when the package is expired — never overridable', async () => {
    const { service, postPlanLimits } = build({
      pkg: { ...ACTIVE_PKG, periodEnd: '2020-01-01T00:00:00.000Z' },
    });
    expect(await service.getUserLimits('u1')).toEqual({
      postChannelLimit: 0,
      postSendLimit: 0,
      noActiveSubscription: true,
    });
    expect(postPlanLimits.applyOverrides).not.toHaveBeenCalled();
  });

  it('applies post_plan_limits overrides to an active package', async () => {
    const { service, postPlanLimits } = build({
      pkg: ACTIVE_PKG,
      applied: { ...ACTIVE_PKG, postSendLimit: 0 },
    });
    const limits = await service.getUserLimits('u1');
    expect(postPlanLimits.applyOverrides).toHaveBeenCalledWith(ACTIVE_PKG);
    expect(limits).toMatchObject({ postSendLimit: 0, postChannelLimit: 10 });
    expect(limits && 'noActiveSubscription' in limits).toBe(false);
  });
});
