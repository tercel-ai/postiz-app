import { expect, it, vi } from 'vitest';
import { PostsRepository } from '../../database/prisma/posts/posts.repository';
import { EngageRepository } from '../../engage/engage.repository';
import { memorySendDatabase } from './support/memory-send-database';

vi.mock('../../redis/redis.service', () => ({ ioRedis: {} }));

function fixture(captured: string[] | null = ['old']) {
  const db = memorySendDatabase();
  const modes = {
    activeLegacyPostIdsIn: vi.fn(async () => captured ?? []),
    autonomousDrainPostIdsIn: vi.fn(async (_tx: unknown, _org: string) => captured),
    assertAutonomousIn: vi.fn(async (_tx, _org, ids?: string[]) => {
      if (captured && (!ids?.length || ids.some(id => !captured.includes(id))))
        throw new Error('SEND_MODE_TRANSITION_PENDING');
    }),
  };
  const repository = new PostsRepository({ model: db } as any, {} as any, {} as any,
    {} as any, { model: db } as any, {} as any, { model: db } as any, modes as any);
  const row = (id: string) => ({ id, organizationId: 'org', state: 'QUEUE', executionProtocol: 'LEGACY',
    parentPostId: null, source: 'calendar', intervalInDays: null, settings: '{}',
    publishMethod: 'EXTENSION', providerIdentifier: 'x', publishDate: new Date('2026-01-01') });
  return { db, modes, repository, row };
}

it('claims only captured queued posts during a pending switch', async () => {
  const { db, repository, row } = fixture();
  db.seed('post', row('old'));
  db.seed('post', row('new'));
  const result = await repository.claimDueExtensionPublishPosts('org', ['x'], new Date(), 10, 'lease', new Date(0));
  expect(result.map(post => post.id)).toEqual(['old']);
  expect(db.rows('post').find(post => post.id === 'new').releaseId).toBeNull();
});

it('returns no leases when the captured queue is empty', async () => {
  const { db, repository, row } = fixture([]);
  db.seed('post', row('new'));
  expect(await repository.claimDueExtensionPublishPosts('org', ['x'], new Date(), 10, 'lease', new Date(0))).toEqual([]);
});

it('keeps the unrestricted claim path when no switch is pending', async () => {
  const { db, repository, row } = fixture(null);
  db.seed('post', row('old'));
  db.seed('post', row('new'));
  expect(await repository.claimDueExtensionPublishPosts('org', ['x'], new Date(), 10, 'lease', new Date(0))).toHaveLength(2);
});

it('authorizes a single captured post claim by its persisted id', async () => {
  const { db, repository, row } = fixture();
  db.seed('post', row('old'));
  expect(await repository.claimPostForPublishing('old', 'lease')).toBe(true);
});

it('rejects a single noncaptured post claim', async () => {
  const { db, repository, row } = fixture();
  db.seed('post', row('new'));
  await expect(repository.claimPostForPublishing('new', 'lease')).rejects.toThrow('SEND_MODE_TRANSITION_PENDING');
  expect(db.rows('post')[0].releaseId).toBeNull();
});

it('claims an already captured recurring clone without creating a future occurrence', async () => {
  const { db, repository, row } = fixture(['clone']);
  const original = { ...row('template'), group: 'recurring', intervalInDays: 1 };
  db.seed('post', original);
  db.seed('post', { ...row('clone'), group: 'recurring' });
  expect(await repository.findOrCreateCycleClone(original, new Date('2026-01-01'), 'lease'))
    .toMatchObject({ clone: { id: 'clone' }, alreadyHandled: false });
  await expect(repository.findOrCreateCycleClone(original, new Date('2026-01-02'), 'later'))
    .rejects.toThrow('SEND_MODE_TRANSITION_PENDING');
  expect(db.rows('post')).toHaveLength(2);
});

it('filters queued Engage claims to the captured post ids under the mode lock', async () => {
  const { db, modes } = fixture();
  const findMany = vi.fn().mockResolvedValue([]);
  const repository = Object.assign(Object.create(EngageRepository.prototype), {
    _tx: { model: db }, _sendModes: modes, _sentReply: { model: { engageSentReply: { findMany } } },
  });
  db.engageSentReply = { findMany };
  await repository.claimDueEngageReplies('org', 'project', 'x', {
    limit: 1, leaseToken: 'lease', leaseCutoff: new Date(0), now: new Date(),
  });
  expect(modes.autonomousDrainPostIdsIn).toHaveBeenCalledOnce();
  expect(modes.autonomousDrainPostIdsIn.mock.calls[0][1]).toBe('org');
  expect(findMany.mock.calls[0][0].where.post.id).toEqual({ in: ['old'] });
});

it.each(['retry', 'schedule'] as const)('keeps %s as new autonomous work while draining', async action => {
  const { db, repository, row } = fixture();
  db.seed('post', { ...row('old'), state: action === 'retry' ? 'ERROR' : 'DRAFT', group: 'g' });
  const work = action === 'retry' ? repository.resetPostForRetry('old', 'org')
    : repository.schedulePostGroupToQueue('org', 'g', 'EXTENSION');
  await expect(work).rejects.toThrow('SEND_MODE_TRANSITION_PENDING');
  expect(db.rows('post')[0].state).toBe(action === 'retry' ? 'ERROR' : 'DRAFT');
});

it('allows saving a new unscheduled draft under the mode lock during draining', async () => {
  const { repository, modes } = fixture();
  (modes as any).lockIn = vi.fn(async () => ({ transition: { targetMode: 'CONTROLLED' } }));
  const result = await repository.createOrUpdatePost('draft', 'org', '2026-01-01', {
    value: [{ id: 'draft', content: 'still editable', image: [] }], settings: { __type: 'x' },
  } as any, []);
  expect(result.posts[0].state).toBe('DRAFT');
  expect((modes as any).lockIn).toHaveBeenCalled();
});

it('does not clear a captured queued claim through a draft edit during draining', async () => {
  const { db, repository, modes, row } = fixture();
  (modes as any).lockIn = vi.fn(async () => ({ transition: { targetMode: 'CONTROLLED' } }));
  db.seed('post', { ...row('old'), releaseId: 'lease', claimedAt: new Date() });
  await expect(repository.createOrUpdatePost('draft', 'org', '2026-01-01', {
    value: [{ id: 'old', content: 'changed while sending', image: [] }], settings: { __type: 'x' },
  } as any, [])).rejects.toThrow('SEND_MODE_TRANSITION_PENDING');
  expect(db.rows('post')[0]).toMatchObject({ state: 'QUEUE', releaseId: 'lease' });
});
