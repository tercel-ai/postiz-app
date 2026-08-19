import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EngageAutoReplyService,
  DEFAULT_REPLY_PACING,
  withinLocalWindow,
} from '../engage-auto-reply.service';

// The unattended reply DRIVER. The behavioural contract that matters most: it
// can never hand out more than the send-time gate would let through (both read
// EngageService.getReplyBudget), and it must never invent a target for a project
// whose plan does not set one.

const org = { id: 'org-1' } as any;

function makeService(over: {
  configs?: any[];
  budget?: any;
  candidates?: any[];
  lastSentAt?: Date | null;
  pacing?: Partial<typeof DEFAULT_REPLY_PACING>;
  opportunity?: any;
} = {}) {
  const repo = {
    getAutoReplyConfigs: vi.fn().mockResolvedValue(over.configs ?? []),
    pickAutoReplyCandidates: vi.fn().mockResolvedValue(over.candidates ?? []),
    claimAutoReplyCandidate: vi.fn().mockResolvedValue(true),
    releaseAutoReplyCandidate: vi.fn().mockResolvedValue(undefined),
    getLastSentReplyAt: vi.fn().mockResolvedValue(over.lastSentAt ?? null),
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
  autoReplyMode: 'auto',
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

  it('drafts one reply and parks it as a DRAFT row', async () => {
    const { svc, engage } = makeService({
      configs: [enabledConfig],
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
      mode: 'auto',
    });
    // The DRAFT row is the commit point — it is what stops the next poll from
    // drafting the same opportunity again.
    expect(engage.saveDraft).toHaveBeenCalledTimes(1);
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
    engage.saveDraft.mockRejectedValue(new Error('db down'));

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

  it('hands out NOTHING when the project has no active plan', async () => {
    const { svc, repo, engage } = makeService({
      configs: [enabledConfig],
      // cap: null is what getReplyBudget returns with no plan. The send-time gate
      // reads it as "uncapped, do not block"; the driver must read the SAME value
      // as "nothing to drive" and never invent a target.
      budget: { cap: null, sentToday: 0, remaining: null, keywords: [] },
      candidates: [{ opportunityId: 'opp-1', score: 90, matchedKeywords: [] }],
    });

    expect(await svc.getDueReplies(org, new Date('2026-08-18T12:00:00Z'))).toEqual([]);
    expect(repo.pickAutoReplyCandidates).not.toHaveBeenCalled();
    expect(engage.saveDraft).not.toHaveBeenCalled();
  });

  it('hands out nothing once the day\'s budget is spent', async () => {
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

  it('never exceeds maxPerPoll across projects', async () => {
    const { svc } = makeService({
      configs: [
        { ...enabledConfig, id: 'c1', projectId: 'p1' },
        { ...enabledConfig, id: 'c2', projectId: 'p2' },
      ],
      budget: budgetWith(),
      candidates: [{ opportunityId: 'opp-1', score: 90, matchedKeywords: [] }],
      pacing: { maxPerPoll: 1 },
    });

    // A trickle per poll is what spreads a day's target across the day; handing
    // out a whole budget at once is what gets an account rate-limited.
    expect(await svc.getDueReplies(org, new Date('2026-08-18T12:00:00Z'))).toHaveLength(1);
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
    expect(engage.saveDraft).not.toHaveBeenCalled();
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
    expect(due[0]).toMatchObject({ platform: 'x', mode: 'review' });
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
    // (Whether 'auto' mode can actually post there is a SEPARATE, extension-side
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

    expect(engage.saveDraft).toHaveBeenCalledWith(
      org,
      'opp-1',
      expect.objectContaining({ strategy: 'AMPLIFY' })
    );
  });
});

// Found on re-review: settleReplyGeneration ran BEFORE saveDraft. A saveDraft
// failure after a successful settle would charge for a draft that exists
// nowhere retrievable — no EngageSentReply row, so pickAutoReplyCandidates
// would offer the SAME opportunity again next poll, re-drafting (and
// re-charging) it every cycle with each earlier draft silently discarded.
describe('EngageAutoReplyService.getDueReplies — settle ordering', () => {
  beforeEach(() => vi.clearAllMocks());

  it('releases (never settles) the reservation when saveDraft fails', async () => {
    const { svc, engage } = makeService({
      configs: [enabledConfig],
      budget: budgetWith(),
      candidates: [{ opportunityId: 'opp-1', score: 90, matchedKeywords: [] }],
    });
    engage.saveDraft.mockRejectedValue(new Error('db down'));

    const due = await svc.getDueReplies(org, new Date('2026-08-18T12:00:00Z'));

    expect(due).toEqual([]);
    expect(engage.releaseReplyGeneration).toHaveBeenCalledWith('task-1');
    expect(engage.settleReplyGeneration).not.toHaveBeenCalled();
  });

  it('settles only after saveDraft has already succeeded', async () => {
    const { svc, engage } = makeService({
      configs: [enabledConfig],
      budget: budgetWith(),
      candidates: [{ opportunityId: 'opp-1', score: 90, matchedKeywords: [] }],
    });
    const callOrder: string[] = [];
    engage.saveDraft.mockImplementation(async () => {
      callOrder.push('saveDraft');
      return { id: 'sent-1' };
    });
    engage.settleReplyGeneration.mockImplementation(async () => {
      callOrder.push('settle');
    });

    await svc.getDueReplies(org, new Date('2026-08-18T12:00:00Z'));

    expect(callOrder).toEqual(['saveDraft', 'settle']);
  });
});
