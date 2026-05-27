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
  const stateUpsert = vi.fn();
  stateUpsert.mockResolvedValue({});

  const opportunity = { model: { engageOpportunity: { upsert: oppUpsert } } } as any;
  const oppState = { model: { engageOpportunityState: { upsert: stateUpsert } } } as any;

  const activity = new EngageScanActivity(
    {} as any, {} as any, {} as any,
    opportunity,   // _opportunity
    oppState,      // _oppState
    {} as any, {} as any, {} as any, {} as any
  );
  return { activity, oppUpsert, stateUpsert };
}

describe('EngageScanActivity._persistOpportunities', () => {
  it('upserts global post by [platform, externalPostId] without per-org columns', async () => {
    const { activity, oppUpsert } = buildActivity();
    await (activity as any)._persistOpportunities('org1', [makeScoredPost(1)]);

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
    const { activity, stateUpsert } = buildActivity();
    await (activity as any)._persistOpportunities('org1', [makeScoredPost(1)]);

    expect(stateUpsert).toHaveBeenCalledTimes(1);
    const arg = stateUpsert.mock.calls[0][0];
    expect(arg.where).toEqual({
      organizationId_opportunityId: { organizationId: 'org1', opportunityId: 'opp_ext_1' },
    });
    expect(arg.create.status).toBe('NEW');
    expect(arg.create.score).toBe(70);
    // The update branch must NOT reset status/bookmarked — re-scan would otherwise
    // silently undo a user's dismiss/bookmark.
    expect(arg.update).not.toHaveProperty('status');
    expect(arg.update).not.toHaveProperty('bookmarked');
    expect(arg.update.score).toBe(70);
  });

  it('keeps state.opportunityId aligned with its post across the chunk boundary', async () => {
    const { activity, stateUpsert } = buildActivity();
    // 27 posts > PERSIST_BATCH_SIZE (25) → spans two chunks; alignment must hold.
    const posts = Array.from({ length: 27 }, (_, i) => makeScoredPost(i));
    await (activity as any)._persistOpportunities('org1', posts);

    expect(stateUpsert).toHaveBeenCalledTimes(27);
    for (const [{ where }] of stateUpsert.mock.calls) {
      // opportunityId is opp_<externalPostId>; the post index is encoded in both.
      const oppId = where.organizationId_opportunityId.opportunityId as string;
      expect(oppId).toMatch(/^opp_ext_\d+$/);
    }
    // Spot-check the row that lives in the SECOND chunk (index 26).
    const last = stateUpsert.mock.calls[26][0];
    expect(last.where.organizationId_opportunityId.opportunityId).toBe('opp_ext_26');
  });

  it('is a no-op for an empty post list', async () => {
    const { activity, oppUpsert, stateUpsert } = buildActivity();
    await (activity as any)._persistOpportunities('org1', []);
    expect(oppUpsert).not.toHaveBeenCalled();
    expect(stateUpsert).not.toHaveBeenCalled();
  });
});
