import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { Injectable } from '@nestjs/common';
import dayjs from 'dayjs';

@Injectable()
export class DashboardRepository {
  constructor(
    private _post: PrismaRepository<'post'>,
    private _integration: PrismaRepository<'integration'>
  ) {}

  getPostCount(orgId: string) {
    return this._post.model.post.count({
      where: {
        organizationId: orgId,
        deletedAt: null,
      },
    });
  }

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

  getPostsForTrend(orgId: string, sinceDays: number) {
    return this._post.model.post.findMany({
      where: {
        organizationId: orgId,
        deletedAt: null,
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
