import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SendModeService } from '../send-mode.service';
import { RedditTargetResolutionService } from '../../engage/reddit-target-resolution.service';
import { memorySendDatabase } from './support/memory-send-database';
const owner = { expectedOrganizationId: 'org', expectedUserId: 'user' };
const begin = {
  ...owner,
  requestId: 'write',
  platform: 'x',
  contentHash: 'a'.repeat(64),
};
const change = {
  mode: 'CONTROLLED' as const,
  expectedRevision: 0,
  requestId: 'switch',
  expectedOrganizationId: 'org',
  expectedUserId: 'user',
};
function setup() {
  const db = memorySendDatabase();
  db.seed('userOrganization', {
    organizationId: 'org',
    userId: 'user',
    role: 'ADMIN',
    disabled: false,
  });
  db.seed('userOrganization', {
    organizationId: 'org',
    userId: 'other',
    role: 'ADMIN',
    disabled: false,
  });
  return { db, service: new SendModeService(db) };
}
beforeEach(() => vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'true'));
afterEach(() => vi.unstubAllEnvs());
describe('durable browser write admission', () => {
  it.each([
    { redditTargetPending: { title: 'Post', reason: 'flair-pending' } },
    { subreddit: [{ value: { subreddit: 'test', flairRequired: true } }] },
  ])('does not authorize a cached Reddit plan post that needs Flair: %o', async (settings) => {
    const { db, service } = setup();
    db.seed('post', { id: 'reddit-post', organizationId: 'org', deletedAt: null,
      state: 'QUEUE', providerIdentifier: 'reddit', sendIntentId: null,
      executionProtocol: null, operationPlanId: 'plan', settings: JSON.stringify(settings) });
    await expect(service.beginBrowserWrite('org', 'user', {
      ...begin, platform: 'reddit', postId: 'reddit-post',
    })).rejects.toThrow('REDDIT_FLAIR_PENDING');
    expect(db.rows('sendMutationReceipt')).toHaveLength(0);
  });

  it('requires the current resolved Flair revision before admitting a cached legacy Reddit task', async () => {
    const { db, service } = setup();
    const settings = JSON.stringify({ redditLegacyFlairResolution: true,
      subreddit: [{ value: { subreddit: 'test', flairLabel: 'Discussion' } }] });
    db.seed('post', { id: 'reddit-post', organizationId: 'org', deletedAt: null,
      state: 'QUEUE', providerIdentifier: 'reddit', sendIntentId: null,
      executionProtocol: null, operationPlanId: 'plan', settings });
    const body = { ...begin, platform: 'reddit', postId: 'reddit-post' };
    await expect(service.beginBrowserWrite('org', 'user', body)).rejects.toThrow('REDDIT_FLAIR_CONTENT_CHANGED');
    await expect(service.beginBrowserWrite('org', 'user', { ...body, redditFlairRevision: 'a'.repeat(64) }))
      .rejects.toThrow('REDDIT_FLAIR_CONTENT_CHANGED');
    const { sendHash } = await import('../send-coordination.utils');
    expect(await service.beginBrowserWrite('org', 'user', { ...body, redditFlairRevision: sendHash(settings) }))
      .toMatchObject({ admitted: true });
  });

  it('identifies a required-Flair draft as needing user editing rather than temporary waiting', async () => {
    const { db, service } = setup();
    db.seed('post', { id: 'reddit-post', organizationId: 'org', deletedAt: null, state: 'DRAFT',
      providerIdentifier: 'reddit', sendIntentId: null, executionProtocol: null, operationPlanId: 'plan',
      projectId: 'project', parentPostId: null, releaseURL: null, settings: JSON.stringify({ subreddit: [{ value: {
        subreddit: 'test', title: 'Title', flairRequired: true } }] }) });
    await expect(service.beginBrowserWrite('org', 'user', { ...begin, platform: 'reddit', postId: 'reddit-post' }))
      .rejects.toThrow('REDDIT_FLAIR_REQUIRED_DRAFT');
    expect(db.rows('sendMutationReceipt')).toHaveLength(0);
  });

  it('does not retry a failed legacy Reddit plan before its Flair is observed', async () => {
    const { db, service } = setup();
    db.seed('post', { id: 'reddit-post', organizationId: 'org', deletedAt: null, state: 'QUEUE',
      providerIdentifier: 'reddit', sendIntentId: null, executionProtocol: null, operationPlanId: 'plan',
      projectId: 'project', parentPostId: null, releaseURL: null, settings: '{}' });
    const body = { ...begin, platform: 'reddit', postId: 'reddit-post' };
    const permit = await service.beginBrowserWrite('org', 'user', body);
    await service.settleBrowserWrite('org', 'user', permit.id, { ...owner, status: 'NOT_SUBMITTED' });
    Object.assign(db.rows('post')[0], { state: 'ERROR', settings: JSON.stringify({ subreddit: [{ value: {
      subreddit: 'test', title: 'Title', type: 'self' } }] }) });
    await expect(service.beginBrowserWrite('org', 'user', { ...body, requestId: 'retry' }))
      .rejects.toThrow('REDDIT_FLAIR_REVIEW_REQUIRED');
    expect(db.rows('sendMutationReceipt')).toHaveLength(1);
  });

  it('stages an explicitly retried failed Reddit plan post with exact NOT_SUBMITTED claim proof', async () => {
    const { db, service } = setup();
    const claimedAt = new Date('2026-10-01T10:00:00Z');
    db.seed('post', { id: 'reddit-post', group: 'reddit-post', organizationId: 'org', deletedAt: null,
      state: 'QUEUE', providerIdentifier: 'reddit', sendIntentId: null, executionProtocol: null,
      operationPlanId: 'plan', projectId: 'project', parentPostId: null, releaseURL: null,
      releaseId: 'lease', claimedAt, settings: '{}' });
    const body = { ...begin, platform: 'reddit', postId: 'reddit-post' };
    const original = await service.beginBrowserWrite('org', 'user', body);
    await service.settleBrowserWrite('org', 'user', original.id, { ...owner, status: 'NOT_SUBMITTED' });
    Object.assign(db.rows('post')[0], { state: 'ERROR', releaseId: null,
      settings: JSON.stringify({ subreddit: [{ value: { subreddit: 'test', title: 'Title', type: 'self' } }] }) });
    const originalReceipt = structuredClone(db.rows('sendMutationReceipt')[0]);
    await expect(service.beginBrowserWrite('org', 'user', { ...body, requestId: 'retry' }))
      .rejects.toThrow('REDDIT_FLAIR_PENDING');
    expect(db.rows('post')[0]).toMatchObject({ state: 'DRAFT', releaseId: null, claimedAt });
    expect(JSON.parse(db.rows('post')[0].settings).redditTargetPending.reason).toBe('flair-pending');
    await expect(service.beginBrowserWrite('org', 'user', { ...body, requestId: 'retry-again' }))
      .rejects.toThrow('REDDIT_FLAIR_PENDING');
    expect(db.rows('sendMutationReceipt')).toEqual([originalReceipt]);
  });

  it('makes a safe failed retry visible to the existing Flair resolver without another admission', async () => {
    const { db, service } = setup();
    const claimedAt = new Date('2026-10-01T10:00:00Z');
    db.seed('post', { id: 'reddit-post', group: 'reddit-post', organizationId: 'org', deletedAt: null,
      state: 'QUEUE', providerIdentifier: 'reddit', sendIntentId: null, executionProtocol: null,
      operationPlanId: 'plan', projectId: 'project', parentPostId: null, releaseURL: null,
      releaseId: 'lease', claimedAt, publishDate: new Date('2026-11-01T10:00:00Z'), content: 'Body', settings: '{}' });
    const body = { ...begin, platform: 'reddit', postId: 'reddit-post' };
    const original = await service.beginBrowserWrite('org', 'user', body);
    await service.settleBrowserWrite('org', 'user', original.id, { ...owner, status: 'NOT_SUBMITTED' });
    Object.assign(db.rows('post')[0], { state: 'ERROR', releaseId: null,
      settings: JSON.stringify({ subreddit: [{ value: { subreddit: 'test', title: 'Title', type: 'self' } }] }) });
    await expect(service.beginBrowserWrite('org', 'user', { ...body, requestId: 'retry' }))
      .rejects.toThrow('REDDIT_FLAIR_PENDING');
    const schedulePlanPosts = vi.fn();
    const resolver = new RedditTargetResolutionService({ model: db } as any, { model: db } as any,
      { getRedditChannelCapability: vi.fn(async () => ({})) } as any,
      { generateStructuredText: vi.fn(async () => ({ data: { option: 0 } })) } as any,
      { schedulePlanPosts, isControlled: vi.fn(async () => false) } as any, {} as any);
    const [pending] = await resolver.listPending('org');
    expect(pending?.postId).toBe('reddit-post');
    expect(await resolver.resolve('org', [{ postId: 'reddit-post', pendingRevision: pending.pendingRevision,
      subreddit: 'test', flairOptions: ['Discussion'], flairRequired: true }])).toMatchObject({ resolved: 1 });
    expect(JSON.stringify(db.rows('post')[0].settings)).toContain('Discussion');
    expect(schedulePlanPosts).toHaveBeenCalledTimes(1);
    expect(db.rows('sendMutationReceipt')).toHaveLength(1);
  });

  it.each(['UNKNOWN', 'CONFIRMED', 'UNBOUND', 'DIFFERENT_CLAIM', 'DIFFERENT_CONTENT'] as const)(
    'does not stage a failed Reddit retry with %s evidence', async evidence => {
      const { db, service } = setup();
      const claimedAt = new Date('2026-10-01T10:00:00Z');
      db.seed('post', { id: 'reddit-post', group: 'reddit-post', organizationId: 'org', deletedAt: null,
        state: 'QUEUE', providerIdentifier: 'reddit', sendIntentId: null, executionProtocol: null,
        operationPlanId: 'plan', projectId: 'project', parentPostId: null, releaseURL: null,
        releaseId: 'lease', claimedAt, settings: '{}' });
      const body = { ...begin, platform: 'reddit', postId: 'reddit-post' };
      const original = await service.beginBrowserWrite('org', 'user', body);
      await service.settleBrowserWrite('org', 'user', original.id, { ...owner,
        status: evidence === 'UNKNOWN' || evidence === 'CONFIRMED' ? evidence : 'NOT_SUBMITTED' });
      const record = db.rows('sendMutationReceipt')[0].result;
      if (evidence === 'UNBOUND') delete record.postClaim;
      if (evidence === 'DIFFERENT_CLAIM') record.postClaim.claimedAt = new Date(claimedAt.getTime() - 1000).toISOString();
      const settings = JSON.stringify({ subreddit: [{ value: { subreddit: 'test', title: 'Title', type: 'self' } }] });
      Object.assign(db.rows('post')[0], { state: 'ERROR', releaseId: null, settings });
      await expect(service.beginBrowserWrite('org', 'user', { ...body, requestId: 'retry',
        ...(evidence === 'DIFFERENT_CONTENT' ? { contentHash: 'b'.repeat(64) } : {}) }))
        .rejects.toThrow('REDDIT_FLAIR_REVIEW_REQUIRED');
      expect(db.rows('post')[0]).toMatchObject({ state: 'ERROR', settings, claimedAt });
      expect(db.rows('sendMutationReceipt')).toHaveLength(1);
    },
  );

  it('does not stage an autonomous Reddit retry after a controlled mode switch', async () => {
    const { db, service } = setup();
    const claimedAt = new Date('2026-10-01T10:00:00Z');
    db.seed('post', { id: 'reddit-post', group: 'reddit-post', organizationId: 'org', deletedAt: null,
      state: 'QUEUE', providerIdentifier: 'reddit', sendIntentId: null, executionProtocol: null,
      operationPlanId: 'plan', projectId: 'project', parentPostId: null, releaseURL: null,
      releaseId: 'lease', claimedAt, settings: '{}' });
    const body = { ...begin, platform: 'reddit', postId: 'reddit-post' };
    const original = await service.beginBrowserWrite('org', 'user', body);
    await service.settleBrowserWrite('org', 'user', original.id, { ...owner, status: 'NOT_SUBMITTED' });
    const settings = JSON.stringify({ subreddit: [{ value: { subreddit: 'test', title: 'Title', type: 'self' } }] });
    Object.assign(db.rows('post')[0], { state: 'ERROR', releaseId: null, settings });
    const mode = db.rows('settings').find(row => row.key === 'sending.organization_mode:org');
    if (mode) mode.value = { mode: 'CONTROLLED', revision: 3 };
    else db.seed('settings', { key: 'sending.organization_mode:org', value: { mode: 'CONTROLLED', revision: 3 } });
    await expect(service.beginBrowserWrite('org', 'user', { ...body, requestId: 'retry' }))
      .rejects.toThrow('SEND_MODE_AUTONOMOUS_REQUIRED');
    expect(db.rows('post')[0]).toMatchObject({ state: 'ERROR', settings });
    expect(db.rows('sendMutationReceipt')).toHaveLength(1);
  });

  it('refuses a cached unobserved legacy Reddit post before it reaches the claim poll', async () => {
    const { db, service } = setup();
    db.seed('post', { id: 'reddit-post', organizationId: 'org', deletedAt: null,
      state: 'QUEUE', providerIdentifier: 'reddit', sendIntentId: null, executionProtocol: null,
      operationPlanId: 'plan', projectId: 'project', parentPostId: null, releaseURL: null,
      settings: JSON.stringify({ subreddit: [{ value: { subreddit: 'test', title: 'Title', type: 'self' } }] }) });
    await expect(service.beginBrowserWrite('org', 'user', { ...begin, platform: 'reddit', postId: 'reddit-post' }))
      .rejects.toThrow('REDDIT_FLAIR_PENDING');
    expect(db.rows('sendMutationReceipt')).toHaveLength(0);
  });

  it('binds a Reddit browser admission and NOT_SUBMITTED outcome to the exact legacy claim', async () => {
    const { db, service } = setup();
    const claimedAt = new Date('2026-10-01T10:00:00Z');
    db.seed('post', { id: 'reddit-post', organizationId: 'org', deletedAt: null,
      state: 'QUEUE', providerIdentifier: 'reddit', sendIntentId: null, executionProtocol: null,
      operationPlanId: 'plan', settings: '{}', releaseId: 'lease', claimedAt });
    const permit = await service.beginBrowserWrite('org', 'user', { ...begin, platform: 'reddit', postId: 'reddit-post' });
    await service.settleBrowserWrite('org', 'user', permit.id, { ...owner, status: 'NOT_SUBMITTED' });
    expect(db.rows('sendMutationReceipt').find(row => row.id === permit.id).result).toMatchObject({
      status: 'NOT_SUBMITTED', postClaim: { releaseId: 'lease', claimedAt: claimedAt.toISOString() },
    });
    expect(db.rows('post')[0]).toMatchObject({ releaseId: 'lease', claimedAt });
  });

  it('admits another platform even if its settings contain the Reddit marker', async () => {
    const { db, service } = setup();
    db.seed('post', { id: 'other-post', organizationId: 'org', deletedAt: null,
      state: 'QUEUE', providerIdentifier: 'x', sendIntentId: null,
      executionProtocol: null, operationPlanId: 'plan',
      settings: JSON.stringify({ redditTargetPending: { title: 'Post' } }) });
    expect(await service.beginBrowserWrite('org', 'user', { ...begin, postId: 'other-post' }))
      .toMatchObject({ admitted: true, status: 'AUTHORIZED' });
  });

  it.each(['CONFIRMED', 'UNKNOWN'] as const)(
    'does not grant another Reddit write after a %s outcome and a Flair change', async (status) => {
      const { db, service } = setup();
      db.seed('post', { id: 'reddit-post', organizationId: 'org', deletedAt: null,
        state: 'QUEUE', providerIdentifier: 'reddit', sendIntentId: null,
        executionProtocol: null, operationPlanId: 'plan', settings: '{}' });
      const body = { ...begin, platform: 'reddit', postId: 'reddit-post' };
      const original = await service.beginBrowserWrite('org', 'user', body);
      await service.settleBrowserWrite('org', 'user', original.id, { ...owner, status });
      db.rows('post')[0].settings = JSON.stringify({ subreddit: [{ value: {
        subreddit: 'test', flairLabel: 'Discussion',
      } }] });
      await expect(service.beginBrowserWrite('org', 'user', { ...body, requestId: 'again' }))
        .rejects.toThrow(status === 'CONFIRMED'
          ? 'AUTONOMOUS_EFFECT_CONTENT_ALREADY_ADMITTED' : 'AUTONOMOUS_EFFECT_RECONCILIATION_REQUIRED');
      expect(db.rows('sendMutationReceipt')).toHaveLength(1);
    }
  );

  it('keeps an existing admission recoverable when a Reddit post becomes pending', async () => {
    const { db, service } = setup();
    db.seed('post', { id: 'reddit-post', organizationId: 'org', deletedAt: null,
      state: 'QUEUE', providerIdentifier: 'reddit', sendIntentId: null,
      executionProtocol: null, operationPlanId: 'plan', settings: '{}' });
    const body = { ...begin, platform: 'reddit', postId: 'reddit-post' };
    const original = await service.beginBrowserWrite('org', 'user', body);
    db.rows('post')[0].settings = JSON.stringify({ redditTargetPending: { title: 'Post' } });
    expect(await service.beginBrowserWrite('org', 'user', body)).toMatchObject({
      id: original.id, admitted: false, status: 'AUTHORIZED',
    });
    await expect(service.beginBrowserWrite('org', 'user', { ...body, requestId: 'again' }))
      .rejects.toThrow('REDDIT_FLAIR_PENDING');
  });

  it('accepts delayed browser proof after operator confirmation and protects the enriched conclusion', async () => {
    const { db, service } = setup();
    const permit = await service.beginBrowserWrite('org', 'user', begin);
    await service.resolveAutonomousEffect('org', 'user', permit.id, {
      ...owner, requestId: 'resolve', expectedRevision: 1, decision: 'CONFIRMED',
      executorStopped: true, noPendingSubmit: true, evidence: 'Worker stopped; remote post verified.',
    });
    const outcome = { ...owner, status: 'CONFIRMED' as const, platformPostId: 'remote' };
    await expect(service.settleBrowserWrite('org', 'user', permit.id, outcome))
      .resolves.toMatchObject({ status: 'CONFIRMED' });
    const receipt = db.rows('sendMutationReceipt').find(row => row.id === permit.id);
    expect(receipt.result).toMatchObject({
      status: 'CONFIRMED', hasResult: true, result: { postId: 'remote' },
      evidence: 'Worker stopped; remote post verified.', resolvedByUserId: 'user',
    });
    await expect(service.settleBrowserWrite('org', 'user', permit.id, outcome))
      .resolves.toMatchObject({ status: 'CONFIRMED' });
    await expect(service.settleBrowserWrite('org', 'user', permit.id, {
      ...outcome, platformPostId: 'different',
    })).rejects.toThrow('BROWSER_WRITE_OUTCOME_CONFLICT');
  });
  it('does not invent platform proof or reopen an operator NOT_SUBMITTED conclusion', async () => {
    const { db, service } = setup();
    const permit = await service.beginBrowserWrite('org', 'user', begin);
    await service.resolveAutonomousEffect('org', 'user', permit.id, {
      ...owner, requestId: 'resolve', expectedRevision: 1, decision: 'CONFIRMED',
      executorStopped: true, noPendingSubmit: true, evidence: 'Worker stopped; remote post verified.',
    });
    await expect(service.settleBrowserWrite('org', 'user', permit.id, {
      ...owner, status: 'CONFIRMED',
    })).resolves.toMatchObject({ status: 'CONFIRMED' });
    const receipt = db.rows('sendMutationReceipt').find(row => row.id === permit.id);
    expect(receipt.result.hasResult).not.toBe(true);
    await service.settleBrowserWrite('org', 'user', permit.id, {
      ...owner, status: 'CONFIRMED', platformPostId: 'remote',
    });
    const other = await service.beginBrowserWrite('org', 'user', { ...begin, requestId: 'not-submitted' });
    await service.resolveAutonomousEffect('org', 'user', other.id, {
      ...owner, requestId: 'resolve-not-submitted', expectedRevision: 1, decision: 'NOT_SUBMITTED',
      executorStopped: true, noPendingSubmit: true, evidence: 'Worker stopped before dispatch.',
    });
    await expect(service.settleBrowserWrite('org', 'user', other.id, {
      ...owner, status: 'CONFIRMED', platformPostId: 'unexpected',
    })).rejects.toThrow('BROWSER_WRITE_OUTCOME_CONFLICT');
  });
  it('tracks an unsaved manual write before switching and never grants a replay', async () => {
    const { service } = setup();
    const permit = await service.beginBrowserWrite('org', 'user', begin);
    expect(permit).toMatchObject({
      admitted: true,
      status: 'AUTHORIZED',
      organizationId: 'org',
      userId: 'user',
    });
    expect(await service.beginBrowserWrite('org', 'user', begin)).toMatchObject(
      { id: permit.id, admitted: false }
    );
    expect(await service.save('org', 'user', change)).toMatchObject({
      mode: 'CONTROLLED',
      legacyDrain: { remainingCount: 1 },
    });
    await service.reconcilePendingTransitions();
    expect((await service.get('org', 'user')).mode).toBe('CONTROLLED');
    await service.settleBrowserWrite('org', 'user', permit.id, {
      ...owner,
      status: 'CONFIRMED',
      platformPostId: 'remote',
      url: 'https://x.com/user/status/remote',
    });
    await service.reconcilePendingTransitions();
    expect((await service.get('org', 'user')).mode).toBe('CONTROLLED');
    expect(await service.beginBrowserWrite('org', 'user', begin)).toMatchObject(
      { admitted: false, status: 'CONFIRMED' }
    );
  });
  it('does not grant new browser leases after cutover even for captured saved content', async () => {
    const { db, service } = setup();
    db.seed('post', {
      id: 'queued',
      organizationId: 'org',
      state: 'QUEUE',
      releaseId: 'lease',
      claimedAt: new Date(),
      providerIdentifier: 'x',
      publishDate: new Date(),
    });
    db.seed('post', {
      id: 'foreign',
      organizationId: 'foreign',
      state: 'QUEUE',
      providerIdentifier: 'x',
      publishDate: new Date(),
    });
    await service.save('org', 'user', change);
    await expect(
      service.beginBrowserWrite('org', 'user', begin)
    ).rejects.toThrow('SEND_MODE_AUTONOMOUS_REQUIRED');
    await expect(
      service.beginBrowserWrite('org', 'user', { ...begin, postId: 'foreign' })
    ).rejects.toThrow('SEND_MODE_AUTONOMOUS_REQUIRED');
    await expect(
      service.beginBrowserWrite('org', 'user', {
        ...begin,
        postId: 'queued',
      })
    ).rejects.toThrow('SEND_MODE_AUTONOMOUS_REQUIRED');
  });
  it('resolves a saved engage reply through organization-scoped records and compares platform', async () => {
    const { db, service } = setup();
    db.seed('post', {
      id: 'reply-post',
      organizationId: 'org',
      state: 'DRAFT',
      source: 'engage',
    });
    db.seed('engageSentReply', {
      id: 'reply',
      organizationId: 'org',
      postId: 'reply-post',
      opportunityId: 'opportunity',
    });
    db.seed('engageOpportunity', { id: 'opportunity', platform: 'reddit' });
    await expect(
      service.beginBrowserWrite('org', 'user', {
        ...begin,
        sentReplyId: 'reply',
      })
    ).rejects.toThrow('BROWSER_WRITE_PLATFORM_CHANGED');
    const result = await service.beginBrowserWrite('org', 'user', {
      ...begin,
      platform: 'reddit',
      sentReplyId: 'reply',
    });
    expect(result.admitted).toBe(true);
    expect(db.rows('sendMutationReceipt')[0].result).toMatchObject({
      action: 'COMMENT',
      source: 'BROWSER',
      postIds: ['reply-post'],
      integrationId: 'browser:user:reddit',
    });
  });
  it('denies another unresolved admission on the same browser actor and changed idempotent payload', async () => {
    const { service } = setup();
    await service.beginBrowserWrite('org', 'user', begin);
    await expect(
      service.beginBrowserWrite('org', 'user', {
        ...begin,
        requestId: 'second',
      })
    ).rejects.toThrow('AUTONOMOUS_EFFECT_RECONCILIATION_REQUIRED');
    await expect(
      service.beginBrowserWrite('org', 'user', {
        ...begin,
        contentHash: 'b'.repeat(64),
      })
    ).rejects.toThrow('AUTONOMOUS_EFFECT_REQUEST_CONFLICT');
  });
  it('keeps unknown writes blocking until confirmed and protects owner and organization on callbacks', async () => {
    const { service } = setup();
    const permit = await service.beginBrowserWrite('org', 'user', begin);
    await expect(
      service.settleBrowserWrite('org', 'other', permit.id, {
        ...owner,
        expectedUserId: 'other',
        status: 'CONFIRMED',
      })
    ).rejects.toThrow('BROWSER_WRITE_OWNER_REQUIRED');
    await expect(
      service.settleBrowserWrite('foreign', 'user', permit.id, {
        ...owner,
        status: 'CONFIRMED',
      })
    ).rejects.toThrow();
    await service.settleBrowserWrite('org', 'user', permit.id, {
      ...owner,
      status: 'UNKNOWN',
    });
    expect(await service.save('org', 'user', change)).toMatchObject({
      legacyDrain: { status: 'NEEDS_ATTENTION' },
    });
    await service.settleBrowserWrite('org', 'user', permit.id, {
      ...owner,
      status: 'CONFIRMED',
      platformPostId: 'remote',
    });
    await service.reconcilePendingTransitions();
    expect((await service.get('org', 'user')).mode).toBe('CONTROLLED');
    await service.settleBrowserWrite('org', 'user', permit.id, {
      ...owner,
      status: 'CONFIRMED',
      platformPostId: 'remote',
    });
    await expect(
      service.settleBrowserWrite('org', 'user', permit.id, {
        ...owner,
        status: 'NOT_SUBMITTED',
      })
    ).rejects.toThrow('BROWSER_WRITE_OUTCOME_CONFLICT');
  });
  it('never grants a captured saved occurrence after its scheduled identity changes', async () => {
    const { db, service } = setup();
    db.seed('post', {
      id: 'queued',
      organizationId: 'org',
      state: 'QUEUE',
      releaseId: 'lease',
      claimedAt: new Date(),
      providerIdentifier: 'x',
      publishDate: new Date('2026-10-20'),
    });
    await service.save('org', 'user', change);
    db.rows('post')[0].publishDate = new Date('2026-10-21');
    await expect(
      service.beginBrowserWrite('org', 'user', { ...begin, postId: 'queued' })
    ).rejects.toThrow('SEND_MODE_AUTONOMOUS_REQUIRED');
    expect(await service.get('org', 'user')).toMatchObject({
      legacyDrain: {
        status: 'NEEDS_ATTENTION',
        waitReason: 'RECONCILIATION_REQUIRED',
      },
    });
  });
  it.each([false, true])(
    'serializes begin racing a zero-backlog switch (switchFirst=%s)',
    async (switchFirst) => {
      const { service } = setup();
      const writes = [
        () => service.beginBrowserWrite('org', 'user', begin),
        () => service.save('org', 'user', change),
      ];
      if (switchFirst) writes.reverse();
      await Promise.allSettled(writes.map((work) => work()));
      const state = await service.get('org', 'user');
      expect(state.mode).toBe('CONTROLLED');
      expect(state.autonomousAllowed).toBe(false);
      expect(state.blockers.autonomousEffects).toBe(switchFirst ? 0 : 1);
      expect(state.legacyDrain?.remainingCount ?? 0).toBe(switchFirst ? 0 : 1);
    }
  );
  it('binds both admissions and callbacks to the displayed owner before any receipt mutation', async () => {
    const { db, service } = setup();
    await expect(
      service.beginBrowserWrite('org', 'user', {
        ...begin,
        expectedOrganizationId: 'other',
      })
    ).rejects.toThrow('SEND_OWNER_CHANGED');
    expect(db.rows('sendMutationReceipt')).toHaveLength(0);
    const permit = await service.beginBrowserWrite('org', 'user', begin);
    await expect(
      service.settleBrowserWrite('org', 'user', permit.id, {
        ...owner,
        expectedUserId: 'other',
        status: 'CONFIRMED',
      })
    ).rejects.toThrow('SEND_OWNER_CHANGED');
    expect(db.rows('sendMutationReceipt')[0].result.status).toBe('AUTHORIZED');
  });
  it('allows safe NOT_SUBMITTED settlement once but never changes terminal conclusions', async () => {
    const { service } = setup();
    const permit = await service.beginBrowserWrite('org', 'user', begin);
    await service.settleBrowserWrite('org', 'user', permit.id, {
      ...owner,
      status: 'NOT_SUBMITTED',
    });
    await service.settleBrowserWrite('org', 'user', permit.id, {
      ...owner,
      status: 'NOT_SUBMITTED',
    });
    await expect(
      service.settleBrowserWrite('org', 'user', permit.id, {
        ...owner,
        status: 'CONFIRMED',
      })
    ).rejects.toThrow('BROWSER_WRITE_OUTCOME_CONFLICT');
    expect(await service.beginBrowserWrite('org', 'user', begin)).toMatchObject(
      { admitted: false, status: 'NOT_SUBMITTED' }
    );
  });
});

it.each([false,true])('retains UNKNOWN candidate evidence without confirming it and replaces it with later proof (operator confirms first: %s)', async resolveFirst => {
 const {db,service}=setup();
 const permit=await service.beginBrowserWrite('org','user',begin);
 const receipt=()=>db.rows('sendMutationReceipt').find(row=>row.id===permit.id);
 receipt().result.result={diagnostic:'original receipt detail'};
 const candidate={...owner,status:'UNKNOWN' as const,platformPostId:'candidate',url:'https://x.com/user/status/candidate'};
 await service.settleBrowserWrite('org','user',permit.id,candidate);
 expect(receipt().result).toMatchObject({status:'UNKNOWN',result:{diagnostic:'original receipt detail',postId:'candidate',url:candidate.url}});
 expect(receipt().result.hasResult).not.toBe(true);
 expect(receipt().result.actualIntegrationId).toBeUndefined();
 expect(await service.beginBrowserWrite('org','user',begin)).toMatchObject({admitted:false,status:'UNKNOWN'});
 await expect(service.beginBrowserWrite('org','user',{...begin,requestId:'second'})).rejects.toThrow('AUTONOMOUS_EFFECT_RECONCILIATION_REQUIRED');
 await service.settleBrowserWrite('org','user',permit.id,{...owner,status:'UNKNOWN'});
 expect(receipt().result.result.url).toBe(candidate.url);
 if(resolveFirst) {
  await service.resolveAutonomousEffect('org','user',permit.id,{...owner,requestId:'operator',expectedRevision:receipt().result.revision,decision:'CONFIRMED',executorStopped:true,noPendingSubmit:true,evidence:'Executor stopped; actual publication verified.'});
  expect(receipt().result.hasResult).not.toBe(true);
 }
 const proof={...owner,status:'CONFIRMED' as const,platformPostId:'actual',url:'https://x.com/user/status/actual'};
 await service.settleBrowserWrite('org','user',permit.id,proof);
 expect(db.rows('sendMutationReceipt').find(row=>row.id===permit.id).result).toMatchObject({status:'CONFIRMED',hasResult:true,result:{postId:'actual',url:proof.url}});
 await expect(service.settleBrowserWrite('org','user',permit.id,candidate)).rejects.toThrow('BROWSER_WRITE_OUTCOME_CONFLICT');
});
