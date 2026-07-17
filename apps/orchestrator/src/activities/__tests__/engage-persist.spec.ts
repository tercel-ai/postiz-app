/**
 * Unit tests for EngageScanActivity._persistOpportunities — the two-phase
 * (global post + per-org state) upsert introduced by the EngageOpportunity
 * global/per-org split. Prisma is mocked; no DB or network.
 *
 * Guards (review W2/W4):
 *  - phase 1 upserts the global post by [platform, externalPostId]
 *  - phase 2 upserts per-org state by [organizationId, opportunityId]
 *  - state.opportunityId aligns with the phase-1 row for the SAME post, even
 *    across the PERSIST_BATCH_SIZE chunk boundary
 *  - the update branches preserve user state (no status/bookmarked, no intentTags)
 */
import { describe, it, expect, vi } from 'vitest';
import { EngageScanActivity } from '../engage-scan.activity';
import type { ScoredPost } from '@gitroom/nestjs-libraries/engage/engage-scorer';

function makeScoredPost(n: number): ScoredPost {
  return {
    id: `reddit_${n}`,
    platform: 'reddit',
    externalPostId: `ext_${n}`,
    externalPostUrl: `https://www.reddit.com/r/x/comments/ext_${n}/`,
    channelId: 'x',
    channelName: 'r/x',
    authorUsername: `u${n}`,
    postContent: `post ${n}`,
    postPublishedAt: new Date('2026-01-01T00:00:00Z'),
    metricLikes: 0,
    metricReplies: 0,
    metricRetweets: 0,
    metricQuotes: 0,
    metricBookmarks: 0,
    metricViews: 0,
    metricShares: 0,
    metricSaves: 0,
    metricScore: 10,
    metricUpvoteRatio: 0.9,
    metricComments: 3,
    score: 70,
    scoreKeyword: 30,
    matchedKeywords: ['react', 'nextjs'],
    scoreHeat: 18,
    scoreAuthority: 8,
    scoreRecency: 4,
    scoreTracked: 0,
    intentTags: ['support'],
    primaryIntent: 'support',
    intentScore: 0.8,
  };
}

function buildActivity() {
  // Phase-1 upsert returns an id derived from the post's externalPostId so we
  // can assert phase-2 alignment without depending on call ordering.
  // Untyped vi.fn() keeps `.mock.calls` as any[] for terse assertions.
  const oppUpsert = vi.fn();
  oppUpsert.mockImplementation(async (args: any) => ({
    id: `opp_${args.where.platform_externalPostId.externalPostId}`,
  }));
  const oppFindFirst = vi.fn();
  oppFindFirst.mockResolvedValue(null);
  const oppUpdate = vi.fn();
  oppUpdate.mockImplementation(async (args: any) => ({ id: args.where.id }));
  // projectId is null in every test below (the legacy, pre-project config) —
  // a nullable column can't back a compound-unique upsert (Postgres NULL !=
  // NULL), so state writes go through findFirst + create, not upsert.
  const stateFindFirst = vi.fn();
  stateFindFirst.mockResolvedValue(null);
  const stateCreate = vi.fn();
  stateCreate.mockImplementation(async (args: any) => ({ id: 'new-state-id', ...args.data }));
  const stateUpdate = vi.fn();
  stateUpdate.mockImplementation(async (args: any) => ({ id: args.where.id }));
  const stateUpsert = vi.fn();
  stateUpsert.mockResolvedValue({});

  const opportunity = {
    model: {
      engageOpportunity: {
        findFirst: oppFindFirst,
        upsert: oppUpsert,
        update: oppUpdate,
      },
    },
  } as any;
  const oppState = {
    model: {
      engageOpportunityState: {
        findFirst: stateFindFirst,
        create: stateCreate,
        update: stateUpdate,
        upsert: stateUpsert,
      },
    },
  } as any;

  const activity = new EngageScanActivity(
    {} as any, {} as any, {} as any,
    opportunity,   // _opportunity
    oppState,      // _oppState
    {} as any, {} as any, {} as any, {} as any,
    {} as any,     // _scanCursor (unused by _persistOpportunities)
    {} as any
  );
  return { activity, oppFindFirst, oppUpsert, oppUpdate, stateFindFirst, stateCreate, stateUpdate, stateUpsert };
}

describe('EngageScanActivity._persistOpportunities', () => {
  it('upserts global post by [platform, externalPostId] without per-org columns', async () => {
    const { activity, oppUpsert } = buildActivity();
    await (activity as any)._persistOpportunities('org1', null, [makeScoredPost(1)]);

    expect(oppUpsert).toHaveBeenCalledTimes(1);
    const arg = oppUpsert.mock.calls[0][0];
    expect(arg.where).toEqual({
      platform_externalPostId: { platform: 'reddit', externalPostId: 'ext_1' },
    });
    // Global row must NOT carry per-org columns (those live on the state table).
    expect(arg.create).not.toHaveProperty('organizationId');
    expect(arg.create).not.toHaveProperty('status');
    expect(arg.create).not.toHaveProperty('bookmarked');
    expect(arg.create).not.toHaveProperty('scoreKeyword');
    // Objective scores DO live on the global row.
    expect(arg.create.scoreHeat).toBe(18);
    // Re-scan update must not clobber the original intent classification.
    expect(arg.update).not.toHaveProperty('intentTags');
    expect(arg.update).not.toHaveProperty('primaryIntent');
  });

  it('upserts per-org state with NEW on create and preserves user state on update', async () => {
    const { activity, stateFindFirst, stateCreate } = buildActivity();
    await (activity as any)._persistOpportunities('org1', null, [makeScoredPost(1)]);

    expect(stateFindFirst).toHaveBeenCalledWith({
      where: { organizationId: 'org1', projectId: null, opportunityId: 'opp_ext_1' },
      select: { id: true },
    });
    expect(stateCreate).toHaveBeenCalledTimes(1);
    const arg = stateCreate.mock.calls[0][0].data;
    expect(arg.status).toBe('NEW');
    expect(arg.score).toBe(70);
    // Matched keywords (per-project) are written on create.
    expect(arg.matchedKeywords).toEqual(['react', 'nextjs']);
    expect(arg.isCurrentlyMatched).toBe(true);
  });

  it('preserves user state (no status/bookmarked reset) when the state row already exists', async () => {
    const { activity, stateFindFirst, stateUpdate } = buildActivity();
    stateFindFirst.mockResolvedValueOnce({ id: 'existing-state-id' });
    await (activity as any)._persistOpportunities('org1', null, [makeScoredPost(1)]);

    expect(stateUpdate).toHaveBeenCalledTimes(1);
    const arg = stateUpdate.mock.calls[0][0];
    expect(arg.where).toEqual({ id: 'existing-state-id' });
    // Re-scan update must NOT reset status/bookmarked — otherwise it would
    // silently undo a user's dismiss/bookmark.
    expect(arg.data).not.toHaveProperty('status');
    expect(arg.data).not.toHaveProperty('bookmarked');
    expect(arg.data.matchedKeywords).toEqual(['react', 'nextjs']);
    expect(arg.data.score).toBe(70);
  });

  it('keeps state.opportunityId aligned with its post across the chunk boundary', async () => {
    const { activity, stateCreate } = buildActivity();
    // 27 posts > PERSIST_BATCH_SIZE (25) → spans two chunks; alignment must hold.
    const posts = Array.from({ length: 27 }, (_, i) => makeScoredPost(i));
    await (activity as any)._persistOpportunities('org1', null, posts);

    expect(stateCreate).toHaveBeenCalledTimes(27);
    for (const [{ data }] of stateCreate.mock.calls) {
      // opportunityId is opp_<externalPostId>; the post index is encoded in both.
      expect(data.opportunityId as string).toMatch(/^opp_ext_\d+$/);
    }
    // Spot-check the row that lives in the SECOND chunk (index 26).
    const last = stateCreate.mock.calls[26][0];
    expect(last.data.opportunityId).toBe('opp_ext_26');
  });

  it('is a no-op for an empty post list', async () => {
    const { activity, oppUpsert, stateCreate } = buildActivity();
    await (activity as any)._persistOpportunities('org1', null, []);
    expect(oppUpsert).not.toHaveBeenCalled();
    expect(stateCreate).not.toHaveBeenCalled();
  });
});
