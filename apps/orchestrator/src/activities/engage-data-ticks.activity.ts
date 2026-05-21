import { Injectable, Logger } from '@nestjs/common';
import { Activity, ActivityMethod } from 'nestjs-temporal-core';
import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { EngageRepository } from '@gitroom/nestjs-libraries/engage/engage.repository';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';

dayjs.extend(utc);

@Injectable()
@Activity()
export class EngageDataTicksActivity {
  private readonly logger = new Logger(EngageDataTicksActivity.name);

  constructor(
    private _engageRepository: EngageRepository,
    private _post: PrismaRepository<'post'>,
    private _engageDataTicks: PrismaRepository<'engageDataTicks'>,
    private _engageSentReply: PrismaRepository<'engageSentReply'>
  ) {}

  @ActivityMethod()
  async aggregateDailyEngageTicks(orgId?: string): Promise<void> {
    const yesterday = dayjs.utc().subtract(1, 'day').startOf('day').toDate();
    const yesterdayEnd = dayjs.utc().subtract(1, 'day').endOf('day').toDate();

    const where = {
      source: 'engage',
      state: 'PUBLISHED' as const,
      publishDate: { gte: yesterday, lte: yesterdayEnd },
      ...(orgId ? { organizationId: orgId } : {}),
    };

    const posts = await this._post.model.post.findMany({
      where,
      select: {
        organizationId: true,
        impressions: true,
        trafficScore: true,
        integration: { select: { providerIdentifier: true } },
      },
    });

    // Group by org and platform
    type Agg = { count: number; impressions: number; traffic: number };
    const byOrgPlatform = new Map<string, Map<string, Agg>>();

    for (const post of posts) {
      const platform = post.integration?.providerIdentifier ?? 'reddit';
      const orgMap = byOrgPlatform.get(post.organizationId) ?? new Map<string, Agg>();
      const curr = orgMap.get(platform) ?? { count: 0, impressions: 0, traffic: 0 };
      orgMap.set(platform, {
        count: curr.count + 1,
        impressions: curr.impressions + (post.impressions ?? 0),
        traffic: curr.traffic + (post.trafficScore ?? 0),
      });
      byOrgPlatform.set(post.organizationId, orgMap);
    }

    for (const [orgId, platformMap] of byOrgPlatform) {
      // Add cross-platform "all" aggregation
      const allAgg = [...platformMap.values()].reduce(
        (a, b) => ({
          count: a.count + b.count,
          impressions: a.impressions + b.impressions,
          traffic: a.traffic + b.traffic,
        }),
        { count: 0, impressions: 0, traffic: 0 }
      );
      platformMap.set('all', allAgg);

      for (const [platform, agg] of platformMap) {
        for (const [type, val] of [
          ['replies', agg.count],
          ['impressions', agg.impressions],
          ['traffic', agg.traffic],
        ] as const) {
          await this._engageDataTicks.model.engageDataTicks.upsert({
            where: {
              organizationId_platform_type_timeUnit_statisticsTime: {
                organizationId: orgId,
                platform,
                type,
                timeUnit: 'day',
                statisticsTime: yesterday,
              },
            },
            create: {
              organizationId: orgId,
              platform,
              type,
              timeUnit: 'day',
              statisticsTime: yesterday,
              value: BigInt(Math.round(val)),
            },
            update: { value: BigInt(Math.round(val)) },
          });
        }
      }
    }

    this.logger.log(
      `EngageDataTicks: aggregated ${posts.length} posts for ${byOrgPlatform.size} orgs`
    );
  }

  @ActivityMethod()
  async syncEngageMetrics(sentReplyId: string): Promise<void> {
    const reply = await this._engageSentReply.model.engageSentReply.findUnique({
      where: { id: sentReplyId },
      include: {
        post: { select: { id: true, releaseURL: true, state: true } },
        opportunity: {
          select: {
            platform: true,
            externalPostId: true,
            authorUsername: true,
          },
        },
      },
    });
    if (!reply || !reply.post) return;

    if (reply.opportunity.platform === 'reddit' && reply.post.releaseURL) {
      await this._syncRedditMetrics(reply.post.id, reply.post.releaseURL, reply.id, reply.opportunity.authorUsername);
    } else if (reply.opportunity.platform === 'x' && reply.post.releaseURL) {
      // Pass the DB post ID (for integration lookup) and the tweet URL (to extract snowflake ID)
      await this._checkXAuthorReplied(reply.id, reply.post.id, reply.post.releaseURL, reply.opportunity.externalPostId);
    }
  }

  private async _syncRedditMetrics(
    postId: string,
    releaseURL: string,
    sentReplyId: string,
    authorUsername: string
  ): Promise<void> {
    const commentId = this._extractRedditCommentId(releaseURL);
    if (!commentId) return;

    try {
      // Fetch our comment's metadata for score/num_comments
      const infoRes = await fetch(
        `https://www.reddit.com/api/info.json?id=t1_${commentId}`,
        { headers: { 'User-Agent': 'AISEE-Engage/1.0' } }
      );
      if (!infoRes.ok) return;
      const infoJson = (await infoRes.json()) as {
        data?: { children?: Array<{ data: { score: number; num_comments: number } }> };
      };
      const commentData = infoJson.data?.children?.[0]?.data;
      if (!commentData) return;

      const today = new Date().toISOString().slice(0, 10);
      const analyticsData = [
        { label: 'score', data: [{ total: String(commentData.score), date: today }], percentageChange: 0 },
        { label: 'comments', data: [{ total: String(commentData.num_comments), date: today }], percentageChange: 0 },
      ];

      await this._post.model.post.update({
        where: { id: postId },
        data: {
          analytics: analyticsData as never,
          impressions: Math.round((commentData.score + commentData.num_comments) * 20),
        },
      });

      // Check if the original post author replied to our comment.
      // Fetch the permalink of our comment thread to get child replies.
      const threadMatch = releaseURL.match(/\/r\/([^/]+)\/comments\/([a-z0-9]+)\//);
      if (threadMatch) {
        const subreddit = threadMatch[1];
        const postId_ = threadMatch[2];
        const threadRes = await fetch(
          `https://www.reddit.com/r/${subreddit}/comments/${postId_}/.json?comment=${commentId}&depth=1&limit=25`,
          { headers: { 'User-Agent': 'AISEE-Engage/1.0' } }
        );
        if (threadRes.ok) {
          const threadJson = (await threadRes.json()) as Array<{
            data?: { children?: Array<{ data?: { replies?: { data?: { children?: Array<{ data?: { author?: string } }> } } } }> };
          }>;
          const ourComment = threadJson[1]?.data?.children?.[0]?.data;
          const childReplies = ourComment?.replies?.data?.children ?? [];
          if (childReplies.some((r) => r.data?.author === authorUsername)) {
            await this._engageRepository.markAuthorReplied(sentReplyId);
          }
        }
      }
    } catch (err) {
      this.logger.warn(`Reddit metrics sync failed: ${(err as Error).message}`);
    }
  }

  private async _checkXAuthorReplied(
    sentReplyId: string,
    postDbId: string,       // DB UUID of the Post record (for integration lookup)
    replyTweetUrl: string,  // https://twitter.com/user/status/<tweetId>
    originalTweetId: string
  ): Promise<void> {
    const bearerToken = process.env.X_BEARER_TOKEN;
    if (!bearerToken) return;

    // Extract the snowflake tweet ID from the releaseURL
    const replyTweetId = replyTweetUrl.match(/\/status\/(\d+)/)?.[1];
    if (!replyTweetId) return;

    try {
      // Fetch our integration's X user ID so we can identify our own tweets in the conversation
      const replyPost = await this._post.model.post.findUnique({
        where: { id: postDbId },
        select: { integration: { select: { internalId: true } } },
      });
      const ourXUserId = replyPost?.integration?.internalId;
      if (!ourXUserId) return;

      // Fetch recent tweets in the original tweet's conversation
      const res = await fetch(
        `https://api.twitter.com/2/tweets/search/recent?query=conversation_id:${originalTweetId}&tweet.fields=author_id&max_results=50`,
        { headers: { Authorization: `Bearer ${bearerToken}` } }
      );
      if (!res.ok) return;
      const json = (await res.json()) as {
        data?: Array<{ id: string; author_id: string }>;
      };

      // Check if the original author replied AFTER our reply (tweet Snowflake ID > replyTweetId)
      const authorReplied = (json.data ?? []).some(
        (t) => t.author_id !== ourXUserId && BigInt(t.id) > BigInt(replyTweetId)
      );
      if (authorReplied) {
        await this._engageRepository.markAuthorReplied(sentReplyId);
      }
    } catch (err) {
      this.logger.warn(`X author-replied check failed: ${(err as Error).message}`);
    }
  }

  private _extractRedditCommentId(url: string): string | null {
    const match = url.match(/\/comments\/[^/]+\/[^/]+\/([a-z0-9]+)\/?/);
    return match?.[1] ?? null;
  }
}
