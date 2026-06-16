import {
  BadRequestException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { EngageSentReply, Organization } from '@prisma/client';
import { TemporalService } from 'nestjs-temporal-core';
import {
  EngageRepository,
  GenerationHistoryEntry,
} from '@gitroom/nestjs-libraries/engage/engage.repository';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import { PostOverageService } from '@gitroom/nestjs-libraries/database/prisma/posts/post-overage.service';
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
  syncRedditMetrics,
  syncXMetrics,
  type MetricsSyncDeps,
  type MetricsSyncOutcome,
} from '@gitroom/nestjs-libraries/engage/engage-metrics-sync';

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
const DEFAULT_SCAN_TICK_MINUTES = 5;

function engageScanTickMinutes(): number {
  const value = Number(
    process.env.ENGAGE_SCAN_TICK_MINUTES ?? DEFAULT_SCAN_TICK_MINUTES
  );
  return Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_SCAN_TICK_MINUTES;
}

@Injectable()
export class EngageService implements OnApplicationBootstrap {
  private readonly logger = new Logger(EngageService.name);

  constructor(
    private _engageRepository: EngageRepository,
    private _temporalService: TemporalService,
    private _postsService: PostsService,
    private _postOverageService: PostOverageService,
    private _entitlementService: EngageEntitlementService
  ) { }

  // Auto-start global workflows on every app boot so pnpm dev / Docker restart
  // never leaves the system in a state where no workflow is running.
  async onApplicationBootstrap() {
    await this._ensureGlobalWorkflowsRunning();
  }

  // ─── Config ───────────────────────────────────────────────────────────────

  async getConfig(org: Organization) {
    const entitlement = await this._entitlementService.getEntitlementSummary(org.id);
    const scanIntervalHours = entitlement.limits.scanIntervalHours;
    const [config, scanStatus] = await Promise.all([
      this._engageRepository.getOrCreateConfig(org.id),
      this._engageRepository.getOrgScanStatus(org.id, scanIntervalHours),
    ]);
    return {
      ...config,
      // Plan limits + current usage + reply pricing, so the frontend can disable
      // entrypoints and show usage. Backend asserts remain the source of truth.
      entitlement,
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
    };
  }

  async saveConfig(org: Organization, dto: SaveEngageConfigDto) {
    const result = await this._engageRepository.saveConfig(org.id, {
      ...(dto.enabled !== undefined && { enabled: dto.enabled }),
    });
    if (dto.enabled) {
      await this._ensureGlobalWorkflowsRunning();
      this.triggerImmediateScan(org).catch((err) =>
        this.logger.warn(`Immediate scan trigger failed for org ${org.id}:`, err)
      );
    }
    return result;
  }

  async setupEngage(org: Organization, dto: SetupEngageDto) {
    const result = await this._engageRepository.setupEngage(org.id, dto);
    await this._ensureGlobalWorkflowsRunning();
    this.triggerImmediateScan(org).catch((err) =>
      this.logger.warn(`Immediate scan trigger failed for org ${org.id}:`, err)
    );
    return result;
  }

  async resetConfig(org: Organization) {
    return this._engageRepository.resetConfig(org.id);
  }

  // ─── Keywords ─────────────────────────────────────────────────────────────

  async addKeyword(org: Organization, dto: AddKeywordDto) {
    await this._entitlementService.assertCanActivate(org.id, 'keyword', 1);
    const config = await this._engageRepository.getOrCreateConfig(org.id);
    return this._engageRepository.addKeyword(config.id, org.id, dto);
  }

  async addKeywordsBulk(org: Organization, dto: AddKeywordsBulkDto) {
    await this._entitlementService.assertCanActivate(
      org.id,
      'keyword',
      dto.keywords.length
    );
    const config = await this._engageRepository.getOrCreateConfig(org.id);
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

  async listMonitoredChannels(org: Organization) {
    return this._engageRepository.listMonitoredChannels(org.id);
  }

  async addMonitoredChannel(org: Organization, dto: AddMonitoredChannelDto) {
    await this._entitlementService.assertCanActivate(org.id, 'subreddit', 1);
    const config = await this._engageRepository.getOrCreateConfig(org.id);
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

  async listTrackedAccounts(org: Organization) {
    return this._engageRepository.listTrackedAccounts(org.id);
  }

  async addTrackedAccount(org: Organization, dto: AddTrackedAccountDto) {
    await this._entitlementService.assertCanActivate(org.id, 'tracked', 1);
    const config = await this._engageRepository.getOrCreateConfig(org.id);
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

  async listReplyAccounts(org: Organization) {
    return this._engageRepository.listXIntegrationsWithReplySettings(org.id);
  }

  async updateReplyAccountSettings(
    org: Organization,
    integrationId: string,
    dto: UpdateReplyAccountDto
  ) {
    return this._engageRepository.updateReplyAccount(
      org.id,
      integrationId,
      dto
    );
  }

  // ─── Opportunities ────────────────────────────────────────────────────────

  async listOpportunities(org: Organization, dto: ListOpportunitiesDto) {
    return this._engageRepository.listOpportunities(org.id, dto);
  }

  async dismissOpportunity(org: Organization, id: string) {
    return this._engageRepository.dismissOpportunity(org.id, id);
  }

  async toggleBookmark(org: Organization, id: string) {
    return this._engageRepository.toggleBookmark(org.id, id);
  }

  async getScoreStats(org: Organization, dto: ScoreStatsDto) {
    return this._engageRepository.getScoreStats(org.id, dto.date, dto.platform);
  }

  async getOpportunityById(org: Organization, id: string) {
    return this._engageRepository.getOpportunityById(org.id, id);
  }

  async getOpportunityDetail(org: Organization, id: string) {
    return this._engageRepository.getOpportunityDetail(org.id, id);
  }

  async getOpportunityForReply(org: Organization, id: string) {
    return this._engageRepository.getOpportunityForReply(org.id, id);
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
      opportunityId
    );
    const saved = await this._engageRepository.upsertDraft(org.id, opportunityId, {
      platform: opportunity.platform,
      content: dto.draftContent,
      inputData: {
        strategy: dto.strategy,
        brandStrength: dto.brandStrength,
        mentions: dto.mentions,
      },
    });

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
      })
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
    entry: GenerationHistoryEntry
  ): Promise<void> {
    await this._engageRepository.appendGenerationHistory(
      org.id,
      opportunityId,
      entry
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
    dto: { date?: string; platform?: string; status?: string } = {}
  ) {
    return this._engageRepository.getSentStats(org.id, dto);
  }

  // ─── Dashboard ────────────────────────────────────────────────────────────

  async getDashboardSummary(
    org: Organization,
    opts: { platform?: string; date?: string } = {}
  ) {
    return this._engageRepository.getDashboardSummary(org.id, opts);
  }

  async getDashboardRepliesTrend(
    org: Organization,
    period?: 'daily' | 'weekly' | 'monthly'
  ) {
    return this._engageRepository.getDashboardRepliesTrend(org.id, period);
  }

  async getDashboardTraffics(
    org: Organization,
    opts: { platform?: string; limit?: number }
  ) {
    return this._engageRepository.getDashboardTraffics(org.id, opts);
  }

  async getDashboardImpressions(
    org: Organization,
    period: 'daily' | 'weekly' | 'monthly' = 'daily'
  ) {
    return this._engageRepository.getDashboardImpressions(org.id, period);
  }

  async getDashboardTopSources(
    org: Organization,
    opts: { platform?: string; limit?: number }
  ) {
    return this._engageRepository.getDashboardTopSources(org.id, opts);
  }

  async submitManualReplyUrl(
    org: Organization,
    sentReplyId: string,
    url: string,
    author?: EngageAuthorProfile
  ) {
    // The backfill URL is mandatory here, so always validate format + reachability.
    const platform = await this._engageRepository.getSentReplyPlatform(org.id, sentReplyId);
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
    void (async () => {
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
    })().catch((err) =>
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

  // Workflow ids of the retired per-type scan workflows. Terminated on boot so
  // upgrading deployments don't leave them looping into a now-missing workflow
  // type (their continueAsNew would otherwise fail repeatedly).
  private static readonly LEGACY_SCAN_WORKFLOW_IDS = [
    'engage-keyword-global',
    'engage-channel-global',
    'engage-tracked-global',
  ];

  // Ensures the single engage scan ticker is running. The per-type cadence
  // (keyword 24h / channel 3h / tracked 3h env vars) is enforced inside the
  // activity; this workflow just ticks. USE_EXISTING makes it idempotent.
  //   ENGAGE_SCAN_TICK_MINUTES  (default 5)
  private async _ensureGlobalWorkflowsRunning(): Promise<void> {
    const client = this._temporalService.client?.getRawClient();
    if (!client) return;

    // Best-effort cleanup of the retired fixed-interval workflows.
    for (const id of EngageService.LEGACY_SCAN_WORKFLOW_IDS) {
      try {
        await client.workflow?.getHandle(id).terminate('superseded by engage-scan-ticker');
      } catch {
        // Not running / already gone — ignore.
      }
    }

    const tickMinutes = engageScanTickMinutes();
    try {
      await client.workflow?.start('engageScanTickerWorkflow', {
        workflowId: 'engage-scan-ticker',
        taskQueue: 'main',
        args: [tickMinutes],
        workflowIdConflictPolicy: 'USE_EXISTING',
      });
    } catch (err) {
      this.logger.error('Failed to start engageScanTickerWorkflow:', err);
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
        'REPLIED'
      );

    // Phase 1 — invoke the post pipeline. type='now' BLOCKS until X publish
    // completes; a failure means the reply never reached X. Full rollback safe.
    let postId: string | undefined;
    try {
      const created = await this._postsService.createPost(
        org.id,
        {
          type: 'now',
          source: 'engage',
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
        priorStatus
      );
      throw err;
    }

    // Phase 2 — the X reply IS LIVE on twitter.com. Do NOT roll back.
    try {
      const sentReply = await this._engageRepository.createSentReply({
        organizationId: org.id,
        opportunityId,
        postId,
        inputData: { strategy: body.strategy, brandStrength: body.brandStrength, mentions: body.mentions },
      });
      // 24h metrics sync — best-effort; the inner method swallows + logs.
      await this.startMetricsSyncForReply(sentReply.id);
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
      await this._engageRepository.resetScheduledOpportunity(org.id, opportunityId);
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
        'SCHEDULED'
      );

    // Scheduled posts publish at a future time — full rollback on failure is safe.
    let postId: string | undefined;
    try {
      const created = await this._postsService.createPost(
        org.id,
        {
          type: 'schedule',
          source: 'engage',
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
        opportunityId,
        postId,
        inputData: { strategy: body.strategy, brandStrength: body.brandStrength, mentions: body.mentions },
      });
      // metrics sync is started after the scheduled post actually publishes
      // (the post workflow triggers it via engage-metrics-sync-on-publish).
    } catch (err) {
      if (postId) await this._engageRepository.deletePostById(postId);
      await this._engageRepository.releaseOpportunityClaim(
        org.id,
        opportunityId,
        priorStatus
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
        'SCHEDULED'
      );

    const createdPostIds: string[] = [];
    try {
      for (const item of body.items) {
        const created = await this._postsService.createPost(
          org.id,
          {
            type: 'schedule',
            source: 'engage',
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
      await this._engageRepository.releaseOpportunityClaim(org.id, opportunityId, priorStatus);
      throw err;
    }

    // Phase 2: one tracking row per scheduled post. Tracking is keyed per-post,
    // so the items are independent — isolate failures (a transient DB error on
    // one must not drop the others) and surface genuine failures via the log.
    const settled = await Promise.allSettled(
      body.items.map((item, i) =>
        this._engageRepository.createSentReply({
          organizationId: org.id,
          opportunityId,
          postId: createdPostIds[i],
          inputData: { strategy: item.strategy, brandStrength: item.brandStrength, mentions: item.mentions },
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
        'REPLIED'
      );

    const now = new Date().toISOString();
    const createdPostIds: string[] = [];
    try {
      for (const item of body.items) {
        const created = await this._postsService.createPost(
          org.id,
          {
            type: 'now',
            source: 'engage',
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
      await this._engageRepository.releaseOpportunityClaim(org.id, opportunityId, priorStatus);
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
            opportunityId,
            postId: createdPostIds[i],
            inputData: { strategy: item.strategy, brandStrength: item.brandStrength, mentions: item.mentions },
          })
          .then(async (sentReply) => {
            await this.startMetricsSyncForReply(sentReply.id);
            return sentReply;
          })
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
    const { opp, priorStatus } =
      await this._engageRepository.claimOpportunityForReply(
        org.id,
        opportunityId,
        'REPLIED'
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
            })
          : await this._engageRepository.createManualRedditPost({
              organizationId: org.id,
              content: body.draftContent,
              date: new Date(),
              replyUrl: body.replyUrl,
            });
      postId = post.id;
    } catch (err) {
      await this._engageRepository.releaseOpportunityClaim(
        org.id,
        opportunityId,
        priorStatus
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
        opportunityId,
        postId,
        inputData: { strategy: body.strategy, brandStrength: body.brandStrength },
      });
      // Now that the reply row exists, resolve + persist its author out of band.
      // Only when a URL was supplied — without one there's nothing to look up.
      if (body.replyUrl) {
        this._storeReplyAuthorInBackground(org.id, sentReply.id, opp.platform, body.replyUrl);
      }
      await this.startMetricsSyncForReply(sentReply.id);
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

  async triggerImmediateScan(
    org: Organization,
    _keywordIds: string[] = []
  ): Promise<{ status: 'signaled' | 'started' | 'no_client' | 'error' }> {
    const client = this._temporalService.client?.getRawClient();
    if (!client) return { status: 'no_client' };

    const tickMinutes = engageScanTickMinutes();

    // Signal the ticker to force an immediate scan of all units; if it isn't
    // running yet, start it (which itself runs within one tick) and signal.
    try {
      await client.workflow.getHandle('engage-scan-ticker').signal('triggerScanNow');
      return { status: 'signaled' };
    } catch {
      try {
        await client.workflow.start('engageScanTickerWorkflow', {
          workflowId: 'engage-scan-ticker',
          taskQueue: 'main',
          args: [tickMinutes],
          workflowIdConflictPolicy: 'USE_EXISTING',
        });
        await client.workflow.getHandle('engage-scan-ticker').signal('triggerScanNow');
        return { status: 'started' };
      } catch (startErr) {
        this.logger.error(
          `triggerImmediateScan: failed to start/signal engage-scan-ticker (org=${org.id})`,
          startErr
        );
        return { status: 'error' };
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
        const p = reply.opportunity.platform;
        let outcome: MetricsSyncOutcome = 'skipped';
        if (p === 'reddit' && reply.post?.releaseURL) {
          outcome = await syncRedditMetrics(reply.post.id, reply.post.releaseURL, reply.id, reply.opportunity.authorUsername ?? '', this._metricsSyncDeps());
        } else if (p === 'x' && reply.post?.releaseURL) {
          outcome = await syncXMetrics({
            orgId: reply.organizationId,
            sentReplyId: reply.id,
            postDbId: reply.post.id,
            replyTweetUrl: reply.post.releaseURL,
            originalTweetId: reply.opportunity.externalPostId ?? '',
            authorUsername: reply.opportunity.authorUsername ?? '',
          }, this._metricsSyncDeps());
        }
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

  // Called by engage.controller after creating an EngageSentReply to start 24h metrics sync.
  async startMetricsSyncForReply(sentReplyId: string): Promise<void> {
    const client = this._temporalService.client?.getRawClient();
    if (!client) return;
    try {
      await client.workflow?.start('engageMetricsSyncWorkflow', {
        workflowId: `engage-metrics-${sentReplyId}`,
        taskQueue: 'main',
        args: [sentReplyId],
        workflowIdConflictPolicy: 'USE_EXISTING',
      });
    } catch (err) {
      this.logger.warn(`Failed to start engageMetricsSyncWorkflow for reply ${sentReplyId}:`, err);
    }
  }
}
