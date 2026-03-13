import { Injectable } from '@nestjs/common';
import {
  PrismaRepository,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';

@Injectable()
export class PostReleaseRepository {
  constructor(
    private _postRelease: PrismaRepository<'postRelease'>,
    private _tx: PrismaTransaction
  ) {}

  createRelease(data: {
    postId: string;
    releaseId: string;
    releaseURL?: string;
    publishDate: Date;
    organizationId: string;
    integrationId: string;
    group: string;
  }) {
    return this._postRelease.model.postRelease.upsert({
      where: {
        postId_releaseId: {
          postId: data.postId,
          releaseId: data.releaseId,
        },
      },
      update: {
        releaseURL: data.releaseURL,
        publishDate: data.publishDate,
      },
      create: data,
    });
  }

  getReleasesForPost(postId: string) {
    return this._postRelease.model.postRelease.findMany({
      where: { postId },
      orderBy: { publishDate: 'desc' },
    });
  }

  getReleasesInDateRange(params: {
    postIds: string[];
    startDate: Date;
    endDate: Date;
  }) {
    return this._postRelease.model.postRelease.findMany({
      where: {
        postId: { in: params.postIds },
        publishDate: {
          gte: params.startDate,
          lte: params.endDate,
        },
      },
      orderBy: { publishDate: 'asc' },
    });
  }

  getRecentReleasesForOrg(orgId: string, sinceDays: number) {
    const since = new Date();
    since.setDate(since.getDate() - sinceDays);
    return this._postRelease.model.postRelease.findMany({
      where: {
        organizationId: orgId,
        publishDate: { gte: since },
      },
      orderBy: { publishDate: 'desc' },
    });
  }

  updateAnalytics(
    id: string,
    data: {
      impressions?: number;
      trafficScore?: number;
      analytics?: any;
    }
  ) {
    return this._postRelease.model.postRelease.update({
      where: { id },
      data,
    });
  }

  getLatestReleaseForPost(postId: string) {
    return this._postRelease.model.postRelease.findFirst({
      where: { postId },
      orderBy: { publishDate: 'desc' },
    });
  }

  async getReleasesForPostPaginated(
    postId: string,
    orgId: string,
    page: number,
    pageSize: number
  ) {
    const where = { postId, organizationId: orgId };
    const skip = (page - 1) * pageSize;

    const [data, total] = await Promise.all([
      this._postRelease.model.postRelease.findMany({
        where,
        orderBy: { publishDate: 'desc' },
        skip,
        take: pageSize,
      }),
      this._postRelease.model.postRelease.count({ where }),
    ]);

    return { data, total, page, pageSize };
  }

  batchUpdateAnalytics(
    updates: Array<{
      id: string;
      impressions?: number;
      trafficScore?: number;
      analytics?: any;
    }>
  ) {
    if (!updates.length) return Promise.resolve([]);
    const ops = updates.map((u) =>
      this._postRelease.model.postRelease.update({
        where: { id: u.id },
        data: {
          impressions: u.impressions,
          trafficScore: u.trafficScore,
          analytics: u.analytics,
        },
      })
    );
    return this._tx.model.$transaction(ops);
  }
}
