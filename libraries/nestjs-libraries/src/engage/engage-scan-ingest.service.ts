import { Injectable } from '@nestjs/common';
import { EngageKeyword, Prisma } from '@prisma/client';
import {
  PrismaRepository,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import {
  RawPost,
  ScoredPost,
  postSearchText,
  scorePost,
} from '@gitroom/nestjs-libraries/engage/engage-scorer';
import { EngageIntentClassifierService } from '@gitroom/nestjs-libraries/engage/engage-intent-classifier.service';
import {
  EngageScorePhase,
  recordEngageScores,
} from '@gitroom/nestjs-libraries/database/prisma/api-usage/api-usage.service';
import {
  EngageScanConfigService,
  OpportunityTtlDays,
  fallbackOpportunityTtlDaysMap,
  opportunityExpiryCutoff,
} from '@gitroom/nestjs-libraries/engage/engage-scan-config.service';

// Max concurrent upserts per phase. The posts array is unbounded (a scan unit's
// full yield), so an un-chunked Promise.all can exhaust the Prisma pool.
const PERSIST_BATCH_SIZE = 25;

// Minimum total score for a scored post to become an opportunity (spec §). Kept
// in sync with the orchestrator's ENGAGE_MIN_SCORE.
const MIN_SCORE = Number(process.env.ENGAGE_MIN_SCORE ?? 60);

// Platforms with no title concept: their postContent is ALWAYS the plain body,
// never the "title\nbody" concatenation older rows can hold. With no pair to
// break, the body can safely be refreshed when the same post is scanned again —
// which is how a row stored with X's wire format in the body (t.co shortlinks
// instead of the real links) gets repaired by a newer extension's re-scan.
const TITLELESS_PLATFORMS = new Set(['x', 'linkedin']);

function xStatusFromUrl(url: string): { username: string; id: string } | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    if (host !== 'x.com' && host !== 'twitter.com') return null;
    const match = parsed.pathname.match(/^\/([^/]+)\/status(?:es)?\/(\d+)/);
    if (!match) return null;
    return { username: match[1], id: match[2] };
  } catch {
    return null;
  }
}

export function normalizeExternalPostUrl(platform: string, url: string): string {
  if (platform !== 'x') return url;
  const status = xStatusFromUrl(url);
  if (!status) return url;
  return `https://x.com/${status.username}/status/${status.id}`;
}

export function normalizeExternalPost<T extends Pick<ScoredPost, 'platform' | 'externalPostId' | 'externalPostUrl'>>(
  post: T
): T {
  const externalPostUrl = normalizeExternalPostUrl(
    post.platform,
    post.externalPostUrl
  );
  const status = post.platform === 'x' ? xStatusFromUrl(externalPostUrl) : null;
  return {
    ...post,
    externalPostId: status?.id ?? post.externalPostId,
    externalPostUrl,
  };
}

/**
 * The per-project subscription context needed to score a scan unit's posts:
 * one project's enabled keywords (the hard keyword filter + keyword score)
 * and its tracked accounts / monitored subreddits (the +tracked bonus).
 * Structurally a subset of EngageConfig-with-relations, so a Prisma
 * project/org context satisfies it.
 *
 * projectId is nullable during migration (project-scoped-post-engage-
 * design.md §11) — a legacy EngageConfig row with no projectId yet still
 * produces exactly one context, same as before this field existed. Once an
 * org has multiple EngageConfig rows (multiple projects), each yields its
 * OWN context here — this is what makes fan-out per-project rather than
 * per-org (§5 step 4: "one EngageOpportunityState per matched project").
 */
export interface OrgScanContext {
  organizationId: string;
  projectId: string | null;
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
  title: string | null;
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
    title: o.title ?? undefined,
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
    private readonly _tx: PrismaTransaction,
    // Optional so a caller that constructs this service by hand (the Temporal
    // scan activity, and the unit tests that build it directly) still works —
    // the TTL gate then resolves from env/defaults instead of Settings.
    private readonly _scanConfig?: EngageScanConfigService
  ) {}

  /**
   * Per-platform opportunity TTL. A Settings read failure degrades to
   * env/defaults rather than throwing: the TTL gate is a filter, and losing it
   * entirely (or aborting an ingest over it) is worse than using the defaults.
   */
  private async _ttlDays(): Promise<OpportunityTtlDays> {
    if (this._scanConfig) {
      try {
        return await this._scanConfig.getOpportunityTtlDaysMap();
      } catch {
        // fall through
      }
    }
    return fallbackOpportunityTtlDaysMap();
  }

  /**
   * Drop posts already published before their platform's TTL cutoff. Such a
   * post would land as an opportunity that is expired the moment it is written
   * — no reply can be sent against it — so persisting it only buys an LLM
   * intent call, a feed row nobody can act on, and a sweep to clean up later.
   *
   * Judged per POST, not per scan unit: `attributeExisting` and a mixed-yield
   * unit can carry more than one platform. A platform with no configured TTL is
   * never dropped (see opportunityExpiryCutoff).
   */
  async filterExpiredByPublishTime<
    T extends { platform: string; postPublishedAt: Date }
  >(posts: T[]): Promise<{ kept: T[]; dropped: number }> {
    if (!posts.length) return { kept: posts, dropped: 0 };
    const ttl = await this._ttlDays();
    const now = Date.now();
    const cutoffs = new Map<string, Date | null>();
    const kept = posts.filter((p) => {
      if (!cutoffs.has(p.platform)) {
        cutoffs.set(p.platform, opportunityExpiryCutoff(p.platform, ttl, now));
      }
      const cutoff = cutoffs.get(p.platform);
      if (!cutoff) return true;
      return new Date(p.postPublishedAt).getTime() >= cutoff.getTime();
    });
    return { kept, dropped: posts.length - kept.length };
  }

  /**
   * Score a scan unit's raw posts for ONE org: mark posts from the org's tracked
   * accounts / monitored subreddits (the +tracked bonus), run the keyword
   * scorer (hard keyword filter + scoring), and keep only posts at/above
   * MIN_SCORE. Mirrors the workflow fan-out so both paths surface the same
   * opportunities. For channel/tracked scope-firehose results (fetched without
   * keywords), this is where the per-org keyword match happens server-side.
   */
  scoreForOrg(posts: RawPost[], ctx: OrgScanContext): ScoredPost[] {
    return this.scoreAllForOrg(posts, ctx).filter((p) => p.score >= MIN_SCORE);
  }

  /**
   * Score a scan unit's posts WITHOUT the MIN_SCORE gate: every keyword-matched
   * post (scorePost non-null), regardless of total score. The gated subset is
   * `scoreForOrg`. Exposed so ingest can record the full 'scanned' score
   * distribution before the gate drops low-quality posts.
   */
  scoreAllForOrg(posts: RawPost[], ctx: OrgScanContext): ScoredPost[] {
    if (!ctx.keywords.length) return [];

    const trackedUsernames = new Set(
      ctx.trackedAccounts.map((a) => a.username.toLowerCase())
    );
    // No platform test on the LIST — partitionScanTargets only routes a row into
    // monitoredChannels when scanTypeFor(platform) === 'channel'. The
    // `p.platform === 'reddit'` test below gates on the POST's platform, which is
    // a different question and stays.
    const monitoredSubreddits = new Set(
      ctx.monitoredChannels.map((c) => c.channelId.toLowerCase())
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
      .filter((p): p is ScoredPost => p !== null);
  }

  /**
   * Record the engage score distribution for one phase, grouped by platform (a
   * scan unit is normally single-platform, but back-attribution may mix). Each
   * scored post's total score is bucketed into a fixed non-overlapping band.
   * Fire-and-forget telemetry — never blocks ingest.
   *
   * Public so BOTH write paths feed EngageScoreTick through one bucketing impl:
   * the extension scan-ingest path (via ingestForOrg, below) and the Temporal
   * workflow fan-out (engage-scan.activity `_fanOutToOrg`, which scores inline
   * and does NOT route through ingestForOrg). The two paths are disjoint, so
   * this never double-counts.
   */
  recordScoreDistribution(
    organizationId: string,
    phase: EngageScorePhase,
    scored: ScoredPost[]
  ): void {
    if (!scored.length) return;
    const byPlatform = new Map<string, number[]>();
    for (const p of scored) {
      const list = byPlatform.get(p.platform) ?? [];
      list.push(p.score);
      byPlatform.set(p.platform, list);
    }
    for (const [platform, scores] of byPlatform) {
      recordEngageScores(organizationId, platform, phase, scores);
    }
  }

  /**
   * End-to-end ingest for one org: score → classify intents → persist (two-table)
   * → keyword hit counts. Returns the number of opportunities persisted. The
   * extension scan-ingest endpoint calls this per subscribing org; the scorer is
   * the per-org keyword gate so channel/tracked firehose noise is dropped here.
   */
  async ingestForOrg(ctx: OrgScanContext, posts: RawPost[]): Promise<number> {
    // Score everything first so the 'scanned' distribution captures posts that
    // the MIN_SCORE gate will drop (the low buckets), then gate for persistence.
    const allScored = this.scoreAllForOrg(posts, ctx);
    this.recordScoreDistribution(ctx.organizationId, 'scanned', allScored);
    const gated = allScored.filter((p) => p.score >= MIN_SCORE);
    if (!gated.length) return 0;
    // TTL gate BEFORE intent classification: an already-expired post must not
    // cost an LLM call. `persisted` telemetry then counts what really persists.
    const { kept: scored } = await this.filterExpiredByPublishTime(gated);
    if (!scored.length) return 0;
    this.recordScoreDistribution(ctx.organizationId, 'persisted', scored);
    const classified = await this.classifyIntents(scored);
    await this.persistOpportunities(ctx.organizationId, ctx.projectId, classified);
    await this.updateKeywordHitCounts(ctx.organizationId, classified, ctx.keywords);
    return scored.length;
  }

  /**
   * Upsert one project's EngageOpportunityState row. Branches on projectId
   * because a nullable column can never satisfy a compound-unique `where`
   * (Postgres NULL != NULL) — the surrogate `id` + unique INDEX schema
   * (project-scoped-post-engage-design.md §3.3) trades away an atomic
   * upsert-by-null-key so legacy (projectId=null) and per-project rows can
   * coexist during migration. For projectId=null this is find-then-write, not
   * a single atomic statement: two concurrent first-discoveries of the same
   * opportunity for the same still-unmigrated org could each insert a row.
   * Accepted, same tolerance as other transient-migration races in the design
   * doc (§3.4) — collapses away once projectId is required (§11 step 8).
   */
  private async _upsertOpportunityState(
    organizationId: string,
    projectId: string | null,
    opportunityId: string,
    values: {
      score: number;
      scoreKeyword: number;
      scoreTracked: number;
      matchedKeywords: string[];
    }
  ) {
    const updateData = {
      score: values.score,
      scoreKeyword: values.scoreKeyword,
      scoreTracked: values.scoreTracked,
      // Refresh matched keywords so keyword edits reflect on re-scan.
      matchedKeywords: values.matchedKeywords,
      isCurrentlyMatched: values.matchedKeywords.length > 0,
      // status / bookmarked NOT updated — preserve user state
    };
    const createData = {
      organizationId,
      projectId,
      opportunityId,
      status: 'NEW' as const,
      ...updateData,
    };

    if (projectId != null) {
      return this._oppState.model.engageOpportunityState.upsert({
        where: {
          organizationId_projectId_opportunityId: { organizationId, projectId, opportunityId },
        },
        create: createData,
        update: updateData,
      });
    }

    const existing = await this._oppState.model.engageOpportunityState.findFirst({
      where: { organizationId, projectId: null, opportunityId },
      select: { id: true },
    });
    if (existing) {
      return this._oppState.model.engageOpportunityState.update({
        where: { id: existing.id },
        data: updateData,
      });
    }
    return this._oppState.model.engageOpportunityState.create({ data: createData });
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
    // Only rows whose opportunity id resolves are actually written; the returned
    // count must reflect writes, not scored candidates (it surfaces as the
    // backfill total), so filter up front and count the filtered set.
    const writable = scored.filter((post) =>
      idByExternal.has(`${post.platform}:${post.externalPostId}`)
    );
    if (!writable.length) return 0;
    // Back-attribution must not resurrect a post that is already past its
    // platform's TTL — the org would gain a state row it can never act on.
    const { kept: fresh } = await this.filterExpiredByPublishTime(writable);
    if (!fresh.length) return 0;

    for (const batch of chunk(fresh, PERSIST_BATCH_SIZE)) {
      await Promise.all(
        batch.map((post) => {
          const opportunityId = idByExternal.get(
            `${post.platform}:${post.externalPostId}`
          )!;
          return this._upsertOpportunityState(
            ctx.organizationId,
            ctx.projectId,
            opportunityId,
            post
          );
        })
      );
    }
    return fresh.length;
  }

  /** Attach intent tags/primary/score to each scored post (batched LLM call). */
  async classifyIntents(scored: ScoredPost[]): Promise<ScoredPost[]> {
    // Title included: on a Q&A platform the question carries the intent
    // ("how do I…", "X vs Y") far more clearly than the answer body does.
    const batchInput = scored.map((p) => ({
      id: p.id,
      content: postSearchText(p),
    }));
    const results = await this._intentClassifier.classifyBatch(batchInput);
    return scored.map((p) => ({
      ...p,
      intentTags: results[p.id]?.intentTags ?? ['discussion'],
      primaryIntent: results[p.id]?.primaryIntent ?? 'discussion',
      intentScore: results[p.id]?.intentScore ?? 0,
    }));
  }

  /**
   * Two-phase persist for one project:
   *   Phase 1 — upsert the GLOBAL post row (shared across every org/project):
   *             content + objective metrics/scores. Idempotent; re-scan
   *             refreshes metrics.
   *   Phase 2 — upsert this project's per-post STATE: total/keyword/tracked
   *             score + matched keywords. status/bookmark are preserved
   *             across re-scans.
   * opportunities[i] aligns with posts[i] because phase 1 pushes in order.
   */
  async persistOpportunities(
    orgId: string,
    projectId: string | null,
    rawPosts: ScoredPost[]
  ): Promise<void> {
    if (!rawPosts.length) return;
    // Authoritative TTL gate. ingestForOrg already filters (before paying for
    // intent classification), but the Temporal scan activity calls this method
    // directly, so the only place that can guarantee no expired post is ever
    // written is here, immediately before the writes.
    const { kept: fresh } = await this.filterExpiredByPublishTime(rawPosts);
    if (!fresh.length) return;
    const normalizedPosts = fresh.map(normalizeExternalPost);

    // Dedup by the GLOBAL natural key so the same post id/URL appearing twice in one
    // unit's yield (overlapping pages on X since_id / Reddit `after`) does not
    // fire two concurrent upserts on the same @@unique([platform,externalPostId])
    // row in one Promise.all batch (a Postgres ON CONFLICT race → P2002 that
    // aborts the whole org persist). Last write wins (freshest metrics). Also
    // keeps phase-2 index alignment trivially 1:1. The URL key catches plugin
    // share URLs whose query params or ids differ while still pointing at the
    // same platform post.
    const byKey = new Map<string, ScoredPost>();
    const byId = new Map<string, string>();
    const byUrl = new Map<string, string>();
    for (const p of normalizedPosts) {
      const idKey = `${p.platform}:${p.externalPostId}`;
      const urlKey = `${p.platform}:${p.externalPostUrl}`;
      const existingKey = byUrl.get(urlKey) ?? byId.get(idKey);
      if (existingKey) byKey.delete(existingKey);
      byKey.set(urlKey, p);
      byId.set(idKey, urlKey);
      byUrl.set(urlKey, urlKey);
    }
    const posts = Array.from(byKey.values());

    const opportunities: Array<{ id: string }> = [];
    for (const batch of chunk(posts, PERSIST_BATCH_SIZE)) {
      const persisted = await Promise.all(
        batch.map(async (post) => {
          const create = {
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
            title: post.title ?? null,
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
          };
          const update = {
            // Store the canonical URL, and refresh the channel audience size so
            // authority tracks growth.
            externalPostUrl: post.externalPostUrl,
            channelFollowers: post.channelFollowers ?? null,
            // The author-side counterpart of channelFollowers: on X there IS no
            // channel, so this is the whole of scoreAuthority there. Omitting it
            // from this branch is why an X row that once scored an author at all
            // could never be refreshed — and why rows that landed null stayed
            // null through every re-scan.
            //
            // Written only when the scanner actually reported it, NOT `?? null`
            // like channelFollowers above. That asymmetry is deliberate: this
            // field is optional on ScanIngestPostDto and only X reports it, so a
            // scanner that cannot supply it must not clear one that could. The
            // concrete case is extension version skew — a build predating the
            // `relationship_counts.followers` fix reports nothing (it read a
            // container X deleted), and `?? null` would let that old build wipe
            // the count a current build just stored. A stale follower count
            // still scores; a null scores as zero authority.
            ...(post.authorFollowers != null
              ? { authorFollowers: post.authorFollowers }
              : {}),
            // Title and body move together or not at all. A row stored before
            // the title column existed holds "title\nbody" in postContent, so
            // writing the title alone would leave the title duplicated in both
            // fields; and on a platform that HAS titles, a scraper sending none
            // (an older extension) must not be able to rewrite the body it did
            // not split — hence the whole pair is left untouched there.
            // TITLELESS_PLATFORMS have no pair to break: postContent is the
            // whole body, so it is refreshed on every re-scan.
            ...(post.title
              ? { title: post.title, postContent: post.postContent }
              : TITLELESS_PLATFORMS.has(post.platform)
                ? { postContent: post.postContent }
                : {}),
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
          };
          const existingByUrl =
            await this._opportunity.model.engageOpportunity.findFirst({
              where: {
                platform: post.platform,
                externalPostUrl: post.externalPostUrl,
              },
              select: { id: true },
            });
          if (existingByUrl) {
            return this._opportunity.model.engageOpportunity.update({
              where: { id: existingByUrl.id },
              data: update,
              select: { id: true },
            });
          }

          return this._opportunity.model.engageOpportunity.upsert({
            where: {
              platform_externalPostId: {
                platform: post.platform,
                externalPostId: post.externalPostId,
              },
            },
            create,
            update,
            select: { id: true },
          });
        })
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
          this._upsertOpportunityState(orgId, projectId, opportunityId, post)
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
        if (kw.enabled && pattern.test(postSearchText(post))) {
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
