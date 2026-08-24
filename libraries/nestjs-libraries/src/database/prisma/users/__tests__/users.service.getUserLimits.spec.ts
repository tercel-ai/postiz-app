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

  it('returns the marked sentinel when the package is stale beyond grace — never overridable', async () => {
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

  // aisee-core (UserCreditPackageStatus.is_valid_subscription) — not a periodEnd
  // comparison here — decides whether a subscription may spend credits. These
  // two blocks pin this side to that definition in both directions.
  describe('honours the status aisee-core sends', () => {
    const hoursAgo = (h: number) =>
      new Date(Date.now() - h * 60 * 60 * 1000).toISOString();

    // The regression: renewal is confirmed by a Stripe webhook that lands AFTER
    // periodEnd, so every paying user passes through a window where the period
    // is past but the subscription is perfectly valid. The old periodEnd test
    // reported those users as having no subscription — a silent downgrade that
    // also hard-blocked posting.
    for (const status of ['active', 'trialing', 'past_due', 'cancelling']) {
      it(`serves a ${status} package whose period just ended (renewal in flight)`, async () => {
        const pkg = { ...ACTIVE_PKG, status, periodEnd: hoursAgo(6) };
        const { service, postPlanLimits } = build({ pkg, applied: pkg });
        const limits = await service.getUserLimits('u1');
        expect(postPlanLimits.applyOverrides).toHaveBeenCalledWith(pkg);
        expect(limits && 'noActiveSubscription' in limits).toBe(false);
      });
    }

    // Status is authoritative in the other direction too: a package inside its
    // period is still blocked once aisee-core marks it invalid (an immediate
    // cancellation, a refund, an abandoned checkout).
    for (const status of [
      'cancelled',
      'expired',
      'abandoned',
      'incomplete',
      'incomplete_expired',
      'pending',
    ]) {
      it(`blocks a ${status} package even while its period is still open`, async () => {
        const { service, postPlanLimits } = build({
          pkg: { ...ACTIVE_PKG, status },
        });
        expect(await service.getUserLimits('u1')).toEqual({
          postChannelLimit: 0,
          postSendLimit: 0,
          noActiveSubscription: true,
        });
        expect(postPlanLimits.applyOverrides).not.toHaveBeenCalled();
      });
    }

    it('matches the status case-insensitively', async () => {
      const pkg = { ...ACTIVE_PKG, status: 'ACTIVE' };
      const { service, postPlanLimits } = build({ pkg, applied: pkg });
      const limits = await service.getUserLimits('u1');
      expect(limits && 'noActiveSubscription' in limits).toBe(false);
      expect(postPlanLimits.applyOverrides).toHaveBeenCalled();
    });
  });

  describe('renewal grace window', () => {
    const daysAgo = (d: number) =>
      new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString();

    it('still serves a valid package one day past its period', async () => {
      const pkg = { ...ACTIVE_PKG, periodEnd: daysAgo(1) };
      const { service } = build({ pkg, applied: pkg });
      const limits = await service.getUserLimits('u1');
      expect(limits && 'noActiveSubscription' in limits).toBe(false);
    });

    // Past the window a still-"active" record means aisee-core neither renewed
    // nor expired it — a missed renewal webhook. Serving a paid plan off that
    // forever would turn one lost webhook into a permanent free upgrade.
    it('blocks a valid-status package well past the window', async () => {
      const { service, postPlanLimits } = build({
        pkg: { ...ACTIVE_PKG, periodEnd: daysAgo(30) },
      });
      expect(await service.getUserLimits('u1')).toEqual({
        postChannelLimit: 0,
        postSendLimit: 0,
        noActiveSubscription: true,
      });
      expect(postPlanLimits.applyOverrides).not.toHaveBeenCalled();
    });

    it('blocks when periodEnd is missing or unparseable', async () => {
      for (const periodEnd of [undefined, '', 'not-a-date']) {
        const { service } = build({ pkg: { ...ACTIVE_PKG, periodEnd } });
        expect(await service.getUserLimits('u1')).toEqual({
          postChannelLimit: 0,
          postSendLimit: 0,
          noActiveSubscription: true,
        });
      }
    });
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
