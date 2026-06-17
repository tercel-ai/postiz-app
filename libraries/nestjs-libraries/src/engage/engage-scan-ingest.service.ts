import { Injectable } from '@nestjs/common';
import { EngageKeyword, Prisma } from '@prisma/client';
import {
  PrismaRepository,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import {
  RawPost,
  ScoredPost,
  scorePost,
} from '@gitroom/nestjs-libraries/engage/engage-scorer';
import { EngageIntentClassifierService } from '@gitroom/nestjs-libraries/engage/engage-intent-classifier.service';

// Max concurrent upserts per phase. The posts array is unbounded (a scan unit's
// full yield), so an un-chunked Promise.all can exhaust the Prisma pool.
const PERSIST_BATCH_SIZE = 25;

// Minimum total score for a scored post to become an opportunity (spec §). Kept
// in sync with the orchestrator's ENGAGE_MIN_SCORE.
const MIN_SCORE = Number(process.env.ENGAGE_MIN_SCORE ?? 60);

/**
 * The per-org subscription context needed to score a scan unit's posts: the
 * org's enabled keywords (the hard keyword filter + keyword score) and its
 * tracked accounts / monitored subreddits (the +tracked bonus). Structurally a
 * subset of EngageConfig-with-relations, so a Prisma org context satisfies it.
 */
export interface OrgScanContext {
  organizationId: string;
  keywords: Pick<EngageKeyword, 'id' | 'keyword' | 'type' | 'enabled'>[];
  trackedAccounts: { platform: string; username: string }[];
  monitoredChannels: { platform: string; channelId: string }[];
}

/** Subset of EngageOpportunity needed to re-score an existing global row. */
export interface OpportunityRow {
  id: string;
  platform: string;
  externalPostId: string;
  externalPostUrl: string;
  channelId: string | null;
  channelName: string | null;
  channelFollowers: number | null;
  authorUsername: string;
  authorDisplayName: string | null;
  authorFollowers: number | null;
  authorAvatarUrl: string | null;
  postContent: string;
  postPublishedAt: Date;
  metricLikes: number;
  metricReplies: number;
  metricRetweets: number;
  metricQuotes: number;
  metricBookmarks: number;
  metricViews: number;
  metricShares: number;
  metricSaves: number;
  metricScore: number;
  metricUpvoteRatio: number | null;
  metricComments: number;
}

/** Map a stored global opportunity back to a RawPost for re-scoring. */
export function opportunityToRawPost(o: OpportunityRow): RawPost {
  return {
    id: o.externalPostId,
    platform: o.platform,
    externalPostId: o.externalPostId,
    externalPostUrl: o.externalPostUrl,
    channelId: o.channelId ?? undefined,
    channelName: o.channelName ?? undefined,
    channelFollowers: o.channelFollowers ?? undefined,
    authorUsername: o.authorUsername,
    authorDisplayName: o.authorDisplayName ?? undefined,
    authorFollowers: o.authorFollowers ?? undefined,
    authorAvatarUrl: o.authorAvatarUrl ?? undefined,
    postContent: o.postContent,
    postPublishedAt: o.postPublishedAt,
    metricLikes: o.metricLikes,
    metricReplies: o.metricReplies,
    metricRetweets: o.metricRetweets,
    metricQuotes: o.metricQuotes,
    metricBookmarks: o.metricBookmarks,
    metricViews: o.metricViews,
    metricShares: o.metricShares,
    metricSaves: o.metricSaves,
    metricScore: o.metricScore,
    metricUpvoteRatio: o.metricUpvoteRatio ?? undefined,
    metricComments: o.metricComments,
  };
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Shared post-scoring ingest pipeline: intent classification → two-table
 * persistence (global EngageOpportunity + per-org EngageOpportunityState) →
 * keyword hit-count bookkeeping. Extracted from the orchestrator scan activity
 * so BOTH the workflow scan and the extension scan-ingest endpoint write through
 * ONE implementation — same tables, same semantics, no divergent write path.
 *
 * Scoring itself stays a pure function (`scorePost`, engage-scorer); this service
 * owns everything from "scored posts" to "persisted opportunities".
 */
@Injectable()
export class EngageScanIngestService {
  constructor(
    private readonly _opportunity: PrismaRepository<'engageOpportunity'>,
    private readonly _oppState: PrismaRepository<'engageOpportunityState'>,
    private readonly _keyword: PrismaRepository<'engageKeyword'>,
    private readonly _intentClassifier: EngageIntentClassifierService,
    private readonly _tx: PrismaTransaction
  ) {}

  /**
   * Score a scan unit's raw posts for ONE org: mark posts from the org's tracked
   * accounts / monitored subreddits (the +tracked bonus), run the keyword
   * scorer (hard keyword filter + scoring), and keep only posts at/above
   * MIN_SCORE. Mirrors the workflow fan-out so both paths surface the same
   * opportunities. For channel/tracked scope-firehose results (fetched without
   * keywords), this is where the per-org keyword match happens server-side.
   */
  scoreForOrg(posts: RawPost[], ctx: OrgScanContext): ScoredPost[] {
    if (!ctx.keywords.length) return [];

    const trackedUsernames = new Set(
      ctx.trackedAccounts.map((a) => a.username.toLowerCase())
    );
    const monitoredSubreddits = new Set(
      ctx.monitoredChannels
        .filter((c) => c.platform === 'reddit')
        .map((c) => c.channelId.toLowerCase())
    );

    return posts
      .map((p) => {
        const tracked =
          (p.platform === 'x' &&
            trackedUsernames.has(p.authorUsername.toLowerCase())) ||
          (p.platform === 'reddit' &&
            !!p.channelId &&
            monitoredSubreddits.has(p.channelId.toLowerCase()));
        return tracked ? { ...p, isFromTrackedAccount: true } : p;
      })
      .map((p) => scorePost(p, ctx.keywords))
      .filter((p): p is ScoredPost => p !== null && p.score >= MIN_SCORE);
  }

  /**
   * End-to-end ingest for one org: score → classify intents → persist (two-table)
   * → keyword hit counts. Returns the number of opportunities persisted. The
   * extension scan-ingest endpoint calls this per subscribing org; the scorer is
   * the per-org keyword gate so channel/tracked firehose noise is dropped here.
   */
  async ingestForOrg(ctx: OrgScanContext, posts: RawPost[]): Promise<number> {
    const scored = this.scoreForOrg(posts, ctx);
    if (!scored.length) return 0;
    const classified = await this.classifyIntents(scored);
    await this.persistOpportunities(ctx.organizationId, classified);
    await this.updateKeywordHitCounts(ctx.organizationId, classified, ctx.keywords);
    return scored.length;
  }

  /**
   * Back-attribute EXISTING global opportunities to one org WITHOUT a platform
   * fetch (the cross-org "initial" path). When an org newly subscribes to a
   * keyword/subreddit/author that other orgs already populated, the global post
   * rows exist but this org has no per-org state. We re-score those rows for the
   * org and upsert ONLY the per-org state (phase 2) — the global row and its
   * intent are untouched. Returns the number of states written.
   */
  async attributeExisting(
    ctx: OrgScanContext,
    opportunities: Array<OpportunityRow>
  ): Promise<number> {
    if (!opportunities.length) return 0;
    const idByExternal = new Map(
      opportunities.map((o) => [`${o.platform}:${o.externalPostId}`, o.id])
    );
    const scored = this.scoreForOrg(opportunities.map(opportunityToRawPost), ctx);
    if (!scored.length) return 0;

    for (const batch of chunk(scored, PERSIST_BATCH_SIZE)) {
      await Promise.all(
        batch.map((post) => {
          const opportunityId = idByExternal.get(
            `${post.platform}:${post.externalPostId}`
          );
          if (!opportunityId) return Promise.resolve(undefined);
          return this._oppState.model.engageOpportunityState.upsert({
            where: {
              organizationId_opportunityId: {
                organizationId: ctx.organizationId,
                opportunityId,
              },
            },
            create: {
              organizationId: ctx.organizationId,
              opportunityId,
              status: 'NEW',
              score: post.score,
              scoreKeyword: post.scoreKeyword,
              scoreTracked: post.scoreTracked,
              matchedKeywords: post.matchedKeywords,
            },
            update: {
              score: post.score,
              scoreKeyword: post.scoreKeyword,
              scoreTracked: post.scoreTracked,
              matchedKeywords: post.matchedKeywords,
              // status / bookmarked preserved
            },
          });
        })
      );
    }
    return scored.length;
  }

  /** Attach intent tags/primary/score to each scored post (batched LLM call). */
  async classifyIntents(scored: ScoredPost[]): Promise<ScoredPost[]> {
    const batchInput = scored.map((p) => ({ id: p.id, content: p.postContent }));
    const results = await this._intentClassifier.classifyBatch(batchInput);
    return scored.map((p) => ({
      ...p,
      intentTags: results[p.id]?.intentTags ?? ['discussion'],
      primaryIntent: results[p.id]?.primaryIntent ?? 'discussion',
      intentScore: results[p.id]?.intentScore ?? 0,
    }));
  }

  /**
   * Two-phase persist for one org:
   *   Phase 1 — upsert the GLOBAL post row (shared across orgs): content +
   *             objective metrics/scores. Idempotent; re-scan refreshes metrics.
   *   Phase 2 — upsert this org's per-post STATE: total/keyword/tracked score +
   *             matched keywords. status/bookmark are preserved across re-scans.
   * opportunities[i] aligns with posts[i] because phase 1 pushes in order.
   */
  async persistOpportunities(
    orgId: string,
    posts: ScoredPost[]
  ): Promise<void> {
    if (!posts.length) return;

    const opportunities: Array<{ id: string }> = [];
    for (const batch of chunk(posts, PERSIST_BATCH_SIZE)) {
      const persisted = await Promise.all(
        batch.map((post) =>
          this._opportunity.model.engageOpportunity.upsert({
            where: {
              platform_externalPostId: {
                platform: post.platform,
                externalPostId: post.externalPostId,
              },
            },
            create: {
              platform: post.platform,
              externalPostId: post.externalPostId,
              externalPostUrl: post.externalPostUrl,
              channelId: post.channelId ?? null,
              channelName: post.channelName ?? null,
              channelFollowers: post.channelFollowers ?? null,
              authorUsername: post.authorUsername,
              authorDisplayName: post.authorDisplayName ?? null,
              authorFollowers: post.authorFollowers ?? null,
              authorAvatarUrl: post.authorAvatarUrl ?? null,
              postContent: post.postContent,
              postPublishedAt: post.postPublishedAt,
              scoreHeat: post.scoreHeat,
              scoreAuthority: post.scoreAuthority,
              scoreRecency: post.scoreRecency,
              intentTags: post.intentTags,
              primaryIntent: post.primaryIntent,
              intentScore: post.intentScore ?? null,
              metricLikes: post.metricLikes,
              metricReplies: post.metricReplies,
              metricRetweets: post.metricRetweets,
              metricQuotes: post.metricQuotes,
              metricBookmarks: post.metricBookmarks ?? 0,
              metricViews: post.metricViews ?? 0,
              metricShares: post.metricShares ?? 0,
              metricSaves: post.metricSaves ?? 0,
              metricScore: post.metricScore,
              metricUpvoteRatio: post.metricUpvoteRatio ?? null,
              metricComments: post.metricComments,
              rawData:
                post.rawData != null
                  ? (post.rawData as Prisma.InputJsonValue)
                  : null,
            },
            update: {
              // Refresh the channel audience size so authority tracks growth.
              channelFollowers: post.channelFollowers ?? null,
              scoreHeat: post.scoreHeat,
              scoreAuthority: post.scoreAuthority,
              scoreRecency: post.scoreRecency,
              metricLikes: post.metricLikes,
              metricReplies: post.metricReplies,
              metricRetweets: post.metricRetweets,
              metricQuotes: post.metricQuotes,
              metricBookmarks: post.metricBookmarks ?? 0,
              metricViews: post.metricViews ?? 0,
              metricShares: post.metricShares ?? 0,
              metricSaves: post.metricSaves ?? 0,
              metricScore: post.metricScore,
              metricUpvoteRatio: post.metricUpvoteRatio ?? null,
              metricComments: post.metricComments,
              // intentTags / primaryIntent NOT updated — preserve original classification
            },
            select: { id: true },
          })
        )
      );
      opportunities.push(...persisted);
    }

    const stateInputs = posts.map((post, i) => ({
      post,
      opportunityId: opportunities[i].id,
    }));
    for (const batch of chunk(stateInputs, PERSIST_BATCH_SIZE)) {
      await Promise.all(
        batch.map(({ post, opportunityId }) =>
          this._oppState.model.engageOpportunityState.upsert({
            where: {
              organizationId_opportunityId: { organizationId: orgId, opportunityId },
            },
            create: {
              organizationId: orgId,
              opportunityId,
              status: 'NEW',
              score: post.score,
              scoreKeyword: post.scoreKeyword,
              scoreTracked: post.scoreTracked,
              matchedKeywords: post.matchedKeywords,
            },
            update: {
              score: post.score,
              scoreKeyword: post.scoreKeyword,
              scoreTracked: post.scoreTracked,
              // Refresh matched keywords so keyword edits reflect on re-scan.
              matchedKeywords: post.matchedKeywords,
              // status / bookmarked NOT updated — preserve user state
            },
          })
        )
      );
    }
  }

  /**
   * Increment weekly/total hit counts for the org's keywords matched by these
   * posts. Guards against Temporal-retry double-counting by skipping keywords
   * counted within the last 5 minutes.
   */
  async updateKeywordHitCounts(
    orgId: string,
    posts: ScoredPost[],
    keywords: Pick<EngageKeyword, 'id' | 'keyword' | 'enabled'>[]
  ): Promise<void> {
    const hitMap = new Map<string, number>();
    for (const post of posts) {
      for (const kw of keywords) {
        // Word-boundary match, consistent with engage-scorer (avoid substring
        // hits like "react" inside "overreacting").
        const pattern = new RegExp(
          `\\b${kw.keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
          'i'
        );
        if (kw.enabled && pattern.test(post.postContent)) {
          hitMap.set(kw.id, (hitMap.get(kw.id) ?? 0) + 1);
        }
      }
    }
    if (!hitMap.size) return;

    const recentCutoff = new Date(Date.now() - 5 * 60 * 1000);
    const kwIds = Array.from(hitMap.keys());
    const existing = await this._keyword.model.engageKeyword.findMany({
      where: { id: { in: kwIds } },
      select: { id: true, lastCountedAt: true },
    });
    const alreadyCounted = new Set(
      existing
        .filter((k) => k.lastCountedAt && k.lastCountedAt > recentCutoff)
        .map((k) => k.id)
    );

    const now = new Date();
    const ops = Array.from(hitMap, ([kwId, hits]) => {
      if (alreadyCounted.has(kwId)) return null;
      return this._keyword.model.engageKeyword.update({
        where: { id: kwId },
        data: {
          weeklyHitCount: { increment: hits },
          totalHitCount: { increment: hits },
          lastCountedAt: now,
        },
      });
    }).filter((op): op is NonNullable<typeof op> => op !== null);

    if (ops.length) await this._tx.model.$transaction(ops);
  }
}
