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
  BatchPostAnalyticsResult,
} from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import { extractMetrics, stripSyntheticMetrics } from '@gitroom/nestjs-libraries/integrations/social/analytics.utils';
import { PostsRepository } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.repository';
import { timer } from '@gitroom/helpers/utils/timer';

dayjs.extend(utc);
dayjs.extend(isoWeek);

/** How many days of posts to fetch for analytics aggregation. */
const ANALYTICS_LOOKBACK_DAYS = 30;

/** Delay between API calls to different integrations (ms). */
const INTER_INTEGRATION_DELAY = 1000;

/** Delay between per-post analytics batches (ms). */
const INTER_BATCH_DELAY = 2000;

@Injectable()
export class DataTicksService {
  constructor(
    private _dataTicksRepository: DataTicksRepository,
    private _dashboardRepository: DashboardRepository,
    private _postsService: PostsService,
    private _integrationManager: IntegrationManager,
    private _refreshIntegrationService: RefreshIntegrationService,
    private _postsRepository: PostsRepository
  ) {}

  /**
   * Sync daily impressions + traffic snapshots for all orgs.
   * Called by the daily cron workflow at UTC 00:05.
   *
   * Note: Platform APIs return lifetime cumulative totals per post, not daily
   * increments. We store the cumulative sum across all posts per integration.
   * Traffic is a weighted engagement score computed from per-post metrics.
   * Frontend computes deltas if needed.
   */
  private static readonly ACCOUNT_METRICS_COOLDOWN = 3600; // 1 hour

  async syncAccountMetricsById(integrationId: string, skipCooldown = false): Promise<Record<string, number> | null> {
    if (!skipCooldown) {
      const cooldownKey = `account-metrics:cooldown:${integrationId}`;
      const locked = await ioRedis.get(cooldownKey);
      if (locked) return null;
      await ioRedis.set(cooldownKey, '1', 'EX', DataTicksService.ACCOUNT_METRICS_COOLDOWN);
    }

    const integration = await this._dashboardRepository.getIntegrationById(integrationId);
    if (!integration || integration.deletedAt || integration.disabled) {
      return null;
    }
    return this.syncSingleAccountMetrics(integration);
  }

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

    // Accumulate impressions and traffic only for integrations that have posts
    const integrationMetrics = new Map<
      string,
      { platform: string; impressions: number; traffic: number; postsAnalyzed: number }
    >();

    // How many days of analytics to request from the API.
    // Minimum 2 so that the target day is always within the API response window.
    const analyticsDays = Math.max(
      2,
      dayjs.utc().diff(dayjs.utc(dayStart), 'day') + 1
    );

    let integrationIndex = 0;
    for (const [intId, groupPosts] of postsByIntegration) {
      // Throttle between integrations to avoid rate limits
      if (integrationIndex++ > 0) {
        await timer(INTER_INTEGRATION_DELAY);
      }

      const fullIntegration = integrationById.get(intId);
      if (!fullIntegration) continue;

      // Find platform from the integration list (or from posts)
      const intEntry = integrations.find((i) => i.id === intId);
      const platform = intEntry?.platform ?? fullIntegration.providerIdentifier;

      if (!integrationMetrics.has(intId)) {
        integrationMetrics.set(intId, {
          platform,
          impressions: 0,
          traffic: 0,
          postsAnalyzed: 0,
        });
      }
      const accum = integrationMetrics.get(intId)!;

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
          fullIntegration,
          provider,
          groupPosts,
          analyticsDays
        );
      }

      for (const [, metrics] of postAnalytics) {
        // Strip synthetic metrics (e.g. Traffic appended by checkPostAnalytics)
        // before counting, so only real platform data drives postsAnalyzed.
        const realMetrics = stripSyntheticMetrics(metrics);
        if (!realMetrics.length) continue;
        accum.postsAnalyzed++;

        const { impressions, trafficScore } = extractMetrics(accum.platform, realMetrics);
        accum.impressions += impressions;
        if (trafficScore !== null) {
          accum.traffic += trafficScore;
        }
      }
    }

    // Only upsert DataTicks for integrations that actually have analyzed posts.
    // This avoids polluting the table with 0-value rows for integrations with no posts.
    const records = Array.from(integrationMetrics.entries())
      .filter(([, accum]) => accum.postsAnalyzed > 0)
      .flatMap(([intId, accum]) => [
        {
          organizationId: orgId,
          integrationId: intId,
          platform: accum.platform,
          type: 'impressions',
          timeUnit: 'day' as TimeUnit,
          statisticsTime: dayStart,
          value: BigInt(accum.impressions),
          postsAnalyzed: accum.postsAnalyzed,
        },
        {
          organizationId: orgId,
          integrationId: intId,
          platform: accum.platform,
          type: 'traffic',
          timeUnit: 'day' as TimeUnit,
          statisticsTime: dayStart,
          value: BigInt(Math.round(accum.traffic)),
          postsAnalyzed: accum.postsAnalyzed,
        },
      ]);

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

    // Sync analytics to individual Post records (each with its own releaseId)
    await this._syncPostAnalytics(orgId, integrationById, analyticsDays);

    // Sync account-level metrics (followers, etc.) to Integration records
    await this._syncAccountMetrics(fullIntegrations);

    return records.length;
  }

  /**
   * Sync analytics for all published Posts with releaseId.
   * For recurring posts, each clone has its own releaseId and gets
   * independent analytics from the platform API.
   */
  private async _syncPostAnalytics(
    orgId: string,
    integrationById: Map<string, Integration>,
    analyticsDays: number
  ) {
    const posts = await this._dashboardRepository.getPublishedPostsWithRelease(
      orgId,
      ANALYTICS_LOOKBACK_DAYS
    );

    if (!posts.length) return;

    // Group posts by integrationId
    const postsByIntegration = new Map<
      string,
      Array<{ id: string; releaseId: string; integrationId: string }>
    >();
    for (const post of posts) {
      if (!post.releaseId || !post.integrationId) continue;
      if (!postsByIntegration.has(post.integrationId)) {
        postsByIntegration.set(post.integrationId, []);
      }
      postsByIntegration.get(post.integrationId)!.push({
        id: post.id,
        releaseId: post.releaseId,
        integrationId: post.integrationId,
      });
    }

    const pendingUpdates: Array<{
      id: string;
      impressions?: number;
      trafficScore?: number;
      analytics?: any;
    }> = [];

    let postSyncIndex = 0;
    for (const [intId, intPosts] of postsByIntegration) {
      // Throttle between integrations
      if (postSyncIndex++ > 0) {
        await timer(INTER_INTEGRATION_DELAY);
      }

      const fullIntegration = integrationById.get(intId);
      if (!fullIntegration) continue;

      const provider = this._integrationManager.getSocialIntegration(
        fullIntegration.providerIdentifier
      );

      if (!provider?.postAnalytics) continue;

      let token = fullIntegration.token;
      if (dayjs(fullIntegration.tokenExpiration).isBefore(dayjs())) {
        try {
          const refreshed =
            await this._refreshIntegrationService.refresh(fullIntegration);
          if (refreshed === false) continue;
          token = refreshed.accessToken;
        } catch {
          continue;
        }
      }

      const platform = fullIntegration.providerIdentifier;

      if (provider.batchPostAnalytics) {
        try {
          const batchResult = await provider.batchPostAnalytics(
            fullIntegration.internalId,
            token,
            intPosts.map((p) => p.releaseId),
            analyticsDays
          );

          for (const post of intPosts) {
            const metrics = batchResult[post.releaseId] || [];
            if (!metrics.length) continue;

            const { impressions, trafficScore, rawMetrics } = extractMetrics(platform, metrics);
            // Only update if we got meaningful data — avoids overwriting valid
            // previous values with 0 when the API returns unrecognized labels.
            if (impressions > 0 || trafficScore !== null) {
              pendingUpdates.push({
                id: post.id,
                impressions,
                trafficScore: trafficScore ?? undefined,
                analytics: rawMetrics,
              });
            }
          }
        } catch (err) {
          console.error(`Post batch analytics error for integration ${intId}:`, err);
        }
      } else {
        const BATCH_SIZE = 5;
        for (let i = 0; i < intPosts.length; i += BATCH_SIZE) {
          // Throttle between batches
          if (i > 0) {
            await timer(INTER_BATCH_DELAY);
          }

          const batch = intPosts.slice(i, i + BATCH_SIZE);
          const results = await Promise.allSettled(
            batch.map((post) =>
              provider.postAnalytics!(
                fullIntegration.internalId,
                token,
                post.releaseId,
                analyticsDays
              )
            )
          );

          for (let j = 0; j < results.length; j++) {
            const r = results[j];
            if (r.status !== 'fulfilled' || !r.value?.length) continue;

            const { impressions, trafficScore, rawMetrics } = extractMetrics(platform, r.value);
            if (impressions > 0 || trafficScore !== null) {
              pendingUpdates.push({
                id: batch[j].id,
                impressions,
                trafficScore: trafficScore ?? undefined,
                analytics: rawMetrics,
              });
            }
          }
        }
      }
    }

    if (pendingUpdates.length > 0) {
      try {
        await this._postsRepository.batchUpdatePostAnalytics(pendingUpdates);
      } catch (e) {
        console.error(`Post batch analytics write error for org ${orgId}:`, e);
      }
    }
  }

  private async _syncAccountMetrics(integrations: Integration[]) {
    for (const integration of integrations) {
      try {
        await this.syncSingleAccountMetrics(integration);
      } catch (err) {
        console.error(
          `Account metrics error for integration ${integration.id}:`,
          err
        );
      }
    }
  }

  async syncSingleAccountMetrics(integration: Integration): Promise<Record<string, number> | null> {
    const provider = this._integrationManager.getSocialIntegration(
      integration.providerIdentifier
    );
    if (!provider?.accountMetrics) {
      return null;
    }

    let token = integration.token;
    if (dayjs(integration.tokenExpiration).isBefore(dayjs())) {
      const refreshed =
        await this._refreshIntegrationService.refresh(integration);
      if (refreshed === false) return null;
      token = refreshed.accessToken;
    }

    const metrics = await provider.accountMetrics(
      integration.internalId,
      token
    );
    if (!metrics || Object.keys(metrics).length === 0) return null;

    await this._dashboardRepository.updateAccountMetrics(
      integration.id,
      metrics
    );

    return metrics;
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
      const releaseIds = postsWithRelease.map((p) => p.releaseId);
      const batchResult = await batchPostAnalytics(
        integration.internalId,
        token,
        releaseIds,
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

  /**
   * Fetch per-post analytics by calling postAnalytics directly on the provider.
   * This avoids going through checkPostAnalytics which appends a synthetic
   * Traffic metric and uses Redis caching that can interfere with aggregation.
   */
  private async _fetchPerPostAnalytics(
    integration: Integration,
    provider: { postAnalytics?: (...args: any[]) => Promise<AnalyticsData[]> },
    posts: Array<{ id: string; releaseId: string | null; platform: string }>,
    days: number
  ): Promise<Map<string, AnalyticsData[]>> {
    const result = new Map<string, AnalyticsData[]>();

    if (!provider?.postAnalytics) return result;

    const postsWithRelease = posts.filter(
      (p): p is typeof p & { releaseId: string } => !!p.releaseId
    );
    if (!postsWithRelease.length) return result;

    // Refresh token if needed
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

    const BATCH_SIZE = 5;
    for (let i = 0; i < postsWithRelease.length; i += BATCH_SIZE) {
      // Throttle between batches to avoid rate limits
      if (i > 0) {
        await timer(INTER_BATCH_DELAY);
      }

      const batch = postsWithRelease.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map((post) =>
          provider.postAnalytics!(
            integration.internalId,
            token,
            post.releaseId,
            days
          )
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

  /** Get impressions time series. */
  async getImpressionsByPlatform(params: TimeSeriesQueryParams) {
    return this._queryTimeSeriesByType('impressions', params);
  }

  /** Get traffic time series (weighted engagement scores). */
  async getTrafficByPlatform(params: TimeSeriesQueryParams) {
    return this._queryTimeSeriesByType('traffic', params);
  }

  /** Get impressions summary per platform (latest snapshot per integration). */
  async getImpressionsSummaryByPlatform(params: SummaryQueryParams) {
    return this._querySummaryByType('impressions', params);
  }

  /** Get traffic summary per platform (latest snapshot per integration). */
  async getTrafficSummaryByPlatform(params: SummaryQueryParams) {
    return this._querySummaryByType('traffic', params);
  }

  // --- Shared query internals ---

  /**
   * Time series query: fetches ticks of the given type, groups by platform + period bucket.
   * For cumulative data, keeps the latest snapshot per (integration, bucket), then sums across integrations.
   */
  private async _queryTimeSeriesByType(
    type: string,
    params: TimeSeriesQueryParams
  ): Promise<Array<{ date: string; value: number; platform: string }>> {
    const defaultDays = params.period === 'monthly' ? 365 : params.period === 'weekly' ? 90 : ANALYTICS_LOOKBACK_DAYS;
    const startTime = params.startDate
      ? dayjs.utc(params.startDate).startOf('day').toDate()
      : dayjs.utc().subtract(defaultDays, 'day').startOf('day').toDate();
    const endTime = params.endDate
      ? dayjs.utc(params.endDate).endOf('day').toDate()
      : dayjs.utc().endOf('day').toDate();

    const ticks = await this._dataTicksRepository.query({
      organizationId: params.organizationId,
      type,
      timeUnit: 'day',
      startTime,
      endTime,
      integrationId: params.integrationId,
    });

    const filtered = params.channel?.length
      ? ticks.filter((t) => params.channel!.includes(t.platform))
      : ticks;

    // Step 1: For each (integration, bucket), keep the latest snapshot value.
    // Ticks are sorted ASC, so later entries overwrite earlier ones.
    const integrationBuckets = new Map<
      string,
      { platform: string; dateKey: string; value: number }
    >();
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

      integrationBuckets.set(`${tick.integrationId}|${dateKey}`, {
        platform: tick.platform,
        dateKey,
        value: Number(tick.value),
      });
    }

    // Step 2: Sum latest-per-integration values by (platform, bucket)
    const bucketMap = new Map<string, { date: string; value: number; platform: string }>();
    for (const [, { platform, dateKey, value }] of integrationBuckets) {
      const key = `${platform}|${dateKey}`;
      const existing = bucketMap.get(key);
      if (existing) {
        existing.value += value;
      } else {
        bucketMap.set(key, { date: dateKey, value, platform });
      }
    }

    const result = Array.from(bucketMap.values());
    result.sort((a, b) => a.date.localeCompare(b.date) || a.platform.localeCompare(b.platform));
    return result;
  }

  /**
   * Summary query: fetches ticks of the given type, picks latest snapshot per integration,
   * sums by platform, returns sorted array with percentages.
   */
  private async _querySummaryByType(
    type: string,
    params: SummaryQueryParams
  ) {
    const startTime = params.startDate
      ? dayjs.utc(params.startDate).startOf('day').toDate()
      : dayjs.utc().subtract(ANALYTICS_LOOKBACK_DAYS, 'day').startOf('day').toDate();
    const endTime = params.endDate
      ? dayjs.utc(params.endDate).endOf('day').toDate()
      : dayjs.utc().endOf('day').toDate();

    const ticks = await this._dataTicksRepository.query({
      organizationId: params.organizationId,
      type,
      timeUnit: 'day',
      startTime,
      endTime,
      integrationId: params.integrationId,
    });

    const filtered = params.channel?.length
      ? ticks.filter((t) => params.channel!.includes(t.platform))
      : ticks;

    // Latest snapshot per integration (ticks sorted ASC → later overwrites earlier)
    const latestByIntegration = new Map<string, { platform: string; value: number }>();
    for (const tick of filtered) {
      latestByIntegration.set(tick.integrationId, {
        platform: tick.platform,
        value: Number(tick.value),
      });
    }

    const platformTotal = new Map<string, number>();
    for (const [, { platform, value }] of latestByIntegration) {
      platformTotal.set(platform, (platformTotal.get(platform) || 0) + value);
    }

    const grandTotal = Array.from(platformTotal.values()).reduce((a, b) => a + b, 0);

    const result = Array.from(platformTotal.entries()).map(([platform, value]) => ({
      platform,
      value,
      percentage: grandTotal > 0 ? Math.round((value / grandTotal) * 10000) / 100 : 0,
    }));

    result.sort((a, b) => b.value - a.value);
    return result;
  }
}

// --- Query parameter types ---

interface TimeSeriesQueryParams {
  organizationId: string;
  period: 'daily' | 'weekly' | 'monthly';
  integrationId?: string[];
  channel?: string[];
  startDate?: Date;
  endDate?: Date;
}

interface SummaryQueryParams {
  organizationId: string;
  integrationId?: string[];
  channel?: string[];
  startDate?: Date;
  endDate?: Date;
}
