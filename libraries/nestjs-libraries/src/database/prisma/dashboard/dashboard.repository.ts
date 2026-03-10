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

  getChannelCount(orgId: string) {
    return this._integration.model.integration.count({
      where: {
        organizationId: orgId,
        deletedAt: null,
        disabled: false,
      },
    });
  }

  getActiveIntegrations(orgId: string) {
    return this._integration.model.integration.findMany({
      where: {
        organizationId: orgId,
        deletedAt: null,
        disabled: false,
        type: 'social',
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

  getPublishedPostsWithRelease(orgId: string, sinceDays: number) {
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
