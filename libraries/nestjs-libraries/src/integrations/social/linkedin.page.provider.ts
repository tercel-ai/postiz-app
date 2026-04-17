import {
  AccountMetrics,
  AnalyticsData,
  AuthTokenDetails,
  BatchPostAnalyticsResult,
  PostDetails,
  PostResponse,
  SocialProvider,
} from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import { makeId } from '@gitroom/nestjs-libraries/services/make.is';
import { LinkedinProvider } from '@gitroom/nestjs-libraries/integrations/social/linkedin.provider';
import dayjs from 'dayjs';
import { Integration } from '@prisma/client';
import { Plug } from '@gitroom/helpers/decorators/plug.decorator';
import { timer } from '@gitroom/helpers/utils/timer';
import { Rules } from '@gitroom/nestjs-libraries/chat/rules.description.decorator';

@Rules(
  'LinkedIn can have maximum one attachment when selecting video, when choosing a carousel on LinkedIn minimum amount of attachment must be two, and only pictures, if uploading a video, LinkedIn can have only one attachment'
)
export class LinkedinPageProvider
  extends LinkedinProvider
  implements SocialProvider
{
  override identifier = 'linkedin-page';
  override name = 'LinkedIn Page';
  override isBetweenSteps = true;
  override refreshWait = true;
  override maxConcurrentJob = 2; // LinkedIn Page has professional posting limits
  override scopes = [
    'openid',
    'profile',
    'w_member_social',
    'email',
    'rw_organization_admin',
    'w_organization_social',
    'r_organization_social',
  ];

  /**
   * LinkedIn Page internalId must be a numeric organization ID.
   * Personal profile IDs (e.g. "p_Eqrb3Fz486") are not valid for
   * organization API endpoints and will cause 400 errors.
   */
  private _isValidOrgId(id: string): boolean {
    return /^\d+$/.test(id);
  }

  override editor = 'normal' as const;

  override async refreshToken(
    refresh_token: string
  ): Promise<AuthTokenDetails> {
    const {
      access_token: accessToken,
      expires_in,
      refresh_token: refreshToken,
    } = await (
      await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token,
          client_id: process.env.LINKEDIN_CLIENT_ID!,
          client_secret: process.env.LINKEDIN_CLIENT_SECRET!,
        }),
      })
    ).json();

    const { vanityName } = await (
      await fetch('https://api.linkedin.com/v2/me', {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      })
    ).json();

    const {
      name,
      sub: id,
      picture,
    } = await (
      await fetch('https://api.linkedin.com/v2/userinfo', {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      })
    ).json();

    return {
      id,
      accessToken,
      refreshToken,
      expiresIn: expires_in,
      name,
      picture,
      username: vanityName,
    };
  }

  override async addComment(
    integration: Integration,
    originalIntegration: Integration,
    postId: string,
    information: any,
  ) {
    return super.addComment(
      integration,
      originalIntegration,
      postId,
      information,
      false
    );
  }

  override async repostPostUsers(
    integration: Integration,
    originalIntegration: Integration,
    postId: string,
    information: any
  ) {
    return super.repostPostUsers(
      integration,
      originalIntegration,
      postId,
      information,
      false
    );
  }

  override async generateAuthUrl() {
    const state = makeId(6);
    const codeVerifier = makeId(30);
    const url = `https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=${
      process.env.LINKEDIN_CLIENT_ID
    }&redirect_uri=${encodeURIComponent(
      `${process.env.FRONTEND_URL}/integrations/social/linkedin-page`
    )}&state=${state}&scope=${encodeURIComponent(this.scopes.join(' '))}`;
    return {
      url,
      codeVerifier,
      state,
    };
  }

  async companies(accessToken: string) {
    const { elements, ...all } = await (
      await fetch(
        'https://api.linkedin.com/v2/organizationalEntityAcls?q=roleAssignee&role=ADMINISTRATOR&projection=(elements*(organizationalTarget~(localizedName,vanityName,logoV2(original~:playableStreams))))',
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'X-Restli-Protocol-Version': '2.0.0',
            'LinkedIn-Version': '202501',
          },
        }
      )
    ).json();

    return (elements || [])
      .map((e: any) => ({
        id: e.organizationalTarget.split(':').pop(),
        page: e.organizationalTarget.split(':').pop(),
        username: e['organizationalTarget~'].vanityName,
        name: e['organizationalTarget~'].localizedName,
        picture:
          e['organizationalTarget~'].logoV2?.['original~']?.elements?.[0]
            ?.identifiers?.[0]?.identifier,
      }))
      .filter((c: any) => this._isValidOrgId(c.id));
  }

  async reConnect(
    id: string,
    requiredId: string,
    accessToken: string
  ): Promise<Omit<AuthTokenDetails, 'refreshToken' | 'expiresIn'>> {
    const information = await this.fetchPageInformation(accessToken, {
      page: requiredId,
    });

    return {
      id: information.id,
      name: information.name,
      accessToken: information.access_token,
      picture: information.picture,
      username: information.username,
    };
  }

  async fetchPageInformation(accessToken: string, params: { page: string }) {
    const pageId = params.page;

    if (!this._isValidOrgId(pageId)) {
      throw new Error(
        `Invalid LinkedIn Page: "${pageId}" is not an organization. Personal accounts should use the LinkedIn (personal) integration instead.`
      );
    }

    const data = await (
      await fetch(
        `https://api.linkedin.com/v2/organizations/${pageId}?projection=(id,localizedName,vanityName,logoV2(original~:playableStreams))`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        }
      )
    ).json();

    if (!data?.id || !this._isValidOrgId(String(data.id))) {
      throw new Error(
        `LinkedIn API returned a non-organization ID (${data?.id}). This account cannot be added as a LinkedIn Page.`
      );
    }

    return {
      id: data.id,
      name: data.localizedName,
      access_token: accessToken,
      picture:
        data?.logoV2?.['original~']?.elements?.[0]?.identifiers?.[0].identifier,
      username: data.vanityName,
    };
  }

  override async authenticate(params: {
    code: string;
    codeVerifier: string;
    refresh?: string;
  }) {
    const body = new URLSearchParams();
    body.append('grant_type', 'authorization_code');
    body.append('code', params.code);
    body.append(
      'redirect_uri',
      `${process.env.FRONTEND_URL}/integrations/social/linkedin-page`
    );
    body.append('client_id', process.env.LINKEDIN_CLIENT_ID!);
    body.append('client_secret', process.env.LINKEDIN_CLIENT_SECRET!);

    const {
      access_token: accessToken,
      expires_in: expiresIn,
      refresh_token: refreshToken,
      scope,
    } = await (
      await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      })
    ).json();

    this.checkScopes(this.scopes, scope);

    const {
      name,
      sub: id,
      picture,
    } = await (
      await fetch('https://api.linkedin.com/v2/userinfo', {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      })
    ).json();

    const { vanityName } = await (
      await fetch('https://api.linkedin.com/v2/me', {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      })
    ).json();

    return {
      id: `p_${id}`,
      accessToken,
      refreshToken,
      expiresIn,
      name,
      picture,
      username: vanityName,
    };
  }

  override async post(
    id: string,
    accessToken: string,
    postDetails: PostDetails[],
    integration: Integration
  ): Promise<PostResponse[]> {
    return super.post(id, accessToken, postDetails, integration, 'company');
  }

  override async comment(
    id: string,
    postId: string,
    lastCommentId: string | undefined,
    accessToken: string,
    postDetails: PostDetails[],
    integration: Integration
  ): Promise<PostResponse[]> {
    return super.comment(
      id,
      postId,
      lastCommentId,
      accessToken,
      postDetails,
      integration,
      'company'
    );
  }

  async analytics(
    id: string,
    accessToken: string,
    date: number
  ): Promise<AnalyticsData[]> {
    const endDate = dayjs().unix() * 1000;
    const startDate = dayjs().subtract(date, 'days').unix() * 1000;

    const { elements }: { elements: Root[]; paging: any } = await (
      await fetch(
        `https://api.linkedin.com/v2/organizationPageStatistics?q=organization&organization=${encodeURIComponent(
          `urn:li:organization:${id}`
        )}&timeIntervals=(timeRange:(start:${startDate},end:${endDate}),timeGranularityType:DAY)`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Linkedin-Version': '202511',
            'X-Restli-Protocol-Version': '2.0.0',
          },
        }
      )
    ).json();

    const { elements: elements2 }: { elements: Root[]; paging: any } = await (
      await fetch(
        `https://api.linkedin.com/v2/organizationalEntityFollowerStatistics?q=organizationalEntity&organizationalEntity=${encodeURIComponent(
          `urn:li:organization:${id}`
        )}&timeIntervals=(timeRange:(start:${startDate},end:${endDate}),timeGranularityType:DAY)`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Linkedin-Version': '202511',
            'X-Restli-Protocol-Version': '2.0.0',
          },
        }
      )
    ).json();

    const { elements: elements3 }: { elements: Root[]; paging: any } = await (
      await fetch(
        `https://api.linkedin.com/v2/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=${encodeURIComponent(
          `urn:li:organization:${id}`
        )}&timeIntervals=(timeRange:(start:${startDate},end:${endDate}),timeGranularityType:DAY)`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Linkedin-Version': '202511',
            'X-Restli-Protocol-Version': '2.0.0',
          },
        }
      )
    ).json();

    const analytics = [...elements2, ...elements, ...elements3].reduce(
      (all, current) => {
        if (
          typeof current?.totalPageStatistics?.views?.allPageViews
            ?.pageViews !== 'undefined'
        ) {
          all['Page Views'].push({
            total: current.totalPageStatistics.views.allPageViews.pageViews,
            date: dayjs(current.timeRange.start).format('YYYY-MM-DD'),
          });
        }

        if (
          typeof current?.followerGains?.organicFollowerGain !== 'undefined'
        ) {
          all['Organic Followers'].push({
            total: current?.followerGains?.organicFollowerGain,
            date: dayjs(current.timeRange.start).format('YYYY-MM-DD'),
          });
        }

        if (typeof current?.followerGains?.paidFollowerGain !== 'undefined') {
          all['Paid Followers'].push({
            total: current?.followerGains?.paidFollowerGain,
            date: dayjs(current.timeRange.start).format('YYYY-MM-DD'),
          });
        }

        if (typeof current?.totalShareStatistics !== 'undefined') {
          all['Clicks'].push({
            total: current?.totalShareStatistics.clickCount,
            date: dayjs(current.timeRange.start).format('YYYY-MM-DD'),
          });

          all['Shares'].push({
            total: current?.totalShareStatistics.shareCount,
            date: dayjs(current.timeRange.start).format('YYYY-MM-DD'),
          });

          all['Engagement'].push({
            total: current?.totalShareStatistics.engagement,
            date: dayjs(current.timeRange.start).format('YYYY-MM-DD'),
          });

          all['Comments'].push({
            total: current?.totalShareStatistics.commentCount,
            date: dayjs(current.timeRange.start).format('YYYY-MM-DD'),
          });
        }

        return all;
      },
      {
        'Page Views': [] as any[],
        Clicks: [] as any[],
        Shares: [] as any[],
        Engagement: [] as any[],
        Comments: [] as any[],
        'Organic Followers': [] as any[],
        'Paid Followers': [] as any[],
      }
    );

    return Object.keys(analytics).map((key) => ({
      label: key,
      data: analytics[
        key as 'Page Views' | 'Organic Followers' | 'Paid Followers'
      ],
      percentageChange: 5,
    }));
  }

  override async postAnalytics(
    integrationId: string,
    accessToken: string,
    postId: string,
    date: number
  ): Promise<AnalyticsData[]> {
    if (!this._isValidOrgId(integrationId)) return [];

    const endDate = dayjs().unix() * 1000;
    const startDate = dayjs().subtract(date, 'days').unix() * 1000;

    // Fetch share statistics for the specific post
    const shareStatsUrl = `https://api.linkedin.com/v2/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=${encodeURIComponent(
      `urn:li:organization:${integrationId}`
    )}&shares=List(${encodeURIComponent(postId)})&timeIntervals=(timeRange:(start:${startDate},end:${endDate}),timeGranularityType:DAY)`;

    const { elements: shareElements }: { elements: PostShareStatElement[] } =
      await (
        await this.fetch(shareStatsUrl, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'LinkedIn-Version': '202511',
            'X-Restli-Protocol-Version': '2.0.0',
          },
        })
      ).json();

    // Also fetch social actions (likes, comments, shares) for the specific post
    let socialActions: SocialActionsResponse | null = null;
    try {
      const socialActionsUrl = `https://api.linkedin.com/v2/socialActions/${encodeURIComponent(
        postId
      )}`;
      socialActions = await (
        await this.fetch(socialActionsUrl, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'LinkedIn-Version': '202511',
            'X-Restli-Protocol-Version': '2.0.0',
          },
        })
      ).json();
    } catch (e) {
      // Social actions may not be available for all posts
    }

    // Process share statistics into time series data
    const todayForAgg = dayjs().format('YYYY-MM-DD');
    const analytics = (shareElements || []).reduce(
      (all, current) => {
        if (typeof current?.totalShareStatistics !== 'undefined') {
          // LinkedIn occasionally returns an aggregate element without
          // `timeRange` even when the request specified `timeGranularityType:DAY`
          // (e.g. when no per-day buckets match the filter). Fall back to
          // today's date so the downstream consumer still gets a valid entry.
          const dateStr = current.timeRange
            ? dayjs(current.timeRange.start).format('YYYY-MM-DD')
            : todayForAgg;

          all['Impressions'].push({
            total: current.totalShareStatistics.impressionCount || 0,
            date: dateStr,
          });

          all['Unique Impressions'].push({
            total: current.totalShareStatistics.uniqueImpressionsCount || 0,
            date: dateStr,
          });

          all['Clicks'].push({
            total: current.totalShareStatistics.clickCount || 0,
            date: dateStr,
          });

          all['Likes'].push({
            total: current.totalShareStatistics.likeCount || 0,
            date: dateStr,
          });

          all['Comments'].push({
            total: current.totalShareStatistics.commentCount || 0,
            date: dateStr,
          });

          all['Shares'].push({
            total: current.totalShareStatistics.shareCount || 0,
            date: dateStr,
          });

          all['Engagement'].push({
            total: current.totalShareStatistics.engagement || 0,
            date: dateStr,
          });
        }
        return all;
      },
      {
        Impressions: [] as { total: number; date: string }[],
        'Unique Impressions': [] as { total: number; date: string }[],
        Clicks: [] as { total: number; date: string }[],
        Likes: [] as { total: number; date: string }[],
        Comments: [] as { total: number; date: string }[],
        Shares: [] as { total: number; date: string }[],
        Engagement: [] as { total: number; date: string }[],
      }
    );

    // Supplement Likes/Comments with socialActions when share statistics either
    // returned no data OR reports all-zero values for those two fields.
    //
    // `organizationalEntityShareStatistics` has a 24-48h aggregation delay and
    // only reports engagement that falls inside the requested `timeRange`, so a
    // fresh post — or one whose reactions happened before the window — can
    // yield shareStats likeCount=0 even when the post actually has reactions
    // visible on LinkedIn. `/v2/socialActions/{urn}` returns the post's current
    // cumulative totals and is authoritative for Likes and Comments.
    //
    // Impressions / Clicks / Shares / Engagement are NOT supplemented because
    // socialActions does not provide them and we prefer the time-series
    // resolution from share statistics for those fields.
    if (socialActions) {
      const today = dayjs().format('YYYY-MM-DD');
      // Note: when a supplement fires, a multi-day zero series like
      // [{0,d1},{0,d2},{0,d3}] is replaced by a single snapshot
      // [{N,today}]. Aggregation (_aggregatePostAnalytics) and the "latest
      // total" UI view are unaffected; per-day trend consumers (none today)
      // would see a one-off collapse.
      const allZero = (arr: { total: number; date: string }[]) =>
        arr.length === 0 || arr.every((d) => d.total === 0);

      if (
        socialActions.likesSummary?.totalLikes !== undefined &&
        allZero(analytics['Likes'])
      ) {
        analytics['Likes'] = [
          { total: socialActions.likesSummary.totalLikes, date: today },
        ];
      }

      if (
        socialActions.commentsSummary?.totalFirstLevelComments !== undefined &&
        allZero(analytics['Comments'])
      ) {
        analytics['Comments'] = [
          {
            total: socialActions.commentsSummary.totalFirstLevelComments,
            date: today,
          },
        ];
      }
    }

    // Filter out empty analytics
    const result = Object.entries(analytics)
      .filter(([_, data]) => data.length > 0)
      .map(([label, data]) => ({
        label,
        data,
        percentageChange: 0,
      }));

    return result as any;
  }

  async accountMetrics(
    integrationId: string,
    accessToken: string
  ): Promise<AccountMetrics | null> {
    if (!this._isValidOrgId(integrationId)) {
      console.warn(`LinkedIn Page accountMetrics skipped: internalId "${integrationId}" is not a valid organization ID`);
      return null;
    }

    try {
      // Fetch total follower count via networkSizes
      const urn = encodeURIComponent(`urn:li:organization:${integrationId}`);
      const networkSizesUrl = `https://api.linkedin.com/v2/networkSizes/${urn}?edgeType=CompanyFollowedByMember`;
      const networkSizes = await (
        await this.fetch(networkSizesUrl, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'LinkedIn-Version': '202511',
            'X-Restli-Protocol-Version': '2.0.0',
          },
        })
      ).json();

      const result: AccountMetrics = {};

      if (networkSizes?.firstDegreeSize !== undefined) {
        result.followers = networkSizes.firstDegreeSize;
      }

      return Object.keys(result).length > 0 ? result : null;
    } catch (err) {
      console.error('Error fetching LinkedIn Page account metrics:', err);
      return null;
    }
  }

  async batchPostAnalytics(
    integrationId: string,
    accessToken: string,
    postIds: string[],
    date: number
  ): Promise<BatchPostAnalyticsResult> {
    if (postIds.length === 0 || !this._isValidOrgId(integrationId)) return {};

    const today = dayjs().format('YYYY-MM-DD');
    const endDate = dayjs().unix() * 1000;
    const startDate = dayjs().subtract(date, 'days').unix() * 1000;
    const result: BatchPostAnalyticsResult = {};

    // LinkedIn API accepts multiple shares in a single request
    // Process in chunks of 20 to avoid URL length limits
    const CHUNK_SIZE = 20;
    for (let i = 0; i < postIds.length; i += CHUNK_SIZE) {
      const chunk = postIds.slice(i, i + CHUNK_SIZE);

      try {
        const sharesList = chunk
          .map((id) => encodeURIComponent(id))
          .join(',');

        const shareStatsUrl = `https://api.linkedin.com/v2/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=${encodeURIComponent(
          `urn:li:organization:${integrationId}`
        )}&shares=List(${sharesList})&timeIntervals=(timeRange:(start:${startDate},end:${endDate}),timeGranularityType:DAY)`;

        const { elements: shareElements } = await (
          await this.fetch(shareStatsUrl, {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'LinkedIn-Version': '202511',
              'X-Restli-Protocol-Version': '2.0.0',
            },
          })
        ).json();

        if (!shareElements?.length) continue;

        // Group elements by share URN
        for (const element of shareElements) {
          const shareUrn = element.share;
          if (!shareUrn) continue;

          if (!result[shareUrn]) {
            result[shareUrn] = [];
          }

          const stats = element.totalShareStatistics;
          if (!stats) continue;

          const dateStr = element.timeRange
            ? dayjs(element.timeRange.start).format('YYYY-MM-DD')
            : today;

          // Accumulate metrics per post
          const existing = result[shareUrn];
          const addOrUpdate = (label: string, value: number) => {
            const found = existing.find((a) => a.label === label);
            if (found) {
              found.data.push({ total: String(value), date: dateStr });
            } else {
              existing.push({
                label,
                percentageChange: 0,
                data: [{ total: String(value), date: dateStr }],
              });
            }
          };

          if (stats.impressionCount !== undefined)
            addOrUpdate('Impressions', stats.impressionCount);
          if (stats.uniqueImpressionsCount !== undefined)
            addOrUpdate('Unique Impressions', stats.uniqueImpressionsCount);
          if (stats.clickCount !== undefined)
            addOrUpdate('Clicks', stats.clickCount);
          if (stats.likeCount !== undefined)
            addOrUpdate('Likes', stats.likeCount);
          if (stats.commentCount !== undefined)
            addOrUpdate('Comments', stats.commentCount);
          if (stats.shareCount !== undefined)
            addOrUpdate('Shares', stats.shareCount);
          if (stats.engagement !== undefined)
            addOrUpdate('Engagement', stats.engagement);
        }
      } catch (err) {
        console.error(
          `Error fetching LinkedIn Page batch post analytics (chunk ${i}):`,
          err
        );
      }
    }

    // Supplement Likes/Comments with socialActions per post when share stats
    // are missing or report zero for those fields. See `postAnalytics` for the
    // full reasoning — share statistics has a 24-48h aggregation delay and a
    // bounded timeRange window, while socialActions returns the post's current
    // cumulative totals and is authoritative for Likes and Comments.
    //
    // socialActions is only fetched when share stats did not cover Likes or
    // Comments for that post, so the normal case (fresh share stats available)
    // does not incur any extra API call.
    // Note: when a supplement fires, a multi-day zero series like
    // [{0,d1},{0,d2},{0,d3}] is replaced by a single snapshot [{N,today}].
    // Aggregation and latest-total consumers are unaffected; per-day trend
    // consumers (none today) would see a one-off collapse.
    const allZero = (entry: AnalyticsData | undefined) =>
      !entry || entry.data.every((d) => Number(d.total) === 0);

    const replaceLabel = (
      bucket: AnalyticsData[],
      label: string,
      value: number
    ) => {
      const idx = bucket.findIndex((a) => a.label === label);
      const entry: AnalyticsData = {
        label,
        percentageChange: 0,
        data: [{ total: String(value), date: today }],
      };
      if (idx >= 0) bucket[idx] = entry;
      else bucket.push(entry);
    };

    for (const postId of postIds) {
      if (!result[postId]) result[postId] = [];
      const bucket = result[postId];

      const needsLikes = allZero(bucket.find((a) => a.label === 'Likes'));
      const needsComments = allZero(bucket.find((a) => a.label === 'Comments'));
      if (!needsLikes && !needsComments) continue;

      try {
        const socialActionsUrl = `https://api.linkedin.com/v2/socialActions/${encodeURIComponent(
          postId
        )}`;
        const socialActions = await (
          await this.fetch(socialActionsUrl, {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'LinkedIn-Version': '202511',
              'X-Restli-Protocol-Version': '2.0.0',
            },
          })
        ).json();

        if (
          needsLikes &&
          socialActions?.likesSummary?.totalLikes !== undefined
        ) {
          replaceLabel(bucket, 'Likes', socialActions.likesSummary.totalLikes);
        }

        if (
          needsComments &&
          socialActions?.commentsSummary?.totalFirstLevelComments !== undefined
        ) {
          replaceLabel(
            bucket,
            'Comments',
            socialActions.commentsSummary.totalFirstLevelComments
          );
        }
      } catch {
        // socialActions may not be available for all posts
      } finally {
        // Placeholder bucket was created before we knew whether socialActions
        // would yield anything usable — discard empty ones in either branch.
        if (bucket.length === 0) {
          delete result[postId];
        }
      }
    }

    return result;
  }

  @Plug({
    identifier: 'linkedin-page-autoRepostPost',
    title: 'Auto Repost Posts',
    description:
      'When a post reached a certain number of likes, repost it to increase engagement (1 week old posts)',
    runEveryMilliseconds: 21600000,
    totalRuns: 3,
    fields: [
      {
        name: 'likesAmount',
        type: 'number',
        placeholder: 'Amount of likes',
        description: 'The amount of likes to trigger the repost',
        validation: /^\d+$/,
      },
    ],
  })
  async autoRepostPost(
    integration: Integration,
    id: string,
    fields: { likesAmount: string }
  ) {
    const {
      likesSummary: { totalLikes },
    } = await (
      await this.fetch(
        `https://api.linkedin.com/v2/socialActions/${encodeURIComponent(id)}`,
        {
          method: 'GET',
          headers: {
            'X-Restli-Protocol-Version': '2.0.0',
            'Content-Type': 'application/json',
            'LinkedIn-Version': '202501',
            Authorization: `Bearer ${integration.token}`,
          },
        }
      )
    ).json();

    if (totalLikes >= +fields.likesAmount) {
      await timer(2000);
      await this.fetch(`https://api.linkedin.com/rest/posts`, {
        body: JSON.stringify({
          author: `urn:li:organization:${integration.internalId}`,
          commentary: '',
          visibility: 'PUBLIC',
          distribution: {
            feedDistribution: 'MAIN_FEED',
            targetEntities: [],
            thirdPartyDistributionChannels: [],
          },
          lifecycleState: 'PUBLISHED',
          isReshareDisabledByAuthor: false,
          reshareContext: {
            parent: id,
          },
        }),
        method: 'POST',
        headers: {
          'X-Restli-Protocol-Version': '2.0.0',
          'Content-Type': 'application/json',
          'LinkedIn-Version': '202504',
          Authorization: `Bearer ${integration.token}`,
        },
      });
      return true;
    }

    return false;
  }

  @Plug({
    identifier: 'linkedin-page-autoPlugPost',
    title: 'Auto plug post',
    description:
      'When a post reached a certain number of likes, add another post to it so you followers get a notification about your promotion',
    runEveryMilliseconds: 21600000,
    totalRuns: 3,
    fields: [
      {
        name: 'likesAmount',
        type: 'number',
        placeholder: 'Amount of likes',
        description: 'The amount of likes to trigger the repost',
        validation: /^\d+$/,
      },
      {
        name: 'post',
        type: 'richtext',
        placeholder: 'Post to plug',
        description: 'Message content to plug',
        validation: /^[\s\S]{3,}$/g,
      },
    ],
  })
  async autoPlugPost(
    integration: Integration,
    id: string,
    fields: { likesAmount: string; post: string }
  ) {
    const {
      likesSummary: { totalLikes },
    } = await (
      await this.fetch(
        `https://api.linkedin.com/v2/socialActions/${encodeURIComponent(id)}`,
        {
          method: 'GET',
          headers: {
            'X-Restli-Protocol-Version': '2.0.0',
            'Content-Type': 'application/json',
            'LinkedIn-Version': '202501',
            Authorization: `Bearer ${integration.token}`,
          },
        }
      )
    ).json();

    if (totalLikes >= fields.likesAmount) {
      await timer(2000);
      await this.fetch(
        `https://api.linkedin.com/v2/socialActions/${decodeURIComponent(
          id
        )}/comments`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${integration.token}`,
          },
          body: JSON.stringify({
            actor: `urn:li:organization:${integration.internalId}`,
            object: id,
            message: {
              text: this.fixText(fields.post),
            },
          }),
        }
      );
      return true;
    }

    return false;
  }
}

export interface Root {
  pageStatisticsByIndustryV2: any[];
  pageStatisticsBySeniority: any[];
  organization: string;
  pageStatisticsByGeoCountry: any[];
  pageStatisticsByTargetedContent: any[];
  totalPageStatistics: TotalPageStatistics;
  pageStatisticsByStaffCountRange: any[];
  pageStatisticsByFunction: any[];
  pageStatisticsByGeo: any[];
  followerGains: { organicFollowerGain: number; paidFollowerGain: number };
  timeRange: TimeRange;
  totalShareStatistics: {
    uniqueImpressionsCount: number;
    shareCount: number;
    engagement: number;
    clickCount: number;
    likeCount: number;
    impressionCount: number;
    commentCount: number;
  };
}

export interface TotalPageStatistics {
  clicks: Clicks;
  views: Views;
}

export interface Clicks {
  mobileCustomButtonClickCounts: any[];
  desktopCustomButtonClickCounts: any[];
}

export interface Views {
  mobileProductsPageViews: MobileProductsPageViews;
  allDesktopPageViews: AllDesktopPageViews;
  insightsPageViews: InsightsPageViews;
  mobileAboutPageViews: MobileAboutPageViews;
  allMobilePageViews: AllMobilePageViews;
  productsPageViews: ProductsPageViews;
  desktopProductsPageViews: DesktopProductsPageViews;
  jobsPageViews: JobsPageViews;
  peoplePageViews: PeoplePageViews;
  overviewPageViews: OverviewPageViews;
  mobileOverviewPageViews: MobileOverviewPageViews;
  lifeAtPageViews: LifeAtPageViews;
  desktopOverviewPageViews: DesktopOverviewPageViews;
  mobileCareersPageViews: MobileCareersPageViews;
  allPageViews: AllPageViews;
  careersPageViews: CareersPageViews;
  mobileJobsPageViews: MobileJobsPageViews;
  mobileLifeAtPageViews: MobileLifeAtPageViews;
  desktopJobsPageViews: DesktopJobsPageViews;
  desktopPeoplePageViews: DesktopPeoplePageViews;
  aboutPageViews: AboutPageViews;
  desktopAboutPageViews: DesktopAboutPageViews;
  mobilePeoplePageViews: MobilePeoplePageViews;
  desktopCareersPageViews: DesktopCareersPageViews;
  desktopInsightsPageViews: DesktopInsightsPageViews;
  desktopLifeAtPageViews: DesktopLifeAtPageViews;
  mobileInsightsPageViews: MobileInsightsPageViews;
}

export interface MobileProductsPageViews {
  pageViews: number;
  uniquePageViews: number;
}

export interface AllDesktopPageViews {
  pageViews: number;
  uniquePageViews: number;
}

export interface InsightsPageViews {
  pageViews: number;
  uniquePageViews: number;
}

export interface MobileAboutPageViews {
  pageViews: number;
  uniquePageViews: number;
}

export interface AllMobilePageViews {
  pageViews: number;
  uniquePageViews: number;
}

export interface ProductsPageViews {
  pageViews: number;
  uniquePageViews: number;
}

export interface DesktopProductsPageViews {
  pageViews: number;
  uniquePageViews: number;
}

export interface JobsPageViews {
  pageViews: number;
  uniquePageViews: number;
}

export interface PeoplePageViews {
  pageViews: number;
  uniquePageViews: number;
}

export interface OverviewPageViews {
  pageViews: number;
  uniquePageViews: number;
}

export interface MobileOverviewPageViews {
  pageViews: number;
  uniquePageViews: number;
}

export interface LifeAtPageViews {
  pageViews: number;
  uniquePageViews: number;
}

export interface DesktopOverviewPageViews {
  pageViews: number;
  uniquePageViews: number;
}

export interface MobileCareersPageViews {
  pageViews: number;
  uniquePageViews: number;
}

export interface AllPageViews {
  pageViews: number;
  uniquePageViews: number;
}

export interface CareersPageViews {
  pageViews: number;
  uniquePageViews: number;
}

export interface MobileJobsPageViews {
  pageViews: number;
  uniquePageViews: number;
}

export interface MobileLifeAtPageViews {
  pageViews: number;
  uniquePageViews: number;
}

export interface DesktopJobsPageViews {
  pageViews: number;
  uniquePageViews: number;
}

export interface DesktopPeoplePageViews {
  pageViews: number;
  uniquePageViews: number;
}

export interface AboutPageViews {
  pageViews: number;
  uniquePageViews: number;
}

export interface DesktopAboutPageViews {
  pageViews: number;
  uniquePageViews: number;
}

export interface MobilePeoplePageViews {
  pageViews: number;
  uniquePageViews: number;
}

export interface DesktopCareersPageViews {
  pageViews: number;
  uniquePageViews: number;
}

export interface DesktopInsightsPageViews {
  pageViews: number;
  uniquePageViews: number;
}

export interface DesktopLifeAtPageViews {
  pageViews: number;
  uniquePageViews: number;
}

export interface MobileInsightsPageViews {
  pageViews: number;
  uniquePageViews: number;
}

export interface TimeRange {
  start: number;
  end: number;
}

// Post analytics interfaces
export interface PostShareStatElement {
  organizationalEntity: string;
  share: string;
  totalShareStatistics: {
    uniqueImpressionsCount: number;
    shareCount: number;
    engagement: number;
    clickCount: number;
    likeCount: number;
    impressionCount: number;
    commentCount: number;
  };
  timeRange: TimeRange;
}

export interface SocialActionsResponse {
  likesSummary?: {
    totalLikes: number;
    likedByCurrentUser: boolean;
  };
  commentsSummary?: {
    totalFirstLevelComments: number;
    commentsState: string;
  };
}
