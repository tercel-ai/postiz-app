import { Injectable, Logger } from '@nestjs/common';
import { Activity, ActivityMethod } from 'nestjs-temporal-core';
import { Context } from '@temporalio/activity';
import {
  PrismaRepository,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { EngageRepository } from '@gitroom/nestjs-libraries/engage/engage.repository';
import { getRedditToken, redditAuthHeaders } from '@gitroom/nestjs-libraries/engage/reddit-auth';
import { redditPublicGet } from '@gitroom/nestjs-libraries/engage/reddit-loid';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
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
    private _engageSentReply: PrismaRepository<'engageSentReply'>,
    private _tx: PrismaTransaction,
    private _postsService: PostsService
  ) {}

  private _heartbeat(progress?: unknown): void {
    try {
      Context.current().heartbeat(progress);
    } catch {
      // Not running in a Temporal activity context.
    }
  }

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

      this._heartbeat({ stage: 'aggregate', org: orgId });
      // Batch per-org upserts in one $transaction round-trip — avoids
      // K orgs × (P+1) platforms × 3 metric-types sequential DB hops.
      const ops: Array<Promise<unknown>> = [];
      for (const [platform, agg] of platformMap) {
        for (const [type, val] of [
          ['replies', agg.count],
          ['impressions', agg.impressions],
          ['traffic', agg.traffic],
        ] as const) {
          ops.push(
            this._engageDataTicks.model.engageDataTicks.upsert({
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
            })
          );
        }
      }
      await this._tx.model.$transaction(ops as never);
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
        post: { select: { id: true, releaseURL: true, state: true, integrationId: true } },
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
      await this._syncXMetrics(
        reply.organizationId,
        reply.id,
        reply.post.id,
        reply.post.releaseURL,
        reply.opportunity.externalPostId,
        reply.opportunity.authorUsername,  // needed to resolve original author's numeric user ID
        !!reply.post.integrationId         // no integration → skip per-account analytics
      );
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
      // Fetch our comment's metadata for score/num_comments.
      // Prefer authenticated oauth.reddit.com; fall back to public endpoint.
      const token = await getRedditToken();
      // Token path → oauth (no WAF); public path → redditPublicGet (loid cookie +
      // tiered proxy: rotate-IP on 403/429, then direct fallback).
      const fetchReddit = async (
        url: string,
        tok: string | null
      ): Promise<{ ok: boolean; status: number; text(): Promise<string> }> => {
        if (tok) {
          const r = await fetch(url, { headers: redditAuthHeaders(tok) });
          return { ok: r.ok, status: r.status, text: () => r.text() };
        }
        return redditPublicGet(url, {}, { log: (m) => this.logger.warn(m) });
      };

      const infoUrl = token
        ? `https://oauth.reddit.com/api/info?id=t1_${commentId}`
        : `https://www.reddit.com/api/info.json?id=t1_${commentId}`;

      const infoRes = await fetchReddit(infoUrl, token);
      if (!infoRes.ok) {
        const body = await infoRes.text().catch(() => '<unreadable>');
        this.logger.warn(
          `Reddit /api/info returned ${infoRes.status} for t1_${commentId}: ${body.slice(0, 200)}`
        );
        return;
      }
      const infoJson = JSON.parse(await infoRes.text()) as {
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
          // Reddit_traffic_index = score×1 + num_comments×3 (Appendix formula).
          trafficScore: commentData.score * 1 + commentData.num_comments * 3,
        },
      });

      // Check if the original post author replied to our comment.
      // Fetch the permalink of our comment thread to get child replies.
      const threadMatch = releaseURL.match(/\/r\/([^/]+)\/comments\/([a-z0-9]+)\//);
      if (threadMatch) {
        const subreddit = threadMatch[1];
        const postId_ = threadMatch[2];
        const threadToken = await getRedditToken();
        const threadUrl = threadToken
          ? `https://oauth.reddit.com/r/${subreddit}/comments/${postId_}?comment=${commentId}&depth=1&limit=25`
          : `https://www.reddit.com/r/${subreddit}/comments/${postId_}/.json?comment=${commentId}&depth=1&limit=25`;
        const threadRes = await fetchReddit(threadUrl, threadToken);
        if (!threadRes.ok) {
          const body = await threadRes.text().catch(() => '<unreadable>');
          this.logger.warn(
            `Reddit thread .json returned ${threadRes.status} for r/${subreddit}/${postId_}: ${body.slice(0, 200)}`
          );
        } else {
          const threadJson = JSON.parse(await threadRes.text()) as Array<{
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

  private async _syncXMetrics(
    orgId: string,              // owning org, for the analytics token lookup
    sentReplyId: string,
    postDbId: string,           // DB UUID of the Post record to write metrics onto
    replyTweetUrl: string,      // https://twitter.com/user/status/<tweetId>
    originalTweetId: string,
    authorUsername: string,     // X @username of the original post's author
    hasIntegration: boolean     // whether the Post carries an X integration token
  ): Promise<void> {
    // Fetch the reply tweet's metrics through the integration's own OAuth token
    // (the same path regular posts use), so impression_count and bookmark_count
    // are captured and the X traffic index + impressions are written back to the
    // Post. Engage posts are excluded from the global analytics job
    // (source != 'engage'), so we drive it explicitly here. When the reply was
    // recorded without an X account, there is no token to authenticate with, so
    // skip the per-account analytics entirely (the author-replied check below
    // uses the app-only bearer and still runs).
    if (hasIntegration) {
      try {
        await this._postsService.checkPostAnalytics(orgId, postDbId, Date.now());
      } catch (err) {
        this.logger.warn(`X analytics sync failed for post ${postDbId}: ${(err as Error).message}`);
      }
    } else {
      this.logger.log(`X reply ${sentReplyId} has no integration — skipping per-account analytics sync`);
    }

    // Author-replied detection uses the app-only bearer (conversation search),
    // which is independent of the per-integration analytics token above.
    const bearerToken = process.env.X_BEARER_TOKEN;
    if (!bearerToken) return;

    // Extract the snowflake tweet ID from the releaseURL
    const replyTweetId = replyTweetUrl.match(/\/status\/(\d+)/)?.[1];
    if (!replyTweetId) return;

    try {
      // Resolve the original post author's username → numeric user ID
      const authorRes = await fetch(
        `https://api.twitter.com/2/users/by/username/${authorUsername}`,
        { headers: { Authorization: `Bearer ${bearerToken}` } }
      );
      if (!authorRes.ok) {
        const body = await authorRes.text().catch(() => '<unreadable>');
        this.logger.warn(
          `X /users/by/username returned ${authorRes.status} for @${authorUsername}: ${body.slice(0, 200)}`
        );
        return;
      }
      const authorJson = (await authorRes.json()) as { data?: { id: string } };
      const originalAuthorId = authorJson.data?.id;
      if (!originalAuthorId) return;

      // Fetch recent tweets in the original tweet's conversation
      const res = await fetch(
        `https://api.twitter.com/2/tweets/search/recent?query=conversation_id:${originalTweetId}&tweet.fields=author_id&max_results=50`,
        { headers: { Authorization: `Bearer ${bearerToken}` } }
      );
      if (!res.ok) {
        const body = await res.text().catch(() => '<unreadable>');
        this.logger.warn(
          `X /tweets/search/recent (conversation_id) returned ${res.status} for ${originalTweetId}: ${body.slice(0, 200)}`
        );
        return;
      }
      const json = (await res.json()) as {
        data?: Array<{ id: string; author_id: string }>;
      };

      // Check if the ORIGINAL AUTHOR specifically replied AFTER our reply
      const authorReplied = (json.data ?? []).some(
        (t) => t.author_id === originalAuthorId && BigInt(t.id) > BigInt(replyTweetId)
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
