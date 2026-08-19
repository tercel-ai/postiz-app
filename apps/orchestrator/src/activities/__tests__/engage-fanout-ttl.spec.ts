/**
 * The TTL gate on the WORKFLOW fan-out path (EngageScanActivity._fanOutToOrg).
 *
 * This path does not go through EngageScanIngestService.ingestForOrg, so it
 * needs its own gate. persistOpportunities would refuse the write either way,
 * but only gating here prevents the three costs of carrying an expired post
 * that far: an LLM intent-classification call, an inflated 'persisted' score
 * distribution, and keyword hit counts credited to a post that never became an
 * opportunity.
 */
import { describe, it, expect, vi } from 'vitest';
import { EngageScanActivity } from '../engage-scan.activity';

const DAY = 86_400_000;

// Strong metrics on purpose: recency contributes at most 5 of the ~100-point
// total, so the fresh and expired fixtures below differ ONLY in whether the TTL
// gate fires — not in whether they clear MIN_SCORE.
function rawPost(publishedAt: Date): any {
  return {
    id: 'r1',
    platform: 'reddit',
    externalPostId: 't3_1',
    externalPostUrl: 'https://reddit.com/1',
    authorUsername: 'u1',
    postContent: 'I love react and nextjs',
    postPublishedAt: publishedAt,
    channelId: 'webdev',
    channelFollowers: 2_000_000,
    metricLikes: 0, metricReplies: 0, metricRetweets: 0, metricQuotes: 0,
    metricScore: 5000, metricComments: 500,
  };
}

const ctx: any = {
  organizationId: 'org1',
  projectId: null,
  keywords: [{ id: 'k1', keyword: 'react', type: 'GLOBAL', enabled: true }],
  trackedAccounts: [],
  monitoredChannels: [],
};

function build() {
  const ingest = {
    recordScoreDistribution: vi.fn(),
    classifyIntents: vi.fn(async (p: any[]) => p),
    persistOpportunities: vi.fn(async () => undefined),
    updateKeywordHitCounts: vi.fn(async () => undefined),
    // Real per-platform semantics, stubbed cheaply: reddit TTL = 7 days.
    filterExpiredByPublishTime: vi.fn(async (posts: any[]) => {
      const cutoff = Date.now() - 7 * DAY;
      const kept = posts.filter(
        (p) => new Date(p.postPublishedAt).getTime() >= cutoff
      );
      return { kept, dropped: posts.length - kept.length };
    }),
  };
  const activity = new EngageScanActivity(
    {} as any, {} as any, {} as any, {} as any, {} as any,
    {} as any, {} as any, {} as any, {} as any, {} as any, {} as any
  );
  // Pre-seed the lazily-built shared pipeline so the fan-out uses this fake.
  (activity as any)._ingestService = ingest;
  return { activity, ingest };
}

describe('EngageScanActivity._fanOutToOrg — TTL gate', () => {
  it('drops an expired post before classification, telemetry and hit counts', async () => {
    const { activity, ingest } = build();
    await (activity as any)._fanOutToOrg(ctx, [
      rawPost(new Date(Date.now() - 30 * DAY)),
    ]);

    expect(ingest.classifyIntents).not.toHaveBeenCalled();
    expect(ingest.persistOpportunities).not.toHaveBeenCalled();
    expect(ingest.updateKeywordHitCounts).not.toHaveBeenCalled();
    // 'scanned' still records the keyword match — an expired post was really
    // seen, and losing it would hide the platform's supply from telemetry.
    const phases = ingest.recordScoreDistribution.mock.calls.map((c: any[]) => c[1]);
    expect(phases).toContain('scanned');
    expect(phases).not.toContain('persisted');
  });

  it('keeps the same post when it is inside the TTL window', async () => {
    // Same fixture, fresh date: proves the assertions above are the gate
    // firing, not the post failing MIN_SCORE for some other reason.
    const { activity, ingest } = build();
    await (activity as any)._fanOutToOrg(ctx, [
      rawPost(new Date(Date.now() - 2 * DAY)),
    ]);

    expect(ingest.classifyIntents).toHaveBeenCalledTimes(1);
    expect(ingest.persistOpportunities).toHaveBeenCalledTimes(1);
    expect(ingest.updateKeywordHitCounts).toHaveBeenCalledTimes(1);
    const phases = ingest.recordScoreDistribution.mock.calls.map((c: any[]) => c[1]);
    expect(phases).toContain('persisted');
  });
});
