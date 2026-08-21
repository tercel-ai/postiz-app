import { describe, expect, it, vi } from 'vitest';
import { PostsRepository } from '../posts.repository';

// The extension publish-due query and the DRAFT->QUEUE schedule write are the
// DB-side of the "QUEUE state is the single source of truth" refactor. These
// assert the query/write SHAPES (the repo is a thin Prisma wrapper).

function createRepo(model: Record<string, any>) {
  return new PostsRepository(
    { model: { post: model } } as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any
  );
}

describe('getDueExtensionPublishPosts', () => {
  it('returns explicit publishMethod=EXTENSION posts regardless of the env allowlist / integration', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const repo = createRepo({ findMany });

    // Empty providerIdentifiers (no env allowlist) must NOT suppress the query:
    // explicit-EXTENSION posts still have to be picked up.
    await repo.getDueExtensionPublishPosts('org-1', [], new Date(), 10);

    expect(findMany).toHaveBeenCalledTimes(1);
    const where = findMany.mock.calls[0][0].where;
    expect(where.state).toBe('QUEUE');
    expect(where.parentPostId).toBeNull();
    // Recurring originals (intervalInDays > 0) are excluded — they publish via
    // the Temporal-only clone-per-cycle path and would loop through the extension.
    expect(where.intervalInDays).toBeNull();
    // Only the explicit EXTENSION branch is present (no legacy integration branch).
    expect(where.OR).toEqual([{ publishMethod: 'EXTENSION' }]);
    // The EXTENSION branch carries NO integration constraint (operation-plan posts
    // route by settings.__type with a null integrationId).
    expect(where).not.toHaveProperty('integration');
  });

  it('excludes engage replies — the due-item shape has no reply target', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const repo = createRepo({ findMany });

    await repo.getDueExtensionPublishPosts('org-1', ['x', 'reddit'], new Date(), 10);

    // An engage reply offered to the extension would be published as a brand-NEW
    // post (X) or rejected forever for lacking a subreddit (Reddit). Replies are
    // stamped publishMethod=API at creation; this excludes legacy null-method rows.
    const where = findMany.mock.calls[0][0].where;
    expect(where.NOT).toEqual({ source: 'engage' });
  });

  it('adds the legacy publishMethod=null + extension-integration branch when providers are given', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const repo = createRepo({ findMany });

    await repo.getDueExtensionPublishPosts('org-1', ['hackernews', 'quora'], new Date(), 10);

    const where = findMany.mock.calls[0][0].where;
    expect(where.OR).toHaveLength(2);
    expect(where.OR[0]).toEqual({ publishMethod: 'EXTENSION' });
    expect(where.OR[1]).toEqual({
      publishMethod: null,
      integration: {
        providerIdentifier: { in: ['hackernews', 'quora'] },
        disabled: false,
        deletedAt: null,
      },
    });
  });
});

describe('claimDueExtensionPublishPosts (lease)', () => {
  it('leases due+available candidates with our token, then returns only rows we won', async () => {
    const now = new Date('2026-07-27T00:10:00.000Z');
    const cutoff = new Date('2026-07-27T00:00:00.000Z');
    const findMany = vi
      .fn()
      // 1st call: candidate id scan
      .mockResolvedValueOnce([{ id: 'p1' }, { id: 'p2' }])
      // 2nd call: read-back of rows carrying our token
      .mockResolvedValueOnce([{ id: 'p1', content: 'a', settings: '{}' }]);
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const repo = createRepo({ findMany, updateMany });

    const res = await repo.claimDueExtensionPublishPosts(
      'org-1',
      ['hackernews'],
      now,
      10,
      'ext_token_123',
      cutoff
    );

    // Candidate scan filters due (via the shared where) AND lease-availability.
    const candidateWhere = findMany.mock.calls[0][0].where;
    expect(candidateWhere.AND[1]).toEqual({
      OR: [{ releaseId: null }, { claimedAt: { lte: cutoff } }],
    });

    // The claim write stamps our token + claimedAt, guarded by availability so a
    // racing puller can't steal an already-leased row.
    const claim = updateMany.mock.calls[0][0];
    expect(claim.where).toEqual({
      id: { in: ['p1', 'p2'] },
      state: 'QUEUE',
      OR: [{ releaseId: null }, { claimedAt: { lte: cutoff } }],
    });
    expect(claim.data).toEqual({ releaseId: 'ext_token_123', claimedAt: now });

    // Read-back is scoped to OUR token — the rows we actually won.
    expect(findMany.mock.calls[1][0].where).toEqual({
      id: { in: ['p1', 'p2'] },
      releaseId: 'ext_token_123',
    });
    expect(res).toEqual([{ id: 'p1', content: 'a', settings: '{}' }]);
  });

  it('claims nothing (no update / no read-back) when there are no candidates', async () => {
    const findMany = vi.fn().mockResolvedValueOnce([]);
    const updateMany = vi.fn();
    const repo = createRepo({ findMany, updateMany });

    const res = await repo.claimDueExtensionPublishPosts(
      'org-1',
      [],
      new Date(),
      10,
      'ext_token',
      new Date()
    );

    expect(res).toEqual([]);
    expect(updateMany).not.toHaveBeenCalled();
    expect(findMany).toHaveBeenCalledTimes(1);
  });
});

describe('schedulePostGroupToQueue', () => {
  it('flips DRAFT->QUEUE for the whole group and stamps the send method', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 2 });
    const repo = createRepo({ updateMany });

    await repo.schedulePostGroupToQueue('org-1', 'plan-1:c1:x', 'EXTENSION');

    expect(updateMany).toHaveBeenCalledTimes(1);
    const arg = updateMany.mock.calls[0][0];
    // Group-scoped, DRAFT-only (never disturbs already-scheduled/published work).
    expect(arg.where).toEqual({
      organizationId: 'org-1',
      group: 'plan-1:c1:x',
      state: 'DRAFT',
      deletedAt: null,
    });
    expect(arg.data).toEqual({ state: 'QUEUE', publishMethod: 'EXTENSION' });
  });

  it('overrides publishDate group-wide when a new date is passed', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const repo = createRepo({ updateMany });
    const when = new Date('2026-08-01T09:00:00.000Z');

    await repo.schedulePostGroupToQueue('org-1', 'g1', 'API', when);

    expect(updateMany.mock.calls[0][0].data).toEqual({
      state: 'QUEUE',
      publishMethod: 'API',
      publishDate: when,
    });
  });

  it('leaves publishDate untouched when no date is passed', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const repo = createRepo({ updateMany });

    await repo.schedulePostGroupToQueue('org-1', 'g1', 'EXTENSION');

    expect(updateMany.mock.calls[0][0].data).not.toHaveProperty('publishDate');
  });
});

describe('markStaleQueuePostsAsError — never sweeps what waits for a browser', () => {
  it('excludes explicit EXTENSION and legacy null-method extension-integration posts', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 3 });
    const repo = createRepo({ updateMany });

    await repo.markStaleQueuePostsAsError(['hackernews', 'quora']);

    const where = updateMany.mock.calls[0][0].where;
    expect(where.state).toBe('QUEUE');
    expect(where.NOT).toEqual({
      OR: [
        { publishMethod: 'EXTENSION' },
        {
          publishMethod: null,
          integration: { providerIdentifier: { in: ['hackernews', 'quora'] } },
        },
        // Engage replies match NEITHER routing branch — no publishMethod, no
        // integration — so they need naming separately. They are drained by
        // reply-due, another pull executor waiting on the same browser.
        { source: 'engage' },
      ],
    });
  });

  it('excludes only explicit EXTENSION when no provider list is passed', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const repo = createRepo({ updateMany });

    await repo.markStaleQueuePostsAsError();

    expect(updateMany.mock.calls[0][0].where.NOT).toEqual({
      OR: [{ publishMethod: 'EXTENSION' }, { source: 'engage' }],
    });
  });
});

describe('findStuckQueuePosts — excludes extension posts (keeps legacy null rows)', () => {
  it('adds NOT { publishMethod: EXTENSION } (not a nullable `not` that would drop null rows)', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const repo = createRepo({ findMany });

    await repo.findStuckQueuePosts(new Date());

    expect(findMany.mock.calls[0][0].where.NOT).toEqual({ publishMethod: 'EXTENSION' });
  });
});

describe('getSchedulablePostsByIds', () => {
  it('loads only org-owned, non-deleted ROOT posts with the fields the resolver needs', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const repo = createRepo({ findMany });

    await repo.getSchedulablePostsByIds('org-1', ['p1', 'p2']);

    const arg = findMany.mock.calls[0][0];
    expect(arg.where).toEqual({
      id: { in: ['p1', 'p2'] },
      organizationId: 'org-1',
      deletedAt: null,
      parentPostId: null,
    });
    expect(arg.select).toMatchObject({
      group: true,
      state: true,
      integrationId: true,
      settings: true,
    });
  });

  it('short-circuits on an empty id list (no query)', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const repo = createRepo({ findMany });

    const res = await repo.getSchedulablePostsByIds('org-1', []);

    expect(res).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
});

// Post.title used to be written ONLY by the operation-plan materializer, so
// every post created through the API landed with title=null and its headline
// reachable only inside settings — the shape of which is per-platform. That is
// what made the extension reject Reddit posts as "reddit post needs a title"
// forever (a rejected item never leaves QUEUE, so it is re-offered each poll).
describe('createOrUpdatePost — Post.title persistence', () => {
  function repoWithUpsert() {
    const upsert = vi.fn().mockImplementation(async ({ create }) => ({
      id: create?.id ?? 'post-1',
    }));
    // createOrUpdatePost also clears tag links, so this needs the tagsPosts
    // repo rather than the bare post model createRepo() provides.
    const repo = new PostsRepository(
      { model: { post: { upsert } } } as any,
      {} as any,
      {} as any,
      {} as any,
      { model: { tagsPosts: { deleteMany: vi.fn(), create: vi.fn() } } } as any,
      {} as any
    );
    return { repo, upsert };
  }

  function body(settings: Record<string, any>, providerIdentifier?: string) {
    return {
      value: [{ content: 'body text', id: 'post-1' }],
      settings,
      ...(providerIdentifier ? { providerIdentifier } : {}),
    } as any;
  }

  it('persists the reddit title from settings.subreddit[0].value', async () => {
    const { repo, upsert } = repoWithUpsert();

    await repo.createOrUpdatePost(
      'schedule',
      'org-1',
      '2030-01-01T00:00:00.000Z',
      body({
        __type: 'reddit',
        subreddit: [{ value: { subreddit: 'football', title: 'Tactical Deep-Dive' } }],
      }),
      []
    );

    expect(upsert.mock.calls[0][0].create.title).toBe('Tactical Deep-Dive');
    // Written on update too, so an edited settings title doesn't leave a stale
    // Post.title behind.
    expect(upsert.mock.calls[0][0].update.title).toBe('Tactical Deep-Dive');
  });

  it('persists a top-level settings title for the article platforms', async () => {
    const { repo, upsert } = repoWithUpsert();

    await repo.createOrUpdatePost(
      'schedule',
      'org-1',
      '2030-01-01T00:00:00.000Z',
      body({ __type: 'devto', title: 'My dev.to article' }),
      []
    );

    expect(upsert.mock.calls[0][0].create.title).toBe('My dev.to article');
  });

  it('writes null (not undefined) when the platform carries no title', async () => {
    const { repo, upsert } = repoWithUpsert();

    await repo.createOrUpdatePost(
      'schedule',
      'org-1',
      '2030-01-01T00:00:00.000Z',
      body({ __type: 'x' }),
      []
    );

    expect(upsert.mock.calls[0][0].create.title).toBeNull();
  });

  it('resolves the platform from providerIdentifier when settings has no __type', async () => {
    const { repo, upsert } = repoWithUpsert();

    await repo.createOrUpdatePost(
      'schedule',
      'org-1',
      '2030-01-01T00:00:00.000Z',
      body(
        { subreddit: [{ value: { subreddit: 'football', title: 'From providerIdentifier' } }] },
        'reddit'
      ),
      []
    );

    expect(upsert.mock.calls[0][0].create.title).toBe('From providerIdentifier');
  });
});
