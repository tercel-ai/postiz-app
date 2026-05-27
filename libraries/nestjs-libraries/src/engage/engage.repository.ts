import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, EngageOpportunity, EngageOpportunityStatus } from '@prisma/client';
import { PrismaRepository, PrismaTransaction } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import {
  AddKeywordDto,
  AddKeywordsBulkDto,
  AddMonitoredChannelDto,
  AddTrackedAccountDto,
  ListOpportunitiesDto,
  ListSentDto,
  SetupEngageDto,
  UpdateKeywordDto,
  UpdateMonitoredChannelDto,
  UpdateReplyAccountDto,
  UpdateTrackedAccountDto,
  ENGAGE_FILTER_ALL,
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
    private _oppState: PrismaRepository<'engageOpportunityState'>,
    private _sentReply: PrismaRepository<'engageSentReply'>,
    private _integration: PrismaRepository<'integration'>,
    private _post: PrismaRepository<'post'>,
    private _tx: PrismaTransaction
  ) {}

  // ─── Config ────────────────────────────────────────────────────────────────

  async getOrCreateConfig(organizationId: string) {
    // Atomic upsert: two concurrent first-call requests would otherwise both
    // miss findUnique and race on create → Prisma P2002 unique violation.
    return this._config.model.engageConfig.upsert({
      where: { organizationId },
      create: { organizationId, enabled: false },
      update: {},
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
  }

  async getAllEnabledOrgContexts() {
    return this._config.model.engageConfig.findMany({
      where: { enabled: true },
      include: {
        keywords: {
          where: { enabled: true },
          orderBy: { createdAt: 'asc' },
        },
        monitoredChannels: {
          where: { enabled: true },
          orderBy: { createdAt: 'asc' },
        },
        trackedAccounts: {
          where: { enabled: true },
          orderBy: { createdAt: 'asc' },
        },
        xReplyAccounts: { where: { engageEnabled: true } },
      },
    });
  }

  async saveConfig(
    organizationId: string,
    data: Partial<{ enabled: boolean; lastScanAt: Date }>
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
      data: { enabled: false },
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
        type: dto.type ?? null,
        enabled: dto.enabled ?? true,
      },
    });
  }

  // Atomic bulk-add — used by the setup wizard so a partial-commit mid-loop
  // cannot leave the user in a half-initialized state. createMany compiles to
  // a single INSERT … ON CONFLICT DO NOTHING (skipDuplicates), so repeating a
  // setup attempt with overlapping keywords is safe.
  async addKeywordsBulk(
    configId: string,
    organizationId: string,
    dto: AddKeywordsBulkDto
  ) {
    const data = dto.keywords.map((kw) => ({
      configId,
      organizationId,
      keyword: kw.keyword,
      type: kw.type ?? null,
      enabled: kw.enabled ?? true,
    }));
    return this._keyword.model.engageKeyword.createMany({
      data,
      skipDuplicates: true,
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

  async getKeywordPosts(organizationId: string, keywordId: string, limit = 8) {
    const kw = await this._keyword.model.engageKeyword.findFirst({
      where: { id: keywordId, organizationId },
    });
    if (!kw) throw new NotFoundException('Keyword not found');
    // Posts are global now — preview any post whose content matches the keyword.
    // The trigram GIN index on postContent backs this ILIKE.
    return this._opportunity.model.engageOpportunity.findMany({
      where: {
        deletedAt: null,
        postContent: { contains: kw.keyword, mode: 'insensitive' },
      },
      orderBy: { postPublishedAt: 'desc' },
      take: limit,
      select: {
        id: true,
        platform: true,
        externalPostUrl: true,
        authorUsername: true,
        postContent: true,
        postPublishedAt: true,
        metricScore: true,
        metricComments: true,
        metricLikes: true,
        scoreHeat: true,
      },
    });
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
        ...(dto.picture && { picture: dto.picture }),
        ...(dto.categoryLabel && { categoryLabel: dto.categoryLabel }),
        ...(dto.enabled !== undefined && { enabled: dto.enabled }),
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
        ...(dto.picture !== undefined && { picture: dto.picture }),
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

  async getRedditIntegrationToken(organizationId: string): Promise<string | null> {
    const integration = await this._integration.model.integration.findFirst({
      where: {
        organizationId,
        providerIdentifier: 'reddit',
        deletedAt: null,
        disabled: false,
      },
      select: { token: true },
      orderBy: { createdAt: 'desc' },
    });
    return integration?.token ?? null;
  }

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

  // Flatten a per-org state row + its global opportunity into the legacy
  // EngageOpportunity response shape the API/frontend expect. `id` stays the
  // opportunity id (the value the controller's :id routes operate on).
  private _merge<
    T extends {
      status: EngageOpportunityStatus;
      bookmarked: boolean;
      score: number;
      scoreKeyword: number;
      scoreTracked: number;
      opportunity: EngageOpportunity;
    }
  >(state: T) {
    const { opportunity, status, bookmarked, score, scoreKeyword, scoreTracked } =
      state;
    return {
      ...opportunity,
      status,
      bookmarked,
      score,
      scoreKeyword,
      scoreTracked,
    };
  }

  async listOpportunities(organizationId: string, dto: ListOpportunitiesDto) {
    const page = dto.page ?? 1;
    const limit = dto.limit ?? 20;
    const offset = (page - 1) * limit;

    // Channel filter: `__all__` → this org's enabled monitored channels (empty set
    // → match none, which is correct: no channels means no channel-sourced posts);
    // any other value → that specific channel id.
    const channelsAll = dto.channels === ENGAGE_FILTER_ALL;
    let channelIdFilter: Prisma.StringNullableFilter | string | undefined;
    if (dto.channels && !channelsAll) {
      channelIdFilter = dto.channels;
    } else if (channelsAll) {
      const channels = await this._channel.model.engageMonitoredChannel.findMany({
        where: { organizationId, enabled: true },
        select: { channelId: true },
      });
      channelIdFilter = { in: channels.map((c) => c.channelId) };
    }

    // Author filter: `__all__` → any tracked account (scoreTracked on the state row,
    // case-normalized at scan time); any other value → that specific author username.
    const authorsAll = dto.authors === ENGAGE_FILTER_ALL;
    const authorSpecific = dto.authors && !authorsAll ? dto.authors : undefined;

    // State-table filters (per-org) + nested opportunity filters (global).
    const where: Prisma.EngageOpportunityStateWhereInput = {
      organizationId,
      ...(dto.status && { status: dto.status }),
      ...(dto.bookmarked !== undefined && { bookmarked: dto.bookmarked }),
      ...(dto.minScore !== undefined && { score: { gte: dto.minScore } }),
      ...(dto.minScoreKeyword !== undefined && {
        scoreKeyword: { gte: dto.minScoreKeyword },
      }),
      ...(authorsAll && { scoreTracked: { gt: 0 } }),
      opportunity: {
        deletedAt: null,
        ...(dto.platform && { platform: dto.platform }),
        ...(channelIdFilter !== undefined && { channelId: channelIdFilter }),
        ...(authorSpecific && {
          authorUsername: { equals: authorSpecific, mode: 'insensitive' },
        }),
        ...(dto.intent && { intentTags: { has: dto.intent } }),
        ...(dto.minScoreHeat !== undefined && {
          scoreHeat: { gte: dto.minScoreHeat },
        }),
        ...(dto.minScoreAuthority !== undefined && {
          scoreAuthority: { gte: dto.minScoreAuthority },
        }),
        ...(dto.date === 'today' && {
          postPublishedAt: { gte: dayjs.utc().startOf('day').toDate() },
        }),
        ...(dto.date === 'week' && {
          postPublishedAt: { gte: dayjs.utc().startOf('isoWeek').toDate() },
        }),
      },
    };

    // Route sort field to the table that owns it.
    const stateSortFields = new Set([
      'score',
      'scoreKeyword',
      'scoreTracked',
      'createdAt',
    ]);
    const oppSortFields = new Set([
      'scoreHeat',
      'scoreAuthority',
      'scoreRecency',
    ]);
    const sortBy =
      dto.sortBy && (stateSortFields.has(dto.sortBy) || oppSortFields.has(dto.sortBy))
        ? dto.sortBy
        : 'score';
    const sortOrder = dto.sortOrder ?? 'desc';
    const orderBy = oppSortFields.has(sortBy)
      ? { opportunity: { [sortBy]: sortOrder } }
      : { [sortBy]: sortOrder };

    const [rows, total] = await Promise.all([
      this._oppState.model.engageOpportunityState.findMany({
        where,
        include: { opportunity: true },
        orderBy,
        skip: offset,
        take: limit,
      }),
      this._oppState.model.engageOpportunityState.count({ where }),
    ]);

    return { items: rows.map((r) => this._merge(r)), total, page, limit };
  }

  async dismissOpportunity(organizationId: string, id: string) {
    // Atomic: only dismiss actionable opportunities. Replied/scheduled rows are protected.
    // `id` is the opportunity id; status lives on this org's state row.
    const result = await this._oppState.model.engageOpportunityState.updateMany({
      where: {
        organizationId,
        opportunityId: id,
        status: { in: ['NEW', 'AUTO_QUEUED'] },
      },
      data: { status: 'DISMISSED' },
    });
    if (result.count === 0) {
      throw new NotFoundException('Opportunity not found or no longer actionable');
    }
    const row = await this._oppState.model.engageOpportunityState.findUnique({
      where: {
        organizationId_opportunityId: { organizationId, opportunityId: id },
      },
      include: { opportunity: true },
    });
    return row ? this._merge(row) : null;
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
    const existing = await this._oppState.model.engageOpportunityState.findUnique({
      where: {
        organizationId_opportunityId: { organizationId, opportunityId: id },
      },
      select: { status: true },
    });
    if (!existing || !['NEW', 'AUTO_QUEUED'].includes(existing.status)) {
      throw new NotFoundException('Opportunity not found or already replied');
    }
    const priorStatus = existing.status as 'NEW' | 'AUTO_QUEUED';

    const result = await this._oppState.model.engageOpportunityState.updateMany({
      where: { organizationId, opportunityId: id, status: priorStatus },
      data: { status: claimStatus },
    });
    if (result.count === 0) {
      throw new NotFoundException('Opportunity already claimed by another request');
    }
    const row = await this._oppState.model.engageOpportunityState.findUnique({
      where: {
        organizationId_opportunityId: { organizationId, opportunityId: id },
      },
      include: { opportunity: true },
    });
    if (!row) throw new NotFoundException('Opportunity not found');
    return { opp: this._merge(row), priorStatus };
  }

  // Rollback helper — restores an opportunity to its prior status after a failed
  // post-claim operation. Best-effort; never throws.
  async releaseOpportunityClaim(
    organizationId: string,
    id: string,
    priorStatus: 'NEW' | 'AUTO_QUEUED' = 'NEW'
  ) {
    try {
      await this._oppState.model.engageOpportunityState.updateMany({
        where: { organizationId, opportunityId: id },
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
    const row = await this._oppState.model.engageOpportunityState.findUnique({
      where: {
        organizationId_opportunityId: { organizationId, opportunityId: id },
      },
    });
    if (!row) throw new NotFoundException('Opportunity not found');
    const updated = await this._oppState.model.engageOpportunityState.update({
      where: {
        organizationId_opportunityId: { organizationId, opportunityId: id },
      },
      data: { bookmarked: !row.bookmarked },
      include: { opportunity: true },
    });
    return this._merge(updated);
  }

  async getScoreStats(
    organizationId: string,
    date?: 'today' | 'week' | 'month',
    platform?: string
  ) {
    // Date/platform filters live on the global opportunity; per-org membership is
    // expressed via the state relation. Two aggregates: org-specific scores from
    // the state table, objective scores from the opportunity table.
    const oppFilter: Prisma.EngageOpportunityWhereInput = {
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
    const stateWhere: Prisma.EngageOpportunityStateWhereInput = {
      organizationId,
      opportunity: oppFilter,
    };
    const oppWhere: Prisma.EngageOpportunityWhereInput = {
      ...oppFilter,
      states: { some: { organizationId } },
    };

    const round1 = (n: number | null | undefined) =>
      n == null ? 0 : Math.round(n * 10) / 10;

    const [stateAgg, oppAgg, distRows, trackedCount, bestKeyword, bestHeat, bestAuthority] =
      await Promise.all([
        this._oppState.model.engageOpportunityState.aggregate({
          where: stateWhere,
          _count: { _all: true },
          _avg: { score: true, scoreKeyword: true, scoreTracked: true },
        }),
        this._opportunity.model.engageOpportunity.aggregate({
          where: oppWhere,
          _avg: { scoreHeat: true, scoreAuthority: true, scoreRecency: true },
        }),
        this._oppState.model.engageOpportunityState.findMany({
          where: stateWhere,
          select: { score: true },
          take: 10_000,
        }),
        this._oppState.model.engageOpportunityState.count({
          where: { ...stateWhere, scoreTracked: { gt: 0 } },
        }),
        this._oppState.model.engageOpportunityState.findFirst({
          where: stateWhere,
          orderBy: { scoreKeyword: 'desc' },
          select: {
            opportunityId: true,
            scoreKeyword: true,
            opportunity: { select: { postContent: true } },
          },
        }),
        this._opportunity.model.engageOpportunity.findFirst({
          where: oppWhere,
          orderBy: { scoreHeat: 'desc' },
          select: { id: true, scoreHeat: true, postContent: true },
        }),
        this._opportunity.model.engageOpportunity.findFirst({
          where: oppWhere,
          orderBy: { scoreAuthority: 'desc' },
          select: { id: true, scoreAuthority: true, postContent: true },
        }),
      ]);

    const total = stateAgg._count._all;
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
      avgScore: round1(stateAgg._avg.score),
      avgScoreKeyword: round1(stateAgg._avg.scoreKeyword),
      avgScoreHeat: round1(oppAgg._avg.scoreHeat),
      avgScoreAuthority: round1(oppAgg._avg.scoreAuthority),
      avgScoreRecency: round1(oppAgg._avg.scoreRecency),
      avgScoreTracked: round1(stateAgg._avg.scoreTracked),
      distribution,
      topByKeyword: bestKeyword && {
        id: bestKeyword.opportunityId,
        score: bestKeyword.scoreKeyword,
        title: bestKeyword.opportunity.postContent.slice(0, 80),
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
    const row = await this._oppState.model.engageOpportunityState.findUnique({
      where: {
        organizationId_opportunityId: { organizationId, opportunityId: id },
      },
      include: { opportunity: true },
    });
    if (!row) throw new NotFoundException('Opportunity not found');
    return this._merge(row);
  }

  async getOpportunityForReply(organizationId: string, id: string) {
    const row = await this._oppState.model.engageOpportunityState.findUnique({
      where: {
        organizationId_opportunityId: { organizationId, opportunityId: id },
      },
      include: { opportunity: true },
    });
    if (!row || !['NEW', 'AUTO_QUEUED'].includes(row.status)) {
      throw new NotFoundException('Opportunity not found or already replied');
    }
    return this._merge(row);
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
    // Joining the opportunity here so we can reject non-Reddit replies. Without
    // this guard a caller can supply any sentReplyId in the org and overwrite an
    // X reply's tweet URL with a Reddit comment URL, corrupting metrics linkage.
    const reply = await this._sentReply.model.engageSentReply.findFirst({
      where: { id: sentReplyId, organizationId },
      include: { opportunity: { select: { platform: true } } },
    });
    if (!reply) throw new NotFoundException('Sent reply not found');
    if (reply.opportunity.platform !== 'reddit') {
      throw new BadRequestException(
        'Reply-URL submission is only valid for Reddit manual replies'
      );
    }
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
    organizationId: string,
    opportunityId: string,
    status: 'REPLIED' | 'SCHEDULED' | 'DISMISSED' | 'AUTO_QUEUED' | 'EXPIRED'
  ) {
    return this._oppState.model.engageOpportunityState.update({
      where: {
        organizationId_opportunityId: { organizationId, opportunityId },
      },
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

  // ─── Setup (atomic bulk init) ─────────────────────────────────────────────

  async setupEngage(organizationId: string, dto: SetupEngageDto) {
    return this._tx.model.$transaction(async (tx) => {
      const config = await tx.engageConfig.upsert({
        where: { organizationId },
        create: { organizationId, enabled: true },
        update: { enabled: true },
      });

      if (dto.keywords?.length) {
        await tx.engageKeyword.createMany({
          data: dto.keywords.map((kw) => ({
            configId: config.id,
            organizationId,
            keyword: kw.keyword,
            type: kw.type ?? null,
            enabled: kw.enabled ?? true,
          })),
          skipDuplicates: true,
        });
      }

      if (dto.monitoredChannels?.length) {
        await tx.engageMonitoredChannel.createMany({
          data: dto.monitoredChannels.map((ch) => ({
            configId: config.id,
            organizationId,
            platform: ch.platform,
            channelId: ch.channelId,
            channelName: ch.channelName,
            audienceSize: ch.audienceSize ?? 0,
            ...(ch.metadata && { metadata: ch.metadata as Prisma.InputJsonValue }),
          })),
          skipDuplicates: true,
        });
      }

      if (dto.trackedAccounts?.length) {
        await tx.engageTrackedAccount.createMany({
          data: dto.trackedAccounts.map((acc) => ({
            configId: config.id,
            organizationId,
            platform: acc.platform ?? 'x',
            username: acc.username,
            ...(acc.picture && { picture: acc.picture }),
            ...(acc.categoryLabel && { categoryLabel: acc.categoryLabel }),
          })),
          skipDuplicates: true,
        });
      }

      return config;
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
