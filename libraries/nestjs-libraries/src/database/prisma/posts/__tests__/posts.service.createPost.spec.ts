import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
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
      // posts.service.ts:843 reads the final state for body.type === 'now'
      // posts. Without this mock the postNow branch crashes with
      // "this._postRepository.getPostById is not a function".
      getPostById: vi.fn().mockImplementation(async (id: string) => ({
        id,
        state: 'PUBLISHED',
        error: null,
        releaseURL: null,
      })),
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
      // Default: the draft ceiling admits everything, so cases asserting other
      // behaviour are not refused before they reach it.
      assertDraftQuota: vi.fn().mockResolvedValue(undefined),
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
    {} as any,
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

describe('PostsService.createPost — explicit publishMethod (editor)', () => {
  let mocks: ReturnType<typeof createMocks>;
  let service: PostsService;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks = createMocks();
    service = createService(mocks);
  });

  // createOrUpdatePost(type, orgId, date, post, tags, inter, source, projectId, publishMethod)
  const methodArg = () => mocks.postRepository.createOrUpdatePost.mock.calls[0][8];

  it('resolves an explicit "extension" choice to the EXTENSION enum', async () => {
    await service.createPost(
      'org-1',
      makeBody({ posts: [{ integration: { id: 'int-1' }, settings: { __type: 'x' }, value: [{ content: 'hi', image: [] }], publishMethod: 'extension' }] } as any),
      'user-1'
    );
    expect(methodArg()).toBe('EXTENSION');
  });

  it('resolves an explicit "api" choice to the API enum when an integration is bound', async () => {
    await service.createPost(
      'org-1',
      makeBody({ posts: [{ integration: { id: 'int-1' }, settings: { __type: 'x' }, value: [{ content: 'hi', image: [] }], publishMethod: 'api' }] } as any),
      'user-1'
    );
    expect(methodArg()).toBe('API');
  });

  it('passes undefined when no publishMethod is given (fall back to capability check)', async () => {
    await service.createPost('org-1', makeBody(), 'user-1');
    expect(methodArg()).toBeUndefined();
  });

  it('rejects an impossible choice — "api" on an extension-only platform', async () => {
    await expect(
      service.createPost(
        'org-1',
        makeBody({ posts: [{ integration: { id: 'int-1' }, settings: { __type: 'medium' }, value: [{ content: 'hi', image: [] }], publishMethod: 'api' }] } as any),
        'user-1'
      )
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(mocks.postRepository.createOrUpdatePost).not.toHaveBeenCalled();
  });

  it('rejects "extension" on a platform the extension cannot publish', async () => {
    await expect(
      service.createPost(
        'org-1',
        makeBody({ posts: [{ integration: { id: 'int-1' }, settings: { __type: 'twitter' }, value: [{ content: 'hi', image: [] }], publishMethod: 'extension' }] } as any),
        'user-1'
      )
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

// An operation-plan post for a platform the org never connected is materialized
// with integrationId = null and published in-browser by the extension. Editing
// one must go through createPost without inventing an integration.
describe('PostsService.createPost — post with no bound integration', () => {
  let mocks: ReturnType<typeof createMocks>;
  let service: PostsService;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks = createMocks();
    service = createService(mocks);
  });

  const accountlessBody = (platform: string, publishMethod?: string) =>
    makeBody({
      posts: [
        {
          settings: { __type: platform },
          value: [{ content: 'hi', image: [] }],
          ...(publishMethod ? { publishMethod } : {}),
        },
      ],
    } as any);

  it('saves without an integration', async () => {
    const result = await service.createPost('org-1', accountlessBody('reddit'), 'user-1');
    expect(mocks.postRepository.createOrUpdatePost).toHaveBeenCalledTimes(1);
    expect(result[0].integration).toBeNull();
  });

  it('accepts "extension" — the only path an accountless post has', async () => {
    await service.createPost('org-1', accountlessBody('reddit', 'extension'), 'user-1');
    expect(mocks.postRepository.createOrUpdatePost.mock.calls[0][8]).toBe('EXTENSION');
  });

  it('rejects "api" — there is no account to publish through', async () => {
    await expect(
      service.createPost('org-1', accountlessBody('x', 'api'), 'user-1')
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(mocks.postRepository.createOrUpdatePost).not.toHaveBeenCalled();
  });
});

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

  it('calls deductIfOverage with orgId, userId, postId, source when userId is provided', async () => {
    mocks.postRepository.createOrUpdatePost.mockResolvedValue({
      posts: [makePost('post-abc')],
    });

    await service.createPost('org-1', makeBody(), 'user-1');

    expect(mocks.postOverageService.deductIfOverage).toHaveBeenCalledTimes(1);
    expect(mocks.postOverageService.deductIfOverage).toHaveBeenCalledWith(
      'org-1',
      'user-1',
      'post-abc',
      'calendar',
    );
  });

  it('forwards body.source="engage" to deductIfOverage for Engage replies', async () => {
    mocks.postRepository.createOrUpdatePost.mockResolvedValue({
      posts: [makePost('post-engage')],
    });

    await service.createPost('org-1', makeBody({ source: 'engage' } as any), 'user-1');

    expect(mocks.postOverageService.deductIfOverage).toHaveBeenCalledWith(
      'org-1',
      'user-1',
      'post-engage',
      'engage',
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
    expect(mocks.postOverageService.deductIfOverage).toHaveBeenNthCalledWith(1, 'org-1', 'user-1', 'post-1', 'calendar');
    expect(mocks.postOverageService.deductIfOverage).toHaveBeenNthCalledWith(2, 'org-1', 'user-1', 'post-2', 'calendar');
    expect(mocks.postOverageService.deductIfOverage).toHaveBeenNthCalledWith(3, 'org-1', 'user-1', 'post-3', 'calendar');
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
      'org-1', 'user-1', 'post-now', 'calendar',
    );
  });

  it('calls deductIfOverage for "draft" type posts', async () => {
    mocks.postRepository.createOrUpdatePost.mockResolvedValue({
      posts: [makePost('post-draft')],
    });

    const body = makeBody({ type: 'draft' });
    await service.createPost('org-1', body, 'user-1');

    expect(mocks.postOverageService.deductIfOverage).toHaveBeenCalledWith(
      'org-1', 'user-1', 'post-draft', 'calendar',
    );
  });
});

// The gate every HTTP entry point runs BEFORE createPost. Tests that call
// createPost directly cannot see it, which is exactly how an accountless-save
// regression can hide behind a green suite — so exercise the REAL mapTypeToPost
// (its own ValidationPipe included) here.
// A DRAFT is not scheduled for anything. Starting a publish workflow for one
// was destructive both ways: with a bound account a real publish workflow ran
// against an unfinished post, and without one startWorkflow's no-integration
// guard flipped state DRAFT → ERROR seconds after creation — silently, because
// the call is fire-and-forget, so the create itself still looked successful.
describe('PostsService.createPost — drafts are never handed to a publish workflow', () => {
  let mocks: ReturnType<typeof createMocks>;
  let service: PostsService;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks = createMocks();
    service = createService(mocks);
  });

  it('does not start a workflow for a draft', async () => {
    await service.createPost('org-1', makeBody({ type: 'draft' }), 'user-1');

    expect((service as any).startWorkflow).not.toHaveBeenCalled();
  });

  it('does not start a workflow for an account-less draft either', async () => {
    await service.createPost(
      'org-1',
      makeBody({
        type: 'draft',
        posts: [
          {
            providerIdentifier: 'reddit',
            settings: { __type: 'reddit' },
            value: [{ content: 'an original post', image: [] }],
          },
        ],
      } as any),
      'user-1'
    );

    expect((service as any).startWorkflow).not.toHaveBeenCalled();
  });

  it('still starts one for a scheduled post', async () => {
    await service.createPost('org-1', makeBody({ type: 'schedule' }), 'user-1');

    expect((service as any).startWorkflow).toHaveBeenCalledTimes(1);
  });

  it('still starts one for a post-now post', async () => {
    await service.createPost('org-1', makeBody({ type: 'now' }), 'user-1');

    expect((service as any).startWorkflow).toHaveBeenCalledTimes(1);
  });
});

describe('PostsService.mapTypeToPost — accountless posts', () => {
  let mocks: ReturnType<typeof createMocks>;
  let service: PostsService;

  const body = (post: any) => ({
    type: 'schedule',
    date: '2026-04-01T10:00:00.000Z',
    shortLink: false,
    tags: [],
    posts: [post],
  }) as any;

  // Mirrors what the client sends for a post with no bound account: the stored
  // platform marker plus the platform's required settings fields.
  const accountlessPost = (overrides?: any) => ({
    settings: { __type: 'x', who_can_reply_post: 'everyone' },
    value: [{ content: 'hello', image: [] }],
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks = createMocks();
    (mocks.integrationService as any).getIntegrationById = vi
      .fn()
      .mockResolvedValue({ id: 'int-1', providerIdentifier: 'mastodon' });
    service = createService(mocks);
  });

  it('accepts a post with no integration and keeps its settings.__type', async () => {
    const result = await service.mapTypeToPost(body(accountlessPost()), 'org-1');

    expect(result.posts[0].integration).toBeUndefined();
    expect((result.posts[0].settings as any).__type).toBe('x');
    expect((mocks.integrationService as any).getIntegrationById).not.toHaveBeenCalled();
  });

  it('rejects a post that has neither an integration nor a platform marker', async () => {
    await expect(
      service.mapTypeToPost(
        body(accountlessPost({ settings: { who_can_reply_post: 'everyone' } })),
        'org-1'
      )
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('still overwrites __type from the bound account when there is one', async () => {
    const result = await service.mapTypeToPost(
      body(accountlessPost({ integration: { id: 'int-1' } })),
      'org-1'
    );

    expect((result.posts[0].settings as any).__type).toBe('mastodon');
    expect((mocks.integrationService as any).getIntegrationById).toHaveBeenCalledWith('org-1', 'int-1');
  });
});

describe('PostsService.createPost — draft ceiling', () => {
  let mocks: ReturnType<typeof createMocks>;
  let service: PostsService;

  beforeEach(() => {
    mocks = createMocks();
    service = createService(mocks);
  });

  it('checks the ceiling ONCE for the whole batch, before anything is written', async () => {
    // Per batch, not per post: a partially-admitted batch would leave the caller
    // unable to tell which of its posts landed.
    await service.createPost(
      'org-1',
      { ...makeBody({ type: 'draft' }), projectId: 'proj-1' } as any,
      'user-1'
    );
    expect(mocks.postOverageService.assertDraftQuota).toHaveBeenCalledTimes(1);
    expect(mocks.postOverageService.assertDraftQuota).toHaveBeenCalledWith(
      'org-1',
      'user-1',
      1,
      'proj-1'
    );
  });

  it('does not charge an EDIT against the cap', async () => {
    // createOrUpdatePost upserts on value[0].id, so an entry carrying one
    // updates a draft that already counts — charging for it would leave an org
    // at its ceiling unable to edit its way down, only delete.
    const body = makeBody({ type: 'draft' }) as any;
    body.posts[0].value[0].id = 'existing-post-1';
    await service.createPost('org-1', body, 'user-1');
    expect(mocks.postOverageService.assertDraftQuota).toHaveBeenCalledWith(
      'org-1',
      'user-1',
      0,
      undefined
    );
  });

  it('counts only the NEW entries in a mixed batch', async () => {
    const body = makeBody({ type: 'draft' }) as any;
    body.posts = [
      { ...body.posts[0], value: [{ content: 'edit', id: 'existing-1' }] },
      { ...body.posts[0], value: [{ content: 'new' }] },
    ];
    await service.createPost('org-1', body, 'user-1');
    expect(mocks.postOverageService.assertDraftQuota).toHaveBeenCalledWith(
      'org-1',
      'user-1',
      1,
      undefined
    );
  });

  it('leaves scheduled posts to the send quota instead', async () => {
    await service.createPost('org-1', makeBody({ type: 'schedule' }) as any, 'user-1');
    expect(mocks.postOverageService.assertDraftQuota).not.toHaveBeenCalled();
  });

  it('writes nothing when the ceiling refuses', async () => {
    mocks.postOverageService.assertDraftQuota.mockRejectedValue(
      new Error('post_draft_limit_reached')
    );
    await expect(
      service.createPost('org-1', makeBody({ type: 'draft' }) as any, 'user-1')
    ).rejects.toThrow('post_draft_limit_reached');
    expect(mocks.postRepository.createOrUpdatePost).not.toHaveBeenCalled();
  });
});
