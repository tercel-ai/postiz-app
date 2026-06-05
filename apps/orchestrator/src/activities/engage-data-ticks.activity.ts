import { Injectable, Logger } from '@nestjs/common';
import { Activity, ActivityMethod } from 'nestjs-temporal-core';
import { Context } from '@temporalio/activity';
import {
  PrismaRepository,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { EngageRepository } from '@gitroom/nestjs-libraries/engage/engage.repository';
import {
  syncRedditMetrics,
  syncXMetrics,
  type MetricsSyncDeps,
  type MetricsSyncOutcome,
} from '@gitroom/nestjs-libraries/engage/engage-metrics-sync';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';

dayjs.extend(utc);

@Injectable()
@Activity()
export class EngageDataTicksActivity {
  private readonly logger = new Logger(EngageDataTicksActivity.name);

  constructor(
    private _engageRepository: EngageRepository,
    private _post: PrismaRepository<'post'>,
    private _engageDataTicks: PrismaRepository<'engageDataTicks'>,
    private _engageSentReply: PrismaRepository<'engageSentReply'>,
    private _tx: PrismaTransaction,
    private _postsService: PostsService
  ) {}

  private _heartbeat(progress?: unknown): void {
    try {
      Context.current().heartbeat(progress);
    } catch {
      // Not running in a Temporal activity context.
    }
  }

  @ActivityMethod()
  async aggregateDailyEngageTicks(orgId?: string): Promise<void> {
    const yesterday = dayjs.utc().subtract(1, 'day').startOf('day').toDate();
    const yesterdayEnd = dayjs.utc().subtract(1, 'day').endOf('day').toDate();

    const where = {
      source: 'engage',
      state: 'PUBLISHED' as const,
      publishDate: { gte: yesterday, lte: yesterdayEnd },
      ...(orgId ? { organizationId: orgId } : {}),
    };

    const posts = await this._post.model.post.findMany({
      where,
      select: {
        organizationId: true,
        impressions: true,
        trafficScore: true,
        integration: { select: { providerIdentifier: true } },
      },
    });

    // Group by org and platform
    type Agg = { count: number; impressions: number; traffic: number };
    const byOrgPlatform = new Map<string, Map<string, Agg>>();

    for (const post of posts) {
      const platform = post.integration?.providerIdentifier ?? 'reddit';
      const orgMap = byOrgPlatform.get(post.organizationId) ?? new Map<string, Agg>();
      const curr = orgMap.get(platform) ?? { count: 0, impressions: 0, traffic: 0 };
      orgMap.set(platform, {
        count: curr.count + 1,
        impressions: curr.impressions + (post.impressions ?? 0),
        traffic: curr.traffic + (post.trafficScore ?? 0),
      });
      byOrgPlatform.set(post.organizationId, orgMap);
    }

    for (const [orgId, platformMap] of byOrgPlatform) {
      // Add cross-platform "all" aggregation
      const allAgg = [...platformMap.values()].reduce(
        (a, b) => ({
          count: a.count + b.count,
          impressions: a.impressions + b.impressions,
          traffic: a.traffic + b.traffic,
        }),
        { count: 0, impressions: 0, traffic: 0 }
      );
      platformMap.set('all', allAgg);

      this._heartbeat({ stage: 'aggregate', org: orgId });
      // Batch per-org upserts in one $transaction round-trip — avoids
      // K orgs × (P+1) platforms × 3 metric-types sequential DB hops.
      const ops: Array<Promise<unknown>> = [];
      for (const [platform, agg] of platformMap) {
        for (const [type, val] of [
          ['replies', agg.count],
          ['impressions', agg.impressions],
          ['traffic', agg.traffic],
        ] as const) {
          ops.push(
            this._engageDataTicks.model.engageDataTicks.upsert({
              where: {
                organizationId_platform_type_timeUnit_statisticsTime: {
                  organizationId: orgId,
                  platform,
                  type,
                  timeUnit: 'day',
                  statisticsTime: yesterday,
                },
              },
              create: {
                organizationId: orgId,
                platform,
                type,
                timeUnit: 'day',
                statisticsTime: yesterday,
                value: BigInt(Math.round(val)),
              },
              update: { value: BigInt(Math.round(val)) },
            })
          );
        }
      }
      await this._tx.model.$transaction(ops as never);
    }

    this.logger.log(
      `EngageDataTicks: aggregated ${posts.length} posts for ${byOrgPlatform.size} orgs`
    );
  }

  @ActivityMethod()
  async syncEngageMetrics(sentReplyId: string): Promise<void> {
    const reply = await this._engageSentReply.model.engageSentReply.findUnique({
      where: { id: sentReplyId },
      include: {
        post: { select: { id: true, releaseURL: true, state: true, integrationId: true } },
        opportunity: {
          select: {
            platform: true,
            externalPostId: true,
            authorUsername: true,
          },
        },
      },
    });
    if (!reply || !reply.post) return;

    if (reply.opportunity.platform === 'reddit' && reply.post.releaseURL) {
      await syncRedditMetrics(
        reply.post.id,
        reply.post.releaseURL,
        reply.id,
        reply.opportunity.authorUsername,
        this._metricsSyncDeps()
      );
    } else if (reply.opportunity.platform === 'x' && reply.post.releaseURL) {
      await syncXMetrics(
        {
          orgId: reply.organizationId,
          sentReplyId: reply.id,
          postDbId: reply.post.id,
          replyTweetUrl: reply.post.releaseURL,
          originalTweetId: reply.opportunity.externalPostId,
          authorUsername: reply.opportunity.authorUsername, // resolve original author's numeric user ID
        },
        this._metricsSyncDeps()
      );
    }
  }

  /**
   * Daily re-fetch of engage reply metrics for every PUBLISHED reply published
   * within the last `ENGAGE_METRICS_RESYNC_DAYS` days (default 30, mirroring the
   * calendar DataTicks lookback). Unlike the per-reply 24h sync + admin "fill
   * missing" path — which only touch `impressions: null` rows and therefore
   * freeze a reply's metrics after the first non-null fetch — this re-polls the
   * whole window so impressions/traffic keep growing day over day. Runs before
   * aggregateDailyEngageTicks so the dashboard (which reads Post directly) and
   * the daily EngageDataTicks roll-up both see fresh values. Idempotent: each
   * call just re-reads public_metrics; PostsService's `impressions > 0` write
   * guard prevents a transient empty read from clobbering good data.
   */
  @ActivityMethod()
  async resyncRecentEngageMetrics(): Promise<void> {
    const sinceDays = Number(process.env.ENGAGE_METRICS_RESYNC_DAYS) || 30;
    const replies = await this._engageRepository.findEngageRepliesInWindow(sinceDays);
    const deps = this._metricsSyncDeps();

    const tally: Record<MetricsSyncOutcome | 'failed', number> = {
      written: 0,
      empty: 0,
      unreachable: 0,
      skipped: 0,
      failed: 0,
    };

    for (const reply of replies) {
      if (!reply.post?.releaseURL) continue;
      this._heartbeat({ stage: 'resync', reply: reply.id });
      try {
        let outcome: MetricsSyncOutcome = 'skipped';
        if (reply.opportunity.platform === 'reddit') {
          outcome = await syncRedditMetrics(
            reply.post.id,
            reply.post.releaseURL,
            reply.id,
            reply.opportunity.authorUsername ?? '',
            deps
          );
        } else if (reply.opportunity.platform === 'x') {
          outcome = await syncXMetrics(
            {
              orgId: reply.organizationId,
              sentReplyId: reply.id,
              postDbId: reply.post.id,
              replyTweetUrl: reply.post.releaseURL,
              originalTweetId: reply.opportunity.externalPostId ?? '',
              authorUsername: reply.opportunity.authorUsername ?? '',
            },
            deps
          );
        }
        tally[outcome]++;
      } catch (err) {
        tally.failed++;
        this.logger.warn(
          `resyncRecentEngageMetrics: failed for reply ${reply.id}: ${(err as Error).message}`
        );
      }
    }

    this.logger.log(
      `EngageMetrics daily resync (last ${sinceDays}d): ${replies.length} replies — ` +
        `written=${tally.written} empty=${tally.empty} unreachable=${tally.unreachable} ` +
        `skipped=${tally.skipped} failed=${tally.failed}`
    );
  }

  /** Sinks for the shared engage-metrics-sync module (see engage-metrics-sync.ts). */
  private _metricsSyncDeps(): MetricsSyncDeps {
    return {
      updatePostMetrics: (postId, impressions, analytics, trafficScore) =>
        this._engageRepository.updatePostMetrics(postId, impressions, analytics, trafficScore),
      markAuthorReplied: (sentReplyId) => this._engageRepository.markAuthorReplied(sentReplyId),
      // Own-token → app-only fallback, identical to the manual sync path so the
      // scheduled 24h sync also recovers dead-token X replies.
      checkPostAnalytics: (orgId, postId, when) =>
        this._postsService.checkEngageXAnalyticsWithFallback(orgId, postId, when),
      warn: (m) => this.logger.warn(m),
      log: (m) => this.logger.log(m),
    };
  }

}
