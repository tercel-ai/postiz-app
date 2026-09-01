import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InternalServerErrorException } from '@nestjs/common';
import { EngageService } from '../engage.service';
import { TooSimilarToReferenceError } from '../engage-reference-post.service';

// Pins EngageService.generateReferencePost's own wiring — generate, bill,
// AND persist as an account-less draft, all in one call (no separate
// save-generated-post — see docs/engage/reference-post-generation.md §5/§7.1).
// The controller spec (which mocks EngageService entirely) and the
// EngageReferencePostService spec (which knows nothing about billing/repo/
// post-creation wiring) can't cover this.

// EngageService builds its own storage via UploadFactory.createStorage() as
// a class field (not constructor-injected, same as agent.graph.service.ts),
// so §6.1's media-reuse tests need to mock the module itself to control
// uploadSimple.
const uploadSimple = vi.fn();
vi.mock('@gitroom/nestjs-libraries/upload/upload.factory', () => ({
  UploadFactory: { createStorage: () => ({ uploadSimple }) },
}));

// The SSRF-guarded downloader has its own dedicated suite
// (safe-media-fetch.spec.ts); here it is mocked so these tests exercise
// EngageService's own orchestration without real DNS/HTTP.
const fetchMediaAsDataUri = vi.fn();
vi.mock('@gitroom/nestjs-libraries/engage/safe-media-fetch', () => ({
  fetchMediaAsDataUri: (...args: any[]) => fetchMediaAsDataUri(...args),
}));

function buildService(deps: {
  repo?: Record<string, any>;
  posts?: Record<string, any>;
  aisee?: Record<string, any>;
  referencePost?: Record<string, any>;
  media?: Record<string, any> | null;
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
    getOpportunityMediaUrls: vi.fn(async () => []),
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
  const media =
    deps.media === null
      ? undefined
      : {
          saveFile: vi.fn(async (org: string, name: string, path: string) => ({
            id: `media-${name}`,
            name,
            path,
          })),
          ...deps.media,
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
    referencePost as any,
    media as any
  );

  return { service, repo, posts, aisee, referencePost, media };
}

const ORG = { id: 'org1' } as any;
const GEN_DTO = { strategy: 'EXPERT_ANSWER', brandStrength: 1, outputLength: 260 } as any;

beforeEach(() => {
  uploadSimple.mockReset();
  fetchMediaAsDataUri.mockReset();
  // Default: the guarded download succeeds, yielding an inert data: URI.
  fetchMediaAsDataUri.mockImplementation(
    async (url: string) => `data:image/jpeg;base64,${Buffer.from(url).toString('base64')}`
  );
});

describe('EngageService.generateReferencePost', () => {
  it('resolves the opportunity, generates with strategy/brandStrength, and bills exactly the reported usages', async () => {
    const { service, aisee, referencePost } = buildService();

    const result = await service.generateReferencePost(ORG, 'user1', 'opp1', GEN_DTO);

    expect(result.text).toBe('an original take on ceramics pricing');
    expect(referencePost.generate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'opp1', platform: 'x' }),
      'EXPERT_ANSWER',
      1,
      undefined,
      260,
      undefined
    );
    expect(aisee.billCollectedUsages).toHaveBeenCalledTimes(1);
    const [opts, usages] = aisee.billCollectedUsages.mock.calls[0];
    expect(opts).toMatchObject({
      userId: 'org1',
      businessType: 'ai_copywriting',
      subType: 'post_gen_reference',
      relatedId: 'opp1',
      data: { platform: 'x', strategy: 'EXPERT_ANSWER' },
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

  it('still returns the generated text when billing itself fails (best-effort)', async () => {
    const { service, aisee } = buildService({
      aisee: {
        billCollectedUsages: vi.fn(async () => {
          throw new Error('aisee unreachable');
        }),
      },
    });

    const result = await service.generateReferencePost(ORG, 'user1', 'opp1', GEN_DTO);
    expect(result.text).toBe('an original take on ceramics pricing');
    expect(aisee.billCollectedUsages).toHaveBeenCalledTimes(1);
  });

  it('does not call billCollectedUsages when generation produced no usage entries', async () => {
    const { service, aisee } = buildService({
      referencePost: {
        generate: vi.fn(async () => ({ text: '', usages: [] })),
      },
    });

    await service.generateReferencePost(ORG, 'user1', 'opp1', GEN_DTO);
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
    const { service, aisee, posts } = buildService({
      referencePost: {
        generate: vi.fn(async () => {
          throw new TooSimilarToReferenceError(failedUsages as any);
        }),
      },
    });

    await expect(
      service.generateReferencePost(ORG, 'user1', 'opp1', GEN_DTO)
    ).rejects.toBeInstanceOf(TooSimilarToReferenceError);

    expect(aisee.billCollectedUsages).toHaveBeenCalledTimes(1);
    const [, usages] = aisee.billCollectedUsages.mock.calls[0];
    expect(usages).toHaveLength(2);
    // A failed generation never reaches persistence — nothing to save.
    expect(posts.createPost).not.toHaveBeenCalled();
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
      service.generateReferencePost(ORG, 'user1', 'opp1', GEN_DTO)
    ).rejects.toThrow('no LLM provider configured');
    expect(aisee.billCollectedUsages).not.toHaveBeenCalled();
  });

  describe('persistence (no separate save-generated-post — this call does it all)', () => {
    it('persists an account-less DRAFT post with the generated text', async () => {
      const { service, posts } = buildService();

      await service.generateReferencePost(ORG, 'user1', 'opp1', GEN_DTO);

      expect(posts.findFreeDateTime).toHaveBeenCalledWith('org1', undefined, undefined);
      const [dto, orgId] = posts.mapTypeToPost.mock.calls[0];
      expect(orgId).toBe('org1');
      expect(dto.type).toBe('draft');
      expect(dto.source).toBe('calendar');
      expect(dto.date).toBe('2026-09-05T10:00:00.000Z');
      expect(dto.posts[0].integration).toBeUndefined();
      expect(dto.posts[0].providerIdentifier).toBe('x');
      expect(dto.posts[0].value[0].content).toBe('an original take on ceramics pricing');
      expect(posts.createPost).toHaveBeenCalledWith('org1', dto, 'user1');
    });

    it('attaches referenceOpportunityId and a content snapshot to the created post', async () => {
      const { service, repo } = buildService();

      await service.generateReferencePost(ORG, 'user1', 'opp1', GEN_DTO);

      expect(repo.attachReferenceOpportunity).toHaveBeenCalledWith('post1', {
        opportunityId: 'opp1',
        platform: 'x',
        externalPostUrl: 'https://x.com/coolwriter/status/1',
        authorUsername: 'coolwriter',
        snapshotTitle: null,
        snapshotContent: 'The market for handmade ceramics quietly tripled.',
      });
    });

    it('returns the created postId alongside the text', async () => {
      const { service } = buildService();

      const result = await service.generateReferencePost(ORG, 'user1', 'opp1', GEN_DTO);
      expect(result).toEqual({
        text: 'an original take on ceramics pricing',
        postId: 'post1',
      });
    });

    it('throws when post creation fails to return a postId', async () => {
      const { service } = buildService({
        posts: { createPost: vi.fn(async () => []) },
      });

      await expect(
        service.generateReferencePost(ORG, 'user1', 'opp1', GEN_DTO)
      ).rejects.toBeInstanceOf(InternalServerErrorException);
    });
  });

  describe('reference media reuse (§6.1 — opt-in via includeReferenceMedia)', () => {
    it('does not look up or download any media when includeReferenceMedia is omitted', async () => {
      const { service, repo, posts } = buildService();

      await service.generateReferencePost(ORG, 'user1', 'opp1', GEN_DTO);

      expect(repo.getOpportunityMediaUrls).not.toHaveBeenCalled();
      expect(fetchMediaAsDataUri).not.toHaveBeenCalled();
      expect(uploadSimple).not.toHaveBeenCalled();
      const [dto] = posts.mapTypeToPost.mock.calls[0];
      expect(dto.posts[0].value[0].image).toEqual([]);
    });

    it('downloads and re-hosts each media URL, attaching the resulting MediaDto[]', async () => {
      const { service, posts, media } = buildService({
        repo: {
          getOpportunityMediaUrls: vi.fn(async () => [
            'https://pbs.twimg.com/media/one.jpg',
            'https://pbs.twimg.com/media/two.mp4',
          ]),
        },
      });
      uploadSimple
        .mockResolvedValueOnce('https://cdn.example.com/uploads/one.jpg')
        .mockResolvedValueOnce('https://cdn.example.com/uploads/two.mp4');

      await service.generateReferencePost(ORG, 'user1', 'opp1', {
        ...GEN_DTO,
        includeReferenceMedia: true,
      });

      expect(uploadSimple).toHaveBeenCalledTimes(2);
      expect(media!.saveFile).toHaveBeenCalledWith(
        'org1',
        'one.jpg',
        'https://cdn.example.com/uploads/one.jpg'
      );
      expect(media!.saveFile).toHaveBeenCalledWith(
        'org1',
        'two.mp4',
        'https://cdn.example.com/uploads/two.mp4'
      );
      const [dto] = posts.mapTypeToPost.mock.calls[0];
      expect(dto.posts[0].value[0].image).toEqual([
        { id: 'media-one.jpg', path: 'https://cdn.example.com/uploads/one.jpg' },
        { id: 'media-two.mp4', path: 'https://cdn.example.com/uploads/two.mp4' },
      ]);
    });

    it('routes every URL through the SSRF-guarded downloader, never straight to storage', async () => {
      const { service } = buildService({
        repo: {
          getOpportunityMediaUrls: vi.fn(async () => [
            'https://pbs.twimg.com/media/one.jpg',
          ]),
        },
      });
      uploadSimple.mockResolvedValue('https://cdn.example.com/uploads/one.jpg');

      await service.generateReferencePost(ORG, 'user1', 'opp1', {
        ...GEN_DTO,
        includeReferenceMedia: true,
      });

      expect(fetchMediaAsDataUri).toHaveBeenCalledWith(
        'https://pbs.twimg.com/media/one.jpg',
        { maxBytes: expect.any(Number), timeoutMs: expect.any(Number) }
      );
      // Storage only ever sees the inert data: URI the guard produced — never
      // the raw third-party URL (which is what made it an SSRF vector).
      expect(uploadSimple).toHaveBeenCalledWith(
        expect.stringMatching(/^data:image\/jpeg;base64,/)
      );
    });

    it('skips a URL the SSRF guard rejects, without failing the whole generation', async () => {
      const { service, posts } = buildService({
        repo: {
          getOpportunityMediaUrls: vi.fn(async () => [
            'http://169.254.169.254/latest/meta-data/',
            'https://pbs.twimg.com/media/ok.jpg',
          ]),
        },
      });
      fetchMediaAsDataUri
        .mockRejectedValueOnce(new Error('blocked address 169.254.169.254'))
        .mockResolvedValueOnce('data:image/jpeg;base64,b2s=');
      uploadSimple.mockResolvedValueOnce('https://cdn.example.com/uploads/ok.jpg');

      const result = await service.generateReferencePost(ORG, 'user1', 'opp1', {
        ...GEN_DTO,
        includeReferenceMedia: true,
      });

      expect(result.postId).toBe('post1');
      const [dto] = posts.mapTypeToPost.mock.calls[0];
      expect(dto.posts[0].value[0].image).toEqual([
        { id: 'media-ok.jpg', path: 'https://cdn.example.com/uploads/ok.jpg' },
      ]);
    });

    it('drops a re-hosted file whose extension MediaDto would reject, instead of failing the whole post', async () => {
      // uploadSimple names files from the response Content-Type, and X serves
      // image/avif while Reddit serves video/webm — both yield extensions
      // ValidUrlExtension rejects. Letting one through means mapTypeToPost's
      // ValidationPipe throws and the already-generated, already-billed post
      // is lost.
      const { service, posts, media } = buildService({
        repo: {
          getOpportunityMediaUrls: vi.fn(async () => [
            'https://pbs.twimg.com/media/shot.avif',
            'https://v.redd.it/clip.webm',
            'https://pbs.twimg.com/media/fine.jpg',
          ]),
        },
      });
      uploadSimple
        .mockResolvedValueOnce('https://cdn.example.com/uploads/aaa.avif')
        .mockResolvedValueOnce('https://cdn.example.com/uploads/bbb.webm')
        .mockResolvedValueOnce('https://cdn.example.com/uploads/ccc.jpg');

      const result = await service.generateReferencePost(ORG, 'user1', 'opp1', {
        ...GEN_DTO,
        includeReferenceMedia: true,
      });

      expect(result.postId).toBe('post1');
      // No orphan Media row for the rejected files.
      expect(media!.saveFile).toHaveBeenCalledTimes(1);
      const [dto] = posts.mapTypeToPost.mock.calls[0];
      expect(dto.posts[0].value[0].image).toEqual([
        { id: 'media-ccc.jpg', path: 'https://cdn.example.com/uploads/ccc.jpg' },
      ]);
    });

    it('accepts every extension MediaDto allows', async () => {
      const { service, posts } = buildService({
        repo: {
          getOpportunityMediaUrls: vi.fn(async () => [
            'https://x.com/a',
            'https://x.com/b',
            'https://x.com/c',
            'https://x.com/d',
          ]),
        },
      });
      uploadSimple
        .mockResolvedValueOnce('https://cdn.example.com/uploads/a.png')
        .mockResolvedValueOnce('https://cdn.example.com/uploads/b.jpeg')
        .mockResolvedValueOnce('https://cdn.example.com/uploads/c.gif')
        .mockResolvedValueOnce('https://cdn.example.com/uploads/d.mp4');

      await service.generateReferencePost(ORG, 'user1', 'opp1', {
        ...GEN_DTO,
        includeReferenceMedia: true,
      });

      const [dto] = posts.mapTypeToPost.mock.calls[0];
      expect(dto.posts[0].value[0].image).toHaveLength(4);
    });

    it('caps the number of media items fetched', async () => {
      const { service } = buildService({
        repo: {
          getOpportunityMediaUrls: vi.fn(async () => [
            'https://x.com/1.jpg',
            'https://x.com/2.jpg',
            'https://x.com/3.jpg',
            'https://x.com/4.jpg',
            'https://x.com/5.jpg',
          ]),
        },
      });
      uploadSimple.mockImplementation(async (url: string) => url);

      await service.generateReferencePost(ORG, 'user1', 'opp1', {
        ...GEN_DTO,
        includeReferenceMedia: true,
      });

      expect(uploadSimple).toHaveBeenCalledTimes(4);
    });

    it('degrades to no media (not a failure) when MediaService is not configured', async () => {
      const { service, posts } = buildService({
        media: null,
        repo: {
          getOpportunityMediaUrls: vi.fn(async () => ['https://x.com/1.jpg']),
        },
      });

      const result = await service.generateReferencePost(ORG, 'user1', 'opp1', {
        ...GEN_DTO,
        includeReferenceMedia: true,
      });

      expect(result.postId).toBe('post1');
      expect(uploadSimple).not.toHaveBeenCalled();
      const [dto] = posts.mapTypeToPost.mock.calls[0];
      expect(dto.posts[0].value[0].image).toEqual([]);
    });

    it('degrades to no media when the opportunity media lookup itself fails', async () => {
      const { service, posts } = buildService({
        repo: {
          getOpportunityMediaUrls: vi.fn(async () => {
            throw new Error('db unreachable');
          }),
        },
      });

      const result = await service.generateReferencePost(ORG, 'user1', 'opp1', {
        ...GEN_DTO,
        includeReferenceMedia: true,
      });

      expect(result.postId).toBe('post1');
      const [dto] = posts.mapTypeToPost.mock.calls[0];
      expect(dto.posts[0].value[0].image).toEqual([]);
    });
  });
});
