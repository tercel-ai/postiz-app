import { describe, expect, it, vi } from 'vitest';
import { PostsRepository } from '../posts.repository';

// ---------------------------------------------------------------------------
// Automation only ever acts on an operation plan's OWN posts. A post the user
// created by hand carries operationPlanId = null, so turning Automation on —
// or committing a plan, or reading the send-queue rollup — must never touch it.
//
// The guarantee is structural rather than filtered-after-the-fact: both plan
// queries match operationPlanId by EQUALITY, and null never equals a plan id.
// These tests pin the where clause so a future edit cannot loosen it into an
// `in` / `not: null` shape that would sweep manual posts in.
// ---------------------------------------------------------------------------

function createRepo(findMany: any) {
  return new PostsRepository(
    { model: { post: { findMany } } } as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any
  );
}

describe('PostsRepository plan scoping — manual posts are out of reach', () => {
  it('getSchedulablePostRootsByPlan matches operationPlanId by equality', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const repo = createRepo(findMany);

    await repo.getSchedulablePostRootsByPlan('org-1', 'plan-1');

    const { where } = findMany.mock.calls[0][0];
    expect(where.operationPlanId).toBe('plan-1');
    expect(where.organizationId).toBe('org-1');
    // Roots only, and never a soft-deleted post.
    expect(where.parentPostId).toBeNull();
    expect(where.deletedAt).toBeNull();
  });

  it('getPlanPublishingQueue matches operationPlanId by equality and only future drafts', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const repo = createRepo(findMany);
    const notBefore = new Date('2026-08-20T00:00:00.000Z');

    await repo.getPlanPublishingQueue('org-1', 'plan-1', notBefore);

    const { where, select } = findMany.mock.calls[0][0];
    expect(where.operationPlanId).toBe('plan-1');
    expect(where.organizationId).toBe('org-1');
    expect(where.state).toBe('DRAFT');
    expect(where.publishDate).toEqual({ gte: notBefore });
    expect(where.parentPostId).toBeNull();
    expect(where.deletedAt).toBeNull();
    // content is what separates a ready post from one still missing its body.
    expect(select.content).toBe(true);
  });

  it('neither query can be talked into matching a null operationPlanId', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const repo = createRepo(findMany);

    // Even handed an empty plan id, the clause stays an equality on that value —
    // it never degrades to "any plan" or "no plan".
    await repo.getSchedulablePostRootsByPlan('org-1', '');
    await repo.getPlanPublishingQueue('org-1', '', new Date());

    for (const call of findMany.mock.calls) {
      const { where } = call[0];
      expect(where).toHaveProperty('operationPlanId');
      expect(typeof where.operationPlanId).toBe('string');
    }
  });
});
