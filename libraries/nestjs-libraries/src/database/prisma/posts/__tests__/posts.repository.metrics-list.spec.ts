import { describe, expect, it, vi } from 'vitest';
import { PostsRepository } from '../posts.repository';

describe('PostsRepository.getPostsList metrics gate fields', () => {
  it('selects lastMetricsFetchAt for every list row', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const count = vi.fn().mockResolvedValue(0);
    const repo = new PostsRepository(
      { model: { post: { findMany, count } } } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any
    );

    await repo.getPostsList('org-1', {
      page: 1,
      pageSize: 20,
      sortBy: 'publishDate',
      sortOrder: 'desc',
    } as any);

    expect(findMany.mock.calls[0][0].select.lastMetricsFetchAt).toBe(true);
    expect(findMany.mock.calls[0][0].select.analytics).toBe(true);
  });
});
