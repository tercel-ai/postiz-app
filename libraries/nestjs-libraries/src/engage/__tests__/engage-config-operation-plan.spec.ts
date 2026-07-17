import { describe, it, expect, vi } from 'vitest';
import { EngageService } from '@gitroom/nestjs-libraries/engage/engage.service';

/**
 * GET /engage/config also surfaces the admin-configured operation-plan limits,
 * so a plan-creation UI can bound its date range / platform picker from the
 * same call it already makes.
 *
 * `allowedPlatforms` is the RESOLVED list (connected ∩ allowlist), not the raw
 * setting: the setting's `[]` means "no extra restriction" server-side, which a
 * UI cannot render. Resolving it here keeps the picker and `_validateInput` in
 * lockstep.
 *
 * `operation_plan.platform_cadence` is deliberately NOT exposed — it steers the
 * generator's editorial strategy and no client has a use for it.
 */
describe('EngageService.getConfig — operationPlan block', () => {
  const org = { id: 'org-1' } as any;

  function buildService(opts: {
    settingsGet?: (key: string) => Promise<unknown>;
    connected?: string[];
    withPlanRepo?: boolean;
  } = {}) {
    const engageRepository = {
      getOrCreateConfig: vi.fn(async () => ({
        id: 'cfg-1',
        keywords: [],
        monitoredChannels: [],
        trackedAccounts: [],
        xReplyAccounts: [],
      })),
      getOrgScanStatus: vi.fn(async () => ({})),
      getKeywordCursors: vi.fn(async () => ({})),
      getChannelCursors: vi.fn(async () => ({})),
      getTrackedCursors: vi.fn(async () => ({})),
    } as any;
    const entitlementService = {
      getEntitlementSummary: vi.fn(async () => ({
        limits: { scanIntervalHours: 6, keywordsMax: 10, priorityAccountsMax: 5, subredditsMax: 5 },
        usage: { keywords: 0, trackedAccounts: 0, subreddits: 0 },
      })),
    } as any;
    const settingsService = opts.settingsGet ? { get: vi.fn(opts.settingsGet) } : undefined;
    const getConnectedPlatforms = vi.fn(async () => opts.connected ?? []);
    const planRepo =
      opts.withPlanRepo === false ? undefined : ({ getConnectedPlatforms } as any);

    const service = new EngageService(
      engageRepository,
      { client: undefined } as any,
      {} as any,
      {} as any,
      entitlementService,
      undefined,
      planRepo,
      settingsService as any
    );
    return { service, getConnectedPlatforms };
  }

  it('with no allowlist configured, returns every CONNECTED platform (not an empty array)', async () => {
    const { service } = buildService({
      connected: ['x', 'linkedin', 'mastodon'],
      settingsGet: async (key) =>
        key === 'operation_plan.allowed_platforms' ? [] : undefined,
    });

    const res: any = await service.getConfig(org);

    // The raw setting is [] ("no restriction"), but the client gets the usable list.
    expect(res.operationPlan.allowedPlatforms).toEqual(['x', 'linkedin', 'mastodon']);
  });

  it('intersects the allowlist with connected platforms', async () => {
    const { service } = buildService({
      connected: ['x', 'linkedin', 'mastodon'],
      settingsGet: async (key) => {
        if (key === 'operation_plan.allowed_platforms') return ['x', 'instagram'];
        if (key === 'operation_plan.max_duration_days') return 14;
        return undefined;
      },
    });

    const res: any = await service.getConfig(org);

    // instagram is allowlisted but NOT connected → not offered (the server would
    // reject it with PLATFORM_NOT_CONNECTED anyway).
    expect(res.operationPlan).toEqual({ maxDurationDays: 14, allowedPlatforms: ['x'] });
  });

  it('returns an empty list when nothing is connected — a true "no platform available"', async () => {
    const { service } = buildService({
      connected: [],
      settingsGet: async () => undefined,
    });

    const res: any = await service.getConfig(org);
    expect(res.operationPlan.allowedPlatforms).toEqual([]);
  });

  it('returns an empty list when the allowlist excludes everything connected', async () => {
    const { service } = buildService({
      connected: ['x'],
      settingsGet: async (key) =>
        key === 'operation_plan.allowed_platforms' ? ['linkedin'] : undefined,
    });

    const res: any = await service.getConfig(org);
    // Consistent with the server: requesting x would 400 PLATFORM_NOT_ALLOWED.
    expect(res.operationPlan.allowedPlatforms).toEqual([]);
  });

  it('never exposes platform_cadence (generator-only editorial strategy)', async () => {
    const cadenceGet = vi.fn(async (key: string) => {
      if (key === 'operation_plan.platform_cadence') return { x: { cadence: 'secret playbook' } };
      return undefined;
    });
    const { service } = buildService({ connected: ['x'], settingsGet: cadenceGet });

    const res: any = await service.getConfig(org);

    expect(res.operationPlan).not.toHaveProperty('platformCadence');
    expect(JSON.stringify(res)).not.toContain('secret playbook');
    // It must not even be read here.
    expect(cadenceGet).not.toHaveBeenCalledWith('operation_plan.platform_cadence');
  });

  it('falls back to the backend default duration when the setting is unset', async () => {
    const { service } = buildService({ connected: ['x'], settingsGet: async () => undefined });

    const res: any = await service.getConfig(org);

    // Mirrors OperationPlanService's own fallback of 30 days.
    expect(res.operationPlan.maxDurationDays).toBe(30);
  });

  it('degrades to defaults instead of failing the whole page when a Settings read throws', async () => {
    const { service } = buildService({
      connected: ['x'],
      settingsGet: async () => {
        throw new Error('settings backend down');
      },
    });

    const res: any = await service.getConfig(org);

    expect(res.operationPlan).toEqual({ maxDurationDays: 30, allowedPlatforms: [] });
    expect(res.id).toBe('cfg-1'); // the rest of the config still came through
  });

  it('no-ops safely when SettingsService is not wired (unit-test construction)', async () => {
    const { service, getConnectedPlatforms } = buildService({ connected: ['x'] });

    const res: any = await service.getConfig(org);

    expect(res.operationPlan).toEqual({ maxDurationDays: 30, allowedPlatforms: [] });
    expect(getConnectedPlatforms).not.toHaveBeenCalled();
  });
});
