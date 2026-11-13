import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupSend, sendNow as now } from './support/send-fixture';
import { sendHash } from '../send-coordination.utils';
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'true');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
describe('durable request identity and privileged reconciliation', () => {
  it('reuses a persisted create identity and rejects a different body with the same request', async () => {
    const { service, db } = setupSend();
    const id = await service.prepareCreation(
      'org',
      'user',
      'request',
      'item',
      sendHash('body')
    );
    expect(
      await service.prepareCreation(
        'org',
        'user',
        'request',
        'item',
        sendHash('body')
      )
    ).toBe(id);
    await expect(
      service.prepareCreation(
        'org',
        'user',
        'request',
        'item',
        sendHash('different')
      )
    ).rejects.toThrow('SEND_CREATE_REQUEST_CONFLICT');
    expect(db.rows('sendMutationReceipt')).toHaveLength(1);
    expect(
      await service.prepareCreation(
        'org',
        'user',
        'other',
        'item',
        sendHash('body'),
        'existing-root'
      )
    ).toBe('existing-root');
  });
  it('requires database-backed administrator permission and matching organization membership', async () => {
    const { service, create, db } = setupSend();
    await create();
    const e = await service.reserveApi('org', 'root', 'workflow', now);
    await expect(
      service.reconciliationView('org', 'user', e.id)
    ).rejects.toThrow('SEND_RECONCILIATION_PERMISSION_REQUIRED');
    db.seed('user', { id: 'admin', isSuperAdmin: true });
    await expect(
      service.reconciliationView('org', 'admin', e.id)
    ).rejects.toThrow('SEND_RECONCILIATION_PERMISSION_REQUIRED');
  });
  it('requires evidence and resolution revision, settles a late confirmation, and replays only the receipt', async () => {
    const { service, create, db } = setupSend();
    await create();
    db.seed('user', { id: 'admin', isSuperAdmin: true });
    db.seed('userOrganization', {
      userId: 'admin',
      organizationId: 'org',
      disabled: false,
    });
    const e = await service.reserveApi('org', 'root', 'workflow', now);
    await service.authorizeApiSegment(
      'org',
      e.id,
      0,
      { id: '123', idNamespace: 'x.rest_id' },
      now
    );
    await service.apiOutcome(
      'org',
      e.id,
      0,
      { status: 'unknown', eventId: 'lost' },
      now
    );
    const result = {
      status: 'confirmed' as const,
      eventId: 'verified',
      platformId: 'tweet',
      evidence:
        'Verified platform record, actor, and target match the original execution.',
    };
    await expect(
      service.reconcile('org', 'admin', e.id, 0, 1, result)
    ).rejects.toThrow('SEND_RESOLUTION_REVISION_CONFLICT');
    await expect(
      service.reconcile('org', 'admin', e.id, 0, 0, { ...result, evidence: '' })
    ).rejects.toThrow('SEND_RECONCILIATION_EVIDENCE_REQUIRED');
    await service.reconcile('org', 'admin', e.id, 0, 0, result);
    await service.reconcile('org', 'admin', e.id, 0, 0, result);
    const view = await service.reconciliationView('org', 'admin', e.id);
    expect(view).toMatchObject({ status: 'SUCCEEDED', resolutionRevision: 1 });
    expect(view).not.toHaveProperty('leaseTokenHash');
    expect(db.rows('sendQuotaBucket')[0]).toMatchObject({
      heldUnits: 0,
      confirmedUnits: 1,
    });
  });
  it('rechecks the policy owner membership before granting any send quota', async () => {
    const { service, create, db } = setupSend();
    await create();
    const e = await service.reserveApi('org', 'root', 'workflow', now);
    db.rows('userOrganization')[0].disabled = true;
    await expect(
      service.authorizeApiSegment(
        'org',
        e.id,
        0,
        { id: '123', idNamespace: 'x.rest_id' },
        now
      )
    ).rejects.toThrow('SEND_POLICY_OWNER_UNAVAILABLE');
    expect(db.rows('sendQuotaReservation')).toHaveLength(0);
  });
});


async function acceptedDraftEnqueue(group?: string, rootIdSupplied = true) {
  const f = setupSend();
  const { PostsService } = await import('../../database/prisma/posts/posts.service');
  const body: any = {
    requestId: 'first-draft-enqueue', projectId: 'project', type: 'now',
    date: now.toISOString(), inter: 0, tags: [], shortLink: false,
    posts: [{ itemKey: 'primary', integration: { id: 'account' },
      providerIdentifier: 'x', publishMethod: 'extension', settings: { __type: 'x' },
      value: [{ id: 'root', content: 'Original saved draft', image: [] }] }],
  };
  const post = body.posts[0];
  if (group) post.group = group;
  if (!rootIdSupplied) { delete post.value[0].id; post.value.push({id: 'original-child', content: 'Second segment', image: []}); }
  await f.service.prepareCreation('org', 'user', body.requestId, post.itemKey,
    sendHash({ post, type: body.type, date: body.date, projectId: body.projectId,
      source: body.source, inter: body.inter, tags: body.tags, shortLink: body.shortLink }), 'root');
  await f.create('root', 'EXTENSION');
  const repository = {
    getPostById: vi.fn(async (id: string, organizationId?: string) =>
      f.db.post.findFirst({ where: { id, ...(organizationId ? { organizationId } : {}) } })),
    createOrUpdatePost: vi.fn(), softDeleteGroupPosts: vi.fn(),
  };
  const posts: any = Object.create(PostsService.prototype);
  Object.assign(posts, { _postRepository: repository, _sendCoordinator: f.service,
    logger: { log: vi.fn() }, isControlled: vi.fn().mockResolvedValue(true) });
  return { ...f, body, posts, repository };
}

it('replays first controlled enqueue of an existing draft after losing its response', async () => {
  const f = await acceptedDraftEnqueue();
  const before = structuredClone(f.db.rows('post'));
  const edit = vi.spyOn(f.service, 'editUnsentPost');
  const result = await f.posts.createPost('org', structuredClone(f.body), 'user');
  expect(result).toMatchObject([{ postId: 'root', integration: 'account', state: 'QUEUE' }]);
  expect(edit).not.toHaveBeenCalled();
  expect(f.repository.createOrUpdatePost).not.toHaveBeenCalled();
  expect(f.db.rows('post')).toEqual(before);
  expect(f.db.rows('sendIntent')).toHaveLength(1);
  expect(f.db.rows('sendMutationReceipt')).toHaveLength(1);
});

it('rejects changed creation payload with the same request ID before treating it as an edit', async () => {
  const f = await acceptedDraftEnqueue();
  f.body.posts[0].value[0].content = 'Changed after an uncertain response';
  const edit = vi.spyOn(f.service, 'editUnsentPost');
  await expect(f.posts.createPost('org', f.body, 'user')).rejects.toThrow('SEND_CREATE_REQUEST_CONFLICT');
  expect(edit).not.toHaveBeenCalled();
  expect(f.repository.createOrUpdatePost).not.toHaveBeenCalled();
});

it('does not treat a genuine subsequent full edit as a creation replay', async () => {
  const f = await acceptedDraftEnqueue();
  f.body.requestId = 'subsequent-original-edit';
  f.body.posts[0].expectedRouteRevision = 0;
  f.body.posts[0].expectedContentRevision = 1;
  const accepted = { postId: 'root', state: 'QUEUE' };
  const edit = vi.spyOn(f.service, 'editUnsentPost').mockResolvedValue(accepted as any);
  expect(await f.posts.createPost('org', f.body, 'user')).toEqual([accepted]);
  expect(edit).toHaveBeenCalledExactlyOnceWith('org', 'user', f.body, expect.any(Function));
  expect(f.db.rows('sendMutationReceipt')).toHaveLength(1);
});


it.each([true, false])('preserves the accepted original thread on creation replay (root ID supplied: %s)', async rootIdSupplied => {
  const f = await acceptedDraftEnqueue('original-thread', rootIdSupplied);
  f.db.rows('post')[0].group = 'original-thread';
  f.db.seed('post', {...f.db.rows('post')[0], id: 'original-child', parentPostId: 'root', content: 'Second segment'});
  const before = structuredClone(f.db.rows('post'));
  await f.posts.createPost('org', structuredClone(f.body), 'user');
  expect(f.repository.softDeleteGroupPosts).not.toHaveBeenCalled();
  expect(f.repository.createOrUpdatePost).not.toHaveBeenCalled();
  expect(f.db.rows('post')).toEqual(before);
});
