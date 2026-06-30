import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  EngageScanTasksService,
  buildTrackedKeywordQuery,
  buildRedditChannelKeywordQuery,
} from '../engage-scan-tasks.service';
import { DEFAULT_SCAN_PACING } from '../engage-scan-config.service';

function build(opts: {
  orgContext?: any;
  unitByToken?: any;
  subscribers?: any[];
  claimResults?: any[];
} = {}) {
  let claimCall = 0;
  const engageRepo = {
    getEnabledOrgContext: vi.fn(async () => opts.orgContext ?? null),
    findScanCursorByToken: vi.fn(async () => opts.unitByToken ?? null),
    getOrgContextsForUnit: vi.fn(async () => opts.subscribers ?? []),
  };
  const lease = {
    claim: vi.fn(async () => (opts.claimResults ?? [])[claimCall++] ?? null),
    completeByToken: vi.fn(async () => true),
    releaseByToken: vi.fn(async () => true),
  };
  const ingest = { ingestForOrg: vi.fn(async () => 3) };
  const config = { getPacing: vi.fn(async () => DEFAULT_SCAN_PACING) };
  const entitlement = { getScanIntervalHours: vi.fn(async () => 6) };

  const svc = new EngageScanTasksService(
    engageRepo as any,
    lease as any,
    ingest as any,
    config as any,
    entitlement as any
  );
  return { svc, engageRepo, lease, ingest };
}

function snap(over: any = {}) {
  return {
    id: 'cur1',
    platform: 'reddit',
    scanType: 'keyword',
    scanKey: 'ai',
    lastSeenExternalId: null,
    lastSeenAt: null,
    leaseToken: 'tok_abc',
    ...over,
  };
}

describe('EngageScanTasksService.sync — claim (bootstrap)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns [] when the org has no enabled config', async () => {
    const { svc } = build({ orgContext: null });
    expect(await svc.sync('org1', {})).toEqual({ accepted: 0, nextTasks: [] });
  });

  it('claims up to `want` units and exposes the leaseToken as taskId (not the cursor id)', async () => {
    const { svc } = build({
      orgContext: {
        keywords: [{ keyword: 'AI', enabled: true }],
        monitoredChannels: [],
        trackedAccounts: [],
      },
      claimResults: [snap({ platform: 'x', leaseToken: 'tokX' }), snap({ platform: 'reddit', leaseToken: 'tokR' })],
    });
    const res = await svc.sync('org1', { want: 2 });
    expect(res.nextTasks).toHaveLength(2);
    expect(res.nextTasks.map((t) => t.taskId)).toEqual(['tokX', 'tokR']);
    expect(res.nextTasks[0]).not.toHaveProperty('id');
    // initial phase (no cursor) → extension reddit/x initial pacing
    expect(res.nextTasks[1].pacing.maxPages).toBe(
      DEFAULT_SCAN_PACING.extension.reddit.initial.maxPages
    );
    expect(res.nextTasks[1].pacing.hourlyRequestCap).toBe(
      DEFAULT_SCAN_PACING.extension.session.hourlyRequestCap
    );
  });

  it('stops at `want` even if more units are due', async () => {
    const { svc, lease } = build({
      orgContext: {
        keywords: [{ keyword: 'a', enabled: true }, { keyword: 'b', enabled: true }],
        monitoredChannels: [],
        trackedAccounts: [],
      },
      claimResults: [snap(), snap(), snap(), snap()],
    });
    const res = await svc.sync('org1', { want: 1 });
    expect(res.nextTasks).toHaveLength(1);
    expect(lease.claim).toHaveBeenCalledTimes(1); // stopped early
  });
});

describe('EngageScanTasksService.sync — ingest completed', () => {
  beforeEach(() => vi.clearAllMocks());

  it('drops an ingest with an invalid/expired lease token', async () => {
    const { svc, ingest, lease } = build({ unitByToken: null });
    const res = await svc.sync('org1', {
      completed: { taskId: 'stale', posts: [] },
    });
    expect(res.accepted).toBe(0);
    expect(ingest.ingestForOrg).not.toHaveBeenCalled();
    expect(lease.completeByToken).not.toHaveBeenCalled();
  });

  it('fans out to subscribers, derives cursor from posts, then completes by token', async () => {
    // Clearly-past dates so the future-clamp (W1) never filters them.
    const newest = new Date('2020-01-02T12:00:00.000Z');
    const { svc, engageRepo, ingest, lease } = build({
      unitByToken: { id: 'cur1', platform: 'reddit', scanType: 'keyword', scanKey: 'ai' },
      subscribers: [{ organizationId: 'o1' }, { organizationId: 'o2' }],
    });
    const posts = [
      { externalPostId: 't3_old', postPublishedAt: new Date('2020-01-01T10:00:00.000Z') },
      { externalPostId: 't3_new', postPublishedAt: newest },
    ];
    const res = await svc.sync('org1', {
      completed: { taskId: 'tok_abc', posts } as any,
    });

    expect(engageRepo.getOrgContextsForUnit).toHaveBeenCalledWith('reddit', 'keyword', 'ai');
    expect(ingest.ingestForOrg).toHaveBeenCalledTimes(2); // o1 + o2
    expect(res.accepted).toBe(6); // 3 per org (mock)
    // cursor derived from the NEWEST post, not trusting the client
    const [token, cursor] = lease.completeByToken.mock.calls[0];
    expect(token).toBe('tok_abc');
    expect(cursor).toEqual({ lastSeenExternalId: 't3_new', lastSeenAt: newest });
  });

  it('isolates a per-org ingest failure and STILL completes the lease (W2)', async () => {
    const { svc, ingest, lease } = build({
      unitByToken: { id: 'cur1', platform: 'reddit', scanType: 'keyword', scanKey: 'ai' },
      subscribers: [{ organizationId: 'o1' }, { organizationId: 'o2' }],
    });
    ingest.ingestForOrg.mockRejectedValueOnce(new Error('LLM down')); // o1 throws
    const res = await svc.sync('org1', {
      completed: { taskId: 'tok_abc', posts: [] } as any,
    });
    expect(ingest.ingestForOrg).toHaveBeenCalledTimes(2); // o2 still attempted
    expect(res.accepted).toBe(3); // only o2 counted
    expect(lease.completeByToken).toHaveBeenCalledTimes(1); // lease NOT stranded
  });

  it('releases (without advancing) when subscriber resolution throws (W2)', async () => {
    const { svc, engageRepo, lease } = build({
      unitByToken: { id: 'cur1', platform: 'reddit', scanType: 'keyword', scanKey: 'ai' },
    });
    engageRepo.getOrgContextsForUnit.mockRejectedValueOnce(new Error('DB down'));
    const res = await svc.sync('org1', {
      completed: { taskId: 'tok_abc', posts: [] } as any,
    });
    expect(res.accepted).toBe(0);
    expect(lease.releaseByToken).toHaveBeenCalledWith('tok_abc');
    expect(lease.completeByToken).not.toHaveBeenCalled(); // cursor not advanced
  });

  it('ignores a future-dated post when deriving the cursor (W1 — no cross-org poisoning)', async () => {
    const past = new Date('2020-01-01T10:00:00.000Z');
    const future = new Date('2099-01-01T00:00:00.000Z');
    const { svc, lease } = build({
      unitByToken: { id: 'cur1', platform: 'reddit', scanType: 'keyword', scanKey: 'ai' },
      subscribers: [{ organizationId: 'o1' }],
    });
    const posts = [
      { externalPostId: 't3_real', postPublishedAt: past },
      { externalPostId: 't3_forged', postPublishedAt: future },
    ];
    await svc.sync('org1', { completed: { taskId: 'tok_abc', posts } as any });
    const [, cursor] = lease.completeByToken.mock.calls[0];
    // The forged future post must NOT become the cursor (id or timestamp).
    expect(cursor).toEqual({ lastSeenExternalId: 't3_real', lastSeenAt: past });
  });
});

describe('buildTrackedKeywordQuery', () => {
  it('returns undefined for empty keyword list', () => {
    expect(buildTrackedKeywordQuery('elonmusk', [])).toBeUndefined();
  });

  it('builds correct from:account (kw) query for a single keyword', () => {
    expect(buildTrackedKeywordQuery('sama', ['openai'])).toBe(
      'from:sama (openai)'
    );
  });

  it('joins multiple keywords with OR', () => {
    expect(buildTrackedKeywordQuery('sama', ['openai', 'claude', 'gpt'])).toBe(
      'from:sama (openai OR claude OR gpt)'
    );
  });

  it('quotes multi-word keywords', () => {
    expect(buildTrackedKeywordQuery('sama', ['open source', 'claude ai'])).toBe(
      'from:sama ("open source" OR "claude ai")'
    );
  });

  it('truncates keywords that would exceed the 460-char budget', () => {
    const manyKws = Array.from({ length: 100 }, (_, i) => `keyword${i}`);
    const result = buildTrackedKeywordQuery('user', manyKws);
    expect(result).toBeDefined();
    expect(result!.length).toBeLessThanOrEqual(460);
    expect(result).toMatch(/^from:user \(/);
  });

  it('returns undefined when username alone exceeds budget', () => {
    const longUser = 'u'.repeat(450);
    const result = buildTrackedKeywordQuery(longUser, ['openai']);
    expect(result).toBeUndefined();
  });
});

describe('buildRedditChannelKeywordQuery', () => {
  it('returns undefined for empty keyword list', () => {
    expect(buildRedditChannelKeywordQuery([])).toBeUndefined();
  });

  it('returns a single keyword as-is', () => {
    expect(buildRedditChannelKeywordQuery(['openai'])).toBe('openai');
  });

  it('joins multiple keywords with OR', () => {
    expect(buildRedditChannelKeywordQuery(['openai', 'claude', 'gpt'])).toBe(
      'openai OR claude OR gpt'
    );
  });

  it('quotes multi-word keywords', () => {
    expect(buildRedditChannelKeywordQuery(['open source', 'large language model'])).toBe(
      '"open source" OR "large language model"'
    );
  });

  it('truncates keywords that would exceed the 480-char budget', () => {
    const manyKws = Array.from({ length: 100 }, (_, i) => `keyword${i}`);
    const result = buildRedditChannelKeywordQuery(manyKws);
    expect(result).toBeDefined();
    expect(result!.length).toBeLessThanOrEqual(480);
  });

  it('produces a query usable as a Reddit search q param (no from: prefix)', () => {
    const result = buildRedditChannelKeywordQuery(['openai', 'claude']);
    expect(result).not.toMatch(/^from:/);
  });
});
