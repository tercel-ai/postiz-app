import { describe, expect, it, vi } from 'vitest';
import { PostsRepository } from '../posts.repository';

// ---------------------------------------------------------------------------
// Reference-posts — the AI originals written by
// POST /engage/opportunities/:id/generate-post — carry no `source` of their own
// (they stay 'calendar' by design, docs/engage/reference-post-generation.md
// §4.1). They are identified by a non-null `Post.referenceOpportunityId` plus
// `source != 'engage'`, because §4.4 backfills that same column onto engage
// REPLY posts, which are not reference-posts.
//
// Those clauses live inside `AND` rather than beside the other top-level
// filters for one concrete reason: `source` is ALREADY a top-level key
// (`query.source`), and `getPosts` already owns a top-level `OR`. Spreading
// them in would silently overwrite one filter with the other. The
// "coexists with query.source" test below is what pins that down.
//
// `getPosts` / `getPostsList` / `locatePostInList` must build the same clauses
// or `/posts/list/locate` returns a page index that does not match
// `/posts/list`.
// ---------------------------------------------------------------------------

function createRepo(overrides: {
  findMany?: any;
  findFirst?: any;
  count?: any;
} = {}) {
  return new PostsRepository(
    {
      model: {
        post: {
          findMany: overrides.findMany ?? vi.fn().mockResolvedValue([]),
          findFirst: overrides.findFirst ?? vi.fn().mockResolvedValue(null),
          count: overrides.count ?? vi.fn().mockResolvedValue(0),
        },
      },
    } as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any
  );
}

const CALENDAR_RANGE = { startDate: '2026-04-01', endDate: '2026-04-30' };
const LIST_QUERY = {
  page: 1,
  pageSize: 20,
  sortBy: 'publishDate',
  sortOrder: 'desc',
};

const REFERENCE_CLAUSES = [
  { referenceOpportunityId: { not: null } },
  { source: { not: 'engage' } },
];
const NON_REFERENCE_CLAUSES = [
  { OR: [{ referenceOpportunityId: null }, { source: 'engage' }] },
];

describe('PostsRepository reference-post filtering', () => {
  describe('getPosts (calendar)', () => {
    it('adds no reference clauses when neither filter is provided', async () => {
      const findMany = vi.fn().mockResolvedValue([]);
      const repo = createRepo({ findMany });

      await repo.getPosts('org-1', { ...CALENDAR_RANGE } as any);

      // Only the two clauses the calendar always has (org ownership, date range).
      expect(findMany.mock.calls[0][0].where.AND).toHaveLength(2);
    });

    it('keeps only reference-posts when isReferencePost=true', async () => {
      const findMany = vi.fn().mockResolvedValue([]);
      const repo = createRepo({ findMany });

      await repo.getPosts('org-1', {
        ...CALENDAR_RANGE,
        isReferencePost: true,
      } as any);

      expect(findMany.mock.calls[0][0].where.AND).toEqual(
        expect.arrayContaining(REFERENCE_CLAUSES)
      );
    });

    it('keeps only non-reference-posts when isReferencePost=false', async () => {
      const findMany = vi.fn().mockResolvedValue([]);
      const repo = createRepo({ findMany });

      await repo.getPosts('org-1', {
        ...CALENDAR_RANGE,
        isReferencePost: false,
      } as any);

      expect(findMany.mock.calls[0][0].where.AND).toEqual(
        expect.arrayContaining(NON_REFERENCE_CLAUSES)
      );
    });

    it('an explicit referenceOpportunityId wins over isReferencePost', async () => {
      const findMany = vi.fn().mockResolvedValue([]);
      const repo = createRepo({ findMany });

      await repo.getPosts('org-1', {
        ...CALENDAR_RANGE,
        referenceOpportunityId: 'opp-1',
        isReferencePost: false,
      } as any);

      const { AND } = findMany.mock.calls[0][0].where;
      expect(AND).toEqual(
        expect.arrayContaining([{ referenceOpportunityId: 'opp-1' }])
      );
      // The id filter is deliberately unguarded: every post tracing back to
      // that opportunity, engage reply included.
      expect(AND).not.toEqual(
        expect.arrayContaining([{ source: { not: 'engage' } }])
      );
    });

    it('returns the attribution fields the frontend badges read', async () => {
      const findMany = vi.fn().mockResolvedValue([]);
      const repo = createRepo({ findMany });

      await repo.getPosts('org-1', { ...CALENDAR_RANGE } as any);

      const { select } = findMany.mock.calls[0][0];
      expect(select.referenceOpportunityId).toBe(true);
      expect(select.source).toBe(true);
    });
  });

  describe('getPostsList', () => {
    it('adds no AND clause when neither filter is provided', async () => {
      const findMany = vi.fn().mockResolvedValue([]);
      const count = vi.fn().mockResolvedValue(0);
      const repo = createRepo({ findMany, count });

      await repo.getPostsList('org-1', { ...LIST_QUERY } as any);

      expect(findMany.mock.calls[0][0].where).not.toHaveProperty('AND');
      expect(count.mock.calls[0][0].where).not.toHaveProperty('AND');
    });

    it('applies the reference clauses to both the page and the total', async () => {
      const findMany = vi.fn().mockResolvedValue([]);
      const count = vi.fn().mockResolvedValue(0);
      const repo = createRepo({ findMany, count });

      await repo.getPostsList('org-1', {
        ...LIST_QUERY,
        isReferencePost: true,
      } as any);

      expect(findMany.mock.calls[0][0].where.AND).toEqual(REFERENCE_CLAUSES);
      expect(count.mock.calls[0][0].where.AND).toEqual(REFERENCE_CLAUSES);
    });

    it('coexists with a source filter instead of overwriting it', async () => {
      const findMany = vi.fn().mockResolvedValue([]);
      const count = vi.fn().mockResolvedValue(0);
      const repo = createRepo({ findMany, count });

      await repo.getPostsList('org-1', {
        ...LIST_QUERY,
        source: ['calendar'],
        isReferencePost: true,
      } as any);

      const { where } = findMany.mock.calls[0][0];
      expect(where.source).toEqual({ in: ['calendar'] });
      expect(where.AND).toEqual(REFERENCE_CLAUSES);
    });

    it('returns the attribution fields the frontend badges read', async () => {
      const findMany = vi.fn().mockResolvedValue([]);
      const count = vi.fn().mockResolvedValue(0);
      const repo = createRepo({ findMany, count });

      await repo.getPostsList('org-1', { ...LIST_QUERY } as any);

      const { select } = findMany.mock.calls[0][0];
      expect(select.referenceOpportunityId).toBe(true);
      expect(select.source).toBe(true);
    });
  });

  describe('locatePostInList mirrors getPostsList', () => {
    it.each([
      ['isReferencePost=true', { isReferencePost: true }],
      ['isReferencePost=false', { isReferencePost: false }],
      ['referenceOpportunityId', { referenceOpportunityId: 'opp-1' }],
      ['neither filter', {}],
    ])('builds the same clauses for %s', async (_label, filter) => {
      const listFindMany = vi.fn().mockResolvedValue([]);
      const listRepo = createRepo({
        findMany: listFindMany,
        count: vi.fn().mockResolvedValue(0),
      });
      await listRepo.getPostsList('org-1', {
        ...LIST_QUERY,
        ...filter,
      } as any);

      const locateCount = vi.fn().mockResolvedValue(0);
      const locateRepo = createRepo({
        findFirst: vi.fn().mockResolvedValue(null),
        count: locateCount,
      });
      await locateRepo.locatePostInList('org-1', {
        postId: 'post-1',
        ...LIST_QUERY,
        ...filter,
      } as any);

      expect(locateCount.mock.calls[0][0].where.AND).toEqual(
        listFindMany.mock.calls[0][0].where.AND
      );
    });
  });
});
