import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SendModeService } from '../send-mode.service';
import { PostsRepository } from '../../database/prisma/posts/posts.repository';
import {
  EngageRepository,
  REPLIES_DISABLED_ERROR_PREFIX,
} from '../../engage/engage.repository';
import { memorySendDatabase } from './support/memory-send-database';
vi.mock('../../redis/redis.service', () => ({ ioRedis: {} }));
beforeEach(() => {
  vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'true');
});
afterEach(() => {
  vi.unstubAllEnvs();
});
function setup() {
  const db = memorySendDatabase();
  db.seed('userOrganization', {
    organizationId: 'org',
    userId: 'admin',
    role: 'ADMIN',
    disabled: false,
  });
  const modes = new SendModeService(db);
  const posts = new PostsRepository(
    { model: db } as any,
    {} as any,
    {} as any,
    {} as any,
    { model: db } as any,
    {} as any,
    { model: db } as any,
    modes
  );
  const engage = Object.assign(Object.create(EngageRepository.prototype), {
    _tx: { model: db },
    _sendModes: modes,
    _sentReply: { model: db },
  });
  const post = (id: string, extra = {}) =>
    db.seed('post', {
      id,
      organizationId: 'org',
      state: 'QUEUE',
      executionProtocol: null,
      group: 'g',
      publishDate: new Date('2026-10-20'),
      ...extra,
    });
  const save = () =>
    modes.save('org', 'admin', {
      mode: 'CONTROLLED',
      expectedRevision: 0,
      requestId: 'request',
      expectedOrganizationId: 'org',
      expectedUserId: 'admin',
    });
  return { db, modes, posts, engage, post, save };
}
it('admin restore preserves the producer fence while repairing shared opportunities', async () => {
  const { db, modes, engage, post, save } = setup();
  post('captured', { releaseId: 'lease', claimedAt: new Date() });
  post('errored', {
    state: 'ERROR',
    releaseURL: null,
    error: REPLIES_DISABLED_ERROR_PREFIX + 'closed',
  });
  db.seed('engageOpportunity', { id: 'opp', repliesDisabledAt: new Date() });
  db.seed('engageSentReply', {
    id: 'reply',
    organizationId: 'org',
    opportunityId: 'opp',
    postId: 'errored',
  });
  await save();
  expect(await engage.restoreOpportunityRepliesForAdmin(['opp'])).toMatchObject(
    { restored: 1, repliesReopened: 0 }
  );
  db.rows('post').find((p: any) => p.id === 'captured').state = 'PUBLISHED';
  await modes.reconcilePendingTransitions();
  expect(await modes.get('org', 'admin')).toMatchObject({
    mode: 'CONTROLLED',
    transition: null,
  });
  expect(db.rows('post').find((p: any) => p.id === 'errored').state).toBe(
    'ERROR'
  );
  expect(db.rows('engageOpportunity')[0].repliesDisabledAt).toBeNull();
});
it('same-group draft cleanup preserves captured live claims', async () => {
  const { db, modes, posts, post, save } = setup();
  post('captured', { releaseId: 'lease', claimedAt: new Date() });
  await save();
  const { posts: created } = await posts.createOrUpdatePost(
    'draft',
    'org',
    '2026-10-20',
    {
      group: 'g',
      value: [{ id: 'new-draft', content: 'saved', image: [] }],
      settings: { __type: 'x' },
    } as any,
    []
  );
  // Exact following call made by PostsService.createPost when supplied IDs + group exist.
  await posts.softDeleteGroupPosts('g', {
    organizationId: 'org',
    excludeIds: created.map((p: any) => p.id),
  });
  expect(db.rows('post').find((p: any) => p.id === 'captured')).toMatchObject({
    releaseId: 'lease',
    deletedAt: null,
  });
  await modes.reconcilePendingTransitions();
  expect(await modes.get('org', 'admin')).toMatchObject({
    mode: 'CONTROLLED',
    legacyDrain: { remainingCount: 1 },
  });
});

it.each(['group', 'id'] as const)(
  'explicit %s deletion cannot hide a captured claim',
  async (kind) => {
    const { db, posts, post, save } = setup();
    post('captured', { releaseId: 'lease', claimedAt: new Date() });
    await save();
    await expect(
      kind === 'group'
        ? posts.deletePost('org', 'g')
        : posts.deletePostById('org', 'captured')
    ).rejects.toThrow('SEND_MODE_TRANSITION_PENDING');
    expect(db.rows('post')[0].deletedAt).toBeNull();
  }
);
it('explicit deletion can cancel unclaimed queued work during transition', async () => {
  const { db, modes, posts, post, save } = setup();
  post('captured');
  post('active', { group: 'active-group', releaseId: 'lease', claimedAt: new Date() });
  expect(await save()).toMatchObject({ mode: 'CONTROLLED', legacyDrain: { remainingCount: 1 } });
  await posts.deletePostById('org', 'captured');
  expect(db.rows('post')[0].deletedAt).toBeInstanceOf(Date);
  db.rows('post').find((row: any) => row.id === 'active').state = 'PUBLISHED';
  await modes.reconcilePendingTransitions();
  expect(await modes.get('org', 'admin')).toMatchObject({
    mode: 'CONTROLLED',
    transition: null,
  });
});
it('admin restore does not requeue into a controlled organization', async () => {
  const { db, modes, engage, post, save } = setup();
  post('errored', {
    state: 'ERROR',
    releaseURL: null,
    error: REPLIES_DISABLED_ERROR_PREFIX + 'closed',
  });
  db.seed('engageOpportunity', { id: 'opp', repliesDisabledAt: new Date() });
  db.seed('engageSentReply', {
    id: 'reply',
    organizationId: 'org',
    opportunityId: 'opp',
    postId: 'errored',
  });
  expect(await save()).toMatchObject({ mode: 'CONTROLLED' });
  expect(await engage.restoreOpportunityRepliesForAdmin(['opp'])).toMatchObject(
    { restored: 1, repliesReopened: 0 }
  );
  expect(db.rows('post')[0].state).toBe('ERROR');
});
it('admin restore still requeues into an autonomous organization', async () => {
  const { db, engage, post } = setup();
  post('errored', {
    state: 'ERROR',
    releaseURL: null,
    error: REPLIES_DISABLED_ERROR_PREFIX + 'closed',
  });
  db.seed('engageOpportunity', { id: 'opp', repliesDisabledAt: new Date() });
  db.seed('engageSentReply', {
    id: 'reply',
    organizationId: 'org',
    opportunityId: 'opp',
    postId: 'errored',
  });
  expect(await engage.restoreOpportunityRepliesForAdmin(['opp'])).toMatchObject(
    { restored: 1, repliesReopened: 1 }
  );
  expect(db.rows('post')[0].state).toBe('QUEUE');
});

it('admin restore leaves account-bound terminal replies unchanged in autonomous mode', async () => {
  const { db, engage, post } = setup();
  post('errored', {
    state: 'ERROR',
    executionProtocol: 'ACCOUNT_BOUND_V1',
    sendIntentId: 'completed-intent',
    releaseURL: null,
    error: REPLIES_DISABLED_ERROR_PREFIX + 'closed',
  });
  db.seed('engageOpportunity', { id: 'opp', repliesDisabledAt: new Date() });
  db.seed('engageSentReply', {
    id: 'reply',
    organizationId: 'org',
    opportunityId: 'opp',
    postId: 'errored',
  });
  expect(await engage.restoreOpportunityRepliesForAdmin(['opp'])).toMatchObject(
    { restored: 1, repliesReopened: 0 }
  );
  expect(db.rows('post')[0].state).toBe('ERROR');
});
it('draft cleanup remains scoped to the authenticated organization', async () => {
  const { db, posts, post, save } = setup();
  post('captured', { releaseId: 'lease', claimedAt: new Date() });
  post('draft', { state: 'DRAFT' });
  db.seed('post', {
    id: 'foreign',
    organizationId: 'other',
    state: 'DRAFT',
    group: 'g',
  });
  await save();
  await posts.softDeleteGroupPosts('g', { organizationId: 'org' });
  expect(
    db.rows('post').find((p: any) => p.id === 'draft').deletedAt
  ).toBeInstanceOf(Date);
  expect(
    db.rows('post').find((p: any) => p.id === 'captured').deletedAt
  ).toBeNull();
  expect(
    db.rows('post').find((p: any) => p.id === 'foreign').deletedAt
  ).toBeNull();
});

it('reports overdue captured browser claims as needing reconciliation without clearing them', async () => {
  const { db, modes, post, save } = setup();
  post('captured', {
    releaseId: 'lease',
    claimedAt: new Date(Date.now() - 31 * 60_000),
  });
  expect(await save()).toMatchObject({
    legacyDrain: {
      status: 'NEEDS_ATTENTION',
      waitReason: 'RECONCILIATION_REQUIRED',
      remainingCount: 1,
    },
  });
  await modes.reconcilePendingTransitions();
  expect(await modes.get('org', 'admin')).toMatchObject({
    mode: 'CONTROLLED',
    legacyDrain: { remainingCount: 1 },
  });
  expect(db.rows('post')[0]).toMatchObject({
    state: 'QUEUE',
    releaseId: 'lease',
  });
});
it('keeps a captured claim inside the longer configured lease window in flight', async () => {
  const { db, post, save } = setup();
  vi.stubEnv('EXTENSION_PUBLISH_LEASE_MINUTES', '120');
  db.seed('settings', {
    key: 'engage_reply_pacing',
    value: { claimLeaseMinutes: 60 },
  });
  post('captured', {
    releaseId: 'lease',
    claimedAt: new Date(Date.now() - 90 * 60_000),
  });
  expect(await save()).toMatchObject({
    legacyDrain: {
      status: 'DRAINING',
      waitReason: 'IN_FLIGHT',
      remainingCount: 1,
    },
  });
});

it.each([
  { source: 'native', minutes: 11, status: 'NEEDS_ATTENTION' },
  { source: 'engage', minutes: 29, status: 'DRAINING' },
  { source: 'engage', minutes: 31, status: 'NEEDS_ATTENTION' },
])(
  'uses the correct claim window for $source at $minutes minutes',
  async ({ source, minutes, status }) => {
    const { post, save } = setup();
    post('captured', {
      source,
      releaseId: 'lease',
      claimedAt: new Date(Date.now() - minutes * 60_000),
    });
    expect(await save()).toMatchObject({
      legacyDrain: { status, remainingCount: 1 },
    });
  }
);
it('respects the configured reply lease before requiring reconciliation', async () => {
  const { db, post, save } = setup();
  db.seed('settings', {
    key: 'engage_reply_pacing',
    value: { claimLeaseMinutes: 60 },
  });
  post('captured', {
    source: 'engage',
    releaseId: 'lease',
    claimedAt: new Date(Date.now() - 45 * 60_000),
  });
  expect(await save()).toMatchObject({
    legacyDrain: { status: 'DRAINING', waitReason: 'IN_FLIGHT' },
  });
});
it('preserves old claim ownership during automatic workflow recovery after immediate cutover', async () => {
  const { db, modes, posts, post, save } = setup();
  post('captured', { releaseId: 'lease', claimedAt: new Date(), providerIdentifier: 'x', publishMethod: 'EXTENSION' });
  await save();
  await posts.resetClaimForPost('captured');
  expect(db.rows('post')[0].releaseId).toBe('lease');
  expect(await modes.get('org', 'admin')).toMatchObject({ mode: 'CONTROLLED', legacyDrain: { remainingCount: 1 } });
});
it('keeps durable settlement protection after an unconfirmed callback clears volatile lease fields', async () => {
  const { db, modes, engage, post, save } = setup();
  Object.assign(engage, { _post: { model: db } });
  db.seed('integration', { id: 'account', organizationId: 'org', providerIdentifier: 'x', internalId: '123', identityNamespace: 'x.rest_id' });
  post('captured', { releaseId: 'lease', claimedAt: new Date(), providerIdentifier: 'x', publishMethod: 'EXTENSION' });
  db.seed('engageSentReply', { id: 'reply', organizationId: 'org', postId: 'captured' });
  await save();
  await engage.closeUnconfirmedReply('org', 'reply', 'Lost platform confirmation');
  expect(db.rows('post')[0].state).toBe('ERROR');
  expect(await modes.get('org', 'admin')).toMatchObject({ mode: 'CONTROLLED', legacyDrain: { remainingCount: 1 } });
  expect(await modes.legacyAccountBlockedIn(db, 'org', 'account')).toBe(true);
  db.rows('post')[0].state = 'PUBLISHED';
  await modes.reconcilePendingTransitions();
  expect((await modes.get('org', 'admin')).legacyDrain).toBeNull();
});
it('does not delete an expired but captured reply while cleaning obsolete working drafts', async () => {
  const { db, engage, post, save } = setup();
  Object.assign(engage, { _post: { model: db } });
  post('captured', { releaseId: 'lease', claimedAt: new Date('2026-01-01'), releaseURL: null });
  db.seed('engageSentReply', { id: 'reply', organizationId: 'org', projectId: null, opportunityId: 'opportunity', postId: 'captured', post: structuredClone(db.rows('post')[0]) });
  await save();
  await (engage as any)._deleteDraftsForOpportunity('org', 'opportunity');
  expect(db.rows('post').find(row => row.id === 'captured')).toBeDefined();
});
it('keeps captured unclaimed thread children out of draft cleanup as well as the claimed root', async () => {
  const { db, posts, post, save } = setup();
  post('captured', { releaseId: 'lease', claimedAt: new Date() });
  post('child', { state: 'DRAFT', parentPostId: 'captured', releaseId: null });
  await save();
  await posts.softDeleteGroupPosts('g', { organizationId: 'org' });
  expect(db.rows('post').find(row => row.id === 'child')).toMatchObject({ deletedAt: null, parentPostId: 'captured' });
});
it('does not let the stale API queue sweep clear an outstanding claim', async () => {
  const { db, posts, post, save } = setup();
  post('captured', { releaseId: 'lease', claimedAt: new Date(), parentPostId: null, intervalInDays: null,
    publishDate: new Date('2026-01-01'), publishMethod: 'API', providerIdentifier: 'mastodon', source: 'calendar' });
  await save();
  await posts.markStaleQueuePostsAsError([]);
  expect(db.rows('post')[0]).toMatchObject({ state: 'QUEUE', releaseId: 'lease' });
});
it('captures an admitted saved draft even when it never acquired a queue lease', async () => {
  const { db, modes, post, save } = setup();
  post('captured', { state: 'DRAFT', releaseId: null, providerIdentifier: 'x', source: 'engage' });
  await modes.beginBrowserWrite('org', 'admin', { expectedOrganizationId: 'org', expectedUserId: 'admin',
    requestId: 'write', platform: 'x', postId: 'captured', contentHash: 'a'.repeat(64) });
  await save();
  expect(await modes.activeLegacyPostIdsIn(db, 'org')).toEqual(['captured']);
});
it('refuses controlled editing of a saved draft whose original browser write is still admitted', async () => {
  const { db, modes, posts, post, save } = setup();
  post('captured', { state: 'DRAFT', releaseId: null, providerIdentifier: 'x', source: 'engage', content: 'original' });
  await modes.beginBrowserWrite('org', 'admin', { expectedOrganizationId: 'org', expectedUserId: 'admin',
    requestId: 'write', platform: 'x', postId: 'captured', contentHash: 'a'.repeat(64) });
  await save();
  await expect(posts.createOrUpdatePost('draft', 'org', '2026-10-20', {
    group: 'g', value: [{ id: 'captured', content: 'replacement', image: [] }], settings: { __type: 'x' },
  } as any, [], undefined, undefined, undefined, undefined, undefined, 'CONTROLLED'))
    .rejects.toThrow('SEND_MODE_TRANSITION_PENDING');
  expect(db.rows('post')[0].content).toBe('original');
});
it('protects an admitted saved reply from the independent engage draft editor after cutover', async () => {
  const { db, modes, engage, post, save } = setup();
  post('captured', { state: 'DRAFT', providerIdentifier: 'x', source: 'engage', content: 'original', settings: '{}' });
  db.seed('engageSentReply', { id: 'reply', organizationId: 'org', projectId: null,
    opportunityId: 'opportunity', postId: 'captured', post: structuredClone(db.rows('post')[0]) });
  await modes.beginBrowserWrite('org', 'admin', { expectedOrganizationId: 'org', expectedUserId: 'admin',
    requestId: 'write', platform: 'x', postId: 'captured', contentHash: 'a'.repeat(64) });
  await save();
  await expect(engage.upsertDraft('org', 'opportunity', { platform: 'x', content: 'replacement', inputData: {} }))
    .rejects.toThrow('SEND_MODE_TRANSITION_PENDING');
  expect(db.rows('post')[0].content).toBe('original');
});
it('rejects direct engage cancellation of a captured send after immediate cutover', async () => {
  const { db, engage, post, save } = setup();
  Object.assign(engage, { _post: { model: { post: { delete: ({ where }: any) => db.post.deleteMany({ where }) } } } });
  post('captured', { releaseId: 'lease', claimedAt: new Date() });
  await save();
  await expect(engage.deletePostById('captured')).rejects.toThrow('SEND_MODE_TRANSITION_PENDING');
  expect(db.rows('post').find(row => row.id === 'captured')).toBeDefined();
});
it('still permits direct engage cancellation of untouched work after cutover', async () => {
  const { db, engage, post, save } = setup();
  Object.assign(engage, { _post: { model: { post: { delete: ({ where }: any) => db.post.deleteMany({ where }) } } } });
  post('untouched');
  await save();
  await engage.deletePostById('untouched');
  expect(db.rows('post')).toHaveLength(0);
});
it('does not let engage failure cleanup delete content owned by a controlled intent', async () => {
  const { db, engage, post, save } = setup();
  post('controlled', { state: 'DRAFT', executionProtocol: 'ACCOUNT_BOUND_V1', sendIntentId: 'intent' });
  await save();
  await expect(engage.deletePostById('controlled')).rejects.toThrow('SEND_INTENT_IMMUTABLE');
  expect(db.rows('post').find(row => row.id === 'controlled')).toBeDefined();
});
