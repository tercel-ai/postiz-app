import { describe, it, expect, vi } from 'vitest';
import {
  EngageService,
  ENGAGE_REPLY_ACCOUNT_DAILY_CAP_KEY,
} from '@gitroom/nestjs-libraries/engage/engage.service';

/**
 * §6/§6.1 reply pacing gate: a send/schedule must be blocked BEFORE the
 * platform-side publish call when either the project's active-plan daily
 * hard cap or an account's per-account daily cap would be exceeded — and the
 * opportunity claim must be released (rolled back), not left dangling.
 *
 * Every test calls buildService() FIRST, then configures the returned mocks
 * — buildService() constructs fresh vi.fn()s each call, so setting
 * expectations beforehand would configure a stale, discarded mock.
 */
describe('EngageService reply pacing gate (§6/§6.1)', () => {
  const org = { id: 'org-1' } as any;

  function buildService() {
    const claim = vi.fn(async () => ({
      opp: { externalPostId: 'tweet-1', platform: 'x', matchedKeywords: ['react'] },
      priorStatus: 'NEW',
    }));
    const releaseClaim = vi.fn(async () => undefined);
    const createPost = vi.fn(async () => [{ postId: 'post-1' }]);
    const countProjectSentRepliesToday = vi.fn(async () => 0);
    const countProjectKeywordSentRepliesToday = vi.fn(async () => 0);
    const countAccountSentRepliesToday = vi.fn(async () => 0);
    const getActivePlan = vi.fn(async () => null);
    const settingsGet = vi.fn(async () => undefined);
    const createManualXPost = vi.fn(async () => ({ id: 'manual-post-1' }));

    const engageRepository = {
      claimOpportunityForReply: claim,
      releaseOpportunityClaim: releaseClaim,
      deletePostById: vi.fn(async () => undefined),
      createSentReply: vi.fn(async (data: any) => ({ id: 'reply-1', ...data })),
      countProjectSentRepliesToday,
      countProjectKeywordSentRepliesToday,
      countAccountSentRepliesToday,
      createManualXPost,
    } as any;
    const postsService = { createPost } as any;
    const temporalService = { client: undefined } as any;
    const operationPlanRepository = { getActivePlan } as any;
    const settingsService = { get: settingsGet } as any;

    const postOverageService = {
      deductIfOverage: vi.fn(async () => undefined),
    } as any;

    const service = new EngageService(
      engageRepository,
      temporalService,
      postsService,
      postOverageService,
      {} as any,
      undefined,
      operationPlanRepository,
      settingsService
    );

    return {
      service,
      claim,
      releaseClaim,
      createPost,
      countProjectSentRepliesToday,
      countProjectKeywordSentRepliesToday,
      countAccountSentRepliesToday,
      getActivePlan,
      settingsGet,
      createManualXPost,
    };
  }

  const sendBody = {
    integrationId: 'int-1',
    draftContent: 'hello',
    strategy: 'EXPERT_ANSWER',
    brandStrength: 1,
    projectId: 'proj-1',
  };

  it('allows the send and calls createPost when nothing is over any limit', async () => {
    const { service, createPost, releaseClaim } = buildService();
    await service.sendReply(org, 'user-1', 'opp-1', sendBody as any);
    expect(createPost).toHaveBeenCalledTimes(1);
    expect(releaseClaim).not.toHaveBeenCalled();
  });

  it('blocks the send BEFORE createPost when the project daily hard cap would be exceeded, and releases the claim', async () => {
    const { service, createPost, releaseClaim, getActivePlan, countProjectSentRepliesToday } =
      buildService();
    getActivePlan.mockResolvedValue({
      planPayload: {
        engagePolicies: [{ platform: 'x', enabled: true, dailyHardCap: 5 }],
      },
    });
    countProjectSentRepliesToday.mockResolvedValue(5); // already at target

    await expect(
      service.sendReply(org, 'user-1', 'opp-1', sendBody as any)
    ).rejects.toMatchObject({
      response: { code: 'engage_daily_hard_cap_reached' },
    });

    expect(createPost).not.toHaveBeenCalled();
    expect(releaseClaim).toHaveBeenCalledWith('org-1', 'opp-1', 'NEW', 'proj-1');
  });

  it('allows the send when under the project daily hard cap', async () => {
    const { service, createPost, getActivePlan, countProjectSentRepliesToday } = buildService();
    getActivePlan.mockResolvedValue({
      planPayload: {
        engagePolicies: [{ platform: 'x', enabled: true, dailyHardCap: 5 }],
      },
    });
    countProjectSentRepliesToday.mockResolvedValue(4); // one below target

    await service.sendReply(org, 'user-1', 'opp-1', sendBody as any);
    expect(createPost).toHaveBeenCalledTimes(1);
  });

  it('does not gate on a project hard cap when there is no active plan', async () => {
    const { service, createPost, getActivePlan, countProjectSentRepliesToday } = buildService();
    getActivePlan.mockResolvedValue(null);

    await service.sendReply(org, 'user-1', 'opp-1', sendBody as any);
    expect(createPost).toHaveBeenCalledTimes(1);
    expect(countProjectSentRepliesToday).not.toHaveBeenCalled();
  });

  it('does not gate on a project hard cap when the request carries no projectId (legacy)', async () => {
    const { service, createPost, getActivePlan } = buildService();

    await service.sendReply(
      org,
      'user-1',
      'opp-1',
      { ...sendBody, projectId: undefined } as any
    );
    expect(getActivePlan).not.toHaveBeenCalled();
    expect(createPost).toHaveBeenCalledTimes(1);
  });

  it('ignores a disabled policy for the matching platform', async () => {
    const { service, createPost, getActivePlan, countProjectSentRepliesToday } = buildService();
    getActivePlan.mockResolvedValue({
      planPayload: {
        engagePolicies: [{ platform: 'x', enabled: false, dailyHardCap: 1 }],
      },
    });
    countProjectSentRepliesToday.mockResolvedValue(99);

    await service.sendReply(org, 'user-1', 'opp-1', sendBody as any);
    expect(createPost).toHaveBeenCalledTimes(1);
  });

  it('blocks the send when the per-account daily cap is reached, using the configured Settings value', async () => {
    const { service, createPost, settingsGet, countAccountSentRepliesToday } = buildService();
    settingsGet.mockImplementation(async (key: string) =>
      key === ENGAGE_REPLY_ACCOUNT_DAILY_CAP_KEY ? 3 : undefined
    );
    countAccountSentRepliesToday.mockResolvedValue(3); // at cap

    await expect(
      service.sendReply(org, 'user-1', 'opp-1', sendBody as any)
    ).rejects.toMatchObject({
      response: { code: 'engage_account_daily_cap_reached' },
    });
    expect(createPost).not.toHaveBeenCalled();
    expect(countAccountSentRepliesToday).toHaveBeenCalledWith(
      'int-1',
      expect.any(Date),
      expect.any(Date)
    );
  });

  it('enforces targetRepliesPerDay as the daily hard cap (the field the plan actually generates)', async () => {
    const { service, createPost, releaseClaim, getActivePlan, countProjectSentRepliesToday } =
      buildService();
    getActivePlan.mockResolvedValue({
      planPayload: {
        engagePolicies: [{ platform: 'x', enabled: true, targetRepliesPerDay: 5 }],
      },
    });
    countProjectSentRepliesToday.mockResolvedValue(5); // at target

    await expect(
      service.sendReply(org, 'user-1', 'opp-1', sendBody as any)
    ).rejects.toMatchObject({
      response: { code: 'engage_daily_hard_cap_reached', hardCap: 5 },
    });
    expect(createPost).not.toHaveBeenCalled();
    expect(releaseClaim).toHaveBeenCalledWith('org-1', 'opp-1', 'NEW', 'proj-1');
  });

  it('allows the send when under targetRepliesPerDay', async () => {
    const { service, createPost, getActivePlan, countProjectSentRepliesToday } = buildService();
    getActivePlan.mockResolvedValue({
      planPayload: {
        engagePolicies: [{ platform: 'x', enabled: true, targetRepliesPerDay: 5 }],
      },
    });
    countProjectSentRepliesToday.mockResolvedValue(4);

    await service.sendReply(org, 'user-1', 'opp-1', sendBody as any);
    expect(createPost).toHaveBeenCalledTimes(1);
  });

  it('enforces the tighter of targetRepliesPerDay and an optional dailyHardCap', async () => {
    const { service, createPost, getActivePlan, countProjectSentRepliesToday } = buildService();
    // target 10 but a stricter safety hardCap of 3 → effective cap is 3.
    getActivePlan.mockResolvedValue({
      planPayload: {
        engagePolicies: [
          { platform: 'x', enabled: true, targetRepliesPerDay: 10, dailyHardCap: 3 },
        ],
      },
    });
    countProjectSentRepliesToday.mockResolvedValue(3);

    await expect(
      service.sendReply(org, 'user-1', 'opp-1', sendBody as any)
    ).rejects.toMatchObject({
      response: { code: 'engage_daily_hard_cap_reached', hardCap: 3 },
    });
    expect(createPost).not.toHaveBeenCalled();
  });

  // P2(9): the plan can pace weekdays and weekends differently via dated
  // dailyTargets; the gate must resolve the target for the day being sent, not
  // the flat default.
  it('uses the dailyTargets override for the send day instead of targetRepliesPerDay', async () => {
    const { service, createPost, getActivePlan, countProjectSentRepliesToday } = buildService();
    const day = new Date().toISOString().slice(0, 10); // today, UTC
    getActivePlan.mockResolvedValue({
      planPayload: {
        engagePolicies: [
          {
            platform: 'x',
            enabled: true,
            targetRepliesPerDay: 10, // generous default...
            dailyTargets: [{ date: day, target: 2 }], // ...but only 2 today
          },
        ],
      },
    });
    countProjectSentRepliesToday.mockResolvedValue(2); // already at today's override

    await expect(
      service.sendReply(org, 'user-1', 'opp-1', sendBody as any)
    ).rejects.toMatchObject({
      response: { code: 'engage_daily_hard_cap_reached', hardCap: 2 },
    });
    expect(createPost).not.toHaveBeenCalled();
  });

  it('falls back to targetRepliesPerDay when no dailyTargets entry matches the send day', async () => {
    const { service, createPost, getActivePlan, countProjectSentRepliesToday } = buildService();
    getActivePlan.mockResolvedValue({
      planPayload: {
        engagePolicies: [
          {
            platform: 'x',
            enabled: true,
            targetRepliesPerDay: 10,
            dailyTargets: [{ date: '1999-01-01', target: 1 }], // some other day
          },
        ],
      },
    });
    countProjectSentRepliesToday.mockResolvedValue(5); // under the default of 10

    await service.sendReply(org, 'user-1', 'opp-1', sendBody as any);
    expect(createPost).toHaveBeenCalledTimes(1);
  });

  it('enforces a dailyTargets override of 0 as "send nothing this day"', async () => {
    const { service, createPost, getActivePlan } = buildService();
    const day = new Date().toISOString().slice(0, 10);
    getActivePlan.mockResolvedValue({
      planPayload: {
        engagePolicies: [
          {
            platform: 'x',
            enabled: true,
            targetRepliesPerDay: 10,
            dailyTargets: [{ date: day, target: 0 }],
          },
        ],
      },
    });

    await expect(
      service.sendReply(org, 'user-1', 'opp-1', sendBody as any)
    ).rejects.toMatchObject({
      response: { code: 'engage_daily_hard_cap_reached', hardCap: 0 },
    });
    expect(createPost).not.toHaveBeenCalled();
  });

  it('blocks when a matched keyword would exceed its per-keyword target', async () => {
    const {
      service,
      createPost,
      releaseClaim,
      getActivePlan,
      countProjectKeywordSentRepliesToday,
    } = buildService();
    // Aggregate target is generous (10) but keyword "react" is capped at 2.
    getActivePlan.mockResolvedValue({
      planPayload: {
        engagePolicies: [
          {
            platform: 'x',
            enabled: true,
            targetRepliesPerDay: 10,
            keywordTargets: { react: 2 },
          },
        ],
      },
    });
    countProjectKeywordSentRepliesToday.mockResolvedValue(2); // at the keyword cap

    await expect(
      service.sendReply(org, 'user-1', 'opp-1', sendBody as any)
    ).rejects.toMatchObject({
      response: { code: 'engage_daily_keyword_target_reached', keyword: 'react', target: 2 },
    });
    expect(createPost).not.toHaveBeenCalled();
    expect(releaseClaim).toHaveBeenCalledWith('org-1', 'opp-1', 'NEW', 'proj-1');
    expect(countProjectKeywordSentRepliesToday).toHaveBeenCalledWith(
      'org-1',
      'proj-1',
      'x',
      'react',
      expect.any(Date),
      expect.any(Date)
    );
  });

  it('ignores per-keyword targets for keywords the opportunity did not match', async () => {
    const { service, createPost, getActivePlan, countProjectKeywordSentRepliesToday } =
      buildService();
    // opportunity matched ['react'] (see claim mock); only "vue" is capped.
    getActivePlan.mockResolvedValue({
      planPayload: {
        engagePolicies: [
          { platform: 'x', enabled: true, keywordTargets: { vue: 1 } },
        ],
      },
    });

    await service.sendReply(org, 'user-1', 'opp-1', sendBody as any);
    expect(createPost).toHaveBeenCalledTimes(1);
    expect(countProjectKeywordSentRepliesToday).not.toHaveBeenCalled();
  });

  it('includes every item in the current batch when checking account capacity', async () => {
    const { service, createPost, settingsGet, countAccountSentRepliesToday } = buildService();
    settingsGet.mockResolvedValue(3);
    countAccountSentRepliesToday.mockResolvedValue(2);

    await expect(
      service.batchSendReply(org, 'user-1', 'opp-1', {
        projectId: 'proj-1',
        items: [
          { integrationId: 'int-1', draftContent: 'a', strategy: 'EXPERT_ANSWER', brandStrength: 1 },
          { integrationId: 'int-1', draftContent: 'b', strategy: 'EXPERT_ANSWER', brandStrength: 1 },
        ],
      } as any)
    ).rejects.toMatchObject({ response: { code: 'engage_account_daily_cap_reached' } });
    expect(createPost).not.toHaveBeenCalled();
  });

  it('falls back to the default cap when no Settings value is configured', async () => {
    const { service, countAccountSentRepliesToday } = buildService();
    countAccountSentRepliesToday.mockResolvedValue(50); // == DEFAULT_REPLY_ACCOUNT_DAILY_CAP

    await expect(
      service.sendReply(org, 'user-1', 'opp-1', sendBody as any)
    ).rejects.toMatchObject({
      response: { code: 'engage_account_daily_cap_reached', cap: 50 },
    });
  });

  it('checks every distinct integration in a batch, not just the first', async () => {
    const { service, createPost, settingsGet, countAccountSentRepliesToday } = buildService();
    countAccountSentRepliesToday.mockImplementation(async (integrationId: string) =>
      integrationId === 'int-2' ? 999 : 0
    );
    settingsGet.mockImplementation(async (key: string) =>
      key === ENGAGE_REPLY_ACCOUNT_DAILY_CAP_KEY ? 1 : undefined
    );

    await expect(
      service.batchSendReply(org, 'user-1', 'opp-1', {
        projectId: 'proj-1',
        items: [
          { integrationId: 'int-1', draftContent: 'a', strategy: 'EXPERT_ANSWER', brandStrength: 1 },
          { integrationId: 'int-2', draftContent: 'b', strategy: 'EXPERT_ANSWER', brandStrength: 1 },
        ],
      } as any)
    ).rejects.toMatchObject({
      response: { code: 'engage_account_daily_cap_reached' },
    });
    expect(createPost).not.toHaveBeenCalled();
  });

  it('does NOT gate confirmManualReply on pacing — a manual reply already happened outside Postiz', async () => {
    const { service, settingsGet, countAccountSentRepliesToday } = buildService();
    settingsGet.mockImplementation(async (key: string) =>
      key === ENGAGE_REPLY_ACCOUNT_DAILY_CAP_KEY ? 1 : undefined
    );
    countAccountSentRepliesToday.mockResolvedValue(999); // way over cap

    const result = await service.confirmManualReply(org, 'user-1', 'opp-1', {
      draftContent: 'already posted',
      strategy: 'EXPERT_ANSWER',
      brandStrength: 1,
      projectId: 'proj-1',
    } as any);
    expect(result).toBeDefined();
  });

  it('skips the gate entirely (never throws) when OperationPlanRepository/SettingsService are not wired', async () => {
    const claim = vi.fn(async () => ({
      opp: { externalPostId: 'tweet-1', platform: 'x', matchedKeywords: ['react'] },
      priorStatus: 'NEW',
    }));
    const createPost = vi.fn(async () => [{ postId: 'post-1' }]);
    const engageRepository = {
      claimOpportunityForReply: claim,
      releaseOpportunityClaim: vi.fn(async () => undefined),
      deletePostById: vi.fn(async () => undefined),
      createSentReply: vi.fn(async (data: any) => ({ id: 'reply-1', ...data })),
    } as any;
    const service = new EngageService(
      engageRepository,
      { client: undefined } as any,
      { createPost } as any,
      {} as any,
      {} as any
      // _scanConfig, _operationPlanRepository, _settingsService all omitted
    );
    await service.sendReply(org, 'user-1', 'opp-1', sendBody as any);
    expect(createPost).toHaveBeenCalledTimes(1);
  });
});
