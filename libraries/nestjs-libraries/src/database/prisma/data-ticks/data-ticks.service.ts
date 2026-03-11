import { Injectable } from '@nestjs/common';
import { Integration } from '@prisma/client';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import isoWeek from 'dayjs/plugin/isoWeek';
import { DataTicksRepository, TimeUnit } from './data-ticks.repository';
import { DashboardRepository } from '@gitroom/nestjs-libraries/database/prisma/dashboard/dashboard.repository';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import { IntegrationManager } from '@gitroom/nestjs-libraries/integrations/integration.manager';
import { RefreshIntegrationService } from '@gitroom/nestjs-libraries/integrations/refresh.integration.service';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';
import {
  AnalyticsData,
  AuthTokenDetails,
  BatchPostAnalyticsResult,
} from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';

dayjs.extend(utc);
dayjs.extend(isoWeek);

/**
 * Per-platform mapping: which API label(s) represent total impressions/exposure.
 * All labels are matched case-insensitively.
 *
 * X:          "Impressions"
 * YouTube:    "Views"
 * Threads:    "Views"
 * Pinterest:  "Impressions"
 * Instagram:  "Impressions"
 * LinkedIn:   "Impressions" (not "Unique Impressions" to avoid double-counting)
 * Facebook:   "Impressions"
 */
const IMPRESSIONS_LABELS: Record<string, Set<string>> = {
  x:                     new Set(['impressions']),
  youtube:               new Set(['views']),
  threads:               new Set(['views']),
  pinterest:             new Set(['impressions']),
  instagram:             new Set(['impressions']),
  'instagram-standalone': new Set(['impressions']),
  facebook:              new Set(['impressions']),
  linkedin:              new Set(['impressions']),
  'linkedin-page':       new Set(['impressions']),
};

/** Fallback: if platform not in map, try these common labels. */
const IMPRESSIONS_FALLBACK = new Set(['impressions', 'views']);

function isImpressionsLabel(platform: string, label: string): boolean {
  const platformLabels = IMPRESSIONS_LABELS[platform.toLowerCase()];
  if (platformLabels) {
    return platformLabels.has(label.toLowerCase());
  }
  return IMPRESSIONS_FALLBACK.has(label.toLowerCase());
}

/** How many days of posts to fetch for analytics aggregation. */
const ANALYTICS_LOOKBACK_DAYS = 30;

@Injectable()
export class DataTicksService {
  constructor(
    private _dataTicksRepository: DataTicksRepository,
    private _dashboardRepository: DashboardRepository,
    private _postsService: PostsService,
    private _integrationManager: IntegrationManager,
    private _refreshIntegrationService: RefreshIntegrationService
  ) {}

  /**
   * Sync daily impressions for all orgs.
   * Called by the daily cron workflow at UTC 00:05 for the previous day.
   */
  async syncDailyTicks(targetDate?: Date) {
    const date = targetDate
      ? dayjs.utc(targetDate).startOf('day')
      : dayjs.utc().subtract(1, 'day').startOf('day');

    const integrationsByOrg =
      await this._dataTicksRepository.getAllActiveIntegrationsByOrg();

    let totalUpserted = 0;
    let totalErrors = 0;

    for (const [orgId, integrations] of integrationsByOrg) {
      try {
        const count = await this._syncOrgDailyTicks(
          orgId,
          integrations,
          date.toDate()
        );
        totalUpserted += count;
      } catch (err) {
        totalErrors++;
        console.error(`DataTicks sync error for org ${orgId}:`, err);
      }
    }

    console.log(
      `DataTicks daily sync complete for ${date.format('YYYY-MM-DD')}: ` +
        `${totalUpserted} ticks upserted, ${totalErrors} org errors`
    );

    return { date: date.toISOString(), totalUpserted, totalErrors };
  }

  private async _syncOrgDailyTicks(
    orgId: string,
    integrations: Array<{ id: string; platform: string }>,
    dayStart: Date
  ): Promise<number> {
    // Calculate lookback relative to now so the repository query works for backfill too.
    const daysFromNow = Math.max(
      ANALYTICS_LOOKBACK_DAYS,
      dayjs.utc().diff(dayjs.utc(dayStart), 'day') + ANALYTICS_LOOKBACK_DAYS
    );

    // Fetch all recently-published posts (analytics come from all posts, not
    // just those published on the target day).
    const posts = await this._dashboardRepository.getPublishedPostsWithRelease(
      orgId,
      daysFromNow
    );

    // Group posts by integration
    const postsByIntegration = new Map<
      string,
      Array<{ id: string; releaseId: string | null; platform: string }>
    >();
    for (const post of posts) {
      const intId = post.integrationId;
      if (!intId || !post.releaseId) continue;
      if (!postsByIntegration.has(intId)) {
        postsByIntegration.set(intId, []);
      }
      postsByIntegration.get(intId)!.push({
        id: post.id,
        releaseId: post.releaseId,
        platform: post.integration?.providerIdentifier ?? 'unknown',
      });
    }

    // Full integration records for token access
    const fullIntegrations =
      await this._dashboardRepository.getActiveIntegrations(orgId);
    const integrationById = new Map(
      fullIntegrations.map((i) => [i.id, i])
    );

    // Accumulate impressions per integration
    const integrationImpressions = new Map<
      string,
      { platform: string; impressions: number; postsAnalyzed: number }
    >();

    // Initialize all integrations (explicit zero if no posts)
    for (const int of integrations) {
      integrationImpressions.set(int.id, {
        platform: int.platform,
        impressions: 0,
        postsAnalyzed: 0,
      });
    }

    // How many days of analytics to request from the API.
    // Minimum 2 so that the target day is always within the API response window.
    const analyticsDays = Math.max(
      2,
      dayjs.utc().diff(dayjs.utc(dayStart), 'day') + 1
    );

    for (const [intId, groupPosts] of postsByIntegration) {
      const fullIntegration = integrationById.get(intId);
      if (!fullIntegration) continue;

      const accum = integrationImpressions.get(intId);
      if (!accum) continue;

      const provider = this._integrationManager.getSocialIntegration(
        fullIntegration.providerIdentifier
      );

      let postAnalytics: Map<string, AnalyticsData[]>;

      if (provider?.batchPostAnalytics) {
        postAnalytics = await this._fetchBatchAnalytics(
          fullIntegration,
          provider.batchPostAnalytics.bind(provider),
          groupPosts,
          analyticsDays
        );
      } else {
        postAnalytics = await this._fetchPerPostAnalytics(
          orgId,
          groupPosts,
          analyticsDays
        );
      }

      for (const [, metrics] of postAnalytics) {
        if (!metrics.length) continue;
        accum.postsAnalyzed++;

        for (const metric of metrics) {
          if (!isImpressionsLabel(accum.platform, metric.label)) continue;

          // Sum only data points that fall within the target day
          for (const point of metric.data) {
            if (dayjs.utc(point.date).isSame(dayStart, 'day')) {
              accum.impressions += Number(point.total || 0);
            }
          }
        }
      }
    }

    // Upsert one tick per integration (type = "impressions")
    const records = Array.from(integrationImpressions.entries()).map(
      ([intId, accum]) => ({
        organizationId: orgId,
        integrationId: intId,
        platform: accum.platform,
        type: 'impressions',
        timeUnit: 'day' as TimeUnit,
        statisticsTime: dayStart,
        value: BigInt(accum.impressions),
        postsAnalyzed: accum.postsAnalyzed,
      })
    );

    if (records.length > 0) {
      await this._dataTicksRepository.upsertMany(records);

      // Invalidate dashboard cache so new data is visible immediately
      const cacheKeys = await ioRedis.keys(`dashboard:impressions:${orgId}:*`);
      const trafficKeys = await ioRedis.keys(`dashboard:traffics:${orgId}:*`);
      const summaryKeys = await ioRedis.keys(`dashboard:summary:${orgId}:*`);
      const allKeys = [...cacheKeys, ...trafficKeys, ...summaryKeys];
      if (allKeys.length > 0) {
        await ioRedis.del(...allKeys);
      }
    }

    return records.length;
  }

  private async _fetchBatchAnalytics(
    integration: Integration,
    batchPostAnalytics: (
      integrationId: string,
      accessToken: string,
      postIds: string[],
      fromDate: number
    ) => Promise<BatchPostAnalyticsResult>,
    posts: Array<{ id: string; releaseId: string | null; platform: string }>,
    days: number
  ): Promise<Map<string, AnalyticsData[]>> {
    const result = new Map<string, AnalyticsData[]>();
    const postsWithRelease = posts.filter(
      (p): p is typeof p & { releaseId: string } => !!p.releaseId
    );

    if (!postsWithRelease.length) return result;

    let token = integration.token;
    if (dayjs(integration.tokenExpiration).isBefore(dayjs())) {
      try {
        const refreshed =
          await this._refreshIntegrationService.refresh(integration);
        if (refreshed === false) return result;
        token = refreshed.accessToken;
      } catch {
        return result;
      }
    }

    try {
      const batchResult = await batchPostAnalytics(
        integration.internalId,
        token,
        postsWithRelease.map((p) => p.releaseId),
        days
      );
      for (const post of postsWithRelease) {
        result.set(post.id, batchResult[post.releaseId] || []);
      }
    } catch (err) {
      console.error('DataTicks batch analytics error:', err);
    }

    return result;
  }

  private async _fetchPerPostAnalytics(
    orgId: string,
    posts: Array<{ id: string; releaseId: string | null; platform: string }>,
    days: number
  ): Promise<Map<string, AnalyticsData[]>> {
    const result = new Map<string, AnalyticsData[]>();
    const BATCH_SIZE = 5;

    for (let i = 0; i < posts.length; i += BATCH_SIZE) {
      const batch = posts.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map((post) =>
          this._postsService.checkPostAnalytics(orgId, post.id, days)
        )
      );

      for (let j = 0; j < results.length; j++) {
        const r = results[j];
        const post = batch[j];
        if (r.status === 'fulfilled' && r.value?.length) {
          result.set(post.id, r.value);
        } else {
          result.set(post.id, []);
        }
      }
    }

    return result;
  }

  // --- Query methods for dashboard ---

  /**
   * Get impressions time series.
   * - No channel filter → { x: [{date,value}], instagram: [{date,value}] }
   * - With channel filter → [{date,value}]
   */
  async getImpressionsByPlatform(params: {
    organizationId: string;
    period: 'daily' | 'weekly' | 'monthly';
    integrationId?: string[];
    channel?: string[];
  }): Promise<
    Record<string, Array<{ date: string; value: number }>> |
    Array<{ date: string; value: number }>
  > {
    const days = params.period === 'monthly' ? 365 : params.period === 'weekly' ? 90 : ANALYTICS_LOOKBACK_DAYS;
    const startTime = dayjs.utc().subtract(days, 'day').startOf('day').toDate();
    const endTime = dayjs.utc().endOf('day').toDate();

    const ticks = await this._dataTicksRepository.query({
      organizationId: params.organizationId,
      type: 'impressions',
      timeUnit: 'day',
      startTime,
      endTime,
      integrationId: params.integrationId,
    });

    const filtered = params.channel?.length
      ? ticks.filter((t) => params.channel!.includes(t.platform))
      : ticks;

    // Roll up: group by platform + period bucket
    const platformBuckets = new Map<string, Map<string, number>>();
    for (const tick of filtered) {
      const d = dayjs.utc(tick.statisticsTime);
      let dateKey: string;
      switch (params.period) {
        case 'weekly':
          dateKey = d.isoWeekday(1).format('YYYY-MM-DD');
          break;
        case 'monthly':
          dateKey = d.format('YYYY-MM');
          break;
        default:
          dateKey = d.format('YYYY-MM-DD');
      }

      if (!platformBuckets.has(tick.platform)) {
        platformBuckets.set(tick.platform, new Map());
      }
      const dateBuckets = platformBuckets.get(tick.platform)!;
      dateBuckets.set(dateKey, (dateBuckets.get(dateKey) || 0) + Number(tick.value));
    }

    // Build sorted arrays per platform
    const byPlatform: Record<string, Array<{ date: string; value: number }>> = {};
    for (const [platform, dateBuckets] of platformBuckets) {
      byPlatform[platform] = Array.from(dateBuckets.entries())
        .map(([date, value]) => ({ date, value }))
        .sort((a, b) => a.date.localeCompare(b.date));
    }

    // Single channel filter → flat array (empty array if no data)
    if (params.channel?.length === 1) {
      return byPlatform[params.channel[0]] || [];
    }

    return byPlatform;
  }

  /**
   * Get impressions totals per platform (for traffics/distribution view).
   * Returns total, percentage, and half-period delta.
   */
  async getImpressionsSummaryByPlatform(params: {
    organizationId: string;
    integrationId?: string[];
    channel?: string[];
  }) {
    const startTime = dayjs.utc().subtract(ANALYTICS_LOOKBACK_DAYS, 'day').startOf('day').toDate();
    const endTime = dayjs.utc().endOf('day').toDate();
    const midDate = dayjs.utc().subtract(Math.floor(ANALYTICS_LOOKBACK_DAYS / 2), 'day');

    const ticks = await this._dataTicksRepository.query({
      organizationId: params.organizationId,
      type: 'impressions',
      timeUnit: 'day',
      startTime,
      endTime,
      integrationId: params.integrationId,
    });

    const filtered = params.channel?.length
      ? ticks.filter((t) => params.channel!.includes(t.platform))
      : ticks;

    const platformTotal = new Map<string, number>();
    const platformRecent = new Map<string, number>();
    const platformOlder = new Map<string, number>();

    for (const tick of filtered) {
      const val = Number(tick.value);
      const platform = tick.platform;
      platformTotal.set(platform, (platformTotal.get(platform) || 0) + val);

      if (dayjs.utc(tick.statisticsTime).isAfter(midDate)) {
        platformRecent.set(platform, (platformRecent.get(platform) || 0) + val);
      } else {
        platformOlder.set(platform, (platformOlder.get(platform) || 0) + val);
      }
    }

    const grandTotal = Array.from(platformTotal.values()).reduce((a, b) => a + b, 0);

    const result = Array.from(platformTotal.entries()).map(([platform, value]) => {
      const recent = platformRecent.get(platform) || 0;
      const older = platformOlder.get(platform) || 0;
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
    });

    result.sort((a, b) => b.value - a.value);
    return result;
  }
}
