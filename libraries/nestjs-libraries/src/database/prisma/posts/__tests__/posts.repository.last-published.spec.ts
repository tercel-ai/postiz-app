import { describe, expect, it, vi } from 'vitest';
import { PostsRepository } from '../posts.repository';

// "Last action" on the Automation status banner. The query shape is what makes
// the number honest, so it is pinned here rather than left to the caller.
function createRepo(findFirst: any) {
  return new PostsRepository(
    { model: { post: { findFirst } } } as any,
    {} as any, {} as any, {} as any, {} as any, {} as any
  );
}

describe('PostsRepository.getLastPublishedAt', () => {
  it('asks for the newest PUBLISHED root of the project', async () => {
    const findFirst = vi.fn().mockResolvedValue({ publishDate: new Date('2026-08-19T07:30:00.000Z') });
    const repo = createRepo(findFirst);

    const result = await repo.getLastPublishedAt('org-1', 'proj-1');

    const { where, orderBy } = findFirst.mock.calls[0][0];
    expect(where.organizationId).toBe('org-1');
    expect(where.projectId).toBe('proj-1');
    // Only what actually went out — a QUEUE row carries a publishDate too, and
    // counting it would report an action that has not happened yet.
    expect(where.state).toBe('PUBLISHED');
    expect(where.deletedAt).toBeNull();
    // Roots only: a thread that went out is one action, not one per segment.
    expect(where.parentPostId).toBeNull();
    // NOT scoped to an operation plan — engage replies carry none, and a reply
    // that went out is just as much an action as a scheduled post.
    expect(where).not.toHaveProperty('operationPlanId');
    expect(orderBy).toEqual({ publishDate: 'desc' });
    expect(result).toEqual(new Date('2026-08-19T07:30:00.000Z'));
  });

  it('returns null when the project has never published', async () => {
    const repo = createRepo(vi.fn().mockResolvedValue(null));

    expect(await repo.getLastPublishedAt('org-1', 'proj-1')).toBeNull();
  });
});
