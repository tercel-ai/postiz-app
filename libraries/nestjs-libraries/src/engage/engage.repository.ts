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
    return this._opportunity.model.engageOpportunity.update({
      where: { id, organizationId },
      data: { status: 'DISMISSED' },
    });
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

    const opps = await this._opportunity.model.engageOpportunity.findMany({
      where,
      take: 10_000, // guard against unbounded load on high-volume orgs
      select: {
        id: true,
        score: true,
        scoreKeyword: true,
        scoreHeat: true,
        scoreAuthority: true,
        scoreRecency: true,
        scoreTracked: true,
        postContent: true,
      },
    });

    if (!opps.length) {
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

    const total = opps.length;
    const avg = (field: keyof (typeof opps)[0]) =>
      Math.round(
        (opps.reduce((s, o) => s + Number(o[field] ?? 0), 0) / total) * 10
      ) / 10;

    // Exclusive range buckets — each score belongs to exactly one bucket
    const buckets = [
      { range: '85-100' as const, min: 85, max: 100 },
      { range: '70-84' as const, min: 70, max: 84 },
      { range: '60-69' as const, min: 60, max: 69 },
    ];
    const distribution = buckets.map(({ range, min, max }) => {
      const count = opps.filter((o) => o.score >= min && o.score <= max).length;
      return { range, count, pct: Math.round((count / total) * 100) };
    });

    const topByKeyword = opps.reduce((a, b) =>
      b.scoreKeyword > a.scoreKeyword ? b : a
    );
    const topByHeat = opps.reduce((a, b) =>
      b.scoreHeat > a.scoreHeat ? b : a
    );
    const topByAuthority = opps.reduce((a, b) =>
      b.scoreAuthority > a.scoreAuthority ? b : a
    );

    return {
      total,
      avgScore: avg('score'),
      avgScoreKeyword: avg('scoreKeyword'),
      avgScoreHeat: avg('scoreHeat'),
      avgScoreAuthority: avg('scoreAuthority'),
      avgScoreRecency: avg('scoreRecency'),
      avgScoreTracked: avg('scoreTracked'),
      distribution,
      topByKeyword: {
        id: topByKeyword.id,
        score: topByKeyword.scoreKeyword,
        title: topByKeyword.postContent.slice(0, 80),
      },
      topByHeat: {
        id: topByHeat.id,
        score: topByHeat.scoreHeat,
        title: topByHeat.postContent.slice(0, 80),
      },
      topByAuthority: {
        id: topByAuthority.id,
        score: topByAuthority.scoreAuthority,
        title: topByAuthority.postContent.slice(0, 80),
      },
      trackedCount: opps.filter((o) => o.scoreTracked > 0).length,
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

    const [allReplies, weeklyReplies] = await Promise.all([
      this._sentReply.model.engageSentReply.findMany({
        where: { organizationId },
        take: 5_000, // guard against unbounded load for high-volume orgs
        select: {
          authorReplied: true,
          post: { select: { impressions: true, analytics: true } },
        },
      }),
      this._sentReply.model.engageSentReply.count({
        where: {
          organizationId,
          post: { is: { source: 'engage', publishDate: { gte: weekStart } } },
        },
      }),
    ]);

    const total = allReplies.length;
    const responseRate =
      total > 0
        ? Math.round(
            (allReplies.filter((r) => r.authorReplied).length / total) * 100
          )
        : 0;
    const totalImpressions = allReplies.reduce(
      (s, r) => s + (r.post?.impressions ?? 0),
      0
    );

    const likesPerReply = allReplies
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
