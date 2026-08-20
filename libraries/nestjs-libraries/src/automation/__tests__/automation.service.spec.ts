import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AutomationService } from '../automation.service';

const org = { id: 'org-1' } as any;

function makeService(over: {
  activePlanId?: string | null;
  config?: any;
  publishing?: any;
  queue?: any[];
  accounts?: any[];
  count?: any;
} = {}) {
  const getActivePlanId = vi
    .fn()
    .mockResolvedValue({ id: over.activePlanId === undefined ? 'plan-1' : over.activePlanId });
  const getConfigCore = vi.fn().mockResolvedValue(over.config ?? null);
  const saveConfigRaw = vi.fn().mockResolvedValue({});
  const resolve = vi.fn().mockResolvedValue(
    over.publishing ?? {
      automationEnabled: true,
      publishingEnabled: false,
      publishingConfigured: false,
      enabledPlatforms: null,
      windows: {},
    }
  );
  const getPlanPublishingQueue = vi.fn().mockResolvedValue(over.queue ?? []);
  const schedulePlanPosts = vi
    .fn()
    .mockResolvedValue({ scheduled: [], failed: [], total: 0, alreadyScheduled: 0 });
  const listReplyAccounts = vi.fn().mockResolvedValue(over.accounts ?? []);
  const countOpportunities = vi.fn().mockResolvedValue(over.count ?? { total: 0 });
  const saveConfig = vi.fn().mockResolvedValue({});
  const upsertReplyAccountSettings = vi.fn().mockResolvedValue({});

  const service = new AutomationService(
    { getPlanPublishingQueue, schedulePlanPosts } as any,
    { getActivePlanId } as any,
    { listReplyAccounts, countOpportunities, saveConfig, upsertReplyAccountSettings } as any,
    { getConfigCore, saveConfig: saveConfigRaw } as any,
    { resolve } as any
  );

  return {
    service,
    getActivePlanId,
    getConfigCore,
    saveConfigRaw,
    resolve,
    getPlanPublishingQueue,
    schedulePlanPosts,
    listReplyAccounts,
    countOpportunities,
    saveConfig,
    upsertReplyAccountSettings,
  };
}

describe('AutomationService.getOverview', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('reports the queue rollup from the plan, not from every post', async () => {
    const { service, getPlanPublishingQueue } = makeService({
      queue: [
        { id: 'p1', providerIdentifier: 'x', content: '<p>hello</p>' },
        { id: 'p2', providerIdentifier: 'reddit', content: 'body' },
        // Empty once the tags come off — needs a human before it can go out.
        { id: 'p3', providerIdentifier: 'x', content: '<p></p>' },
        // No platform resolved — same.
        { id: 'p4', providerIdentifier: null, content: 'body' },
      ],
    });

    const res = await service.getOverview(org, 'proj-1');

    expect(getPlanPublishingQueue).toHaveBeenCalledWith('org-1', 'plan-1');
    expect(res.plan).toEqual({
      id: 'plan-1',
      queue: {
        totalPosts: 4,
        readyPosts: 2,
        attentionPosts: 2,
        platforms: ['x', 'reddit'],
      },
    });
  });

  it('returns a null plan without touching the queue when the project has none', async () => {
    const { service, getPlanPublishingQueue } = makeService({ activePlanId: null });

    const res = await service.getOverview(org, 'proj-1');

    expect(res.plan).toBeNull();
    expect(getPlanPublishingQueue).not.toHaveBeenCalled();
  });

  it('distinguishes "never configured" from "everything turned off"', async () => {
    const unconfigured = await makeService({
      publishing: {
        automationEnabled: true,
        publishingEnabled: false,
        publishingConfigured: false,
        enabledPlatforms: null,
        windows: {},
      },
    }).service.getOverview(org, 'proj-1');
    expect(unconfigured.publishing).toMatchObject({
      configured: false,
      enabled: false,
      platforms: [],
    });

    const allOff = await makeService({
      publishing: {
        automationEnabled: true,
        publishingEnabled: false,
        publishingConfigured: true,
        enabledPlatforms: [],
        windows: {},
      },
    }).service.getOverview(org, 'proj-1');
    expect(allOff.publishing).toMatchObject({
      configured: true,
      enabled: false,
      platforms: [],
    });
  });

  it('reports EFFECTIVE windows, so an admin-imposed window is visible', async () => {
    const { service } = makeService({
      publishing: {
        automationEnabled: true,
        publishingEnabled: true,
        publishingConfigured: true,
        enabledPlatforms: ['x', 'reddit'],
        windows: {
          x: { windowStart: '09:00', windowEnd: '17:00', timezone: 'Asia/Shanghai' },
          reddit: { windowStart: '10:00', windowEnd: '20:00' },
        },
      },
    });

    const res = await service.getOverview(org, 'proj-1');

    expect(res.publishing.windows).toEqual({
      x: { start: '09:00', end: '17:00', timezone: 'Asia/Shanghai' },
      reddit: { start: '10:00', end: '20:00' },
    });
  });

  it('keeps the publishing keys out of the reply policies it returns', async () => {
    const { service } = makeService({
      config: {
        enabled: true,
        metadata: {
          autoReplyMode: 'review',
          replyPolicies: {
            x: {
              autoReplyEnabled: true,
              length: 'short',
              publishingEnabled: true,
              publishingWindowStart: '09:00',
            },
          },
        },
      },
    });

    const res = await service.getOverview(org, 'proj-1');

    // Returning them under both halves would invite a client to write them back
    // through the reply endpoint, which is exactly the clobbering this split ends.
    expect(res.replies.policies).toEqual({
      x: { autoReplyEnabled: true, length: 'short' },
    });
    expect(res.replies).toMatchObject({ enabled: true, autoReplyMode: 'review' });
  });

  it('defaults replies to off for a project with no engage config row', async () => {
    const { service, getConfigCore } = makeService({ config: null });

    const res = await service.getOverview(org, 'proj-1');

    expect(res.replies).toMatchObject({
      enabled: false,
      autoReplyMode: 'off',
      policies: {},
    });
    // Read-only: loading the page must not create an EngageConfig row.
    expect(getConfigCore).toHaveBeenCalledWith('org-1', 'proj-1');
  });
});

// The three-level chain surfaced to the client. `enabled` on each feature is the
// feature's OWN switch; `active` is the AND with the master. Reporting them
// separately is what lets a UI show "publishing is on, Automation is off overall"
// instead of silently losing the setting the moment the master goes off.
describe('AutomationService.getOverview — switch chain', () => {
  beforeEach(() => vi.restoreAllMocks());

  const withSwitches = (over: Record<string, unknown>) => ({
    automationEnabled: true,
    publishingEnabled: true,
    publishingConfigured: true,
    enabledPlatforms: ['x'],
    windows: {},
    ...over,
  });

  it('reports the master switch at the top level', async () => {
    const off = await makeService({
      publishing: withSwitches({ automationEnabled: false }),
    }).service.getOverview(org, 'proj-1');
    expect(off.enabled).toBe(false);

    const on = await makeService({ publishing: withSwitches({}) }).service.getOverview(
      org,
      'proj-1'
    );
    expect(on.enabled).toBe(true);
  });

  it('keeps the publishing feature switch reported ON under a dead master', async () => {
    const res = await makeService({
      publishing: withSwitches({ automationEnabled: false, publishingEnabled: true }),
    }).service.getOverview(org, 'proj-1');

    expect(res.publishing.enabled).toBe(true);
    expect(res.publishing.active).toBe(false);
    // The platform selection survives too — a master switch suspends, it does
    // not reset.
    expect(res.publishing.platforms).toEqual(['x']);
  });

  it('derives replies.active from master AND autoReplyMode', async () => {
    const cases: Array<[boolean, string, boolean]> = [
      [true, 'review', true],
      [true, 'auto', true],
      [true, 'off', false],
      [false, 'review', false],
      [false, 'off', false],
    ];
    for (const [master, mode, expected] of cases) {
      const res = await makeService({
        publishing: withSwitches({ automationEnabled: master }),
        config: { enabled: true, metadata: { autoReplyMode: mode, replyPolicies: {} } },
      }).service.getOverview(org, 'proj-1');
      expect(res.replies.active, `master=${master} mode=${mode}`).toBe(expected);
      expect(res.replies.repliesEnabled, `master=${master} mode=${mode}`).toBe(mode !== 'off');
    }
  });
});

describe('AutomationService.saveEnabled', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('writes ONLY the master column, so no configuration is lost', async () => {
    const { service, saveConfigRaw, saveConfig } = makeService();

    const res = await service.saveEnabled(org, 'proj-1', false);

    expect(saveConfigRaw).toHaveBeenCalledWith(
      'org-1',
      { metadata: { automationEnabled: false } },
      'proj-1'
    );
    // Not through EngageService.saveConfig — that one starts the global Engage
    // workflows and kicks a scan whenever it sees `enabled`.
    expect(saveConfig).not.toHaveBeenCalled();
    expect(res).toEqual({ saved: true, enabled: false });
  });

  it('turns the master back on without restating anything else', async () => {
    const { service, saveConfigRaw } = makeService();

    await service.saveEnabled(org, 'proj-1', true);

    expect(saveConfigRaw).toHaveBeenCalledWith(
      'org-1',
      { metadata: { automationEnabled: true } },
      'proj-1'
    );
  });
});

describe('AutomationService.savePublishing', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('writes an explicit true/false for every platform, so the stored set equals the request', async () => {
    const { service, saveConfigRaw } = makeService({
      config: { metadata: { replyPolicies: { reddit: { publishingEnabled: true, length: 'long' } } } },
    });

    await service.savePublishing(org, 'proj-1', { platforms: ['x'] });

    const [, data] = saveConfigRaw.mock.calls[0];
    const policies = data.metadata.replyPolicies as Record<string, any>;
    expect(policies.x.publishingEnabled).toBe(true);
    // Previously enabled and absent from the request → explicitly turned off,
    // never left in an undecided middle state.
    expect(policies.reddit.publishingEnabled).toBe(false);
    // The reply-side key it shared the object with survives untouched.
    expect(policies.reddit.length).toBe('long');
  });

  it('stores a per-platform window only for the platforms named', async () => {
    const { service, saveConfigRaw } = makeService();

    await service.savePublishing(org, 'proj-1', {
      platforms: ['x', 'reddit'],
      windows: { x: { start: '09:00', end: '17:00', timezone: 'Asia/Shanghai' } },
    });

    const policies = saveConfigRaw.mock.calls[0][1].metadata.replyPolicies as Record<string, any>;
    expect(policies.x).toMatchObject({
      publishingWindowStart: '09:00',
      publishingWindowEnd: '17:00',
      publishingTimezone: 'Asia/Shanghai',
    });
    expect(policies.reddit.publishingWindowStart).toBeUndefined();
  });

  it('does NOT route the write through EngageService, so saving cannot start a scan', async () => {
    const { service, saveConfig, saveConfigRaw } = makeService();

    await service.savePublishing(org, 'proj-1', { platforms: ['x'] });

    // EngageService.saveConfig starts the global engage workflows and kicks an
    // immediate scan whenever it sees `enabled`. Publishing has no business
    // doing either.
    expect(saveConfig).not.toHaveBeenCalled();
    expect(saveConfigRaw).toHaveBeenCalled();
    // `enabled` is the ENGAGE feature's column — a publishing save must never
    // touch it, or saving platforms would start a scan.
    expect(saveConfigRaw.mock.calls[0][1]).not.toHaveProperty('enabled');
  });

  it('saves without committing when `commit` is absent', async () => {
    const { service, schedulePlanPosts } = makeService();

    const res = await service.savePublishing(org, 'proj-1', { platforms: ['x'] });

    expect(schedulePlanPosts).not.toHaveBeenCalled();
    expect(res).toEqual({ saved: true, scheduled: null });
  });

  it('resolves the plan id server-side and passes the projectId down when committing', async () => {
    const { service, schedulePlanPosts, getActivePlanId } = makeService();

    await service.savePublishing(org, 'proj-1', {
      platforms: ['x'],
      commit: true,
      publishMethod: 'extension',
    });

    // The client never names a plan, so it cannot borrow one from another project.
    expect(getActivePlanId).toHaveBeenCalledWith('org-1', 'proj-1');
    // projectId is a REQUIRED positional argument, not a trailing option —
    // schedulePlanPosts cannot be reached without one, so the ownership
    // assertion inside it cannot be skipped.
    expect(schedulePlanPosts).toHaveBeenCalledWith(
      'org-1',
      'plan-1',
      'proj-1',
      'extension',
      ['x']
    );
  });

  it('still saves the settings when the project has no active plan', async () => {
    const { service, saveConfigRaw, schedulePlanPosts } = makeService({
      activePlanId: null,
    });

    const res = await service.savePublishing(org, 'proj-1', {
      platforms: ['x'],
      commit: true,
    });

    // Choosing platforms is configuration; a project may do it before it has
    // ever generated a plan.
    expect(saveConfigRaw).toHaveBeenCalled();
    expect(schedulePlanPosts).not.toHaveBeenCalled();
    expect(res).toEqual({ saved: true, scheduled: null });
  });
});

describe('AutomationService.saveReplies', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('rejects an empty body rather than writing nothing and reporting success', async () => {
    const { service } = makeService();
    await expect(service.saveReplies(org, 'proj-1', {})).rejects.toMatchObject({
      status: 400,
    });
  });

  it('merges reply policies over what is stored and preserves the publishing keys', async () => {
    const { service, saveConfig } = makeService({
      config: {
        metadata: {
          replyPolicies: {
            x: { length: 'short', publishingEnabled: true, publishingWindowStart: '09:00' },
          },
        },
      },
    });

    await service.saveReplies(org, 'proj-1', {
      policies: { x: { length: 'long' } },
    });

    const policies = saveConfig.mock.calls[0][1].replyPolicies as Record<string, any>;
    expect(policies.x).toEqual({
      length: 'long',
      publishingEnabled: true,
      publishingWindowStart: '09:00',
    });
  });

  it('drops publishing keys a caller tries to smuggle through the reply endpoint', async () => {
    const { service, saveConfig } = makeService({
      config: { metadata: { replyPolicies: { x: { publishingEnabled: true } } } },
    });

    await service.saveReplies(org, 'proj-1', {
      policies: { x: { length: 'long', publishingEnabled: false } as any },
    });

    const policies = saveConfig.mock.calls[0][1].replyPolicies as Record<string, any>;
    // The stored value stands — publishing is the other endpoint's to change.
    expect(policies.x.publishingEnabled).toBe(true);
    expect(policies.x.length).toBe('long');
  });

  it('writes config flags through EngageService so enabling engage still starts it', async () => {
    const { service, saveConfig } = makeService();

    await service.saveReplies(org, 'proj-1', { enabled: true, autoReplyMode: 'auto' });

    expect(saveConfig).toHaveBeenCalledWith(org, {
      projectId: 'proj-1',
      enabled: true,
      autoReplyMode: 'auto',
    });
  });

  it('applies account authorization in one batched call', async () => {
    const { service, upsertReplyAccountSettings } = makeService();

    const res = await service.saveReplies(org, 'proj-1', {
      accounts: [
        { integrationId: 'int-1', engageEnabled: true },
        { integrationId: 'int-2', engageEnabled: false },
      ],
    });

    expect(upsertReplyAccountSettings).toHaveBeenNthCalledWith(1, org, 'int-1', {
      projectId: 'proj-1',
      engageEnabled: true,
    });
    expect(upsertReplyAccountSettings).toHaveBeenNthCalledWith(2, org, 'int-2', {
      projectId: 'proj-1',
      engageEnabled: false,
    });
    expect(res).toEqual({ saved: true, accounts: 2 });
  });
});
