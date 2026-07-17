import { describe, it, expect, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { OperationPlanRepository } from '../operation-plan.repository';

function createRepo(overrides: {
  planFindFirst?: any;
  postFindMany?: any;
  postCreateMany?: any;
  sentReplyFindMany?: any;
  keywordFindMany?: any;
  integrationFindMany?: any;
}) {
  return new OperationPlanRepository(
    { model: { operationPlan: { findFirst: overrides.planFindFirst ?? vi.fn() } } } as any,
    {
      model: {
        post: {
          findMany: overrides.postFindMany ?? vi.fn().mockResolvedValue([]),
          createMany: overrides.postCreateMany ?? vi.fn().mockResolvedValue({ count: 0 }),
        },
      },
    } as any,
    {
      model: {
        engageSentReply: { findMany: overrides.sentReplyFindMany ?? vi.fn().mockResolvedValue([]) },
      },
    } as any,
    {
      model: {
        engageKeyword: { findMany: overrides.keywordFindMany ?? vi.fn().mockResolvedValue([]) },
      },
    } as any,
    {
      model: {
        integration: { findMany: overrides.integrationFindMany ?? vi.fn().mockResolvedValue([]) },
      },
    } as any
  );
}

describe('OperationPlanRepository', () => {
  it('getById scopes the lookup to organizationId', async () => {
    const planFindFirst = vi.fn().mockResolvedValue({ id: 'plan-1' });
    const repo = createRepo({ planFindFirst });

    await repo.getById('plan-1', 'org-1');

    expect(planFindFirst).toHaveBeenCalledWith({
      where: { id: 'plan-1', organizationId: 'org-1' },
    });
  });

  it('getById throws NotFoundException when the plan does not exist (or belongs to another org)', async () => {
    const planFindFirst = vi.fn().mockResolvedValue(null);
    const repo = createRepo({ planFindFirst });

    await expect(repo.getById('missing', 'org-1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('getPostsForPlan filters by operationPlanId + organizationId, excludes soft-deleted', async () => {
    const postFindMany = vi.fn().mockResolvedValue([]);
    const repo = createRepo({ postFindMany });

    await repo.getPostsForPlan('plan-1', 'org-1');

    expect(postFindMany.mock.calls[0][0].where).toEqual({
      operationPlanId: 'plan-1',
      organizationId: 'org-1',
      deletedAt: null,
    });
  });

  it('getSentRepliesInRange scopes by organizationId, projectId, and the publishDate window', async () => {
    const sentReplyFindMany = vi.fn().mockResolvedValue([]);
    const repo = createRepo({ sentReplyFindMany });
    const start = new Date('2026-07-20T00:00:00.000Z');
    const end = new Date('2026-07-21T00:00:00.000Z');

    await repo.getSentRepliesInRange('org-1', 'proj-1', start, end);

    expect(sentReplyFindMany.mock.calls[0][0].where).toEqual({
      organizationId: 'org-1',
      projectId: 'proj-1',
      post: { publishDate: { gte: start, lte: end } },
    });
    // Selects the opportunity platform so pacing can split per platform.
    expect(sentReplyFindMany.mock.calls[0][0].select).toEqual({
      matchedKeywords: true,
      post: { select: { publishDate: true } },
      opportunity: { select: { platform: true } },
    });
  });

  it('resolveKeywordTexts short-circuits on an empty id list without querying', async () => {
    const keywordFindMany = vi.fn();
    const repo = createRepo({ keywordFindMany });

    const result = await repo.resolveKeywordTexts([]);

    expect(result).toEqual([]);
    expect(keywordFindMany).not.toHaveBeenCalled();
  });

  it('getActivePlan filters by organizationId, projectId, status=READY, and the given instant within [startsAt, endsAt]', async () => {
    const planFindFirst = vi.fn().mockResolvedValue(null);
    const repo = createRepo({ planFindFirst });
    const now = new Date('2026-07-20T12:00:00.000Z');

    await repo.getActivePlan('org-1', 'proj-1', now);

    expect(planFindFirst).toHaveBeenCalledWith({
      where: {
        organizationId: 'org-1',
        projectId: 'proj-1',
        status: 'READY',
        startsAt: { lte: now },
        endsAt: { gte: now },
      },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('resolveKeywordTexts looks up by id IN (...)', async () => {
    const keywordFindMany = vi.fn().mockResolvedValue([{ id: 'k1', keyword: 'react' }]);
    const repo = createRepo({ keywordFindMany });

    await repo.resolveKeywordTexts(['k1', 'k2']);

    expect(keywordFindMany).toHaveBeenCalledWith({
      where: { id: { in: ['k1', 'k2'] } },
      select: { id: true, keyword: true },
    });
  });

  it('materializePlanPosts creates draft posts using platform item ids as Post.id and skips existing same-plan posts', async () => {
    const postFindMany = vi.fn().mockResolvedValue([
      { id: '22222222-2222-4222-8222-222222222222', operationPlanId: 'plan-1', organizationId: 'org-1' },
    ]);
    const postCreateMany = vi.fn().mockResolvedValue({ count: 1 });
    const integrationFindMany = vi.fn().mockResolvedValue([
      { id: 'integration-x', providerIdentifier: 'x' },
    ]);
    const repo = createRepo({ postFindMany, postCreateMany, integrationFindMany });

    await repo.materializePlanPosts(
      {
        id: 'plan-1',
        organizationId: 'org-1',
        projectId: 'proj-1',
        campaignId: 'campaign-1',
      } as any,
      {
        contentItems: [
          {
            contentId: 'D01',
            utcDate: '2030-01-01T00:00:00.000Z',
            themeKey: 'positioning',
            themeTitle: 'AI search positioning',
            platforms: [
              {
                id: '11111111-1111-4111-8111-111111111111',
                platform: 'x',
                content: 'Publish-ready post text',
                media: [],
              },
              {
                id: '22222222-2222-4222-8222-222222222222',
                platform: 'x',
                content: 'Existing text',
                media: [],
              },
            ],
          },
        ],
      }
    );

    expect(integrationFindMany).toHaveBeenCalledWith({
      where: {
        organizationId: 'org-1',
        disabled: false,
        deletedAt: null,
        providerIdentifier: { in: ['x'] },
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true, providerIdentifier: true },
    });
    expect(postFindMany).toHaveBeenCalledWith({
      where: {
        id: {
          in: [
            '11111111-1111-4111-8111-111111111111',
            '22222222-2222-4222-8222-222222222222',
          ],
        },
      },
      select: { id: true, organizationId: true, operationPlanId: true },
    });
    expect(postCreateMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          id: '11111111-1111-4111-8111-111111111111',
          organizationId: 'org-1',
          projectId: 'proj-1',
          operationPlanId: 'plan-1',
          integrationId: 'integration-x',
          group: 'plan-1:D01',
          state: 'DRAFT',
          content: 'Publish-ready post text',
          title: 'AI search positioning',
          description: null,
          settings: JSON.stringify({
            __type: 'x',
            campaignId: 'campaign-1',
            contentId: 'D01',
            themeKey: 'positioning',
          }),
        }),
      ],
      skipDuplicates: true,
    });
  });
});
