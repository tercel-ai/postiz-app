import { Injectable } from '@nestjs/common';
import { Integration, Organization } from '@prisma/client';
import dayjs from 'dayjs';
import isoWeek from 'dayjs/plugin/isoWeek';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { DashboardRepository } from '@gitroom/nestjs-libraries/database/prisma/dashboard/dashboard.repository';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import { IntegrationManager } from '@gitroom/nestjs-libraries/integrations/integration.manager';
import { RefreshIntegrationService } from '@gitroom/nestjs-libraries/integrations/refresh.integration.service';
import { AnalyticsData, BatchPostAnalyticsResult } from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';
import { DataTicksService } from '@gitroom/nestjs-libraries/database/prisma/data-ticks/data-ticks.service';

dayjs.extend(isoWeek);
dayjs.extend(utc);
dayjs.extend(timezone);

const VIEWS_RE = /^(impression|views|reach|unique.impression)/i;
const LIKES_RE = /^(like|reaction)/i;
const COMMENTS_RE = /^(comment|repl)/i;
const SAVES_RE = /^(save|bookmark|favorite)/i;

const CACHE_TTL =
  !process.env.NODE_ENV || process.env.NODE_ENV === 'development' ? 1 : 3600;

@Injectable()
export class DashboardService {
  constructor(
    private _dashboardRepository: DashboardRepository,
    private _postsService: PostsService,
    private _integrationManager: IntegrationManager,
    private _refreshIntegrationService: RefreshIntegrationService,
    private _dataTicksService: DataTicksService
  ) {}

  async getSummary(
    org: Organization,
    startDate?: Date,
    endDate?: Date,
    integrationId?: string[],
    channel?: string[],
    tz?: string
  ) {
    const normalizedStart = startDate ? dayjs(startDate).startOf('day').toDate() : undefined;
    const normalizedEnd = endDate ? dayjs(endDate).endOf('day').toDate() : undefined;
    const intKey = integrationId?.length ? [...integrationId].sort().join(',') : 'all';
    const chKey = channel?.length ? [...channel].sort().join(',') : 'all';
    const cacheKey = `dashboard:summary:${org.id}:${normalizedStart?.getTime() || 'all'}:${normalizedEnd?.getTime() || 'all'}:${intKey}:${chKey}:${tz || 'utc'}`;
    const cached = await ioRedis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }

    // Month start in user's timezone (or UTC), used for published_this_month count
    const now = tz ? dayjs().tz(tz) : dayjs.utc();
    const monthStart = now.startOf('month').toDate();

    const [channelCount, integrations, postStats, impressionsSummary, trafficSummary, publishedThisMonth] = await Promise.all([
      this._dashboardRepository.getChannelCount(org.id, integrationId, channel),
      this._dashboardRepository.getActiveIntegrations(org.id, integrationId, channel),
      this._dashboardRepository.getPostsStats(org.id, normalizedStart, normalizedEnd, integrationId, channel),
      this._dataTicksService.getImpressionsSummaryByPlatform({
        organizationId: org.id,
        integrationId,
        channel,
        startDate: normalizedStart,
        endDate: normalizedEnd,
      }),
      this._dataTicksService.getTrafficSummaryByPlatform({
        organizationId: org.id,
        integrationId,
        channel,
        startDate: normalizedStart,
        endDate: normalizedEnd,
      }),
      this._dashboardRepository.countPublishedThisMonth(org.id, monthStart),
    ]);

    const stats = {
      total: 0,
      scheduled: 0,
      published: 0,
      drafts: 0,
      errors: 0,
    };

    for (const stat of postStats) {
      const count = stat._count._all;
      stats.total += count;
      switch (stat.state) {
        case 'QUEUE':
          stats.scheduled = count;
          break;
        case 'PUBLISHED':
          stats.published = count;
          break;
        case 'DRAFT':
          stats.drafts = count;
          break;
        case 'ERROR':
          stats.errors = count;
          break;
      }
    }

    const channelsByPlatform = new Map<string, number>();
    for (const integration of integrations) {
      const platform = integration.providerIdentifier;
      channelsByPlatform.set(
        platform,
        (channelsByPlatform.get(platform) || 0) + 1
      );
    }

    const impressionsTotal = impressionsSummary.reduce((sum: number, p: { value: number }) => sum + p.value, 0);
    const trafficsTotal = trafficSummary.reduce((sum: number, p: { value: number }) => sum + p.value, 0);

    const result = {
      channel_count: channelCount,
      channels_by_platform: Array.from(channelsByPlatform.entries()).map(
        ([platform, count]) => ({ platform, count })
      ),
      impressions_total: impressionsTotal,
      traffics_total: trafficsTotal,
      posts_stats: stats,
      published_this_month: publishedThisMonth,
    };

    await ioRedis.set(cacheKey, JSON.stringify(result), 'EX', CACHE_TTL);
    return result;
  }

  async getPostsTrend(
    org: Organization,
    period: 'daily' | 'weekly' | 'monthly' = 'daily',
    tz?: string
  ) {
    const sinceDays = period === 'monthly' ? 365 : period === 'weekly' ? 90 : 30;
    const posts = await this._dashboardRepository.getPostsForTrend(
      org.id,
      sinceDays
    );

    const buckets = new Map<string, number>();

    for (const post of posts) {
      if (!post.publishDate || !post.integration) continue;

      const d = tz
        ? dayjs.utc(post.publishDate).tz(tz)
        : dayjs.utc(post.publishDate);
      let dateKey: string;
      switch (period) {
        case 'weekly':
          dateKey = d.isoWeekday(1).format('YYYY-MM-DD');
          break;
        case 'monthly':
          dateKey = d.format('YYYY-MM');
          break;
        default:
          dateKey = d.format('YYYY-MM-DD');
      }

      const platform = post.integration.providerIdentifier;
      const key = `${dateKey}|${platform}`;
      buckets.set(key, (buckets.get(key) || 0) + 1);
    }

    const result: Array<{ date: string; platform: string; count: number }> = [];
    for (const [key, count] of buckets) {
      const [date, platform] = key.split('|');
      result.push({ date, platform, count });
    }

    result.sort((a, b) => a.date.localeCompare(b.date) || a.platform.localeCompare(b.platform));
    return result;
  }

  async getTraffics(
    org: Organization,
    integrationId?: string[],
    channel?: string[],
    startDate?: Date,
    endDate?: Date
  ) {
    const intKey = integrationId?.length ? [...integrationId].sort().join(',') : 'all';
    const chKey = channel?.length ? [...channel].sort().join(',') : 'all';
    const sdKey = startDate?.getTime() || 'all';
    const edKey = endDate?.getTime() || 'all';
    const cacheKey = `dashboard:traffics:${org.id}:${intKey}:${chKey}:${sdKey}:${edKey}`;
    const cached = await ioRedis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }

    const result = await this._dataTicksService.getTrafficSummaryByPlatform({
      organizationId: org.id,
      integrationId,
      channel,
      startDate,
      endDate,
    });

    await ioRedis.set(cacheKey, JSON.stringify(result), 'EX', CACHE_TTL);
    return result;
  }

  async getImpressions(
    org: Organization,
    period: 'daily' | 'weekly' | 'monthly' = 'daily',
    integrationId?: string[],
    channel?: string[],
    startDate?: Date,
    endDate?: Date
  ) {
    const intKey = integrationId?.length ? [...integrationId].sort().join(',') : 'all';
    const chKey = channel?.length ? [...channel].sort().join(',') : 'all';
    const sdKey = startDate?.getTime() || 'all';
    const edKey = endDate?.getTime() || 'all';
    const cacheKey = `dashboard:impressions:${org.id}:${period}:${intKey}:${chKey}:${sdKey}:${edKey}`;
    const cached = await ioRedis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }

    const result = await this._dataTicksService.getImpressionsByPlatform({
      organizationId: org.id,
      period,
      integrationId,
      channel,
      startDate,
      endDate,
    });

    await ioRedis.set(cacheKey, JSON.stringify(result), 'EX', CACHE_TTL);
    return result;
  }

  async getPostEngagement(org: Organization, days: number = 30) {
    const cacheKey = `dashboard:post-engagement:${org.id}:${days}`;
    const cached = await ioRedis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }

    const activeIntegrations =
      await this._dashboardRepository.getActiveIntegrations(org.id);

    const { analyticsMap, postsFailed, postsTotal } =
      await this._fetchAllPostAnalytics(org, days);

    const totals = { views: 0, likes: 0, comments: 0, saves: 0 };
    const platformMap = new Map<
      string,
      { views: number; likes: number; comments: number; saves: number; post_count: number }
    >();

    for (const integration of activeIntegrations) {
      const platform = integration.providerIdentifier;
      if (!platformMap.has(platform)) {
        platformMap.set(platform, {
          views: 0,
          likes: 0,
          comments: 0,
          saves: 0,
          post_count: 0,
        });
      }
    }

    for (const [, { metrics, platform }] of analyticsMap) {
      if (!metrics.length) continue;
      const platformData = platformMap.get(platform);
      if (!platformData) continue;
      platformData.post_count++;
      this._accumulateMetrics(metrics, totals, platformData);
    }

    const by_platform = Array.from(platformMap.entries()).map(
      ([platform, data]) => ({ platform, ...data })
    );

    const response = {
      totals,
      by_platform,
      meta: {
        posts_analyzed: postsTotal - postsFailed,
        posts_failed: postsFailed,
        posts_total: postsTotal,
        days,
      },
    };

    await ioRedis.set(cacheKey, JSON.stringify(response), 'EX', CACHE_TTL);
    return response;
  }

  async getGlobalStats() {
    const [
      totalPosts,
      postsByState,
      totalIntegrations,
      integrationsByPlatform,
      postsToday,
      errorsLast7Days,
      postsLast7Days,
    ] = await this._dashboardRepository.getGlobalStats();

    return {
      total_posts: totalPosts,
      posts_by_state: postsByState.map((s) => ({
        state: s.state,
        count: s._count._all,
      })),
      total_integrations: totalIntegrations,
      integrations_by_platform: integrationsByPlatform.map((p) => ({
        platform: p.providerIdentifier,
        count: p._count._all,
      })),
      posts_today: postsToday,
      error_rate_7d:
        postsLast7Days > 0
          ? Math.round((errorsLast7Days / postsLast7Days) * 10000) / 100
          : 0,
      errors_last_7d: errorsLast7Days,
    };
  }

  /**
   * Fetch post-level analytics for all published posts, using batch APIs
   * where available and per-post fallback with circuit breaker otherwise.
   */
  private async _fetchAllPostAnalytics(
    org: Organization,
    days: number,
    integrationId?: string[],
    channel?: string[]
  ): Promise<{
    analyticsMap: Map<string, { metrics: AnalyticsData[]; platform: string }>;
    postsFailed: number;
    postsTotal: number;
  }> {
    const [posts, activeIntegrations] = await Promise.all([
      this._dashboardRepository.getPublishedPostsWithRelease(org.id, days, integrationId, channel),
      this._dashboardRepository.getActiveIntegrations(org.id, integrationId, channel),
    ]);

    const analyticsMap = new Map<string, { metrics: AnalyticsData[]; platform: string }>();

    const integrationById = new Map<string, Integration>();
    for (const integration of activeIntegrations) {
      integrationById.set(integration.id, integration);
    }

    const postsByIntegration = new Map<
      string,
      Array<{ id: string; releaseId: string | null; platform: string }>
    >();
    for (const post of posts) {
      const intId = post.integrationId;
      if (!intId) continue;
      if (!postsByIntegration.has(intId)) {
        postsByIntegration.set(intId, []);
      }
      postsByIntegration.get(intId)!.push({
        id: post.id,
        releaseId: post.releaseId,
        platform: post.integration?.providerIdentifier ?? 'unknown',
      });
    }

    let postsFailed = 0;

    for (const [intId, groupPosts] of postsByIntegration) {
      const fullIntegration = integrationById.get(intId);
      if (!fullIntegration) {
        postsFailed += groupPosts.length;
        continue;
      }

      const provider = this._integrationManager.getSocialIntegration(
        fullIntegration.providerIdentifier
      );

      if (provider?.batchPostAnalytics) {
        const batchAnalytics = await this._processBatchAnalytics(
          org.id,
          fullIntegration,
          provider.batchPostAnalytics.bind(provider),
          groupPosts,
          days
        );

        for (const post of groupPosts) {
          const metrics = batchAnalytics.get(post.id) || [];
          analyticsMap.set(post.id, { metrics, platform: post.platform });
        }
      } else {
        const platformFailCount = new Map<string, number>();
        const PLATFORM_FAIL_THRESHOLD = 2;
        const BATCH_SIZE = 5;

        for (let i = 0; i < groupPosts.length; i += BATCH_SIZE) {
          const batch = groupPosts.slice(i, i + BATCH_SIZE);
          const results = await Promise.allSettled(
            batch.map((post) => {
              if (
                (platformFailCount.get(post.platform) || 0) >=
                PLATFORM_FAIL_THRESHOLD
              ) {
                return Promise.resolve([] as AnalyticsData[]);
              }
              return this._postsService.checkPostAnalytics(
                org.id,
                post.id,
                days
              );
            })
          );

          for (let j = 0; j < results.length; j++) {
            const result = results[j];
            const post = batch[j];

            if (result.status === 'rejected' || !result.value?.length) {
              if (result.status === 'rejected') postsFailed++;
              platformFailCount.set(
                post.platform,
                (platformFailCount.get(post.platform) || 0) + 1
              );
              analyticsMap.set(post.id, { metrics: [], platform: post.platform });
              continue;
            }

            platformFailCount.set(post.platform, 0);
            analyticsMap.set(post.id, { metrics: result.value, platform: post.platform });
          }
        }
      }
    }

    return { analyticsMap, postsFailed, postsTotal: posts.length };
  }

  private async _processBatchAnalytics(
    orgId: string,
    integration: Integration,
    batchPostAnalytics: (integrationId: string, accessToken: string, postIds: string[], fromDate: number) => Promise<BatchPostAnalyticsResult>,
    posts: Array<{ id: string; releaseId: string | null; platform: string }>,
    days: number
  ): Promise<Map<string, AnalyticsData[]>> {
    const result = new Map<string, AnalyticsData[]>();

    // Check per-post cache first, collect uncached posts
    const postsWithRelease = posts.filter((p): p is typeof p & { releaseId: string } => !!p.releaseId);
    const cacheKeys = postsWithRelease.map((p) => `integration:${orgId}:${p.id}:${days}`);
    const cachedValues = cacheKeys.length > 0 ? await ioRedis.mget(...cacheKeys) : [];

    const uncachedPosts: Array<{ id: string; releaseId: string }> = [];
    for (let i = 0; i < postsWithRelease.length; i++) {
      const post = postsWithRelease[i];
      const cached = cachedValues[i];
      if (cached) {
        result.set(post.id, JSON.parse(cached));
      } else {
        uncachedPosts.push({ id: post.id, releaseId: post.releaseId });
      }
    }

    if (uncachedPosts.length === 0) {
      return result;
    }

    // Refresh token if expired (once for the entire integration)
    let token = integration.token;
    if (dayjs(integration.tokenExpiration).isBefore(dayjs())) {
      try {
        const refreshed =
          await this._refreshIntegrationService.refresh(integration);
        if (!refreshed || !refreshed.accessToken) {
          return result;
        }
        token = refreshed.accessToken;
      } catch {
        return result;
      }
    }

    try {
      const batchResult = await batchPostAnalytics(
        integration.internalId,
        token,
        uncachedPosts.map((p) => p.releaseId),
        days
      );

      // Map results back by releaseId and cache per-post
      for (const post of uncachedPosts) {
        const analytics = batchResult[post.releaseId] || [];
        result.set(post.id, analytics);

        await ioRedis.set(
          `integration:${orgId}:${post.id}:${days}`,
          JSON.stringify(analytics),
          'EX',
          CACHE_TTL
        );
      }
    } catch (err: any) {
      if (err?.code === 429 || err?.rateLimit) {
        console.log(
          `Batch analytics rate limited for integration ${integration.id}, returning cached data only`
        );
      } else {
        console.log('Error in batch post analytics:', err);
      }
      // Uncached posts get empty arrays
      for (const post of uncachedPosts) {
        if (!result.has(post.id)) {
          result.set(post.id, []);
        }
      }
    }

    return result;
  }

  private _accumulateMetrics(
    metrics: AnalyticsData[],
    totals: { views: number; likes: number; comments: number; saves: number },
    platformData: { views: number; likes: number; comments: number; saves: number }
  ) {
    for (const metric of metrics) {
      const total = metric.data.reduce(
        (sum, d) => sum + Number(d.total || 0),
        0
      );

      if (VIEWS_RE.test(metric.label)) {
        totals.views += total;
        platformData.views += total;
      } else if (LIKES_RE.test(metric.label)) {
        totals.likes += total;
        platformData.likes += total;
      } else if (COMMENTS_RE.test(metric.label)) {
        totals.comments += total;
        platformData.comments += total;
      } else if (SAVES_RE.test(metric.label)) {
        totals.saves += total;
        platformData.saves += total;
      }
    }
  }
}
