import { Injectable } from '@nestjs/common';
import { Integration, Organization } from '@prisma/client';
import dayjs from 'dayjs';
import isoWeek from 'dayjs/plugin/isoWeek';
import { DashboardRepository } from '@gitroom/nestjs-libraries/database/prisma/dashboard/dashboard.repository';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import { IntegrationManager } from '@gitroom/nestjs-libraries/integrations/integration.manager';
import { RefreshIntegrationService } from '@gitroom/nestjs-libraries/integrations/refresh.integration.service';
import { AnalyticsData, BatchPostAnalyticsResult } from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';

dayjs.extend(isoWeek);

const IMPRESSIONS_RE = /impression|views|page.views|reach/i;
const TRAFFICS_RE = /click|engagement|traffic/i;

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
    private _integrationService: IntegrationService,
    private _postsService: PostsService,
    private _integrationManager: IntegrationManager,
    private _refreshIntegrationService: RefreshIntegrationService
  ) {}

  async getSummary(org: Organization) {
    const cacheKey = `dashboard:summary:${org.id}`;
    const cached = await ioRedis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }

    const [postCount, channelCount, integrations] = await Promise.all([
      this._dashboardRepository.getPostCount(org.id),
      this._dashboardRepository.getChannelCount(org.id),
      this._dashboardRepository.getActiveIntegrations(org.id),
    ]);

    let impressionsTotal = 0;
    let trafficsTotal = 0;

    const channelsByPlatform = new Map<string, number>();
    for (const integration of integrations) {
      const platform = integration.providerIdentifier;
      channelsByPlatform.set(
        platform,
        (channelsByPlatform.get(platform) || 0) + 1
      );

      try {
        const analytics: AnalyticsData[] =
          await this._integrationService.checkAnalytics(
            org,
            integration.id,
            '30'
          );

        for (const metric of analytics) {
          const total = metric.data.reduce(
            (sum, d) => sum + Number(d.total || 0),
            0
          );
          if (IMPRESSIONS_RE.test(metric.label)) {
            impressionsTotal += total;
          } else if (TRAFFICS_RE.test(metric.label)) {
            trafficsTotal += total;
          }
        }
      } catch {
        // skip failed integrations
      }
    }

    const result = {
      post_count: postCount,
      channel_count: channelCount,
      channels_by_platform: Array.from(channelsByPlatform.entries()).map(
        ([platform, count]) => ({ platform, count })
      ),
      impressions_total: impressionsTotal,
      traffics_total: trafficsTotal,
    };

    await ioRedis.set(cacheKey, JSON.stringify(result), 'EX', CACHE_TTL);
    return result;
  }

  async getPostsTrend(
    org: Organization,
    period: 'daily' | 'weekly' | 'monthly' = 'daily'
  ) {
    const sinceDays = period === 'monthly' ? 365 : period === 'weekly' ? 90 : 30;
    const posts = await this._dashboardRepository.getPostsForTrend(
      org.id,
      sinceDays
    );

    const buckets = new Map<string, number>();

    for (const post of posts) {
      if (!post.publishDate || !post.integration) continue;

      const d = dayjs(post.publishDate);
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

  async getTraffics(org: Organization) {
    const cacheKey = `dashboard:traffics:${org.id}`;
    const cached = await ioRedis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }

    const integrations =
      await this._dashboardRepository.getActiveIntegrations(org.id);

    const platformValues = new Map<string, number>();
    const platformRecent = new Map<string, number>();
    const platformOlder = new Map<string, number>();

    // Pre-populate all connected platforms so they always appear in the result
    for (const integration of integrations) {
      const platform = integration.providerIdentifier;
      if (!platformValues.has(platform)) {
        platformValues.set(platform, 0);
      }
    }

    // Split 30-day window into two halves at the midpoint (day 15).
    // "older" = days 16-30 ago, "recent" = days 0-15 ago.
    // delta = ((recent - older) / older) * 100  (percentage change).
    // Frontend usage: delta > 0 → show ↑ in green; delta < 0 → show ↓ in red.
    const midDate = dayjs().subtract(15, 'day');

    for (const integration of integrations) {
      try {
        const analytics: AnalyticsData[] =
          await this._integrationService.checkAnalytics(
            org,
            integration.id,
            '30'
          );

        for (const metric of analytics) {
          if (TRAFFICS_RE.test(metric.label)) {
            const platform = integration.providerIdentifier;
            for (const point of metric.data) {
              const val = Number(point.total || 0);
              platformValues.set(
                platform,
                (platformValues.get(platform) || 0) + val
              );
              if (dayjs(point.date).isAfter(midDate)) {
                platformRecent.set(
                  platform,
                  (platformRecent.get(platform) || 0) + val
                );
              } else {
                platformOlder.set(
                  platform,
                  (platformOlder.get(platform) || 0) + val
                );
              }
            }
          }
        }
      } catch {
        // skip failed integrations
      }
    }

    const grandTotal = Array.from(platformValues.values()).reduce(
      (a, b) => a + b,
      0
    );

    const result = Array.from(platformValues.entries()).map(
      ([platform, value]) => {
        const recent = platformRecent.get(platform) || 0;
        const older = platformOlder.get(platform) || 0;
        // Half-over-half percentage change:
        //   older > 0  → ((recent - older) / older) * 100
        //   older == 0 && recent > 0 → 100 (new traffic, treat as +100%)
        //   both 0 → 0
        // Frontend: delta > 0 → ↑ green, delta < 0 → ↓ red, delta === 0 → neutral
        const delta =
          older > 0
            ? Math.round(((recent - older) / older) * 10000) / 100
            : recent > 0
              ? 100
              : 0;
        return {
          platform,
          value,
          percentage:
            grandTotal > 0
              ? Math.round((value / grandTotal) * 10000) / 100
              : 0,
          delta,
        };
      }
    );

    result.sort((a, b) => b.value - a.value);

    await ioRedis.set(cacheKey, JSON.stringify(result), 'EX', CACHE_TTL);
    return result;
  }

  async getImpressions(
    org: Organization,
    period: 'daily' | 'weekly' | 'monthly' = 'daily'
  ) {
    const cacheKey = `dashboard:impressions:${org.id}:${period}`;
    const cached = await ioRedis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }

    const integrations =
      await this._dashboardRepository.getActiveIntegrations(org.id);

    const dateBuckets = new Map<string, number>();

    for (const integration of integrations) {
      try {
        const analytics: AnalyticsData[] =
          await this._integrationService.checkAnalytics(
            org,
            integration.id,
            '30'
          );

        for (const metric of analytics) {
          if (IMPRESSIONS_RE.test(metric.label)) {
            for (const point of metric.data) {
              const d = dayjs(point.date);
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
              dateBuckets.set(
                dateKey,
                (dateBuckets.get(dateKey) || 0) + Number(point.total || 0)
              );
            }
          }
        }
      } catch {
        // skip failed integrations
      }
    }

    const result = Array.from(dateBuckets.entries())
      .map(([date, impressions]) => ({ date, impressions }))
      .sort((a, b) => a.date.localeCompare(b.date));

    await ioRedis.set(cacheKey, JSON.stringify(result), 'EX', CACHE_TTL);
    return result;
  }

  async getPostEngagement(org: Organization, days: number = 30) {
    const cacheKey = `dashboard:post-engagement:${org.id}:${days}`;
    const cached = await ioRedis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }

    const [posts, activeIntegrations] = await Promise.all([
      this._dashboardRepository.getPublishedPostsWithRelease(org.id, days),
      this._dashboardRepository.getActiveIntegrations(org.id),
    ]);

    const totals = { views: 0, likes: 0, comments: 0, saves: 0 };
    const platformMap = new Map<
      string,
      { views: number; likes: number; comments: number; saves: number; post_count: number }
    >();

    // Pre-populate all connected platforms so they always appear in the result
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

    // Build integration lookup: integrationId -> full Integration object (with token)
    const integrationById = new Map<string, Integration>();
    for (const integration of activeIntegrations) {
      integrationById.set(integration.id, integration);
    }

    // Group posts by integrationId
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

    // Process each integration group
    for (const [integrationId, groupPosts] of postsByIntegration) {
      const fullIntegration = integrationById.get(integrationId);
      if (!fullIntegration) {
        postsFailed += groupPosts.length;
        continue;
      }

      const provider = this._integrationManager.getSocialIntegration(
        fullIntegration.providerIdentifier
      );

      // Batch path: provider supports batchPostAnalytics
      if (provider?.batchPostAnalytics) {
        const batchAnalytics = await this._processBatchAnalytics(
          org.id,
          fullIntegration,
          provider.batchPostAnalytics.bind(provider),
          groupPosts,
          days
        );

        for (const post of groupPosts) {
          const metrics = batchAnalytics.get(post.id);
          if (!metrics || metrics.length === 0) continue;

          const platformData = platformMap.get(post.platform);
          if (!platformData) continue;
          platformData.post_count++;
          this._accumulateMetrics(metrics, totals, platformData);
        }
      } else {
        // Fallback path: per-post calls with circuit breaker
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
              continue;
            }

            platformFailCount.set(post.platform, 0);
            const platformData = platformMap.get(post.platform);
            if (!platformData) continue;
            platformData.post_count++;
            this._accumulateMetrics(result.value, totals, platformData);
          }
        }
      }
    }

    const by_platform = Array.from(platformMap.entries()).map(
      ([platform, data]) => ({ platform, ...data })
    );

    const response = {
      totals,
      by_platform,
      meta: {
        posts_analyzed: posts.length - postsFailed,
        posts_failed: postsFailed,
        posts_total: posts.length,
        days,
      },
    };

    await ioRedis.set(cacheKey, JSON.stringify(response), 'EX', CACHE_TTL);
    return response;
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
