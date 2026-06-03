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
import { EngageRepository } from '@gitroom/nestjs-libraries/engage/engage.repository';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import { PostOverageService } from '@gitroom/nestjs-libraries/database/prisma/posts/post-overage.service';
import {
  AddKeywordDto,
  AddKeywordsBulkDto,
  AddMonitoredChannelDto,
  AddTrackedAccountDto,
  ConfirmManualReplyDto,
  ListOpportunitiesDto,
  ListSentDto,
  SaveEngageConfigDto,
  SetupEngageDto,
  BatchScheduleReplyDto,
  BatchSendReplyDto,
  ScheduleReplyDto,
  ScoreStatsDto,
  SendReplyDto,
  UpdateKeywordDto,
  UpdateMonitoredChannelDto,
  UpdateReplyAccountDto,
  UpdateTrackedAccountDto,
  UpdateScheduledReplyDto,
} from '@gitroom/nestjs-libraries/engage/dtos/engage.dto';
import { getRedditToken, redditAuthHeaders } from '@gitroom/nestjs-libraries/engage/reddit-auth';
import { redditPublicGet } from '@gitroom/nestjs-libraries/engage/reddit-loid';
import {
  syncRedditMetrics,
  syncXMetrics,
  type MetricsSyncDeps,
} from '@gitroom/nestjs-libraries/engage/engage-metrics-sync';
import { checkRedditCommentAccessible } from '@gitroom/nestjs-libraries/engage/reddit-comment';
import { checkXTweetAccessible } from '@gitroom/nestjs-libraries/engage/x-tweet';

// Anchored at $ to reject trailing query strings / fragments that would otherwise
// pollute the stored releaseURL (e.g. `?utm_source=...`). Matches spec §12.4.
const REDDIT_COMMENT_URL_RE =
  /^https?:\/\/(www\.)?reddit\.com\/r\/[^/]+\/comments\/[^/]+\/[^/]+\/[a-z0-9]+\/?$/i;

// An X reply permalink: x.com / twitter.com /<handle>/status/<snowflake>. A
// trailing query (e.g. ?s=20) is tolerated — syncXMetrics parses the id out.
const X_REPLY_URL_RE =
  /^https?:\/\/(www\.|mobile\.)?(x|twitter)\.com\/[^/]+\/status\/\d+/i;

@Injectable()
export class EngageService implements OnApplicationBootstrap {
  private readonly logger = new Logger(EngageService.name);

  constructor(
    private _engageRepository: EngageRepository,
    private _temporalService: TemporalService,
    private _postsService: PostsService,
    private _postOverageService: PostOverageService
  ) { }

  // Auto-start global workflows on every app boot so pnpm dev / Docker restart
  // never leaves the system in a state where no workflow is running.
  async onApplicationBootstrap() {
    await this._ensureGlobalWorkflowsRunning();
  }

  // ─── Config ───────────────────────────────────────────────────────────────

  async getConfig(org: Organization) {
    const [config, scanStatus] = await Promise.all([
      this._engageRepository.getOrCreateConfig(org.id),
      this._engageRepository.getOrgScanStatus(org.id),
    ]);
    return {
      ...config,
      scanIntervals: {
        keywordHours: Number(process.env.ENGAGE_KEYWORD_SCAN_INTERVAL_HOURS ?? 24),
        channelHours: Number(process.env.ENGAGE_CHANNEL_SCAN_INTERVAL_HOURS ?? 3),
        trackedHours: Number(process.env.ENGAGE_TRACKED_SCAN_INTERVAL_HOURS ?? 3),
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
    const config = await this._engageRepository.getOrCreateConfig(org.id);
    return this._engageRepository.addKeyword(config.id, org.id, dto);
  }

  async addKeywordsBulk(org: Organization, dto: AddKeywordsBulkDto) {
    const config = await this._engageRepository.getOrCreateConfig(org.id);
    return this._engageRepository.addKeywordsBulk(config.id, org.id, dto);
  }

  async updateKeyword(org: Organization, id: string, dto: UpdateKeywordDto) {
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
    const config = await this._engageRepository.getOrCreateConfig(org.id);
    return this._engageRepository.addTrackedAccount(config.id, org.id, dto);
  }

  async updateTrackedAccount(
    org: Organization,
    id: string,
    dto: UpdateTrackedAccountDto
  ) {
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

  // ─── Sent Replies ─────────────────────────────────────────────────────────

  async listSentReplies(org: Organization, dto: ListSentDto) {
    return this._engageRepository.listSentReplies(org.id, dto);
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

  async getDashboardRepliesTrend(org: Organization, days?: number) {
    return this._engageRepository.getDashboardRepliesTrend(org.id, days);
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
    url: string
  ) {
    // Validate the URL against the reply's own platform, then confirm it is real
    // and reachable before persisting, so an invalid or mistyped link never
    // becomes the stored releaseURL (which metrics sync and the UI both rely
    // on). Strict: an unverifiable result is also rejected.
    const platform = await this._engageRepository.getSentReplyPlatform(org.id, sentReplyId);
    if (platform === 'reddit') {
      if (!REDDIT_COMMENT_URL_RE.test(url)) {
        throw new BadRequestException(
          'Invalid Reddit comment URL. Expected: https://www.reddit.com/r/.../comments/.../comment/...'
        );
      }
      this._assertReplyUrlVerified(
        await checkRedditCommentAccessible(url, (m) => this.logger.warn(m)),
        'Reddit comment'
      );
    } else if (platform === 'x') {
      if (!X_REPLY_URL_RE.test(url)) {
        throw new BadRequestException(
          'Invalid X reply URL. Expected: https://x.com/.../status/...'
        );
      }
      this._assertReplyUrlVerified(
        await checkXTweetAccessible(url, (m) => this.logger.warn(m)),
        'X reply'
      );
    } else {
      throw new BadRequestException(
        'Reply-URL backfill is only valid for X or Reddit manual replies'
      );
    }
    return this._engageRepository.updateReplyUrl(org.id, sentReplyId, url);
  }

  /** Strict gate shared by the Reddit/X backfill paths: reject not_found AND unverifiable. */
  private _assertReplyUrlVerified(
    check: { status: 'exists' | 'not_found' | 'unverifiable'; reason?: string },
    label: string
  ): void {
    if (check.status === 'not_found') {
      throw new BadRequestException(
        `That ${label} could not be found — check the URL points to a real, public ${label.toLowerCase()}.`
      );
    }
    if (check.status === 'unverifiable') {
      throw new BadRequestException(
        `Could not verify the ${label} right now (${check.reason}). Please try again shortly.`
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

    const tickMinutes = Number(process.env.ENGAGE_SCAN_TICK_MINUTES ?? 5);
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

    const tickMinutes = Number(process.env.ENGAGE_SCAN_TICK_MINUTES ?? 5);

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
  } = {}): Promise<{ found: number; updated: number; errors: number }> {
    const { orgId, platform, dryRun = false } = opts;
    const pending = await this._engageRepository.findPendingEngageMetrics(orgId, platform);
    let updated = 0;
    let errors = 0;

    for (const reply of pending) {
      if (dryRun) continue;
      try {
        const p = reply.opportunity.platform;
        if (p === 'reddit' && reply.post?.releaseURL) {
          await syncRedditMetrics(reply.post.id, reply.post.releaseURL, reply.id, reply.opportunity.authorUsername ?? '', this._metricsSyncDeps());
          updated++;
        } else if (p === 'x' && reply.post?.releaseURL) {
          await syncXMetrics({
            orgId: reply.organizationId,
            sentReplyId: reply.id,
            postDbId: reply.post.id,
            replyTweetUrl: reply.post.releaseURL,
            originalTweetId: reply.opportunity.externalPostId ?? '',
            authorUsername: reply.opportunity.authorUsername ?? '',
            hasIntegration: !!reply.post.integrationId,
          }, this._metricsSyncDeps());
          updated++;
        }
      } catch (err) {
        this.logger.warn(`resyncEngageMetrics: failed for sentReplyId=${reply.id}: ${(err as Error).message}`);
        errors++;
      }
    }

    return { found: pending.length, updated, errors };
  }

  /** Sinks for the shared engage-metrics-sync module (see engage-metrics-sync.ts). */
  private _metricsSyncDeps(): MetricsSyncDeps {
    return {
      updatePostMetrics: (postId, impressions, analytics, trafficScore) =>
        this._engageRepository.updatePostMetrics(postId, impressions, analytics, trafficScore),
      markAuthorReplied: (sentReplyId) => this._engageRepository.markAuthorReplied(sentReplyId),
      checkPostAnalytics: (orgId, postId, when) =>
        this._postsService.checkPostAnalytics(orgId, postId, when),
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
