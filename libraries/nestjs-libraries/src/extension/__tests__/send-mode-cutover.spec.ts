import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SendModeService, organizationSendModeKey } from '../send-mode.service';
import { memorySendDatabase } from './support/memory-send-database';
beforeEach(() => vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'true'));
afterEach(() => vi.unstubAllEnvs());
const owner = { expectedOrganizationId: 'org', expectedUserId: 'admin' };
const request = { ...owner, mode: 'CONTROLLED' as const, expectedRevision: 0, requestId: 'switch' };
function setup() {
  const db = memorySendDatabase();
  db.seed('userOrganization', { organizationId: 'org', userId: 'admin', role: 'ADMIN', disabled: false });
  const modes = new SendModeService(db);
  const post = (id: string, extra = {}) => db.seed('post', { id, organizationId: 'org', state: 'QUEUE',
    parentPostId: null, publishDate: new Date('2026-12-15T10:00:00Z'), ...extra });
  return { db, modes, post };
}
it('switches immediately with future queued work and preserves its content and date for reallocation', async () => {
  const { db, modes, post } = setup();
  post('future', { content: 'Keep this content' }); post('child', { parentPostId: 'future' });
  const before = structuredClone(db.rows('post'));
  expect(await modes.save('org', 'admin', request)).toMatchObject({ mode: 'CONTROLLED', transition: null,
    reallocation: { remainingCount: 2, completedCount: 0 } });
  expect(db.rows('post')).toEqual(before);
  expect(await modes.pendingReallocations()).toEqual([{ organizationId: 'org', userId: 'admin' }]);
});
it('waits only for an already claimed chain, then switches without waiting for future posts', async () => {
  const { db, modes, post } = setup();
  post('active', { releaseId: 'lease', claimedAt: new Date() });
  post('active-child', { parentPostId: 'active' }); post('future');
  expect(await modes.save('org', 'admin', request)).toMatchObject({ mode: 'AUTONOMOUS',
    transition: { remainingCount: 2, scheduledNotBefore: null, waitReason: 'IN_FLIGHT' } });
  await expect(modes.assertAutonomousIn(db, 'org', ['future'])).rejects.toThrow('SEND_MODE_TRANSITION_PENDING');
  db.rows('post').filter(p => p.id !== 'future').forEach(p => { p.state = 'PUBLISHED'; });
  expect(await modes.reconcilePendingTransitions()).toEqual([true]);
  expect(await modes.get('org', 'admin')).toMatchObject({ mode: 'CONTROLLED', transition: null,
    reallocation: { remainingCount: 1 } });
});
it('finishes an existing v1 request without waiting for its captured future schedule', async () => {
  const { db, modes, post } = setup(); post('future');
  db.seed('settings', { key: organizationSendModeKey('org'), value: { mode: 'AUTONOMOUS', revision: 1,
    transition: { version: 1, targetMode: 'CONTROLLED', requestedAt: new Date().toISOString(),
      requestedByUserId: 'admin', initialPendingCount: 1, eligiblePostIds: ['future'],
      eligiblePostOccurrences: { future: '2026-12-15T10:00:00.000Z' } } } });
  expect(await modes.reconcilePendingTransitions()).toEqual([true]);
  expect(await modes.get('org', 'admin')).toMatchObject({ mode: 'CONTROLLED', reallocation: { remainingCount: 1 } });
});
it('does not reallocate a confirmed write whose post callback has not settled', async () => {
  const { db, modes, post } = setup(); post('future', { providerIdentifier: 'x' });
  const grant = await modes.beginBrowserWrite('org', 'admin', { ...owner, requestId: 'write',
    platform: 'x', postId: 'future', contentHash: 'a'.repeat(64) });
  await modes.settleBrowserWrite('org', 'admin', grant.id, { ...owner, status: 'CONFIRMED', platformPostId: 'live' });
  expect(await modes.save('org', 'admin', request)).toMatchObject({ mode: 'AUTONOMOUS',
    transition: { remainingCount: 1, status: 'NEEDS_ATTENTION' } });
  expect(db.rows('post')[0].state).toBe('QUEUE');
});
it('retains partial published threads as reconciliation work rather than migrating them', async () => {
  const { modes, post } = setup(); post('root', { state: 'PUBLISHED' }); post('child', { parentPostId: 'root' });
  expect(await modes.save('org', 'admin', request)).toMatchObject({ mode: 'AUTONOMOUS',
    transition: { remainingCount: 1, status: 'NEEDS_ATTENTION' } });
});
it('reports per-task reallocation issues and clears the marker only after queued work is adopted', async () => {
  const { db, modes, post } = setup(); post('future'); await modes.save('org', 'admin', request);
  await modes.recordReallocationIssues('org', [{ postId: 'future', code: 'SEND_BINDING_REQUIRED' }]);
  expect(await modes.get('org', 'admin')).toMatchObject({ reallocation: { remainingCount: 1,
    blockedCount: 1, issues: [{ postId: 'future', code: 'SEND_BINDING_REQUIRED' }] } });
  db.rows('post')[0].sendIntentId = 'new-intent'; await modes.recordReallocationIssues('org', []);
  expect((await modes.get('org', 'admin')).reallocation).toBeNull();
});
it('keeps a known live permalink out of the unsent handover even without a receipt', async () => {
  const { modes, post } = setup(); post('live', { releaseURL: 'https://x.com/u/status/live' });
  expect(await modes.save('org', 'admin', request)).toMatchObject({ mode: 'AUTONOMOUS',
    transition: { remainingCount: 1, status: 'NEEDS_ATTENTION' } });
});
it('shows an unavailable reallocation owner instead of silently waiting forever', async () => {
  const { db, modes, post } = setup(); post('future'); await modes.save('org', 'admin', request);
  db.rows('userOrganization')[0].disabled = true;
  expect(await modes.stateIn(db, 'org')).toMatchObject({ reallocation: { blockedCount: 1,
    issues: [{ postId: 'future', code: 'ORGANIZATION_MEMBERSHIP_REQUIRED' }] } });
});
it('rebases v1 progress to active work instead of falsely counting future tasks as completed', async () => {
  const { db, modes, post } = setup(); post('future'); post('active', { releaseId: 'lease', claimedAt: new Date() });
  db.seed('settings', { key: organizationSendModeKey('org'), value: { mode: 'AUTONOMOUS', revision: 1,
    transition: { version: 1, targetMode: 'CONTROLLED', requestedAt: new Date().toISOString(),
      requestedByUserId: 'admin', initialPendingCount: 2, eligiblePostIds: ['future', 'active'],
      eligiblePostOccurrences: { future: '2026-12-15T10:00:00.000Z', active: '2026-12-15T10:00:00.000Z' } } } });
  expect(await modes.reconcilePendingTransitions()).toEqual([false]);
  expect(await modes.get('org', 'admin')).toMatchObject({ transition: {
    initialPendingCount: 1, remainingCount: 1, completedCount: 0,
  } });
  expect(await modes.autonomousDrainPostIdsIn(db, 'org')).toEqual(['active']);
});
it('does not turn an ordinary saved draft thread into in-flight work', async () => {
  const { db, modes, post } = setup();
  post('draft-root', { state: 'DRAFT' });
  post('draft-child', { state: 'DRAFT', parentPostId: 'draft-root' });
  const before = structuredClone(db.rows('post'));
  expect(await modes.save('org', 'admin', request)).toMatchObject({ mode: 'CONTROLLED', transition: null });
  expect(db.rows('post')).toEqual(before);
});
it('does not block cutover on a failed unsent root and its saved draft continuation', async () => {
  const { modes, post } = setup();
  post('failed-root', { state: 'ERROR' });
  post('draft-child', { state: 'DRAFT', parentPostId: 'failed-root' });
  expect(await modes.save('org', 'admin', request)).toMatchObject({ mode: 'CONTROLLED', transition: null });
});
it('keeps a truly missing parent of a draft continuation requiring reconciliation', async () => {
  const { modes, post } = setup();
  post('orphan', { state: 'DRAFT', parentPostId: 'missing' });
  expect(await modes.save('org', 'admin', request)).toMatchObject({ mode: 'AUTONOMOUS',
    transition: { remainingCount: 1, status: 'NEEDS_ATTENTION' } });
});
it('upgrades an existing v1 captured active chain to include its pre-existing draft continuation', async () => {
  const { db, modes, post } = setup();
  const requestedAt = new Date('2026-10-20T09:00:00Z');
  post('active', { releaseId: 'lease', claimedAt: new Date(), createdAt: new Date('2026-10-19') });
  post('existing-child', { state: 'DRAFT', parentPostId: 'active', createdAt: new Date('2026-10-19') });
  post('new-child', { state: 'DRAFT', parentPostId: 'existing-child', createdAt: new Date('2026-10-20T10:00:00Z') });
  db.seed('settings', { key: organizationSendModeKey('org'), value: { mode: 'AUTONOMOUS', revision: 1,
    transition: { version: 1, targetMode: 'CONTROLLED', requestedAt: requestedAt.toISOString(),
      requestedByUserId: 'admin', initialPendingCount: 1, eligiblePostIds: ['active'],
      eligiblePostOccurrences: { active: '2026-12-15T10:00:00.000Z' } } } });
  await modes.reconcilePendingTransitions();
  await expect(modes.assertAutonomousIn(db, 'org', ['existing-child'])).resolves.toBeDefined();
  await expect(modes.assertAutonomousIn(db, 'org', ['new-child'])).rejects.toThrow('SEND_MODE_TRANSITION_PENDING');
});
it.each([false, true])('preserves a captured published ancestor for its pre-existing v1 continuation (publicationDateChanged=%s)', async changed => {
  const { db, modes, post } = setup();
  const capturedDate = '2026-12-15T10:00:00.000Z';
  post('published-root', { state: 'PUBLISHED', releaseURL: 'https://x.com/u/status/root',
    publishDate: new Date(changed ? '2026-12-15T10:01:00Z' : capturedDate), createdAt: new Date('2026-10-19') });
  post('child', { state: 'DRAFT', parentPostId: 'published-root', createdAt: new Date('2026-10-19') });
  if (changed) db.seed('sendMutationReceipt', { organizationId: 'org', operation: 'autonomous-side-effect',
    result: { status: 'CONFIRMED', revision: 1, action: 'POST', integrationId: 'account',
      postIds: ['published-root'], recurring: false, occurrenceKey: 'single' } });
  db.seed('settings', { key: organizationSendModeKey('org'), value: { mode: 'AUTONOMOUS', revision: 1,
    transition: { version: 1, targetMode: 'CONTROLLED', requestedAt: '2026-10-20T09:00:00Z',
      requestedByUserId: 'admin', initialPendingCount: 1, eligiblePostIds: ['published-root'],
      eligiblePostOccurrences: { 'published-root': capturedDate } } } });
  await modes.reconcilePendingTransitions();
  await expect(modes.assertAutonomousIn(db, 'org', ['child'])).resolves.toBeDefined();
});
it('does not extend a v1 captured chain after its recurring occurrence advances', async () => {
  const { db, modes, post } = setup();
  post('advanced', { state: 'PUBLISHED', intervalInDays: 2, publishDate: new Date('2026-12-17'),
    createdAt: new Date('2026-10-19') });
  post('child', { state: 'DRAFT', parentPostId: 'advanced', createdAt: new Date('2026-10-19') });
  db.seed('settings', { key: organizationSendModeKey('org'), value: { mode: 'AUTONOMOUS', revision: 1,
    transition: { version: 1, targetMode: 'CONTROLLED', requestedAt: '2026-10-20T09:00:00Z',
      requestedByUserId: 'admin', initialPendingCount: 1, eligiblePostIds: ['advanced'],
      eligiblePostOccurrences: { advanced: '2026-12-15T00:00:00.000Z' } } } });
  await modes.reconcilePendingTransitions();
  await expect(modes.assertAutonomousIn(db, 'org', ['child'])).rejects.toThrow('SEND_MODE_TRANSITION_PENDING');
});
it.each(['missing', 'deleted', 'changed-without-proof'] as const)('never anchors a v1 continuation to a %s captured parent', async kind => {
  const { db, modes, post } = setup();
  if (kind !== 'missing') post('root', { state: 'PUBLISHED', createdAt: new Date('2026-10-19'),
    deletedAt: kind === 'deleted' ? new Date() : null,
    publishDate: new Date(kind === 'changed-without-proof' ? '2026-12-16' : '2026-12-15T10:00:00Z') });
  post('child', { state: 'DRAFT', parentPostId: 'root', createdAt: new Date('2026-10-19') });
  db.seed('settings', { key: organizationSendModeKey('org'), value: { mode: 'AUTONOMOUS', revision: 1,
    transition: { version: 1, targetMode: 'CONTROLLED', requestedAt: '2026-10-20T09:00:00Z',
      requestedByUserId: 'admin', initialPendingCount: 1, eligiblePostIds: ['root'],
      eligiblePostOccurrences: { root: '2026-12-15T10:00:00.000Z' } } } });
  await modes.reconcilePendingTransitions();
  await expect(modes.assertAutonomousIn(db, 'org', ['child'])).rejects.toThrow('SEND_MODE_TRANSITION_PENDING');
});
