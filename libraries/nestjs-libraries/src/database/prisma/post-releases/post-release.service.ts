import { Injectable } from '@nestjs/common';
import { PostReleaseRepository } from './post-release.repository';

@Injectable()
export class PostReleaseService {
  constructor(private _postReleaseRepository: PostReleaseRepository) {}

  createRelease(data: {
    postId: string;
    releaseId: string;
    releaseURL?: string;
    publishDate: Date;
    organizationId: string;
    integrationId: string;
    group: string;
  }) {
    return this._postReleaseRepository.createRelease(data);
  }

  getReleasesForPost(postId: string) {
    return this._postReleaseRepository.getReleasesForPost(postId);
  }

  getReleasesInDateRange(params: {
    postIds: string[];
    startDate: Date;
    endDate: Date;
  }) {
    return this._postReleaseRepository.getReleasesInDateRange(params);
  }

  getRecentReleasesForOrg(orgId: string, sinceDays: number) {
    return this._postReleaseRepository.getRecentReleasesForOrg(orgId, sinceDays);
  }

  updateAnalytics(
    id: string,
    data: {
      impressions?: number;
      trafficScore?: number;
      analytics?: any;
    }
  ) {
    return this._postReleaseRepository.updateAnalytics(id, data);
  }

  getLatestReleaseForPost(postId: string) {
    return this._postReleaseRepository.getLatestReleaseForPost(postId);
  }
}
