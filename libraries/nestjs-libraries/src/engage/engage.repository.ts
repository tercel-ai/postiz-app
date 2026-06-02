import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
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

  // Runs a create that may hit a unique constraint and converts the resulting
  // Prisma P2002 into a readable 409 ConflictException instead of letting it
  // bubble up as a generic 500. `label` describes the duplicated entity, e.g.
  // `Keyword "nestjs"`.
  private async _createOrConflict<T>(
    label: string,
    op: () => Promise<T>
  ): Promise<T> {
    try {
      return await op();
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException(`${label} already exists`);
      }
      throw err;
    }
  }

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
    // Unique violation on (configId, keyword) → 409 with a readable message.
    return this._createOrConflict(`Keyword "${dto.keyword}"`, () =>
      this._keyword.model.engageKeyword.create({
        data: {
          configId,
          organizationId,
          keyword: dto.keyword,
          type: dto.type ?? null,
          enabled: dto.enabled ?? true,
        },
      })
    );
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
    // Unique violation on (configId, platform, channelId) → 409.
    return this._createOrConflict(
      `Channel "${dto.channelName ?? dto.channelId}"`,
      () =>
        this._channel.model.engageMonitoredChannel.create({
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
        })
    );
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
    // Unique violation on (configId, platform, username) → 409.
    return this._createOrConflict(`Account "${dto.username}"`, () =>
      this._trackedAccount.model.engageTrackedAccount.create({
        data: {
          configId,
          organizationId,
          platform: dto.platform ?? 'x',
          username: dto.username,
          ...(dto.picture && { picture: dto.picture }),
          ...(dto.categoryLabel && { categoryLabel: dto.categoryLabel }),
          ...(dto.enabled !== undefined && { enabled: dto.enabled }),
        },
      })
    );
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
  //
  // Fields are listed explicitly (not via `...opportunity`) so the compiler
  // catches any future schema migration that accidentally moves a score field
  // to the wrong table — the global/per-org boundary is enforced at the type
  // level by naming each field's source.
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
      // ── Global fields (EngageOpportunity) ──────────────────────────────────
      id: opportunity.id,
      platform: opportunity.platform,
      externalPostId: opportunity.externalPostId,
      externalPostUrl: opportunity.externalPostUrl,
      channelId: opportunity.channelId,
      channelName: opportunity.channelName,
      authorUsername: opportunity.authorUsername,
      authorDisplayName: opportunity.authorDisplayName,
      authorFollowers: opportunity.authorFollowers,
      authorAvatarUrl: opportunity.authorAvatarUrl,
      postContent: opportunity.postContent,
      postPublishedAt: opportunity.postPublishedAt,
      // Objective scores — identical across all orgs
      scoreHeat: opportunity.scoreHeat,
      scoreAuthority: opportunity.scoreAuthority,
      scoreRecency: opportunity.scoreRecency,
      intentTags: opportunity.intentTags,
      primaryIntent: opportunity.primaryIntent,
      intentScore: opportunity.intentScore,
      metricLikes: opportunity.metricLikes,
      metricReplies: opportunity.metricReplies,
      metricRetweets: opportunity.metricRetweets,
      metricQuotes: opportunity.metricQuotes,
      metricBookmarks: opportunity.metricBookmarks,
      metricViews: opportunity.metricViews,
      metricShares: opportunity.metricShares,
      metricSaves: opportunity.metricSaves,
      metricScore: opportunity.metricScore,
      metricUpvoteRatio: opportunity.metricUpvoteRatio,
      metricComments: opportunity.metricComments,
      rawData: opportunity.rawData,
      createdAt: opportunity.createdAt,
      updatedAt: opportunity.updatedAt,
      deletedAt: opportunity.deletedAt,
      // ── Per-org fields (EngageOpportunityState) ───────────────────────────
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

  // Resets a SCHEDULED opportunity back to NEW so that sendReply can claim it.
  // Used by cancelAndSendNow after the scheduled post has been deleted.
  async resetScheduledOpportunity(organizationId: string, opportunityId: string) {
    const result = await this._oppState.model.engageOpportunityState.updateMany({
      where: { organizationId, opportunityId, status: 'SCHEDULED' },
      data: { status: 'NEW' },
    });
    if (result.count === 0) {
      throw new BadRequestException('Opportunity is not in SCHEDULED state');
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

  async getOpportunityDetail(organizationId: string, id: string) {
    const row = await this._oppState.model.engageOpportunityState.findUnique({
      where: {
        organizationId_opportunityId: { organizationId, opportunityId: id },
      },
      include: { opportunity: true },
    });
    if (!row) throw new NotFoundException('Opportunity not found');

    const merged = this._merge(row);

    if (row.status === 'SCHEDULED' || row.status === 'REPLIED') {
      const sentReply = await this._sentReply.model.engageSentReply.findUnique({
        where: {
          organizationId_opportunityId: { organizationId, opportunityId: id },
        },
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
      });
      return { ...merged, sentReply };
    }

    return { ...merged, sentReply: null };
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
    inputData: object;
  }) {
    return this._sentReply.model.engageSentReply.create({ data });
  }

  // Shared filter for the sent-reply LIST and STATS so both apply identical
  // date/platform/status semantics. No `date` → all-time (no publishDate window),
  // mirroring /engage/sent. Returns both the Post-scoped and SentReply-scoped where.
  private _buildSentReplyFilter(
    organizationId: string,
    dto: { date?: string; platform?: string; status?: string }
  ): { postWhere: Prisma.PostWhereInput; sentWhere: Prisma.EngageSentReplyWhereInput } {
    // Single source of truth for the date→publishDate window (shared with
    // getDashboardSummary), so /sent, /sent/stats and /dashboard/summary all
    // accept the same vocabulary (all | day | today | week | month).
    const postWhere: Prisma.PostWhereInput = {
      source: 'engage',
      ...this._engageDateWindow(dto.date),
    };

    if (dto.status === 'published') {
      postWhere.state = 'PUBLISHED';
      postWhere.releaseURL = { not: null };
    } else if (dto.status === 'scheduled') postWhere.state = 'QUEUE';
    else if (dto.status === 'error') postWhere.state = 'ERROR';
    else if (dto.status === 'manual') {
      postWhere.state = 'PUBLISHED';
      postWhere.releaseURL = null;
    }

    const sentWhere: Prisma.EngageSentReplyWhereInput = {
      organizationId,
      post: postWhere,
      // Apply platform filter via the linked opportunity's platform field
      ...(dto.platform && {
        opportunity: { platform: dto.platform },
      }),
    };

    return { postWhere, sentWhere };
  }

  async listSentReplies(organizationId: string, dto: ListSentDto) {
    const page = dto.page ?? 1;
    const limit = dto.limit ?? 20;
    const offset = (page - 1) * limit;

    const { sentWhere: where } = this._buildSentReplyFilter(organizationId, dto);

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

  // Aggregate stats for sent replies, scoped by the SAME date/platform/status
  // filters as listSentReplies (no `date` → all-time). repliesCount, responseRate,
  // totalImpressions and avgLikes all reflect the selected window.
  async getSentStats(
    organizationId: string,
    dto: { date?: string; platform?: string; status?: string } = {}
  ) {
    const { postWhere, sentWhere } = this._buildSentReplyFilter(organizationId, dto);

    // Totals and response rate via DB aggregation — no row cap.
    const [total, repliedCount, impressionsAgg, likeSample] = await Promise.all([
      this._sentReply.model.engageSentReply.count({ where: sentWhere }),
      this._sentReply.model.engageSentReply.count({
        where: { ...sentWhere, authorReplied: true },
      }),
      // Impressions live on Post; sum across the windowed engage posts. The
      // platform filter goes through the post→engageSentReply→opportunity link.
      this._post.model.post.aggregate({
        where: {
          organizationId,
          ...postWhere,
          ...(dto.platform
            ? { engageSentReply: { is: { opportunity: { platform: dto.platform } } } }
            : {}),
        },
        _sum: { impressions: true, trafficScore: true },
      }),
      // Analytics is a JSON column; aggregating inside is database-specific.
      // Keep a bounded recent sample (1_000 most recent replies) just for the
      // avgLikes derivation — total/responseRate/impressions are now exact.
      this._sentReply.model.engageSentReply.findMany({
        where: sentWhere,
        orderBy: { createdAt: 'desc' },
        take: 1_000,
        select: {
          post: { select: { analytics: true } },
          opportunity: { select: { platform: true } },
        },
      }),
    ]);

    const responseRate =
      total > 0 ? Math.round((repliedCount / total) * 100) : 0;
    const totalImpressions = impressionsAgg._sum.impressions ?? 0;
    const totalTrafficScore = Math.round(impressionsAgg._sum.trafficScore ?? 0);

    // 平均获赞 = AVG(X like_count) combined with AVG(Reddit score). Both are read
    // out of the analytics blob via the same platform-aware extractor.
    const likesPerReply = likeSample
      .map((r) => this._extractLikes(r.post?.analytics, r.opportunity.platform))
      .filter((v) => v > 0);

    const avgLikes =
      likesPerReply.length > 0
        ? Math.round(
            likesPerReply.reduce((s, v) => s + v, 0) / likesPerReply.length
          )
        : 0;

    return { repliesCount: total, responseRate, totalImpressions, totalTrafficScore, avgLikes };
  }

  // Pull the "likes" metric out of a Post.analytics JSON blob. X stores it under
  // a like/favorite label; Reddit's equivalent is the post score. The sync writes
  // each metric as { label, data: [{ total, date }], percentageChange }.
  private _extractLikes(analytics: unknown, platform: string): number {
    if (!Array.isArray(analytics)) return 0;
    const wanted = platform === 'reddit' ? /score|upvote/i : /like|favorite|reaction/i;
    const entry = (
      analytics as Array<{ label?: string; data?: Array<{ total?: string | number }> }>
    ).find((a) => a.label && wanted.test(a.label));
    const raw = entry?.data?.[entry.data.length - 1]?.total;
    const n =
      typeof raw === 'string' ? parseInt(raw, 10) : typeof raw === 'number' ? raw : 0;
    return Number.isFinite(n) ? n : 0;
  }

  // Shared engage date window on Post.publishDate. 'all'/empty/undefined → no
  // window; 'day'/'today' → today; 'week' → ISO week; 'month' → calendar month.
  private _engageDateWindow(date?: string): { publishDate?: { gte: Date } } {
    const gte =
      date === 'day' || date === 'today'
        ? dayjs.utc().startOf('day').toDate()
        : date === 'week'
        ? dayjs.utc().startOf('isoWeek').toDate()
        : date === 'month'
        ? dayjs.utc().startOf('month').toDate()
        : null;
    return gte ? { publishDate: { gte } } : {};
  }

  // Dashboard panel ① "Engage Performance": reply count, response rate,
  // impressions, traffic index, total likes/upvotes, per-platform split, and the
  // single best reply — all scoped to the optional platform + date window
  // (default all-time). Pass platform='x'|'reddit' for the UI tab/chip scope.
  async getDashboardSummary(
    organizationId: string,
    opts: { platform?: string; date?: string } = {}
  ) {
    const platform = opts.platform;
    const platformFilter = platform ? { opportunity: { platform } } : {};
    const dateWindow = this._engageDateWindow(opts.date);

    // Reply-count + best-reply metrics: only replies actually SENT (`PUBLISHED`,
    // excludes future-scheduled QUEUE and errored), within the date window.
    const sentPostFilter = {
      is: {
        source: 'engage',
        state: 'PUBLISHED',
        ...dateWindow,
      } as Prisma.PostWhereInput,
    };
    // Window-only filter (any state) for the totals/response-rate scope. With
    // 'all' this is just the engage source, equivalent to the prior behavior.
    const windowedPostFilter = {
      is: { source: 'engage', ...dateWindow } as Prisma.PostWhereInput,
    };

    const [
      total,
      repliedCount,
      sentReplies,
      xSent,
      redditSent,
      totalPostAgg,
      xPostAgg,
      replyRows,
      bestReplyRows,
    ] =
      await Promise.all([
        this._sentReply.model.engageSentReply.count({
          where: { organizationId, post: windowedPostFilter, ...platformFilter },
        }),
        this._sentReply.model.engageSentReply.count({
          where: { organizationId, post: windowedPostFilter, authorReplied: true, ...platformFilter },
        }),
        this._sentReply.model.engageSentReply.count({
          where: { organizationId, post: sentPostFilter, ...platformFilter },
        }),
        this._sentReply.model.engageSentReply.count({
          where: { organizationId, post: sentPostFilter, opportunity: { platform: 'x' } },
        }),
        this._sentReply.model.engageSentReply.count({
          where: { organizationId, post: sentPostFilter, opportunity: { platform: 'reddit' } },
        }),
        // Headline impressions + traffic for the selected UI scope + date window.
        this._post.model.post.aggregate({
          where: {
            organizationId,
            source: 'engage',
            ...dateWindow,
            ...(platform
              ? { engageSentReply: { is: { opportunity: { platform } } } }
              : {}),
          },
          _sum: { impressions: true, trafficScore: true },
        }),
        // X-only cumulative impressions + traffic index across engage X posts in window.
        this._post.model.post.aggregate({
          where: {
            organizationId,
            source: 'engage',
            ...dateWindow,
            engageSentReply: { is: { opportunity: { platform: 'x' } } },
          },
          _sum: { impressions: true, trafficScore: true },
        }),
        // Likes/upvotes for the selected UI scope + window. Analytics is JSON, so use
        // the same platform-aware extractor as sent stats after loading the rows.
        this._sentReply.model.engageSentReply.findMany({
          where: { organizationId, post: windowedPostFilter, ...platformFilter },
          select: {
            opportunity: { select: { platform: true } },
            post: { select: { analytics: true } },
          },
        }),
        // All sent replies, to pick the single best one (most likes/upvotes).
        this._sentReply.model.engageSentReply.findMany({
          where: { organizationId, post: sentPostFilter, ...platformFilter },
          select: {
            opportunity: {
              select: {
                id: true,
                platform: true,
                externalPostUrl: true,
                authorUsername: true,
                authorDisplayName: true,
                authorAvatarUrl: true,
              },
            },
            post: { select: { content: true, releaseURL: true, analytics: true } },
          },
        }),
      ]);

    const responseRate = total > 0 ? Math.round((repliedCount / total) * 100) : 0;

    let bestReply: {
      opportunityId: string;
      platform: string;
      content: string;
      likes: number;
      url: string | null;
      // Account info of the original post's author (the engagement source).
      author: {
        username: string;
        displayName: string | null;
        avatarUrl: string | null;
      };
    } | null = null;
    let bestLikes = 0;
    for (const r of bestReplyRows) {
      const likes = this._extractLikes(r.post?.analytics, r.opportunity.platform);
      if (likes > bestLikes) {
        bestLikes = likes;
        bestReply = {
          opportunityId: r.opportunity.id,
          platform: r.opportunity.platform,
          content: r.post?.content ?? '',
          likes,
          url: r.post?.releaseURL ?? r.opportunity.externalPostUrl ?? null,
          author: {
            username: r.opportunity.authorUsername,
            displayName: r.opportunity.authorDisplayName ?? null,
            avatarUrl: r.opportunity.authorAvatarUrl ?? null,
          },
        };
      }
    }

    return {
      // All-time count of SENT replies (PUBLISHED only).
      repliesCount: sentReplies,
      responseRate,
      xImpressions: xPostAgg._sum.impressions ?? 0,
      xTrafficIndex: Math.round(xPostAgg._sum.trafficScore ?? 0),
      totalImpressions: totalPostAgg._sum.impressions ?? 0,
      totalTrafficScore: Math.round(totalPostAgg._sum.trafficScore ?? 0),
      totalLikes: replyRows.reduce(
        (sum, r) => sum + this._extractLikes(r.post?.analytics, r.opportunity.platform),
        0
      ),
      platformSplit: { x: xSent, reddit: redditSent },
      bestReply,
    };
  }

  // Dashboard panel ② "Your Posts" overlay: Engage reply counts bucketed by the
  // day they were published, over a trailing window. Every day in the window is
  // seeded so the chart has continuous (zero-filled) buckets. Includes today,
  // which the daily EngageDataTicks aggregate does not yet cover.
  async getDashboardRepliesTrend(organizationId: string, days = 30) {
    const rangeStart = dayjs.utc().subtract(days - 1, 'day').startOf('day').toDate();

    const rows = await this._sentReply.model.engageSentReply.findMany({
      where: {
        organizationId,
        post: { is: { source: 'engage', publishDate: { gte: rangeStart } } },
      },
      select: {
        opportunity: { select: { platform: true } },
        post: { select: { publishDate: true } },
      },
    });

    const buckets = new Map<
      string,
      { date: string; count: number; x: number; reddit: number }
    >();
    for (let i = 0; i < days; i++) {
      const d = dayjs.utc().subtract(days - 1 - i, 'day').format('YYYY-MM-DD');
      buckets.set(d, { date: d, count: 0, x: 0, reddit: 0 });
    }
    for (const r of rows) {
      if (!r.post?.publishDate) continue;
      const d = dayjs.utc(r.post.publishDate).format('YYYY-MM-DD');
      const b = buckets.get(d);
      if (!b) continue;
      b.count++;
      if (r.opportunity.platform === 'reddit') b.reddit++;
      else b.x++;
    }

    return { days, items: [...buckets.values()] };
  }

  // Dashboard panel ③ "Traffic from Engage": total traffic index (clicks) plus a
  // per-reply breakdown sorted by traffic, for the progress-bar list. Defaults to
  // all engage platforms; pass platform='x' for the X-only "X 流量指数汇总".
  async getDashboardTraffics(
    organizationId: string,
    opts: { platform?: string; limit?: number } = {}
  ) {
    const limit = opts.limit ?? 10;
    const platform = opts.platform;

    const [agg, items] = await Promise.all([
      this._post.model.post.aggregate({
        where: {
          organizationId,
          source: 'engage',
          ...(platform
            ? { engageSentReply: { is: { opportunity: { platform } } } }
            : {}),
        },
        _sum: { trafficScore: true },
      }),
      this._sentReply.model.engageSentReply.findMany({
        where: {
          organizationId,
          ...(platform ? { opportunity: { platform } } : {}),
          post: { is: { source: 'engage', trafficScore: { not: null } } },
        },
        select: {
          opportunity: { select: { id: true, platform: true, externalPostUrl: true } },
          post: {
            select: {
              content: true,
              releaseURL: true,
              publishDate: true,
              trafficScore: true,
            },
          },
        },
        orderBy: { post: { trafficScore: 'desc' } },
        take: limit,
      }),
    ]);

    return {
      totalClicks: Math.round(agg._sum.trafficScore ?? 0),
      items: items.map((r) => ({
        opportunityId: r.opportunity.id,
        platform: r.opportunity.platform,
        content: r.post?.content ?? '',
        clicks: Math.round(r.post?.trafficScore ?? 0),
        time: r.post?.publishDate ?? null,
        url: r.post?.releaseURL ?? r.opportunity.externalPostUrl ?? null,
      })),
    };
  }

  // Panel ④ "Engage Impressions Trend" — impressions by publish date and
  // platform for engage posts. Period bucketing matches /dashboard/impressions
  // so the frontend can reuse the same chart component.
  async getDashboardImpressions(
    organizationId: string,
    period: 'daily' | 'weekly' | 'monthly' = 'daily'
  ) {
    const sinceDays = period === 'monthly' ? 365 : period === 'weekly' ? 90 : 30;
    const rangeStart = dayjs.utc().subtract(sinceDays, 'day').startOf('day').toDate();

    const rows = await this._post.model.post.findMany({
      where: {
        organizationId,
        source: 'engage',
        publishDate: { gte: rangeStart },
      },
      select: {
        impressions: true,
        publishDate: true,
        engageSentReply: {
          select: { opportunity: { select: { platform: true } } },
        },
      },
    });

    const buckets = new Map<
      string,
      { date: string; platform: string; value: number }
    >();

    for (const row of rows) {
      if (!row.publishDate) continue;
      const d = dayjs.utc(row.publishDate);
      let dateKey: string;
      switch (period) {
        case 'weekly':
          dateKey = d.isoWeekday(1).format('YYYY-MM-DD');
          break;
        case 'monthly':
          dateKey = d.format('YYYY-MM');
          break;
        default:
          dateKey = d.format('YYYY-MM-DD');
      }

      const platform = row.engageSentReply?.opportunity?.platform ?? 'unknown';
      const key = `${dateKey}|${platform}`;
      const existing = buckets.get(key);
      if (existing) {
        existing.value += row.impressions ?? 0;
      } else {
        buckets.set(key, { date: dateKey, platform, value: row.impressions ?? 0 });
      }
    }

    const result = Array.from(buckets.values());
    result.sort((a, b) => a.date.localeCompare(b.date) || a.platform.localeCompare(b.platform));
    return result;
  }

  // Panel ⑤ "Top engage sources" — engage replies aggregated by the ORIGINAL
  // post author (the traffic source), ranked by traffic index ("clicks").
  // NOTE: "visitors" from the mockup is not tracked anywhere, so it is omitted.
  async getDashboardTopSources(
    organizationId: string,
    opts: { platform?: string; limit?: number } = {}
  ) {
    const limit = opts.limit ?? 10;
    const platform = opts.platform;

    const rows = await this._sentReply.model.engageSentReply.findMany({
      where: {
        organizationId,
        ...(platform ? { opportunity: { platform } } : {}),
        post: { is: { source: 'engage', trafficScore: { not: null } } },
      },
      select: {
        opportunity: {
          select: { platform: true, authorUsername: true, authorAvatarUrl: true },
        },
        post: { select: { trafficScore: true } },
      },
    });

    const byAuthor = new Map<
      string,
      { author: string; avatar: string | null; platform: string; clicks: number; replies: number }
    >();
    for (const r of rows) {
      const p = r.opportunity?.platform ?? 'unknown';
      const author = r.opportunity?.authorUsername ?? 'unknown';
      const key = `${p}|${author}`;
      const clicks = Math.round(r.post?.trafficScore ?? 0);
      const existing = byAuthor.get(key);
      if (existing) {
        existing.clicks += clicks;
        existing.replies += 1;
      } else {
        byAuthor.set(key, {
          author,
          avatar: r.opportunity?.authorAvatarUrl ?? null,
          platform: p,
          clicks,
          replies: 1,
        });
      }
    }

    const all = [...byAuthor.values()].sort((a, b) => b.clicks - a.clicks);
    const totalClicks = all.reduce((s, i) => s + i.clicks, 0);
    return { totalClicks, items: all.slice(0, limit) };
  }

  async updateScheduledReply(
    organizationId: string,
    id: string,
    data: { content?: string; inputData?: object }
  ) {
    const reply = await this._sentReply.model.engageSentReply.findFirst({
      where: { id, organizationId },
      include: { post: { select: { id: true, state: true } } },
    });
    if (!reply) throw new NotFoundException('Sent reply not found');
    if (reply.post.state !== 'QUEUE') {
      throw new BadRequestException('Reply has already been sent — cannot edit');
    }

    const ops: Promise<unknown>[] = [];

    if (data.content !== undefined) {
      ops.push(
        this._post.model.post.update({
          where: { id: reply.postId },
          data: { content: data.content },
        })
      );
    }

    if (data.inputData !== undefined) {
      ops.push(
        this._sentReply.model.engageSentReply.update({
          where: { id },
          data: { inputData: data.inputData },
        })
      );
    }

    await Promise.all(ops);
    return this._sentReply.model.engageSentReply.findFirst({
      where: { id },
      include: {
        post: { select: { id: true, content: true, state: true, publishDate: true } },
      },
    });
  }

  async getSentReplyByOpportunity(organizationId: string, opportunityId: string) {
    return this._sentReply.model.engageSentReply.findUnique({
      where: { organizationId_opportunityId: { organizationId, opportunityId } },
      include: { post: { select: { id: true, state: true } } },
    });
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

  async findPendingEngageMetrics(orgId?: string, platform?: string) {
    return this._sentReply.model.engageSentReply.findMany({
      where: {
        ...(orgId ? { organizationId: orgId } : {}),
        post: {
          source: 'engage',
          state: 'PUBLISHED',
          releaseURL: { not: null },
          impressions: null,
        },
        ...(platform
          ? { opportunity: { platform } }
          : {}),
      },
      select: {
        id: true,
        organizationId: true,
        authorReplied: true,
        post: { select: { id: true, releaseURL: true, integrationId: true } },
        opportunity: { select: { platform: true, externalPostId: true, authorUsername: true } },
      },
    });
  }

  async updatePostMetrics(
    postId: string,
    impressions: number,
    analytics: unknown,
    trafficScore?: number
  ) {
    return this._post.model.post.update({
      where: { id: postId },
      data: {
        impressions,
        analytics: analytics as never,
        ...(trafficScore !== undefined && { trafficScore }),
      },
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
    replyUrl?: string;
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
        ...(data.replyUrl ? { releaseURL: data.replyUrl } : {}),
        // integrationId intentionally omitted: Reddit manual posts have no integration
      },
    });
  }

  async createManualXPost(data: {
    organizationId: string;
    content: string;
    date: Date;
    replyUrl: string;
    integrationId?: string;
  }) {
    // The integration is optional. When provided, its OAuth token lets
    // checkPostAnalytics read the reply tweet's impressions/bookmarks. When
    // omitted (user replied manually without connecting an X account), the post
    // is still recorded but the per-account metrics sync is skipped — only the
    // app-only bearer can later read public metrics (likes/replies/retweets/
    // quotes), and the author-replied check still runs.
    if (data.integrationId) {
      // Validate the integration belongs to this org and is an X social account.
      const integration = await this._integration.model.integration.findFirst({
        where: {
          id: data.integrationId,
          organizationId: data.organizationId,
          providerIdentifier: 'x',
          deletedAt: null,
        },
        select: { id: true },
      });
      if (!integration) {
        throw new NotFoundException('X integration not found for this organization');
      }
    }

    // Parse the snowflake tweet id from the pasted reply URL into releaseId.
    // checkPostAnalytics early-returns when releaseId is null, so without this
    // the metrics sync can never fetch impressions/likes/retweets/etc.
    const releaseId = data.replyUrl.match(/\/status\/(\d+)/)?.[1];

    const { randomUUID } = await import('crypto');
    return this._post.model.post.create({
      data: {
        organizationId: data.organizationId,
        content: data.content,
        publishDate: data.date,
        state: 'PUBLISHED',
        source: 'engage',
        image: '[]',
        settings: JSON.stringify({ __type: 'x' }),
        group: randomUUID(),
        delay: 0,
        releaseURL: data.replyUrl,
        ...(releaseId ? { releaseId } : {}),
        // Scalar FK (not a `connect` relation) to stay in Prisma's unchecked
        // create form alongside organizationId; ownership is validated above.
        // Omitted when no integration is supplied (column is nullable).
        ...(data.integrationId ? { integrationId: data.integrationId } : {}),
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
