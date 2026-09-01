import { describe, it, expect, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { EngageService } from '../engage.service';
import { TooSimilarToReferenceError } from '../engage-reference-post.service';

// Pins EngageService.generateReferencePost/saveGeneratedPost's own wiring —
// the pieces the controller spec (which mocks EngageService entirely) and the
// EngageReferencePostService spec (which knows nothing about billing/repo
// wiring) can't cover. See docs/engage/reference-post-generation.md §5/§7.1.

function buildService(deps: {
  repo?: Record<string, any>;
  posts?: Record<string, any>;
  aisee?: Record<string, any>;
  referencePost?: Record<string, any>;
} = {}) {
  const repo = {
    getOpportunityById: vi.fn(async () => ({
      id: 'opp1',
      platform: 'x',
      externalPostUrl: 'https://x.com/coolwriter/status/1',
      authorUsername: 'coolwriter',
      title: null,
      postContent: 'The market for handmade ceramics quietly tripled.',
    })),
    getIntegrationById: vi.fn(async () => ({
      id: 'int1',
      providerIdentifier: 'x',
    })),
    attachReferenceOpportunity: vi.fn(async () => undefined),
    ...deps.repo,
  };
  const posts = {
    findFreeDateTime: vi.fn(async () => '2026-09-05T10:00:00.000Z'),
    mapTypeToPost: vi.fn(async (dto: any) => dto),
    createPost: vi.fn(async () => [{ postId: 'post1' }]),
    ...deps.posts,
  };
  const aisee = {
    billCollectedUsages: vi.fn(async () => ({})),
    ...deps.aisee,
  };
  const referencePost = {
    generate: vi.fn(async () => ({
      text: 'an original take on ceramics pricing',
      usages: [
        {
          promptTokens: 100,
          completionTokens: 40,
          totalTokens: 140,
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
        },
      ],
    })),
    ...deps.referencePost,
  };

  const service = new EngageService(
    repo as any,
    {} as any, // temporal
    posts as any,
    {} as any, // post overage
    {} as any, // entitlement
    undefined,
    undefined,
    undefined,
    aisee as any,
    referencePost as any
  );

  return { service, repo, posts, aisee, referencePost };
}

const ORG = { id: 'org1' } as any;
const GEN_DTO = { integrationId: 'int1', tone: 'personal', outputLength: 260 } as any;

describe('EngageService.generateReferencePost', () => {
  it('resolves the opportunity and integration, generates, and bills exactly the reported usages', async () => {
    const { service, aisee } = buildService();

    const result = await service.generateReferencePost(ORG, 'opp1', GEN_DTO);

    expect(result.text).toBe('an original take on ceramics pricing');
    expect(aisee.billCollectedUsages).toHaveBeenCalledTimes(1);
    const [opts, usages] = aisee.billCollectedUsages.mock.calls[0];
    expect(opts).toMatchObject({
      userId: 'org1',
      businessType: 'ai_copywriting',
      subType: 'post_gen_reference',
      relatedId: 'opp1',
    });
    expect(usages).toEqual([
      {
        servicer: 'anthropic',
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        type: 'text',
        billing_mode: 'per_token',
        method: 'messages.create',
        usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
      },
    ]);
  });

  it('throws NotFoundException when the integration does not belong to this org', async () => {
    const { service } = buildService({
      repo: { getIntegrationById: vi.fn(async () => null) },
    });

    await expect(
      service.generateReferencePost(ORG, 'opp1', GEN_DTO)
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('still returns the generated text when billing itself fails (best-effort)', async () => {
    const { service, aisee } = buildService({
      aisee: {
        billCollectedUsages: vi.fn(async () => {
          throw new Error('aisee unreachable');
        }),
      },
    });

    const result = await service.generateReferencePost(ORG, 'opp1', GEN_DTO);
    expect(result.text).toBe('an original take on ceramics pricing');
    expect(aisee.billCollectedUsages).toHaveBeenCalledTimes(1);
  });

  it('does not call billCollectedUsages when generation produced no usage entries', async () => {
    const { service, aisee } = buildService({
      referencePost: {
        generate: vi.fn(async () => ({ text: '', usages: [] })),
      },
    });

    await service.generateReferencePost(ORG, 'opp1', GEN_DTO);
    expect(aisee.billCollectedUsages).not.toHaveBeenCalled();
  });

  it('still bills the usages attached to a ReferencePostGenerationError before rethrowing (e.g. TooSimilarToReferenceError)', async () => {
    const failedUsages = [
      {
        promptTokens: 100,
        completionTokens: 40,
        totalTokens: 140,
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
      },
      {
        promptTokens: 90,
        completionTokens: 35,
        totalTokens: 125,
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
      },
    ];
    const { service, aisee } = buildService({
      referencePost: {
        generate: vi.fn(async () => {
          throw new TooSimilarToReferenceError(failedUsages as any);
        }),
      },
    });

    await expect(
      service.generateReferencePost(ORG, 'opp1', GEN_DTO)
    ).rejects.toBeInstanceOf(TooSimilarToReferenceError);

    expect(aisee.billCollectedUsages).toHaveBeenCalledTimes(1);
    const [, usages] = aisee.billCollectedUsages.mock.calls[0];
    expect(usages).toHaveLength(2);
  });

  it('does not attempt to bill when the failure carries no usages', async () => {
    const { service, aisee } = buildService({
      referencePost: {
        generate: vi.fn(async () => {
          throw new Error('no LLM provider configured');
        }),
      },
    });

    await expect(
      service.generateReferencePost(ORG, 'opp1', GEN_DTO)
    ).rejects.toThrow('no LLM provider configured');
    expect(aisee.billCollectedUsages).not.toHaveBeenCalled();
  });
});

describe('EngageService.saveGeneratedPost', () => {
  const SAVE_DTO = { content: 'final text', type: 'draft', integrationId: 'int1' } as any;

  it('resolves a placeholder date via findFreeDateTime for a draft (no explicit date)', async () => {
    const { service, posts } = buildService();

    await service.saveGeneratedPost(ORG, 'user1', 'opp1', SAVE_DTO);

    expect(posts.findFreeDateTime).toHaveBeenCalledWith('org1', 'int1', undefined);
    const [, orgId] = posts.mapTypeToPost.mock.calls[0];
    expect(orgId).toBe('org1');
    const [dto] = posts.mapTypeToPost.mock.calls[0];
    expect(dto.date).toBe('2026-09-05T10:00:00.000Z');
    expect(dto.source).toBe('calendar');
  });

  it('uses the caller-supplied date for type=schedule and skips findFreeDateTime', async () => {
    const { service, posts } = buildService();

    await service.saveGeneratedPost(ORG, 'user1', 'opp1', {
      ...SAVE_DTO,
      type: 'schedule',
      date: '2026-09-10T09:00:00.000Z',
    });

    expect(posts.findFreeDateTime).not.toHaveBeenCalled();
    const [dto] = posts.mapTypeToPost.mock.calls[0];
    expect(dto.date).toBe('2026-09-10T09:00:00.000Z');
  });

  it('type=now skips findFreeDateTime entirely (createPost overrides the date anyway)', async () => {
    const { service, posts } = buildService();

    await service.saveGeneratedPost(ORG, 'user1', 'opp1', {
      ...SAVE_DTO,
      type: 'now',
    });

    expect(posts.findFreeDateTime).not.toHaveBeenCalled();
    const [dto] = posts.mapTypeToPost.mock.calls[0];
    expect(typeof dto.date).toBe('string');
  });

  it('rejects type=schedule with no date', async () => {
    const { service } = buildService();

    await expect(
      service.saveGeneratedPost(ORG, 'user1', 'opp1', { ...SAVE_DTO, type: 'schedule' })
    ).rejects.toThrow(/date is required/);
  });

  it('attaches referenceOpportunityId and a content snapshot to the created post', async () => {
    const { service, repo } = buildService();

    await service.saveGeneratedPost(ORG, 'user1', 'opp1', SAVE_DTO);

    expect(repo.attachReferenceOpportunity).toHaveBeenCalledWith('post1', {
      opportunityId: 'opp1',
      platform: 'x',
      externalPostUrl: 'https://x.com/coolwriter/status/1',
      authorUsername: 'coolwriter',
      snapshotTitle: null,
      snapshotContent: 'The market for handmade ceramics quietly tripled.',
    });
  });

  it('throws NotFoundException when the integration does not belong to this org', async () => {
    const { service } = buildService({
      repo: { getIntegrationById: vi.fn(async () => null) },
    });

    await expect(
      service.saveGeneratedPost(ORG, 'user1', 'opp1', SAVE_DTO)
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
