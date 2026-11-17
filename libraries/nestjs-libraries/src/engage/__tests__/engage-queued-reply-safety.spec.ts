import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EngageRepository } from '../engage.repository';
import { EngageService } from '../engage.service';
import { SendModeService } from '../../extension/send-mode.service';
import { memorySendDatabase } from '../../extension/__tests__/support/memory-send-database';

const now = new Date('2026-11-13T08:00:00Z');
it('includes saved editor content on the existing opportunity read without changing flat publication fields', async () => {
  const draft = { id: 'draft', post: { state: 'DRAFT', content: 'Previously edited content' } };
  const card = { id: 'opportunity', status: 'NEW', channelAvatar: 'avatar', sentReplyId: null as string | null, replyLink: null as string | null };
  const repository = { getOpportunityById: vi.fn(async () => card),
    getOpportunityDetail: vi.fn(async () => ({ sentReply: draft })) };
  const service = Object.assign(Object.create(EngageService.prototype), { _engageRepository: repository });
  expect(await service.getOpportunityById({ id: 'org' }, 'opportunity', 'project')).toEqual({ ...card, sentReply: draft });
  expect(repository.getOpportunityById).toHaveBeenCalledWith('org', 'opportunity', 'project');
  expect(repository.getOpportunityDetail).toHaveBeenCalledWith('org', 'opportunity', 'project');
});

it.each(['QUEUED', 'RESERVED', 'RECONCILING', 'SUCCEEDED'])('returns authoritative %s permissions at both editor summary locations', async status => {
  const reply = { id: 'reply', postId: 'post', post: { id: 'post', state: status === 'SUCCEEDED' ? 'PUBLISHED' : 'QUEUE',
    content: 'Saved reply', executionProtocol: 'ACCOUNT_BOUND_V1', sendIntentId: 'intent' } };
  const sending = { rootPostId: 'post', status, allowedActions: { edit: { allowed: status === 'QUEUED' }, retry: { allowed: false } } };
  const getSendingSummary = vi.fn(async () => sending);
  const service = Object.assign(Object.create(EngageService.prototype), {
    _engageRepository: { getOpportunityById: vi.fn(async () => ({ id: 'opportunity', replyLink: 'saved-link' })),
      getOpportunityDetail: vi.fn(async () => ({ sentReply: reply })) },
    // A historical controlled reply still needs its summary after mode handover.
    _sendModes: { isControlled: vi.fn(async () => false) },
    _postsService: { getSendingSummary },
  });
  const result = await service.getOpportunityById({ id: 'org' }, 'opportunity', 'project', 'user');
  expect(result.replyLink).toBe('saved-link');
  expect(result.sentReply.sending).toEqual(sending);
  expect(result.sentReply.post.sending).toEqual(sending);
  expect(getSendingSummary).toHaveBeenCalledExactlyOnceWith('org', 'user', 'post');
  expect(reply).not.toHaveProperty('sending');
});

it('keeps autonomous legacy draft reads unchanged without calling controlled summary APIs', async () => {
  const draft = { id: 'draft', postId: 'post', post: { id: 'post', state: 'DRAFT', content: 'Human draft', executionProtocol: 'LEGACY' } };
  const getSendingSummary = vi.fn();
  const service = Object.assign(Object.create(EngageService.prototype), {
    _engageRepository: { getOpportunityById: vi.fn(async () => ({ id: 'opportunity' })),
      getOpportunityDetail: vi.fn(async () => ({ sentReply: draft })) },
    _sendModes: { isControlled: vi.fn(async () => false) }, _postsService: { getSendingSummary },
  });
  expect((await service.getOpportunityById({ id: 'org' }, 'opportunity', 'project', 'user')).sentReply).toEqual(draft);
  expect(getSendingSummary).not.toHaveBeenCalled();
});

it('does not turn a failed permission lookup into an editable draft response', async () => {
  const service = Object.assign(Object.create(EngageService.prototype), {
    _engageRepository: { getOpportunityById: vi.fn(async () => ({ id: 'opportunity' })),
      getOpportunityDetail: vi.fn(async () => ({ sentReply: { id: 'reply', postId: 'post', post: { id: 'post', sendIntentId: 'intent' } } })) },
    _sendModes: { isControlled: vi.fn(async () => true) },
    _postsService: { getSendingSummary: vi.fn(async () => { throw new Error('SEND_OWNER_CHANGED'); }) },
  });
  await expect(service.getOpportunityById({ id: 'org' }, 'opportunity', 'project', 'user')).rejects.toThrow('SEND_OWNER_CHANGED');
});
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'true'); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
function fixture() {
  const db = memorySendDatabase();
  db.seed('settings', { key: 'sending.organization_mode:org', value: { mode: 'AUTONOMOUS', revision: 1 } });
  db.seed('userOrganization', { organizationId: 'org', userId: 'user', disabled: false });
  db.seed('post', { id: 'post', organizationId: 'org', projectId: 'project', source: 'engage', providerIdentifier: 'x',
    state: 'QUEUE', content: 'original', publishDate: now, publishMethod: null, executionProtocol: 'LEGACY',
    releaseId: null, releaseURL: null, claimedAt: null, parentPostId: null, intervalInDays: null });
  db.seed('engageOpportunity', { id: 'opportunity', platform: 'x', externalPostUrl: 'https://x.com/a/status/123', repliesDisabledAt: null });
  db.seed('engageSentReply', { id: 'reply', organizationId: 'org', projectId: 'project', postId: 'post', opportunityId: 'opportunity', inputData: { strategy: 'old' } });
  const reply = db.rows('engageSentReply')[0]; reply.post = db.rows('post')[0]; reply.opportunity = db.rows('engageOpportunity')[0];
  const modes = new SendModeService(db as any);
  const store = { model: db } as any;
  const repo = new EngageRepository(store, store, store, store, store, store, store, store, store, store, store, store, store, modes);
  const claim = () => repo.claimDueEngageReplies('org', 'project', 'x', { limit: 5, leaseToken: 'claim_current', leaseCutoff: new Date(+now - 1800000), now });
  return { db, repo, modes, claim, post: db.rows('post')[0] };
}

it.each(['claim', 'authorized', 'unknown', 'confirmed', 'deleted', 'quarantined', 'captured'])(
  'refuses queued legacy reply edits with protected %s evidence', async kind => {
    const f = fixture();
    if (kind === 'claim') Object.assign(f.post, { releaseId: 'claim_old', claimedAt: now });
    if (['authorized', 'unknown', 'confirmed'].includes(kind)) {
      const grant = await f.modes.beginBrowserWrite('org', 'user', { expectedOrganizationId: 'org', expectedUserId: 'user', requestId: 'old', platform: 'x', sentReplyId: 'reply', contentHash: 'a'.repeat(64) });
      if (kind !== 'authorized') await f.modes.settleBrowserWrite('org', 'user', grant.id, { expectedOrganizationId: 'org', expectedUserId: 'user', status: kind.toUpperCase() } as any);
    }
    if (kind === 'deleted') f.post.deletedAt = now;
    if (kind === 'quarantined') f.post.executionProtocol = 'LEGACY_QUARANTINED';
    if (kind === 'captured') f.db.rows('settings')[0].value = { mode: 'CONTROLLED', revision: 2, legacyDrain: { version: 2, targetMode: 'CONTROLLED', requestedAt: now.toISOString(), requestedByUserId: 'user', eligiblePostIds: ['post'], eligiblePostOccurrences: { post: now.toISOString() }, effectReceiptIds: [] } };
    await expect(f.repo.updateScheduledReply('org', 'reply', { content: 'edited', inputData: { strategy: 'new' } })).rejects.toThrow();
    expect(f.db.rows('post')[0].content).toBe('original');
    expect(f.db.rows('engageSentReply')[0].inputData).toEqual({ strategy: 'old' });
  }
);
it('keeps full safe unclaimed legacy reply editing available', async () => {
  const f = fixture();
  await f.repo.updateScheduledReply('org', 'reply', { content: 'edited', inputData: { strategy: 'new' } });
  expect(f.db.rows('post')[0]).toMatchObject({ content: 'edited', contentRevision: 2 });
  expect(f.db.rows('engageSentReply')[0].inputData).toEqual({ strategy: 'new' });
});
it.each(['future', 'api'])('does not browser-claim a %s queued reply', async kind => {
  const f = fixture();
  if (kind === 'future') f.post.publishDate = new Date(+now + 86400000);
  else f.post.publishMethod = 'API';
  expect(await f.claim()).toEqual([]);
  expect(f.post.releaseId).toBeNull();
});
it.each([null, 'EXTENSION'])('continues claiming due legacy automatic replies with method %s', async method => {
  const f = fixture(); f.post.publishMethod = method;
  expect(await f.claim()).toMatchObject([{ id: 'reply', content: 'original' }]);
});
it.each(['future', 'api'])('rechecks %s eligibility when the queued reply changes during discovery', async kind => {
  const f = fixture();
  const store = f.db.engageSentReply; f.db.engageSentReply = store;
  const find = store.findMany.bind(store);
  vi.spyOn(store, 'findMany').mockImplementationOnce(async (query: any) => {
    const result = await find(query);
    if (kind === 'future') f.post.publishDate = new Date(+now + 86400000);
    else f.post.publishMethod = 'API';
    return result;
  });
  expect(await f.claim()).toEqual([]);
  expect(f.post.releaseId).toBeNull();
});

it('keeps null immediate scheduling unavailable to unversioned legacy Reply edits', async () => {
  const f = fixture();
  const svc = Object.assign(Object.create(EngageService.prototype), { _engageRepository: f.repo });
  const before = structuredClone(f.post);
  await expect(svc.updateScheduledReply({ id: 'org' }, 'reply', { scheduledAt: null }, 'user')).rejects.toThrow('scheduledAt must be a future date');
  expect(f.db.rows('post')[0]).toEqual(before);
});
it('serializes legacy content editing behind an already admitted browser write', async () => {
  const f = fixture();
  const grant = f.modes.beginBrowserWrite('org', 'user', { expectedOrganizationId: 'org', expectedUserId: 'user', requestId: 'racing-write', platform: 'x', sentReplyId: 'reply', contentHash: 'a'.repeat(64) });
  const edit = f.repo.updateScheduledReply('org', 'reply', { content: 'racing edit' });
  expect((await Promise.allSettled([grant, edit])).map(result => result.status)).toEqual(['fulfilled', 'rejected']);
  expect(f.db.rows('post')[0].content).toBe('original');
});

it('does not partially reschedule a protected legacy Reply when a combined edit is rejected', async () => {
  const f = fixture(); const before = new Date(+now + 3600000); f.post.publishDate = before;
  await f.modes.beginBrowserWrite('org', 'user', { expectedOrganizationId: 'org', expectedUserId: 'user', requestId: 'owned', platform: 'x', sentReplyId: 'reply', contentHash: 'a'.repeat(64) });
  const changeDate = vi.fn(async (_org: string, _id: string, date: string) => { f.post.publishDate = new Date(date); });
  const svc = Object.assign(Object.create(EngageService.prototype), { _engageRepository: f.repo, _postsService: { changeDate } });
  await expect(svc.updateScheduledReply({ id: 'org' }, 'reply', { scheduledAt: new Date(+before + 3600000).toISOString(), content: 'edited' }, 'user')).rejects.toThrow();
  expect(f.db.rows('post')[0]).toMatchObject({ content: 'original', publishDate: before });
  expect(changeDate).not.toHaveBeenCalled();
});
it.each(['API', 'EXTENSION', null])('atomically edits a safe legacy Reply schedule while preserving method %s workflow routing', async method => {
  const f = fixture(); Object.assign(f.post, { publishMethod: method, integrationId: 'account', publishDate: new Date(+now + 3600000) });
  const startWorkflow = vi.fn();
  const svc = Object.assign(Object.create(EngageService.prototype), { _engageRepository: f.repo, _postsService: { startWorkflow } });
  const next = new Date(+now + 7200000);
  await svc.updateScheduledReply({ id: 'org' }, 'reply', { scheduledAt: next.toISOString(), content: 'edited' }, 'user');
  expect(f.db.rows('post')[0]).toMatchObject({ content: 'edited', publishDate: next });
  expect(startWorkflow).toHaveBeenCalledTimes(method === 'EXTENSION' ? 0 : 1);
});
it('retains the legacy original-schedule lockout without partially editing content', async () => {
  const f = fixture(); f.post.publishDate = new Date(+now + 10000);
  await expect(f.repo.updateScheduledReply('org', 'reply', { content: 'edited', publishDate: new Date(+now + 3600000), rescheduleLockoutMs: 30000 } as any)).rejects.toThrow();
  expect(f.db.rows('post')[0].content).toBe('original');
});

it('restarts a legacy API Reply with the bound integration provider when the old Post has no provider column', async () => {
  const f = fixture(); vi.stubEnv('TEMPORAL_WORKER_MODE', 'per-provider');
  f.db.seed('integration', { id: 'account', organizationId: 'org', providerIdentifier: 'x' });
  Object.assign(f.post, { providerIdentifier: null, publishMethod: 'API', integrationId: 'account', integration: { providerIdentifier: 'x' }, publishDate: new Date(+now + 3600000) });
  const startWorkflow = vi.fn();
  const svc = Object.assign(Object.create(EngageService.prototype), { _engageRepository: f.repo, _postsService: { startWorkflow } });
  await svc.updateScheduledReply({ id: 'org' }, 'reply', { scheduledAt: new Date(+now + 7200000).toISOString() }, 'user');
  expect(startWorkflow).toHaveBeenCalledWith('x', 'post', 'org');
});
