import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AutomationService } from '../automation.service';

const org = { id: 'org-1' } as any;

function makeService(over: {
  activePlanId?: string | null;
  config?: any;
  publishing?: any;
  lastPublishedAt?: Date | null;
  count?: any;
  pacing?: any;
  lastSentAtByPlatform?: Record<string, Date>;
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
      platformDecisions: {},
      windows: {},
    }
  );
  const getLastPublishedAt = vi.fn().mockResolvedValue(over.lastPublishedAt ?? null);
  // The two publish-window passes. Both are best-effort follow-ups to a save,
  // so the harness gives them benign defaults and the tests assert WHEN they run.
  const alignPlanDraftPublishDates = vi
    .fn()
    .mockResolvedValue({ aligned: 0, skipped: null });
  const rescheduleQueuedPlanPosts = vi
    .fn()
    .mockResolvedValue({ rescheduled: 0, skipped: [], inactive: null });
  const schedulePlanPosts = vi
    .fn()
    .mockResolvedValue({ scheduled: [], failed: [], total: 0, alreadyScheduled: 0 });
  const countOpportunities = vi.fn().mockResolvedValue(over.count ?? { total: 0 });
  const saveConfig = vi.fn().mockResolvedValue({});
  const upsertReplyAccountSettings = vi.fn().mockResolvedValue({});
  const getPacing = vi
    .fn()
    .mockResolvedValue(over.pacing ?? { minGapMinutes: 25 });
  const getLastSentReplyAtByPlatform = vi
    .fn()
    .mockResolvedValue(over.lastSentAtByPlatform ?? {});

  const service = new AutomationService(
    {
      getLastPublishedAt,
      schedulePlanPosts,
      alignPlanDraftPublishDates,
      rescheduleQueuedPlanPosts,
    } as any,
    { getActivePlanId } as any,
    { countOpportunities, saveConfig, upsertReplyAccountSettings } as any,
    { getConfigCore, saveConfig: saveConfigRaw, getLastSentReplyAtByPlatform } as any,
    { resolve } as any,
    { getPacing } as any
  );

  return {
    service,
    getActivePlanId,
    getConfigCore,
    saveConfigRaw,
    resolve,
    getLastPublishedAt,
    schedulePlanPosts,
    alignPlanDraftPublishDates,
    rescheduleQueuedPlanPosts,
    countOpportunities,
    saveConfig,
    upsertReplyAccountSettings,
    getPacing,
    getLastSentReplyAtByPlatform,
  };
}

describe('AutomationService.getOverview', () => {
  beforeEach(() => vi.restoreAllMocks());



  it('distinguishes "never configured" from "everything turned off"', async () => {
    const unconfigured = await makeService({
      publishing: {
        automationEnabled: true,
        publishingEnabled: false,
        publishingConfigured: false,
        enabledPlatforms: null,
        platformDecisions: {},
        windows: {},
      },
    }).service.getOverview(org, 'proj-1');
    // Never configured: no platform carries an `enabled` decision at all, which
    // is what tells this apart from "every platform deliberately off" below.
    expect(unconfigured.publishing.enabled).toBe(false);
    expect(unconfigured.publishing.platforms).toEqual({});

    const allOff = await makeService({
      publishing: {
        automationEnabled: true,
        publishingEnabled: false,
        publishingConfigured: true,
        enabledPlatforms: [],
        platformDecisions: { x: false, reddit: false },
        windows: {},
      },
    }).service.getOverview(org, 'proj-1');
    // Every platform explicitly off — the decisions are present and false.
    expect(allOff.publishing.enabled).toBe(false);
    expect(allOff.publishing.platforms).toEqual({
      x: { enabled: false },
      reddit: { enabled: false },
    });
  });

  it('reports EFFECTIVE windows, so an admin-imposed window is visible', async () => {
    const { service } = makeService({
      publishing: {
        automationEnabled: true,
        publishingEnabled: true,
        publishingConfigured: true,
        enabledPlatforms: ['x', 'reddit'],
        platformDecisions: { x: true, reddit: true },
        windows: {
          x: { windowStart: '09:00', windowEnd: '17:00', timezone: 'Asia/Shanghai' },
          reddit: { windowStart: '10:00', windowEnd: '20:00' },
        },
      },
    });

    const res = await service.getOverview(org, 'proj-1');

    // The zones disagree (one window carries none), so there is no unanimous
    // default to hoist and the one that has a zone states it itself.
    expect(res.publishing.timezone).toBeUndefined();
    expect(res.publishing.platforms).toEqual({
      x: { enabled: true, window: { start: '09:00', end: '17:00', timezone: 'Asia/Shanghai' } },
      reddit: { enabled: true, window: { start: '10:00', end: '20:00' } },
    });
  });

  it('keeps the publishing keys out of the reply policies it returns', async () => {
    const { service } = makeService({
      config: {
        enabled: true,
        metadata: {
          autoReplyEnabled: true,
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
    // `nextCheckAt` is asserted separately below — it is a live timestamp, not
    // part of what this test is checking.
    expect(res.replies.platforms).toMatchObject({
      x: { autoReplyEnabled: true, length: 'short' },
    });
    expect(res.replies.platforms.x).not.toHaveProperty('publishingEnabled');
    expect(res.replies.platforms.x).not.toHaveProperty('publishingWindowStart');
    expect(res.replies).toMatchObject({ scanEnabled: true, autoReplyEnabled: true });
  });

  it('defaults replies to off for a project with no engage config row', async () => {
    const { service, getConfigCore } = makeService({ config: null });

    const res = await service.getOverview(org, 'proj-1');

    expect(res.replies).toMatchObject({
      scanEnabled: false,
      autoReplyEnabled: false,
      platforms: {},
    });
    // The retired tri-state is gone from the payload entirely.
    expect(res.replies).not.toHaveProperty('autoReplyMode');
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
    platformDecisions: { x: true },
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
    // `active` is no longer transmitted — the client computes
    // `overview.enabled && publishing.enabled`, so it cannot disagree with a
    // server-sent copy of itself.
    expect(res.publishing).not.toHaveProperty('active');
    expect(res.enabled).toBe(false);
    // The platform selection survives — a master switch suspends, it does not
    // reset.
    expect(res.publishing.platforms).toEqual({ x: { enabled: true } });
  });

  it('reports the three reply switches separately, so the client can AND them', async () => {
    // scan / reply / master are three different reasons for silence, and the
    // payload keeps them apart. `active` itself is still NOT transmitted — it is
    // the AND, which the client computes and so cannot disagree with a
    // server-sent copy of itself (same rule as publishing above).
    const cases: Array<[boolean, boolean, boolean, boolean]> = [
      [true, true, true, true],
      [true, true, false, false],
      [true, false, true, false],
      [false, true, true, false],
      [false, true, false, false],
    ];
    for (const [master, scan, reply, expected] of cases) {
      const res = await makeService({
        publishing: withSwitches({ automationEnabled: master }),
        config: { enabled: scan, metadata: { autoReplyEnabled: reply, replyPolicies: {} } },
      }).service.getOverview(org, 'proj-1');
      expect(res.replies).not.toHaveProperty('active');
      expect(res.replies).not.toHaveProperty('enabled');
      expect(res.replies.scanEnabled).toBe(scan);
      expect(res.replies.autoReplyEnabled).toBe(reply);
      expect(
        res.enabled && res.replies.scanEnabled && res.replies.autoReplyEnabled,
        `master=${master} scan=${scan} reply=${reply}`
      ).toBe(expected);
    }
  });

  it('reads a project still carrying the retired autoReplyMode', async () => {
    // No migration: an untouched row keeps its old key, and must not read as off.
    const res = await makeService({
      publishing: withSwitches({}),
      config: { enabled: true, metadata: { autoReplyMode: 'review', replyPolicies: {} } },
    }).service.getOverview(org, 'proj-1');

    expect(res.replies.autoReplyEnabled).toBe(true);
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
    // Turning the master OFF is a suspension — nothing is rescheduled, and the
    // response says so rather than reporting an empty move.
    expect(res).toEqual({ saved: true, enabled: false, rescheduled: null });
  });

  it('realigns when publishing goes from not-running to running', async () => {
    const { service, alignPlanDraftPublishDates, rescheduleQueuedPlanPosts } =
      makeService();

    await service.saveEnabled(org, 'proj-1', true);

    expect(alignPlanDraftPublishDates).toHaveBeenCalledWith('org-1', 'proj-1');
    expect(rescheduleQueuedPlanPosts).toHaveBeenCalledWith('org-1', 'proj-1');
  });

  it('does not realign when publishing was ALREADY running', async () => {
    const { service, alignPlanDraftPublishDates, rescheduleQueuedPlanPosts } =
      makeService({
        publishing: {
          automationEnabled: true,
          publishingEnabled: true,
          publishingConfigured: true,
          enabledPlatforms: ['x'],
          platformDecisions: { x: true },
          windows: {},
        },
      });

    await service.saveEnabled(org, 'proj-1', true);

    // Nothing transitioned, so nothing may rewrite a schedule that was already
    // running — a no-op save must stay a no-op.
    expect(alignPlanDraftPublishDates).not.toHaveBeenCalled();
    expect(rescheduleQueuedPlanPosts).not.toHaveBeenCalled();
  });

  it('does not realign when the master is switched OFF', async () => {
    const { service, alignPlanDraftPublishDates, rescheduleQueuedPlanPosts } =
      makeService();

    await service.saveEnabled(org, 'proj-1', false);

    // A switch suspends, it does not reset — and it certainly does not reshuffle.
    expect(alignPlanDraftPublishDates).not.toHaveBeenCalled();
    expect(rescheduleQueuedPlanPosts).not.toHaveBeenCalled();
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
    expect(res).toEqual({
      saved: true,
      scheduled: null,
      rescheduled: { moved: 0, skipped: [] },
    });
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
    expect(res).toEqual({
      saved: true,
      scheduled: null,
      rescheduled: { moved: 0, skipped: [] },
    });
  });

  it('realigns DRAFTs before queued posts, and both before the commit', async () => {
    const {
      service,
      alignPlanDraftPublishDates,
      rescheduleQueuedPlanPosts,
      schedulePlanPosts,
    } = makeService();

    await service.savePublishing(org, 'proj-1', {
      platforms: ['x'],
      commit: true,
    });

    // Drafts first: the QUEUE pass measures its minimum gap against them, so
    // spacing against a draft that is itself about to move is spacing against
    // a slot nobody uses.
    expect(alignPlanDraftPublishDates).toHaveBeenCalledWith('org-1', 'proj-1');
    expect(rescheduleQueuedPlanPosts).toHaveBeenCalledWith('org-1', 'proj-1');
    const draftOrder = alignPlanDraftPublishDates.mock.invocationCallOrder[0];
    const queueOrder = rescheduleQueuedPlanPosts.mock.invocationCallOrder[0];
    const commitOrder = schedulePlanPosts.mock.invocationCallOrder[0];
    expect(draftOrder).toBeLessThan(queueOrder);
    expect(queueOrder).toBeLessThan(commitOrder);
  });

  it('reports queued posts it could not move', async () => {
    const { service, rescheduleQueuedPlanPosts } = makeService();
    rescheduleQueuedPlanPosts.mockResolvedValue({
      rescheduled: 2,
      skipped: [{ id: 'p9', reason: 'claimed' }],
      inactive: null,
    });

    const res = await service.savePublishing(org, 'proj-1', { platforms: ['x'] });

    // A scheduled send that could NOT be moved is a real exception to what the
    // user just asked for, so it is named rather than swallowed.
    expect(res.rescheduled).toEqual({
      moved: 2,
      skipped: [{ id: 'p9', reason: 'claimed' }],
    });
  });

  it('still reports the save as successful when a realign throws', async () => {
    const { service, rescheduleQueuedPlanPosts, saveConfigRaw } = makeService();
    rescheduleQueuedPlanPosts.mockRejectedValue(new Error('temporal down'));

    const res = await service.savePublishing(org, 'proj-1', { platforms: ['x'] });

    // The settings ARE saved; tidying the schedule is a follow-up and must not
    // turn a successful write into an error.
    expect(saveConfigRaw).toHaveBeenCalled();
    expect(res.saved).toBe(true);
    expect(res.rescheduled).toBeNull();
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

  it('replaces a platform reply policy and preserves its publishing keys', async () => {
    const { service, saveConfig } = makeService({
      config: {
        metadata: {
          replyPolicies: {
            x: {
              length: 'short',
              defaultStrategy: 'helpful',
              publishingEnabled: true,
              publishingWindowStart: '09:00',
            },
          },
        },
      },
    });

    await service.saveReplies(org, 'proj-1', {
      policies: { x: { length: 'long' } },
    });

    const policies = saveConfig.mock.calls[0][1].replyPolicies as Record<string, any>;
    // `defaultStrategy` is GONE: the incoming policy is the whole reply half of
    // this platform, not a patch on it. The publishing keys stand.
    expect(policies.x).toEqual({
      length: 'long',
      publishingEnabled: true,
      publishingWindowStart: '09:00',
    });
  });

  it('clears the reply policy of every platform the caller omits', async () => {
    // Whole-set semantics. Under a merge, "stop replying on reddit" could not be
    // said at all: the client can only overwrite keys whose names it knows.
    const { service, saveConfig } = makeService({
      config: {
        metadata: {
          replyPolicies: {
            x: { length: 'short' },
            reddit: { autoReplyEnabled: true, checkIntervalMinutes: 30 },
            linkedin: { length: 'long' },
          },
        },
      },
    });

    await service.saveReplies(org, 'proj-1', {
      autoReplyEnabled: true,
      policies: { x: { length: 'long' } },
    });

    expect(saveConfig.mock.calls[0][1].replyPolicies).toEqual({ x: { length: 'long' } });
  });

  it('clears every platform when handed an empty map', async () => {
    const { service, saveConfig } = makeService({
      config: {
        metadata: {
          replyPolicies: {
            x: { length: 'short', defaultStrategy: 'helpful' },
            reddit: { autoReplyEnabled: true },
          },
        },
      },
    });

    await service.saveReplies(org, 'proj-1', { autoReplyEnabled: true, policies: {} });

    expect(saveConfig.mock.calls[0][1].replyPolicies).toEqual({});
  });

  it('keeps the publishing half of a cleared platform', async () => {
    // The column is shared with the publishing endpoint. Dropping whole entries
    // here would delete windows and enablement this endpoint does not own.
    const { service, saveConfig } = makeService({
      config: {
        metadata: {
          replyPolicies: {
            x: { length: 'short' },
            reddit: {
              length: 'long',
              publishingEnabled: true,
              publishingWindowStart: '09:00',
              publishingWindowEnd: '17:00',
              publishingTimezone: 'Asia/Shanghai',
            },
          },
        },
      },
    });

    await service.saveReplies(org, 'proj-1', { policies: { x: { length: 'long' } } });

    // reddit loses its reply policy but keeps its publish window; x is replaced.
    expect(saveConfig.mock.calls[0][1].replyPolicies).toEqual({
      x: { length: 'long' },
      reddit: {
        publishingEnabled: true,
        publishingWindowStart: '09:00',
        publishingWindowEnd: '17:00',
        publishingTimezone: 'Asia/Shanghai',
      },
    });
  });

  it('drops a platform whose entry is left with nothing at all', async () => {
    // An empty object would be a second spelling of "never configured", which an
    // absent entry already means to getOverview.
    const { service, saveConfig } = makeService({
      config: { metadata: { replyPolicies: { x: { length: 'short' } } } },
    });

    await service.saveReplies(org, 'proj-1', { policies: { x: {} } });

    expect(saveConfig.mock.calls[0][1].replyPolicies).toEqual({});
  });

  it('normalizes an incoming platform key instead of storing a second entry', async () => {
    const { service, saveConfig } = makeService({
      config: { metadata: { replyPolicies: { x: { publishingEnabled: true } } } },
    });

    await service.saveReplies(org, 'proj-1', { policies: { X: { length: 'long' } } });

    expect(saveConfig.mock.calls[0][1].replyPolicies).toEqual({
      x: { publishingEnabled: true, length: 'long' },
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

    await service.saveReplies(org, 'proj-1', { autoReplyEnabled: true });

    expect(saveConfig).toHaveBeenCalledWith(org, {
      projectId: 'proj-1',
      enabled: true,
      autoReplyEnabled: true,
    });
  });

  it('turns SCANNING on with replying — replying to nothing is a dead end', async () => {
    // Engage scanning is what produces the opportunities a reply answers. With
    // it off the page would show a switch that is on and permanently idle, and
    // carries no control that explains why.
    const { service, saveConfig } = makeService({
      config: { enabled: false, metadata: { autoReplyEnabled: false, replyPolicies: {} } },
    });

    await service.saveReplies(org, 'proj-1', { autoReplyEnabled: true });

    expect(saveConfig).toHaveBeenCalledWith(org, {
      projectId: 'proj-1',
      enabled: true,
      autoReplyEnabled: true,
    });
  });

  it('leaves scanning alone when replying goes off — the coupling is one-way', async () => {
    // Discovery is the Engage page's own feature. Stopping it would empty that
    // page as a side effect of a decision made on the Automation page, and the
    // switch chain already says turning Automation off stops replying, not
    // finding.
    const { service, saveConfig } = makeService({
      config: { enabled: true, metadata: { autoReplyEnabled: true, replyPolicies: {} } },
    });

    await service.saveReplies(org, 'proj-1', { autoReplyEnabled: false });

    expect(saveConfig).toHaveBeenCalledWith(org, {
      projectId: 'proj-1',
      autoReplyEnabled: false,
    });
  });

  it('leaves scanning alone on a policies-only save', async () => {
    const { service, saveConfig } = makeService({
      config: { enabled: false, metadata: { autoReplyEnabled: false, replyPolicies: {} } },
    });

    await service.saveReplies(org, 'proj-1', { policies: { x: { length: 'long' } } });

    // Editing a platform's policy is not a decision about whether replying runs.
    expect(saveConfig.mock.calls[0][1]).not.toHaveProperty('enabled');
    expect(saveConfig.mock.calls[0][1]).not.toHaveProperty('autoReplyEnabled');
  });

  it('leaves scanning alone when replying goes off — the coupling is one-way', async () => {
    // Discovery is the Engage page's own feature. Stopping it would empty that
    // page as a side effect of a decision made on the Automation page, and the
    // switch chain already says turning Automation off stops replying, not
    // finding.
    const { service, saveConfig } = makeService({
      config: { enabled: true, metadata: { autoReplyEnabled: true, replyPolicies: {} } },
    });

    await service.saveReplies(org, 'proj-1', { autoReplyEnabled: false });

    expect(saveConfig).toHaveBeenCalledWith(org, {
      projectId: 'proj-1',
      autoReplyEnabled: false,
    });
  });

  it('leaves scanning alone on a policies-only save', async () => {
    const { service, saveConfig } = makeService({
      config: { enabled: false, metadata: { autoReplyEnabled: false, replyPolicies: {} } },
    });

    await service.saveReplies(org, 'proj-1', { policies: { x: { length: 'long' } } });

    // Editing a platform's policy is not a decision about whether replying runs.
    expect(saveConfig.mock.calls[0][1]).not.toHaveProperty('enabled');
    expect(saveConfig.mock.calls[0][1]).not.toHaveProperty('autoReplyEnabled');
  });

  it('writes the switch straight through — there is no mode to resolve', async () => {
    const { service, saveConfig, getConfigCore } = makeService();

    await service.saveReplies(org, 'proj-1', { autoReplyEnabled: false });

    expect(saveConfig).toHaveBeenCalledWith(org, {
      projectId: 'proj-1',
      autoReplyEnabled: false,
    });
    // Nothing has to be read to decide the write, so a bare switch flip stays a
    // single round trip. The retired tri-state needed the current row to answer
    // "which mode does ON mean"; a boolean does not.
    expect(getConfigCore).not.toHaveBeenCalled();
  });

  it('switches ON without reading the row either', async () => {
    const { service, saveConfig, getConfigCore } = makeService({ config: null });

    await service.saveReplies(org, 'proj-1', { autoReplyEnabled: true });

    expect(saveConfig).toHaveBeenCalledWith(org, {
      projectId: 'proj-1',
      enabled: true,
      autoReplyEnabled: true,
    });
    expect(getConfigCore).not.toHaveBeenCalled();
  });
  it('never writes per-account settings', async () => {
    // `IntegrationProject.engageEnabled` is an Engage setting that no gate even
    // reads. Writing it from a managed-reply save meant this page silently
    // reached into another feature's configuration for every account at once.
    const { service, upsertReplyAccountSettings } = makeService();

    const res = await service.saveReplies(org, 'proj-1', { autoReplyEnabled: true });

    expect(upsertReplyAccountSettings).not.toHaveBeenCalled();
    expect(res).toEqual({ saved: true });
  });
});

// The payload states each platform once, with both halves of its state, instead
// of a `platforms` array beside a parallel `windows` map (publishing) or an
// `accounts` list the client had to join by providerIdentifier (replies).
describe('AutomationService.getOverview — one entry per platform', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('hoists the timezone when every window agrees, and states it once', async () => {
    const { service } = makeService({
      publishing: {
        automationEnabled: true,
        publishingEnabled: true,
        publishingConfigured: true,
        enabledPlatforms: ['x', 'reddit'],
        platformDecisions: { x: true, reddit: true, linkedin: false },
        windows: {
          x: { windowStart: '09:00', windowEnd: '18:00', timezone: 'Asia/Taipei' },
          reddit: { windowStart: '07:00', windowEnd: '12:00', timezone: 'Asia/Taipei' },
          linkedin: { windowStart: '09:00', windowEnd: '18:00', timezone: 'Asia/Taipei' },
        },
      },
    });

    const res = await service.getOverview(org, 'proj-1');

    expect(res.publishing.timezone).toBe('Asia/Taipei');
    // Stated once above, so no window repeats it.
    for (const entry of Object.values(res.publishing.platforms)) {
      expect(entry.window).not.toHaveProperty('timezone');
    }
  });

  it('keeps a divergent zone on the window that diverges', async () => {
    const { service } = makeService({
      publishing: {
        automationEnabled: true,
        publishingEnabled: true,
        publishingConfigured: true,
        enabledPlatforms: ['x', 'linkedin'],
        platformDecisions: { x: true, linkedin: true },
        windows: {
          x: { windowStart: '09:00', windowEnd: '18:00', timezone: 'Asia/Taipei' },
          linkedin: { windowStart: '08:00', windowEnd: '20:00', timezone: 'America/New_York' },
        },
      },
    });

    const res = await service.getOverview(org, 'proj-1');

    // No unanimous zone, so nothing is hoisted and each states its own — a
    // hoisted default here would misstate one of the two.
    expect(res.publishing.timezone).toBeUndefined();
    expect(res.publishing.platforms.x.window).toMatchObject({ timezone: 'Asia/Taipei' });
    expect(res.publishing.platforms.linkedin.window).toMatchObject({ timezone: 'America/New_York' });
  });

  it('does not hoist a zone onto a window that has none', async () => {
    // A window with no zone is UTC, not "unset" — it does not agree with a
    // sibling that names one, and hoisting would state the wrong zone for it.
    const { service } = makeService({
      publishing: {
        automationEnabled: true,
        publishingEnabled: true,
        publishingConfigured: true,
        enabledPlatforms: ['x', 'reddit'],
        platformDecisions: { x: true, reddit: true },
        windows: {
          x: { windowStart: '09:00', windowEnd: '18:00', timezone: 'Asia/Taipei' },
          reddit: { windowStart: '07:00', windowEnd: '12:00' },
        },
      },
    });

    const res = await service.getOverview(org, 'proj-1');

    expect(res.publishing.timezone).toBeUndefined();
    expect(res.publishing.platforms.x.window).toMatchObject({ timezone: 'Asia/Taipei' });
    expect(res.publishing.platforms.reddit.window).not.toHaveProperty('timezone');
  });

  it('surfaces a platform that has only an admin window and no decision', async () => {
    // `enabled` absent = the project never decided. The window still has to show,
    // or the dialog would render its default hours for a platform an admin has
    // actually restricted.
    const { service } = makeService({
      publishing: {
        automationEnabled: true,
        publishingEnabled: false,
        publishingConfigured: false,
        enabledPlatforms: null,
        platformDecisions: {},
        windows: { linkedin: { windowStart: '08:00', windowEnd: '20:00' } },
      },
    });

    const res = await service.getOverview(org, 'proj-1');

    expect(res.publishing.platforms.linkedin).toEqual({
      window: { start: '08:00', end: '20:00' },
    });
    expect(res.publishing.platforms.linkedin).not.toHaveProperty('enabled');
  });

  it('omits reply accounts entirely — Automation never picks an account', async () => {
    // Everything sends through the extension's own browser session, so the
    // identity is whoever the user is signed in as. Choosing a specific account
    // is a per-post edit on a different surface.
    const { service } = makeService({
      config: {
        enabled: true,
        metadata: { autoReplyEnabled: true, replyPolicies: { x: { autoReplyEnabled: true } } },
      },
    });

    const res = await service.getOverview(org, 'proj-1');

    expect(res.replies.platforms.x).toMatchObject({ autoReplyEnabled: true });
    expect(res.replies.platforms.x).not.toHaveProperty('accounts');
  });
});

// The next time AIsee will check a platform for reply opportunities — the same
// anchor and interval the driver itself gates on
// (EngageAutoReplyService.getDueReplies), so this can never disagree with what
// the driver actually does.
describe('AutomationService.getOverview — replies.platforms[].nextCheckAt', () => {
  beforeEach(() => vi.restoreAllMocks());

  const withSwitches = (over: Record<string, unknown>) => ({
    automationEnabled: true,
    publishingEnabled: true,
    publishingConfigured: true,
    enabledPlatforms: ['x'],
    platformDecisions: { x: true },
    windows: {},
    ...over,
  });

  const activeConfig = {
    enabled: true,
    metadata: {
      autoReplyEnabled: true,
      replyPolicies: { x: { autoReplyEnabled: true } },
    },
  };

  it('is null when the platform has never replied before, minus the master switch', async () => {
    const { service } = makeService({
      config: activeConfig,
      publishing: withSwitches({ automationEnabled: false }),
    });

    const res = await service.getOverview(org, 'proj-1');

    expect(res.replies.platforms.x.nextCheckAt).toBeNull();
  });

  it('is null when scanning is off, even with replying and the platform both on', async () => {
    const { service } = makeService({
      config: { ...activeConfig, enabled: false },
      publishing: withSwitches({}),
    });

    const res = await service.getOverview(org, 'proj-1');

    expect(res.replies.platforms.x.nextCheckAt).toBeNull();
  });

  it('is null when the platform itself never turned replying on', async () => {
    const { service } = makeService({
      config: {
        enabled: true,
        metadata: {
          autoReplyEnabled: true,
          replyPolicies: { x: { autoReplyEnabled: false } },
        },
      },
      publishing: withSwitches({}),
    });

    const res = await service.getOverview(org, 'proj-1');

    expect(res.replies.platforms.x.nextCheckAt).toBeNull();
  });

  it('is "now" for an active platform that has never sent a reply', async () => {
    const now = new Date('2026-08-21T10:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const { service } = makeService({
        config: activeConfig,
        publishing: withSwitches({}),
      });

      const res = await service.getOverview(org, 'proj-1');

      expect(res.replies.platforms.x.nextCheckAt).toBe(now.toISOString());
    } finally {
      vi.useRealTimers();
    }
  });

  it('is lastSentReplyAt + checkIntervalMinutes when the platform overrides the interval', async () => {
    const lastSentAt = new Date('2026-08-21T08:00:00.000Z');
    const { service, getLastSentReplyAtByPlatform } = makeService({
      config: {
        enabled: true,
        metadata: {
          autoReplyEnabled: true,
          replyPolicies: {
            x: { autoReplyEnabled: true, checkIntervalMinutes: 480 },
          },
        },
      },
      publishing: withSwitches({}),
      pacing: { minGapMinutes: 25 },
      lastSentAtByPlatform: { x: lastSentAt },
    });

    const res = await service.getOverview(org, 'proj-1');

    expect(getLastSentReplyAtByPlatform).toHaveBeenCalledWith('org-1', 'proj-1', ['x']);
    expect(res.replies.platforms.x.nextCheckAt).toBe(
      new Date(lastSentAt.getTime() + 480 * 60_000).toISOString()
    );
  });

  it('falls back to the org-wide pacing default when the platform sets no interval', async () => {
    const lastSentAt = new Date('2026-08-21T08:00:00.000Z');
    const { service } = makeService({
      config: activeConfig,
      publishing: withSwitches({}),
      pacing: { minGapMinutes: 25 },
      lastSentAtByPlatform: { x: lastSentAt },
    });

    const res = await service.getOverview(org, 'proj-1');

    expect(res.replies.platforms.x.nextCheckAt).toBe(
      new Date(lastSentAt.getTime() + 25 * 60_000).toISOString()
    );
  });
});

// The status banner reports when the project last actually published. It
// previously showed a hardcoded "Just now" beside a hardcoded "In 24 min"
// countdown — neither measured anything, so both read as facts while being
// decoration.
describe('AutomationService.getOverview — lastPublishedAt', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('reports the last publish time as an ISO string', async () => {
    const when = new Date('2026-08-19T07:30:00.000Z');
    const { service, getLastPublishedAt } = makeService({ lastPublishedAt: when });

    const res = await service.getOverview(org, 'proj-1');

    expect(getLastPublishedAt).toHaveBeenCalledWith('org-1', 'proj-1');
    expect(res.lastPublishedAt).toBe('2026-08-19T07:30:00.000Z');
  });

  it('reports null for a project that has never published', async () => {
    // Distinct from "0 minutes ago" — the banner has to be able to say "None
    // yet" rather than implying something just went out.
    const { service } = makeService({ lastPublishedAt: null });

    expect((await service.getOverview(org, 'proj-1')).lastPublishedAt).toBeNull();
  });

  it('asks for it project-wide, not per plan', async () => {
    // Engage replies are Post rows with no operationPlanId; scoping the lookup
    // to a plan would make a project that only replies look inactive.
    const { service, getLastPublishedAt } = makeService();

    await service.getOverview(org, 'proj-1');

    expect(getLastPublishedAt).toHaveBeenCalledWith('org-1', 'proj-1');
  });
});
