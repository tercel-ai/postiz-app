import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import dayjs from 'dayjs';

@Injectable()
export class DashboardRepository {
  constructor(
    private _post: PrismaRepository<'post'>,
    private _integration: PrismaRepository<'integration'>
  ) {}

  getChannelCount(orgId: string, integrationId?: string[], channel?: string[]) {
    return this._integration.model.integration.count({
      where: {
        organizationId: orgId,
        deletedAt: null,
        disabled: false,
        ...(integrationId?.length && { id: { in: integrationId } }),
        ...(channel?.length && { providerIdentifier: { in: channel } }),
      },
    });
  }

  getActiveIntegrations(orgId: string, integrationId?: string[], channel?: string[]) {
    return this._integration.model.integration.findMany({
      where: {
        organizationId: orgId,
        deletedAt: null,
        disabled: false,
        type: 'social',
        ...(integrationId?.length && { id: { in: integrationId } }),
        ...(channel?.length && { providerIdentifier: { in: channel } }),
      },
    });
  }

  async getPostsStats(
    orgId: string,
    startDate?: Date,
    endDate?: Date,
    integrationId?: string[],
    channel?: string[]
  ) {
    const where: Prisma.PostWhereInput = {
      organizationId: orgId,
      deletedAt: null,
      parentPostId: null,
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

  countPublishedThisMonth(orgId: string, monthStart: Date) {
    return this._post.model.post.count({
      where: {
        organizationId: orgId,
        deletedAt: null,
        parentPostId: null,
        state: 'PUBLISHED',
        publishDate: { gte: monthStart },
      },
    });
  }

  getPublishedPostsWithRelease(orgId: string, sinceDays: number, integrationId?: string[], channel?: string[]) {
    return this._post.model.post.findMany({
      where: {
        organizationId: orgId,
        deletedAt: null,
        parentPostId: null,
        state: 'PUBLISHED',
        releaseId: { not: null },
        publishDate: {
          gte: dayjs().subtract(sinceDays, 'day').toDate(),
        },
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

  getPostsForTrend(orgId: string, sinceDays: number) {
    return this._post.model.post.findMany({
      where: {
        organizationId: orgId,
        deletedAt: null,
        parentPostId: null,
        publishDate: {
          gte: dayjs().subtract(sinceDays, 'day').toDate(),
        },
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
}
