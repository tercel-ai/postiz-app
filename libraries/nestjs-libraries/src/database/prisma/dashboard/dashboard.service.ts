import { Injectable } from '@nestjs/common';
import { Organization } from '@prisma/client';
import dayjs from 'dayjs';
import isoWeek from 'dayjs/plugin/isoWeek';
import { DashboardRepository } from '@gitroom/nestjs-libraries/database/prisma/dashboard/dashboard.repository';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import { AnalyticsData } from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';

dayjs.extend(isoWeek);

const IMPRESSIONS_RE = /impression|views|page.views|reach/i;
const TRAFFICS_RE = /click|engagement|traffic/i;

const CACHE_TTL =
  !process.env.NODE_ENV || process.env.NODE_ENV === 'development' ? 1 : 3600;

@Injectable()
export class DashboardService {
  constructor(
    private _dashboardRepository: DashboardRepository,
    private _integrationService: IntegrationService
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

    for (const integration of integrations) {
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
            const total = metric.data.reduce(
              (sum, d) => sum + Number(d.total || 0),
              0
            );
            const platform = integration.providerIdentifier;
            platformValues.set(
              platform,
              (platformValues.get(platform) || 0) + total
            );
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
      ([platform, value]) => ({
        platform,
        value,
        percentage:
          grandTotal > 0
            ? Math.round((value / grandTotal) * 10000) / 100
            : 0,
        delta: 0,
      })
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
}
