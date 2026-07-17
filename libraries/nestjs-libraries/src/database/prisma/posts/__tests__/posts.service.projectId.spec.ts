import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PostsService } from '../posts.service';

// ---------------------------------------------------------------------------
// projectId threading: PostsService must pass body.projectId /
// the projectId param straight through to PostsRepository, same as orgId,
// without inventing or dropping it (project-scoped-post-engage-design.md §8).
// ---------------------------------------------------------------------------

function createMocks() {
  return {
    postRepository: {
      createOrUpdatePost: vi.fn().mockResolvedValue({
        posts: [{ id: 'post-1', state: 'QUEUE' }],
      }),
      // getPostsRecursively/getPost crash on an empty result (pre-existing,
      // unrelated behavior — not this test's concern), so resolve a full
      // post row here to isolate the projectId-forwarding assertion below.
      getPost: vi.fn().mockResolvedValue({
        id: 'post-1',
        group: 'group-1',
        image: '[]',
        settings: '{}',
        integrationId: 'int-1',
        integration: { picture: null },
        childrenPost: [],
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
    mocks.postOverageService as any
  );
  (svc as any).startWorkflow = vi.fn().mockResolvedValue(undefined);
  return svc;
}

function makeBody(overrides?: Partial<{ projectId: string }>) {
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

describe('PostsService projectId threading', () => {
  let mocks: ReturnType<typeof createMocks>;
  let service: PostsService;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks = createMocks();
    service = createService(mocks);
  });

  it('createPost forwards body.projectId to PostsRepository.createOrUpdatePost', async () => {
    await service.createPost('org-1', makeBody({ projectId: 'proj-1' }), 'user-1');

    expect(mocks.postRepository.createOrUpdatePost).toHaveBeenCalledWith(
      'schedule',
      'org-1',
      expect.any(String),
      expect.any(Object),
      [],
      undefined,
      undefined,
      'proj-1'
    );
  });

  it('createPost forwards undefined projectId for a legacy, non-project post', async () => {
    await service.createPost('org-1', makeBody(), 'user-1');

    expect(mocks.postRepository.createOrUpdatePost).toHaveBeenCalledWith(
      'schedule',
      'org-1',
      expect.any(String),
      expect.any(Object),
      [],
      undefined,
      undefined,
      undefined
    );
  });

  it('getPost forwards projectId down to PostsRepository.getPost', async () => {
    await service.getPost('org-1', 'post-1', false, 'proj-1');

    expect(mocks.postRepository.getPost).toHaveBeenCalledWith(
      'post-1',
      true,
      'org-1',
      true,
      'proj-1'
    );
  });
});
