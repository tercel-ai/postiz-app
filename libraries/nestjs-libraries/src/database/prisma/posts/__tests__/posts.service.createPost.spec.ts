import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PostsService } from '../posts.service';

// ---------------------------------------------------------------------------
// Minimal mock factories — only methods touched by createPost
// ---------------------------------------------------------------------------

function makePost(id: string) {
  return { id, state: 'QUEUE' };
}

function createMocks() {
  return {
    postRepository: {
      createOrUpdatePost: vi.fn().mockResolvedValue({
        posts: [makePost('post-1')],
      }),
    },
    integrationManager: {},
    integrationService: {},
    mediaService: {},
    shortLinkService: {
      convertTextToShortLinks: vi.fn().mockImplementation((_org, msgs) => msgs),
    },
    openaiService: {},
    temporalService: {},
    refreshIntegrationService: {},
    postOverageService: {
      deductIfOverage: vi.fn().mockResolvedValue(undefined),
    },
  };
}

function createService(mocks: ReturnType<typeof createMocks>) {
  const svc = new PostsService(
    mocks.postRepository as any,
    mocks.integrationManager as any,
    mocks.integrationService as any,
    mocks.mediaService as any,
    mocks.shortLinkService as any,
    mocks.openaiService as any,
    mocks.temporalService as any,
    mocks.refreshIntegrationService as any,
    mocks.postOverageService as any,
  );
  // Stub startWorkflow to avoid Temporal calls
  (svc as any).startWorkflow = vi.fn().mockResolvedValue(undefined);
  return svc;
}

/** Minimal body matching CreatePostDto shape */
function makeBody(overrides?: Partial<{ type: string; posts: any[] }>) {
  return {
    type: 'schedule',
    date: '2026-04-01T10:00:00',
    shortLink: false,
    tags: [],
    posts: [
      {
        integration: { id: 'int-1' },
        settings: { __type: 'twitter' },
        value: [{ content: 'hello', image: [] }],
      },
    ],
    ...overrides,
  } as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PostsService.createPost — overage billing integration', () => {
  let mocks: ReturnType<typeof createMocks>;
  let service: PostsService;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks = createMocks();
    service = createService(mocks);
  });

  // -------------------------------------------------------------------------
  // userId provided → deductIfOverage called
  // -------------------------------------------------------------------------

  it('calls deductIfOverage with orgId, userId, postId when userId is provided', async () => {
    mocks.postRepository.createOrUpdatePost.mockResolvedValue({
      posts: [makePost('post-abc')],
    });

    await service.createPost('org-1', makeBody(), 'user-1');

    expect(mocks.postOverageService.deductIfOverage).toHaveBeenCalledTimes(1);
    expect(mocks.postOverageService.deductIfOverage).toHaveBeenCalledWith(
      'org-1',
      'user-1',
      'post-abc',
    );
  });

  it('calls deductIfOverage for EACH post in a multi-post body', async () => {
    let callCount = 0;
    mocks.postRepository.createOrUpdatePost.mockImplementation(async () => ({
      posts: [makePost(`post-${++callCount}`)],
    }));

    const body = makeBody({
      posts: [
        { integration: { id: 'int-1' }, settings: { __type: 'twitter' }, value: [{ content: 'a', image: [] }] },
        { integration: { id: 'int-2' }, settings: { __type: 'linkedin' }, value: [{ content: 'b', image: [] }] },
        { integration: { id: 'int-3' }, settings: { __type: 'threads' }, value: [{ content: 'c', image: [] }] },
      ],
    });

    await service.createPost('org-1', body, 'user-1');

    expect(mocks.postOverageService.deductIfOverage).toHaveBeenCalledTimes(3);
    expect(mocks.postOverageService.deductIfOverage).toHaveBeenNthCalledWith(1, 'org-1', 'user-1', 'post-1');
    expect(mocks.postOverageService.deductIfOverage).toHaveBeenNthCalledWith(2, 'org-1', 'user-1', 'post-2');
    expect(mocks.postOverageService.deductIfOverage).toHaveBeenNthCalledWith(3, 'org-1', 'user-1', 'post-3');
  });

  // -------------------------------------------------------------------------
  // userId NOT provided → deductIfOverage NOT called
  // -------------------------------------------------------------------------

  it('does NOT call deductIfOverage when userId is undefined', async () => {
    await service.createPost('org-1', makeBody());

    expect(mocks.postOverageService.deductIfOverage).not.toHaveBeenCalled();
  });

  it('does NOT call deductIfOverage when userId is empty string', async () => {
    await service.createPost('org-1', makeBody(), '');

    expect(mocks.postOverageService.deductIfOverage).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // deductIfOverage failure does NOT block post creation
  // -------------------------------------------------------------------------

  it('returns created posts even when deductIfOverage rejects', async () => {
    mocks.postOverageService.deductIfOverage.mockRejectedValue(new Error('billing down'));
    mocks.postRepository.createOrUpdatePost.mockResolvedValue({
      posts: [makePost('post-ok')],
    });

    const result = await service.createPost('org-1', makeBody(), 'user-1');

    expect(result).toEqual([{ postId: 'post-ok', integration: 'int-1' }]);
  });

  // -------------------------------------------------------------------------
  // Return value shape
  // -------------------------------------------------------------------------

  it('returns { postId, integration } for each created post', async () => {
    let callCount = 0;
    mocks.postRepository.createOrUpdatePost.mockImplementation(async () => ({
      posts: [makePost(`p-${++callCount}`)],
    }));

    const body = makeBody({
      posts: [
        { integration: { id: 'int-a' }, settings: { __type: 'twitter' }, value: [{ content: 'x', image: [] }] },
        { integration: { id: 'int-b' }, settings: { __type: 'linkedin' }, value: [{ content: 'y', image: [] }] },
      ],
    });

    const result = await service.createPost('org-1', body, 'user-1');

    expect(result).toEqual([
      { postId: 'p-1', integration: 'int-a' },
      { postId: 'p-2', integration: 'int-b' },
    ]);
  });

  it('returns empty array when createOrUpdatePost returns no posts', async () => {
    mocks.postRepository.createOrUpdatePost.mockResolvedValue({ posts: [] });

    const result = await service.createPost('org-1', makeBody(), 'user-1');

    expect(result).toEqual([]);
    expect(mocks.postOverageService.deductIfOverage).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Workflow type interaction
  // -------------------------------------------------------------------------

  it('calls deductIfOverage for "now" type posts', async () => {
    mocks.postRepository.createOrUpdatePost.mockResolvedValue({
      posts: [makePost('post-now')],
    });

    const body = makeBody({ type: 'now' });
    await service.createPost('org-1', body, 'user-1');

    expect(mocks.postOverageService.deductIfOverage).toHaveBeenCalledWith(
      'org-1', 'user-1', 'post-now',
    );
  });

  it('calls deductIfOverage for "draft" type posts', async () => {
    mocks.postRepository.createOrUpdatePost.mockResolvedValue({
      posts: [makePost('post-draft')],
    });

    const body = makeBody({ type: 'draft' });
    await service.createPost('org-1', body, 'user-1');

    expect(mocks.postOverageService.deductIfOverage).toHaveBeenCalledWith(
      'org-1', 'user-1', 'post-draft',
    );
  });
});
