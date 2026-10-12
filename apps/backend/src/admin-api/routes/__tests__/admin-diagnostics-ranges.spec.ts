import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminDiagnosticsController } from '../admin-diagnostics.controller';
import { PostsRepository } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.repository';
import { EngageRepository } from '@gitroom/nestjs-libraries/engage/engage.repository';

const NOW = new Date('2026-10-12T04:00:00Z');
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000);

function makeController() {
  const posts = {
    findRecentErrorPosts: vi.fn().mockResolvedValue([]),
    countRecentErrorPosts: vi.fn().mockResolvedValue(0),
    findRecurringPosts: vi.fn().mockResolvedValue([]),
    findClonesByGroups: vi.fn().mockResolvedValue([]),
  };
  const engage = {
    findFailedKeywordScans: vi.fn().mockResolvedValue([]),
    findEngageReplyErrors: vi.fn().mockResolvedValue([]),
    countEngageReplyErrors: vi.fn().mockResolvedValue(0),
    findDeadReplyAccounts: vi.fn().mockResolvedValue([]),
  };
  const controller = new AdminDiagnosticsController(
    posts as any, {} as any, engage as any, {} as any,
    {} as any, {} as any, {} as any, {} as any
  );
  return { controller, posts, engage };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('diagnostic history windows', () => {
  it.each([undefined, '7', '30', 'all'])('applies range %s consistently to error queries', async (range) => {
    const { controller, posts, engage } = makeController();
    const since = range === 'all' ? null : ago(Number(range ?? '7'));
    const expected = range ?? '7';
    expect((await controller.checkErrorPosts(range)).range).toBe(expected);
    expect((await controller.checkEngageReplyErrors(range)).range).toBe(expected);
    expect((await controller.checkEngageFailedScans(range)).range).toBe(expected);
    expect(posts.findRecentErrorPosts).toHaveBeenCalledWith(since, 0, 20);
    expect(posts.countRecentErrorPosts).toHaveBeenCalledWith(since);
    expect(engage.findEngageReplyErrors).toHaveBeenCalledWith(since, 0, 20);
    expect(engage.countEngageReplyErrors).toHaveBeenCalledWith(since);
    expect(engage.findFailedKeywordScans).toHaveBeenCalledWith(
      new Date(NOW.getTime() - 3_600_000), since
    );
  });

  it.each(['0', '-7', '365', '', 'ALL'])('rejects invalid range %s before querying', async (range) => {
    const { controller, posts, engage } = makeController();
    for (const check of [
      controller.checkRecurringPosts.bind(controller),
      controller.checkErrorPosts.bind(controller),
      controller.checkEngageReplyErrors.bind(controller),
      controller.checkEngageFailedScans.bind(controller),
      controller.overview.bind(controller),
    ]) {
      await expect(check(range)).rejects.toThrow('range must be 7, 30, or all');
    }
    expect(posts.findRecentErrorPosts).not.toHaveBeenCalled();
    expect(engage.findEngageReplyErrors).not.toHaveBeenCalled();
  });

  it.each<[string, number]>([['7', 1], ['30', 2], ['all', 3]])('limits recurring anomalies to %s', async (range, count) => {
    const { controller, posts } = makeController();
    posts.findRecurringPosts.mockResolvedValue([{
      id: 'source', group: 'g', publishDate: ago(-1), createdAt: ago(60),
      intervalInDays: null, state: 'QUEUE', integration: null,
    }] as any);
    posts.findClonesByGroups.mockResolvedValue([2, 15, 45].flatMap((days) => [0, 1].map((n) => ({
      id: `${days}-${n}`, group: 'g', state: 'PUBLISHED',
      publishDate: ago(days), createdAt: new Date(ago(days).getTime() - 7_200_000),
    }))) as any);
    const result = await controller.checkRecurringPosts(range);
    expect(result.summary.duplicateCount).toBe(count);
    expect(result.summary.prematureCount).toBe(Number(count) * 2);
  });

  it('never invents missed cycles before a recurring template existed, including all time', async () => {
    const { controller, posts } = makeController();
    posts.findRecurringPosts.mockResolvedValue([{
      id: 'source', group: 'g', publishDate: ago(-1), createdAt: ago(2),
      intervalInDays: 1, state: 'QUEUE', integration: null,
    }] as any);
    const result = await controller.checkRecurringPosts('all');
    expect(result.missedCycles.map((r) => r.expectedDate)).toEqual(['2026-10-10', '2026-10-11']);
  });

  it('keeps the overview healthy when only auxiliary scan records are stale', async () => {
    const { controller } = makeController();
    const healthy = { summary: { healthy: true } } as any;
    vi.spyOn(controller, 'checkRecurringPosts').mockResolvedValue(healthy);
    vi.spyOn(controller, 'checkStuckPosts').mockResolvedValue(healthy);
    vi.spyOn(controller, 'checkIntegrations').mockResolvedValue(healthy);
    vi.spyOn(controller, 'checkErrorPosts').mockResolvedValue(healthy);
    vi.spyOn(controller, 'checkEngageScanCursors').mockResolvedValue({ summary: { healthy: false, count: 58 } } as any);
    vi.spyOn(controller, 'checkEngageFailedScans').mockResolvedValue({ summary: { healthy: false, total: 40 } } as any);
    vi.spyOn(controller, 'checkEngageDeadReplyAccounts').mockResolvedValue(healthy);
    vi.spyOn(controller, 'checkEngageReplyErrors').mockResolvedValue(healthy);
    vi.spyOn(controller, 'checkWriteLimits').mockResolvedValue(healthy);
    const result = await controller.overview('30');
    expect(result.healthy).toBe(true);
    expect(result.range).toBe('30');
    expect(controller.checkRecurringPosts).toHaveBeenCalledWith('30');
    expect(controller.checkErrorPosts).toHaveBeenCalledWith('30');
    expect(controller.checkEngageFailedScans).toHaveBeenCalledWith('30');
    expect(controller.checkEngageReplyErrors).toHaveBeenCalledWith('30');
    expect(result.engageScans.stuckCursors).toBe(58);
    vi.mocked(controller.checkErrorPosts).mockResolvedValue({ summary: { healthy: false, count: 1 } } as any);
    expect((await controller.overview('30')).healthy).toBe(false);
  });
});

describe('reply account send paths', () => {
  it('counts disabled and API-token failures, keeping extension-token warnings advisory', async () => {
    const { controller, engage } = makeController();
    engage.findDeadReplyAccounts.mockResolvedValue([
      ['ext-token', 'reddit', true, false],
      ['ext-disabled', 'reddit', false, true],
      ['api-token', 'instagram', true, false],
    ].map(([id, providerIdentifier, refreshNeeded, disabled]) => ({
      id, organizationId: 'org', integrationId: id, projectId: 'project',
      integration: { id, name: id, providerIdentifier, refreshNeeded, disabled },
    })) as any);
    const result = await controller.checkEngageDeadReplyAccounts();
    expect(result.summary).toMatchObject({ total: 3, count: 2, advisory: 1, affectedIntegrations: 2, healthy: false });
    expect(result.deadReplyAccounts.map((r) => [r.id, r.sendPath, r.blocking])).toEqual([
      ['ext-token', 'extension', false], ['ext-disabled', 'extension', true], ['api-token', 'api', true],
    ]);
  });

  it('does not mark replies unhealthy for a stale extension OAuth token', async () => {
    const { controller, engage } = makeController();
    engage.findDeadReplyAccounts.mockResolvedValue([{
      id: 'binding', integrationId: 'ext',
      integration: { id: 'ext', name: 'ext', providerIdentifier: 'reddit', refreshNeeded: true, disabled: false },
    }] as any);
    expect((await controller.checkEngageDeadReplyAccounts()).summary).toMatchObject({ count: 0, advisory: 1, healthy: true });
  });
});

describe('diagnostic database filters', () => {
  it('counts the entire window while bounding each database page', async () => {
    const rows = Array.from({ length: 101 }, (_, id) => ({ id }));
    const findMany = vi.fn().mockImplementation(({ skip, take }) => Promise.resolve(rows.slice(skip, skip + take)));
    const count = vi.fn().mockResolvedValue(rows.length);
    const repository = { _post: { model: { post: { findMany, count } } } };
    const result = await PostsRepository.prototype.findRecentErrorPosts.call(repository, ago(7), 20, 20);
    expect(result).toHaveLength(20);
    expect(result[0].id).toBe(20);
    expect(await PostsRepository.prototype.countRecentErrorPosts.call(repository, ago(7))).toBe(101);
    const query = findMany.mock.calls[0][0];
    expect(query.where).toEqual({ state: 'ERROR', updatedAt: { gte: ago(7) }, deletedAt: null });
    expect(count.mock.calls[0][0].where).toEqual(query.where);
    expect(query).toMatchObject({ skip: 20, take: 20 });
    await PostsRepository.prototype.findRecentErrorPosts.call(repository, null);
    expect(findMany.mock.calls[1][0].where).not.toHaveProperty('updatedAt');
    expect(findMany.mock.calls[1][0].take).toBe(20);
  });

  it('filters reply errors by linked post update time and excludes deleted posts', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const count = vi.fn().mockResolvedValue(101);
    const repository = { _sentReply: { model: { engageSentReply: { findMany, count } } } };
    await EngageRepository.prototype.findEngageReplyErrors.call(repository, ago(30));
    expect(findMany.mock.calls[0][0].where.post).toEqual({ state: 'ERROR', deletedAt: null, updatedAt: { gte: ago(30) } });
    expect(await EngageRepository.prototype.countEngageReplyErrors.call(repository, ago(30))).toBe(101);
    expect(count.mock.calls[0][0].where).toEqual(findMany.mock.calls[0][0].where);
    expect(findMany.mock.calls[0][0]).toMatchObject({ skip: 0, take: 20 });
    await EngageRepository.prototype.findEngageReplyErrors.call(repository, null);
    expect(findMany.mock.calls[1][0].where.post).toEqual({ state: 'ERROR', deletedAt: null });
  });

  it('limits historical initial-scan failures while keeping the running-age predicate', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const repository = { _keywordInitialScan: { model: { engageKeywordInitialScan: { findMany } } } };
    await EngageRepository.prototype.findFailedKeywordScans.call(repository, ago(1), ago(7));
    expect(findMany.mock.calls[0][0].where).toEqual({
      OR: [{ status: 'FAILED' }, { status: 'RUNNING', startedAt: { lt: ago(1) } }],
      updatedAt: { gte: ago(7) },
    });
  });
});


describe('diagnostic review regressions', () => {
  it('does not mistake an already handled cutoff-day cycle for a missed cycle', async () => {
    const { controller, posts } = makeController();
    posts.findRecurringPosts.mockResolvedValue([{
      id: 'source', group: 'g', publishDate: new Date('2026-10-12T05:00:00Z'),
      createdAt: ago(30), intervalInDays: 1, state: 'QUEUE', integration: null,
    }] as any);
    posts.findClonesByGroups.mockResolvedValue([{
      id: 'handled', group: 'g', state: 'PUBLISHED',
      publishDate: new Date('2026-10-05T01:00:00Z'), createdAt: ago(7),
    }] as any);
    const result = await controller.checkRecurringPosts('7');
    expect(result.missedCycles.some((r) => r.expectedDate === '2026-10-05')).toBe(false);
  });

  it('counts duplicate-day clones on both sides of the rolling cutoff', async () => {
    const { controller, posts } = makeController();
    posts.findRecurringPosts.mockResolvedValue([{
      id: 'source', group: 'g', publishDate: ago(-1), createdAt: ago(30),
      intervalInDays: null, state: 'QUEUE', integration: null,
    }] as any);
    posts.findClonesByGroups.mockResolvedValue([1, 5].map((hour) => ({
      id: `clone-${hour}`, group: 'g', state: 'PUBLISHED',
      publishDate: new Date(`2026-10-05T0${hour}:00:00Z`), createdAt: ago(7),
    })) as any);
    const result = await controller.checkRecurringPosts('7');
    expect(result.duplicateClones).toHaveLength(1);
    expect(result.duplicateClones[0].count).toBe(2);
  });

  it('keeps primary health available when auxiliary scan queries fail', async () => {
    const { controller } = makeController();
    const healthy = { summary: { healthy: true } } as any;
    for (const method of ['checkRecurringPosts', 'checkStuckPosts', 'checkIntegrations',
      'checkErrorPosts', 'checkEngageDeadReplyAccounts', 'checkEngageReplyErrors', 'checkWriteLimits'] as const) {
      vi.spyOn(controller, method).mockResolvedValue(healthy);
    }
    vi.spyOn(controller, 'checkEngageScanCursors').mockRejectedValue(new Error('Auxiliary scan unavailable'));
    vi.spyOn(controller, 'checkEngageFailedScans').mockRejectedValue(new Error('Legacy scan unavailable'));
    expect(await controller.overview()).toMatchObject({
      healthy: true, engageScans: { available: false, healthy: null },
    });
    vi.mocked(controller.checkErrorPosts).mockRejectedValue(new Error('Primary check unavailable'));
    await expect(controller.overview()).rejects.toThrow('Primary check unavailable');
  });

  it('returns totals independently of the requested page and keeps an empty page unhealthy', async () => {
    const { controller, posts, engage } = makeController();
    posts.countRecentErrorPosts.mockResolvedValue(101);
    engage.countEngageReplyErrors.mockResolvedValue(55);
    const errors = await controller.checkErrorPosts('all', '3', '20');
    const replies = await controller.checkEngageReplyErrors('30', '2', '20');
    expect(errors).toMatchObject({ pagination: { page: 3, pageSize: 20, total: 101 }, summary: { count: 101, healthy: false } });
    expect(replies).toMatchObject({ pagination: { page: 2, pageSize: 20, total: 55 }, summary: { count: 55, healthy: false } });
    expect(posts.findRecentErrorPosts).toHaveBeenCalledWith(null, 40, 20);
    expect(engage.findEngageReplyErrors).toHaveBeenCalledWith(ago(30), 20, 20);
  });

  it.each([['0', '20'], ['-1', '20'], ['1', '101'], ['1.2', '20'], ['1', 'NaN'], ['9007199254740992', '20']])(
    'rejects invalid pagination page=%s pageSize=%s', async (page, pageSize) => {
      const { controller, posts, engage } = makeController();
      await expect(controller.checkErrorPosts('7', page, pageSize)).rejects.toThrow();
      await expect(controller.checkEngageReplyErrors('7', page, pageSize)).rejects.toThrow();
      expect(posts.findRecentErrorPosts).not.toHaveBeenCalled();
      expect(engage.findEngageReplyErrors).not.toHaveBeenCalled();
    }
  );
});


it('clamps a removed last page without losing the full error total', async () => {
  const { controller, posts } = makeController();
  posts.countRecentErrorPosts.mockResolvedValue(45);
  expect(await controller.checkErrorPosts('all', '9', '20')).toMatchObject({
    pagination: { page: 3, pageSize: 20, total: 45 }, summary: { count: 45, healthy: false },
  });
  expect(posts.findRecentErrorPosts).toHaveBeenCalledWith(null, 40, 20);
});
