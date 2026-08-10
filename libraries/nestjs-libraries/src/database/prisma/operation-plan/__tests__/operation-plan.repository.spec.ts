import { describe, it, expect, vi, afterEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import {
  OperationPlanRepository,
  deriveOperationPlanPostId,
  normalizeDevtoTags,
} from '../operation-plan.repository';

function createRepo(overrides: {
  planFindFirst?: any;
  planFindMany?: any;
  planUpdate?: any;
  postFindMany?: any;
  postCreateMany?: any;
  postUpdateMany?: any;
  sentReplyFindMany?: any;
  keywordFindMany?: any;
  integrationFindMany?: any;
}) {
  return new OperationPlanRepository(
    {
      model: {
        operationPlan: {
          findFirst: overrides.planFindFirst ?? vi.fn(),
          findMany: overrides.planFindMany ?? vi.fn().mockResolvedValue([]),
          update: overrides.planUpdate ?? vi.fn(),
        },
      },
    } as any,
    {
      model: {
        post: {
          findMany: overrides.postFindMany ?? vi.fn().mockResolvedValue([]),
          createMany: overrides.postCreateMany ?? vi.fn().mockResolvedValue({ count: 0 }),
          updateMany: overrides.postUpdateMany ?? vi.fn().mockResolvedValue({ count: 0 }),
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
  afterEach(() => {
    vi.useRealTimers();
  });

  it('findStuckGenerating selects GENERATING rows older than the threshold, oldest first, capped by limit', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:10:00.000Z'));
    const planFindMany = vi.fn().mockResolvedValue([]);
    const repo = createRepo({ planFindMany });

    await repo.findStuckGenerating(600_000, 10); // 10 minutes stale

    expect(planFindMany).toHaveBeenCalledWith({
      where: {
        status: 'GENERATING',
        updatedAt: { lt: new Date('2030-01-01T00:00:00.000Z') }, // now - 600s
      },
      orderBy: { updatedAt: 'asc' },
      take: 10,
    });
  });

  it('completeGeneration writes planPayload + data + status onto the row by id', async () => {
    const planUpdate = vi.fn().mockResolvedValue({ id: 'plan-1', status: 'BILLING_PENDING' });
    const repo = createRepo({ planUpdate });

    await repo.completeGeneration('plan-1', {
      planPayload: { contentItems: [], engagePolicies: [] },
      data: { title: 'T', targetScore: 70 },
      status: 'BILLING_PENDING',
    });

    expect(planUpdate).toHaveBeenCalledWith({
      where: { id: 'plan-1' },
      data: {
        planPayload: { contentItems: [], engagePolicies: [] },
        data: { title: 'T', targetScore: 70 },
        status: 'BILLING_PENDING',
      },
    });
  });

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

  it('getSentRepliesInRange scopes by organizationId, projectId, PUBLISHED state, and the publishDate window', async () => {
    const sentReplyFindMany = vi.fn().mockResolvedValue([]);
    const repo = createRepo({ sentReplyFindMany });
    const start = new Date('2026-07-20T00:00:00.000Z');
    const end = new Date('2026-07-21T00:00:00.000Z');

    await repo.getSentRepliesInRange('org-1', 'proj-1', start, end);

    // PUBLISHED only — the extension flow keeps sent-reply rows for saved
    // DRAFTs and failed publishes leave ERROR; neither is an actual reply.
    expect(sentReplyFindMany.mock.calls[0][0].where).toEqual({
      organizationId: 'org-1',
      projectId: 'proj-1',
      post: { publishDate: { gte: start, lte: end }, state: 'PUBLISHED' },
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

  it('materializePlanPosts derives Post.id = uuidv5(plan.id, payload id) and skips existing same-plan posts', async () => {
    // The existing row is stored under the DERIVED id, so the idempotency skip must
    // key off the derived id, not the raw payload id.
    const postFindMany = vi.fn().mockResolvedValue([
      {
        id: deriveOperationPlanPostId('plan-1', '22222222-2222-4222-8222-222222222222'),
        operationPlanId: 'plan-1',
        organizationId: 'org-1',
      },
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
            deriveOperationPlanPostId('plan-1', '11111111-1111-4111-8111-111111111111'),
            deriveOperationPlanPostId('plan-1', '22222222-2222-4222-8222-222222222222'),
          ],
        },
      },
      select: { id: true, organizationId: true, operationPlanId: true },
    });
    expect(postCreateMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          id: deriveOperationPlanPostId('plan-1', '11111111-1111-4111-8111-111111111111'),
          organizationId: 'org-1',
          projectId: 'proj-1',
          operationPlanId: 'plan-1',
          integrationId: null,
          group: 'plan-1:D01:x',
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

  it('materializePlanPosts strips a duplicated leading title from title-platform content but not from x', async () => {
    const postFindMany = vi.fn().mockResolvedValue([]);
    const postCreateMany = vi.fn().mockResolvedValue({ count: 2 });
    const integrationFindMany = vi.fn().mockResolvedValue([]);
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
                // hackernews submits Post.title separately, so the repeated
                // headline must come off the body.
                id: '11111111-1111-4111-8111-111111111111',
                platform: 'hackernews',
                content: '## AI search positioning\n\nBody paragraph for HN.',
                media: [],
              },
              {
                // x has no separate title field — an identical first line is
                // real copy and stays.
                id: '22222222-2222-4222-8222-222222222222',
                platform: 'x',
                content: 'AI search positioning\n\nTweet body.',
                media: [],
              },
            ],
          },
        ],
      }
    );

    const created = postCreateMany.mock.calls[0][0].data;
    const hn = created.find((p: any) => p.providerIdentifier === 'hackernews');
    const x = created.find((p: any) => p.providerIdentifier === 'x');
    expect(hn.title).toBe('AI search positioning');
    expect(hn.content).toBe('Body paragraph for HN.');
    expect(x.content).toBe('AI search positioning\n\nTweet body.');
  });

  it('materializePlanPosts writes the headline into settings.title for non-community title platforms (devto/hackernews/medium), matching where the post editor and titleFromSettings read it — not just Post.title', async () => {
    const postFindMany = vi.fn().mockResolvedValue([]);
    const postCreateMany = vi.fn().mockResolvedValue({ count: 4 });
    const integrationFindMany = vi.fn().mockResolvedValue([]);
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
            themeTitle: 'Verified GTA 6 release info',
            platforms: [
              {
                id: '11111111-1111-4111-8111-111111111111',
                platform: 'devto',
                content: 'Dev.to body.',
                media: [],
                tags: null,
              },
              {
                id: '22222222-2222-4222-8222-222222222222',
                platform: 'hackernews',
                content: 'HN body.',
                media: [],
              },
              {
                id: '33333333-3333-4333-8333-333333333333',
                platform: 'medium',
                content: 'Medium body.',
                media: [],
              },
              {
                id: '44444444-4444-4444-8444-444444444444',
                platform: 'x',
                content: 'Tweet body.',
                media: [],
              },
            ],
          },
        ],
      }
    );

    const created = postCreateMany.mock.calls[0][0].data;
    for (const platform of ['devto', 'hackernews', 'medium']) {
      const post = created.find((p: any) => p.providerIdentifier === platform);
      expect(post.title).toBe('Verified GTA 6 release info');
      const settings = JSON.parse(post.settings);
      // The same headline, reachable where titleFromSettings/the editor's
      // per-platform settings form actually look for it — not only on the
      // Post.title column.
      expect(settings.title).toBe('Verified GTA 6 release info');
    }

    // x has no title-submitting concept — settings.title must stay absent
    // there rather than cargo-culting a value nothing reads.
    const x = created.find((p: any) => p.providerIdentifier === 'x');
    const xSettings = JSON.parse(x.settings);
    expect('title' in xSettings).toBe(false);
  });

  it('materializePlanPosts does NOT duplicate the headline into a flat settings.title for reddit — it stays nested under settings.subreddit[].value.title', async () => {
    const postFindMany = vi.fn().mockResolvedValue([]);
    const postCreateMany = vi.fn().mockResolvedValue({ count: 1 });
    const integrationFindMany = vi.fn().mockResolvedValue([]);
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
            themeTitle: 'Reddit-only headline',
            platforms: [
              {
                id: '11111111-1111-4111-8111-111111111111',
                platform: 'reddit',
                content: 'Reddit body.',
                media: [],
                redditTarget: {
                  subreddit: 'webdev',
                  title: 'Reddit-only headline',
                  type: 'self',
                  is_flair_required: false,
                },
              },
            ],
          },
        ],
      }
    );

    const created = postCreateMany.mock.calls[0][0].data;
    const reddit = created.find((p: any) => p.providerIdentifier === 'reddit');
    expect(reddit.title).toBe('Reddit-only headline');
    const settings = JSON.parse(reddit.settings);
    expect('title' in settings).toBe(false);
    expect(settings.subreddit[0].value.title).toBe('Reddit-only headline');
  });

  it('materializePlanPosts expands a thread into a chained anchor + children (parentPostId links to the PREVIOUS part)', async () => {
    const postFindMany = vi.fn().mockResolvedValue([]);
    const postCreateMany = vi.fn().mockResolvedValue({ count: 3 });
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
                id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                platform: 'x',
                content: 'Anchor tweet',
                media: [],
                thread: [
                  { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', content: 'Reply 2', media: null },
                  { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', content: 'Reply 3', media: null },
                ],
              },
            ],
          },
        ],
      }
    );

    // Every part is looked up for idempotency, anchor first then the chain — all
    // under their derived ids.
    expect(postFindMany).toHaveBeenCalledWith({
      where: {
        id: {
          in: [
            deriveOperationPlanPostId('plan-1', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
            deriveOperationPlanPostId('plan-1', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
            deriveOperationPlanPostId('plan-1', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
          ],
        },
      },
      select: { id: true, organizationId: true, operationPlanId: true },
    });
    // Anchor has no parent; each reply chains to the PREVIOUS part's DERIVED id (a
    // chain, not a star), so getPostsRecursively walks the whole thread. The same
    // derivation is applied to id and parentPostId, so the self-referential FK holds.
    expect(postCreateMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          id: deriveOperationPlanPostId('plan-1', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
          parentPostId: null,
          content: 'Anchor tweet',
          group: 'plan-1:D01:x',
          integrationId: null,
        }),
        expect.objectContaining({
          id: deriveOperationPlanPostId('plan-1', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
          parentPostId: deriveOperationPlanPostId('plan-1', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
          content: 'Reply 2',
          group: 'plan-1:D01:x',
          integrationId: null,
        }),
        expect.objectContaining({
          id: deriveOperationPlanPostId('plan-1', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
          parentPostId: deriveOperationPlanPostId('plan-1', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
          content: 'Reply 3',
          group: 'plan-1:D01:x',
          integrationId: null,
        }),
      ],
      skipDuplicates: true,
    });
  });

  it('materializePlanPosts creates a null-integration draft when the platform has no OAuth account', async () => {
    const postFindMany = vi.fn().mockResolvedValue([]);
    const postCreateMany = vi.fn().mockResolvedValue({ count: 1 });
    // No integration rows — the org has not connected a reddit account.
    const integrationFindMany = vi.fn().mockResolvedValue([]);
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
            themeTitle: 'Reddit theme',
            platforms: [
              {
                id: '33333333-3333-4333-8333-333333333333',
                platform: 'reddit',
                content: 'Reddit post text',
                media: [],
                // Attached by the reddit target resolver during generation.
                redditTarget: {
                  subreddit: 'webdev',
                  title: 'Reddit theme',
                  type: 'self',
                  is_flair_required: false,
                },
              },
            ],
          },
        ],
      }
    );

    // Post is still created; integrationId is null and the platform lives in
    // settings.__type so the by-platform plugin can pick it up. The resolved
    // subreddit is folded into settings.subreddit so the Reddit submit can run.
    expect(postCreateMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          id: deriveOperationPlanPostId('plan-1', '33333333-3333-4333-8333-333333333333'),
          integrationId: null,
          settings: JSON.stringify({
            __type: 'reddit',
            campaignId: 'campaign-1',
            contentId: 'D01',
            themeKey: 'positioning',
            subreddit: [
              {
                value: {
                  subreddit: 'webdev',
                  title: 'Reddit theme',
                  type: 'self',
                  is_flair_required: false,
                },
              },
            ],
          }),
        }),
      ],
      skipDuplicates: true,
    });
  });

  it('materializePlanPosts folds the resolved flair LABEL into settings, not the DTO flair field', async () => {
    const postFindMany = vi.fn().mockResolvedValue([]);
    const postCreateMany = vi.fn().mockResolvedValue({ count: 1 });
    const integrationFindMany = vi.fn().mockResolvedValue([]);
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
            themeTitle: 'Reddit theme',
            platforms: [
              {
                id: '33333333-3333-4333-8333-333333333333',
                platform: 'reddit',
                content: 'Reddit post text',
                media: [],
                redditTarget: {
                  subreddit: 'machinelearning',
                  title: '[D] Reddit theme',
                  type: 'self',
                  is_flair_required: false,
                  flairLabel: 'Discussion',
                },
              },
            ],
          },
        ],
      }
    );

    const settings = JSON.parse(postCreateMany.mock.calls[0][0].data[0].settings);
    expect(settings.subreddit[0].value).toEqual({
      subreddit: 'machinelearning',
      title: '[D] Reddit theme',
      type: 'self',
      is_flair_required: false,
      flairLabel: 'Discussion',
    });
    // NEVER the DTO's `flair` field: that is {id,name} and the OAuth provider
    // submits it as flair_id, so a label there would post a bogus id.
    expect(settings.subreddit[0].value).not.toHaveProperty('flair');
  });

  // linkedin has two backing integration types (personal profile vs company
  // page) but the generator only ever emits the canonical 'linkedin' platform
  // — materializePlanPosts must resolve which one to actually publish through.
  describe('materializePlanPosts linkedin -> linkedin-page resolution', () => {
    const linkedinPayload = {
      contentItems: [
        {
          contentId: 'D01',
          utcDate: '2030-01-01T00:00:00.000Z',
          themeKey: 'positioning',
          themeTitle: 'LinkedIn theme',
          platforms: [
            {
              id: '44444444-4444-4444-8444-444444444444',
              platform: 'linkedin',
              content: 'LinkedIn post text',
              media: [],
            },
          ],
        },
      ],
    };
    const plan = {
      id: 'plan-1',
      organizationId: 'org-1',
      projectId: 'proj-1',
      campaignId: 'campaign-1',
    } as any;

    it('resolves to the personal integration when only linkedin is connected', async () => {
      const postCreateMany = vi.fn().mockResolvedValue({ count: 1 });
      const integrationFindMany = vi
        .fn()
        .mockResolvedValue([{ id: 'integration-linkedin', providerIdentifier: 'linkedin' }]);
      const repo = createRepo({ postCreateMany, integrationFindMany });

      await repo.materializePlanPosts(plan, linkedinPayload);

      expect(integrationFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ providerIdentifier: { in: ['linkedin', 'linkedin-page'] } }),
        })
      );
      expect(postCreateMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({
            integrationId: null,
            group: 'plan-1:D01:linkedin',
            settings: expect.stringContaining('"__type":"linkedin"'),
          }),
        ],
        skipDuplicates: true,
      });
    });

    it('falls back to the company page integration when only linkedin-page is connected', async () => {
      const postCreateMany = vi.fn().mockResolvedValue({ count: 1 });
      const integrationFindMany = vi
        .fn()
        .mockResolvedValue([{ id: 'integration-linkedin-page', providerIdentifier: 'linkedin-page' }]);
      const repo = createRepo({ postCreateMany, integrationFindMany });

      await repo.materializePlanPosts(plan, linkedinPayload);

      expect(postCreateMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({
            integrationId: null,
            group: 'plan-1:D01:linkedin-page',
            settings: expect.stringContaining('"__type":"linkedin-page"'),
          }),
        ],
        skipDuplicates: true,
      });
    });

    it('prefers the personal integration (single post, no duplication) when both linkedin and linkedin-page are connected', async () => {
      const postCreateMany = vi.fn().mockResolvedValue({ count: 1 });
      const integrationFindMany = vi.fn().mockResolvedValue([
        { id: 'integration-linkedin', providerIdentifier: 'linkedin' },
        { id: 'integration-linkedin-page', providerIdentifier: 'linkedin-page' },
      ]);
      const repo = createRepo({ postCreateMany, integrationFindMany });

      await repo.materializePlanPosts(plan, linkedinPayload);

      expect(postCreateMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({
            integrationId: null,
            group: 'plan-1:D01:linkedin',
            settings: expect.stringContaining('"__type":"linkedin"'),
          }),
        ],
        skipDuplicates: true,
      });
      // Exactly one Post row for the one generated content item — no fan-out.
      expect((postCreateMany.mock.calls[0][0] as any).data).toHaveLength(1);
    });

    it('creates a null-integration draft tagged "linkedin" when neither is connected', async () => {
      const postCreateMany = vi.fn().mockResolvedValue({ count: 1 });
      const integrationFindMany = vi.fn().mockResolvedValue([]);
      const repo = createRepo({ postCreateMany, integrationFindMany });

      await repo.materializePlanPosts(plan, linkedinPayload);

      expect(postCreateMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({
            integrationId: null,
            group: 'plan-1:D01:linkedin',
            settings: expect.stringContaining('"__type":"linkedin"'),
          }),
        ],
        skipDuplicates: true,
      });
    });
  });

  it('materializePlanPosts drops a reddit post that has no resolved subreddit target', async () => {
    const postFindMany = vi.fn().mockResolvedValue([]);
    const postCreateMany = vi.fn().mockResolvedValue({ count: 1 });
    const integrationFindMany = vi.fn().mockResolvedValue([]);
    const repo = createRepo({ postFindMany, postCreateMany, integrationFindMany });

    const result = await repo.materializePlanPosts(
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
            themeTitle: 'Reddit theme',
            platforms: [
              // No redditTarget → unpublishable → dropped, not persisted as a
              // draft that would throw at submit on undefined.subreddit.
              {
                id: '33333333-3333-4333-8333-333333333333',
                platform: 'reddit',
                content: 'Reddit post text',
                media: [],
              },
            ],
          },
        ],
      }
    );

    expect(result).toEqual({ count: 0 });
    expect(postCreateMany).not.toHaveBeenCalled();
  });

  it('materializePlanPosts supersedes prior plans by soft-deleting their DRAFT posts (project-scoped, DRAFT-only, plan/manual drafts protected)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-06-01T00:00:00.000Z'));
    const postFindMany = vi.fn().mockResolvedValue([]);
    const postCreateMany = vi.fn().mockResolvedValue({ count: 1 });
    const postUpdateMany = vi.fn().mockResolvedValue({ count: 3 });
    const integrationFindMany = vi.fn().mockResolvedValue([
      { id: 'integration-x', providerIdentifier: 'x' },
    ]);
    const repo = createRepo({ postFindMany, postCreateMany, postUpdateMany, integrationFindMany });

    await repo.materializePlanPosts(
      {
        id: 'plan-2',
        organizationId: 'org-1',
        projectId: 'proj-1',
        campaignId: 'campaign-1',
      } as any,
      {
        contentItems: [
          {
            contentId: 'D01',
            utcDate: '2030-06-02T00:00:00.000Z',
            themeKey: 'positioning',
            themeTitle: 'AI search positioning',
            platforms: [
              {
                id: '11111111-1111-4111-8111-111111111111',
                platform: 'x',
                content: 'Publish-ready post text',
                media: [],
              },
            ],
          },
        ],
      }
    );

    // Prior plans' DRAFTs for this project are soft-deleted. Scoped by org+project;
    // only DRAFT (committed QUEUE/PUBLISHED/ERROR survive); only plan-owned drafts
    // (operationPlanId not null) and never this plan's own rows.
    expect(postUpdateMany).toHaveBeenCalledWith({
      where: {
        organizationId: 'org-1',
        projectId: 'proj-1',
        state: 'DRAFT',
        deletedAt: null,
        operationPlanId: { not: null },
        NOT: { operationPlanId: 'plan-2' },
      },
      data: { deletedAt: new Date('2030-06-01T00:00:00.000Z'), parentPostId: null },
    });
  });

  it('materializePlanPosts re-asserts the active plan on an idempotent re-materialize (all ids already exist → no create, still supersedes)', async () => {
    // The payload id already belongs to this plan (stored under its derived id) →
    // nothing new to create, but the plan is still the active one, so prior plans
    // must still be superseded.
    const postFindMany = vi.fn().mockResolvedValue([
      {
        id: deriveOperationPlanPostId('plan-2', '11111111-1111-4111-8111-111111111111'),
        operationPlanId: 'plan-2',
        organizationId: 'org-1',
      },
    ]);
    const postCreateMany = vi.fn().mockResolvedValue({ count: 0 });
    const postUpdateMany = vi.fn().mockResolvedValue({ count: 2 });
    const integrationFindMany = vi.fn().mockResolvedValue([
      { id: 'integration-x', providerIdentifier: 'x' },
    ]);
    const repo = createRepo({ postFindMany, postCreateMany, postUpdateMany, integrationFindMany });

    const result = await repo.materializePlanPosts(
      {
        id: 'plan-2',
        organizationId: 'org-1',
        projectId: 'proj-1',
        campaignId: 'campaign-1',
      } as any,
      {
        contentItems: [
          {
            contentId: 'D01',
            utcDate: '2030-06-02T00:00:00.000Z',
            themeKey: 'positioning',
            themeTitle: 'AI search positioning',
            platforms: [
              {
                id: '11111111-1111-4111-8111-111111111111',
                platform: 'x',
                content: 'Existing text',
                media: [],
              },
            ],
          },
        ],
      }
    );

    expect(result).toEqual({ count: 0 });
    expect(postCreateMany).not.toHaveBeenCalled();
    expect(postUpdateMany).toHaveBeenCalledTimes(1);
  });

  it('materializePlanPosts does NOT throw when the LLM re-emits a prior plan\'s raw UUID (namespacing by plan.id avoids the cross-plan Post.id collision)', async () => {
    // Regression for OPERATION_PLAN_POST_ID_CONFLICT: plan-A already materialized a
    // post from raw id X. The LLM hands plan-B the SAME raw id X. Because Post.id is
    // derived per-plan, plan-B's derived id differs from plan-A's, so the conflict
    // lookup (keyed on derived ids) finds nothing and creation proceeds.
    const rawId = '11111111-1111-4111-8111-111111111111';
    const priorPlanDerivedId = deriveOperationPlanPostId('plan-A', rawId);
    const thisPlanDerivedId = deriveOperationPlanPostId('plan-B', rawId);
    expect(thisPlanDerivedId).not.toEqual(priorPlanDerivedId);

    // The conflict lookup queries globally by id; plan-A's row lives under a
    // DIFFERENT derived id, so it is never returned for plan-B's derived id.
    const postFindMany = vi.fn().mockResolvedValue([]);
    const postCreateMany = vi.fn().mockResolvedValue({ count: 1 });
    const integrationFindMany = vi.fn().mockResolvedValue([
      { id: 'integration-x', providerIdentifier: 'x' },
    ]);
    const repo = createRepo({ postFindMany, postCreateMany, integrationFindMany });

    await expect(
      repo.materializePlanPosts(
        {
          id: 'plan-B',
          organizationId: 'org-1',
          projectId: 'proj-1',
          campaignId: 'campaign-1',
        } as any,
        {
          contentItems: [
            {
              contentId: 'D01',
              utcDate: '2030-06-02T00:00:00.000Z',
              themeKey: 'positioning',
              themeTitle: 'AI search positioning',
              platforms: [
                { id: rawId, platform: 'x', content: 'Publish-ready post text', media: [] },
              ],
            },
          ],
        }
      )
    ).resolves.toEqual({ count: 1 });

    expect(postCreateMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ id: thisPlanDerivedId, operationPlanId: 'plan-B' })],
      skipDuplicates: true,
    });
  });

  it('materializePlanPosts does NOT supersede when the plan resolved to zero posts (dropped reddit, no existing) — avoids wiping the previous plan into an empty calendar', async () => {
    const postFindMany = vi.fn().mockResolvedValue([]);
    const postCreateMany = vi.fn().mockResolvedValue({ count: 0 });
    const postUpdateMany = vi.fn().mockResolvedValue({ count: 0 });
    const integrationFindMany = vi.fn().mockResolvedValue([]);
    const repo = createRepo({ postFindMany, postCreateMany, postUpdateMany, integrationFindMany });

    await repo.materializePlanPosts(
      {
        id: 'plan-2',
        organizationId: 'org-1',
        projectId: 'proj-1',
        campaignId: 'campaign-1',
      } as any,
      {
        contentItems: [
          {
            contentId: 'D01',
            utcDate: '2030-06-02T00:00:00.000Z',
            themeKey: 'positioning',
            themeTitle: 'Reddit theme',
            platforms: [
              // No redditTarget → dropped → plan owns zero posts.
              {
                id: '33333333-3333-4333-8333-333333333333',
                platform: 'reddit',
                content: 'Reddit post text',
                media: [],
              },
            ],
          },
        ],
      }
    );

    expect(postUpdateMany).not.toHaveBeenCalled();
  });
});

describe('normalizeDevtoTags', () => {
  // Dev.to distributes through tag feeds, so a generated article ships with
  // tags — but only in the exact shape DevToSettingsDto accepts, or the post
  // fails validation at publish and never goes out at all.
  it('lowercases and strips everything dev.to tags cannot contain', () => {
    expect(normalizeDevtoTags(['WebDev', 'build-in-public', '#AI'])).toEqual([
      { value: -1, label: 'webdev' },
      { value: -2, label: 'buildinpublic' },
      { value: -3, label: 'ai' },
    ]);
  });

  it('caps at 4 — a fifth tag would fail ArrayMaxSize and strand the post', () => {
    const tags = normalizeDevtoTags(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(tags).toHaveLength(4);
    expect(tags.map((t) => t.label)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('dedupes tags that only differed by case or punctuation', () => {
    expect(
      normalizeDevtoTags(['AI', 'a.i.', 'ai']).map((t) => t.label)
    ).toEqual(['ai']);
  });

  it('assigns distinct NEGATIVE ids so they cannot collide with real tag ids', () => {
    // `value` is a dev.to tag id the generator cannot know. It is UI-only (the
    // provider sends `label` alone), but react-tag-autocomplete keys selected
    // tags by it, so they must be distinct — and negative, since every real
    // dev.to tag id is positive.
    const values = normalizeDevtoTags(['x', 'y', 'z']).map((t) => t.value);
    expect(values).toEqual([-1, -2, -3]);
    expect(new Set(values).size).toBe(3);
    expect(values.every((v) => v < 0)).toBe(true);
  });

  it('drops entries that normalize to nothing, and tolerates junk input', () => {
    expect(normalizeDevtoTags(['---', '', '  ', 'ok'])).toEqual([
      { value: -1, label: 'ok' },
    ]);
    expect(normalizeDevtoTags(null)).toEqual([]);
    expect(normalizeDevtoTags(undefined)).toEqual([]);
    expect(normalizeDevtoTags('webdev')).toEqual([]);
  });
});

describe('materializePlanPosts — dev.to tags', () => {
  const plan = {
    id: 'plan-1',
    organizationId: 'org-1',
    projectId: 'proj-1',
    campaignId: 'campaign-1',
  } as any;

  const devtoPayload = (tags: unknown) => ({
    contentItems: [
      {
        contentId: 'D01',
        utcDate: '2030-01-01T00:00:00.000Z',
        themeKey: 'positioning',
        themeTitle: 'Dev.to theme',
        platforms: [
          {
            id: '55555555-5555-4555-8555-555555555555',
            platform: 'devto',
            content: 'Article body',
            media: [],
            tags,
          },
        ],
      },
    ],
  });

  it('writes generated tags into settings in DevToSettingsDto shape', async () => {
    const postCreateMany = vi.fn().mockResolvedValue({ count: 1 });
    const integrationFindMany = vi
      .fn()
      .mockResolvedValue([{ id: 'integration-devto', providerIdentifier: 'devto' }]);
    const repo = createRepo({ postCreateMany, integrationFindMany });

    await repo.materializePlanPosts(plan, devtoPayload(['WebDev', 'ai']));

    const settings = JSON.parse(postCreateMany.mock.calls[0][0].data[0].settings);
    expect(settings.__type).toBe('devto');
    expect(settings.tags).toEqual([
      { value: -1, label: 'webdev' },
      { value: -2, label: 'ai' },
    ]);
  });

  it('omits `tags` entirely when the model returned none', async () => {
    // An empty array would still validate, but writing the key only when it has
    // content keeps an untagged post indistinguishable from a pre-tags one.
    const postCreateMany = vi.fn().mockResolvedValue({ count: 1 });
    const integrationFindMany = vi
      .fn()
      .mockResolvedValue([{ id: 'integration-devto', providerIdentifier: 'devto' }]);
    const repo = createRepo({ postCreateMany, integrationFindMany });

    await repo.materializePlanPosts(plan, devtoPayload(null));

    const settings = JSON.parse(postCreateMany.mock.calls[0][0].data[0].settings);
    expect(settings.__type).toBe('devto');
    expect('tags' in settings).toBe(false);
  });

  it('never leaks tags onto a non-dev.to platform', async () => {
    // The schema tells the model to null `tags` off dev.to, but a stray value
    // must not reach e.g. an X post's settings.
    const postCreateMany = vi.fn().mockResolvedValue({ count: 1 });
    const integrationFindMany = vi
      .fn()
      .mockResolvedValue([{ id: 'integration-x', providerIdentifier: 'x' }]);
    const repo = createRepo({ postCreateMany, integrationFindMany });

    await repo.materializePlanPosts(plan, {
      contentItems: [
        {
          contentId: 'D02',
          utcDate: '2030-01-02T00:00:00.000Z',
          themeKey: 'positioning',
          themeTitle: 'X theme',
          platforms: [
            {
              id: '66666666-6666-4666-8666-666666666666',
              platform: 'x',
              content: 'Tweet text',
              media: [],
              tags: ['webdev'],
            },
          ],
        },
      ],
    });

    const settings = JSON.parse(postCreateMany.mock.calls[0][0].data[0].settings);
    expect(settings.__type).toBe('x');
    expect('tags' in settings).toBe(false);
  });
});
