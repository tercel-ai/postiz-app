import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EngageAutoReplyService,
  DEFAULT_REPLY_PACING,
  withinLocalWindow,
} from '../engage-auto-reply.service';

// The unattended reply DRIVER. By default (ENGAGE_REPLY_BUDGET_GATE_ENABLED
// unset) it is paced by interval/active-hours alone and does not require an
// operation plan. With the flag set to 'true' it additionally never hands out
// more than the send-time gate would let through (both read
// EngageService.getReplyBudget), and never invents a target for a project
// whose plan does not set one.

const org = { id: 'org-1' } as any;

function makeService(over: {
  configs?: any[];
  budget?: any;
  candidates?: any[];
  lastSentAt?: Date | null;
  pacing?: Partial<typeof DEFAULT_REPLY_PACING>;
  opportunity?: any;
  queued?: any[];
} = {}) {
  const repo = {
    getAutoReplyConfigs: vi.fn().mockResolvedValue(over.configs ?? []),
    pickAutoReplyCandidates: vi.fn().mockResolvedValue(over.candidates ?? []),
    claimAutoReplyCandidate: vi.fn().mockResolvedValue(true),
    releaseAutoReplyCandidate: vi.fn().mockResolvedValue(undefined),
    getLastSentReplyAt: vi.fn().mockResolvedValue(over.lastSentAt ?? null),
    claimDueEngageReplies: vi.fn().mockResolvedValue(over.queued ?? []),
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

  const settings = {
    get: vi.fn().mockResolvedValue({ ...DEFAULT_REPLY_PACING, ...(over.pacing ?? {}) }),
    set: vi.fn().mockResolvedValue(undefined),
  } as any;

  return {
    svc: new EngageAutoReplyService(repo, engage, draft, settings),
    repo,
    engage,
    draft,
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

  it('hands out nothing outside the configured active window', async () => {
    const { svc, repo } = makeService({
      configs: [enabledConfig],
      budget: budgetWith(),
      pacing: { activeHoursUtc: [9, 18] },
    });

    // 03:00 UTC — outside [9,18). Checked before any query.
    expect(await svc.getDueReplies(org, new Date('2026-08-18T03:00:00Z'))).toEqual([]);
    expect(repo.getAutoReplyConfigs).not.toHaveBeenCalled();
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

describe('EngageAutoReplyService.getDueReplies — per-platform overrides', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses the platform\'s checkIntervalMinutes instead of the global default', async () => {
    const { svc, repo } = makeService({
      configs: [
        {
          ...enabledConfig,
          replyPolicies: { reddit: { autoReplyEnabled: true, checkIntervalMinutes: 5 } },
        },
      ],
      budget: budgetWith(),
      candidates: [{ opportunityId: 'opp-1', score: 90, matchedKeywords: [] }],
      // 10 minutes ago: under the 25-min GLOBAL default, but over this
      // platform's 5-min override — so it should still be due.
      lastSentAt: new Date('2026-08-18T11:50:00Z'),
    });

    await svc.getDueReplies(org, new Date('2026-08-18T12:00:00Z'));

    expect(repo.pickAutoReplyCandidates).toHaveBeenCalled();
  });

  it('falls back to the global minGapMinutes when the platform sets none', async () => {
    const { svc, repo } = makeService({
      configs: [{ ...enabledConfig, replyPolicies: { reddit: { autoReplyEnabled: true } } }],
      budget: budgetWith(),
      candidates: [{ opportunityId: 'opp-1', score: 90, matchedKeywords: [] }],
      lastSentAt: new Date('2026-08-18T11:50:00Z'), // 10 min ago, under the 25-min default
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

    const due = await svc.getDueReplies(org);

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

    const due = await svc.getDueReplies(org);

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

    await svc.getDueReplies(org);

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

    const due = await svc.getDueReplies(org);

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

    const due = await svc.getDueReplies(org);

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

    await svc.getDueReplies(org);

    expect(repo.claimDueEngageReplies.mock.calls[0][3].limit).toBe(1);
  });

  it('does not touch the queue for a platform the project has switched off', async () => {
    const { svc, repo } = makeService({
      configs: [{ ...enabledConfig, replyPolicies: { reddit: { autoReplyEnabled: false } } }],
    });

    await svc.getDueReplies(org);

    expect(repo.claimDueEngageReplies).not.toHaveBeenCalled();
  });
});
