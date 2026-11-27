import { describe, expect, it, vi } from 'vitest';
import {
  applyResolvedRedditTarget,
  clearRedditTargetPending,
  readRedditTargetPending,
  REDDIT_TARGET_PENDING_KEY,
  settingsHavePendingRedditTarget,
} from '@gitroom/nestjs-libraries/engage/reddit-pending-target';

const parked = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    __type: 'reddit',
    contentId: 'D01',
    [REDDIT_TARGET_PENDING_KEY]: {
      candidate: 'claudeai',
      title: '[D] Shipping an MCP server',
      flairLabel: 'Discussion',
      reason: 'egress-unavailable',
      since: '2026-09-21T00:00:00.000Z',
    },
    ...extra,
  });

describe('reading the parked marker', () => {
  it('reads a well-formed marker', () => {
    const pending = readRedditTargetPending(parked());
    expect(pending).toEqual({
      candidate: 'claudeai',
      title: '[D] Shipping an MCP server',
      flairLabel: 'Discussion',
      reason: 'egress-unavailable',
      since: '2026-09-21T00:00:00.000Z',
    });
  });

  it('returns null for settings that carry no marker', () => {
    expect(readRedditTargetPending(JSON.stringify({ __type: 'reddit' }))).toBeNull();
    expect(settingsHavePendingRedditTarget(JSON.stringify({ __type: 'x' }))).toBe(false);
  });

  it('survives null, empty and unparseable settings', () => {
    expect(readRedditTargetPending(null)).toBeNull();
    expect(readRedditTargetPending('')).toBeNull();
    expect(readRedditTargetPending('{not json')).toBeNull();
    expect(readRedditTargetPending('"a string"')).toBeNull();
  });

  it('rejects a marker with no title — there would be nothing to submit', () => {
    const broken = JSON.stringify({
      [REDDIT_TARGET_PENDING_KEY]: { candidate: 'claudeai' },
    });
    expect(readRedditTargetPending(broken)).toBeNull();
  });

  it('tolerates a missing candidate — the resolver searches instead', () => {
    const noCandidate = JSON.stringify({
      [REDDIT_TARGET_PENDING_KEY]: { title: 'A post', reason: 'no-candidate' },
    });
    expect(readRedditTargetPending(noCandidate)?.candidate).toBeNull();
  });
});

describe('applying a resolution', () => {
  it('writes the subreddit and REMOVES the marker in one value', () => {
    const next = applyResolvedRedditTarget(parked(), {
      subreddit: 'claudeai',
      title: '[D] Shipping an MCP server',
      type: 'self',
    });
    const parsed = JSON.parse(next);

    expect(parsed[REDDIT_TARGET_PENDING_KEY]).toBeUndefined();
    expect(parsed.subreddit).toEqual([
      {
        value: {
          subreddit: 'claudeai',
          title: '[D] Shipping an MCP server',
          type: 'self',
          is_flair_required: false,
        },
      },
    ]);
    // A post can never be both parked and resolved — that is the whole point of
    // doing it in one write.
    expect(settingsHavePendingRedditTarget(next)).toBe(false);
  });

  it('preserves unrelated settings keys', () => {
    const next = applyResolvedRedditTarget(parked({ campaignId: 'c-1' }), {
      subreddit: 'claudeai',
      title: 'T',
      type: 'self',
    });
    const parsed = JSON.parse(next);
    expect(parsed.__type).toBe('reddit');
    expect(parsed.contentId).toBe('D01');
    expect(parsed.campaignId).toBe('c-1');
  });

  it('pins is_flair_required false even when a flair requirement was observed', () => {
    // The DTO makes `flair` ({id,name}) conditionally required on this field and
    // nothing can supply a flair id without OAuth, so a true here would make the
    // post fail validation on every later save. The observation rides in
    // flairRequired instead.
    const next = applyResolvedRedditTarget(parked(), {
      subreddit: 'machinelearning',
      title: 'T',
      type: 'self',
      flairLabel: 'Research',
      flairRequired: true,
    });
    const value = JSON.parse(next).subreddit[0].value;
    expect(value.is_flair_required).toBe(false);
    expect(value.flairRequired).toBe(true);
    expect(value.flairLabel).toBe('Research');
  });

  it('omits flair fields entirely when there are none', () => {
    const value = JSON.parse(
      applyResolvedRedditTarget(parked(), {
        subreddit: 'claudeai',
        title: 'T',
        type: 'self',
      })
    ).subreddit[0].value;
    expect('flairLabel' in value).toBe(false);
    expect('flairRequired' in value).toBe(false);
  });

  it('works from null settings', () => {
    const next = applyResolvedRedditTarget(null, {
      subreddit: 'claudeai',
      title: 'T',
      type: 'self',
    });
    expect(JSON.parse(next).subreddit[0].value.subreddit).toBe('claudeai');
  });
});

describe('clearing without resolving', () => {
  it('drops the marker and leaves no subreddit behind', () => {
    const next = clearRedditTargetPending(parked());
    const parsed = JSON.parse(next);
    expect(parsed[REDDIT_TARGET_PENDING_KEY]).toBeUndefined();
    expect(parsed.subreddit).toBeUndefined();
    expect(parsed.__type).toBe('reddit');
  });
});

describe('the publish-due guard contract', () => {
  it('the serialized marker contains the exact key the SQL filter matches', () => {
    // PostsRepository excludes parked posts with a raw `contains` on the
    // quoted key, because `settings` is a JSON string column. If this ever
    // stops holding, parked posts silently enter the publish queue and are
    // re-offered forever.
    expect(parked()).toContain(`"${REDDIT_TARGET_PENDING_KEY}"`);
    const resolved = applyResolvedRedditTarget(parked(), {
      subreddit: 'claudeai',
      title: 'T',
      type: 'self',
    });
    expect(resolved).not.toContain(`"${REDDIT_TARGET_PENDING_KEY}"`);
  });
});


describe('legacy queued Reddit Flair staging', () => {
  it('marks an untouched queued Plan post for the existing resolver', async () => {
    const { stageLegacyRedditFlairIn } = await import('../reddit-plan-readiness');
    const post: any = { id: 'p', organizationId: 'org', group: 'g', parentPostId: null,
      operationPlanId: 'plan', projectId: 'project', providerIdentifier: 'reddit', state: 'QUEUE',
      sendIntentId: null, claimedAt: null, releaseId: null, releaseURL: null, routeRevision: 0, contentRevision: 0,
      settings: JSON.stringify({ subreddit: [{ value: { subreddit: 'test', title: 'Title', type: 'self' } }] }) };
    const tx: any = { post: { findMany: vi.fn(async () => [post]), updateMany: vi.fn(async () => ({ count: 1 })) },
      sendMutationReceipt: { findMany: vi.fn(async () => []) } };
    expect(await stageLegacyRedditFlairIn(tx, post)).toBe(true);
    const settings = JSON.parse(tx.post.updateMany.mock.calls[0][0].data.settings);
    expect(settings).toMatchObject({ redditLegacyFlairResolution: true, redditTargetPending: {
      candidate: 'test', title: 'Title', reason: 'flair-pending', selectFlair: true } });
  });

  it.each([false, true])('stages a prior controlled execution only when it has no submission permit (authorized=%s)', async authorized => {
    const { stageLegacyRedditFlairIn } = await import('../reddit-plan-readiness');
    const post: any = { id: 'p', organizationId: 'org', group: 'g', parentPostId: null,
      operationPlanId: 'plan', projectId: 'project', providerIdentifier: 'reddit', state: 'QUEUE',
      publishMethod: 'EXTENSION', sendIntentId: 'intent', claimedAt: null, releaseId: null, releaseURL: null,
      routeRevision: 1, contentRevision: 2,
      settings: JSON.stringify({ subreddit: [{ value: { subreddit: 'test', title: 'Title', type: 'self' } }] }) };
    const intent = { id: 'intent', rootPostId: 'p', action: 'POST', status: 'QUEUED', activeExecutionId: null,
      hasConfirmedSegments: false, routeRevision: 1, contentRevision: 2 };
    const execution = { id: 'execution', kind: 'EXTENSION', action: 'POST', status: 'EXPIRED', startedAt: null,
      context: { authorizationMode: 'NATIVE_FLOW_V1' }, routeRevision: 1, contentRevision: 2,
      payload: [{ id: 'p', contentHash: 'hash' }] };
    const segment = { executionId: 'execution', postId: 'p', segmentIndex: 0, contentHash: 'hash',
      status: 'PENDING', result: null, authorizedAt: authorized ? new Date() : null,
      permitHash: null, submitBefore: null, confirmedAt: null };
    const tx: any = { post: { findMany: vi.fn(async () => [post]), updateMany: vi.fn(async () => ({ count: 1 })) },
      sendIntent: { findFirst: vi.fn(async () => intent) }, sendExecution: { findMany: vi.fn(async () => [execution]) },
      sendSegment: { findMany: vi.fn(async () => [segment]) }, sendMutationReceipt: { findMany: vi.fn(async () => []) } };
    expect(await stageLegacyRedditFlairIn(tx, post)).toBe(!authorized);
    expect(tx.post.updateMany).toHaveBeenCalledTimes(authorized ? 0 : 1);
  });

  it.each(['NOT_SUBMITTED', 'UNKNOWN', 'CONFIRMED'] as const)(
    'stages an autonomous lease only with matching NOT_SUBMITTED proof (%s)', async status => {
      const { stageLegacyRedditFlairIn } = await import('../reddit-plan-readiness');
      const claimedAt = new Date('2026-10-01T10:00:00Z');
      const post: any = { id: 'p', organizationId: 'org', group: 'g', parentPostId: null,
        operationPlanId: 'plan', projectId: 'project', providerIdentifier: 'reddit', state: 'QUEUE',
        sendIntentId: null, claimedAt, releaseId: 'lease', releaseURL: null, routeRevision: 0, contentRevision: 0,
        settings: JSON.stringify({ subreddit: [{ value: { subreddit: 'test', title: 'Title', type: 'self' } }] }) };
      const receipt = { result: { status, source: 'BROWSER', action: 'POST', platform: 'reddit',
        postIds: ['p'], postClaim: { releaseId: 'lease', claimedAt: claimedAt.toISOString() } } };
      const tx: any = { post: { findMany: vi.fn(async () => [post]), updateMany: vi.fn(async () => ({ count: 1 })) },
        sendMutationReceipt: { findMany: vi.fn(async () => [receipt]) } };
      expect(await stageLegacyRedditFlairIn(tx, post)).toBe(status === 'NOT_SUBMITTED');
      if (status === 'NOT_SUBMITTED') {
        const update = tx.post.updateMany.mock.calls[0][0];
        expect(update.where).toMatchObject({ releaseId: 'lease', claimedAt });
        expect(update.data).toMatchObject({ releaseId: null });
        expect(update.data).not.toHaveProperty('claimedAt');
      } else expect(tx.post.updateMany).not.toHaveBeenCalled();
    }
  );

  it.each([undefined, 'other-lease'])('never infers the original claim from missing or changed binding (%s)', async boundLease => {
    const { stageLegacyRedditFlairIn } = await import('../reddit-plan-readiness');
    const claimedAt = new Date('2026-10-01T10:00:00Z');
    const post: any = { id: 'p', organizationId: 'org', group: 'g', parentPostId: null,
      operationPlanId: 'plan', projectId: 'project', providerIdentifier: 'reddit', state: 'QUEUE',
      sendIntentId: null, claimedAt, releaseId: 'lease', releaseURL: null, routeRevision: 0, contentRevision: 0,
      settings: JSON.stringify({ subreddit: [{ value: { subreddit: 'test', title: 'Title', type: 'self' } }] }) };
    const tx: any = { post: { findMany: vi.fn(async () => [post]), updateMany: vi.fn() },
      sendMutationReceipt: { findMany: vi.fn(async () => [{ result: { status: 'NOT_SUBMITTED', source: 'BROWSER',
        action: 'POST', platform: 'reddit', postIds: ['p'], ...(boundLease ? { postClaim: {
          releaseId: boundLease, claimedAt: claimedAt.toISOString() } } : {}) } }]) } };
    expect(await stageLegacyRedditFlairIn(tx, post)).toBe(false);
    expect(tx.post.updateMany).not.toHaveBeenCalled();
  });

  it('preserves a post with any previous browser write receipt', async () => {
    const { stageLegacyRedditFlairIn } = await import('../reddit-plan-readiness');
    const post: any = { id: 'p', organizationId: 'org', group: 'g', parentPostId: null,
      operationPlanId: 'plan', projectId: 'project', providerIdentifier: 'reddit', state: 'QUEUE',
      sendIntentId: null, claimedAt: null, releaseId: null, releaseURL: null,
      settings: JSON.stringify({ subreddit: [{ value: { subreddit: 'test', title: 'Title', type: 'self' } }] }) };
    const tx: any = { post: { findMany: vi.fn(async () => [post]), updateMany: vi.fn() },
      sendMutationReceipt: { findMany: vi.fn(async () => [{ result: { status: 'UNKNOWN', postIds: ['p'] } }]) } };
    expect(await stageLegacyRedditFlairIn(tx, post)).toBe(false);
    expect(tx.post.updateMany).not.toHaveBeenCalled();
  });

  it('does not stage a claimed post or overwrite a selected Flair', async () => {
    const { stageLegacyRedditFlairIn } = await import('../reddit-plan-readiness');
    const tx: any = { post: { findMany: vi.fn(), updateMany: vi.fn() } };
    const base: any = { id: 'p', organizationId: 'org', group: 'g', parentPostId: null,
      operationPlanId: 'plan', projectId: 'project', providerIdentifier: 'reddit', state: 'QUEUE',
      sendIntentId: null, releaseId: null, releaseURL: null, settings: JSON.stringify({ subreddit: [{ value: {
        subreddit: 'test', title: 'Title', type: 'self', flairLabel: 'Discussion' } }] }) };
    expect(await stageLegacyRedditFlairIn(tx, { ...base, claimedAt: null })).toBe(false);
    expect(await stageLegacyRedditFlairIn(tx, { ...base, claimedAt: new Date(), settings: '{}' })).toBe(false);
    expect(tx.post.updateMany).not.toHaveBeenCalled();
  });
});
