import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { EngageSentReply, Organization, State } from '@prisma/client';
import { TemporalService } from 'nestjs-temporal-core';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import {
  EngageRepository,
  GenerationHistoryEntry,
} from '@gitroom/nestjs-libraries/engage/engage.repository';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import { PostOverageService } from '@gitroom/nestjs-libraries/database/prisma/posts/post-overage.service';
import { SettingsService } from '@gitroom/nestjs-libraries/database/prisma/settings/settings.service';
import { OperationPlanRepository } from '@gitroom/nestjs-libraries/database/prisma/operation-plan/operation-plan.repository';
import {
  OPERATION_PLAN_ALLOWED_PLATFORMS_KEY,
  OPERATION_PLAN_MAX_DURATION_DAYS_KEY,
} from '@gitroom/nestjs-libraries/database/prisma/operation-plan/operation-plan.service';

dayjs.extend(utc);

// §6.1: "the sending account hit its own per-account daily cap." No dedicated
// capacity table — the cap VALUE is a Settings config; "sends so far" is a
// live COUNT (EngageRepository.countAccountSentRepliesToday).
export const ENGAGE_REPLY_ACCOUNT_DAILY_CAP_KEY = 'engage_reply_account_daily_cap';
const DEFAULT_REPLY_ACCOUNT_DAILY_CAP = 50;
import {
  EngageEntitlementService,
  ReplyLength,
} from '@gitroom/nestjs-libraries/engage/engage-entitlement.service';
import {
  AddKeywordDto,
  AddKeywordsBulkDto,
  AddMonitoredChannelDto,
  AddTrackedAccountDto,
  ConfirmManualReplyDto,
  ListOpportunitiesDto,
  ListSentDto,
  LocateOpportunityDto,
  LocateSentReplyDto,
  OpportunityCountsDto,
  SaveEngageConfigDto,
  SetupEngageDto,
  BatchScheduleReplyDto,
  BatchSendReplyDto,
  ScheduleReplyDto,
  SaveDraftDto,
  ScoreStatsDto,
  SendReplyDto,
  UpdateKeywordDto,
  UpdateMonitoredChannelDto,
  UpdateReplyAccountDto,
  UpdateTrackedAccountDto,
  UpdateScheduledReplyDto,
} from '@gitroom/nestjs-libraries/engage/dtos/engage.dto';
import { parseXTweetId } from '@gitroom/nestjs-libraries/engage/x-tweet';
import {
  fetchRedditAuthorProfile,
  EngageAuthorProfile,
} from '@gitroom/nestjs-libraries/engage/engage-author';
import { parseRedditCommentId } from '@gitroom/nestjs-libraries/engage/reddit-url';
import { getRedditToken, redditAuthHeaders } from '@gitroom/nestjs-libraries/engage/reddit-auth';
import { redditPublicGet } from '@gitroom/nestjs-libraries/engage/reddit-loid';
import {
  dispatchReplyMetricsSync,
  buildReplyMetricsFromRaw,
  type MetricsSyncDeps,
  type RawReplyMetrics,
} from '@gitroom/nestjs-libraries/engage/engage-metrics-sync';
import { normalizeReplyMetrics } from '@gitroom/nestjs-libraries/engage/engage-metrics-stats';
import { normalizeKeyword } from '@gitroom/nestjs-libraries/engage/engage-scan-lease.service';
import { EngageScanConfigService } from '@gitroom/nestjs-libraries/engage/engage-scan-config.service';
import {
  BIZ_USAGE,
  runWithBizUsage,
} from '@gitroom/nestjs-libraries/database/prisma/api-usage/api-usage.service';

// Validate by DOMAIN only, not by full path shape — Reddit/X change their
// permalink structure over time. The reply URL is only checked for the right
// platform host; target reachability is not verified (see _validateReplyUrl).
function hostIsOneOf(url: string, domains: string[]): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return domains.some((d) => host === d || host.endsWith(`.${d}`));
  } catch {
    return false; // not a parseable absolute URL
  }
}

const isRedditUrl = (url: string) => hostIsOneOf(url, ['reddit.com']);
const isXUrl = (url: string) => hostIsOneOf(url, ['x.com', 'twitter.com']);

// Event-driven metrics refresh (`refreshMetricsForPosts`): hard cap on how many
// client-supplied post ids one request may refresh, bounding external API work
// (X tier-rate risk) even if a caller sends an oversized page.
const REFRESH_METRICS_MAX_POSTS = 100;
// Floor for the returned `nextRefreshAt` AND the in-memory scan-signal debounce:
// the client caches nextRefreshAt and won't re-call before it, so this is the
// minimum spacing between effective triggers regardless of how fast a user
// browses (also stops a 0-interval plan from inviting hammering).
const DEFAULT_REFRESH_FLOOR_SECONDS = 60;

function engageRefreshFloorMs(): number {
  const value = Number(
    process.env.ENGAGE_REFRESH_FLOOR_SECONDS ?? DEFAULT_REFRESH_FLOOR_SECONDS
  );
  return (
    (Number.isFinite(value) && value > 0 ? value : DEFAULT_REFRESH_FLOOR_SECONDS) *
    1000
  );
}

@Injectable()
export class EngageService implements OnApplicationBootstrap {
  private readonly logger = new Logger(EngageService.name);

  constructor(
    private _engageRepository: EngageRepository,
    private _temporalService: TemporalService,
    private _postsService: PostsService,
    private _postOverageService: PostOverageService,
    private _entitlementService: EngageEntitlementService,
    private _scanConfig?: EngageScanConfigService,
    // Optional (like _scanConfig) so existing tests that construct
    // EngageService directly don't all need updating — production wiring via
    // DatabaseModule always provides both. §6.1/§6 pacing checks no-op (never
    // block a send) when either is absent, matching _scanConfig's own
    // never-throws fallback posture elsewhere in this file.
    private _operationPlanRepository?: OperationPlanRepository,
    private _settingsService?: SettingsService
  ) { }

  // Auto-start global workflows on every app boot so pnpm dev / Docker restart
  // never leaves the system in a state where no workflow is running.
  async onApplicationBootstrap() {
    await this._seedDefaultSettings();
    await this._ensureGlobalWorkflowsRunning();
  }

  // Seed engage Settings knobs that otherwise live only as code-level fallbacks
  // and never surface in the admin Settings UI until someone sets them once.
  // Insert-if-absent only — never overwrite an operator's configured value, and
  // never let a settings failure block boot.
  private async _seedDefaultSettings() {
    if (!this._settingsService) return;
    try {
      const existing = await this._settingsService.get<number>(
        ENGAGE_REPLY_ACCOUNT_DAILY_CAP_KEY
      );
      if (existing === null || existing === undefined) {
        await this._settingsService.set(
          ENGAGE_REPLY_ACCOUNT_DAILY_CAP_KEY,
          DEFAULT_REPLY_ACCOUNT_DAILY_CAP,
          {
            type: 'number',
            description:
              'Max engage replies a single connected account may send per UTC day (0 = uncapped). Send-time pacing cap (§6.1).',
            defaultValue: DEFAULT_REPLY_ACCOUNT_DAILY_CAP,
          }
        );
      }
    } catch (err) {
      this.logger.error(
        `Failed to seed default setting ${ENGAGE_REPLY_ACCOUNT_DAILY_CAP_KEY}:`,
        err
      );
    }
  }

  // ─── Config ───────────────────────────────────────────────────────────────

  async getConfig(org: Organization, projectId?: string | null) {
    const entitlement = await this._entitlementService.getEntitlementSummary(org.id);
    const scanIntervalHours = entitlement.limits.scanIntervalHours;
    const cadenceMs = scanIntervalHours * 3_600_000;
    const [config, scanStatus] = await Promise.all([
      // No projectId → the caller has no project context (the browser extension's
      // scan panel). Return the org-wide aggregate (union across every enabled
      // config, deduped) so its selectable scan units match what the server-side
      // scan loop actually enumerates. A concrete projectId → that project's
      // config only. aisee-app always passes projectId, so it is unaffected.
      projectId
        ? this._engageRepository.getOrCreateConfig(org.id, projectId)
        : this._engageRepository.getOrgAggregateConfig(org.id),
      // getOrgScanStatus stays org-scoped (not yet project-aware) — a known,
      // separately-flagged gap, not a regression introduced here.
      this._engageRepository.getOrgScanStatus(org.id, scanIntervalHours),
    ]);

    // Per-keyword per-platform scan times (from EngageScanCursor). Queried after
    // config so we know the keyword list; empty map when no keywords configured.
    const keywordKeys = Array.from(
      new Set(
        config.keywords
          .filter((k) => k.enabled)
          .map((k) => normalizeKeyword(k.keyword))
          .filter(Boolean)
      )
    );
    const kwCursors = await this._engageRepository.getKeywordCursors(
      keywordKeys,
      cadenceMs
    );
    // Decorate each keyword with its per-platform scan cursor times.
    const keywords = config.keywords.map((kw) => {
      const key = normalizeKeyword(kw.keyword);
      return { ...kw, scanCursors: kwCursors[key] ?? [] };
    });

    // Decorate channels / tracked accounts with their REAL EngageScanCursor
    // last/next scan, exactly like keywords. Previously they carried only the
    // per-row bookkeeping field (EngageMonitoredChannel.lastScannedAt /
    // EngageTrackedAccount.lastCheckedAt), which ONLY the workflow writes — so a
    // unit advanced by the extension scan path showed a stale "last scanned"
    // while its shared cursor was fresh. scanCursor is the single source of truth
    // the frontends read; the legacy field is overwritten with it for back-compat.
    const [channelCursors, trackedCursors] = await Promise.all([
      this._engageRepository.getChannelCursors(
        config.monitoredChannels.map((c) => ({
          platform: c.platform,
          channelId: c.channelId,
        })),
        cadenceMs
      ),
      this._engageRepository.getTrackedCursors(
        config.trackedAccounts.map((a) => ({
          platform: a.platform,
          username: a.username,
        })),
        cadenceMs
      ),
    ]);
    const monitoredChannels = config.monitoredChannels.map((ch) => {
      const cur = channelCursors[`${ch.platform}:${ch.channelId}`] ?? null;
      return {
        ...ch,
        lastScannedAt: cur?.lastScannedAt ?? ch.lastScannedAt ?? null,
        scanCursor: cur,
      };
    });
    const trackedAccounts = config.trackedAccounts.map((a) => {
      const cur = trackedCursors[`${a.platform}:${a.username}`] ?? null;
      return {
        ...a,
        lastCheckedAt: cur?.lastScannedAt ?? a.lastCheckedAt ?? null,
        scanCursor: cur,
      };
    });

    // Per-type added/active/max so the frontend renders "active / added / cap"
    // without re-deriving it. `added` = total rows (incl. disabled), straight off
    // the already-loaded config lists (no extra query); `active` reuses the
    // enabled-only counts in entitlement.usage; `max` is the plan cap (null =
    // unlimited, 0 = feature hidden). subreddits mirrors usage.subreddits, which
    // counts ALL monitored channels (no platform filter) — keep them aligned.
    const counts = {
      keywords: {
        added: config.keywords.length,
        active: entitlement.usage.keywords,
        max: entitlement.limits.keywordsMax,
      },
      trackedAccounts: {
        added: config.trackedAccounts.length,
        active: entitlement.usage.trackedAccounts,
        max: entitlement.limits.priorityAccountsMax,
      },
      subreddits: {
        added: config.monitoredChannels.length,
        active: entitlement.usage.subreddits,
        max: entitlement.limits.subredditsMax,
      },
    };
    return {
      ...config,
      keywords,
      monitoredChannels,
      trackedAccounts,
      // Plan limits + current usage + reply pricing, so the frontend can disable
      // entrypoints and show usage. Backend asserts remain the source of truth.
      // `entitlement.counts` adds per-type added/active/max for the UI.
      entitlement: { ...entitlement, counts },
      // Single per-plan scan cadence applied to keyword/channel/tracked alike.
      // Legacy per-type keys kept for frontend compatibility (all equal now).
      scanIntervals: {
        scanIntervalHours,
        keywordHours: scanIntervalHours,
        channelHours: scanIntervalHours,
        trackedHours: scanIntervalHours,
      },
      // Per-org last/next scan timing (derived from EngageScanCursor). Overall +
      // per-type (keyword / channel / tracked). next is derived, never stored.
      scanStatus,
      // Admin-configured operation-plan limits, surfaced here so a plan-creation
      // UI can bound its date range / platform picker from the same call. Only
      // the client-relevant knobs — `operation_plan.platform_cadence` is
      // deliberately NOT exposed: it steers the generator's editorial strategy
      // and no client has a use for it.
      operationPlan: await this._getOperationPlanConfig(),
    };
  }

  /**
   * Global operation-plan knobs a client needs to build a valid create request.
   *
   * `allowedPlatforms` is the raw `operation_plan.allowed_platforms` allowlist,
   * returned verbatim — it is the ONLY platform gate the create endpoint applies
   * (publishing is by-platform via the plugin, so a platform needs no connected
   * integration; see OperationPlanService._validateInput). Returning the
   * allowlist as-is keeps the picker in lockstep with what POST accepts when a
   * list is configured.
   *
   * An empty allowlist means the admin has NOT scoped platforms: the create
   * endpoint is then unrestricted, but a UI cannot render a picker from
   * "anything", so this returns `[]` — configure the allowlist to drive the
   * picker. (Deliberately NOT intersected with connected integrations: an
   * unconnected platform is still plannable, so filtering by connection would
   * hide platforms POST would accept.)
   */
  private async _getOperationPlanConfig(): Promise<{
    maxDurationDays: number;
    allowedPlatforms: string[];
  }> {
    const fallback = { maxDurationDays: 30, allowedPlatforms: [] as string[] };
    if (!this._settingsService) return fallback;
    try {
      const [maxDays, allowedRaw] = await Promise.all([
        this._settingsService.get<number>(OPERATION_PLAN_MAX_DURATION_DAYS_KEY),
        this._settingsService.get(OPERATION_PLAN_ALLOWED_PLATFORMS_KEY),
      ]);
      const allowlist = Array.isArray(allowedRaw)
        ? allowedRaw.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
        : [];
      return {
        maxDurationDays: Number.isFinite(Number(maxDays)) ? Number(maxDays) : fallback.maxDurationDays,
        allowedPlatforms: allowlist,
      };
    } catch (err) {
      // Config is decoration on this endpoint — never fail the whole Engage
      // page because a Settings read hiccuped.
      this.logger.error('Failed to read operation-plan settings for /engage/config:', err);
      return fallback;
    }
  }

  async saveConfig(org: Organization, dto: SaveEngageConfigDto) {
    const result = await this._engageRepository.saveConfig(
      org.id,
      { ...(dto.enabled !== undefined && { enabled: dto.enabled }) },
      dto.projectId
    );
    if (dto.enabled) {
      await this._ensureGlobalWorkflowsRunning();
      this.triggerImmediateScan(org).catch((err) =>
        this.logger.warn(`Immediate scan trigger failed for org ${org.id}:`, err)
      );
    }
    return result;
  }

  async setupEngage(org: Organization, dto: SetupEngageDto) {
    const result = await this._engageRepository.setupEngage(org.id, dto, dto.projectId);
    await this._ensureGlobalWorkflowsRunning();
    this.triggerImmediateScan(org).catch((err) =>
      this.logger.warn(`Immediate scan trigger failed for org ${org.id}:`, err)
    );
    return result;
  }

  async resetConfig(org: Organization, projectId?: string | null) {
    return this._engageRepository.resetConfig(org.id, projectId);
  }

  // ─── Keywords ─────────────────────────────────────────────────────────────

  async addKeyword(org: Organization, dto: AddKeywordDto) {
    await this._entitlementService.assertCanActivate(org.id, 'keyword', 1);
    const config = await this._engageRepository.getOrCreateConfig(org.id, dto.projectId);
    return this._engageRepository.addKeyword(config.id, org.id, dto);
  }

  async addKeywordsBulk(org: Organization, dto: AddKeywordsBulkDto) {
    await this._entitlementService.assertCanActivate(
      org.id,
      'keyword',
      dto.keywords.length
    );
    const config = await this._engageRepository.getOrCreateConfig(org.id, dto.projectId);
    return this._engageRepository.addKeywordsBulk(config.id, org.id, dto);
  }

  async updateKeyword(org: Organization, id: string, dto: UpdateKeywordDto) {
    if (dto.enabled === true) {
      await this._entitlementService.assertCanEnable(org.id, 'keyword', id);
    }
    return this._engageRepository.updateKeyword(org.id, id, dto);
  }

  async deleteKeyword(org: Organization, id: string) {
    return this._engageRepository.deleteKeyword(org.id, id);
  }

  async getKeywordPosts(org: Organization, keywordId: string) {
    return this._engageRepository.getKeywordPosts(org.id, keywordId);
  }

  // ─── Monitored Channels ───────────────────────────────────────────────────

  async listMonitoredChannels(org: Organization, projectId?: string | null) {
    return this._engageRepository.listMonitoredChannels(org.id, projectId);
  }

  async addMonitoredChannel(org: Organization, dto: AddMonitoredChannelDto) {
    await this._entitlementService.assertCanActivate(org.id, 'subreddit', 1);
    const config = await this._engageRepository.getOrCreateConfig(org.id, dto.projectId);
    return this._engageRepository.addMonitoredChannel(
      config.id,
      org.id,
      dto
    );
  }

  async updateMonitoredChannel(
    org: Organization,
    id: string,
    dto: UpdateMonitoredChannelDto
  ) {
    if (dto.enabled === true) {
      await this._entitlementService.assertCanEnable(org.id, 'subreddit', id);
    }
    return this._engageRepository.updateMonitoredChannel(org.id, id, dto);
  }

  async removeMonitoredChannel(org: Organization, id: string) {
    return this._engageRepository.removeMonitoredChannel(org.id, id);
  }

  async searchChannels(org: Organization, platform: string, query: string) {
    if (platform === 'reddit') {
      const userToken = await this._engageRepository.getRedditIntegrationToken(org.id);
      return this._searchRedditSubreddits(query, userToken);
    }
    return [];
  }

  // ─── Tracked Accounts ─────────────────────────────────────────────────────

  async listTrackedAccounts(org: Organization, projectId?: string | null) {
    return this._engageRepository.listTrackedAccounts(org.id, projectId);
  }

  async addTrackedAccount(org: Organization, dto: AddTrackedAccountDto) {
    await this._entitlementService.assertCanActivate(org.id, 'tracked', 1);
    const config = await this._engageRepository.getOrCreateConfig(org.id, dto.projectId);
    return this._engageRepository.addTrackedAccount(config.id, org.id, dto);
  }

  async updateTrackedAccount(
    org: Organization,
    id: string,
    dto: UpdateTrackedAccountDto
  ) {
    if (dto.enabled === true) {
      await this._entitlementService.assertCanEnable(org.id, 'tracked', id);
    }
    return this._engageRepository.updateTrackedAccount(org.id, id, dto);
  }

  async removeTrackedAccount(org: Organization, id: string) {
    return this._engageRepository.removeTrackedAccount(org.id, id);
  }

  // ─── Reply Accounts ───────────────────────────────────────────────────────

  async listReplyAccounts(org: Organization, projectId?: string | null) {
    return this._engageRepository.listXIntegrationsWithReplySettings(org.id, projectId);
  }

  async updateReplyAccountSettings(
    org: Organization,
    integrationId: string,
    dto: UpdateReplyAccountDto
  ) {
    return this._engageRepository.updateReplyAccount(
      org.id,
      integrationId,
      dto,
      dto.projectId
    );
  }

  // ─── Opportunities ────────────────────────────────────────────────────────

  async listOpportunities(org: Organization, dto: ListOpportunitiesDto) {
    return this._engageRepository.listOpportunities(org.id, dto);
  }

  async dismissOpportunity(org: Organization, id: string, projectId?: string | null) {
    return this._engageRepository.dismissOpportunity(org.id, id, projectId);
  }

  async toggleBookmark(org: Organization, id: string, projectId?: string | null) {
    return this._engageRepository.toggleBookmark(org.id, id, projectId);
  }

  async getScoreStats(org: Organization, dto: ScoreStatsDto) {
    return this._engageRepository.getScoreStats(org.id, dto.date, dto.platform, dto.projectId);
  }

  async getOpportunityCounts(org: Organization, dto: OpportunityCountsDto) {
    return this._engageRepository.getOpportunityCounts(org.id, dto);
  }

  async getOpportunityById(org: Organization, id: string, projectId?: string | null) {
    return this._engageRepository.getOpportunityById(org.id, id, projectId);
  }

  async getOpportunityDetail(org: Organization, id: string, projectId?: string | null) {
    return this._engageRepository.getOpportunityDetail(org.id, id, projectId);
  }

  async getOpportunityForReply(org: Organization, id: string, projectId?: string | null) {
    return this._engageRepository.getOpportunityForReply(org.id, id, projectId);
  }

  // Persist an unpublished working draft (AI-generated, edited, or hand-typed) for
  // an opportunity — one DRAFT per opportunity, upserted. Decoupled from generation
  // so a manually-typed reply is saved too. Unlike send/schedule/manual it does NOT
  // claim the opportunity (it stays actionable in the feed), charge credits, or sync
  // metrics; it just stores the content as a Post(state=DRAFT)+EngageSentReply so it
  // surfaces in GET /sent?status=awaiting.
  async saveDraft(org: Organization, opportunityId: string, dto: SaveDraftDto) {
    // Gate on actionable status (same as draft generation): no drafts for an
    // expired/replied/scheduled/dismissed opportunity. Throws Forbidden otherwise.
    const opportunity = await this._engageRepository.getOpportunityForReply(
      org.id,
      opportunityId,
      dto.projectId
    );
    const saved = await this._engageRepository.upsertDraft(org.id, opportunityId, {
      platform: opportunity.platform,
      content: dto.draftContent,
      inputData: {
        strategy: dto.strategy,
        brandStrength: dto.brandStrength,
        mentions: dto.mentions,
      },
    }, dto.projectId);

    // Also record this save as a 'manual' version in generationHistory so the
    // version history is complete (AI + hand-typed/edited), each tagged by source.
    // Deduped against the latest entry (saving an unchanged AI draft won't dup it).
    // Best-effort: a history hiccup must not fail the save itself.
    await this._engageRepository
      .recordManualGeneration(org.id, opportunityId, {
        source: 'manual',
        content: dto.draftContent,
        strategy: dto.strategy,
        brandStrength: dto.brandStrength,
        ...(dto.mentions?.length ? { mentions: dto.mentions } : {}),
        createdAt: new Date().toISOString(),
      }, dto.projectId)
      .catch(() => undefined);

    return saved;
  }

  // Append one AI-generation entry to the opportunity's per-org version history
  // (every successful generation is kept so the user can review past versions).
  // Best-effort at the call site — losing an audit entry must not fail a draft
  // that was already produced and charged.
  async recordGeneration(
    org: Organization,
    opportunityId: string,
    entry: GenerationHistoryEntry,
    projectId?: string
  ): Promise<void> {
    await this._engageRepository.appendGenerationHistory(
      org.id,
      opportunityId,
      entry,
      projectId
    );
  }

  // ─── Reply-draft billing (the only credit-charging action in engage) ───────

  /**
   * Reserve a reply generation before any model call: monthly cap + credit
   * balance, writing the cap-ledger row up front. Throws ForbiddenException
   * (typed code) when blocked. Returns the length-based cost AND the reservation
   * taskId — the caller MUST later settle (success) or release (failure/abort).
   */
  async reserveReplyGeneration(
    org: Organization,
    length: ReplyLength,
    opportunityId: string
  ) {
    return this._entitlementService.reserveReplyGeneration(
      org.id,
      length,
      opportunityId
    );
  }

  /** Settle a reserved reply after a successful generation (charges credits). */
  async settleReplyGeneration(
    org: Organization,
    taskId: string,
    length: ReplyLength,
    cost: number
  ): Promise<void> {
    await this._entitlementService.settleReplyGeneration(
      org.id,
      taskId,
      length,
      cost
    );
  }

  /** Release a reservation when generation failed/aborted (uncounts it). */
  async releaseReplyGeneration(taskId: string): Promise<void> {
    await this._entitlementService.releaseReplyGeneration(taskId);
  }

  // ─── Sent Replies ─────────────────────────────────────────────────────────

  async listSentReplies(org: Organization, dto: ListSentDto) {
    return this._engageRepository.listSentReplies(org.id, dto);
  }

  // Cross-org Engage reply list for the admin console. Not org-scoped — the
  // caller (AdminEngageController, SuperAdmin-guarded) passes an optional
  // organizationId filter already resolved from userId.
  listSentRepliesForAdmin(query: {
    page?: number;
    pageSize?: number;
    organizationId?: string | string[];
    platform?: string;
    state?: State;
    sortOrder?: 'asc' | 'desc';
  }) {
    return this._engageRepository.listSentRepliesForAdmin(query);
  }

  async locateOpportunity(org: Organization, dto: LocateOpportunityDto) {
    return this._engageRepository.locateOpportunity(org.id, dto);
  }

  async locateSentReply(org: Organization, dto: LocateSentReplyDto) {
    return this._engageRepository.locateSentReply(org.id, dto);
  }

  // Poll target for the in-browser extension reply loop: returns once the
  // extension has backfilled the permalink (replyUrl non-null).
  async getSentReplyStatus(org: Organization, sentReplyId: string) {
    return this._engageRepository.getSentReplyStatus(org.id, sentReplyId);
  }

  async getSentReplyItemById(org: Organization, sentReplyId: string) {
    return this._engageRepository.getSentReplyItemById(org.id, sentReplyId);
  }

  async updateScheduledReply(org: Organization, id: string, dto: UpdateScheduledReplyDto) {
    if (dto.scheduledAt !== undefined) {
      if (new Date(dto.scheduledAt) <= new Date()) {
        throw new BadRequestException('scheduledAt must be a future date');
      }
      const reply = await this._engageRepository.getSentReplyById(org.id, id);
      // changeDate handles the claim-gate and Temporal workflow restart
      await this._postsService.changeDate(org.id, reply.post.id, dto.scheduledAt);
    }

    const inputData = (dto.strategy !== undefined || dto.brandStrength !== undefined || dto.mentions !== undefined)
      ? { strategy: dto.strategy, brandStrength: dto.brandStrength, mentions: dto.mentions }
      : undefined;

    if (dto.content !== undefined || inputData !== undefined) {
      return this._engageRepository.updateScheduledReply(org.id, id, {
        content: dto.content,
        inputData,
      });
    }

    return this._engageRepository.getSentReplyById(org.id, id);
  }

  async getSentStats(
    org: Organization,
    dto: { date?: string; platform?: string; status?: string; projectId?: string } = {}
  ) {
    return this._engageRepository.getSentStats(org.id, dto);
  }

  async getSentCounts(
    org: Organization,
    dto: { date?: string; status?: string; projectId?: string } = {}
  ) {
    return this._engageRepository.getSentCounts(org.id, dto);
  }

  // ─── Dashboard ────────────────────────────────────────────────────────────

  async getDashboardSummary(
    org: Organization,
    opts: { projectId?: string; platform?: string; date?: string } = {}
  ) {
    return this._engageRepository.getDashboardSummary(org.id, opts);
  }

  async getDashboardRepliesTrend(
    org: Organization,
    period?: 'daily' | 'weekly' | 'monthly',
    projectId?: string
  ) {
    return this._engageRepository.getDashboardRepliesTrend(org.id, period, projectId);
  }

  async getDashboardTraffics(
    org: Organization,
    opts: { projectId?: string; platform?: string; limit?: number }
  ) {
    return this._engageRepository.getDashboardTraffics(org.id, opts);
  }

  async getDashboardImpressions(
    org: Organization,
    period: 'daily' | 'weekly' | 'monthly' = 'daily',
    projectId?: string
  ) {
    return this._engageRepository.getDashboardImpressions(org.id, period, projectId);
  }

  async getDashboardTopSources(
    org: Organization,
    opts: { projectId?: string; platform?: string; limit?: number }
  ) {
    return this._engageRepository.getDashboardTopSources(org.id, opts);
  }

  async submitManualReplyUrl(
    org: Organization,
    sentReplyId: string,
    url: string,
    author?: EngageAuthorProfile
  ) {
    // Load state + platform in one read. The manual backfill is ONLY meaningful for
    // a reply that was already posted (PUBLISHED) but whose permalink is still
    // pending. A DRAFT working-copy was never sent; QUEUE will auto-fire later; an
    // ERROR publish failed — attaching a link to any of them would mint a record
    // that looks "live" without ever having been published (and, for X, kick off a
    // metrics sync against a tweet that doesn't exist). Guard with an explicit 400
    // so the frontend can tell the user exactly why, instead of silently corrupting
    // the row. The extension publish-on-success path intentionally backfills a DRAFT
    // and flips it PUBLISHED in one write — but it goes through publishExtensionReply
    // (updateReplyUrl with markPublished), never here, so this guard can't break it.
    const ctx = await this._engageRepository.getSentReplyContext(org.id, sentReplyId);
    if (!ctx) throw new NotFoundException('Sent reply not found');
    if (ctx.state !== 'PUBLISHED') {
      throw new BadRequestException(
        ctx.state === 'DRAFT'
          ? 'This reply is still a draft — send it before submitting its link.'
          : `Cannot attach a reply link to a ${String(
              ctx.state ?? 'unknown'
            ).toLowerCase()} reply — only a posted reply awaiting its link can be backfilled.`
      );
    }
    const platform = ctx.platform ?? '';
    // The backfill URL is mandatory here, so always validate format + reachability.
    await this._validateReplyUrl(platform, url);
    // Save the URL immediately. When the caller already supplies the real poster
    // (e.g. the browser extension captured it from X's CreateTweet response), pass
    // it straight through so it's recorded synchronously — and skip the slow
    // out-of-band lookup. Otherwise resolve the author out of band (Reddit scrape /
    // X API), which is slow + display-only and must never block saving the URL.
    const result = await this._engageRepository.updateReplyUrl(
      org.id,
      sentReplyId,
      url,
      author
    );
    if (!author) {
      this._storeReplyAuthorInBackground(org.id, sentReplyId, platform, url);
    }
    return result;
  }

  /**
   * Extension publish-on-success callback. Unlike confirmManualReply (which
   * optimistically creates a PUBLISHED post + charges at confirm time), the
   * extension flow saves a DRAFT first (save-draft) and commits NOTHING until the
   * browser confirms the reply actually posted. This is that commit point:
   *   1. backfill the permalink (releaseURL/releaseId/integration/author) AND flip
   *      the post DRAFT→PUBLISHED in one write;
   *   2. claim the opportunity → REPLIED (best-effort: the reply is already live,
   *      so a non-actionable opportunity must not lose the record);
   *   3. charge here, and ONLY here, on confirmed success (idempotent by postId).
   * Idempotent: a duplicate/late callback for an already-published reply no-ops
   * (no re-charge, no re-claim) — the releaseURL is the success marker.
   */
  async publishExtensionReply(
    org: Organization,
    userId: string | undefined,
    sentReplyId: string,
    url: string,
    author?: EngageAuthorProfile
  ) {
    const ctx = await this._engageRepository.getSentReplyContext(org.id, sentReplyId);
    if (!ctx) throw new NotFoundException('Sent reply not found');

    // Already published with a URL → a repeat success callback. No-op so we never
    // double-charge or re-claim.
    if (ctx.state === 'PUBLISHED' && ctx.releaseURL) {
      return {
        id: sentReplyId,
        state: 'PUBLISHED',
        replyUrl: ctx.releaseURL,
        alreadyPublished: true,
      };
    }
    if (ctx.platform !== 'x' && ctx.platform !== 'reddit') {
      throw new BadRequestException(
        'Publish is only valid for X or Reddit replies'
      );
    }

    // Same format validation as the manual backfill path.
    await this._validateReplyUrl(ctx.platform, url);

    // Backfill URL + (X) releaseId/integration + author AND flip DRAFT→PUBLISHED.
    await this._engageRepository.updateReplyUrl(org.id, sentReplyId, url, author, {
      markPublished: true,
    });

    // The reply is live on the platform; recording it wins over claim bookkeeping.
    try {
      await this._engageRepository.claimOpportunityForReply(
        org.id,
        ctx.opportunityId,
        'REPLIED'
      );
    } catch (err) {
      this.logger.warn(
        `publishExtensionReply: could not claim opportunity ${ctx.opportunityId} ` +
          `(already replied/expired?): ${err instanceof Error ? err.message : err}`
      );
    }

    // Charge ONLY now, on confirmed success. Fire-and-forget — billing must not
    // break the user-visible publish — and idempotent by postId (taskId).
    if (userId) {
      this._postOverageService
        .deductIfOverage(org.id, userId, ctx.postId, 'engage')
        .catch((err) =>
          this.logger.error(
            `publishExtensionReply: deductIfOverage failed for postId=${ctx.postId}:`,
            err
          )
        );
    } else {
      this.logger.warn(
        `publishExtensionReply: skipping deductIfOverage for postId=${ctx.postId} — no userId`
      );
    }

    // The extension usually supplies the real poster (X CreateTweet capture);
    // when it doesn't, resolve it out of band like the manual backfill path.
    if (!author) {
      this._storeReplyAuthorInBackground(org.id, sentReplyId, ctx.platform, url);
    }

    return { id: sentReplyId, state: 'PUBLISHED', replyUrl: url };
  }

  /**
   * Resolve the reply's author (handle + avatar/name) and persist it to
   * settings.engageAuthor — OUT OF BAND, fire-and-forget. The lookup is slow
   * (Reddit: comment→author then author→/about, each behind the loid/WAF path) and
   * purely cosmetic, so callers save the URL first and invoke this without
   * awaiting. Never throws — failures are logged and the reply keeps its URL with
   * no author (the replies list simply shows no avatar/name until a later retry).
   */
  private _storeReplyAuthorInBackground(
    orgId: string,
    sentReplyId: string,
    platform: string,
    url: string
  ): void {
    void runWithBizUsage(
      { organizationId: orgId, bizCategory: BIZ_USAGE.ENGAGE_AUTHOR_ENRICH },
      async () => {
      let engageAuthor: EngageAuthorProfile | null = null;
      if (platform === 'x') {
        engageAuthor = (await this._postsService.fetchEngageXAuthor(orgId, url)) ?? null;
      } else if (platform === 'reddit') {
        engageAuthor = await fetchRedditAuthorProfile(url, (message) =>
          this.logger.warn(`storeReplyAuthor: ${message}`)
        );
      }
      if (!engageAuthor) {
        this.logger.warn(
          `storeReplyAuthor: could not resolve ${platform} reply author for sentReplyId=${sentReplyId}`
        );
        return;
      }
      await this._engageRepository.updateReplyAuthor(orgId, sentReplyId, engageAuthor);
      }
    ).catch((err) =>
      this.logger.error(
        `storeReplyAuthor: background author enrichment failed for sentReplyId=${sentReplyId}:`,
        err instanceof Error ? err.stack : err
      )
    );
  }

  /**
   * Validate a reply URL against its platform: correct format only. Shared by the
   * confirm path (only when a URL is supplied) and the backfill path (always).
   *
   * Network reachability of the target (Reddit comment / X tweet) is intentionally
   * NOT checked: the verification fetch goes out through the global proxy
   * dispatcher, which returns 407 in environments without proxy credentials and
   * blocks legitimate backfills. We trust the user-supplied link's format instead.
   */
  private async _validateReplyUrl(platform: string, url: string): Promise<void> {
    if (platform === 'reddit') {
      if (!isRedditUrl(url)) {
        throw new BadRequestException(
          'Invalid Reddit comment URL — must be a reddit.com link.'
        );
      }
      // Strict: the URL must contain a parseable comment id. Host-only
      // validation let truncated links (e.g. .../comments/d) and post-only links
      // through, which saved a releaseURL whose comment id can't be parsed —
      // syncRedditMetrics then skips forever and the reply silently never gets
      // metrics. Reject here so the id is guaranteed present before persisting.
      if (!parseRedditCommentId(url)) {
        throw new BadRequestException(
          'Invalid Reddit comment URL — must link to a specific comment, e.g. ' +
            'https://www.reddit.com/r/<sub>/comments/<postId>/comment/<commentId>/ ' +
            '(share params like ?utm_source are fine).'
        );
      }
    } else if (platform === 'x') {
      if (!isXUrl(url)) {
        throw new BadRequestException(
          'Invalid X reply URL — must be an x.com or twitter.com link.'
        );
      }
      // Strict: the URL must contain a parseable /status/<id>. Host-only
      // validation let id-less links through, which saved releaseURL with a
      // null releaseId — checkPostAnalytics then early-returns and metrics never
      // sync. Reject here so the id is guaranteed present before persisting.
      if (!parseXTweetId(url)) {
        throw new BadRequestException(
          'Invalid X reply URL — must link to a specific tweet, e.g. ' +
            'https://x.com/<user>/status/<id> (tracking params like ?s=20 are fine).'
        );
      }
    } else {
      throw new BadRequestException(
        'Reply-URL backfill is only valid for X or Reddit manual replies'
      );
    }
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private async _searchRedditSubreddits(query: string, userToken?: string | null) {
    // Strip leading "r/" so users can type either "SEO" or "r/SEO".
    const normalized = query.replace(/^r\//i, '').trim();
    if (!normalized) return [];

    // Prefer user-level OAuth token (from a connected Reddit account). The
    // app-level client_credentials token (getRedditToken) is unavailable for
    // "web app" type apps — Reddit forbids that grant (403) — so it falls back
    // to the public JSON API, which works from a clean (non-blocked) IP.
    const appToken = userToken ? null : await getRedditToken();
    const token = userToken || appToken;
    this.logger.log(
      `[redditSearch] query="${query}" normalized="${normalized}" tokenSource=${
        userToken ? 'user-oauth' : appToken ? 'app-client-credentials' : 'none(public-json)'
      }`
    );

    // Fetch a reddit URL with OAuth headers when a token is available, or the
    // public .json API otherwise. The public path uses redditPublicGet, which
    // carries the loid cookie (clears Reddit's anti-bot WAF) and applies the
    // tiered proxy strategy: proxy → rotate-IP on 403/429 → direct fallback.
    const redditFetch = async (
      url: string
    ): Promise<{ status: number; ok: boolean; text(): Promise<string> }> => {
      if (token) {
        const res = await fetch(url, {
          headers: redditAuthHeaders(token),
          signal: AbortSignal.timeout(8000),
        });
        return { status: res.status, ok: res.ok, text: () => res.text() };
      }
      return redditPublicGet(url, {}, { log: (m) => this.logger.warn(m) });
    };

    const searchBase = token
      ? `https://oauth.reddit.com/subreddits/search`
      : `https://www.reddit.com/subreddits/search.json`;

    const aboutBase = (name: string) =>
      token
        ? `https://oauth.reddit.com/r/${encodeURIComponent(name)}/about`
        : `https://www.reddit.com/r/${encodeURIComponent(name)}/about.json`;

    const mapSubreddit = (d: Record<string, unknown>) => ({
      platform: 'reddit' as const,
      channelId: d.display_name as string,
      channelName: `r/${d.display_name as string}`,
      audienceSize: Number(d.subscribers ?? 0),
      metadata: {
        description: d.public_description,
        url: `https://reddit.com/r/${d.display_name}`,
        avatar: (d.community_icon as string)?.split('?')[0] || (d.icon_img as string) || null,
      },
    });

    // Primary: subreddit search.
    try {
      const url = `${searchBase}?q=${encodeURIComponent(normalized)}&limit=10&type=sr`;
      this.logger.log(`[redditSearch] primary GET ${url}`);
      const res = await redditFetch(url);
      const raw = await res.text();
      this.logger.log(
        `[redditSearch] primary status=${res.status} ok=${res.ok} bodyLen=${raw.length} body=${raw.slice(0, 2000)}`
      );
      if (res.ok) {
        const json = JSON.parse(raw) as {
          data?: { children?: Array<{ data: Record<string, unknown> }> };
        };
        const children = json?.data?.children ?? [];
        this.logger.log(`[redditSearch] primary parsed children=${children.length}`);
        const results = children.map((c) => mapSubreddit(c.data));
        if (results.length) {
          this.logger.log(`[redditSearch] primary returning ${results.length} result(s)`);
          return results;
        }
      }
    } catch (err) {
      this.logger.warn(`[redditSearch] primary failed: ${(err as Error).message}`);
      // fall through to direct lookup
    }

    // Fallback: exact subreddit name — handles small/new subreddits absent from search index.
    try {
      const aboutUrl = aboutBase(normalized);
      this.logger.log(`[redditSearch] fallback GET ${aboutUrl}`);
      const aboutRes = await redditFetch(aboutUrl);
      const raw = await aboutRes.text();
      this.logger.log(
        `[redditSearch] fallback status=${aboutRes.status} ok=${aboutRes.ok} bodyLen=${raw.length} body=${raw.slice(0, 2000)}`
      );
      if (!aboutRes.ok) return [];
      const about = JSON.parse(raw) as { data?: Record<string, unknown> };
      const d = about.data;
      if (!d || d.subreddit_type === 'private') {
        this.logger.log(
          `[redditSearch] fallback no usable data (type=${d?.subreddit_type ?? 'missing'})`
        );
        return [];
      }
      this.logger.log(`[redditSearch] fallback returning r/${d.display_name}`);
      return [mapSubreddit(d)];
    } catch (err) {
      this.logger.warn(`[redditSearch] fallback failed: ${(err as Error).message}`);
      return [];
    }
  }

  // Workflow ids of retired scan workflows. Terminated on boot so upgrading
  // deployments don't leave them looping into now-incompatible code.
  //  • engage-keyword/channel/tracked-global — the old per-type workflows.
  //  • engage-scan-ticker — the old 5-minute *periodic* ticker. Its history has
  //    a sleep timer the new (event-driven, timer-less) workflow no longer
  //    schedules, so replaying it under the new code would throw a
  //    non-determinism error. We terminate it and run the new logic under a
  //    fresh id (SCAN_WORKFLOW_ID below) instead.
  private static readonly LEGACY_SCAN_WORKFLOW_IDS = [
    'engage-keyword-global',
    'engage-channel-global',
    'engage-tracked-global',
    'engage-scan-ticker',
  ];

  // Current scan-executor workflow id. Bumped from 'engage-scan-ticker' when the
  // workflow went from periodic to purely event-driven (breaking history change).
  private static readonly SCAN_WORKFLOW_ID = 'engage-scan-ticker-v2';

  // Ensures the single engage scan executor exists so it can receive wake
  // signals. It is PURELY EVENT-DRIVEN — no periodic tick; it just waits for a
  // page-visit / setup signal and scans the units that are due. The per-unit
  // cadence is enforced inside the activity. USE_EXISTING makes this idempotent.
  private async _ensureGlobalWorkflowsRunning(): Promise<void> {
    const client = this._temporalService.client?.getRawClient();
    if (!client) return;

    // Best-effort cleanup of retired scan workflows (incl. the old periodic
    // ticker, whose history is incompatible with the new event-driven code).
    for (const id of EngageService.LEGACY_SCAN_WORKFLOW_IDS) {
      try {
        await client.workflow?.getHandle(id).terminate('superseded by engage-scan-ticker-v2');
      } catch {
        // Not running / already gone — ignore.
      }
    }

    try {
      await client.workflow?.start('engageScanTickerWorkflow', {
        workflowId: EngageService.SCAN_WORKFLOW_ID,
        taskQueue: 'main',
        args: [],
        workflowIdConflictPolicy: 'USE_EXISTING',
      });
    } catch (err) {
      this.logger.error('Failed to start engageScanTickerWorkflow:', err);
    }
  }

  // ─── Reply pacing gate (§6/§6.1) ───────────────────────────────────────────
  //
  // Independent of, and additional to, EngageEntitlementService's monthly
  // reply-GENERATION credit cap (§6.2) — that gate runs at draft-generation
  // time and governs LLM-cost admission; this one runs at SEND time and
  // governs pacing. A reply passes both, and neither substitutes for the
  // other. Called from inside each send/schedule flow's existing claim→
  // publish try/catch, right before the platform-side publish call, so a
  // blocked send hits the SAME rollback path (release the claim) as any
  // other pre-publish failure — never a change to that error-handling shape.

  /**
   * Throws ForbiddenException if the request would exceed any of: the project's
   * active-plan daily reply TARGET (`targetRepliesPerDay`), a per-keyword target
   * (`keywordTargets[keyword]`) for any keyword this reply matched, an optional
   * extra safety cap (`dailyHardCap`/`hardCapRepliesPerDay`, tighter of the two
   * wins), or an account's per-account daily cap. No-ops (never blocks) if
   * OperationPlanRepository/SettingsService weren't wired in (test
   * construction) — see the constructor note.
   *
   * `matchedKeywords` is the claimed opportunity's send-time keyword snapshot;
   * every request in a call targets the same opportunity, so one array covers
   * the whole batch.
   */
  private async _assertReplyPacing(
    organizationId: string,
    projectId: string | null | undefined,
    platform: string,
    matchedKeywords: string[],
    requests: Array<{ integrationId: string; at: Date }>
  ): Promise<void> {
    const projectGroups = new Map<string, { start: Date; end: Date; count: number }>();
    const accountGroups = new Map<
      string,
      { integrationId: string; start: Date; end: Date; count: number }
    >();
    for (const request of requests) {
      const start = dayjs.utc(request.at).startOf('day');
      const end = start.add(1, 'day');
      const dayKey = start.toISOString();
      const projectGroup = projectGroups.get(dayKey);
      if (projectGroup) projectGroup.count += 1;
      else projectGroups.set(dayKey, { start: start.toDate(), end: end.toDate(), count: 1 });

      const accountKey = `${request.integrationId}:${dayKey}`;
      const accountGroup = accountGroups.get(accountKey);
      if (accountGroup) accountGroup.count += 1;
      else {
        accountGroups.set(accountKey, {
          integrationId: request.integrationId,
          start: start.toDate(),
          end: end.toDate(),
          count: 1,
        });
      }
    }
    await Promise.all([
      ...Array.from(projectGroups.values()).map((group) =>
        this._assertProjectDailyTarget(
          organizationId,
          projectId,
          platform,
          matchedKeywords,
          group.start,
          group.end,
          group.count
        )
      ),
      ...Array.from(accountGroups.values()).map((group) =>
        this._assertAccountDailyCap(
          group.integrationId,
          group.start,
          group.end,
          group.count
        )
      ),
    ]);
  }

  private async _assertProjectDailyTarget(
    organizationId: string,
    projectId: string | null | undefined,
    platform: string,
    matchedKeywords: string[],
    dayStart: Date,
    dayEnd: Date,
    requested: number
  ): Promise<void> {
    // No project context → no plan can exist for it → no target to enforce
    // (§3.4: "a project with no active plan has no daily target").
    if (!projectId || !this._operationPlanRepository) return;

    const plan = await this._operationPlanRepository.getActivePlan(
      organizationId,
      projectId,
      dayStart
    );
    if (!plan) return;

    const policies = (plan.planPayload as { engagePolicies?: Array<{
      platform: string;
      enabled: boolean;
      targetRepliesPerDay?: number;
      // Per-day overrides of targetRepliesPerDay, keyed by UTC "YYYY-MM-DD"
      // (operation-plan generation emits these so a plan can pace weekdays and
      // weekends differently). Absent/unmatched dates fall back to the default.
      dailyTargets?: Array<{ date: string; target: number }>;
      keywordTargets?: Record<string, number>;
      // Optional extra safety ceiling — NOT emitted by operation-plan generation
      // (§3.4: "the operation-plan API does not generate or return a dailyHardCap"),
      // but honored as a tighter override if a plan carries one.
      dailyHardCap?: number;
      hardCapRepliesPerDay?: number;
    }> } | null)?.engagePolicies;
    const policy = policies?.find((p) => p?.platform === platform && p?.enabled);
    if (!policy) return;

    // This day's target: a `dailyTargets` entry for the exact UTC date wins,
    // else the policy default. A 0 override is meaningful ("send nothing this
    // day"), so check for presence, not truthiness.
    const dayKey = dayjs.utc(dayStart).format('YYYY-MM-DD');
    const override = policy.dailyTargets?.find((d) => d?.date === dayKey);
    const dailyTarget =
      override && typeof override.target === 'number'
        ? override.target
        : policy.targetRepliesPerDay;

    // Aggregate daily ceiling: the day's target is the primary cap; an optional
    // dailyHardCap tightens it further. Enforce the tighter of whichever exist.
    // A target of exactly 0 means "no replies today" — enforce it rather than
    // letting the `> 0` filter drop it into "uncapped".
    if (dailyTarget === 0) {
      throw new ForbiddenException({
        code: 'engage_daily_hard_cap_reached',
        message: `This project's plan sets a 0 reply target for ${platform} on ${dayKey}.`,
        hardCap: 0,
        sentToday: 0,
        requested,
      });
    }
    const caps = [
      dailyTarget,
      policy.dailyHardCap ?? policy.hardCapRepliesPerDay,
    ].filter((c): c is number => typeof c === 'number' && c > 0);
    const effectiveCap = caps.length ? Math.min(...caps) : undefined;

    // Per-keyword sub-targets that apply to THIS reply (only keywords it matched).
    const keywordTargets = policy.keywordTargets ?? {};
    const applicableKeywords = matchedKeywords.filter(
      (k) => typeof keywordTargets[k] === 'number' && keywordTargets[k] > 0
    );

    if (effectiveCap === undefined && applicableKeywords.length === 0) return;

    await Promise.all([
      // Aggregate target/hard-cap check.
      (async () => {
        if (effectiveCap === undefined) return;
        const sentToday = await this._engageRepository.countProjectSentRepliesToday(
          organizationId,
          projectId,
          platform,
          dayStart,
          dayEnd
        );
        if (sentToday + requested > effectiveCap) {
          throw new ForbiddenException({
            code: 'engage_daily_hard_cap_reached',
            message: `This project would exceed its daily reply target for ${platform} (${effectiveCap}).`,
            hardCap: effectiveCap,
            sentToday,
            requested,
          });
        }
      })(),
      // Per-keyword target checks — one live count per applicable keyword.
      ...applicableKeywords.map(async (keyword) => {
        const target = keywordTargets[keyword];
        const sentToday =
          await this._engageRepository.countProjectKeywordSentRepliesToday(
            organizationId,
            projectId,
            platform,
            keyword,
            dayStart,
            dayEnd
          );
        if (sentToday + requested > target) {
          throw new ForbiddenException({
            code: 'engage_daily_keyword_target_reached',
            message: `This project would exceed its daily reply target for keyword "${keyword}" on ${platform} (${target}).`,
            keyword,
            target,
            sentToday,
            requested,
          });
        }
      }),
    ]);
  }

  private async _assertAccountDailyCap(
    integrationId: string,
    dayStart: Date,
    dayEnd: Date,
    requested: number
  ): Promise<void> {
    if (!this._settingsService) return;
    const cap =
      (await this._settingsService.get<number>(ENGAGE_REPLY_ACCOUNT_DAILY_CAP_KEY)) ??
      DEFAULT_REPLY_ACCOUNT_DAILY_CAP;
    if (!cap || cap <= 0) return; // 0/unset = uncapped

    const sentToday = await this._engageRepository.countAccountSentRepliesToday(
      integrationId,
      dayStart,
      dayEnd
    );
    if (sentToday + requested > cap) {
      throw new ForbiddenException({
        code: 'engage_account_daily_cap_reached',
        message: `This account has reached its daily reply cap (${cap}).`,
        cap,
        sentToday,
        requested,
      });
    }
  }

  // ─── Reply transactional flows ────────────────────────────────────────────
  //
  // These three methods own the multi-step claim → publish → sentReply → sync
  // orchestration. They live in the service tier (not the controller) so the
  // controller only depends on services, never on EngageRepository directly.

  async sendReply(
    org: Organization,
    userId: string | undefined,
    opportunityId: string,
    body: SendReplyDto
  ) {
    // Atomic claim: marks status=REPLIED iff currently NEW/AUTO_QUEUED. Loser
    // of a concurrent race throws NotFoundException here, BEFORE createPost —
    // eliminates duplicate X publishes and orphan Post rows.
    const { opp: opportunity, priorStatus } =
      await this._engageRepository.claimOpportunityForReply(
        org.id,
        opportunityId,
        'REPLIED',
        body.projectId
      );

    // Phase 1 — invoke the post pipeline. type='now' BLOCKS until X publish
    // completes; a failure means the reply never reached X. Full rollback safe.
    let postId: string | undefined;
    try {
      // §6/§6.1 pacing gate — a blocked send hits this same catch/rollback.
      await this._assertReplyPacing(
        org.id,
        body.projectId,
        opportunity.platform,
        opportunity.matchedKeywords ?? [],
        [{ integrationId: body.integrationId, at: new Date() }]
      );

      const created = await this._postsService.createPost(
        org.id,
        {
          type: 'now',
          source: 'engage',
          projectId: body.projectId,
          tags: [],
          shortLink: false,
          date: new Date().toISOString(),
          posts: [
            {
              integration: { id: body.integrationId },
              value: [
                { content: body.draftContent, image: [], delay: 0, id: '' } as never,
              ],
              group: '',
              settings: {
                __type: 'x',
                reply_to_tweet_id: opportunity.externalPostId,
                who_can_reply_post: 'everyone',
              } as never,
            } as never,
          ],
        },
        userId
      );
      // PostsService.createPost returns objects keyed `postId` (not `id`).
      postId = created?.[0]?.postId;
      if (!postId) throw new Error('Post creation failed');
    } catch (err) {
      if (postId) await this._engageRepository.deletePostById(postId);
      await this._engageRepository.releaseOpportunityClaim(
        org.id,
        opportunityId,
        priorStatus,
        body.projectId
      );
      throw err;
    }

    // Phase 2 — the X reply IS LIVE on twitter.com. Do NOT roll back.
    try {
      const sentReply = await this._engageRepository.createSentReply({
        organizationId: org.id,
        projectId: body.projectId,
        opportunityId,
        postId,
        inputData: { strategy: body.strategy, brandStrength: body.brandStrength, mentions: body.mentions },
        matchedKeywords: opportunity.matchedKeywords,
      });
      return sentReply;
    } catch (err) {
      this.logger.error(
        `sendReply: X reply published (postId=${postId}, opportunityId=${opportunityId}, ` +
        `orgId=${org.id}) but failed to record EngageSentReply.`,
        err instanceof Error ? err.stack : err
      );
      if (err instanceof HttpException) throw err;
      throw new InternalServerErrorException(
        'Reply was published but the tracking record could not be created. ' +
        'Contact support to reconcile.',
        { cause: err instanceof Error ? err : undefined }
      );
    }
  }

  async cancelAndSendNow(
    org: Organization,
    userId: string | undefined,
    opportunityId: string,
    body: SendReplyDto
  ) {
    const existing = await this._engageRepository.getSentReplyByOpportunity(org.id, opportunityId);
    if (existing) {
      if (existing.post.state !== 'QUEUE') {
        throw new BadRequestException('Scheduled post is no longer pending — cannot cancel');
      }
      await this._engageRepository.deletePostById(existing.postId);
      await this._engageRepository.resetScheduledOpportunity(
        org.id,
        opportunityId,
        body.projectId
      );
    }
    return this.sendReply(org, userId, opportunityId, body);
  }

  async scheduleReply(
    org: Organization,
    userId: string | undefined,
    opportunityId: string,
    body: ScheduleReplyDto
  ) {
    if (new Date(body.scheduledAt) <= new Date()) {
      throw new BadRequestException('scheduledAt must be a future date');
    }

    const { opp: opportunity, priorStatus } =
      await this._engageRepository.claimOpportunityForReply(
        org.id,
        opportunityId,
        'SCHEDULED',
        body.projectId
      );

    // Scheduled posts publish at a future time — full rollback on failure is safe.
    let postId: string | undefined;
    try {
      await this._assertReplyPacing(
        org.id,
        body.projectId,
        opportunity.platform,
        opportunity.matchedKeywords ?? [],
        [{ integrationId: body.integrationId, at: new Date(body.scheduledAt) }]
      );

      const created = await this._postsService.createPost(
        org.id,
        {
          type: 'schedule',
          source: 'engage',
          projectId: body.projectId,
          tags: [],
          shortLink: false,
          date: body.scheduledAt,
          posts: [
            {
              integration: { id: body.integrationId },
              value: [
                { content: body.draftContent, image: [], delay: 0, id: '' } as never,
              ],
              group: '',
              settings: {
                __type: 'x',
                reply_to_tweet_id: opportunity.externalPostId,
                who_can_reply_post: 'everyone',
              } as never,
            } as never,
          ],
        },
        userId
      );
      postId = created?.[0]?.postId;
      if (!postId) throw new Error('Post creation failed');

      return await this._engageRepository.createSentReply({
        organizationId: org.id,
        projectId: body.projectId,
        opportunityId,
        postId,
        inputData: { strategy: body.strategy, brandStrength: body.brandStrength, mentions: body.mentions },
        matchedKeywords: opportunity.matchedKeywords,
      });
      // metrics sync is started after the scheduled post actually publishes
      // (the post workflow triggers it via engage-metrics-sync-on-publish).
    } catch (err) {
      if (postId) await this._engageRepository.deletePostById(postId);
      await this._engageRepository.releaseOpportunityClaim(
        org.id,
        opportunityId,
        priorStatus,
        body.projectId
      );
      throw err;
    }
  }

  async batchScheduleReply(
    org: Organization,
    userId: string | undefined,
    opportunityId: string,
    body: BatchScheduleReplyDto
  ) {
    for (const item of body.items) {
      if (new Date(item.scheduledAt) <= new Date()) {
        throw new BadRequestException('All scheduledAt values must be future dates');
      }
    }

    const { opp: opportunity, priorStatus } =
      await this._engageRepository.claimOpportunityForReply(
        org.id,
        opportunityId,
        'SCHEDULED',
        body.projectId
      );

    const createdPostIds: string[] = [];
    try {
      await this._assertReplyPacing(
        org.id,
        body.projectId,
        opportunity.platform,
        opportunity.matchedKeywords ?? [],
        body.items.map((item) => ({
          integrationId: item.integrationId,
          at: new Date(item.scheduledAt),
        }))
      );

      for (const item of body.items) {
        const created = await this._postsService.createPost(
          org.id,
          {
            type: 'schedule',
            source: 'engage',
            projectId: body.projectId,
            tags: [],
            shortLink: false,
            date: item.scheduledAt,
            posts: [
              {
                integration: { id: item.integrationId },
                value: [
                  { content: item.draftContent, image: [], delay: 0, id: '' } as never,
                ],
                group: '',
                settings: {
                  __type: 'x',
                  reply_to_tweet_id: opportunity.externalPostId,
                  who_can_reply_post: 'everyone',
                } as never,
              } as never,
            ],
          },
          userId
        );
        const postId = created?.[0]?.postId;
        if (!postId) throw new Error('Post creation failed');
        createdPostIds.push(postId);
      }
    } catch (err) {
      for (const postId of createdPostIds) {
        await this._engageRepository.deletePostById(postId);
      }
      await this._engageRepository.releaseOpportunityClaim(
        org.id,
        opportunityId,
        priorStatus,
        body.projectId
      );
      throw err;
    }

    // Phase 2: one tracking row per scheduled post. Tracking is keyed per-post,
    // so the items are independent — isolate failures (a transient DB error on
    // one must not drop the others) and surface genuine failures via the log.
    const settled = await Promise.allSettled(
      body.items.map((item, i) =>
        this._engageRepository.createSentReply({
          organizationId: org.id,
          projectId: body.projectId,
          opportunityId,
          postId: createdPostIds[i],
          inputData: { strategy: item.strategy, brandStrength: item.brandStrength, mentions: item.mentions },
          matchedKeywords: opportunity.matchedKeywords,
        })
      )
    );
    const results: EngageSentReply[] = [];
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        results.push(r.value);
      } else {
        this.logger.error(
          `batchScheduleReply: post scheduled (postId=${createdPostIds[i]}, opportunityId=${opportunityId}, ` +
          `orgId=${org.id}) but failed to record EngageSentReply.`,
          r.reason instanceof Error ? r.reason.stack : r.reason
        );
      }
    });
    return results;
  }

  async batchSendReply(
    org: Organization,
    userId: string | undefined,
    opportunityId: string,
    body: BatchSendReplyDto
  ) {
    const { opp: opportunity, priorStatus } =
      await this._engageRepository.claimOpportunityForReply(
        org.id,
        opportunityId,
        'REPLIED',
        body.projectId
      );

    const now = new Date().toISOString();
    const createdPostIds: string[] = [];
    try {
      await this._assertReplyPacing(
        org.id,
        body.projectId,
        opportunity.platform,
        opportunity.matchedKeywords ?? [],
        body.items.map((item) => ({ integrationId: item.integrationId, at: new Date() }))
      );

      for (const item of body.items) {
        const created = await this._postsService.createPost(
          org.id,
          {
            type: 'now',
            source: 'engage',
            projectId: body.projectId,
            tags: [],
            shortLink: false,
            date: now,
            posts: [
              {
                integration: { id: item.integrationId },
                value: [
                  { content: item.draftContent, image: [], delay: 0, id: '' } as never,
                ],
                group: '',
                settings: {
                  __type: 'x',
                  reply_to_tweet_id: opportunity.externalPostId,
                  who_can_reply_post: 'everyone',
                } as never,
              } as never,
            ],
          },
          userId
        );
        const postId = created?.[0]?.postId;
        if (!postId) throw new Error('Post creation failed');
        createdPostIds.push(postId);
      }
    } catch (err) {
      for (const postId of createdPostIds) {
        await this._engageRepository.deletePostById(postId);
      }
      await this._engageRepository.releaseOpportunityClaim(
        org.id,
        opportunityId,
        priorStatus,
        body.projectId
      );
      throw err;
    }

    // Phase 2: all X replies are LIVE. Do NOT roll back. One tracking row per
    // post (per-post keying), isolated so one transient failure doesn't drop the
    // rest. Genuine failures are logged (the reply is live but untracked).
    const settled = await Promise.allSettled(
      body.items.map((item, i) =>
        this._engageRepository
          .createSentReply({
            organizationId: org.id,
            projectId: body.projectId,
            opportunityId,
            postId: createdPostIds[i],
            inputData: { strategy: item.strategy, brandStrength: item.brandStrength, mentions: item.mentions },
            matchedKeywords: opportunity.matchedKeywords,
          })
          .then(async (sentReply) => sentReply)
      )
    );
    const results: EngageSentReply[] = [];
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        results.push(r.value);
      } else {
        this.logger.error(
          `batchSendReply: X reply published (postId=${createdPostIds[i]}, opportunityId=${opportunityId}, ` +
          `orgId=${org.id}) but failed to record EngageSentReply.`,
          r.reason instanceof Error ? r.reason.stack : r.reason
        );
      }
    });
    if (results.length === 0) {
      throw new InternalServerErrorException(
        'All replies were published but no tracking records could be created. Contact support to reconcile.'
      );
    }
    return results;
  }

  async confirmManualReply(
    org: Organization,
    userId: string | undefined,
    opportunityId: string,
    body: ConfirmManualReplyDto
  ) {
    // No _assertReplyPacing gate here (unlike sendReply/scheduleReply/batch*):
    // the reply was already sent manually, outside Postiz, before this call —
    // blocking the CONFIRMATION doesn't undo an already-sent reply, it only
    // loses the tracking record. This call still counts toward future pacing
    // checks via the recorded EngageSentReply below.
    const { opp, priorStatus } =
      await this._engageRepository.claimOpportunityForReply(
        org.id,
        opportunityId,
        'REPLIED',
        body.projectId
      );

    // The reply URL is optional for both platforms now ("I've posted it — I'll
    // add the link later"). When omitted the reply is recorded with a null
    // releaseURL and the opportunity still moves to REPLIED; the user backfills
    // the link afterwards via PATCH /sent/:id/reply-url, which is when metrics
    // tracking can begin (X needs the tweet id from the URL). The posting
    // integration is also optional: when supplied, its OAuth token drives the
    // per-account metrics sync; when omitted, only the app-only bearer can read
    // public metrics later.
    let postId: string | undefined;
    try {
      // If the user supplied the link now, hold it to the same standard as the
      // backfill path: validate format. When omitted, skip the check entirely
      // ("I'll add the link later"). A failure here is caught below and releases
      // the claim, so the opportunity isn't stuck in REPLIED.
      if (body.replyUrl) {
        await this._validateReplyUrl(opp.platform, body.replyUrl);
      }
      // The reply author (handle + avatar) is recorded out of band after the
      // EngageSentReply exists — see _storeReplyAuthorInBackground below. Resolving
      // it here would make the user wait on 1–2 slow Reddit hops just to confirm a
      // reply, so the post is created without it and enriched asynchronously.
      const post =
        opp.platform === 'x'
          ? await this._engageRepository.createManualXPost({
              organizationId: org.id,
              content: body.draftContent,
              date: new Date(),
              replyUrl: body.replyUrl,
              integrationId: body.integrationId,
              projectId: body.projectId,
            })
          : await this._engageRepository.createManualRedditPost({
              organizationId: org.id,
              content: body.draftContent,
              date: new Date(),
              replyUrl: body.replyUrl,
              projectId: body.projectId,
            });
      postId = post.id;
    } catch (err) {
      await this._engageRepository.releaseOpportunityClaim(
        org.id,
        opportunityId,
        priorStatus,
        body.projectId
      );
      throw err;
    }

    // Engage shares the regular post quota. The manual reply path bypasses
    // PostsService.createPost, so we trigger the overage check here.
    // Fire-and-forget — billing failures must not break the user-visible flow.
    if (userId) {
      this._postOverageService
        .deductIfOverage(org.id, userId, postId, 'engage')
        .catch((err) => {
          this.logger.error(
            `confirmManualReply: deductIfOverage failed for postId=${postId}:`,
            err
          );
        });
    } else {
      this.logger.warn(
        `confirmManualReply: skipping deductIfOverage for postId=${postId} — no userId on request`
      );
    }

    try {
      const sentReply = await this._engageRepository.createSentReply({
        organizationId: org.id,
        projectId: body.projectId,
        opportunityId,
        postId,
        inputData: { strategy: body.strategy, brandStrength: body.brandStrength },
        matchedKeywords: opp.matchedKeywords,
      });
      // Now that the reply row exists, resolve + persist its author out of band.
      // Only when a URL was supplied — without one there's nothing to look up.
      if (body.replyUrl) {
        this._storeReplyAuthorInBackground(org.id, sentReply.id, opp.platform, body.replyUrl);
      }
      return sentReply;
    } catch (err) {
      this.logger.error(
        `confirmManualReply: manual reply recorded (postId=${postId}, ` +
        `opportunityId=${opportunityId}, orgId=${org.id}) but failed to record EngageSentReply.`,
        err instanceof Error ? err.stack : err
      );
      if (err instanceof HttpException) throw err;
      throw new InternalServerErrorException(
        'Reply was recorded but the tracking record could not be created. ' +
        'Contact support to reconcile.',
        { cause: err instanceof Error ? err : undefined }
      );
    }
  }

  // FORCE scan: bypass the per-unit cadence gate and scan all units now. For
  // explicit user actions (engage setup / enable) where an immediate first scan
  // is expected. Page visits use triggerDueScan (cadence-respecting) instead.
  async triggerImmediateScan(
    org: Organization,
    _keywordIds: string[] = []
  ): Promise<{ status: 'signaled' | 'started' | 'no_client' | 'error' }> {
    return this._signalScanExecutor(org, 'triggerScanNow', 'triggerImmediateScan');
  }

  // DUE scan (non-force): wake the executor to scan only units whose per-unit
  // cadence is due. The page-visit trigger uses this so a frequent visitor
  // mostly no-ops at the lease layer ("check first, scan only if due").
  async triggerDueScan(
    org: Organization
  ): Promise<{ status: 'signaled' | 'started' | 'no_client' | 'error' }> {
    return this._signalScanExecutor(org, 'triggerDueScan', 'triggerDueScan');
  }

  // Signal the global scan executor; start it first (idempotent) if it isn't
  // running yet, then signal. The executor is event-driven — no interval args.
  private async _signalScanExecutor(
    org: Organization,
    signalName: 'triggerScanNow' | 'triggerDueScan',
    logLabel: string
  ): Promise<{ status: 'signaled' | 'started' | 'no_client' | 'error' }> {
    const touchEnabled = !this._scanConfig || await this._scanConfig.isTouchEnabled().catch(() => true);
    if (!touchEnabled) {
      this.logger.log(`${logLabel}: backend scan disabled (engage_touch_switch=false) — skipping signal`);
      return { status: 'signaled' };
    }

    const client = this._temporalService.client?.getRawClient();
    if (!client) return { status: 'no_client' };

    try {
      await client.workflow.getHandle(EngageService.SCAN_WORKFLOW_ID).signal(signalName);
      return { status: 'signaled' };
    } catch {
      try {
        await client.workflow.start('engageScanTickerWorkflow', {
          workflowId: EngageService.SCAN_WORKFLOW_ID,
          taskQueue: 'main',
          args: [],
          workflowIdConflictPolicy: 'USE_EXISTING',
        });
        await client.workflow.getHandle(EngageService.SCAN_WORKFLOW_ID).signal(signalName);
        return { status: 'started' };
      } catch (startErr) {
        this.logger.error(
          `${logLabel}: failed to start/signal ${EngageService.SCAN_WORKFLOW_ID} (org=${org.id})`,
          startErr
        );
        return { status: 'error' };
      }
    }
  }

  // Per-org, in-memory debounce for the scan signal so rapid multi-tab visits
  // don't spam the ticker before it has had a chance to advance the cursors (the
  // cursor cadence is the durable gate; this only smooths the signal-to-run gap).
  private readonly _lastScanSignalAt = new Map<string, number>();

  private _shouldSignalScan(orgId: string, now: number): boolean {
    const last = this._lastScanSignalAt.get(orgId) ?? 0;
    if (now - last < engageRefreshFloorMs()) return false;
    this._lastScanSignalAt.set(orgId, now);
    return true;
  }

  /**
   * Page-visit trigger for the SCAN side only (keywords / tracked / channels).
   * The frontend fires this fire-and-forget on every Engage visit; it only
   * *requests* a scan — the per-unit cadence gate (`EngageScanCursor`) decides
   * whether the scan ticker actually claims any unit. Metrics are NOT handled
   * here: they refresh purely on demand via `refreshMetricsForPosts`, driven by
   * the exact post ids the client has on screen ("no views → no update").
   *
   * Returns `nextRefreshAt` — the soonest a future visit could run a scan —
   * which the client caches so it can skip the call until then. Due-ness is
   * gate-derived: a once-a-week visitor scans immediately on entry, a brand-new
   * org (cold start, no cursors) runs its first scan, and a frequent visitor
   * mostly no-ops — all from the SAME interval gate.
   */
  async refreshOnVisit(org: Organization): Promise<{
    status: 'accepted' | 'throttled';
    coldStart: boolean;
    nextRefreshAt: string;
  }> {
    const now = Date.now();
    const scanIntervalHours = await this._entitlementService.getScanIntervalHours(
      org.id
    );

    // ── Scan side: per-unit cadence gate (EngageScanCursor) ──────────────────
    const scanStatus = await this._engageRepository.getOrgScanStatus(
      org.id,
      scanIntervalHours
    );
    // No cursors yet → never scanned → empty feed. The visit kicks the first scan.
    const coldStart = scanStatus.lastScanAt == null;
    const scanNextMs = scanStatus.nextScanAt
      ? scanStatus.nextScanAt.getTime()
      : now;
    const scanDue = scanNextMs <= now;

    // ── Kick (fire-and-forget) — never block the page ────────────────────────
    // Non-force: the executor scans only units whose per-unit cadence is due, so
    // a frequent visitor mostly no-ops at the lease layer (no wasted API calls).
    if (scanDue && this._shouldSignalScan(org.id, now)) {
      this.triggerDueScan(org).catch((err) =>
        this.logger.warn(
          `refreshOnVisit: scan trigger failed (org=${org.id}): ${
            (err as Error)?.message ?? err
          }`
        )
      );
    }

    const nextRefreshMs = Math.max(scanNextMs, now + engageRefreshFloorMs());
    return {
      status: scanDue ? 'accepted' : 'throttled',
      coldStart,
      nextRefreshAt: new Date(nextRefreshMs).toISOString(),
    };
  }

  /**
   * Event-driven metrics refresh for the posts the client is currently viewing
   * on /engage/sent. The client sends the post ids on screen (any sort / filter
   * / page — the server never guesses the set), and the server refreshes only
   * those that are PUBLISHED, inside the monitoring window, and past their
   * per-plan metrics interval (`lastMetricsFetchAt` gate). The gate is stamped
   * optimistically BEFORE the async fetch so repeat requests within the interval
   * no-op. The real X/Reddit fetch runs fire-and-forget — this returns
   * immediately with the sentReplyIds whose fetch was kicked (`accepted`, poll
   * `/sent/:id/status`) vs skipped (`throttled`). This is the ONLY metrics path
   * when periodic refresh is disabled (the default).
   */
  async refreshMetricsForPosts(
    org: Organization,
    postIds: string[]
  ): Promise<{
    accepted: string[];
    throttled: string[];
    nextRefreshAt: string;
  }> {
    const now = Date.now();
    const capped = postIds.slice(0, REFRESH_METRICS_MAX_POSTS);
    if (capped.length === 0) {
      return {
        accepted: [],
        throttled: [],
        nextRefreshAt: new Date(now + engageRefreshFloorMs()).toISOString(),
      };
    }

    const [metricsWindowDays, metricsIntervalHours] = await Promise.all([
      this._entitlementService.getMetricsWindowDays(org.id),
      this._entitlementService.getMetricsFetchIntervalHours(org.id),
    ]);
    const windowStartMs = now - metricsWindowDays * 86_400_000;
    const intervalMs = metricsIntervalHours * 3_600_000;

    const rows = await this._engageRepository.findEngageRepliesByPostIds(
      org.id,
      capped
    );

    const dueRows: typeof rows = [];
    const duePostIds: string[] = [];
    const throttled: string[] = [];
    let metricsNextMs: number | null = null;
    for (const row of rows) {
      const post = row.post;
      // Out of the monitoring window → never refreshed on demand.
      if (!post?.publishDate || post.publishDate.getTime() < windowStartMs) {
        throttled.push(row.id);
        continue;
      }
      const lastMs = post.lastMetricsFetchAt
        ? post.lastMetricsFetchAt.getTime()
        : null;
      const isDue = lastMs == null || lastMs < now - intervalMs;
      // Due rows are about to be stamped now → their next-due is now + interval.
      const nextMs = isDue ? now + intervalMs : (lastMs as number) + intervalMs;
      metricsNextMs =
        metricsNextMs == null ? nextMs : Math.min(metricsNextMs, nextMs);
      if (isDue) {
        dueRows.push(row);
        duePostIds.push(post.id);
      } else {
        throttled.push(row.id);
      }
    }

    if (duePostIds.length > 0) {
      // Stamp BEFORE the async fetch so a repeat request within the interval
      // no-ops while the fire-and-forget sync is still running.
      await this._postsService
        .markMetricsFetched(org.id, duePostIds)
        .catch(() => undefined);
      this._runMetricsSyncForReplies(dueRows).catch((err) =>
        this.logger.warn(
          `refreshMetricsForPosts: sync failed (org=${org.id}): ${
            (err as Error)?.message ?? err
          }`
        )
      );
    }

    const nextRefreshMs = Math.max(
      metricsNextMs == null ? now : metricsNextMs,
      now + engageRefreshFloorMs()
    );
    return {
      accepted: dueRows.map((r) => r.id),
      throttled,
      nextRefreshAt: new Date(nextRefreshMs).toISOString(),
    };
  }

  /**
   * Persist metrics for ONE published reply that the browser extension scraped
   * from the reply's own page (X TweetDetail / Reddit comment .json) and handed
   * back to the page. Unlike refreshMetricsForPosts (server pulls via OAuth /
   * public APIs), here the EXTENSION is the fetcher and the server only normalises
   * + stores — but the persisted shape is identical, so the list/dashboard read
   * it back exactly the same way. Returns the canonical normalized metrics so the
   * page can update the card in place without re-fetching the list.
   */
  async ingestReplyMetrics(
    org: Organization,
    sentReplyId: string,
    raw: RawReplyMetrics
  ) {
    const ctx = await this._engageRepository.getSentReplyContext(
      org.id,
      sentReplyId
    );
    if (!ctx) throw new NotFoundException('Sent reply not found');
    if (ctx.platform !== 'x' && ctx.platform !== 'reddit') {
      throw new BadRequestException(
        'Metrics ingest is only valid for X or Reddit replies'
      );
    }
    if (raw.platform !== ctx.platform) {
      throw new BadRequestException('Metrics platform mismatch for this reply');
    }
    // The reply must be a live, linked post; otherwise there is nothing whose
    // metrics these counters describe (a DRAFT/ERROR/no-URL reply was never sent).
    if (ctx.state !== 'PUBLISHED' || !ctx.releaseURL) {
      throw new BadRequestException(
        'This reply has no published post to attach metrics to'
      );
    }

    const built = buildReplyMetricsFromRaw({ ...raw, platform: ctx.platform });
    await this._engageRepository.updatePostMetrics(
      ctx.postId,
      built.impressions,
      built.analytics,
      built.trafficScore
    );
    // Stamp lastMetricsFetchAt so the demand-driven server pull treats this as
    // freshly synced and won't immediately re-fetch over the extension's data.
    // Only report the stamp to the caller if it actually persisted — otherwise
    // the client would believe the interval gate advanced when it did not and
    // suppress a needed re-fetch.
    const stampedAt = new Date();
    const stampOk = await this._postsService
      .markMetricsFetched(org.id, [ctx.postId], stampedAt)
      .then(() => true)
      .catch(() => false);

    const metrics = normalizeReplyMetrics(
      ctx.platform,
      built.analytics,
      built.impressions,
      built.trafficScore
    );
    return {
      id: sentReplyId,
      postId: ctx.postId,
      impressions: built.impressions,
      trafficScore: built.trafficScore,
      metrics,
      lastMetricsFetchAt: stampOk ? stampedAt : null,
    };
  }

  /**
   * Real, in-process X/Reddit metrics fetch for a set of replies — the event-
   * driven executor (replaces the never-registered `engageMetricsSyncWorkflow`).
   * Runs serially to bound external API concurrency (X tier-rate risk). Each
   * reply's failure is isolated; the gate was already stamped by the caller, so
   * a failure just leaves that value stale until the next visit past the interval.
   */
  private async _runMetricsSyncForReplies(
    rows: Awaited<
      ReturnType<EngageRepository['findEngageRepliesByPostIds']>
    >
  ): Promise<void> {
    const deps = this._metricsSyncDeps();
    for (const row of rows) {
      try {
        await runWithBizUsage(
          {
            organizationId: row.organizationId,
            bizCategory: BIZ_USAGE.ENGAGE_METRICS,
          },
          () => dispatchReplyMetricsSync(row, deps)
        );
      } catch (err) {
        this.logger.warn(
          `_runMetricsSyncForReplies: failed for sentReplyId=${row.id}: ${
            (err as Error).message
          }`
        );
      }
    }
  }

  async resyncEngageMetrics(opts: {
    orgId?: string;
    platform?: string;
    dryRun?: boolean;
    /**
     * When set, re-fetch EVERY published engage reply from the last `sinceDays`
     * days regardless of whether impressions are already set (full re-poll,
     * same selection the daily Temporal job uses). When omitted, keep the
     * legacy "fill missing" behaviour (only `impressions: null` rows).
     */
    sinceDays?: number;
  } = {}): Promise<{
    found: number;
    updated: number;
    written: number;
    empty: number;
    unreachable: number;
    skipped: number;
    errors: number;
  }> {
    const { orgId, platform, dryRun = false, sinceDays } = opts;
    const pending =
      sinceDays != null
        ? await this._engageRepository.findEngageRepliesInWindow(sinceDays, orgId, platform)
        : await this._engageRepository.findPendingEngageMetrics(orgId, platform);
    // Count REAL outcomes from the shared sync, not attempts — so the caller can
    // tell "fetched & written" apart from "API returned nothing / WAF blocked".
    const tally = { written: 0, empty: 0, unreachable: 0, skipped: 0, errors: 0 };

    for (const reply of pending) {
      if (dryRun) continue;
      try {
        const outcome = await runWithBizUsage(
          {
            organizationId: reply.organizationId,
            bizCategory: BIZ_USAGE.ENGAGE_METRICS,
          },
          () => dispatchReplyMetricsSync(reply, this._metricsSyncDeps())
        );
        tally[outcome]++;
      } catch (err) {
        this.logger.warn(`resyncEngageMetrics: failed for sentReplyId=${reply.id}: ${(err as Error).message}`);
        tally.errors++;
      }
    }

    // `updated` retains its name but now means rows that actually got metrics.
    return { found: pending.length, updated: tally.written, ...tally };
  }

  /**
   * Admin "manual wake-up": backfill missing X integrations, then resync metrics
   * for every PUBLISHED engage reply whose impressions are still null, returning
   * a before/after per-platform stats summary. This is the request-time twin of
   * scripts/engage-sync-metrics.ts. The resync uses the exact shared logic of the
   * 24h Temporal sync, so the only new behaviour over /admin/resync-metrics is
   * the integration backfill (so X replies can actually be read) plus the stats.
   */
  async syncEngageMetricsWithStats(
    org: Organization,
    opts: { platform?: string; dryRun?: boolean; backfill?: boolean } = {}
  ) {
    const { platform, dryRun = false, backfill = true } = opts;

    const before = await this._engageRepository.getEngageMetricsStats(org.id, platform);

    // Backfill only matters for X — Reddit metrics never need an integration.
    const backfillResult =
      backfill && platform !== 'reddit'
        ? await this._engageRepository.backfillXReplyIntegrations(org.id, dryRun)
        : { found: 0, filled: 0, unresolved: 0, items: [] as Array<unknown> };

    const resync = await this.resyncEngageMetrics({ orgId: org.id, platform, dryRun });

    const after = await this._engageRepository.getEngageMetricsStats(org.id, platform);

    return { dryRun, backfill: backfillResult, resync, stats: { before, after } };
  }

  /** Sinks for the shared engage-metrics-sync module (see engage-metrics-sync.ts). */
  private _metricsSyncDeps(): MetricsSyncDeps {
    return {
      updatePostMetrics: (postId, impressions, analytics, trafficScore) =>
        this._engageRepository.updatePostMetrics(postId, impressions, analytics, trafficScore),
      markAuthorReplied: (sentReplyId) => this._engageRepository.markAuthorReplied(sentReplyId),
      // Shared engage X analytics read with the own-token → app-only fallback
      // chain (PostsService is the single source of truth; the scheduled Temporal
      // activity uses the same method so both behave identically).
      checkPostAnalytics: (orgId, postId, when) =>
        this._postsService.checkEngageXAnalyticsWithFallback(orgId, postId, when),
      warn: (m) => this.logger.warn(m),
      log: (m) => this.logger.log(m),
    };
  }



}
