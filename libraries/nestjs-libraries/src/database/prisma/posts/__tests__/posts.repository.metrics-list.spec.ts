import { describe, expect, it, vi } from 'vitest';
import { PostsRepository } from '../posts.repository';

// `removedAt` is a separate axis from `state` — see the Post.removedAt note in
// the schema: a removed post keeps state=PUBLISHED because "PUBLISHED means it
// was sent; removedAt means what happened after". That invariant splits these
// queries in two, and the split is what these tests pin:
//
//   work queues   filter removed posts OUT (there is nothing left to read)
//   display reads SELECT the fact, never filter on it — the user must still see
//                 the post, and the one notification they got is otherwise the
//                 only trace of the removal
//
// Getting either backwards fails silently: a missing filter re-fetches a dead
// post forever, and a stray filter makes the post vanish from the calendar.

function makeRepo(findMany: ReturnType<typeof vi.fn>, count = vi.fn()) {
  return new PostsRepository(
    { model: { post: { findMany, count } } } as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any
  );
}

const LIST_QUERY = {
  page: 1,
  pageSize: 20,
  sortBy: 'publishDate',
  sortOrder: 'desc',
} as any;

describe('PostsRepository.getPostsList metrics gate fields', () => {
  it('selects lastMetricsFetchAt for every list row', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const repo = makeRepo(findMany, vi.fn().mockResolvedValue(0));

    await repo.getPostsList('org-1', LIST_QUERY);

    expect(findMany.mock.calls[0][0].select.lastMetricsFetchAt).toBe(true);
    expect(findMany.mock.calls[0][0].select.analytics).toBe(true);
  });

  it('selects the removal fields so a removed row can be labelled', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const repo = makeRepo(findMany, vi.fn().mockResolvedValue(0));

    await repo.getPostsList('org-1', LIST_QUERY);

    expect(findMany.mock.calls[0][0].select.removedAt).toBe(true);
    expect(findMany.mock.calls[0][0].select.removedReason).toBe(true);
  });

  it('does NOT filter removed posts out of the list', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const repo = makeRepo(findMany, vi.fn().mockResolvedValue(0));

    await repo.getPostsList('org-1', LIST_QUERY);

    expect(findMany.mock.calls[0][0].where).not.toHaveProperty('removedAt');
  });
});

describe('PostsRepository.getDueMetricsPosts removal gate', () => {
  it('excludes posts the platform removed', async () => {
    // Without this the post is due FOREVER: ingest is what stamps
    // lastMetricsFetchAt, an unreadable post never reaches ingest, so the null
    // check keeps matching for the whole monitoring window (up to 360 days on
    // the live entitlements).
    const findMany = vi.fn().mockResolvedValue([]);
    const repo = makeRepo(findMany);

    await repo.getDueMetricsPosts(
      'org-1',
      ['p1'],
      new Date('2026-01-01'),
      new Date('2026-09-01')
    );

    expect(findMany.mock.calls[0][0].where.removedAt).toBeNull();
  });

  it('keeps the rest of the due gate intact', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const repo = makeRepo(findMany);
    const windowStart = new Date('2026-01-01');
    const intervalCutoff = new Date('2026-09-01');

    await repo.getDueMetricsPosts(
      'org-1',
      ['p1', 'p2'],
      windowStart,
      intervalCutoff
    );

    const { where } = findMany.mock.calls[0][0];
    expect(where).toMatchObject({
      id: { in: ['p1', 'p2'] },
      organizationId: 'org-1',
      deletedAt: null,
      removedAt: null,
      publishDate: { gte: windowStart },
    });
    expect(where.OR).toEqual([
      { lastMetricsFetchAt: null },
      { lastMetricsFetchAt: { lt: intervalCutoff } },
    ]);
  });
});

describe('PostsRepository.getPosts (calendar) removal fields', () => {
  it('selects the removal fields without filtering on them', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const repo = makeRepo(findMany);

    await repo.getPosts('org-1', {
      startDate: '2026-09-01T00:00:00.000Z',
      endDate: '2026-09-30T00:00:00.000Z',
    } as any);

    const call = findMany.mock.calls[0][0];
    expect(call.select.removedAt).toBe(true);
    expect(call.select.removedReason).toBe(true);
    // The calendar keeps rendering a removed post — only the metrics work
    // queue filters it out.
    expect(JSON.stringify(call.where)).not.toContain('removedAt');
  });
});
