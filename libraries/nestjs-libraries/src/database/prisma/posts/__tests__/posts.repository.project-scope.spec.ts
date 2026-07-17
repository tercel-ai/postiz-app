import { describe, expect, it, vi } from 'vitest';
import { PostsRepository } from '../posts.repository';

// ---------------------------------------------------------------------------
// projectId stays optional everywhere: omitting it must reproduce today's
// legacy (non-project) query/write exactly (project-scoped-post-engage-
// design.md §8/§11 — "keep ordinary non-project Postiz posts working").
// ---------------------------------------------------------------------------

function createRepo(overrides: {
  findMany?: any;
  findFirst?: any;
  findUnique?: any;
  count?: any;
  upsert?: any;
  update?: any;
}) {
  return new PostsRepository(
    {
      model: {
        post: {
          findMany: overrides.findMany ?? vi.fn().mockResolvedValue([]),
          findFirst: overrides.findFirst ?? vi.fn().mockResolvedValue(null),
          findUnique: overrides.findUnique ?? vi.fn().mockResolvedValue(null),
          count: overrides.count ?? vi.fn().mockResolvedValue(0),
          upsert: overrides.upsert ?? vi.fn().mockResolvedValue({ id: 'post-1' }),
          update: overrides.update ?? vi.fn().mockResolvedValue({}),
        },
      },
    } as any,
    {} as any,
    {} as any,
    { model: { tags: { findMany: vi.fn().mockResolvedValue([]) } } } as any,
    { model: { tagsPosts: { deleteMany: vi.fn().mockResolvedValue({}) } } } as any,
    {} as any
  );
}

describe('PostsRepository projectId scoping', () => {
  it('getPosts omits the projectId filter when not provided (legacy calendar read)', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const repo = createRepo({ findMany });

    await repo.getPosts('org-1', {
      startDate: '2026-04-01',
      endDate: '2026-04-30',
    } as any);

    expect(findMany.mock.calls[0][0].where).not.toHaveProperty('projectId');
  });

  it('getPosts filters by projectId when provided', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const repo = createRepo({ findMany });

    await repo.getPosts('org-1', {
      startDate: '2026-04-01',
      endDate: '2026-04-30',
      projectId: 'proj-1',
    } as any);

    expect(findMany.mock.calls[0][0].where.projectId).toBe('proj-1');
  });

  it('getPostsList omits the projectId filter when not provided', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const count = vi.fn().mockResolvedValue(0);
    const repo = createRepo({ findMany, count });

    await repo.getPostsList('org-1', {
      page: 1,
      pageSize: 20,
      sortBy: 'publishDate',
      sortOrder: 'desc',
    } as any);

    expect(findMany.mock.calls[0][0].where).not.toHaveProperty('projectId');
    expect(count.mock.calls[0][0].where).not.toHaveProperty('projectId');
  });

  it('getPostsList filters by projectId when provided', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const count = vi.fn().mockResolvedValue(0);
    const repo = createRepo({ findMany, count });

    await repo.getPostsList('org-1', {
      page: 1,
      pageSize: 20,
      sortBy: 'publishDate',
      sortOrder: 'desc',
      projectId: 'proj-1',
    } as any);

    expect(findMany.mock.calls[0][0].where.projectId).toBe('proj-1');
    expect(count.mock.calls[0][0].where.projectId).toBe('proj-1');
  });

  it('locatePostInList mirrors getPostsList\'s projectId filter exactly', async () => {
    const count = vi.fn().mockResolvedValue(0);
    // postId lookup (findFirst) misses — exercises the "not found" branch,
    // which still runs `count` with the same `where` used by getPostsList.
    const findFirst = vi.fn().mockResolvedValue(null);
    const repo = createRepo({ findFirst, count });

    await repo.locatePostInList('org-1', {
      postId: 'missing',
      pageSize: 20,
      sortBy: 'publishDate',
      sortOrder: 'desc',
      projectId: 'proj-1',
    } as any);

    expect(findFirst.mock.calls[0][0].where.projectId).toBe('proj-1');
    expect(count.mock.calls[0][0].where.projectId).toBe('proj-1');
  });

  it('getPost omits the projectId filter when not provided (legacy detail read)', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const repo = createRepo({ findUnique });

    await repo.getPost('post-1', false, 'org-1', true);

    expect(findUnique.mock.calls[0][0].where).not.toHaveProperty('projectId');
  });

  it('getPost filters by projectId when provided (authorization-safe 404 for a foreign project)', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const repo = createRepo({ findUnique });

    await repo.getPost('post-1', false, 'org-1', true, 'proj-1');

    expect(findUnique.mock.calls[0][0].where.projectId).toBe('proj-1');
  });

  it('createOrUpdatePost sets projectId to null on create when not provided (legacy post)', async () => {
    const upsert = vi.fn().mockResolvedValue({ id: 'post-1' });
    const repo = createRepo({ upsert });

    await repo.createOrUpdatePost(
      'schedule',
      'org-1',
      '2026-04-01T10:00:00',
      {
        integration: { id: 'int-1' },
        value: [{ content: 'hello', image: [] }],
        settings: {},
      } as any,
      []
    );

    expect(upsert.mock.calls[0][0].create.projectId).toBeNull();
  });

  it('createOrUpdatePost sets projectId on create when provided', async () => {
    const upsert = vi.fn().mockResolvedValue({ id: 'post-1' });
    const repo = createRepo({ upsert });

    await repo.createOrUpdatePost(
      'schedule',
      'org-1',
      '2026-04-01T10:00:00',
      {
        integration: { id: 'int-1' },
        value: [{ content: 'hello', image: [] }],
        settings: {},
      } as any,
      [],
      undefined,
      undefined,
      'proj-1'
    );

    expect(upsert.mock.calls[0][0].create.projectId).toBe('proj-1');
  });

  it('createOrUpdatePost does NOT touch projectId on update when not provided (must not clear existing attribution)', async () => {
    const upsert = vi.fn().mockResolvedValue({ id: 'post-1' });
    const repo = createRepo({ upsert });

    await repo.createOrUpdatePost(
      'schedule',
      'org-1',
      '2026-04-01T10:00:00',
      {
        id: 'existing-post',
        integration: { id: 'int-1' },
        value: [{ id: 'existing-post', content: 'hello', image: [] }],
        settings: {},
      } as any,
      []
    );

    expect(upsert.mock.calls[0][0].update).not.toHaveProperty('projectId');
  });

  it('createOrUpdatePost DOES set projectId on update when explicitly provided', async () => {
    const upsert = vi.fn().mockResolvedValue({ id: 'post-1' });
    const repo = createRepo({ upsert });

    await repo.createOrUpdatePost(
      'schedule',
      'org-1',
      '2026-04-01T10:00:00',
      {
        id: 'existing-post',
        integration: { id: 'int-1' },
        value: [{ id: 'existing-post', content: 'hello', image: [] }],
        settings: {},
      } as any,
      [],
      undefined,
      undefined,
      'proj-2'
    );

    expect(upsert.mock.calls[0][0].update.projectId).toBe('proj-2');
  });
});

describe('PostsRepository operationPlanId scoping', () => {
  it('getPosts filters by operationPlanId when provided', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const repo = createRepo({ findMany });

    await repo.getPosts('org-1', {
      startDate: '2026-04-01',
      endDate: '2026-04-30',
      operationPlanId: 'plan-1',
    } as any);

    expect(findMany.mock.calls[0][0].where.operationPlanId).toBe('plan-1');
  });

  it('getPostsList filters by operationPlanId when provided', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const count = vi.fn().mockResolvedValue(0);
    const repo = createRepo({ findMany, count });

    await repo.getPostsList('org-1', {
      page: 1,
      pageSize: 20,
      sortBy: 'publishDate',
      sortOrder: 'desc',
      operationPlanId: 'plan-1',
    } as any);

    expect(findMany.mock.calls[0][0].where.operationPlanId).toBe('plan-1');
    expect(count.mock.calls[0][0].where.operationPlanId).toBe('plan-1');
  });

  it('locatePostInList mirrors getPostsList\'s operationPlanId filter exactly', async () => {
    const count = vi.fn().mockResolvedValue(0);
    const findFirst = vi.fn().mockResolvedValue(null);
    const repo = createRepo({ findFirst, count });

    await repo.locatePostInList('org-1', {
      postId: 'missing',
      pageSize: 20,
      sortBy: 'publishDate',
      sortOrder: 'desc',
      operationPlanId: 'plan-1',
    } as any);

    expect(findFirst.mock.calls[0][0].where.operationPlanId).toBe('plan-1');
    expect(count.mock.calls[0][0].where.operationPlanId).toBe('plan-1');
  });
});
