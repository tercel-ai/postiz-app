import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EngageAutoReplyService,
  DEFAULT_REPLY_PACING,
  withinLocalWindow,
} from '../engage-auto-reply.service';
import {
  DEFAULT_CHANNEL_DAILY_LIMIT,
  ENGAGE_REPLY_CHANNEL_LIMIT_KEY,
  ENGAGE_REPLY_DAILY_CEILING_KEY,
  ENGAGE_REPLY_WARMUP_KEY,
  PLATFORM_REPLY_RISK_CEILING,
} from '../engage-reply-schedule';

// The unattended reply DRIVER. By default (ENGAGE_REPLY_BUDGET_GATE_ENABLED
// unset) it is paced by interval/active-hours alone and does not require an
// operation plan. With the flag set to 'true' it additionally never hands out
// more than the send-time gate would let through (both read
// EngageService.getReplyBudget), and never invents a target for a project
// whose plan does not set one.

const org = { id: 'org-1' } as any;

// Every policy now has active hours — the default 8 AM–6 PM when it set none —
// so a spec that lets the driver read the wall clock passes or fails depending
// on what time the suite runs at. Cases that are not ABOUT the window pin this
// one instead.
const DURING_ACTIVE_HOURS = new Date('2026-08-18T12:00:00Z');

function makeService(over: {
  configs?: any[];
  budget?: any;
  candidates?: any[];
  lastSentAt?: Date | null;
  pacing?: Partial<typeof DEFAULT_REPLY_PACING>;
  opportunity?: any;
  queued?: any[];
  queuedCount?: number;
  eligibleCount?: number;
  /** Last write on this platform by ANY track, org-wide (the floor's clock). */
  lastPlatformWriteAt?: Date | null;
  /** The platform floor in minutes; 0 (the default) takes it out of the way. */
  writeFloorMinutes?: number;
  /** Whether the platform's write window allows writing now. */
  withinWriteWindow?: boolean;
  /** Replies already sent today for this project+platform (the daily limit's count). */
  sentToday?: number;
  /** The admin `engage_reply_daily_ceiling` setting, if a case is about it. */
  ceilings?: Record<string, number>;
  /** The admin `engage_reply_warmup` ladder, if a case is about it. */
  warmupTiers?: { days: number; factor: number }[];
  /** The admin `engage_reply_channel_daily_limit` map, if a case is about it. */
  channelDailyLimits?: Record<string, number>;
  /** When this org first replied on the platform — the warm-up clock. */
  firstSentAt?: Date | null;
  /** Today's reply count per channel, for the same-channel cap. */
  repliesByChannel?: Record<string, number>;
} = {}) {
  const repo = {
    getAutoReplyConfigs: vi.fn().mockResolvedValue(over.configs ?? []),
    pickAutoReplyCandidates: vi.fn().mockResolvedValue(over.candidates ?? []),
    claimAutoReplyCandidate: vi.fn().mockResolvedValue(true),
    releaseAutoReplyCandidate: vi.fn().mockResolvedValue(undefined),
    getLastSentReplyAt: vi.fn().mockResolvedValue(over.lastSentAt ?? null),
    getLastPlatformWriteAt: vi
      .fn()
      .mockResolvedValue(over.lastPlatformWriteAt ?? null),
    claimDueEngageReplies: vi.fn().mockResolvedValue(over.queued ?? []),
    countQueuedEngageReplies: vi.fn().mockResolvedValue(over.queuedCount ?? 0),
    countEligibleOpportunities: vi.fn().mockResolvedValue(over.eligibleCount ?? 0),
    // The day's tally behind the reply limit. 0 by default so the specs below
    // exercise the other gates in isolation; the cases that are ABOUT the limit
    // set it.
    countProjectSentRepliesToday: vi.fn().mockResolvedValue(over.sentToday ?? 0),
    // Fully warmed up by default (a year of driving), so the specs below
    // exercise the configured limits rather than the ramp.
    getFirstSentReplyAt: vi
      .fn()
      .mockResolvedValue(
        over.firstSentAt === undefined
          ? new Date('2025-01-01T00:00:00.000Z')
          : over.firstSentAt
      ),
    // The gate reads the clock for every configured platform in ONE call; the
    // status endpoint still reads it per platform. Both are mocked off the same
    // `firstSentAt` override so a case cannot set one and forget the other.
    getFirstSentReplyAtByPlatform: vi
      .fn()
      .mockImplementation(async (_orgId: string, platforms: string[]) => {
        const at =
          over.firstSentAt === undefined
            ? new Date('2025-01-01T00:00:00.000Z')
            : over.firstSentAt;
        if (!at) return {};
        return Object.fromEntries(platforms.map((platform) => [platform, at]));
      }),
    countTodayRepliesByChannel: vi
      .fn()
      .mockResolvedValue(over.repliesByChannel ?? {}),
  } as any;

  const engage = {
    getReplyBudget: vi
      .fn()
      .mockResolvedValue(
        over.budget ?? { cap: null, sentToday: 0, remaining: null, keywords: [] }
      ),
    getOpportunityForReply: vi.fn().mockResolvedValue(
      over.opportunity ?? {
        id: 'opp-1',
        platform: 'reddit',
        externalPostUrl: 'https://reddit.com/r/x/comments/1',
      }
    ),
    reserveReplyGeneration: vi.fn().mockResolvedValue({ cost: 3, taskId: 'task-1' }),
    settleReplyGeneration: vi.fn().mockResolvedValue(undefined),
    releaseReplyGeneration: vi.fn().mockResolvedValue(undefined),
    saveDraft: vi.fn().mockResolvedValue({ id: 'sent-1' }),
    queueAutoReply: vi.fn().mockResolvedValue({ id: 'sent-1' }),
  } as any;

  const draft = {
    generateDraft: vi.fn().mockImplementation(async function* () {
      yield 'a thoughtful reply';
    }),
  } as any;

  // Keyed, not one blanket value: the service reads two settings now (pacing and
  // the per-platform daily ceilings), and answering both with the pacing object
  // would hand the ceiling resolver a shape it can only discard.
  const settings = {
    get: vi.fn().mockImplementation(async (key: string) => {
      if (key === ENGAGE_REPLY_DAILY_CEILING_KEY) return over.ceilings ?? null;
      if (key === ENGAGE_REPLY_WARMUP_KEY) return over.warmupTiers ?? null;
      if (key === ENGAGE_REPLY_CHANNEL_LIMIT_KEY) {
        return over.channelDailyLimits ?? null;
      }
      return { ...DEFAULT_REPLY_PACING, ...(over.pacing ?? {}) };
    }),
    set: vi.fn().mockResolvedValue(undefined),
  } as any;

  // The platform write floor. Defaults to 0 so the specs below exercise the
  // per-project cadence in isolation; the cases that are ABOUT the floor
  // override it.
  // The driver resolves the config ONCE per call and then uses the pure
  // variants, so the mock mirrors that shape. getPlatformPacing's return value
  // is opaque here — the pure methods are stubbed directly.
  const platformPacing = {
    getPlatformPacing: vi.fn().mockResolvedValue({ default: {}, platforms: {} }),
    getWriteFloorMinutes: vi.fn().mockResolvedValue(over.writeFloorMinutes ?? 0),
    writeFloorMinutesFor: vi.fn().mockReturnValue(over.writeFloorMinutes ?? 0),
    // Unconstrained by default — the out-of-the-box state. Cases about the
    // window set it explicitly.
    isWithinWriteWindow: vi.fn().mockResolvedValue(over.withinWriteWindow ?? true),
    isWithinWriteWindowFor: vi.fn().mockReturnValue(over.withinWriteWindow ?? true),
  } as any;

  return {
    svc: new EngageAutoReplyService(repo, engage, draft, settings, platformPacing),
    repo,
    engage,
    draft,
    platformPacing,
  };
}

// A project opted in AND with the platform's policy switched on. Both gates are
// required: autoReplyMode says whether this project replies unattended at all,
// replyPolicies[platform] says where.
const enabledConfig = {
  id: 'cfg-1',
  projectId: 'proj-1',
  replyPolicies: {
    reddit: { autoReplyEnabled: true },
    x: { autoReplyEnabled: true },
  },
};
const budgetWith = (over: any = {}) => ({
  cap: 5,
  sentToday: 1,
  remaining: 4,
  keywords: [],
  ...over,
});

describe('EngageAutoReplyService.getDueReplies', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllEnvs());

  it('drafts one reply and parks it as a QUEUE row', async () => {
    const { svc, engage } = makeService({
      // Single platform: the per-platform maxPerPoll cap is exercised separately
      // below, this test is only about the draft/persist sequence.
      configs: [{ ...enabledConfig, replyPolicies: { reddit: { autoReplyEnabled: true } } }],
      budget: budgetWith(),
      candidates: [{ opportunityId: 'opp-1', score: 90, matchedKeywords: ['geo'] }],
    });

    const due = await svc.getDueReplies(org, new Date('2026-08-18T12:00:00Z'));

    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({
      sentReplyId: 'sent-1',
      opportunityId: 'opp-1',
      projectId: 'proj-1',
      platform: 'reddit',
      url: 'https://reddit.com/r/x/comments/1',
      text: 'a thoughtful reply',
    });
    // Gone from the wire: the version floor (ExtensionVersionGuard) means the
    // API carries one contract, so a retired field is deleted rather than
    // shimmed forever for builds that might still read it.
    expect(due[0]).not.toHaveProperty('mode');
    // The QUEUE row is the commit point — it is what stops the next poll from
    // drafting the same opportunity again, and what the claim lane picks up.
    expect(engage.queueAutoReply).toHaveBeenCalledTimes(1);
  });

  it('does not generate when another worker has already claimed the candidate', async () => {
    const { svc, repo, engage, draft } = makeService({
      configs: [enabledConfig],
      budget: budgetWith(),
      candidates: [{ id: 'state-1', opportunityId: 'opp-1', score: 90, matchedKeywords: [] }],
    });
    repo.claimAutoReplyCandidate.mockResolvedValue(false);

    await expect(svc.getDueReplies(org, new Date('2026-08-18T12:00:00Z'))).resolves.toEqual([]);
    expect(engage.getOpportunityForReply).not.toHaveBeenCalled();
    expect(draft.generateDraft).not.toHaveBeenCalled();
  });

  it('releases its candidate claim when draft persistence fails', async () => {
    const { svc, repo, engage } = makeService({
      configs: [enabledConfig],
      budget: budgetWith(),
      candidates: [{ id: 'state-1', opportunityId: 'opp-1', score: 90, matchedKeywords: [] }],
    });
    engage.queueAutoReply.mockRejectedValue(new Error('db down'));

    await expect(svc.getDueReplies(org, new Date('2026-08-18T12:00:00Z'))).resolves.toEqual([]);
    expect(repo.releaseAutoReplyCandidate).toHaveBeenCalledWith('org-1', 'proj-1', 'state-1');
  });

  it('fails closed for malformed local-time policies', () => {
    const now = new Date('2026-08-18T12:00:00Z');
    expect(withinLocalWindow({ windowStart: '99:00', windowEnd: '17:00' }, now)).toBe(false);
    expect(
      withinLocalWindow(
        { windowStart: '09:00', windowEnd: '17:00', timezone: 'Not/A_Timezone' },
        now
      )
    ).toBe(false);
  });

  it('drafts anyway with no active plan when the budget gate is OFF (default)', async () => {
    // ENGAGE_REPLY_BUDGET_GATE_ENABLED unset — the driver must not require an
    // operation plan to exist; interval/active-hours pacing alone governs it.
    const { svc, repo, engage } = makeService({
      configs: [{ ...enabledConfig, replyPolicies: { reddit: { autoReplyEnabled: true } } }],
      budget: { cap: null, sentToday: 0, remaining: null, keywords: [] },
      candidates: [{ opportunityId: 'opp-1', score: 90, matchedKeywords: [] }],
    });

    expect(await svc.getDueReplies(org, new Date('2026-08-18T12:00:00Z'))).toHaveLength(1);
    expect(repo.pickAutoReplyCandidates).toHaveBeenCalled();
    expect(engage.queueAutoReply).toHaveBeenCalled();
  });

  it('hands out NOTHING when the project has no active plan and the budget gate is ON', async () => {
    vi.stubEnv('ENGAGE_REPLY_BUDGET_GATE_ENABLED', 'true');
    const { svc, repo, engage } = makeService({
      configs: [enabledConfig],
      // cap: null is what getReplyBudget returns with no plan. The send-time gate
      // reads it as "uncapped, do not block"; the driver must read the SAME value
      // as "nothing to drive" and never invent a target — but only when the gate
      // is explicitly enabled.
      budget: { cap: null, sentToday: 0, remaining: null, keywords: [] },
      candidates: [{ opportunityId: 'opp-1', score: 90, matchedKeywords: [] }],
    });

    expect(await svc.getDueReplies(org, new Date('2026-08-18T12:00:00Z'))).toEqual([]);
    expect(repo.pickAutoReplyCandidates).not.toHaveBeenCalled();
    expect(engage.queueAutoReply).not.toHaveBeenCalled();
  });

  it('hands out nothing once the day\'s budget is spent and the budget gate is ON', async () => {
    vi.stubEnv('ENGAGE_REPLY_BUDGET_GATE_ENABLED', 'true');
    const { svc, repo } = makeService({
      configs: [enabledConfig],
      budget: budgetWith({ cap: 5, sentToday: 5, remaining: 0 }),
    });

    expect(await svc.getDueReplies(org, new Date('2026-08-18T12:00:00Z'))).toEqual([]);
    expect(repo.pickAutoReplyCandidates).not.toHaveBeenCalled();
  });

  it('honours the minimum gap between two replies of the same project+platform', async () => {
    const now = new Date('2026-08-18T12:00:00Z');
    const { svc, repo } = makeService({
      configs: [enabledConfig],
      budget: budgetWith(),
      candidates: [{ opportunityId: 'opp-1', score: 90, matchedKeywords: [] }],
      // 10 minutes ago, under the 25-minute default.
      lastSentAt: new Date('2026-08-18T11:50:00Z'),
    });

    expect(await svc.getDueReplies(org, now)).toEqual([]);
    expect(repo.pickAutoReplyCandidates).not.toHaveBeenCalled();
  });

  it('targets the keywords that still have quota, not the whole pool', async () => {
    const { svc, repo } = makeService({
      configs: [enabledConfig],
      budget: budgetWith({
        keywords: [
          { keyword: 'geo', target: 3, sentToday: 3, remaining: 0 },
          { keyword: 'ai search', target: 2, sentToday: 0, remaining: 2 },
        ],
      }),
      candidates: [{ opportunityId: 'opp-1', score: 90, matchedKeywords: ['ai search'] }],
    });

    await svc.getDueReplies(org, new Date('2026-08-18T12:00:00Z'));

    // A plan that splits its target per keyword is asking for that split — not
    // for N replies drawn from whichever keyword has the best-scoring posts.
    expect(repo.pickAutoReplyCandidates).toHaveBeenCalledWith(
      'org-1',
      'proj-1',
      'reddit',
      expect.objectContaining({ keywords: ['ai search'] })
    );
  });

  it('draws from the whole matched pool when no keyword has quota left', async () => {
    const { svc, repo } = makeService({
      configs: [enabledConfig],
      // Aggregate target can exceed the sum of the per-keyword ones, so an
      // exhausted keyword split must not strand the remaining budget.
      budget: budgetWith({
        keywords: [{ keyword: 'geo', target: 1, sentToday: 1, remaining: 0 }],
      }),
      candidates: [{ opportunityId: 'opp-1', score: 90, matchedKeywords: ['other'] }],
    });

    await svc.getDueReplies(org, new Date('2026-08-18T12:00:00Z'));

    const opts = repo.pickAutoReplyCandidates.mock.calls[0][3];
    expect(opts.keywords).toBeUndefined();
  });

  it('never exceeds maxPerPoll for ONE platform, even across projects', async () => {
    const { svc } = makeService({
      configs: [
        { ...enabledConfig, id: 'c1', projectId: 'p1', replyPolicies: { reddit: { autoReplyEnabled: true } } },
        { ...enabledConfig, id: 'c2', projectId: 'p2', replyPolicies: { reddit: { autoReplyEnabled: true } } },
      ],
      budget: budgetWith(),
      candidates: [{ opportunityId: 'opp-1', score: 90, matchedKeywords: [] }],
      pacing: { maxPerPoll: 1 },
    });

    // A trickle per poll is what spreads a day's target across the day; handing
    // out a whole budget at once is what gets an account rate-limited. Both
    // projects run reddit, so the cap is shared between them.
    expect(await svc.getDueReplies(org, new Date('2026-08-18T12:00:00Z'))).toHaveLength(1);
  });

  it('hands out maxPerPoll separately for EACH platform in one poll', async () => {
    const { svc, repo } = makeService({
      // One project running both reddit and x.
      configs: [enabledConfig],
      budget: budgetWith(),
      candidates: [{ opportunityId: 'opp-1', score: 90, matchedKeywords: [] }],
      pacing: { maxPerPoll: 1 },
    });

    const due = await svc.getDueReplies(org, new Date('2026-08-18T12:00:00Z'));

    // A busy reddit slate must not starve x (or vice versa): each platform gets
    // its own maxPerPoll allowance within the same poll. `due[].platform` comes
    // from the (here identically-mocked) opportunity, not the loop's platform
    // key, so assert on which platforms were actually driven instead.
    expect(due).toHaveLength(2);
    const drivenPlatforms = repo.pickAutoReplyCandidates.mock.calls.map((c: any) => c[2]);
    expect(drivenPlatforms.sort()).toEqual(['reddit', 'x']);
  });

  it('releases the credit reservation when generation fails', async () => {
    const { svc, engage, draft } = makeService({
      configs: [enabledConfig],
      budget: budgetWith(),
      candidates: [{ opportunityId: 'opp-1', score: 90, matchedKeywords: [] }],
    });
    draft.generateDraft.mockImplementation(async function* () {
      throw new Error('model down');
    });

    expect(await svc.getDueReplies(org, new Date('2026-08-18T12:00:00Z'))).toEqual([]);
    expect(engage.releaseReplyGeneration).toHaveBeenCalledWith('task-1');
    expect(engage.queueAutoReply).not.toHaveBeenCalled();
  });

  it('a failing draft never aborts the rest of the sweep', async () => {
    const { svc, engage } = makeService({
      configs: [{ ...enabledConfig, id: 'c1', projectId: 'p1', autoReplyMode: 'review' }],
      budget: budgetWith(),
      candidates: [{ opportunityId: 'opp-1', score: 90, matchedKeywords: [] }],
      pacing: { maxPerPoll: 5 },
    });
    // First platform blows up (e.g. the opportunity aged out between the pick and
    // the read); the sweep must carry on to the next rather than return empty.
    engage.getOpportunityForReply
      .mockRejectedValueOnce(new Error('opportunity expired'))
      .mockResolvedValue({
        id: 'opp-2',
        platform: 'x',
        externalPostUrl: 'https://x.com/u/2',
      });

    const due = await svc.getDueReplies(org, new Date('2026-08-18T12:00:00Z'));

    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ platform: 'x' });
  });

  it('skips every project when none opted in', async () => {
    const { svc, engage } = makeService({ configs: [] });

    expect(await svc.getDueReplies(org, new Date('2026-08-18T12:00:00Z'))).toEqual([]);
    expect(engage.getReplyBudget).not.toHaveBeenCalled();
  });

  it('skips a platform whose policy was never configured', async () => {
    const { svc, repo } = makeService({
      // Project opted in, but only reddit is switched on.
      configs: [{ ...enabledConfig, replyPolicies: { reddit: { autoReplyEnabled: true } } }],
      budget: budgetWith(),
      candidates: [{ opportunityId: 'opp-1', score: 90, matchedKeywords: [] }],
      pacing: { maxPerPoll: 5 },
    });

    await svc.getDueReplies(org, new Date('2026-08-18T12:00:00Z'));

    // An unconfigured platform must not start replying on its own — this is the
    // one gate where "no setting" has to mean OFF rather than "inherit".
    const platforms = repo.pickAutoReplyCandidates.mock.calls.map((c: any) => c[2]);
    expect(platforms).toEqual(['reddit']);
  });

  it('respects the platform policy\'s local-time window', async () => {
    const { svc, repo } = makeService({
      configs: [
        {
          ...enabledConfig,
          replyPolicies: {
            reddit: {
              autoReplyEnabled: true,
              windowStart: '09:00',
              windowEnd: '18:00',
              timezone: 'Asia/Shanghai',
            },
          },
        },
      ],
      budget: budgetWith(),
      candidates: [{ opportunityId: 'opp-1', score: 90, matchedKeywords: [] }],
    });

    // 02:00 UTC = 10:00 Shanghai → inside the window.
    await svc.getDueReplies(org, new Date('2026-08-18T02:00:00Z'));
    expect(repo.pickAutoReplyCandidates).toHaveBeenCalled();

    repo.pickAutoReplyCandidates.mockClear();
    // 14:00 UTC = 22:00 Shanghai → outside. A UTC-only window could not express
    // this for an org whose working day straddles midnight UTC.
    await svc.getDueReplies(org, new Date('2026-08-18T14:00:00Z'));
    expect(repo.pickAutoReplyCandidates).not.toHaveBeenCalled();
  });

  it('drives a platform beyond reddit/x purely from its configured policy', async () => {
    const { svc, repo } = makeService({
      configs: [
        {
          ...enabledConfig,
          replyPolicies: { linkedin: { autoReplyEnabled: true } },
        },
      ],
      budget: budgetWith(),
      candidates: [{ opportunityId: 'opp-1', score: 90, matchedKeywords: [] }],
    });

    await svc.getDueReplies(org, new Date('2026-08-18T12:00:00Z'));

    // The loop is data-driven off replyPolicies' keys, not a hardcoded pair — a
    // newly supported platform needs only a policy entry, no code change here.
    // (Whether the extension can actually post there is a SEPARATE, extension-side
    // concern this driver does not gate on.)
    expect(repo.pickAutoReplyCandidates).toHaveBeenCalledWith(
      'org-1', 'proj-1', 'linkedin', expect.anything()
    );
  });
});

// The schedule the Automation page configures: ACTIVE HOURS and a DAILY LIMIT.
// They replaced a single "check every N hours" cadence, which could only answer
// "when may this account be seen replying" and "how many replies a day is still
// a person" by accident — both depend on how long the window is open.
describe('EngageAutoReplyService.getDueReplies — active hours and daily limit', () => {
  beforeEach(() => vi.clearAllMocks());

  const dueConfig = {
    configs: [{ ...enabledConfig, replyPolicies: { reddit: { autoReplyEnabled: true } } }],
    budget: budgetWith(),
    candidates: [{ opportunityId: 'opp-1', score: 90, matchedKeywords: [] as string[] }],
  };

  it('holds a platform that set no window to the default 8 AM–6 PM', async () => {
    const { svc, repo } = makeService(dueConfig);

    await svc.getDueReplies(org, new Date('2026-08-18T22:00:00Z'));

    expect(repo.pickAutoReplyCandidates).not.toHaveBeenCalled();
  });

  it('drives that same platform inside those hours', async () => {
    const { svc, repo } = makeService(dueConfig);

    await svc.getDueReplies(org, new Date('2026-08-18T09:00:00Z'));

    expect(repo.pickAutoReplyCandidates).toHaveBeenCalled();
  });

  it('stops for the day once the limit is spent', async () => {
    // The default limit is 4 — well under every platform's safety ceiling, so
    // this is the configured limit biting, not the clamp.
    const { svc, repo } = makeService({ ...dueConfig, sentToday: 4 });

    await svc.getDueReplies(org, new Date('2026-08-18T12:00:00Z'));

    expect(repo.pickAutoReplyCandidates).not.toHaveBeenCalled();
  });

  it('keeps going while the day still has room', async () => {
    const { svc, repo } = makeService({ ...dueConfig, sentToday: 3 });

    await svc.getDueReplies(org, new Date('2026-08-18T12:00:00Z'));

    expect(repo.pickAutoReplyCandidates).toHaveBeenCalled();
  });

  it('clamps a requested limit to the platform SAFETY ceiling', async () => {
    // Asking for 99 on reddit is not a more ambitious configuration, it is a
    // guardrail removed — so the ceiling applies and the day ends at 25.
    const { svc, repo } = makeService({
      configs: [
        {
          ...enabledConfig,
          replyPolicies: {
            reddit: { autoReplyEnabled: true, dailyReplyLimit: 99 },
          },
        },
      ],
      budget: budgetWith(),
      candidates: [{ opportunityId: 'opp-1', score: 90, matchedKeywords: [] }],
      sentToday: PLATFORM_REPLY_RISK_CEILING.reddit,
    });

    await svc.getDueReplies(org, new Date('2026-08-18T12:00:00Z'));

    expect(repo.pickAutoReplyCandidates).not.toHaveBeenCalled();
  });

  it('does not clamp a raised limit down to the EDITORIAL volume', async () => {
    // 10 a day on x is a rate decision; the plan generator's 4 is a content
    // one. Confusing the two silently held this project to 4.
    const { svc, repo } = makeService({
      configs: [
        {
          ...enabledConfig,
          replyPolicies: { x: { autoReplyEnabled: true, dailyReplyLimit: 10 } },
        },
      ],
      budget: budgetWith(),
      candidates: [{ opportunityId: 'opp-1', score: 90, matchedKeywords: [] }],
      sentToday: 6,
    });

    await svc.getDueReplies(org, new Date('2026-08-18T12:00:00Z'));

    expect(repo.pickAutoReplyCandidates).toHaveBeenCalled();
  });

  it('applies each platform\'s OWN ceiling, not one flat number', async () => {
    // x tolerates 30 where medium tolerates 10: with both asking for the moon,
    // the same day's count closes medium and leaves x running.
    const raised = (platform: string) => ({
      configs: [
        {
          ...enabledConfig,
          replyPolicies: {
            [platform]: { autoReplyEnabled: true, dailyReplyLimit: 99 },
          },
        },
      ],
      budget: budgetWith(),
      candidates: [{ opportunityId: 'opp-1', score: 90, matchedKeywords: [] as string[] }],
      sentToday: 12,
    });
    const onX = makeService(raised('x'));
    const onMedium = makeService(raised('medium'));

    await onX.svc.getDueReplies(org, new Date('2026-08-18T12:00:00Z'));
    await onMedium.svc.getDueReplies(org, new Date('2026-08-18T12:00:00Z'));

    expect(onX.repo.pickAutoReplyCandidates).toHaveBeenCalled();
    expect(onMedium.repo.pickAutoReplyCandidates).not.toHaveBeenCalled();
  });

  it('honours the admin ceiling setting over the built-in', async () => {
    const { svc, repo } = makeService({
      configs: [
        {
          ...enabledConfig,
          replyPolicies: { x: { autoReplyEnabled: true, dailyReplyLimit: 20 } },
        },
      ],
      budget: budgetWith(),
      candidates: [{ opportunityId: 'opp-1', score: 90, matchedKeywords: [] }],
      // The built-in would allow 20; the operator has pulled x back to 5.
      ceilings: { x: 5 },
      sentToday: 5,
    });

    await svc.getDueReplies(org, new Date('2026-08-18T12:00:00Z'));

    expect(repo.pickAutoReplyCandidates).not.toHaveBeenCalled();
  });

  it('honours a limit of 0 as "not today"', async () => {
    // Distinct from an absent field, which asks for the default. `??` would
    // have read the two the same way and handed back 4.
    const { svc, repo } = makeService({
      configs: [
        {
          ...enabledConfig,
          replyPolicies: { reddit: { autoReplyEnabled: true, dailyReplyLimit: 0 } },
        },
      ],
      budget: budgetWith(),
      candidates: [{ opportunityId: 'opp-1', score: 90, matchedKeywords: [] }],
      sentToday: 0,
    });

    await svc.getDueReplies(org, new Date('2026-08-18T12:00:00Z'));

    expect(repo.pickAutoReplyCandidates).not.toHaveBeenCalled();
  });

  it('counts the day in the timezone the active hours are stated in', async () => {
    // A UTC day would roll the count over in the middle of a UTC+8 afternoon,
    // handing that project a second day's replies inside one of its own.
    const { svc, repo } = makeService({
      configs: [
        {
          ...enabledConfig,
          replyPolicies: {
            reddit: {
              autoReplyEnabled: true,
              windowStart: '08:00',
              windowEnd: '23:00',
              timezone: 'Asia/Shanghai',
            },
          },
        },
      ],
      budget: budgetWith(),
      candidates: [{ opportunityId: 'opp-1', score: 90, matchedKeywords: [] }],
    });

    // 12:00 UTC = 20:00 Shanghai, inside the window and inside the Shanghai day
    // that began at 16:00 UTC the day before.
    await svc.getDueReplies(org, new Date('2026-08-18T12:00:00Z'));

    expect(repo.countProjectSentRepliesToday).toHaveBeenCalledWith(
      'org-1',
      'proj-1',
      'reddit',
      new Date('2026-08-17T16:00:00.000Z'),
      new Date('2026-08-18T16:00:00.000Z')
    );
  });

  it('will not hand over a QUEUED reply once the day is spent', async () => {
    // A queued reply was generated under conditions that no longer hold. Sending
    // it is still sending one today, so the ceiling has to apply to the claim
    // lane as well — otherwise a backlog spends a day the limit already closed.
    const { svc, repo } = makeService({
      configs: [{ ...enabledConfig, replyPolicies: { reddit: { autoReplyEnabled: true } } }],
      queued: [
        {
          id: 'sent-old',
          projectId: 'proj-1',
          opportunityId: 'opp-old',
          platform: 'reddit',
          url: 'https://reddit.com/r/x/comments/old',
          content: 'a reply waiting to go out',
        },
      ],
      sentToday: 4,
    });

    const due = await svc.getDueReplies(org, new Date('2026-08-18T12:00:00Z'));

    expect(due).toHaveLength(0);
    expect(repo.claimDueEngageReplies).not.toHaveBeenCalled();
  });
});

// WARM-UP. An account we have only just started driving runs at a fraction of
// its ceiling. The clock is the org's FIRST reply on that platform — how long
// WE have been driving the account, which is the only age signal available,
// since replies go out through the extension's own browser session and no
// registration date is ever visible.
describe('EngageAutoReplyService.getDueReplies — warm-up', () => {
  beforeEach(() => vi.clearAllMocks());

  const now = new Date('2026-08-18T12:00:00Z');
  const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);
  const raisedOnX = (over: Record<string, unknown>) => ({
    configs: [
      {
        ...enabledConfig,
        // Asking for x's full ceiling, so the only thing that can lower it is
        // the ramp.
        replyPolicies: { x: { autoReplyEnabled: true, dailyReplyLimit: 30 } },
      },
    ],
    budget: budgetWith(),
    candidates: [{ opportunityId: 'opp-1', score: 90, matchedKeywords: [] as string[] }],
    ...over,
  });

  it('holds a two-day-old account to 30% of the ceiling', async () => {
    // 30 × 0.3 = 9, so a tenth reply today is refused.
    const { svc, repo } = makeService(
      raisedOnX({ firstSentAt: daysAgo(2), sentToday: 9 })
    );

    await svc.getDueReplies(org, now);

    expect(repo.pickAutoReplyCandidates).not.toHaveBeenCalled();
  });

  it('lets that same account run up to its discounted limit', async () => {
    const { svc, repo } = makeService(
      raisedOnX({ firstSentAt: daysAgo(2), sentToday: 8 })
    );

    await svc.getDueReplies(org, now);

    expect(repo.pickAutoReplyCandidates).toHaveBeenCalled();
  });

  it('opens up to 60% in the second tier', async () => {
    // 30 × 0.6 = 18: the same 9 replies that closed the day above are fine here.
    const { svc, repo } = makeService(
      raisedOnX({ firstSentAt: daysAgo(10), sentToday: 9 })
    );

    await svc.getDueReplies(org, now);

    expect(repo.pickAutoReplyCandidates).toHaveBeenCalled();
  });

  it('applies no discount once the account is fully warmed up', async () => {
    const { svc, repo } = makeService(
      raisedOnX({ firstSentAt: daysAgo(45), sentToday: 29 })
    );

    await svc.getDueReplies(org, now);

    expect(repo.pickAutoReplyCandidates).toHaveBeenCalled();
  });

  // Never replied here = day 0, not "unknown, go ahead": an account we have
  // never driven is the one to start slowest on.
  it('treats a platform with no reply history as day zero', async () => {
    const { svc, repo } = makeService(
      raisedOnX({ firstSentAt: null, sentToday: 9 })
    );

    await svc.getDueReplies(org, now);

    expect(repo.pickAutoReplyCandidates).not.toHaveBeenCalled();
  });

  // The clock belongs to the ACCOUNT, which this org's projects share — so it is
  // read ONCE for the whole poll, not once per (project, platform). Lazily was a
  // query per platform charged before the window gates, so an org outside its
  // active hours paid N of them to be told nothing was due.
  it('reads the warm-up clock in one batched call for the whole poll', async () => {
    const { svc, repo } = makeService({
      configs: [
        { id: 'cfg-1', projectId: 'proj-1', replyPolicies: { x: { autoReplyEnabled: true } } },
        { id: 'cfg-2', projectId: 'proj-2', replyPolicies: { x: { autoReplyEnabled: true } } },
      ],
      budget: budgetWith(),
      candidates: [{ opportunityId: 'opp-1', score: 90, matchedKeywords: [] }],
    });

    await svc.getDueReplies(org, now);

    expect(repo.getFirstSentReplyAtByPlatform).toHaveBeenCalledTimes(1);
    expect(repo.getFirstSentReplyAtByPlatform).toHaveBeenCalledWith(org.id, ['x']);
    expect(repo.getFirstSentReplyAt).not.toHaveBeenCalled();
  });

  it('asks for every configured platform exactly once, de-duplicated', async () => {
    const { svc, repo } = makeService({
      configs: [
        {
          id: 'cfg-1',
          projectId: 'proj-1',
          replyPolicies: { x: { autoReplyEnabled: true }, reddit: { autoReplyEnabled: true } },
        },
        // Same platform under a second project, and a differently-cased key —
        // neither may produce a second entry.
        { id: 'cfg-2', projectId: 'proj-2', replyPolicies: { X: { autoReplyEnabled: true } } },
      ],
      budget: budgetWith(),
      candidates: [{ opportunityId: 'opp-1', score: 90, matchedKeywords: [] }],
    });

    await svc.getDueReplies(org, now);

    const [, platforms] = repo.getFirstSentReplyAtByPlatform.mock.calls[0];
    expect([...platforms].sort()).toEqual(['reddit', 'x']);
  });

  it('honours an admin warm-up ladder over the built-in curve', async () => {
    const { svc, repo } = makeService(
      raisedOnX({
        firstSentAt: daysAgo(2),
        sentToday: 9,
        // The operator has decided a new account may use half the ceiling from
        // day one: 30 × 0.5 = 15, so 9 sent today is still inside it.
        warmupTiers: [{ days: 0, factor: 0.5 }],
      })
    );

    await svc.getDueReplies(org, now);

    expect(repo.pickAutoReplyCandidates).toHaveBeenCalled();
  });

  // Warm-up slows an account down; it never stops one. A platform that may not
  // reply at all for its first week only looks abandoned.
  it('never discounts a ceiling below one reply a day', async () => {
    const { svc, repo } = makeService({
      configs: [
        {
          ...enabledConfig,
          // hackernews tolerates 10; 10 × 0.01 would round to 0 without the floor.
          replyPolicies: { hackernews: { autoReplyEnabled: true } },
        },
      ],
      budget: budgetWith(),
      candidates: [{ opportunityId: 'opp-1', score: 90, matchedKeywords: [] }],
      firstSentAt: null,
      warmupTiers: [{ days: 0, factor: 0.01 }],
      sentToday: 0,
    });

    await svc.getDueReplies(org, now);

    expect(repo.pickAutoReplyCandidates).toHaveBeenCalled();
  });
});

// BUDGET PACING. The gap between two replies is what is LEFT of the active
// hours divided by what is still OWED today — so a day that falls behind speeds
// up instead of finishing under its limit with hours of window unused.
describe('EngageAutoReplyService.getDueReplies — budget pacing', () => {
  beforeEach(() => vi.clearAllMocks());

  // 09:00–17:00 across 4 replies. The fixtures below move `now` and `sentToday`
  // to put the day ahead of or behind where it should be.
  const paced = (over: Record<string, unknown>) => ({
    configs: [
      {
        ...enabledConfig,
        replyPolicies: {
          reddit: {
            autoReplyEnabled: true,
            windowStart: '09:00',
            windowEnd: '17:00',
            dailyReplyLimit: 4,
          },
        },
      },
    ],
    budget: budgetWith(),
    candidates: [{ opportunityId: 'opp-1', score: 90, matchedKeywords: [] as string[] }],
    pacing: { minGapMinutes: 10 },
    ...over,
  });

  it('holds a day that is running ahead of its budget', async () => {
    // 10:00, 3 of 4 already sent: 420 minutes left for the one still owed, and
    // only 40 have passed since the last.
    const { svc, repo } = makeService(
      paced({ sentToday: 3, lastSentAt: new Date('2026-08-18T09:20:00Z') })
    );

    await svc.getDueReplies(org, new Date('2026-08-18T10:00:00Z'));

    expect(repo.pickAutoReplyCandidates).not.toHaveBeenCalled();
  });

  // The self-correction the whole mechanism exists for: under the old flat
  // window/limit this same state waited another 120 minutes and the day ended
  // one reply short with the window closed.
  it('releases a day that has fallen behind, on the same elapsed time', async () => {
    // 15:00, nothing sent: 120 minutes left, 4 still owed — a 30-minute pace, and
    // 40 minutes have passed.
    const { svc, repo } = makeService(
      paced({ sentToday: 0, lastSentAt: new Date('2026-08-18T14:20:00Z') })
    );

    await svc.getDueReplies(org, new Date('2026-08-18T15:00:00Z'));

    expect(repo.pickAutoReplyCandidates).toHaveBeenCalled();
  });

  it('still refuses to go under the org-wide floor', async () => {
    // Same catching-up day, but the operator has slowed everything to 90.
    const { svc, repo } = makeService(
      paced({
        sentToday: 0,
        lastSentAt: new Date('2026-08-18T14:20:00Z'),
        pacing: { minGapMinutes: 90 },
      })
    );

    await svc.getDueReplies(org, new Date('2026-08-18T15:00:00Z'));

    expect(repo.pickAutoReplyCandidates).not.toHaveBeenCalled();
  });
});

// SAME-CHANNEL CONCENTRATION. A daily total says nothing about spread, and
// spread is what reddit's spam filter actually reads: three comments across
// three subreddits is three people having a day, three in one subreddit is a
// campaign.
describe('EngageAutoReplyService.getDueReplies — same-channel cap', () => {
  beforeEach(() => vi.clearAllMocks());

  const onReddit = (over: Record<string, unknown>) => ({
    configs: [{ ...enabledConfig, replyPolicies: { reddit: { autoReplyEnabled: true } } }],
    budget: budgetWith(),
    candidates: [{ opportunityId: 'opp-1', score: 90, matchedKeywords: [] as string[] }],
    ...over,
  });

  it('excludes a subreddit that has had its allowance today', async () => {
    const { svc, repo } = makeService(
      onReddit({
        repliesByChannel: {
          't5_busy': DEFAULT_CHANNEL_DAILY_LIMIT.reddit,
          't5_quiet': 1,
        },
      })
    );

    await svc.getDueReplies(org, new Date('2026-08-18T12:00:00Z'));

    // Excluded at the PICK, not after: a candidate we would refuse to send is a
    // draft we must not pay an LLM to write.
    expect(repo.pickAutoReplyCandidates).toHaveBeenCalledWith(
      org.id,
      'proj-1',
      'reddit',
      expect.objectContaining({ excludeChannelIds: ['t5_busy'] })
    );
    // Counted ORG-wide: a community's spam filter counts the ACCOUNT's
    // comments and cannot see our project boundaries.
    expect(repo.countTodayRepliesByChannel).toHaveBeenCalledWith(
      org.id,
      'reddit',
      expect.any(Date),
      expect.any(Date)
    );
  });

  it('holds the QUEUED lane to the same exclusion', async () => {
    // A queued reply is still a reply ARRIVING in that community, so a backlog
    // must not deliver the stack of comments the cap exists to prevent.
    const { svc, repo } = makeService(
      onReddit({ repliesByChannel: { 't5_busy': 9 } })
    );

    await svc.getDueReplies(org, new Date('2026-08-18T12:00:00Z'));

    expect(repo.claimDueEngageReplies).toHaveBeenCalledWith(
      org.id,
      'proj-1',
      'reddit',
      expect.objectContaining({ excludeChannelIds: ['t5_busy'] })
    );
  });

  it('passes no exclusion while every channel still has room', async () => {
    const { svc, repo } = makeService(onReddit({ repliesByChannel: { 't5_quiet': 1 } }));

    await svc.getDueReplies(org, new Date('2026-08-18T12:00:00Z'));

    expect(repo.pickAutoReplyCandidates).toHaveBeenCalledWith(
      org.id,
      'proj-1',
      'reddit',
      expect.not.objectContaining({ excludeChannelIds: expect.anything() })
    );
  });

  // x has no channel at all, so there is no concentration to measure — and no
  // query to pay for.
  it('does not even count channels on an uncapped platform', async () => {
    const { svc, repo } = makeService({
      configs: [{ ...enabledConfig, replyPolicies: { x: { autoReplyEnabled: true } } }],
      budget: budgetWith(),
      candidates: [{ opportunityId: 'opp-1', score: 90, matchedKeywords: [] }],
    });

    await svc.getDueReplies(org, new Date('2026-08-18T12:00:00Z'));

    expect(repo.countTodayRepliesByChannel).not.toHaveBeenCalled();
  });

  it('honours an admin per-platform cap over the built-in', async () => {
    const { svc, repo } = makeService(
      onReddit({
        channelDailyLimits: { reddit: 1 },
        repliesByChannel: { 't5_one': 1 },
      })
    );

    await svc.getDueReplies(org, new Date('2026-08-18T12:00:00Z'));

    expect(repo.pickAutoReplyCandidates).toHaveBeenCalledWith(
      org.id,
      'proj-1',
      'reddit',
      expect.objectContaining({ excludeChannelIds: ['t5_one'] })
    );
  });

  it('can cap a platform the built-ins leave alone', async () => {
    const { svc, repo } = makeService({
      configs: [{ ...enabledConfig, replyPolicies: { linkedin: { autoReplyEnabled: true } } }],
      budget: budgetWith(),
      candidates: [{ opportunityId: 'opp-1', score: 90, matchedKeywords: [] }],
      channelDailyLimits: { linkedin: 1 },
      repliesByChannel: { 'company-page': 1 },
    });

    await svc.getDueReplies(org, new Date('2026-08-18T12:00:00Z'));

    expect(repo.pickAutoReplyCandidates).toHaveBeenCalledWith(
      org.id,
      'proj-1',
      'linkedin',
      expect.objectContaining({ excludeChannelIds: ['company-page'] })
    );
  });
});

describe('EngageAutoReplyService.getDueReplies — platform write window', () => {
  beforeEach(() => vi.clearAllMocks());

  const dueConfig = {
    configs: [{ ...enabledConfig, replyPolicies: { reddit: { autoReplyEnabled: true } } }],
    budget: budgetWith(),
    candidates: [{ opportunityId: 'opp-1', score: 90, matchedKeywords: [] as string[] }],
  };

  it('hands out nothing outside the platform write window', async () => {
    const { svc, repo } = makeService({ ...dueConfig, withinWriteWindow: false });

    // Noon: inside the project's own default active hours, so this asserts the
    // PLATFORM window and nothing else. At 03:00 the project window would skip
    // the platform first and the spec would pass without testing anything.
    await svc.getDueReplies(org, new Date('2026-08-18T12:00:00Z'));

    expect(repo.pickAutoReplyCandidates).not.toHaveBeenCalled();
  });

  it('checks the window PER PLATFORM, not once globally', async () => {
    // It used to be one global pair of UTC hours, checked before any query — so
    // it could neither name a timezone nor differ between platforms, while
    // POSTING had its own per-platform window that could disagree with it.
    const { svc, platformPacing } = makeService(dueConfig);

    const now = new Date('2026-08-18T12:00:00Z');
    await svc.getDueReplies(org, now);

    // Per platform, against a config resolved ONCE for the whole call — the
    // window used to be one global pair of UTC hours checked before any query.
    expect(platformPacing.getPlatformPacing).toHaveBeenCalledTimes(1);
    expect(platformPacing.isWithinWriteWindowFor).toHaveBeenCalledWith(
      expect.anything(),
      'reddit',
      now
    );
  });

  it('proceeds when the window allows it', async () => {
    const { svc, repo } = makeService({ ...dueConfig, withinWriteWindow: true });

    await svc.getDueReplies(org, new Date('2026-08-18T12:00:00Z'));

    expect(repo.pickAutoReplyCandidates).toHaveBeenCalled();
  });
});

describe('EngageAutoReplyService.getDueReplies — platform write floor', () => {
  beforeEach(() => vi.clearAllMocks());

  const dueConfig = {
    configs: [{ ...enabledConfig, replyPolicies: { reddit: { autoReplyEnabled: true } } }],
    budget: budgetWith(),
    candidates: [{ opportunityId: 'opp-1', score: 90, matchedKeywords: [] as string[] }],
  };

  it('holds a reply back when ANOTHER track wrote to the platform just now', async () => {
    // The incident, on the backend side: a post went out to this platform's
    // account minutes ago. The project's own reply clock says "go" — it has not
    // replied at all today — but the platform counts posts and replies against
    // one throttle, so it must not.
    const { svc, repo } = makeService({
      ...dueConfig,
      lastSentAt: null, // this project has never replied
      lastPlatformWriteAt: new Date('2026-08-18T11:55:00Z'), // a POST, 5 min ago
      writeFloorMinutes: 15,
    });

    await svc.getDueReplies(org, new Date('2026-08-18T12:00:00Z'));

    expect(repo.pickAutoReplyCandidates).not.toHaveBeenCalled();
  });

  it('releases the reply once the floor has elapsed', async () => {
    const { svc, repo } = makeService({
      ...dueConfig,
      lastSentAt: null,
      lastPlatformWriteAt: new Date('2026-08-18T11:40:00Z'), // 20 min ago
      writeFloorMinutes: 15,
    });

    await svc.getDueReplies(org, new Date('2026-08-18T12:00:00Z'));

    expect(repo.pickAutoReplyCandidates).toHaveBeenCalled();
  });

  it('checks the floor ORG-wide, not per project', async () => {
    // A project is our concept; the throttle belongs to the platform account,
    // and two projects publishing to one login share it. The floor's lookup must
    // therefore not be scoped by project — scoping it would let N projects each
    // spend the full floor.
    const { svc, repo } = makeService({
      ...dueConfig,
      lastSentAt: null,
      lastPlatformWriteAt: new Date('2026-08-18T11:55:00Z'),
      writeFloorMinutes: 15,
    });

    await svc.getDueReplies(org, new Date('2026-08-18T12:00:00Z'));

    expect(repo.getLastPlatformWriteAt).toHaveBeenCalledWith(org.id, 'reddit');
  });

  it('does not block when nothing has ever written to the platform', async () => {
    const { svc, repo } = makeService({
      ...dueConfig,
      lastSentAt: null,
      lastPlatformWriteAt: null,
      writeFloorMinutes: 15,
    });

    await svc.getDueReplies(org, new Date('2026-08-18T12:00:00Z'));

    expect(repo.pickAutoReplyCandidates).toHaveBeenCalled();
  });

  it('a tighter derived cadence cannot get under the floor', async () => {
    // A narrow window divided by a full day's limit is the one way the derived
    // spacing gets small — and it is still only a preference. What a preference
    // may never undercut is what the platform tolerates, which is why the floor
    // is a separate setting resolved with max() rather than — like the cadence
    // — with the schedule.
    const { svc, repo } = makeService({
      configs: [
        {
          ...enabledConfig,
          replyPolicies: {
            reddit: {
              autoReplyEnabled: true,
              // A one-hour window, 3 replies (reddit's ceiling) — one every 20.
              windowStart: '11:30',
              windowEnd: '12:30',
              dailyReplyLimit: 3,
            },
          },
        },
      ],
      budget: budgetWith(),
      candidates: [{ opportunityId: 'opp-1', score: 90, matchedKeywords: [] }],
      // Out of the way, so the 20-minute derived cadence is what the floor is
      // being tested against.
      pacing: { minGapMinutes: 5 },
      lastSentAt: new Date('2026-08-18T11:38:00Z'), // 22 min — clears the 20-min cadence
      lastPlatformWriteAt: new Date('2026-08-18T11:38:00Z'),
      writeFloorMinutes: 25,
    });

    await svc.getDueReplies(org, new Date('2026-08-18T12:00:00Z'));

    expect(repo.pickAutoReplyCandidates).not.toHaveBeenCalled();
  });
});

describe('EngageAutoReplyService.getDueReplies — per-platform overrides', () => {
  beforeEach(() => vi.clearAllMocks());

  it('paces by the spacing DERIVED from the schedule, not the retired checkIntervalMinutes', async () => {
    const { svc, repo } = makeService({
      configs: [
        {
          ...enabledConfig,
          // A stored cadence from an older client. Honouring it would let two
          // replies through a ten-hour window while the same policy asks for
          // three — the contradiction the pair replaced it to remove.
          replyPolicies: { reddit: { autoReplyEnabled: true, checkIntervalMinutes: 5 } },
        },
      ],
      budget: budgetWith(),
      candidates: [{ opportunityId: 'opp-1', score: 90, matchedKeywords: [] }],
      // 10 minutes ago: over the stored 5-minute cadence, far under the
      // schedule's own (8 AM–6 PM across 4 a day = one every 150).
      lastSentAt: new Date('2026-08-18T11:50:00Z'),
    });

    await svc.getDueReplies(org, new Date('2026-08-18T12:00:00Z'));

    expect(repo.pickAutoReplyCandidates).not.toHaveBeenCalled();
  });

  it('is due once the derived spacing has elapsed', async () => {
    const { svc, repo } = makeService({
      configs: [{ ...enabledConfig, replyPolicies: { reddit: { autoReplyEnabled: true } } }],
      budget: budgetWith(),
      candidates: [{ opportunityId: 'opp-1', score: 90, matchedKeywords: [] }],
      // 210 minutes ago, against the default schedule's 150.
      lastSentAt: new Date('2026-08-18T08:30:00Z'),
    });

    await svc.getDueReplies(org, new Date('2026-08-18T12:00:00Z'));

    expect(repo.pickAutoReplyCandidates).toHaveBeenCalled();
  });

  it('never spaces tighter than the org-wide minGapMinutes', async () => {
    // The org-wide setting is a FLOOR under the derived cadence, not a default
    // beside it: an operator slowing every project down must not be undercut by
    // a project that divides a wide window by a big limit.
    const { svc, repo } = makeService({
      configs: [
        {
          ...enabledConfig,
          replyPolicies: {
            // 60 minutes across 3 replies = one every 20…
            reddit: {
              autoReplyEnabled: true,
              windowStart: '11:30',
              windowEnd: '12:30',
              dailyReplyLimit: 3,
            },
          },
        },
      ],
      budget: budgetWith(),
      candidates: [{ opportunityId: 'opp-1', score: 90, matchedKeywords: [] }],
      // … but the operator says never under 45.
      pacing: { minGapMinutes: 45 },
      lastSentAt: new Date('2026-08-18T11:30:00Z'), // 30 min ago
    });

    await svc.getDueReplies(org, new Date('2026-08-18T12:00:00Z'));

    expect(repo.pickAutoReplyCandidates).not.toHaveBeenCalled();
  });

  it('drafts with the platform\'s length tier and mentionTags instead of the hardcoded medium/none', async () => {
    const { svc, engage, draft } = makeService({
      configs: [
        {
          ...enabledConfig,
          replyPolicies: {
            reddit: {
              autoReplyEnabled: true,
              length: 'long',
              mentionTags: ['@aisee', '@support'],
            },
          },
        },
      ],
      budget: budgetWith(),
      candidates: [{ opportunityId: 'opp-1', score: 90, matchedKeywords: [] }],
    });

    await svc.getDueReplies(org, new Date('2026-08-18T12:00:00Z'));

    expect(engage.reserveReplyGeneration).toHaveBeenCalledWith(org, 'long', 'opp-1');
    expect(draft.generateDraft).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      50,
      ['@aisee', '@support'],
      undefined,
      expect.any(Number)
    );
    expect(engage.settleReplyGeneration).toHaveBeenCalledWith(org, 'task-1', 'long', 3);
  });

  it('defaults to medium length and no mentions when the policy sets neither', async () => {
    const { svc, engage } = makeService({
      configs: [enabledConfig],
      budget: budgetWith(),
      candidates: [{ opportunityId: 'opp-1', score: 90, matchedKeywords: [] }],
    });

    await svc.getDueReplies(org, new Date('2026-08-18T12:00:00Z'));

    expect(engage.reserveReplyGeneration).toHaveBeenCalledWith(org, 'medium', 'opp-1');
  });
});

// Found on re-review: Object.keys(policies) yields whatever casing the caller
// wrote, but getReplyBudget's platform match against the plan's
// engagePolicies[].platform (always lowercase) is case-sensitive. An
// uppercase-keyed policy would previously resolve budget.cap to null and get
// silently skipped — never rejected, never logged, just quietly never driven.
describe('EngageAutoReplyService.getDueReplies — platform key casing', () => {
  beforeEach(() => vi.clearAllMocks());

  it('drives a policy keyed in a different case by normalizing before the budget lookup', async () => {
    const { svc, engage } = makeService({
      configs: [{ ...enabledConfig, replyPolicies: { X: { autoReplyEnabled: true } } }],
      budget: budgetWith(),
      candidates: [{ opportunityId: 'opp-1', score: 90, matchedKeywords: [] }],
    });

    await svc.getDueReplies(org, new Date('2026-08-18T12:00:00Z'));

    // getReplyBudget/pickAutoReplyCandidates must see the LOWERCASE form — that
    // is what the plan's engagePolicies[].platform is always written as.
    expect(engage.getReplyBudget).toHaveBeenCalledWith('org-1', 'proj-1', 'x', expect.any(Date));
  });

  it('still finds the policy VALUE under its original (un-normalized) key', async () => {
    // Regression guard for the naive fix: normalizing the loop variable and
    // then doing `policies[platform]` would look up the lowercase key in an
    // object actually keyed by the original casing, finding nothing — the
    // opposite failure from the one being fixed.
    const { svc, engage } = makeService({
      configs: [
        {
          ...enabledConfig,
          replyPolicies: { X: { autoReplyEnabled: true, defaultStrategy: 'AMPLIFY' } },
        },
      ],
      budget: budgetWith(),
      candidates: [{ opportunityId: 'opp-1', score: 90, matchedKeywords: [] }],
    });

    await svc.getDueReplies(org, new Date('2026-08-18T12:00:00Z'));

    expect(engage.queueAutoReply).toHaveBeenCalledWith(
      org,
      'opp-1',
      expect.objectContaining({
        inputData: expect.objectContaining({ strategy: 'AMPLIFY' }),
      })
    );
  });
});

// Found on re-review: settleReplyGeneration ran BEFORE the persist. A persist
// failure after a successful settle would charge for a draft that exists
// nowhere retrievable — no EngageSentReply row, so pickAutoReplyCandidates
// would offer the SAME opportunity again next poll, re-drafting (and
// re-charging) it every cycle with each earlier draft silently discarded.
describe('EngageAutoReplyService.getDueReplies — settle ordering', () => {
  beforeEach(() => vi.clearAllMocks());

  it('releases (never settles) the reservation when the queue write fails', async () => {
    const { svc, engage } = makeService({
      configs: [enabledConfig],
      budget: budgetWith(),
      candidates: [{ opportunityId: 'opp-1', score: 90, matchedKeywords: [] }],
    });
    engage.queueAutoReply.mockRejectedValue(new Error('db down'));

    const due = await svc.getDueReplies(org, new Date('2026-08-18T12:00:00Z'));

    expect(due).toEqual([]);
    expect(engage.releaseReplyGeneration).toHaveBeenCalledWith('task-1');
    expect(engage.settleReplyGeneration).not.toHaveBeenCalled();
  });

  it('settles only after the queue write has already succeeded', async () => {
    const { svc, engage } = makeService({
      // Single platform so callOrder reflects exactly one draft/settle pair.
      configs: [{ ...enabledConfig, replyPolicies: { reddit: { autoReplyEnabled: true } } }],
      budget: budgetWith(),
      candidates: [{ opportunityId: 'opp-1', score: 90, matchedKeywords: [] }],
    });
    const callOrder: string[] = [];
    engage.queueAutoReply.mockImplementation(async () => {
      callOrder.push('queueAutoReply');
      return { id: 'sent-1' };
    });
    engage.settleReplyGeneration.mockImplementation(async () => {
      callOrder.push('settle');
    });

    await svc.getDueReplies(org, new Date('2026-08-18T12:00:00Z'));

    expect(callOrder).toEqual(['queueAutoReply', 'settle']);
  });
});

// A reply is generated, claimed by the extension, and the send never lands — the
// browser was closed, the network dropped, the platform errored. Redelivery is
// not a mechanism of its own: the reply is in QUEUE, the claim leases it, and an
// expired lease means it is simply offered again. Same shape as the publish path.
//
// These pin that, and the one thing it must never become: sending a DRAFT, which
// belongs to a human who has not pressed send.
describe('EngageAutoReplyService.getDueReplies — the queue lane', () => {
  beforeEach(() => vi.clearAllMocks());

  const queued = (over: Record<string, unknown> = {}) => ({
    id: 'sent-old',
    projectId: 'proj-1',
    opportunityId: 'opp-old',
    platform: 'reddit',
    url: 'https://reddit.com/r/x/comments/old',
    content: 'a reply waiting to go out',
    ...over,
  });

  it('hands over a queued reply without generating or charging anything', async () => {
    const { svc, engage, repo } = makeService({
      configs: [{ ...enabledConfig, replyPolicies: { reddit: { autoReplyEnabled: true } } }],
      queued: [queued()],
    });

    const due = await svc.getDueReplies(org, DURING_ACTIVE_HOURS);

    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({
      sentReplyId: 'sent-old',
      url: 'https://reddit.com/r/x/comments/old',
      text: 'a reply waiting to go out',
    });
    // The text already exists — regenerating it would charge twice for one reply
    // and burn another slice of the daily budget.
    expect(engage.reserveReplyGeneration).not.toHaveBeenCalled();
    expect(engage.queueAutoReply).not.toHaveBeenCalled();
    expect(repo.pickAutoReplyCandidates).not.toHaveBeenCalled();
  });

  it('drains the queue before generating anything new', async () => {
    // maxPerPoll is 1 by default, so a waiting reply takes that slot: the cap
    // protects the user's account, which cannot tell a re-offer from a first
    // attempt, and new work outranking the queue is what lets it only grow.
    const { svc, engage } = makeService({
      configs: [{ ...enabledConfig, replyPolicies: { reddit: { autoReplyEnabled: true } } }],
      queued: [queued()],
      candidates: [{ opportunityId: 'opp-new', stateId: 'st-new' }],
    });

    const due = await svc.getDueReplies(org, DURING_ACTIVE_HOURS);

    expect(due).toHaveLength(1);
    expect(due[0].sentReplyId).toBe('sent-old');
    expect(engage.queueAutoReply).not.toHaveBeenCalled();
  });

  it('claims with a fresh lease token and an expiring cutoff', async () => {
    const { svc, repo } = makeService({
      configs: [{ ...enabledConfig, replyPolicies: { reddit: { autoReplyEnabled: true } } }],
    });
    const now = new Date('2026-08-21T12:00:00Z');

    await svc.getDueReplies(org, now);

    const [, projectId, platform, opts] = repo.claimDueEngageReplies.mock.calls[0];
    expect(projectId).toBe('proj-1');
    expect(platform).toBe('reddit');
    // 30 minutes back — comfortably longer than the extension's 15-minute poll,
    // so a reply still being posted is never offered to a second client.
    expect(opts.leaseCutoff).toEqual(new Date('2026-08-21T11:30:00Z'));
    // The token identifies OUR claim, which is how the read-back tells the rows
    // we won from the ones a racing puller took.
    expect(opts.leaseToken).toMatch(/^claim_/);
  });

  it('generates into QUEUE, never into DRAFT', async () => {
    // DRAFT is a person's: it waits for them in Awaiting review and nothing
    // automated may send it. Writing an automated reply there would put it
    // somewhere nothing sends from — and make it indistinguishable from theirs.
    const { svc, engage } = makeService({
      configs: [{ ...enabledConfig, replyPolicies: { reddit: { autoReplyEnabled: true } } }],
      candidates: [{ opportunityId: 'opp-1', stateId: 'st-1' }],
    });

    await svc.getDueReplies(org, DURING_ACTIVE_HOURS);

    expect(engage.queueAutoReply).toHaveBeenCalledTimes(1);
    expect(engage.saveDraft).not.toHaveBeenCalled();
  });

  it('leaves a freshly generated reply unleased for the next poll to claim', async () => {
    // One code path holds the lease. Stamping one here too would mean two places
    // writing the same columns for the same reason.
    const { svc, repo } = makeService({
      configs: [{ ...enabledConfig, replyPolicies: { reddit: { autoReplyEnabled: true } } }],
      candidates: [{ opportunityId: 'opp-1', stateId: 'st-1' }],
    });

    const due = await svc.getDueReplies(org, DURING_ACTIVE_HOURS);

    expect(due).toHaveLength(1);
    expect(repo.claimDueEngageReplies).toHaveBeenCalledTimes(1);
  });

  // The gates decide WHEN a reply may leave, so a queued one has to pass them
  // too. It was generated under conditions that no longer hold — and a reply
  // whose send already failed once is exactly the one most likely to come back
  // round at 3am.
  it('will not hand over a queued reply outside the local-time window', async () => {
    const { svc, repo } = makeService({
      configs: [
        {
          ...enabledConfig,
          replyPolicies: {
            reddit: {
              autoReplyEnabled: true,
              windowStart: '09:00',
              windowEnd: '18:00',
              timezone: 'UTC',
            },
          },
        },
      ],
      queued: [queued()],
    });

    const due = await svc.getDueReplies(org, new Date('2026-08-21T03:00:00Z'));

    expect(due).toHaveLength(0);
    expect(repo.claimDueEngageReplies).not.toHaveBeenCalled();
  });

  it('will not hand over a queued reply inside the minimum gap', async () => {
    // Otherwise a backlog drains as fast as the extension polls — the burst the
    // gap exists to prevent, and the one an account gets rate-limited for.
    const { svc, repo } = makeService({
      configs: [{ ...enabledConfig, replyPolicies: { reddit: { autoReplyEnabled: true } } }],
      queued: [queued()],
      lastSentAt: new Date('2026-08-21T11:55:00Z'),
    });

    const due = await svc.getDueReplies(org, new Date('2026-08-21T12:00:00Z'));

    expect(due).toHaveLength(0);
    expect(repo.claimDueEngageReplies).not.toHaveBeenCalled();
  });

  it('hands over a queued reply even when the plan budget is spent', async () => {
    // The budget bounds what is PRODUCED. A queued reply was counted against it
    // when generated, so a spent budget must not strand the very replies it
    // already paid for.
    vi.stubEnv('ENGAGE_REPLY_BUDGET_GATE_ENABLED', 'true');
    const { svc, engage } = makeService({
      configs: [{ ...enabledConfig, replyPolicies: { reddit: { autoReplyEnabled: true } } }],
      queued: [queued()],
      budget: { cap: 5, sentToday: 5, remaining: 0, keywords: [] },
    });

    const due = await svc.getDueReplies(org, DURING_ACTIVE_HOURS);

    expect(due).toHaveLength(1);
    expect(due[0].sentReplyId).toBe('sent-old');
    // The budget is not even consulted before the claim.
    expect(engage.getReplyBudget).not.toHaveBeenCalled();
  });

  it('takes ONE queued reply per project+platform per poll', async () => {
    // Mirrors `_draftOne`. Draining a backlog in one burst is exactly what the
    // spacing forbids, so a backlog clears at the configured pace.
    const { svc, repo } = makeService({
      configs: [{ ...enabledConfig, replyPolicies: { reddit: { autoReplyEnabled: true } } }],
      queued: [queued()],
    });

    await svc.getDueReplies(org, DURING_ACTIVE_HOURS);

    expect(repo.claimDueEngageReplies.mock.calls[0][3].limit).toBe(1);
  });

  it('does not touch the queue for a platform the project has switched off', async () => {
    const { svc, repo } = makeService({
      configs: [{ ...enabledConfig, replyPolicies: { reddit: { autoReplyEnabled: false } } }],
    });

    await svc.getDueReplies(org, DURING_ACTIVE_HOURS);

    expect(repo.claimDueEngageReplies).not.toHaveBeenCalled();
  });
});

describe('EngageAutoReplyService.getReplyQueueStatus — mirrors the dispatch gate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reports NOT eligible when the platform floor holds the reply, not the cadence', async () => {
    // This row exists to EXPLAIN the dispatch gate. It used to compute
    // eligibility from the project cadence alone, so a post published minutes
    // earlier — which moves a clock this project never touched — left the
    // overview saying "eligible now" while getDueReplies withheld the reply.
    const { svc } = makeService({
      configs: [{ ...enabledConfig, replyPolicies: { reddit: { autoReplyEnabled: true } } }],
      lastSentAt: new Date('2026-08-18T06:00:00Z'), // 6h ago — cadence is clear
      lastPlatformWriteAt: new Date('2026-08-18T11:55:00Z'), // a POST, 5 min ago
      writeFloorMinutes: 15,
      queuedCount: 2,
    });

    const rows = await svc.getReplyQueueStatus(org, new Date('2026-08-18T12:00:00Z'));

    expect(rows[0]).toMatchObject({ withinMinGap: false, queuedCount: 2 });
    // And it names WHEN, from the floor rather than the cadence.
    expect(rows[0].nextEligibleAt).toBe(new Date('2026-08-18T12:10:00Z').toISOString());
  });

  it('reports the LATER of the cadence and the floor', async () => {
    const { svc } = makeService({
      configs: [{ ...enabledConfig, replyPolicies: { reddit: { autoReplyEnabled: true } } }],
      // The default schedule leaves hours of window across 4 replies, so the
      // cadence clears well after the floor does.
      lastSentAt: new Date('2026-08-18T11:50:00Z'),
      lastPlatformWriteAt: new Date('2026-08-18T11:55:00Z'), // floor clears at 12:10
      writeFloorMinutes: 15,
    });

    const rows = await svc.getReplyQueueStatus(org, new Date('2026-08-18T12:00:00Z'));

    // The cadence is budget-derived and jittered, so the assertion is the
    // RELATIONSHIP the row exists to report — whichever clock holds the reply
    // back longer is the one shown — not a minute the jitter may move.
    const reported = new Date(rows[0].nextEligibleAt!).getTime();
    expect(reported).toBeGreaterThan(new Date('2026-08-18T12:10:00Z').getTime());
    expect(reported).toBe(
      new Date('2026-08-18T11:50:00Z').getTime() + rows[0].minGapMinutes * 60_000
    );
  });

  it('resolves the pacing config ONCE, not per row', async () => {
    // It is a settings query, and this loop is (projects × platforms) deep.
    const { svc, platformPacing } = makeService({
      configs: [
        {
          ...enabledConfig,
          replyPolicies: {
            reddit: { autoReplyEnabled: true },
            x: { autoReplyEnabled: true },
          },
        },
      ],
    });

    await svc.getReplyQueueStatus(org, new Date('2026-08-18T12:00:00Z'));

    expect(platformPacing.getPlatformPacing).toHaveBeenCalledTimes(1);
  });
});

describe('EngageAutoReplyService.getReplyQueueStatus', () => {
  // Read-only: `getDueReplies` returning `{ due: [] }` cannot tell "nothing
  // eligible" apart from "something is eligible/queued but pacing is holding
  // it back". This is the diagnostic the extension's debug panel calls.

  it('reports queued and eligible counts per (project, platform), with no claim/draft side effects', async () => {
    const { svc, repo, engage } = makeService({
      configs: [{ ...enabledConfig, replyPolicies: { reddit: { autoReplyEnabled: true } } }],
      queuedCount: 3,
      eligibleCount: 7,
    });

    const rows = await svc.getReplyQueueStatus(org, new Date('2026-08-18T12:00:00Z'));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      projectId: 'proj-1',
      platform: 'reddit',
      policyEnabled: true,
      queuedCount: 3,
      eligibleCount: 7,
    });
    expect(repo.claimDueEngageReplies).not.toHaveBeenCalled();
    expect(repo.claimAutoReplyCandidate).not.toHaveBeenCalled();
    expect(engage.queueAutoReply).not.toHaveBeenCalled();
  });

  it('omits a platform the project has switched off, rather than reporting 0/0', async () => {
    // 0 queued / 0 eligible would read identically to "this platform is on but
    // idle" — the row must not exist at all when the switch itself is off.
    const { svc } = makeService({
      configs: [{ ...enabledConfig, replyPolicies: { reddit: { autoReplyEnabled: false } } }],
    });

    const rows = await svc.getReplyQueueStatus(org, DURING_ACTIVE_HOURS);

    expect(rows).toHaveLength(0);
  });

  it('reports withinActiveHours=false outside the write window, but still surfaces the counts', async () => {
    // Resolved from the platform's own window now, not a global pair of UTC
    // hours — and from the SAME call the dispatch gate makes, so this row cannot
    // disagree with the gate it exists to explain.
    const { svc } = makeService({
      configs: [{ ...enabledConfig, replyPolicies: { reddit: { autoReplyEnabled: true } } }],
      withinWriteWindow: false,
      queuedCount: 2,
    });

    const rows = await svc.getReplyQueueStatus(org, new Date('2026-08-18T22:00:00Z'));

    expect(rows[0]).toMatchObject({ withinActiveHours: false, queuedCount: 2 });
  });

  it('reports withinLocalWindow from the platform policy, independent of the pacing window', async () => {
    const { svc } = makeService({
      configs: [
        {
          ...enabledConfig,
          replyPolicies: {
            reddit: { autoReplyEnabled: true, windowStart: '09:00', windowEnd: '17:00' },
          },
        },
      ],
    });

    const rows = await svc.getReplyQueueStatus(org, new Date('2026-08-18T22:00:00Z'));

    expect(rows[0].withinLocalWindow).toBe(false);
  });

  it('computes nextEligibleAt from the last sent reply + the derived spacing', async () => {
    const { svc } = makeService({
      configs: [
        {
          ...enabledConfig,
          // 10:00–14:00 across 2 replies = one every 120 minutes.
          replyPolicies: {
            reddit: {
              autoReplyEnabled: true,
              windowStart: '10:00',
              windowEnd: '14:00',
              dailyReplyLimit: 2,
            },
          },
        },
      ],
      lastSentAt: new Date('2026-08-18T11:50:00Z'),
      pacing: { minGapMinutes: 25 },
    });

    const rows = await svc.getReplyQueueStatus(org, new Date('2026-08-18T12:00:00Z'));

    // 12:00 with nothing sent: 120 minutes of window left across 2 replies is a
    // 60-minute pace, ±25% of jitter — and 10 minutes have passed, so the row
    // is still gated whichever way the jitter fell.
    expect(rows[0].withinMinGap).toBe(false);
    expect(rows[0].minGapMinutes).toBeGreaterThanOrEqual(45);
    expect(rows[0].minGapMinutes).toBeLessThanOrEqual(75);
    expect(rows[0].nextEligibleAt).toBe(
      new Date(
        new Date('2026-08-18T11:50:00Z').getTime() + rows[0].minGapMinutes * 60_000
      ).toISOString()
    );
  });

  it('reports withinMinGap=true and nextEligibleAt=null once the spacing has elapsed', async () => {
    const { svc } = makeService({
      configs: [{ ...enabledConfig, replyPolicies: { reddit: { autoReplyEnabled: true } } }],
      // 220 minutes back, against the default schedule's 150.
      lastSentAt: new Date('2026-08-18T08:20:00Z'),
      pacing: { minGapMinutes: 25 },
    });

    const rows = await svc.getReplyQueueStatus(org, new Date('2026-08-18T12:00:00Z'));

    expect(rows[0].withinMinGap).toBe(true);
    expect(rows[0].nextEligibleAt).toBeNull();
  });

  // The row exists to EXPLAIN a hold, and an exhausted day is the one hold no
  // clock on the row accounts for.
  it('reports the day\'s ceiling and how much of it is spent', async () => {
    const { svc } = makeService({
      configs: [
        {
          ...enabledConfig,
          replyPolicies: {
            reddit: {
              autoReplyEnabled: true,
              windowStart: '09:00',
              windowEnd: '17:00',
              dailyReplyLimit: 3,
            },
          },
        },
      ],
      sentToday: 3,
    });

    const rows = await svc.getReplyQueueStatus(org, new Date('2026-08-18T12:00:00Z'));

    expect(rows[0]).toMatchObject({
      activeHours: { start: '09:00', end: '17:00' },
      dailyReplyLimit: 3,
      sentToday: 3,
      withinDailyLimit: false,
    });
  });

  it('reports the DEFAULT schedule for a platform that configured none', async () => {
    const { svc } = makeService({
      configs: [{ ...enabledConfig, replyPolicies: { reddit: { autoReplyEnabled: true } } }],
      sentToday: 1,
    });

    const rows = await svc.getReplyQueueStatus(org, new Date('2026-08-18T12:00:00Z'));

    expect(rows[0]).toMatchObject({
      activeHours: { start: '08:00', end: '18:00' },
      // The default, untouched: it is far below reddit's safety ceiling, so
      // nothing clamps it.
      dailyReplyLimit: 4,
      sentToday: 1,
      withinDailyLimit: true,
    });
  });

  it('never gates on the min gap when this project+platform has never sent a reply', async () => {
    const { svc } = makeService({
      configs: [{ ...enabledConfig, replyPolicies: { reddit: { autoReplyEnabled: true } } }],
      lastSentAt: null,
    });

    const rows = await svc.getReplyQueueStatus(org, DURING_ACTIVE_HOURS);

    expect(rows[0].withinMinGap).toBe(true);
    expect(rows[0].nextEligibleAt).toBeNull();
  });

  it('passes the pacing minScore through to the eligible-count query', async () => {
    const { svc, repo } = makeService({
      configs: [{ ...enabledConfig, replyPolicies: { reddit: { autoReplyEnabled: true } } }],
      pacing: { minScore: 80 },
    });

    await svc.getReplyQueueStatus(org, DURING_ACTIVE_HOURS);

    expect(repo.countEligibleOpportunities).toHaveBeenCalledWith(
      org.id,
      'proj-1',
      'reddit',
      { minScore: 80 }
    );
  });

  it('reports one row per configured platform, across multiple projects', async () => {
    const { svc } = makeService({
      configs: [
        { id: 'cfg-1', projectId: 'proj-1', replyPolicies: { reddit: { autoReplyEnabled: true } } },
        { id: 'cfg-2', projectId: 'proj-2', replyPolicies: { x: { autoReplyEnabled: true } } },
      ],
    });

    const rows = await svc.getReplyQueueStatus(org, DURING_ACTIVE_HOURS);

    expect(rows.map((r) => `${r.projectId}:${r.platform}`).sort()).toEqual([
      'proj-1:reddit',
      'proj-2:x',
    ]);
  });
});
