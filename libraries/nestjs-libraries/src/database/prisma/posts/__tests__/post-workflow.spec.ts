import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PostsService } from '../posts.service';
import { PostsRepository } from '../posts.repository';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeIntegration(overrides?: Partial<any>) {
  return {
    id: 'int-1',
    organizationId: 'org-1',
    providerIdentifier: 'x',
    name: 'Test Account',
    token: 'access:secret',
    disabled: false,
    refreshNeeded: false,
    tokenExpiration: new Date(Date.now() + 86400000),
    internalId: 'x-user-123',
    ...overrides,
  };
}

function makePost(overrides?: Partial<any>) {
  return {
    id: 'post-1',
    organizationId: 'org-1',
    integrationId: 'int-1',
    group: 'group-uuid-1',
    content: '<p>Hello world</p>',
    image: '[]',
    settings: '{"__type":"x"}',
    publishDate: new Date('2026-04-01T10:00:00Z'),
    state: 'QUEUE',
    intervalInDays: null,
    sourcePostId: null,
    parentPostId: null,
    deletedAt: null,
    releaseId: null,
    releaseURL: null,
    error: null,
    integration: makeIntegration(),
    childrenPost: [],
    ...overrides,
  };
}

function makeRecurringPost(overrides?: Partial<any>) {
  return makePost({
    intervalInDays: 1,
    ...overrides,
  });
}

function createRepoMocks() {
  return {
    createOrUpdatePost: vi.fn(),
    getPostById: vi.fn(),
    findOrCreateCycleClone: vi.fn(),
    finalizeCycleClone: vi.fn(),
    advancePublishDate: vi.fn().mockResolvedValue(true),
    changeState: vi.fn(),
    deletePost: vi.fn(),
    getPostsList: vi.fn(),
    getPosts: vi.fn(),
    updatePost: vi.fn(),
    logError: vi.fn(),
    countPostsFromDay: vi.fn().mockResolvedValue(0),
    findClonesByGroups: vi.fn().mockResolvedValue([]),
  };
}

function createServiceMocks() {
  return {
    postRepository: createRepoMocks(),
    integrationManager: {
      getSocialIntegration: vi.fn().mockReturnValue({
        identifier: 'x',
        post: vi.fn().mockResolvedValue([
          { id: 'post-1', postId: 'tw-123', releaseURL: 'https://twitter.com/user/status/123', status: 'ok' },
        ]),
      }),
    },
    integrationService: {
      getIntegrationById: vi.fn().mockResolvedValue(makeIntegration()),
    },
    mediaService: {},
    shortLinkService: {
      convertTextToShortLinks: vi.fn().mockImplementation((_org, msgs) => msgs),
    },
    openaiService: {},
    temporalService: {},
    refreshIntegrationService: {
      refresh: vi.fn().mockResolvedValue({ accessToken: 'new-token' }),
    },
    postOverageService: {
      deductIfOverage: vi.fn().mockResolvedValue(undefined),
    },
  };
}

function createService(mocks: ReturnType<typeof createServiceMocks>) {
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
  (svc as any).startWorkflow = vi.fn().mockResolvedValue(undefined);
  return svc;
}

// ---------------------------------------------------------------------------
// Tests: findOrCreateCycleClone (repository-level)
// ---------------------------------------------------------------------------

describe('PostsRepository.findOrCreateCycleClone', () => {
  let repo: any;
  let mockPrismaPost: any;

  beforeEach(() => {
    mockPrismaPost = {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
    };

    repo = new PostsRepository(
      { model: { post: mockPrismaPost } } as any,
    );
  });

  it('should create clone WITHOUT sourcePostId', async () => {
    const original = makeRecurringPost();
    const cycleDate = new Date('2026-04-02T10:00:00Z');

    mockPrismaPost.findFirst.mockResolvedValue(null); // no existing clone
    mockPrismaPost.create.mockResolvedValue({ id: 'clone-1', state: 'QUEUE' });
    mockPrismaPost.findMany.mockResolvedValue([{ id: 'clone-1', createdAt: new Date() }]);

    const result = await repo.findOrCreateCycleClone(original, cycleDate, 'claim_123');

    expect(result.alreadyHandled).toBe(false);

    // Verify clone created without sourcePostId
    const createCall = mockPrismaPost.create.mock.calls[0][0];
    expect(createCall.data.sourcePostId).toBeUndefined();
    expect(createCall.data.group).toBe(original.group);
    expect(createCall.data.publishDate).toEqual(cycleDate);
  });

  it('should detect existing clone by group + publishDate (not sourcePostId)', async () => {
    const original = makeRecurringPost();
    const cycleDate = new Date('2026-04-02T10:00:00Z');

    mockPrismaPost.findFirst.mockResolvedValue({
      id: 'clone-existing',
      state: 'PUBLISHED',
      releaseId: 'tw-456',
    });

    const result = await repo.findOrCreateCycleClone(original, cycleDate, 'claim_123');

    expect(result.alreadyHandled).toBe(true);

    // Verify lookup uses group + publishDate, not sourcePostId
    const findCall = mockPrismaPost.findFirst.mock.calls[0][0];
    expect(findCall.where.group).toBe(original.group);
    expect(findCall.where.publishDate).toEqual(cycleDate);
    expect(findCall.where.id).toEqual({ not: original.id });
    expect(findCall.where.sourcePostId).toBeUndefined();
  });

  it('should handle race condition — earliest clone wins', async () => {
    const original = makeRecurringPost();
    const cycleDate = new Date('2026-04-02T10:00:00Z');
    const earlier = new Date('2026-04-02T09:59:00Z');
    const later = new Date('2026-04-02T10:00:01Z');

    mockPrismaPost.findFirst.mockResolvedValue(null);
    mockPrismaPost.create.mockResolvedValue({ id: 'clone-mine', state: 'QUEUE' });
    mockPrismaPost.findMany.mockResolvedValue([
      { id: 'clone-theirs', createdAt: earlier },
      { id: 'clone-mine', createdAt: later },
    ]);
    mockPrismaPost.delete.mockResolvedValue({});

    const result = await repo.findOrCreateCycleClone(original, cycleDate, 'claim_123');

    expect(result.alreadyHandled).toBe(true);
    expect(result.clone.id).toBe('clone-theirs');
    expect(mockPrismaPost.delete).toHaveBeenCalledWith({ where: { id: 'clone-mine' } });
  });
});

// ---------------------------------------------------------------------------
// Tests: finalizeRecurringCycle (service-level)
// ---------------------------------------------------------------------------

describe('PostsService.finalizeRecurringCycle', () => {
  let mocks: ReturnType<typeof createServiceMocks>;
  let service: PostsService;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks = createServiceMocks();
    service = createService(mocks);
  });

  it('should finalize clone + advance publishDate on SUCCESS', async () => {
    const post = makeRecurringPost();
    mocks.postRepository.getPostById.mockResolvedValue(post);

    await service.finalizeRecurringCycle(
      'post-1', 'clone-1', post.publishDate,
      { state: 'PUBLISHED', releaseId: 'tw-123', releaseURL: 'https://twitter.com/status/123' }
    );

    expect(mocks.postRepository.finalizeCycleClone).toHaveBeenCalledWith('clone-1', {
      state: 'PUBLISHED',
      releaseId: 'tw-123',
      releaseURL: 'https://twitter.com/status/123',
    });
    expect(mocks.postRepository.advancePublishDate).toHaveBeenCalledWith(
      post.id, post.publishDate, 1
    );
  });

  it('should finalize clone + advance publishDate on ERROR', async () => {
    const post = makeRecurringPost();
    mocks.postRepository.getPostById.mockResolvedValue(post);

    await service.finalizeRecurringCycle(
      'post-1', 'clone-1', post.publishDate,
      { state: 'ERROR', error: 'Rate limited' }
    );

    expect(mocks.postRepository.finalizeCycleClone).toHaveBeenCalledWith('clone-1', {
      state: 'ERROR',
      error: 'Rate limited',
    });
    // Still advances — next cycle must not be blocked
    expect(mocks.postRepository.advancePublishDate).toHaveBeenCalled();
  });

  it('should skip non-recurring post', async () => {
    const post = makePost(); // intervalInDays: null
    mocks.postRepository.getPostById.mockResolvedValue(post);

    await service.finalizeRecurringCycle(
      'post-1', 'clone-1', post.publishDate,
      { state: 'PUBLISHED', releaseId: 'tw-1', releaseURL: 'url' }
    );

    expect(mocks.postRepository.finalizeCycleClone).not.toHaveBeenCalled();
    expect(mocks.postRepository.advancePublishDate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: deletePost — recurring vs non-recurring
// ---------------------------------------------------------------------------

describe('PostsRepository.deletePost', () => {
  let repo: any;
  let mockPrismaPost: any;

  beforeEach(() => {
    mockPrismaPost = {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      updateMany: vi.fn(),
    };

    repo = new PostsRepository(
      { model: { post: mockPrismaPost } } as any,
    );
  });

  it('should delete everything for non-recurring posts', async () => {
    // No recurring post in group
    mockPrismaPost.findFirst
      .mockResolvedValueOnce(null) // hasRecurring check
      .mockResolvedValueOnce({ id: 'post-1' }); // return value
    mockPrismaPost.updateMany.mockResolvedValue({ count: 3 });

    await repo.deletePost('org-1', 'group-1');

    const updateCall = mockPrismaPost.updateMany.mock.calls[0][0];
    expect(updateCall.where.state).toBeUndefined(); // no state filter — delete all
    expect(updateCall.data.deletedAt).toBeDefined();
  });

  it('should only delete QUEUE/DRAFT for recurring posts', async () => {
    // Has recurring post in group
    mockPrismaPost.findFirst
      .mockResolvedValueOnce({ id: 'recurring-1' }) // hasRecurring check
      .mockResolvedValueOnce({ id: 'recurring-1' }); // return value
    mockPrismaPost.updateMany.mockResolvedValue({ count: 1 });

    await repo.deletePost('org-1', 'group-1');

    const updateCall = mockPrismaPost.updateMany.mock.calls[0][0];
    expect(updateCall.where.state).toEqual({ in: ['QUEUE', 'DRAFT'] });
  });

  it('should preserve PUBLISHED clones after deleting recurring post', async () => {
    mockPrismaPost.findFirst
      .mockResolvedValueOnce({ id: 'recurring-1' }) // hasRecurring
      .mockResolvedValueOnce({ id: 'recurring-1' });
    mockPrismaPost.updateMany.mockResolvedValue({ count: 1 });

    await repo.deletePost('org-1', 'group-1');

    // PUBLISHED state should NOT be in the delete filter
    const updateCall = mockPrismaPost.updateMany.mock.calls[0][0];
    const stateFilter = updateCall.where.state;
    expect(stateFilter.in).not.toContain('PUBLISHED');
    expect(stateFilter.in).not.toContain('ERROR');
  });
});

// ---------------------------------------------------------------------------
// Tests: getPosts (calendar) — clone lookup via group
// ---------------------------------------------------------------------------

describe('PostsRepository.getPosts — calendar clone display', () => {
  let repo: any;
  let mockPrismaPost: any;

  beforeEach(() => {
    mockPrismaPost = {
      findMany: vi.fn(),
    };

    repo = new PostsRepository(
      { model: { post: mockPrismaPost } } as any,
    );
  });

  it('should fetch clones by group, not sourcePostId', async () => {
    const recurringOriginal = makeRecurringPost({
      id: 'orig-1',
      group: 'grp-1',
      publishDate: new Date('2026-04-10T10:00:00Z'),
    });

    // First call: main query (originals)
    mockPrismaPost.findMany
      .mockResolvedValueOnce([recurringOriginal])
      // Second call: clone lookup
      .mockResolvedValueOnce([
        {
          ...makePost({ id: 'clone-1', group: 'grp-1', state: 'PUBLISHED' }),
          publishDate: new Date('2026-04-01T10:00:00Z'),
          releaseId: 'tw-1',
          releaseURL: 'https://twitter.com/1',
        },
        {
          ...makePost({ id: 'clone-2', group: 'grp-1', state: 'PUBLISHED' }),
          publishDate: new Date('2026-04-02T10:00:00Z'),
          releaseId: 'tw-2',
          releaseURL: 'https://twitter.com/2',
        },
      ]);

    const query = {
      startDate: '2026-04-01',
      endDate: '2026-04-10',
    };

    const results = await repo.getPosts('org-1', query);

    // Clone query should use group, not sourcePostId
    const cloneQuery = mockPrismaPost.findMany.mock.calls[1][0];
    expect(cloneQuery.where.group).toEqual({ in: ['grp-1'] });
    expect(cloneQuery.where.sourcePostId).toBeUndefined();
    expect(cloneQuery.where.id).toEqual({ notIn: ['orig-1'] });

    // Results should include both clones
    const publishedResults = results.filter((r: any) => r.state === 'PUBLISHED');
    expect(publishedResults.length).toBe(2);
  });

  it('should show clones even when original is deleted (sourcePostId not needed)', async () => {
    // When original is deleted, main query won't return it.
    // But clones are now standalone posts (sourcePostId: null)
    // so they appear in the main query directly.
    const clone = makePost({
      id: 'clone-1',
      group: 'grp-1',
      state: 'PUBLISHED',
      sourcePostId: null, // standalone after our fix
      intervalInDays: null,
      publishDate: new Date('2026-04-01T10:00:00Z'),
    });

    mockPrismaPost.findMany
      .mockResolvedValueOnce([clone]); // main query returns clone as standalone

    const query = {
      startDate: '2026-04-01',
      endDate: '2026-04-10',
    };

    const results = await repo.getPosts('org-1', query);

    expect(results.length).toBe(1);
    expect(results[0].id).toBe('clone-1');
    expect(results[0].state).toBe('PUBLISHED');
  });
});

// ---------------------------------------------------------------------------
// Tests: advancePublishDate — catch-up logic
// ---------------------------------------------------------------------------

describe('PostsRepository.advancePublishDate', () => {
  let repo: any;
  let mockPrismaPost: any;

  beforeEach(() => {
    mockPrismaPost = {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    };

    repo = new PostsRepository(
      { model: { post: mockPrismaPost } } as any,
    );
  });

  it('should advance to next day for daily recurring', async () => {
    const current = new Date('2099-04-01T10:00:00Z'); // future date
    await repo.advancePublishDate('post-1', current, 1);

    const updateCall = mockPrismaPost.updateMany.mock.calls[0][0];
    const newDate = updateCall.data.publishDate;
    expect(newDate.getTime()).toBe(new Date('2099-04-02T10:00:00Z').getTime());
  });

  it('should skip past dates (catch-up)', async () => {
    const pastDate = new Date('2020-01-01T10:00:00Z');
    await repo.advancePublishDate('post-1', pastDate, 1);

    const updateCall = mockPrismaPost.updateMany.mock.calls[0][0];
    const newDate = updateCall.data.publishDate as Date;
    // Should be in the future, not 2020-01-02
    expect(newDate.getTime()).toBeGreaterThan(Date.now());
  });

  it('should use optimistic lock on publishDate', async () => {
    const current = new Date('2099-04-01T10:00:00Z');
    await repo.advancePublishDate('post-1', current, 1);

    const updateCall = mockPrismaPost.updateMany.mock.calls[0][0];
    expect(updateCall.where.id).toBe('post-1');
    expect(updateCall.where.publishDate).toEqual(current);
  });

  it('should return false when already advanced (optimistic lock fails)', async () => {
    mockPrismaPost.updateMany.mockResolvedValue({ count: 0 });

    const result = await repo.advancePublishDate('post-1', new Date(), 1);
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: End-to-end recurring cycle simulation
// ---------------------------------------------------------------------------

describe('Recurring post — full cycle simulation', () => {
  let mocks: ReturnType<typeof createServiceMocks>;
  let service: PostsService;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks = createServiceMocks();
    service = createService(mocks);
  });

  it('Day 1 SUCCESS → Day 2 SUCCESS → Day 3 ERROR → Day 4 SUCCESS', async () => {
    const post = makeRecurringPost({ intervalInDays: 1 });

    // Each cycle: finalize → advance → (workflow restarts via continueAsNew)
    mocks.postRepository.getPostById.mockResolvedValue(post);

    // Day 1: SUCCESS
    await service.finalizeRecurringCycle(
      'post-1', 'clone-d1', new Date('2026-04-01T10:00:00Z'),
      { state: 'PUBLISHED', releaseId: 'tw-1', releaseURL: 'url-1' }
    );
    expect(mocks.postRepository.finalizeCycleClone).toHaveBeenCalledTimes(1);
    expect(mocks.postRepository.advancePublishDate).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    mocks.postRepository.getPostById.mockResolvedValue(post);

    // Day 2: SUCCESS
    await service.finalizeRecurringCycle(
      'post-1', 'clone-d2', new Date('2026-04-02T10:00:00Z'),
      { state: 'PUBLISHED', releaseId: 'tw-2', releaseURL: 'url-2' }
    );
    expect(mocks.postRepository.advancePublishDate).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    mocks.postRepository.getPostById.mockResolvedValue(post);

    // Day 3: ERROR — still advances
    await service.finalizeRecurringCycle(
      'post-1', 'clone-d3', new Date('2026-04-03T10:00:00Z'),
      { state: 'ERROR', error: 'Rate limited' }
    );
    expect(mocks.postRepository.finalizeCycleClone).toHaveBeenCalledWith('clone-d3', {
      state: 'ERROR', error: 'Rate limited',
    });
    expect(mocks.postRepository.advancePublishDate).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    mocks.postRepository.getPostById.mockResolvedValue(post);

    // Day 4: SUCCESS — chain not broken
    await service.finalizeRecurringCycle(
      'post-1', 'clone-d4', new Date('2026-04-04T10:00:00Z'),
      { state: 'PUBLISHED', releaseId: 'tw-4', releaseURL: 'url-4' }
    );
    expect(mocks.postRepository.advancePublishDate).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: changeState — recurring post protection
// ---------------------------------------------------------------------------

describe('PostsService.changeState — recurring post protection', () => {
  let mocks: ReturnType<typeof createServiceMocks>;
  let service: PostsService;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks = createServiceMocks();
    service = createService(mocks);
  });

  it('should NOT set ERROR on recurring original post', async () => {
    const post = makeRecurringPost({ sourcePostId: null, parentPostId: null });
    mocks.postRepository.getPostById.mockResolvedValue(post);

    await service.changeState('post-1', 'ERROR' as any, 'some error');

    // Should log error but not change state
    expect(mocks.postRepository.logError).toHaveBeenCalled();
    expect(mocks.postRepository.changeState).not.toHaveBeenCalled();
  });

  it('should set ERROR on non-recurring post normally', async () => {
    const post = makePost(); // intervalInDays: null
    mocks.postRepository.getPostById.mockResolvedValue(post);
    mocks.postRepository.changeState.mockResolvedValue(undefined);

    await service.changeState('post-1', 'ERROR' as any, 'some error');

    expect(mocks.postRepository.changeState).toHaveBeenCalledWith('post-1', 'ERROR', 'some error', undefined);
  });

  // Regression: thread items (parentPostId != null) must NOT be protected by the
  // recurring-original guard — only the original (parentPostId=null, intervalInDays>0)
  // is protected. When a workflow calls markError for a thread item i>0, changeState
  // must actually update the DB record.
  it('should set ERROR on a recurring-group THREAD ITEM (parentPostId set)', async () => {
    const threadItem = makePost({
      id: 'thread-item-1',
      parentPostId: 'main-post-1',   // ← thread item
      intervalInDays: null,          // thread items never have intervalInDays
    });
    mocks.postRepository.getPostById.mockResolvedValue(threadItem);
    mocks.postRepository.changeState.mockResolvedValue(undefined);

    await service.changeState('thread-item-1', 'ERROR' as any, 'thread failed');

    // Must update, NOT no-op — the guard only applies to recurring originals
    expect(mocks.postRepository.changeState).toHaveBeenCalledWith(
      'thread-item-1', 'ERROR', 'thread failed', undefined
    );
  });

  it('should set PUBLISHED on a thread item via updatePost', async () => {
    // updatePost is called by the workflow for each successfully-posted item
    mocks.postRepository.updatePost.mockResolvedValue(undefined);

    await (mocks.postRepository as any).updatePost('thread-item-1', 'tw-999', 'https://x.com/status/999');

    expect(mocks.postRepository.updatePost).toHaveBeenCalledWith(
      'thread-item-1', 'tw-999', 'https://x.com/status/999'
    );
  });
});

// ---------------------------------------------------------------------------
// Regression: thread post failure — finalizeRecurringCycle must use PUBLISHED
// when the main post (i=0) succeeded before the thread item (i>0) failed.
// ---------------------------------------------------------------------------

describe('PostsService.finalizeRecurringCycle — thread failure uses PUBLISHED state', () => {
  let mocks: ReturnType<typeof createServiceMocks>;
  let service: PostsService;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks = createServiceMocks();
    service = createService(mocks);
  });

  it('records PUBLISHED for the cycle clone when main post succeeded (i>0 failed)', async () => {
    // Simulate: main post published tw-123, thread item failed.
    // The workflow calls finalizeCycle(errMsg) where i=1 → should use PUBLISHED.
    const recurringPost = makeRecurringPost();
    mocks.postRepository.getPostById.mockResolvedValue(recurringPost);

    // The workflow calls finalizeRecurringCycle with PUBLISHED + main post IDs
    await service.finalizeRecurringCycle(
      'post-1', 'clone-1', recurringPost.publishDate,
      {
        state: 'PUBLISHED',
        releaseId: 'tw-123',
        releaseURL: 'https://twitter.com/user/status/123',
      }
    );

    // clone must be stamped PUBLISHED, not ERROR
    expect(mocks.postRepository.finalizeCycleClone).toHaveBeenCalledWith('clone-1', {
      state: 'PUBLISHED',
      releaseId: 'tw-123',
      releaseURL: 'https://twitter.com/user/status/123',
    });
    // publishDate advances for the next cycle
    expect(mocks.postRepository.advancePublishDate).toHaveBeenCalled();
  });

  it('records ERROR for the cycle clone when main post failed (i=0 failed)', async () => {
    const recurringPost = makeRecurringPost();
    mocks.postRepository.getPostById.mockResolvedValue(recurringPost);

    await service.finalizeRecurringCycle(
      'post-1', 'clone-1', recurringPost.publishDate,
      { state: 'ERROR', error: 'Rate limit exceeded' }
    );

    expect(mocks.postRepository.finalizeCycleClone).toHaveBeenCalledWith('clone-1', {
      state: 'ERROR',
      error: 'Rate limit exceeded',
    });
    // Still advances — the next cycle must not be blocked by this failure
    expect(mocks.postRepository.advancePublishDate).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Regression: refreshNeeded/disabled paths must mark non-recurring posts ERROR.
// Before this fix, the workflow returned early without calling changeState,
// leaving posts stuck in QUEUE forever ("pending" state in the UI).
// ---------------------------------------------------------------------------

describe('PostsService.changeState — refreshNeeded / disabled early-exit', () => {
  let mocks: ReturnType<typeof createServiceMocks>;
  let service: PostsService;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks = createServiceMocks();
    service = createService(mocks);
  });

  it('marks non-recurring post ERROR when integration requires reconnection', async () => {
    const post = makePost({ refreshNeeded: true });
    mocks.postRepository.getPostById.mockResolvedValue(post);
    mocks.postRepository.changeState.mockResolvedValue(undefined);

    await service.changeState('post-1', 'ERROR' as any, 'Integration requires reconnection');

    expect(mocks.postRepository.changeState).toHaveBeenCalledWith(
      'post-1', 'ERROR', 'Integration requires reconnection', undefined
    );
  });

  it('marks non-recurring post ERROR when integration is disabled', async () => {
    const post = makePost({ disabled: true });
    mocks.postRepository.getPostById.mockResolvedValue(post);
    mocks.postRepository.changeState.mockResolvedValue(undefined);

    await service.changeState('post-1', 'ERROR' as any, 'Integration is disabled');

    expect(mocks.postRepository.changeState).toHaveBeenCalledWith(
      'post-1', 'ERROR', 'Integration is disabled', undefined
    );
  });

  it('does NOT mark recurring original ERROR (stays QUEUE for next cycle)', async () => {
    const post = makeRecurringPost({ parentPostId: null });
    mocks.postRepository.getPostById.mockResolvedValue(post);

    await service.changeState('post-1', 'ERROR' as any, 'Integration requires reconnection');

    expect(mocks.postRepository.changeState).not.toHaveBeenCalled();
    expect(mocks.postRepository.logError).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: markStaleQueuePostsAsError — stale QUEUE sweep
// ---------------------------------------------------------------------------

describe('PostsRepository.markStaleQueuePostsAsError', () => {
  let repo: any;
  let mockPrismaPost: any;

  beforeEach(() => {
    mockPrismaPost = {
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    };

    repo = new PostsRepository(
      { model: { post: mockPrismaPost } } as any,
    );
  });

  it('marks stale non-recurring QUEUE posts as ERROR', async () => {
    mockPrismaPost.updateMany.mockResolvedValue({ count: 3 });

    const count = await repo.markStaleQueuePostsAsError();

    expect(count).toBe(3);
    const call = mockPrismaPost.updateMany.mock.calls[0][0];
    expect(call.where.state).toBe('QUEUE');
    expect(call.where.intervalInDays).toBe(null);
    expect(call.where.parentPostId).toBe(null);
    expect(call.data.state).toBe('ERROR');
  });

  it('excludes recurring originals (intervalInDays set)', async () => {
    mockPrismaPost.updateMany.mockResolvedValue({ count: 0 });

    await repo.markStaleQueuePostsAsError();

    const call = mockPrismaPost.updateMany.mock.calls[0][0];
    // intervalInDays: null means only non-recurring posts are targeted
    expect(call.where.intervalInDays).toBe(null);
  });

  it('excludes thread children (parentPostId set)', async () => {
    mockPrismaPost.updateMany.mockResolvedValue({ count: 0 });

    await repo.markStaleQueuePostsAsError();

    const call = mockPrismaPost.updateMany.mock.calls[0][0];
    expect(call.where.parentPostId).toBe(null);
  });

  it('only targets posts older than 7 days', async () => {
    mockPrismaPost.updateMany.mockResolvedValue({ count: 0 });

    await repo.markStaleQueuePostsAsError();

    const call = mockPrismaPost.updateMany.mock.calls[0][0];
    const cutoff = call.where.publishDate.lt as Date;
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    // cutoff should be approximately 7 days ago (within 5 seconds)
    expect(Math.abs(cutoff.getTime() - sevenDaysAgo.getTime())).toBeLessThan(5000);
  });

  it('clears releaseId so stale claim tokens do not leak to clients', async () => {
    mockPrismaPost.updateMany.mockResolvedValue({ count: 0 });

    await repo.markStaleQueuePostsAsError();

    const call = mockPrismaPost.updateMany.mock.calls[0][0];
    expect(call.data.releaseId).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// Tests: changeState — claim-token cleanup on ERROR
// Regression: non-recurring posts hold a `claim_*` lock token in `releaseId`
// while publishing. If publish fails and the row flips to ERROR without
// clearing it, the token leaks via the calendar API (which selects releaseId).
// ---------------------------------------------------------------------------

describe('PostsRepository.changeState — claim-token cleanup', () => {
  let repo: any;
  let mockPrismaPost: any;
  let mockPrismaErrors: any;

  beforeEach(() => {
    mockPrismaPost = {
      update: vi.fn().mockResolvedValue({
        id: 'post-1',
        organizationId: 'org-1',
        integration: { providerIdentifier: 'x' },
      }),
    };
    mockPrismaErrors = { create: vi.fn() };

    repo = new PostsRepository(
      { model: { post: mockPrismaPost } } as any,
      { model: { popularPosts: {} } } as any,
      { model: { comments: {} } } as any,
      { model: { tags: {} } } as any,
      { model: { tagsPosts: {} } } as any,
      { model: { errors: mockPrismaErrors } } as any,
    );
  });

  it('clears releaseId when transitioning to ERROR (no body)', async () => {
    await repo.changeState('post-1', 'ERROR', '403 Forbidden');

    const call = mockPrismaPost.update.mock.calls[0][0];
    expect(call.where).toEqual({ id: 'post-1' });
    expect(call.data.state).toBe('ERROR');
    expect(call.data.releaseId).toBe(null);
    expect(call.data.error).toContain('403');
  });

  it('clears releaseId when transitioning to ERROR (with body → errors.create)', async () => {
    mockPrismaErrors.create.mockResolvedValue({});

    await repo.changeState('post-1', 'ERROR', '403 Forbidden', [{ id: 'post-1' }]);

    const call = mockPrismaPost.update.mock.calls[0][0];
    expect(call.data.state).toBe('ERROR');
    expect(call.data.releaseId).toBe(null);
    expect(mockPrismaErrors.create).toHaveBeenCalled();
  });

  it('does NOT touch releaseId on non-ERROR transitions (must not wipe real platform IDs)', async () => {
    await repo.changeState('post-1', 'PUBLISHED');

    const call = mockPrismaPost.update.mock.calls[0][0];
    expect(call.data.state).toBe('PUBLISHED');
    expect('releaseId' in call.data).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: createOrUpdatePost — multi-account group cleanup guard
// ---------------------------------------------------------------------------

describe('PostsRepository.createOrUpdatePost — group cleanup guard', () => {
  let repo: any;
  let mockPrismaPost: any;
  let mockTagsPosts: any;
  let mockTags: any;

  function makeUpsertResult(id: string) {
    return {
      id,
      organizationId: 'org-1',
      group: 'group-abc',
      state: 'QUEUE',
      publishDate: new Date('2026-04-01T10:00:00Z'),
      content: '<p>hello</p>',
      image: '[]',
      settings: '{"__type":"x"}',
      delay: 0,
      intervalInDays: null,
      parentPostId: null,
      releaseURL: null,
      releaseId: null,
    };
  }

  function makeBody(overrides?: { group?: string; valueId?: string }) {
    return {
      integration: { id: 'int-1' },
      group: overrides?.group,
      value: [
        {
          id: overrides?.valueId,
          content: '<p>hello</p>',
          image: [],
          delay: 0,
        },
      ],
      settings: { __type: 'x' },
    };
  }

  beforeEach(() => {
    mockPrismaPost = {
      findFirst: vi.fn().mockResolvedValue(null),
      upsert: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    };
    mockTagsPosts = {
      deleteMany: vi.fn().mockResolvedValue({}),
    };
    mockTags = {
      findMany: vi.fn().mockResolvedValue([]),
    };

    repo = new PostsRepository(
      { model: { post: mockPrismaPost } } as any,
      {} as any, // _popularPosts
      {} as any, // _comments
      { model: { tags: mockTags } } as any,
      { model: { tagsPosts: mockTagsPosts } } as any,
      {} as any, // _errors
    );
  });

  it('does NOT run group cleanup when creating new posts (no value.id)', async () => {
    mockPrismaPost.upsert.mockResolvedValue(makeUpsertResult('post-new-1'));

    await repo.createOrUpdatePost(
      'schedule',
      'org-1',
      '2026-04-01T10:00:00',
      makeBody({ group: 'group-abc' }), // group passed, but no value.id
      [],
    );

    expect(mockPrismaPost.updateMany).not.toHaveBeenCalled();
  });

  it('does NOT soft-delete a sibling post created earlier in the same group', async () => {
    // Simulate two sequential calls for two different integrations sharing the same group.
    // Call 1 creates post-A (no value.id).
    mockPrismaPost.upsert.mockResolvedValue(makeUpsertResult('post-A'));
    await repo.createOrUpdatePost(
      'schedule', 'org-1', '2026-04-01T10:00:00',
      makeBody({ group: 'group-abc' }),
      [],
    );

    vi.clearAllMocks();
    mockPrismaPost.findFirst.mockResolvedValue(null);
    mockPrismaPost.upsert.mockResolvedValue(makeUpsertResult('post-B'));

    // Call 2 creates post-B for a different integration in the same group.
    await repo.createOrUpdatePost(
      'schedule', 'org-1', '2026-04-01T10:00:00',
      makeBody({ group: 'group-abc' }),
      [],
    );

    // The cleanup updateMany must NOT have been called — post-A must survive.
    expect(mockPrismaPost.updateMany).not.toHaveBeenCalled();
  });

  it('DOES run group cleanup when editing an existing post (value.id present)', async () => {
    mockPrismaPost.upsert.mockResolvedValue(makeUpsertResult('post-existing'));

    await repo.createOrUpdatePost(
      'schedule',
      'org-1',
      '2026-04-01T10:00:00',
      makeBody({ group: 'group-abc', valueId: 'post-existing' }),
      [],
    );

    expect(mockPrismaPost.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          group: 'group-abc',
          id: { notIn: ['post-existing'] },
        }),
        data: expect.objectContaining({ deletedAt: expect.any(Date) }),
      }),
    );
  });
});
