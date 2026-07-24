import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import dayjs from 'dayjs';
import { mergeAdditionalSettings } from '@gitroom/nestjs-libraries/database/prisma/integrations/additional-settings.utils';

@Injectable()
export class DashboardRepository {
  constructor(
    private _post: PrismaRepository<'post'>,
    private _integration: PrismaRepository<'integration'>
  ) { }

  getChannelCount(orgId: string, integrationId?: string[], channel?: string[], refreshNeeded?: boolean, projectId?: string) {
    return this._integration.model.integration.count({
      where: {
        organizationId: orgId,
        deletedAt: null,
        disabled: false,
        ...(integrationId?.length && { id: { in: integrationId } }),
        ...(channel?.length && { providerIdentifier: { in: channel } }),
        ...(refreshNeeded !== undefined && { refreshNeeded }),
        ...(projectId && {
          integrationProjects: { some: { projectId, disabled: false } },
        }),
      },
    });
  }

  getActiveIntegrations(orgId: string, integrationId?: string[], channel?: string[], projectId?: string) {
    return this._integration.model.integration.findMany({
      where: {
        organizationId: orgId,
        deletedAt: null,
        disabled: false,
        type: 'social',
        ...(integrationId?.length && { id: { in: integrationId } }),
        ...(channel?.length && { providerIdentifier: { in: channel } }),
        ...(projectId && {
          integrationProjects: { some: { projectId, disabled: false } },
        }),
      },
    });
  }

  async getPostsStats(
    orgId: string,
    startDate?: Date,
    endDate?: Date,
    integrationId?: string[],
    channel?: string[],
    projectId?: string
  ) {
    const where: Prisma.PostWhereInput = {
      organizationId: orgId,
      deletedAt: null,
      parentPostId: null,
      // Exclude Engage reply posts — they are tracked separately via EngageDataTicks
      source: { notIn: ['engage'] },
      ...(projectId && { projectId }),
      ...(integrationId?.length && { integrationId: { in: integrationId } }),
      ...(channel?.length && { integration: { providerIdentifier: { in: channel } } }),
    };

    if (startDate || endDate) {
      where.publishDate = {
        ...(startDate && { gte: startDate }),
        ...(endDate && { lte: endDate }),
      };
    }

    const stats = await this._post.model.post.groupBy({
      by: ['state'],
      where,
      _count: {
        _all: true,
      },
    });

    return stats;
  }

  async getImpressionsByPlatform(
    orgId: string,
    integrationId?: string[],
    channel?: string[],
    startDate?: Date,
    endDate?: Date,
    projectId?: string
  ): Promise<{ platform: string; value: number }[]> {
    const where: Prisma.PostWhereInput = {
      organizationId: orgId,
      deletedAt: null,
      parentPostId: null,
      source: { notIn: ['engage'] },
      impressions: { not: null },
      ...(projectId && { projectId }),
      ...(integrationId?.length && { integrationId: { in: integrationId } }),
      ...(channel?.length && { integration: { providerIdentifier: { in: channel } } }),
    };
    if (startDate || endDate) {
      where.publishDate = {
        ...(startDate && { gte: startDate }),
        ...(endDate && { lte: endDate }),
      };
    }
    const rows = await this._post.model.post.groupBy({
      by: ['integrationId'],
      where,
      _sum: { impressions: true },
    });
    const validRows = rows.filter((r) => r.integrationId != null);
    if (!validRows.length) return [];

    const integrationIds = validRows.map((r) => r.integrationId!);
    const integrationRecords = await this._integration.model.integration.findMany({
      where: { id: { in: integrationIds } },
      select: { id: true, providerIdentifier: true },
    });
    const platformMap = new Map(integrationRecords.map((i) => [i.id, i.providerIdentifier]));

    const byPlatform = new Map<string, number>();
    for (const row of validRows) {
      const platform = platformMap.get(row.integrationId!) ?? 'unknown';
      byPlatform.set(platform, (byPlatform.get(platform) ?? 0) + (row._sum.impressions ?? 0));
    }
    return Array.from(byPlatform.entries()).map(([platform, value]) => ({ platform, value }));
  }

  async getTrafficTotal(
    orgId: string,
    integrationId?: string[],
    channel?: string[],
    startDate?: Date,
    endDate?: Date,
    projectId?: string
  ): Promise<number> {
    const where: Prisma.PostWhereInput = {
      organizationId: orgId,
      deletedAt: null,
      parentPostId: null,
      source: { notIn: ['engage'] },
      trafficScore: { not: null },
      ...(projectId && { projectId }),
      ...(integrationId?.length && { integrationId: { in: integrationId } }),
      ...(channel?.length && { integration: { providerIdentifier: { in: channel } } }),
    };
    if (startDate || endDate) {
      where.publishDate = {
        ...(startDate && { gte: startDate }),
        ...(endDate && { lte: endDate }),
      };
    }
    const agg = await this._post.model.post.aggregate({ where, _sum: { trafficScore: true } });
    return agg._sum.trafficScore ?? 0;
  }

  /**
   * Post-level traffic summary by platform. Used for project-scoped `/traffics`
   * (DataTicks aggregates by integration with no project attribution, so a
   * channel shared across projects would leak other projects' traffic into
   * this project's total — see docs/dashboard-module.md § Project scoping).
   */
  async getTrafficByPlatform(
    orgId: string,
    integrationId?: string[],
    channel?: string[],
    startDate?: Date,
    endDate?: Date,
    projectId?: string
  ): Promise<{ platform: string; value: number }[]> {
    const where: Prisma.PostWhereInput = {
      organizationId: orgId,
      deletedAt: null,
      parentPostId: null,
      source: { notIn: ['engage'] },
      trafficScore: { not: null },
      ...(projectId && { projectId }),
      ...(integrationId?.length && { integrationId: { in: integrationId } }),
      ...(channel?.length && { integration: { providerIdentifier: { in: channel } } }),
    };
    if (startDate || endDate) {
      where.publishDate = {
        ...(startDate && { gte: startDate }),
        ...(endDate && { lte: endDate }),
      };
    }
    const rows = await this._post.model.post.groupBy({
      by: ['integrationId'],
      where,
      _sum: { trafficScore: true },
    });
    const validRows = rows.filter((r) => r.integrationId != null);
    if (!validRows.length) return [];

    const integrationIds = validRows.map((r) => r.integrationId!);
    const integrationRecords = await this._integration.model.integration.findMany({
      where: { id: { in: integrationIds } },
      select: { id: true, providerIdentifier: true },
    });
    const platformMap = new Map(integrationRecords.map((i) => [i.id, i.providerIdentifier]));

    const byPlatform = new Map<string, number>();
    for (const row of validRows) {
      const platform = platformMap.get(row.integrationId!) ?? 'unknown';
      byPlatform.set(platform, (byPlatform.get(platform) ?? 0) + Math.round(row._sum.trafficScore ?? 0));
    }
    return Array.from(byPlatform.entries()).map(([platform, value]) => ({ platform, value }));
  }

  /**
   * Raw posts with impressions, for project-scoped `/impressions` time-series
   * bucketing (done in DashboardService, which already carries the
   * timezone-aware date-bucketing helpers). Post-level, not DataTicks-backed —
   * see getTrafficByPlatform for why project scoping can't use DataTicks.
   */
  getPostsForImpressionsSeries(
    orgId: string,
    startDate: Date,
    endDate: Date,
    integrationId?: string[],
    channel?: string[],
    projectId?: string
  ) {
    return this._post.model.post.findMany({
      where: {
        organizationId: orgId,
        deletedAt: null,
        parentPostId: null,
        source: { notIn: ['engage'] },
        impressions: { not: null },
        publishDate: { gte: startDate, lte: endDate },
        ...(projectId && { projectId }),
        ...(integrationId?.length && { integrationId: { in: integrationId } }),
        ...(channel?.length && { integration: { providerIdentifier: { in: channel } } }),
      },
      select: {
        publishDate: true,
        impressions: true,
        integration: {
          select: {
            providerIdentifier: true,
          },
        },
      },
    });
  }

  getPublishedPostsWithRelease(orgId: string, sinceDays: number, integrationId?: string[], channel?: string[], projectId?: string) {
    return this._post.model.post.findMany({
      where: {
        organizationId: orgId,
        deletedAt: null,
        parentPostId: null,
        state: 'PUBLISHED',
        releaseId: { not: null },
        // Exclude Engage reply posts — they are aggregated separately via EngageDataTicks
        source: { notIn: ['engage'] },
        publishDate: {
          gte: dayjs().subtract(sinceDays, 'day').toDate(),
        },
        ...(projectId && { projectId }),
        ...(integrationId?.length && { integrationId: { in: integrationId } }),
        ...(channel?.length && { integration: { providerIdentifier: { in: channel } } }),
      },
      select: {
        id: true,
        releaseId: true,
        publishDate: true,
        integrationId: true,
        integration: {
          select: {
            id: true,
            providerIdentifier: true,
          },
        },
      },
      orderBy: { publishDate: 'desc' },
    });
  }

  getGlobalStats() {
    const last7Days = dayjs().subtract(7, 'day').toDate();
    return Promise.all([
      // [0] totalPosts
      this._post.model.post.count({ where: { deletedAt: null, parentPostId: null } }),
      // [1] postsByState
      this._post.model.post.groupBy({
        by: ['state'],
        where: { deletedAt: null, parentPostId: null },
        _count: { _all: true },
      }),
      // [2] totalIntegrations
      this._integration.model.integration.count({ where: { deletedAt: null } }),
      // [3] integrationsByPlatform
      this._integration.model.integration.groupBy({
        by: ['providerIdentifier'],
        where: { deletedAt: null },
        _count: { _all: true },
        orderBy: { _count: { providerIdentifier: 'desc' } },
      }),
      // [4] postsToday
      this._post.model.post.count({
        where: {
          deletedAt: null,
          parentPostId: null,
          createdAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
        },
      }),
      // [5] errorsLast7Days (ERROR state only)
      this._post.model.post.count({
        where: {
          deletedAt: null,
          parentPostId: null,
          state: 'ERROR',
          createdAt: { gte: last7Days },
        },
      }),
      // [6] postsLast7Days (all states, for error rate denominator)
      this._post.model.post.count({
        where: {
          deletedAt: null,
          parentPostId: null,
          createdAt: { gte: last7Days },
        },
      }),
    ]);
  }

  getPostsForTrend(orgId: string, sinceDays: number, projectId?: string) {
    return this._post.model.post.findMany({
      where: {
        organizationId: orgId,
        deletedAt: null,
        parentPostId: null,
        // Exclude Engage reply posts — they are tracked separately via EngageDataTicks
        source: { notIn: ['engage'] },
        publishDate: {
          gte: dayjs().subtract(sinceDays, 'day').toDate(),
        },
        ...(projectId && { projectId }),
      },
      select: {
        publishDate: true,
        integration: {
          select: {
            providerIdentifier: true,
          },
        },
      },
    });
  }

  getIntegrationById(id: string) {
    return this._integration.model.integration.findUnique({
      where: { id },
    });
  }

  async updateAccountMetrics(integrationId: string, metrics: Record<string, number>) {
    const integration = await this._integration.model.integration.findUnique({
      where: { id: integrationId },
      select: { additionalSettings: true },
    });
    if (!integration) return;

    const incoming = Object.entries(metrics).map(([key, value]) => ({
      title: `account:${key}`,
      description: key,
      type: 'readonly' as const,
      value,
    }));

    await this._integration.model.integration.update({
      where: { id: integrationId },
      data: { additionalSettings: mergeAdditionalSettings(integration.additionalSettings, incoming) },
    });
  }
}
