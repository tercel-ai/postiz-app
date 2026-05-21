import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import {
  AddKeywordDto,
  AddMonitoredChannelDto,
  AddTrackedAccountDto,
  ListOpportunitiesDto,
  ListSentDto,
  UpdateKeywordDto,
  UpdateMonitoredChannelDto,
  UpdateReplyAccountDto,
  UpdateTrackedAccountDto,
} from '@gitroom/nestjs-libraries/engage/dtos/engage.dto';
import dayjs from 'dayjs';
import isoWeek from 'dayjs/plugin/isoWeek';
import utc from 'dayjs/plugin/utc';

dayjs.extend(isoWeek);
dayjs.extend(utc);

@Injectable()
export class EngageRepository {
  constructor(
    private _config: PrismaRepository<'engageConfig'>,
    private _keyword: PrismaRepository<'engageKeyword'>,
    private _channel: PrismaRepository<'engageMonitoredChannel'>,
    private _trackedAccount: PrismaRepository<'engageTrackedAccount'>,
    private _replyAccount: PrismaRepository<'engageXReplyAccount'>,
    private _opportunity: PrismaRepository<'engageOpportunity'>,
    private _sentReply: PrismaRepository<'engageSentReply'>,
    private _integration: PrismaRepository<'integration'>,
    private _post: PrismaRepository<'post'>
  ) {}

  // ─── Config ────────────────────────────────────────────────────────────────

  async getOrCreateConfig(organizationId: string) {
    const existing = await this._config.model.engageConfig.findUnique({
      where: { organizationId },
      include: {
        keywords: { orderBy: { createdAt: 'asc' } },
        monitoredChannels: { orderBy: { createdAt: 'asc' } },
        trackedAccounts: { orderBy: { createdAt: 'asc' } },
        xReplyAccounts: {
          include: {
            integration: {
              select: {
                id: true,
                name: true,
                providerIdentifier: true,
                picture: true,
              },
            },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (existing) return existing;

    return this._config.model.engageConfig.create({
      data: { organizationId, setupCompleted: false },
      include: {
        keywords: true,
        monitoredChannels: true,
        trackedAccounts: true,
        xReplyAccounts: {
          include: {
            integration: {
              select: {
                id: true,
                name: true,
                providerIdentifier: true,
                picture: true,
              },
            },
          },
        },
      },
    });
  }

  async saveConfig(
    organizationId: string,
    data: Partial<{ setupCompleted: boolean; lastScanAt: Date }>
  ) {
    return this._config.model.engageConfig.upsert({
      where: { organizationId },
      create: { organizationId, ...data },
      update: data,
    });
  }

  async resetConfig(organizationId: string) {
    return this._config.model.engageConfig.update({
      where: { organizationId },
      data: { setupCompleted: false },
    });
  }

  // ─── Keywords ──────────────────────────────────────────────────────────────

  async addKeyword(
    configId: string,
    organizationId: string,
    dto: AddKeywordDto
  ) {
    return this._keyword.model.engageKeyword.create({
      data: {
        configId,
        organizationId,
        keyword: dto.keyword,
        type: dto.type ?? 'CORE',
        enabled: dto.enabled ?? true,
      },
    });
  }

  async updateKeyword(
    organizationId: string,
    id: string,
    dto: UpdateKeywordDto
  ) {
    const kw = await this._keyword.model.engageKeyword.findFirst({
      where: { id, organizationId },
    });
    if (!kw) throw new NotFoundException('Keyword not found');
    return this._keyword.model.engageKeyword.update({
      where: { id },
      data: {
        ...(dto.type !== undefined && { type: dto.type }),
        ...(dto.enabled !== undefined && { enabled: dto.enabled }),
      },
    });
  }

  async deleteKeyword(organizationId: string, id: string) {
    const kw = await this._keyword.model.engageKeyword.findFirst({
      where: { id, organizationId },
    });
    if (!kw) throw new NotFoundException('Keyword not found');
    return this._keyword.model.engageKeyword.delete({ where: { id } });
  }

  // ─── Monitored Channels ───────────────────────────────────────────────────

  async addMonitoredChannel(
    configId: string,
    organizationId: string,
    dto: AddMonitoredChannelDto
  ) {
    return this._channel.model.engageMonitoredChannel.create({
      data: {
        configId,
        organizationId,
        platform: dto.platform,
        channelId: dto.channelId,
        channelName: dto.channelName,
        audienceSize: dto.audienceSize ?? 0,
        ...(dto.metadata && {
          metadata: dto.metadata as Prisma.InputJsonValue,
        }),
      },
    });
  }

  async listMonitoredChannels(organizationId: string) {
    return this._channel.model.engageMonitoredChannel.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async updateMonitoredChannel(
    organizationId: string,
    id: string,
    dto: UpdateMonitoredChannelDto
  ) {
    const channel = await this._channel.model.engageMonitoredChannel.findFirst(
      { where: { id, organizationId } }
    );
    if (!channel) throw new NotFoundException('Channel not found');
    return this._channel.model.engageMonitoredChannel.update({
      where: { id },
      data: {
        ...(dto.enabled !== undefined && { enabled: dto.enabled }),
        ...(dto.channelName !== undefined && { channelName: dto.channelName }),
        ...(dto.audienceSize !== undefined && {
          audienceSize: dto.audienceSize,
        }),
      },
    });
  }

  async removeMonitoredChannel(organizationId: string, id: string) {
    const channel = await this._channel.model.engageMonitoredChannel.findFirst(
      { where: { id, organizationId } }
    );
    if (!channel) throw new NotFoundException('Channel not found');
    return this._channel.model.engageMonitoredChannel.delete({ where: { id } });
  }

  // ─── Tracked Accounts ─────────────────────────────────────────────────────

  async addTrackedAccount(
    configId: string,
    organizationId: string,
    dto: AddTrackedAccountDto
  ) {
    return this._trackedAccount.model.engageTrackedAccount.create({
      data: {
        configId,
        organizationId,
        platform: dto.platform ?? 'x',
        username: dto.username,
        ...(dto.categoryLabel && { categoryLabel: dto.categoryLabel }),
      },
    });
  }

  async listTrackedAccounts(organizationId: string) {
    return this._trackedAccount.model.engageTrackedAccount.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async updateTrackedAccount(
    organizationId: string,
    id: string,
    dto: UpdateTrackedAccountDto
  ) {
    const account =
      await this._trackedAccount.model.engageTrackedAccount.findFirst({
        where: { id, organizationId },
      });
    if (!account) throw new NotFoundException('Tracked account not found');
    return this._trackedAccount.model.engageTrackedAccount.update({
      where: { id },
      data: {
        ...(dto.enabled !== undefined && { enabled: dto.enabled }),
        ...(dto.categoryLabel !== undefined && {
          categoryLabel: dto.categoryLabel,
        }),
      },
    });
  }

  async removeTrackedAccount(organizationId: string, id: string) {
    const account =
      await this._trackedAccount.model.engageTrackedAccount.findFirst({
        where: { id, organizationId },
      });
    if (!account) throw new NotFoundException('Tracked account not found');
    return this._trackedAccount.model.engageTrackedAccount.delete({
      where: { id },
    });
  }

  // ─── Reply Accounts ───────────────────────────────────────────────────────

  async listXIntegrationsWithReplySettings(organizationId: string) {
    return this._integration.model.integration.findMany({
      where: {
        organizationId,
        providerIdentifier: 'x',
        deletedAt: null,
        disabled: false,
        type: 'social',
      },
      include: { engageXReplyAccount: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  async updateReplyAccount(
    organizationId: string,
    integrationId: string,
    dto: UpdateReplyAccountDto
  ) {
    // Verify the integration belongs to this org before upserting engage settings
    const integration = await this._integration.model.integration.findFirst({
      where: { id: integrationId, organizationId, deletedAt: null },
      select: { id: true },
    });
    if (!integration) throw new NotFoundException('Integration not found');

    const configId = await this._getConfigId(organizationId);
    return this._replyAccount.model.engageXReplyAccount.upsert({
      where: { integrationId },
      create: {
        configId,
        organizationId,
        integrationId,
        engageEnabled: dto.engageEnabled ?? true,
        autoReplyEnabled: dto.autoReplyEnabled ?? false,
        autoReplyTimeStart: dto.autoReplyTimeStart ?? null,
        autoReplyTimeEnd: dto.autoReplyTimeEnd ?? null,
        autoReplyTimezone: dto.autoReplyTimezone ?? null,
        defaultStrategy: dto.defaultStrategy ?? 'EXPERT_ANSWER',
      },
      update: {
        ...(dto.engageEnabled !== undefined && {
          engageEnabled: dto.engageEnabled,
        }),
        ...(dto.autoReplyEnabled !== undefined && {
          autoReplyEnabled: dto.autoReplyEnabled,
        }),
        ...(dto.autoReplyTimeStart !== undefined && {
          autoReplyTimeStart: dto.autoReplyTimeStart,
        }),
        ...(dto.autoReplyTimeEnd !== undefined && {
          autoReplyTimeEnd: dto.autoReplyTimeEnd,
        }),
        ...(dto.autoReplyTimezone !== undefined && {
          autoReplyTimezone: dto.autoReplyTimezone,
        }),
        ...(dto.defaultStrategy !== undefined && {
          defaultStrategy: dto.defaultStrategy,
        }),
      },
    });
  }

  // ─── Opportunities ────────────────────────────────────────────────────────

  async listOpportunities(organizationId: string, dto: ListOpportunitiesDto) {
    const page = dto.page ?? 1;
    const limit = dto.limit ?? 20;
    const offset = (page - 1) * limit;

    const where: Prisma.EngageOpportunityWhereInput = {
      organizationId,
      deletedAt: null,
      ...(dto.platform && { platform: dto.platform }),
      ...(dto.status && { status: dto.status }),
      ...(dto.intent && { intentTags: { has: dto.intent } }),
      ...(dto.minScore !== undefined && { score: { gte: dto.minScore } }),
      ...(dto.minScoreKeyword !== undefined && {
        scoreKeyword: { gte: dto.minScoreKeyword },
      }),
      ...(dto.minScoreHeat !== undefined && {
        scoreHeat: { gte: dto.minScoreHeat },
      }),
      ...(dto.minScoreAuthority !== undefined && {
        scoreAuthority: { gte: dto.minScoreAuthority },
      }),
      ...(dto.trackedOnly && { scoreTracked: { gt: 0 } }),
      ...(dto.bookmarked !== undefined && { bookmarked: dto.bookmarked }),
      ...(dto.date === 'today' && {
        postPublishedAt: { gte: dayjs.utc().startOf('day').toDate() },
      }),
      ...(dto.date === 'week' && {
        postPublishedAt: { gte: dayjs.utc().startOf('isoWeek').toDate() },
      }),
    };

    const validSortFields = new Set([
      'score',
      'scoreKeyword',
      'scoreHeat',
      'scoreAuthority',
      'scoreRecency',
      'scoreTracked',
      'createdAt',
    ]);
    const sortBy =
      dto.sortBy && validSortFields.has(dto.sortBy) ? dto.sortBy : 'score';
    const sortOrder = dto.sortOrder ?? 'desc';

    const [items, total] = await Promise.all([
      this._opportunity.model.engageOpportunity.findMany({
        where,
        orderBy: { [sortBy]: sortOrder },
        skip: offset,
        take: limit,
      }),
      this._opportunity.model.engageOpportunity.count({ where }),
    ]);

    return { items, total, page, limit };
  }

  async dismissOpportunity(organizationId: string, id: string) {
    // Atomic: only dismiss actionable opportunities. Replied/scheduled rows are protected.
    const result = await this._opportunity.model.engageOpportunity.updateMany({
      where: {
        id,
        organizationId,
        status: { in: ['NEW', 'AUTO_QUEUED'] },
      },
      data: { status: 'DISMISSED' },
    });
    if (result.count === 0) {
      throw new NotFoundException('Opportunity not found or no longer actionable');
    }
    return this._opportunity.model.engageOpportunity.findUnique({ where: { id } });
  }

  // Atomic claim — only one concurrent caller succeeds. Prevents the orphan-Post + duplicate-X-reply
  // race where two concurrent reply attempts both pass a non-locking findFirst then both invoke
  // PostsService.createPost.
  //
  // Returns the opportunity plus the `priorStatus` (NEW | AUTO_QUEUED) so the caller can restore
  // the original status on rollback — preventing the loss of AUTO_QUEUED markers when the
  // auto-reply worker had pre-queued the opportunity.
  async claimOpportunityForReply(
    organizationId: string,
    id: string,
    claimStatus: 'REPLIED' | 'SCHEDULED'
  ) {
    // Read prior status (snapshot for rollback). The followup updateMany is conditional
    // on this exact status — if a concurrent claimer flipped it between the read and
    // the update, the conditional update yields count=0 and we throw.
    const existing = await this._opportunity.model.engageOpportunity.findFirst({
      where: {
        id,
        organizationId,
        status: { in: ['NEW', 'AUTO_QUEUED'] },
      },
      select: { status: true },
    });
    if (!existing) {
      throw new NotFoundException('Opportunity not found or already replied');
    }
    const priorStatus = existing.status as 'NEW' | 'AUTO_QUEUED';

    const result = await this._opportunity.model.engageOpportunity.updateMany({
      where: { id, organizationId, status: priorStatus },
      data: { status: claimStatus },
    });
    if (result.count === 0) {
      throw new NotFoundException('Opportunity already claimed by another request');
    }
    const opp = await this._opportunity.model.engageOpportunity.findUnique({
      where: { id },
    });
    if (!opp) throw new NotFoundException('Opportunity not found');
    return { opp, priorStatus };
  }

  // Rollback helper — restores an opportunity to its prior status after a failed
  // post-claim operation. Best-effort; never throws.
  async releaseOpportunityClaim(
    organizationId: string,
    id: string,
    priorStatus: 'NEW' | 'AUTO_QUEUED' = 'NEW'
  ) {
    try {
      await this._opportunity.model.engageOpportunity.updateMany({
        where: { id, organizationId },
        data: { status: priorStatus },
      });
    } catch {
      // swallow — caller is already handling an error
    }
  }

  async deletePostById(postId: string) {
    try {
      await this._post.model.post.delete({ where: { id: postId } });
    } catch {
      // swallow — best-effort cleanup
    }
  }

  async toggleBookmark(organizationId: string, id: string) {
    const opp = await this._opportunity.model.engageOpportunity.findFirst({
      where: { id, organizationId },
    });
    if (!opp) throw new NotFoundException('Opportunity not found');
    return this._opportunity.model.engageOpportunity.update({
      where: { id },
      data: { bookmarked: !opp.bookmarked },
    });
  }

  async getScoreStats(
    organizationId: string,
    date?: 'today' | 'week' | 'month',
    platform?: string
  ) {
    const where: Prisma.EngageOpportunityWhereInput = {
      organizationId,
      deletedAt: null,
      ...(platform && { platform }),
      ...(date === 'today' && {
        postPublishedAt: { gte: dayjs.utc().startOf('day').toDate() },
      }),
      ...(date === 'week' && {
        postPublishedAt: { gte: dayjs.utc().startOf('isoWeek').toDate() },
      }),
      ...(date === 'month' && {
        postPublishedAt: { gte: dayjs.utc().startOf('month').toDate() },
      }),
    };

    // DB-side aggregation — no row cap. Earlier implementation pulled up to 10_000
    // rows into JS and reduced; that silently undercounted high-volume orgs.
    const round1 = (n: number | null | undefined) =>
      n == null ? 0 : Math.round(n * 10) / 10;

    const [agg, distRows, trackedCount, bestKeyword, bestHeat, bestAuthority] =
      await Promise.all([
        this._opportunity.model.engageOpportunity.aggregate({
          where,
          _count: { _all: true },
          _avg: {
            score: true,
            scoreKeyword: true,
            scoreHeat: true,
            scoreAuthority: true,
            scoreRecency: true,
            scoreTracked: true,
          },
        }),
        this._opportunity.model.engageOpportunity.findMany({
          where,
          select: { score: true },
          // small projection used purely for the 3-bucket distribution; bounded by
          // followup aggregations below — we trust this cap because distribution is
          // a percentage and high-N samples converge fast.
          take: 10_000,
        }),
        this._opportunity.model.engageOpportunity.count({
          where: { ...where, scoreTracked: { gt: 0 } },
        }),
        this._opportunity.model.engageOpportunity.findFirst({
          where,
          orderBy: { scoreKeyword: 'desc' },
          select: { id: true, scoreKeyword: true, postContent: true },
        }),
        this._opportunity.model.engageOpportunity.findFirst({
          where,
          orderBy: { scoreHeat: 'desc' },
          select: { id: true, scoreHeat: true, postContent: true },
        }),
        this._opportunity.model.engageOpportunity.findFirst({
          where,
          orderBy: { scoreAuthority: 'desc' },
          select: { id: true, scoreAuthority: true, postContent: true },
        }),
      ]);

    const total = agg._count._all;
    if (total === 0) {
      return {
        total: 0,
        avgScore: 0,
        avgScoreKeyword: 0,
        avgScoreHeat: 0,
        avgScoreAuthority: 0,
        avgScoreRecency: 0,
        avgScoreTracked: 0,
        distribution: [] as Array<{ range: string; count: number; pct: number }>,
        topByKeyword: null as null | { id: string; score: number; title: string },
        topByHeat: null as null | { id: string; score: number; title: string },
        topByAuthority: null as null | { id: string; score: number; title: string },
        trackedCount: 0,
      };
    }

    const buckets = [
      { range: '85-100' as const, min: 85, max: 100 },
      { range: '70-84' as const, min: 70, max: 84 },
      { range: '60-69' as const, min: 60, max: 69 },
    ];
    const distSampleSize = distRows.length;
    const distribution = buckets.map(({ range, min, max }) => {
      const count = distRows.filter((o) => o.score >= min && o.score <= max).length;
      return {
        range,
        count,
        pct: distSampleSize > 0
          ? Math.round((count / distSampleSize) * 100)
          : 0,
      };
    });

    return {
      total,
      avgScore: round1(agg._avg.score),
      avgScoreKeyword: round1(agg._avg.scoreKeyword),
      avgScoreHeat: round1(agg._avg.scoreHeat),
      avgScoreAuthority: round1(agg._avg.scoreAuthority),
      avgScoreRecency: round1(agg._avg.scoreRecency),
      avgScoreTracked: round1(agg._avg.scoreTracked),
      distribution,
      topByKeyword: bestKeyword && {
        id: bestKeyword.id,
        score: bestKeyword.scoreKeyword,
        title: bestKeyword.postContent.slice(0, 80),
      },
      topByHeat: bestHeat && {
        id: bestHeat.id,
        score: bestHeat.scoreHeat,
        title: bestHeat.postContent.slice(0, 80),
      },
      topByAuthority: bestAuthority && {
        id: bestAuthority.id,
        score: bestAuthority.scoreAuthority,
        title: bestAuthority.postContent.slice(0, 80),
      },
      trackedCount,
    };
  }

  async getOpportunityById(organizationId: string, id: string) {
    const opp = await this._opportunity.model.engageOpportunity.findFirst({
      where: { id, organizationId },
    });
    if (!opp) throw new NotFoundException('Opportunity not found');
    return opp;
  }

  async getOpportunityForReply(organizationId: string, id: string) {
    const opp = await this._opportunity.model.engageOpportunity.findFirst({
      where: { id, organizationId, status: { in: ['NEW', 'AUTO_QUEUED'] } },
    });
    if (!opp) throw new NotFoundException('Opportunity not found or already replied');
    return opp;
  }

  // ─── Sent Replies ─────────────────────────────────────────────────────────

  async createSentReply(data: {
    organizationId: string;
    opportunityId: string;
    postId: string;
    strategy: string;
    brandStrength: number;
  }) {
    return this._sentReply.model.engageSentReply.create({ data });
  }

  async listSentReplies(organizationId: string, dto: ListSentDto) {
    const page = dto.page ?? 1;
    const limit = dto.limit ?? 20;
    const offset = (page - 1) * limit;

    const postWhere: Prisma.PostWhereInput = {
      source: 'engage',
      ...(dto.date === 'today' && {
        publishDate: { gte: dayjs.utc().startOf('day').toDate() },
      }),
      ...(dto.date === 'week' && {
        publishDate: { gte: dayjs.utc().startOf('isoWeek').toDate() },
      }),
      ...(dto.date === 'month' && {
        publishDate: { gte: dayjs.utc().startOf('month').toDate() },
      }),
    };

    if (dto.status === 'published') postWhere.state = 'PUBLISHED';
    else if (dto.status === 'scheduled') postWhere.state = 'QUEUE';
    else if (dto.status === 'error') postWhere.state = 'ERROR';
    else if (dto.status === 'manual') {
      postWhere.state = 'PUBLISHED';
      postWhere.releaseURL = null;
    }

    const where: Prisma.EngageSentReplyWhereInput = {
      organizationId,
      post: postWhere,
      // Apply platform filter via the linked opportunity's platform field
      ...(dto.platform && {
        opportunity: { platform: dto.platform },
      }),
    };

    const [items, total] = await Promise.all([
      this._sentReply.model.engageSentReply.findMany({
        where,
        include: {
          post: {
            select: {
              id: true,
              content: true,
              state: true,
              releaseURL: true,
              publishDate: true,
              impressions: true,
              trafficScore: true,
              analytics: true,
              integration: {
                select: {
                  id: true,
                  name: true,
                  providerIdentifier: true,
                  picture: true,
                },
              },
            },
          },
          opportunity: {
            select: {
              id: true,
              platform: true,
              externalPostUrl: true,
              postContent: true,
              authorUsername: true,
              authorDisplayName: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit,
      }),
      this._sentReply.model.engageSentReply.count({ where }),
    ]);

    return { items, total, page, limit };
  }

  async getSentStats(organizationId: string) {
    const weekStart = dayjs.utc().startOf('isoWeek').toDate();

    // Totals and response rate via DB aggregation — no row cap.
    const [totalAgg, repliedCount, weeklyReplies, impressionsAgg, likeSample] =
      await Promise.all([
        this._sentReply.model.engageSentReply.count({
          where: { organizationId },
        }),
        this._sentReply.model.engageSentReply.count({
          where: { organizationId, authorReplied: true },
        }),
        this._sentReply.model.engageSentReply.count({
          where: {
            organizationId,
            post: { is: { source: 'engage', publishDate: { gte: weekStart } } },
          },
        }),
        // Impressions live on Post; sum across the org's engage posts.
        this._post.model.post.aggregate({
          where: {
            organizationId,
            source: 'engage',
          },
          _sum: { impressions: true },
        }),
        // Analytics is a JSON column; aggregating inside is database-specific.
        // Keep a bounded recent sample (1_000 most recent replies) just for the
        // avgLikes derivation — total/responseRate/impressions are now exact.
        this._sentReply.model.engageSentReply.findMany({
          where: { organizationId },
          orderBy: { createdAt: 'desc' },
          take: 1_000,
          select: { post: { select: { analytics: true } } },
        }),
      ]);

    const total = totalAgg;
    const responseRate =
      total > 0 ? Math.round((repliedCount / total) * 100) : 0;
    const totalImpressions = impressionsAgg._sum.impressions ?? 0;

    const likesPerReply = likeSample
      .map((r) => {
        const analytics = r.post?.analytics as Array<{
          label: string;
          data: number[];
        }> | null;
        if (!analytics) return 0;
        const likesEntry = analytics.find((a) => /like|reaction/i.test(a.label));
        return likesEntry?.data?.[0] ?? 0;
      })
      .filter((v) => v > 0);

    const avgLikes =
      likesPerReply.length > 0
        ? Math.round(
            likesPerReply.reduce((s, v) => s + v, 0) / likesPerReply.length
          )
        : 0;

    return { weeklyCount: weeklyReplies, responseRate, totalImpressions, avgLikes };
  }

  async getSentReplyById(organizationId: string, id: string) {
    const reply = await this._sentReply.model.engageSentReply.findFirst({
      where: { id, organizationId },
      include: { post: true },
    });
    if (!reply) throw new NotFoundException('Sent reply not found');
    return reply;
  }

  async updateReplyUrl(organizationId: string, sentReplyId: string, url: string) {
    const reply = await this.getSentReplyById(organizationId, sentReplyId);
    return this._post.model.post.update({
      where: { id: reply.postId },
      data: { releaseURL: url },
    });
  }

  async markAuthorReplied(sentReplyId: string) {
    return this._sentReply.model.engageSentReply.update({
      where: { id: sentReplyId },
      data: { authorReplied: true },
    });
  }

  async setOpportunityStatus(
    opportunityId: string,
    status: 'REPLIED' | 'SCHEDULED' | 'DISMISSED' | 'AUTO_QUEUED' | 'EXPIRED'
  ) {
    return this._opportunity.model.engageOpportunity.update({
      where: { id: opportunityId },
      data: { status },
    });
  }

  async createManualRedditPost(data: {
    organizationId: string;
    content: string;
    date: Date;
  }) {
    const { randomUUID } = await import('crypto');
    return this._post.model.post.create({
      data: {
        organizationId: data.organizationId,
        content: data.content,
        publishDate: data.date,
        state: 'PUBLISHED',
        source: 'engage',
        image: '[]',
        settings: JSON.stringify({ __type: 'reddit' }),
        group: randomUUID(),
        delay: 0,
        // integrationId intentionally omitted: Reddit manual posts have no integration
      },
    });
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private async _getConfigId(organizationId: string): Promise<string> {
    const config = await this._config.model.engageConfig.findUnique({
      where: { organizationId },
    });
    if (!config)
      throw new NotFoundException(
        'EngageConfig not found — call GET /engage/config first'
      );
    return config.id;
  }
}
