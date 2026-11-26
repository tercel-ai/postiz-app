import { describe, it, expect, vi } from 'vitest';
import { EngageRepository } from '../engage.repository';

// The persistence half of the Reddit channel-capability cache. These are
// regression tests for two defects found in review, both of which lived here
// precisely because this layer had no tests: the read used to be cross-tenant,
// and the read used to throw on a missing subreddit.
//
function buildRepo(engageTrackedAccount: any, post = { findMany: vi.fn(async () => []), updateMany: vi.fn() }) {
  const db = { engageTrackedAccount, post };
  return new EngageRepository(
    {} as any,
    {} as any,
    { model: { engageTrackedAccount } } as any, {} as any, {} as any, {} as any, {} as any,
        {} as any,   // _integrationProject,
    { model: db } as any,
    { model: { $transaction: (work: (tx: typeof db) => unknown) => work(db) } } as any,
    {} as any, {} as any
  );
}

const FLAIRS = [{ label: '📰News' }, { label: 'Redditch United' }];

describe('EngageRepository.getRedditChannelCapability', () => {
  // The defect: the query carried no organizationId and fell back to
  // `rows[0]` — the freshest row from ANY org. Because a Tier-2 subreddit has
  // no own row until AFTER resolution, that made the poisoned path the DEFAULT
  // path for newly discovered communities: org A could seed a one-element
  // flair list and make org B's generated posts drop their own flair label.
  it('queries only this org and never another tenant', async () => {
    const findFirst = vi.fn(async () => null);
    const repo = buildRepo({ findFirst });

    await repo.getRedditChannelCapability('org-b', 'programming');

    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(findFirst.mock.calls[0][0].where).toEqual({
      organizationId: 'org-b',
      platform: 'reddit',
      username: 'programming',
    });
  });

  it('returns the capability record from this org own row', async () => {
    const findFirst = vi.fn(async () => ({
      metadata: { avatar: 'a.png', reddit: { flairs: FLAIRS, flairRequired: true } },
    }));
    const repo = buildRepo({ findFirst });

    expect(await repo.getRedditChannelCapability('org-a', 'r/Programming/')).toEqual({
      flairs: FLAIRS,
      flairRequired: true,
    });
    // The stored scan key is normalized, so the r/ prefix and casing must not
    // reach the query or the row would never be found.
    expect(findFirst.mock.calls[0][0].where.username).toBe('programming');
  });

  // A subreddit this org has never published to must degrade to "unknown", NOT
  // borrow another tenant's observation — resolveRedditTargets then passes the
  // generated label through unverified, which is the pre-feature behavior.
  it('returns an empty record when this org holds no row', async () => {
    const repo = buildRepo({ findFirst: vi.fn(async () => null) });
    expect(await repo.getRedditChannelCapability('org-b', 'programming')).toEqual({});
  });

  // The guard used to sit AFTER normalizeUsername, which dereferences its
  // argument, so a GET with no `subreddit` query param produced a TypeError
  // (HTTP 500) instead of an empty record.
  it('returns an empty record instead of throwing on a missing subreddit', async () => {
    const findFirst = vi.fn(async () => null);
    const repo = buildRepo({ findFirst });

    for (const bad of [undefined, null, '', '   ']) {
      await expect(
        repo.getRedditChannelCapability('org-a', bad as any)
      ).resolves.toEqual({});
    }
    expect(findFirst).not.toHaveBeenCalled();
  });

  // normalizeUsername canonicalises but does NOT validate the charset (that
  // guard lives at the add boundary, buildScanTargetKey). A malformed name is
  // therefore queried rather than rejected — which is safe: Prisma parameterises
  // the predicate, so the only outcome is that nothing matches.
  it('queries — and matches nothing — for a malformed subreddit name', async () => {
    const findFirst = vi.fn(async () => null);
    const repo = buildRepo({ findFirst });

    expect(
      await repo.getRedditChannelCapability('org-a', 'not a subreddit!')
    ).toEqual({});
    expect(findFirst.mock.calls[0][0].where.username).toBe('not a subreddit!');
  });
});

describe('EngageRepository.recordRedditChannelCapability', () => {
  it('writes every row THIS org holds for the subreddit, and no other org', async () => {
    const findMany = vi.fn(async () => [
      { id: 'row-1', metadata: { avatar: 'a.png' } },
      { id: 'row-2', metadata: null },
    ]);
    const update = vi.fn(async () => ({}));
    const repo = buildRepo({ findMany, update });

    const res = await repo.recordRedditChannelCapability('org-a', 'r/Programming', {
      flairs: FLAIRS,
      flairRequired: true,
      source: 'extension',
    });

    expect(res).toEqual({ updated: 2 });
    expect(findMany.mock.calls[0][0].where).toEqual({
      organizationId: 'org-a',
      platform: 'reddit',
      username: 'programming',
    });
    expect(update).toHaveBeenCalledTimes(2);
    // Unrelated metadata keys survive the merge; the capability lands under
    // its own sub-object.
    const first = update.mock.calls[0][0].data.metadata as any;
    expect(first.avatar).toBe('a.png');
    expect(first.reddit.flairs).toEqual(FLAIRS);
    expect(first.reddit.flairRequired).toBe(true);
    expect(typeof first.reddit.observedAt).toBe('string');
  });

  it('restages only unselected plan drafts for the changed community, including their thread', async () => {
    const target = (subreddit: string, extra = {}) => JSON.stringify({ subreddit: [{ value: {
      subreddit, title: 'Saved title', flairRequired: true, ...extra,
    } }] });
    const root = (id: string, settings: string, overrides = {}) => ({
      id, group: id, operationPlanId: 'plan', projectId: 'project', state: 'DRAFT', providerIdentifier: 'reddit',
      claimedAt: null, sendIntentId: null, releaseId: null, releaseURL: null, settings,
      parentPostId: null, updatedAt: new Date('2026-11-25'), ...overrides,
    });
    const empty = root('empty', target('programming'));
    const rows = [
      empty,
      root('child', target('programming', { title: 'Saved second title' }), { parentPostId: empty.id, group: empty.group }),
      root('selected-label', target('programming', { flairLabel: '📰News' })),
      root('selected-id', target('programming', { flair: { id: 'reddit-template' } })),
      root('different-community', target('opensource')),
      root('manual', target('programming'), { operationPlanId: null }),
      root('claimed', target('programming'), { claimedAt: new Date() }),
      root('already-admitted', target('programming'), { sendIntentId: 'intent' }),
      root('queued', target('programming'), { state: 'QUEUE' }),
    ];
    const post = {
      findMany: vi.fn(async ({ where }) => where.group
        ? rows.filter(row => row.group === where.group)
        : rows.filter(row => !row.parentPostId && row.operationPlanId !== null)),
      updateMany: vi.fn(async (_args) => ({ count: 1 })),
    };
    const repo = buildRepo({
      findMany: vi.fn(async () => [{ id: 'row-1', metadata: { reddit: { flairs: [FLAIRS[0]] } } }]),
      update: vi.fn(async () => ({})),
    }, post as any);

    await expect(repo.recordRedditChannelCapability('org-a', 'r/Programming', { flairs: FLAIRS }))
      .resolves.toEqual({ updated: 1 });
    expect(post.findMany.mock.calls[0][0].where).toMatchObject({
      organizationId: 'org-a', state: 'DRAFT', deletedAt: null, sendIntentId: null, parentPostId: null,
      operationPlanId: { not: null }, projectId: { not: null },
    });
    const writes = post.updateMany.mock.calls.map(([args]) => args);
    expect(writes.map(write => write.where.id)).toEqual(['empty', 'child']);
    for (const write of writes) {
      expect(write.where).toMatchObject({ organizationId: 'org-a', state: 'DRAFT', sendIntentId: null });
      expect(write.data).not.toHaveProperty('state');
      expect(JSON.parse(write.data.settings).redditTargetPending).toMatchObject({
        reason: 'flair-pending', candidate: 'programming', flairRequired: true, selectFlair: true,
      });
    }
    expect(JSON.parse(writes[1].data.settings).subreddit[0].value.title).toBe('Saved second title');
  });

  it.each([[FLAIRS], [[...FLAIRS].reverse()], [undefined]])('does not reconsider drafts when the reported set is unchanged (%j)', async (flairs) => {
    const post = { findMany: vi.fn(), updateMany: vi.fn() };
    const repo = buildRepo({
      findMany: vi.fn(async () => [{ id: 'row-1', metadata: { reddit: { flairs: FLAIRS } } }]),
      update: vi.fn(async () => ({})),
    }, post);
    await repo.recordRedditChannelCapability('org-a', 'programming', { flairs, flairRequired: true });
    expect(post.findMany).not.toHaveBeenCalled();
    expect(post.updateMany).not.toHaveBeenCalled();
  });

  // The capability record is a cache attached to a monitoring relationship, not
  // an entity of its own — creating a row to hold it would silently add a scan
  // target nobody asked for. The extension reports after every publish and
  // cannot know whether this org monitors the community it just posted to.
  it('is a no-op when this org monitors no matching row', async () => {
    const findMany = vi.fn(async () => []);
    const update = vi.fn(async () => ({}));
    const create = vi.fn(async () => ({}));
    const repo = buildRepo({ findMany, update, create });

    expect(
      await repo.recordRedditChannelCapability('org-a', 'programming', { flairs: FLAIRS })
    ).toEqual({ updated: 0 });
    expect(update).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  // isEmptyRedditCapability short-circuits before the query: the extension
  // reports after EVERY publish attempt and most observe nothing new, so a
  // no-op patch must not cost a round trip.
  it('skips the query entirely for an empty patch or a blank subreddit', async () => {
    const findMany = vi.fn(async () => []);
    const repo = buildRepo({ findMany, update: vi.fn() });

    expect(
      await repo.recordRedditChannelCapability('org-a', 'programming', {})
    ).toEqual({ updated: 0 });
    expect(
      await repo.recordRedditChannelCapability('org-a', '   ', { flairs: FLAIRS })
    ).toEqual({ updated: 0 });
    expect(findMany).not.toHaveBeenCalled();
  });

  // A publish that never hit a rule proves nothing about whether one exists, so
  // an omitted boolean must not clear what a real rejection taught us.
  it('does not clear a stored flairRequired when the patch omits it', async () => {
    const update = vi.fn(async () => ({}));
    const repo = buildRepo({
      findMany: vi.fn(async () => [
        { id: 'row-1', metadata: { reddit: { flairRequired: true } } },
      ]),
      update,
    });

    await repo.recordRedditChannelCapability('org-a', 'programming', { flairs: FLAIRS });

    const written = update.mock.calls[0][0].data.metadata as any;
    expect(written.reddit.flairRequired).toBe(true);
    expect(written.reddit.flairs).toEqual(FLAIRS);
  });
});
