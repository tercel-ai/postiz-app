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
} from '@gitroom/nestjs-libraries/engage/dtos/engage.dto';
import { KEYWORD_GLOBAL_SCAN_KEY } from '@gitroom/nestjs-libraries/engage/scan/platform-scan-adapter';
import {
  pickXReplyIntegration,
  XReplyResolution,
} from '@gitroom/nestjs-libraries/engage/resolve-x-reply-integration';
import { classifyReplyMetric, normalizeReplyMetrics } from '@gitroom/nestjs-libraries/engage/engage-metrics-stats';
import { parseXTweetId } from '@gitroom/nestjs-libraries/engage/x-tweet';
import { EngageAuthorProfile } from '@gitroom/nestjs-libraries/engage/engage-author';
import dayjs from 'dayjs';
import isoWeek from 'dayjs/plugin/isoWeek';
import utc from 'dayjs/plugin/utc';

dayjs.extend(isoWeek);
dayjs.extend(utc);

// Scan cadence per type (ms), mirroring the orchestrator's interval env vars.
// getOrgScanStatus derives "next scan" = lastScanStartedAt + cadence (or
// cooldownUntil, whichever is later). The activity/workflows own the actual
// scheduling; this only reports the derived timing to the UI.
const KEYWORD_CADENCE_MS =
  Number(process.env.ENGAGE_KEYWORD_SCAN_INTERVAL_HOURS ?? 24) * 3_600_000;
const CHANNEL_CADENCE_MS =
  Number(process.env.ENGAGE_CHANNEL_SCAN_INTERVAL_HOURS ?? 3) * 3_600_000;
const TRACKED_CADENCE_MS =
  Number(process.env.ENGAGE_TRACKED_SCAN_INTERVAL_HOURS ?? 3) * 3_600_000;
const INITIAL_SCAN_PLATFORMS = ['reddit', 'x'] as const;

export interface ScanTiming {
  lastScanAt: Date | null; // most recent successful completion
  nextScanAt: Date | null; // earliest upcoming scan (derived, not stored)
}

export interface OrgScanStatus {
  lastScanAt: Date | null;
  nextScanAt: Date | null;
  keyword: ScanTiming; // org-independent global firehose (X + Reddit)
  channel: ScanTiming; // this org's monitored subreddits
  tracked: ScanTiming; // this org's tracked accounts
}

type ScanCursorTiming = {
  lastScanStartedAt: Date | null;
  lastScannedAt: Date | null;
  cooldownUntil: Date | null;
};

// next = max(lastScanStartedAt + cadence, cooldownUntil). Anchored to scan
// START (not duration) so scan length never affects the next-due time; a unit
// never scanned is due now. cooldownUntil pushes it out under rate-limit.
function deriveNext(row: ScanCursorTiming, cadenceMs: number, now: number): number {
  const base = row.lastScanStartedAt
    ? row.lastScanStartedAt.getTime() + cadenceMs
    : now;
  const cd = row.cooldownUntil ? row.cooldownUntil.getTime() : 0;
  return Math.max(base, cd);
}

function aggregateScan(
  rows: ScanCursorTiming[],
  cadenceMs: number,
  now: number
): ScanTiming {
  if (!rows.length) return { lastScanAt: null, nextScanAt: null };
  const lasts = rows
    .map((r) => r.lastScannedAt?.getTime())
    .filter((n): n is number => n != null);
  const nexts = rows.map((r) => deriveNext(r, cadenceMs, now));
  return {
    lastScanAt: lasts.length ? new Date(Math.max(...lasts)) : null,
    nextScanAt: nexts.length ? new Date(Math.min(...nexts)) : null,
  };
}

function maxDate(ds: (Date | null)[]): Date | null {
  const ts = ds.filter((d): d is Date => d != null).map((d) => d.getTime());
  return ts.length ? new Date(Math.max(...ts)) : null;
}

function minDate(ds: (Date | null)[]): Date | null {
  const ts = ds.filter((d): d is Date => d != null).map((d) => d.getTime());
  return ts.length ? new Date(Math.min(...ts)) : null;
}

/**
 * Pull the reply author (engageAuthor) out of a Post.settings JSON blob. Returns
 * null when settings is absent/unparseable or carries no engageAuthor.
 */
function parseEngageAuthor(settings: string | null): EngageAuthorProfile | null {
  if (!settings) return null;
  try {
    const parsed = JSON.parse(settings) as { engageAuthor?: EngageAuthorProfile };
    return parsed?.engageAuthor ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve a single, unified `replyAuthor` (who posted the reply) so the frontend
 * reads one field regardless of source. integrationId is the source of truth: when
 * a connected account authored the reply, build the author from it; otherwise fall
 * back to settings.engageAuthor (manual reply from a non-connected account).
 */
function resolveReplyAuthor(
  integration:
    | { profile: string | null; internalId: string | null; name: string | null; picture: string | null }
    | null
    | undefined,
  settings: string | null
): EngageAuthorProfile | null {
  if (integration) {
    return {
      handle: (integration.profile ?? '').replace(/^@/, ''),
      ...(integration.internalId ? { id: integration.internalId } : {}),
      ...(integration.name ? { name: integration.name } : {}),
      ...(integration.picture ? { avatarUrl: integration.picture } : {}),
    };
  }
  return parseEngageAuthor(settings);
}

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
    private _tx: PrismaTransaction,
    private _scanCursor: PrismaRepository<'engageScanCursor'>,
    private _keywordInitialScan: PrismaRepository<'engageKeywordInitialScan'>
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
        keywords: {
          orderBy: { createdAt: 'asc' },
          include: { initialScans: { orderBy: { platform: 'asc' } } },
        },
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

  // Per-org scan timing, derived from the shared EngageScanCursor rows. The
  // keyword firehose is org-independent (one cursor per platform), while
  // channel/tracked timing comes from the cursors for THIS org's monitored
  // subreddits / tracked usernames. "Next scan" is derived (lastScanStartedAt +
  // env cadence, or cooldownUntil) — never stored — so changing the cadence env
  // is reflected immediately. A scoped type the org hasn't configured reports
  // null/null. NOTE: a keyword/subreddit shared with a more aggressive org is
  // scanned on that org's cadence, so the reported time can be fresher than this
  // org's own interval — intentional (shared data, always fresher is fine).
  async getOrgScanStatus(organizationId: string): Promise<OrgScanStatus> {
    const now = Date.now();

    const [subs, tracked] = await Promise.all([
      this._channel.model.engageMonitoredChannel.findMany({
        where: { organizationId, platform: 'reddit', enabled: true },
        select: { channelId: true },
      }),
      this._trackedAccount.model.engageTrackedAccount.findMany({
        where: { organizationId, enabled: true },
        select: { username: true },
      }),
    ]);
    const subredditIds = subs.map((s) => s.channelId);
    const usernames = tracked.map((t) => t.username.toLowerCase());

    const [keywordCursors, channelCursors, trackedCursors] = await Promise.all([
      this._scanCursor.model.engageScanCursor.findMany({
        where: { scanType: 'keyword', scanKey: KEYWORD_GLOBAL_SCAN_KEY },
      }),
      subredditIds.length
        ? this._scanCursor.model.engageScanCursor.findMany({
            where: {
              platform: 'reddit',
              scanType: 'channel',
              scanKey: { in: subredditIds },
            },
          })
        : Promise.resolve([]),
      usernames.length
        ? this._scanCursor.model.engageScanCursor.findMany({
            where: {
              platform: 'x',
              scanType: 'tracked',
              scanKey: { in: usernames },
            },
          })
        : Promise.resolve([]),
    ]);

    const keyword = aggregateScan(keywordCursors, KEYWORD_CADENCE_MS, now);
    const channel = aggregateScan(channelCursors, CHANNEL_CADENCE_MS, now);
    const trackedAgg = aggregateScan(trackedCursors, TRACKED_CADENCE_MS, now);

    return {
      lastScanAt: maxDate([keyword.lastScanAt, channel.lastScanAt, trackedAgg.lastScanAt]),
      nextScanAt: minDate([keyword.nextScanAt, channel.nextScanAt, trackedAgg.nextScanAt]),
      keyword,
      channel,
      tracked: trackedAgg,
    };
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
          ...((dto.enabled ?? true) && {
            initialScans: {
              create: INITIAL_SCAN_PLATFORMS.map((platform) => ({
                organizationId,
                platform,
                keyword: dto.keyword,
                status: 'PENDING',
              })),
            },
          }),
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
    const result = await this._keyword.model.engageKeyword.createMany({
      data,
      skipDuplicates: true,
    });
    await this._ensureInitialScansForEnabledKeywords(configId, organizationId);
    return result;
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
    const shouldResetInitialScan =
      dto.enabled === true && kw.enabled === false;
    const updated = await this._keyword.model.engageKeyword.update({
      where: { id },
      data: {
        ...(dto.type !== undefined && { type: dto.type }),
        ...(dto.enabled !== undefined && { enabled: dto.enabled }),
      },
    });
    if (shouldResetInitialScan) {
      await this._resetInitialScansForKeyword(
        updated.id,
        organizationId,
        updated.keyword
      );
    }
    return updated;
  }

  private async _ensureInitialScansForEnabledKeywords(
    configId: string,
    organizationId: string
  ): Promise<void> {
    const keywords = await this._keyword.model.engageKeyword.findMany({
      where: { configId, organizationId, enabled: true },
      select: { id: true, keyword: true },
    });
    if (!keywords.length) return;
    await this._keywordInitialScan.model.engageKeywordInitialScan.createMany({
      data: keywords.flatMap((kw) =>
        INITIAL_SCAN_PLATFORMS.map((platform) => ({
          organizationId,
          keywordId: kw.id,
          keyword: kw.keyword,
          platform,
          status: 'PENDING',
        }))
      ),
      skipDuplicates: true,
    });
  }

  private async _resetInitialScansForKeyword(
    keywordId: string,
    organizationId: string,
    keyword: string
  ): Promise<void> {
    for (const platform of INITIAL_SCAN_PLATFORMS) {
      await this._keywordInitialScan.model.engageKeywordInitialScan.upsert({
        where: { keywordId_platform: { keywordId, platform } },
        create: {
          organizationId,
          keywordId,
          keyword,
          platform,
          status: 'PENDING',
        },
        update: {
          keyword,
          status: 'PENDING',
          startedAt: null,
          completedAt: null,
          error: null,
          attempts: 0,
        },
      });
    }
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
      matchedKeywords: string[];
      createdAt: Date;
      opportunity: EngageOpportunity;
    }
  >(state: T) {
    const {
      opportunity,
      status,
      bookmarked,
      score,
      scoreKeyword,
      scoreTracked,
      matchedKeywords,
      createdAt,
    } = state;
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
      // Per-org createdAt (when this org first saw the opportunity) — this is
      // also the column `sortBy=createdAt` orders on, so display and sort match.
      createdAt,
      updatedAt: opportunity.updatedAt,
      deletedAt: opportunity.deletedAt,
      // ── Per-org fields (EngageOpportunityState) ───────────────────────────
      status,
      bookmarked,
      score,
      scoreKeyword,
      scoreTracked,
      matchedKeywords,
    };
  }

  async listOpportunities(organizationId: string, dto: ListOpportunitiesDto) {
    const page = dto.page ?? 1;
    const limit = dto.limit ?? 20;
    const offset = (page - 1) * limit;

    const channelSpecific = dto.channels?.length ? dto.channels : undefined;
    const authorSpecificList = dto.authors?.length ? dto.authors : undefined;

    // State-table filters (per-org) + nested opportunity filters (global).
    const where: Prisma.EngageOpportunityStateWhereInput = {
      organizationId,
      ...(dto.status?.length && { status: { in: dto.status } }),
      ...(dto.bookmarked !== undefined && { bookmarked: dto.bookmarked }),
      ...(dto.minScore !== undefined && { score: { gte: dto.minScore } }),
      ...(dto.minScoreKeyword !== undefined && {
        scoreKeyword: { gte: dto.minScoreKeyword },
      }),
      // Keyword filter — exact match against this org's matchedKeywords. `keyword`
      // (single) and `keywords` (multi) union into one OR set (hasSome), so either
      // or both params work and a match on any listed keyword keeps the row.
      ...((() => {
        const set = [
          ...(dto.keyword ? [dto.keyword] : []),
          ...(dto.keywords ?? []),
        ];
        return set.length ? { matchedKeywords: { hasSome: set } } : {};
      })()),
      opportunity: {
        deletedAt: null,
        ...(dto.platform?.length && { platform: { in: dto.platform } }),
        ...(channelSpecific && { channelId: { in: channelSpecific } }),
        ...(authorSpecificList?.length && {
          OR: authorSpecificList.map((a) => ({
            authorUsername: { equals: a, mode: 'insensitive' as const },
          })),
        }),
        ...(dto.intent?.length && { intentTags: { hasSome: dto.intent } }),
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

    // Attach the manual-reply link status so the feed can show "replied, link
    // pending" and offer a backfill. One bounded query for the page's
    // opportunities; the latest reply per opportunity wins (per-post tracking
    // means an opportunity may have several replies). `replyLink` is the stored
    // Post.releaseURL (null = not yet submitted); `sentReplyId` is what the
    // backfill endpoint (PATCH /sent/:id/reply-url) needs.
    const oppIds = rows.map((r) => r.opportunity.id);
    const replies = oppIds.length
      ? (await this._sentReply.model.engageSentReply.findMany({
          where: { organizationId, opportunityId: { in: oppIds } },
          orderBy: { createdAt: 'desc' },
          select: { id: true, opportunityId: true, post: { select: { releaseURL: true } } },
        })) ?? []
      : [];
    const latestByOpp = new Map<string, { id: string; replyLink: string | null }>();
    for (const rep of replies) {
      if (!latestByOpp.has(rep.opportunityId)) {
        latestByOpp.set(rep.opportunityId, { id: rep.id, replyLink: rep.post?.releaseURL ?? null });
      }
    }

    const items = rows.map((r) => {
      const merged = this._merge(r);
      const rep = latestByOpp.get(merged.id);
      return {
        ...merged,
        sentReplyId: rep?.id ?? null,
        replyLink: rep?.replyLink ?? null,
      };
    });

    return { items, total, page, limit };
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
      // An opportunity may now carry several replies (batch send); surface the
      // most recent for the detail panel.
      const sentReply = await this._sentReply.model.engageSentReply.findFirst({
        where: { organizationId, opportunityId: id },
        orderBy: { createdAt: 'desc' },
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
    // Tracking is keyed per-post (postId is @unique), so a batch that sends N
    // replies to one opportunity records N rows. There is no per-opportunity
    // unique to collide on, so this is a plain create.
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
              // settings carries engageAuthor for manual replies posted from an
              // account that isn't a connected integration (integrationId=null).
              settings: true,
              integration: {
                select: {
                  id: true,
                  name: true,
                  providerIdentifier: true,
                  picture: true,
                  // profile (@handle) + internalId (numeric X id) let us build a
                  // unified replyAuthor from the integration when it authored the reply.
                  profile: true,
                  internalId: true,
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
              authorFollowers: true,
              authorAvatarUrl: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit,
      }),
      this._sentReply.model.engageSentReply.count({ where }),
    ]);

    // Attach the keywords this org matched on the opportunity (shown on the sent
    // card so the user remembers why they replied). matchedKeywords is per-org,
    // living on EngageOpportunityState — joined here by (organizationId,
    // opportunityId) rather than via the opportunity, since the SentReply links
    // to the shared opportunity, not the org's state row. One bounded query.
    const oppIds = items.map((it) => it.opportunity.id);
    const states = oppIds.length
      ? (await this._oppState.model.engageOpportunityState.findMany({
          where: { organizationId, opportunityId: { in: oppIds } },
          select: { opportunityId: true, matchedKeywords: true },
        })) ?? []
      : [];
    const keywordsByOpp = new Map(
      states.map((s) => [s.opportunityId, s.matchedKeywords])
    );

    // Attach a flat, frontend-friendly `metrics` object (every per-platform field
    // present) derived from the verbose Post.analytics array, so the UI can read
    // e.g. metrics.bookmarks directly. Post.analytics is kept for compatibility.
    const itemsWithMetrics = items.map((it) => {
      const opportunity = {
        ...it.opportunity,
        matchedKeywords: keywordsByOpp.get(it.opportunity.id) ?? [],
      };
      if (!it.post) return { ...it, opportunity };
      // Surface the reply author (the account that posted the reply) as a clean
      // `replyAuthor` field, and drop the raw `settings` blob from the response.
      const { settings, ...postRest } = it.post;
      return {
        ...it,
        opportunity,
        post: {
          ...postRest,
          replyAuthor: resolveReplyAuthor(it.post.integration, settings),
          metrics: normalizeReplyMetrics(
            it.opportunity.platform,
            it.post.analytics,
            it.post.impressions,
            it.post.trafficScore
          ),
        },
      };
    });

    return { items: itemsWithMetrics, total, page, limit };
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

  // Dashboard panel ② "Your Posts" overlay: Engage reply counts bucketed by
  // period (daily/weekly/monthly).
  async getDashboardRepliesTrend(
    organizationId: string,
    period: 'daily' | 'weekly' | 'monthly' = 'daily'
  ) {
    let rangeStart: Date;
    if (period === 'monthly') {
      rangeStart = dayjs.utc().subtract(11, 'month').startOf('month').toDate();
    } else if (period === 'weekly') {
      rangeStart = dayjs.utc().subtract(11, 'week').isoWeekday(1).startOf('day').toDate();
    } else {
      rangeStart = dayjs.utc().subtract(29, 'day').startOf('day').toDate();
    }

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

    // Pre-seed continuous buckets so chart has zero-filled slots.
    if (period === 'monthly') {
      for (let i = 11; i >= 0; i--) {
        const d = dayjs.utc().subtract(i, 'month').format('YYYY-MM');
        buckets.set(d, { date: d, count: 0, x: 0, reddit: 0 });
      }
    } else if (period === 'weekly') {
      for (let i = 11; i >= 0; i--) {
        const d = dayjs.utc().subtract(i, 'week').isoWeekday(1).format('YYYY-MM-DD');
        buckets.set(d, { date: d, count: 0, x: 0, reddit: 0 });
      }
    } else {
      for (let i = 29; i >= 0; i--) {
        const d = dayjs.utc().subtract(i, 'day').format('YYYY-MM-DD');
        buckets.set(d, { date: d, count: 0, x: 0, reddit: 0 });
      }
    }

    for (const r of rows) {
      if (!r.post?.publishDate) continue;
      const d = dayjs.utc(r.post.publishDate);
      let dateKey: string;
      switch (period) {
        case 'monthly':
          dateKey = d.format('YYYY-MM');
          break;
        case 'weekly':
          dateKey = d.isoWeekday(1).format('YYYY-MM-DD');
          break;
        default:
          dateKey = d.format('YYYY-MM-DD');
      }
      const b = buckets.get(dateKey);
      if (!b) continue;
      b.count++;
      if (r.opportunity.platform === 'reddit') b.reddit++;
      else b.x++;
    }

    return { period: period ?? 'daily', items: [...buckets.values()] };
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

  // Panel ⑤ "Top engage sources" — top engage replies ranked by the engagement
  // metric that matters per platform: X by likes, Reddit by upvotes (descending).
  // Returns a per-reply list shaped like /sent (opportunity author + post.metrics)
  // rather than an author rollup, so the panel can show each top-performing reply.
  // likes/upvotes live inside Post.analytics (extracted by normalizeReplyMetrics),
  // not as a sortable column, so we fetch the candidate set and rank in memory.
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
        id: true,
        opportunity: {
          select: {
            id: true,
            platform: true,
            externalPostUrl: true,
            postContent: true,
            authorUsername: true,
            authorDisplayName: true,
            authorFollowers: true,
            authorAvatarUrl: true,
          },
        },
        post: {
          select: {
            id: true,
            content: true,
            releaseURL: true,
            publishDate: true,
            impressions: true,
            trafficScore: true,
            analytics: true,
            // settings carries engageAuthor for manual replies posted from an
            // account that isn't a connected integration (integrationId=null).
            settings: true,
            integration: {
              select: {
                id: true,
                name: true,
                providerIdentifier: true,
                picture: true,
                profile: true,
                internalId: true,
              },
            },
          },
        },
      },
    });

    // Rank key per platform: Reddit → upvotes, everything else (X) → likes. When
    // no platform filter is set, each item picks its own key so a mixed list still
    // sorts sensibly (Reddit rows by upvotes, X rows by likes).
    const rankValue = (p: string, metrics: { likes?: number; upvotes?: number }) =>
      p === 'reddit' ? metrics.upvotes ?? 0 : metrics.likes ?? 0;

    const items = rows.map((r) => {
      const p = r.opportunity?.platform ?? 'unknown';
      const metrics = normalizeReplyMetrics(
        p,
        r.post?.analytics,
        r.post?.impressions,
        r.post?.trafficScore
      );
      return {
        id: r.id,
        opportunity: r.opportunity,
        post: {
          id: r.post?.id ?? null,
          content: r.post?.content ?? '',
          releaseURL: r.post?.releaseURL ?? r.opportunity?.externalPostUrl ?? null,
          publishDate: r.post?.publishDate ?? null,
          // The account that posted the reply (avatar + @handle), mirroring /sent.
          replyAuthor: resolveReplyAuthor(r.post?.integration ?? null, r.post?.settings ?? null),
          metrics,
        },
        metric: rankValue(p, metrics),
      };
    });

    items.sort((a, b) => b.metric - a.metric);
    return { items: items.slice(0, limit) };
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

    // Both writes must commit together: a partial commit would leave the
    // published post content and the stored generation inputData diverged.
    if (data.content !== undefined || data.inputData !== undefined) {
      await this._tx.model.$transaction(async (tx) => {
        if (data.content !== undefined) {
          await tx.post.update({
            where: { id: reply.postId },
            data: { content: data.content },
          });
        }
        if (data.inputData !== undefined) {
          await tx.engageSentReply.update({
            where: { id },
            data: { inputData: data.inputData },
          });
        }
      });
    }

    return this._sentReply.model.engageSentReply.findFirst({
      where: { id },
      include: {
        post: { select: { id: true, content: true, state: true, publishDate: true } },
      },
    });
  }

  async getSentReplyByOpportunity(organizationId: string, opportunityId: string) {
    // Per-post tracking means an opportunity can have multiple replies; return
    // the most recent (used by cancelAndSendNow to find a still-pending reply).
    return this._sentReply.model.engageSentReply.findFirst({
      where: { organizationId, opportunityId },
      orderBy: { createdAt: 'desc' },
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

  async updateReplyUrl(
    organizationId: string,
    sentReplyId: string,
    url: string,
    engageAuthor?: EngageAuthorProfile
  ) {
    // Join the opportunity for its platform: backfill is only meaningful for the
    // manual-reply platforms (X / Reddit), and for X we also derive releaseId
    // from the tweet URL so metrics sync can read it. The caller (service) has
    // already validated the URL matches this platform.
    const reply = await this._sentReply.model.engageSentReply.findFirst({
      where: { id: sentReplyId, organizationId },
      include: { opportunity: { select: { platform: true } } },
    });
    if (!reply) throw new NotFoundException('Sent reply not found');
    const platform = reply.opportunity.platform;
    if (platform !== 'reddit' && platform !== 'x') {
      throw new BadRequestException(
        'Reply-URL backfill is only valid for X or Reddit manual replies'
      );
    }
    const releaseId =
      platform === 'x' ? parseXTweetId(url) ?? undefined : undefined;

    // If this X reply was recorded without a connected account, the freshly
    // supplied URL lets us resolve the author's integration now (handle match)
    // so metrics sync can finally read it. Only fill when currently null —
    // never override an account the user explicitly chose at confirm time.
    let integrationId: string | undefined;
    let mergedSettings: string | undefined;
    if (platform === 'x') {
      const post = await this._post.model.post.findUnique({
        where: { id: reply.postId },
        select: { integrationId: true, settings: true },
      });
      const alreadyLinked = !!post?.integrationId;
      if (!alreadyLinked) {
        integrationId =
          (await this.resolveXReplyIntegrationId(organizationId, url))
            ?.integrationId ?? undefined;
      }
      // engageAuthor is only the FALLBACK identity for replies with no connected
      // account. If the reply already had an integration, or the URL just
      // handle-matched one, integrationId is the source of truth — leave settings
      // (and the existing row) untouched. Only record engageAuthor when the reply
      // ends up with no integration at all.
      const willHaveIntegration = alreadyLinked || !!integrationId;
      if (!willHaveIntegration && engageAuthor) {
        mergedSettings = this._mergeEngageAuthor(post?.settings, 'x', engageAuthor);
      }
    } else if (platform === 'reddit' && engageAuthor) {
      // Reddit replies never have an integration, so engageAuthor is always the
      // recorded author. Merge into existing settings to preserve the __type tag.
      const post = await this._post.model.post.findUnique({
        where: { id: reply.postId },
        select: { settings: true },
      });
      mergedSettings = this._mergeEngageAuthor(post?.settings, 'reddit', engageAuthor);
    }

    return this._post.model.post.update({
      where: { id: reply.postId },
      data: {
        releaseURL: url,
        ...(releaseId ? { releaseId } : {}),
        ...(integrationId ? { integrationId } : {}),
        ...(mergedSettings ? { settings: mergedSettings } : {}),
      },
    });
  }

  /** Merge engageAuthor into a Post.settings JSON string, preserving __type and any
   *  other keys; tolerant of null/unparseable input. */
  private _mergeEngageAuthor(
    settings: string | null | undefined,
    type: 'x' | 'reddit',
    engageAuthor: EngageAuthorProfile
  ): string {
    let parsed: Record<string, unknown> = { __type: type };
    try {
      parsed = { ...parsed, ...(JSON.parse(settings ?? '{}') ?? {}) };
    } catch {
      /* keep the {__type} default on unparseable settings */
    }
    return JSON.stringify({ ...parsed, engageAuthor });
  }

  /** Platform of a sent reply, scoped to the org (for backfill validation). */
  async getSentReplyPlatform(
    organizationId: string,
    sentReplyId: string
  ): Promise<string> {
    const reply = await this._sentReply.model.engageSentReply.findFirst({
      where: { id: sentReplyId, organizationId },
      select: { opportunity: { select: { platform: true } } },
    });
    if (!reply) throw new NotFoundException('Sent reply not found');
    return reply.opportunity.platform;
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

  /**
   * Engage replies whose metrics should be RE-FETCHED on the daily schedule:
   * every PUBLISHED engage reply published within the last `sinceDays` days,
   * REGARDLESS of whether impressions are already set. This is what makes engage
   * metrics keep updating daily (mirroring the calendar DataTicks lookback)
   * instead of freezing after the first non-null fetch (the `findPendingEngageMetrics`
   * path only ever picks `impressions: null` rows, so a synced row never updates).
   * The `impressions > 0` write guard in PostsService keeps a transient empty/0
   * read from clobbering a previously good value.
   */
  async findEngageRepliesInWindow(sinceDays: number, orgId?: string, platform?: string) {
    const cutoff = dayjs.utc().subtract(sinceDays, 'day').startOf('day').toDate();
    return this._sentReply.model.engageSentReply.findMany({
      where: {
        ...(orgId ? { organizationId: orgId } : {}),
        post: {
          source: 'engage',
          state: 'PUBLISHED',
          releaseURL: { not: null },
          publishDate: { gte: cutoff },
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

  /**
   * Fill Post.integrationId for X engage replies that have none, resolving a
   * usable X account per reply (author-handle → engage reply account → any live
   * account; see resolveXReplyIntegrationId). Without an integration,
   * checkPostAnalytics can't read X metrics. Reddit needs no integration and is
   * left untouched. Returns what was (or, in dryRun, would be) filled.
   */
  async backfillXReplyIntegrations(organizationId: string, dryRun: boolean) {
    const pending = await this._sentReply.model.engageSentReply.findMany({
      where: {
        organizationId,
        opportunity: { platform: 'x' },
        post: { source: 'engage', integrationId: null },
      },
      select: { post: { select: { id: true, releaseURL: true } } },
    });

    let filled = 0;
    let unresolved = 0;
    const items: Array<{ postId: string; integrationId: string; matchedBy: string }> = [];

    for (const r of pending) {
      if (!r.post) continue;
      const pick = await this.resolveXReplyIntegrationId(organizationId, r.post.releaseURL);
      if (!pick) {
        unresolved++;
        continue;
      }
      if (!dryRun) {
        await this._post.model.post.update({
          where: { id: r.post.id },
          data: { integrationId: pick.integrationId },
        });
      }
      filled++;
      items.push({ postId: r.post.id, integrationId: pick.integrationId, matchedBy: pick.matchedBy });
    }

    return { found: pending.length, filled, unresolved, items };
  }

  /**
   * Per-platform snapshot of PUBLISHED engage replies: how many carry metrics,
   * how many are still missing — broken down by WHY (no link yet / no
   * integration / no tweet id / syncable-but-empty) — and the impression/traffic
   * totals. Powers the /admin/sync-metrics before/after summary. Engage replies
   * are few, so one findMany + in-memory fold is fine. Classification is shared
   * with the script via classifyReplyMetric.
   */
  async getEngageMetricsStats(organizationId: string, platform?: string) {
    const rows = await this._sentReply.model.engageSentReply.findMany({
      where: {
        organizationId,
        ...(platform ? { opportunity: { platform } } : {}),
        post: { source: 'engage', state: 'PUBLISHED' },
      },
      select: {
        post: {
          select: {
            impressions: true,
            trafficScore: true,
            integrationId: true,
            releaseURL: true,
            releaseId: true,
          },
        },
        opportunity: { select: { platform: true } },
      },
    });

    const stats: Record<
      string,
      {
        published: number;
        withMetrics: number;
        missing: number;
        // Breakdown of `missing` by blocker:
        missingNoReleaseURL: number; // needs PATCH /sent/:id/reply-url
        missingNoIntegration: number; // X — run integration backfill
        missingNoReleaseId: number; // X — URL has no /status/<id>
        missingSyncable: number; // ready, but fetch returned nothing (tier/WAF)
        totalImpressions: number;
        totalTrafficScore: number;
      }
    > = {};

    for (const r of rows) {
      const p = r.opportunity.platform;
      const s = (stats[p] ??= {
        published: 0,
        withMetrics: 0,
        missing: 0,
        missingNoReleaseURL: 0,
        missingNoIntegration: 0,
        missingNoReleaseId: 0,
        missingSyncable: 0,
        totalImpressions: 0,
        totalTrafficScore: 0,
      });
      s.published++;
      const status = classifyReplyMetric({
        platform: p,
        impressions: r.post?.impressions,
        releaseURL: r.post?.releaseURL,
        releaseId: r.post?.releaseId,
        integrationId: r.post?.integrationId,
      });
      if (status === 'has_metrics') {
        s.withMetrics++;
        s.totalImpressions += r.post?.impressions ?? 0;
        s.totalTrafficScore += r.post?.trafficScore ?? 0;
      } else {
        s.missing++;
        if (status === 'no_release_url') s.missingNoReleaseURL++;
        else if (status === 'no_integration') s.missingNoIntegration++;
        else if (status === 'no_release_id') s.missingNoReleaseId++;
        else s.missingSyncable++;
      }
    }
    for (const s of Object.values(stats)) s.totalTrafficScore = Math.round(s.totalTrafficScore);
    return stats;
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
    engageAuthor?: EngageAuthorProfile;
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
        // Reddit manual posts never have an integration, so engageAuthor (the
        // redditor who posted the reply) is the source of truth when known.
        settings: JSON.stringify({
          __type: 'reddit',
          ...(data.engageAuthor ? { engageAuthor: data.engageAuthor } : {}),
        }),
        group: randomUUID(),
        delay: 0,
        ...(data.replyUrl ? { releaseURL: data.replyUrl } : {}),
        // integrationId intentionally omitted: Reddit manual posts have no integration
      },
    });
  }

  /**
   * Pick the connected X integration that AUTHORED a manual engage reply: the live
   * X account whose handle matches the reply URL's author. Returns null when no
   * connected account authored the reply (external account / unparseable handle) —
   * see resolve-x-reply-integration.ts for why we no longer attach a fallback.
   */
  async resolveXReplyIntegrationId(
    organizationId: string,
    replyUrl?: string | null
  ): Promise<XReplyResolution | null> {
    const liveX = await this._integration.model.integration.findMany({
      where: {
        organizationId,
        providerIdentifier: 'x',
        deletedAt: null,
        disabled: false,
      },
      select: {
        id: true,
        profile: true,
        engageXReplyAccount: { select: { engageEnabled: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });

    return pickXReplyIntegration(
      liveX.map((i) => ({
        id: i.id,
        profile: i.profile,
        engageEnabled: i.engageXReplyAccount?.engageEnabled ?? false,
      })),
      replyUrl
    );
  }

  async createManualXPost(data: {
    organizationId: string;
    content: string;
    date: Date;
    replyUrl?: string;
    integrationId?: string;
    engageAuthor?: EngageAuthorProfile;
  }) {
    // The integration is optional. When provided, its OAuth token lets
    // checkPostAnalytics read the reply tweet's impressions/bookmarks. When
    // omitted (user replied manually without connecting an X account), the post
    // is still recorded but the per-account metrics sync is skipped — only the
    // app-only bearer can later read public metrics (likes/replies/retweets/
    // quotes), and the author-replied check still runs.
    let integrationId = data.integrationId;
    if (integrationId) {
      // Validate the integration belongs to this org and is an X social account.
      const integration = await this._integration.model.integration.findFirst({
        where: {
          id: integrationId,
          organizationId: data.organizationId,
          providerIdentifier: 'x',
          deletedAt: null,
        },
        select: { id: true },
      });
      if (!integration) {
        throw new NotFoundException('X integration not found for this organization');
      }
    } else {
      // No account picked: resolve one so metrics aren't stuck null forever.
      // Prefer the tweet author's own integration (by handle) so impressions are
      // readable; else the org's engage reply account; else any live X account.
      integrationId =
        (await this.resolveXReplyIntegrationId(data.organizationId, data.replyUrl))
          ?.integrationId ?? undefined;
    }

    // Parse the snowflake tweet id from the pasted reply URL into releaseId.
    // checkPostAnalytics early-returns when releaseId is null, so without this
    // the metrics sync can never fetch impressions/likes/retweets/etc. When the
    // reply URL is omitted ("I'll add the link later"), both are left null and
    // backfilled later via updateReplyUrl.
    const releaseId = parseXTweetId(data.replyUrl);

    const { randomUUID } = await import('crypto');
    return this._post.model.post.create({
      data: {
        organizationId: data.organizationId,
        content: data.content,
        publishDate: data.date,
        state: 'PUBLISHED',
        source: 'engage',
        image: '[]',
        settings: JSON.stringify({
          __type: 'x',
          // engageAuthor is only a FALLBACK identity for when no connected account
          // authored the reply. When integrationId is set it IS the source of truth
          // for who replied, so we don't duplicate the author into settings.
          ...(!integrationId && data.engageAuthor
            ? { engageAuthor: data.engageAuthor }
            : {}),
        }),
        group: randomUUID(),
        delay: 0,
        ...(data.replyUrl ? { releaseURL: data.replyUrl } : {}),
        ...(releaseId ? { releaseId } : {}),
        // Scalar FK (not a `connect` relation) to stay in Prisma's unchecked
        // create form alongside organizationId; ownership is validated/resolved
        // above. Left null when no connected account authored the reply — the
        // author is captured in settings.engageAuthor instead.
        ...(integrationId ? { integrationId } : {}),
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
        const enabledKeywords = await tx.engageKeyword.findMany({
          where: {
            configId: config.id,
            organizationId,
            enabled: true,
            keyword: { in: dto.keywords.map((kw) => kw.keyword) },
          },
          select: { id: true, keyword: true },
        });
        if (enabledKeywords.length) {
          await tx.engageKeywordInitialScan.createMany({
            data: enabledKeywords.flatMap((kw) =>
              INITIAL_SCAN_PLATFORMS.map((platform) => ({
                organizationId,
                keywordId: kw.id,
                keyword: kw.keyword,
                platform,
                status: 'PENDING',
              }))
            ),
            skipDuplicates: true,
          });
        }
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

  // ─── Admin diagnostics ───────────────────────────────────────────────────

  async findStuckScanCursors(before: Date) {
    return this._scanCursor.model.engageScanCursor.findMany({
      where: {
        status: 'SCANNING',
        lastScanStartedAt: { lt: before },
      },
      select: {
        id: true,
        platform: true,
        scanType: true,
        scanKey: true,
        lastScanStartedAt: true,
        lastScannedAt: true,
      },
      orderBy: { lastScanStartedAt: 'asc' },
    });
  }

  async findFailedKeywordScans(stuckBefore: Date) {
    return this._keywordInitialScan.model.engageKeywordInitialScan.findMany({
      where: {
        OR: [
          { status: 'FAILED' },
          { status: 'RUNNING', startedAt: { lt: stuckBefore } },
        ],
      },
      select: {
        id: true,
        organizationId: true,
        keyword: true,
        platform: true,
        status: true,
        startedAt: true,
        attempts: true,
        error: true,
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async findDeadReplyAccounts() {
    return this._replyAccount.model.engageXReplyAccount.findMany({
      where: {
        engageEnabled: true,
        integration: {
          OR: [{ refreshNeeded: true }, { disabled: true }],
        },
      },
      select: {
        id: true,
        organizationId: true,
        integrationId: true,
        autoReplyEnabled: true,
        integration: {
          select: {
            id: true,
            name: true,
            providerIdentifier: true,
            refreshNeeded: true,
            disabled: true,
          },
        },
      },
      orderBy: { organizationId: 'asc' },
    });
  }

  async findEngageReplyErrors(since: Date) {
    return this._sentReply.model.engageSentReply.findMany({
      where: {
        post: { state: 'ERROR', createdAt: { gte: since } },
      },
      select: {
        id: true,
        organizationId: true,
        opportunityId: true,
        postId: true,
        createdAt: true,
        post: { select: { id: true, state: true, error: true, createdAt: true } },
        opportunity: { select: { externalPostUrl: true, platform: true } },
      },
      orderBy: { createdAt: 'desc' },
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
