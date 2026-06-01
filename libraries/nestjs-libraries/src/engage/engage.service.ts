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

// Anchored at $ to reject trailing query strings / fragments that would otherwise
// pollute the stored releaseURL (e.g. `?utm_source=...`). Matches spec §12.4.
const REDDIT_COMMENT_URL_RE =
  /^https?:\/\/(www\.)?reddit\.com\/r\/[^/]+\/comments\/[^/]+\/[^/]+\/[a-z0-9]+\/?$/i;

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
    const config = await this._engageRepository.getOrCreateConfig(org.id);
    return {
      ...config,
      scanIntervals: {
        keywordHours: Number(process.env.ENGAGE_KEYWORD_SCAN_INTERVAL_HOURS ?? 24),
        channelHours: Number(process.env.ENGAGE_CHANNEL_SCAN_INTERVAL_HOURS ?? 3),
        trackedHours: Number(process.env.ENGAGE_TRACKED_SCAN_INTERVAL_HOURS ?? 3),
      },
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
    dto: { date?: 'today' | 'week' | 'month'; platform?: string; status?: string } = {}
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
    if (!REDDIT_COMMENT_URL_RE.test(url)) {
      throw new BadRequestException(
        'Invalid Reddit comment URL. Expected: https://www.reddit.com/r/.../comments/.../comment/...'
      );
    }
    return this._engageRepository.updateReplyUrl(org.id, sentReplyId, url);
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
    const token = userToken || (await getRedditToken());

    // Build fetch options: OAuth headers when a token is available, public JSON
    // API otherwise. Reddit's public .json endpoints need no auth (lower rate
    // limits, sufficient for search). Outbound requests to *.reddit.com are
    // routed via REDDIT_PROXY when set (see setup-dispatcher.ts).
    const makeOpts = (t: string | null): RequestInit => ({
      headers: t
        ? redditAuthHeaders(t)
        : {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
          'Accept': '*/*',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      signal: AbortSignal.timeout(8000),
    });

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
      const res = await fetch(url, makeOpts(token));
      if (res.ok) {
        const json = (await res.json()) as {
          data?: { children?: Array<{ data: Record<string, unknown> }> };
        };
        const results = (json?.data?.children ?? []).map((c) => mapSubreddit(c.data));
        if (results.length) return results;
      }
    } catch {
      // fall through to direct lookup
    }

    // Fallback: exact subreddit name — handles small/new subreddits absent from search index.
    try {
      const aboutRes = await fetch(aboutBase(normalized), makeOpts(token));
      if (!aboutRes.ok) return [];
      const about = (await aboutRes.json()) as { data?: Record<string, unknown> };
      const d = about.data;
      if (!d || d.subreddit_type === 'private') return [];
      return [mapSubreddit(d)];
    } catch {
      return [];
    }
  }

  // Ensures the 3 global workflows are running.
  // Intervals are read from env vars; USE_EXISTING makes this idempotent on every call.
  //   ENGAGE_KEYWORD_SCAN_INTERVAL_HOURS  (default 24)
  //   ENGAGE_CHANNEL_SCAN_INTERVAL_HOURS  (default 3)
  //   ENGAGE_TRACKED_SCAN_INTERVAL_HOURS  (default 3)
  private async _ensureGlobalWorkflowsRunning(): Promise<void> {
    const client = this._temporalService.client?.getRawClient();
    if (!client) return;

    const keywordHours = Number(process.env.ENGAGE_KEYWORD_SCAN_INTERVAL_HOURS ?? 24);
    const channelHours = Number(process.env.ENGAGE_CHANNEL_SCAN_INTERVAL_HOURS ?? 3);
    const trackedHours = Number(process.env.ENGAGE_TRACKED_SCAN_INTERVAL_HOURS ?? 3);

    const workflows = [
      { workflowId: 'engage-keyword-global', name: 'engageGlobalKeywordScanWorkflow', args: [false, keywordHours] as unknown[] },
      { workflowId: 'engage-channel-global', name: 'engageGlobalChannelScanWorkflow', args: [false, channelHours] as unknown[] },
      { workflowId: 'engage-tracked-global', name: 'engageGlobalTrackedWorkflow', args: [false, trackedHours] as unknown[] },
    ];
    for (const { workflowId, name, args } of workflows) {
      try {
        await client.workflow?.start(name, {
          workflowId,
          taskQueue: 'main',
          args,
          workflowIdConflictPolicy: 'USE_EXISTING',
        });
      } catch (err) {
        this.logger.error(`Failed to start ${name}:`, err);
      }
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

    // Phase 2: scheduled posts haven't published yet; best-effort record creation.
    // Log failures but continue — a missing SentReply is recoverable; a missing Post is not.
    const results: EngageSentReply[] = [];
    for (let i = 0; i < body.items.length; i++) {
      const item = body.items[i];
      try {
        const reply = await this._engageRepository.createSentReply({
          organizationId: org.id,
          opportunityId,
          postId: createdPostIds[i],
          inputData: { strategy: item.strategy, brandStrength: item.brandStrength, mentions: item.mentions },
        });
        results.push(reply);
      } catch (err) {
        this.logger.error(
          `batchScheduleReply: post scheduled (postId=${createdPostIds[i]}, opportunityId=${opportunityId}, ` +
          `orgId=${org.id}) but failed to record EngageSentReply.`,
          err instanceof Error ? err.stack : err
        );
      }
    }
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

    // Phase 2: all X replies are LIVE. Do NOT roll back.
    const results: EngageSentReply[] = [];
    for (let i = 0; i < body.items.length; i++) {
      const item = body.items[i];
      try {
        const sentReply = await this._engageRepository.createSentReply({
          organizationId: org.id,
          opportunityId,
          postId: createdPostIds[i],
          inputData: { strategy: item.strategy, brandStrength: item.brandStrength, mentions: item.mentions },
        });
        await this.startMetricsSyncForReply(sentReply.id);
        results.push(sentReply);
      } catch (err) {
        this.logger.error(
          `batchSendReply: X reply published (postId=${createdPostIds[i]}, opportunityId=${opportunityId}, ` +
          `orgId=${org.id}) but failed to record EngageSentReply.`,
          err instanceof Error ? err.stack : err
        );
      }
    }
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
    const { priorStatus } =
      await this._engageRepository.claimOpportunityForReply(
        org.id,
        opportunityId,
        'REPLIED'
      );

    let postId: string | undefined;
    try {
      const post = await this._engageRepository.createManualRedditPost({
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

    // Engage shares the regular post quota. Reddit manual path bypasses
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
        `confirmManualReply: Reddit reply recorded (postId=${postId}, ` +
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

    const keywordHours = Number(process.env.ENGAGE_KEYWORD_SCAN_INTERVAL_HOURS ?? 24);
    const channelHours = Number(process.env.ENGAGE_CHANNEL_SCAN_INTERVAL_HOURS ?? 3);
    const trackedHours = Number(process.env.ENGAGE_TRACKED_SCAN_INTERVAL_HOURS ?? 3);

    // Signal all 3 workflows; fall back to start if any is not yet running.
    const targets = [
      { workflowId: 'engage-keyword-global', signal: 'triggerKeywordScanNow', startName: 'engageGlobalKeywordScanWorkflow', intervalHours: keywordHours },
      { workflowId: 'engage-channel-global', signal: 'triggerChannelScanNow', startName: 'engageGlobalChannelScanWorkflow', intervalHours: channelHours },
      { workflowId: 'engage-tracked-global', signal: 'triggerTrackedScanNow', startName: 'engageGlobalTrackedWorkflow', intervalHours: trackedHours },
    ];

    let anyError = false;
    for (const { workflowId, signal, startName, intervalHours } of targets) {
      try {
        await client.workflow.getHandle(workflowId).signal(signal);
      } catch {
        try {
          await client.workflow.start(startName, {
            workflowId,
            taskQueue: 'main',
            args: [true, intervalHours],
            workflowIdConflictPolicy: 'USE_EXISTING',
          });
        } catch (startErr) {
          this.logger.error(`triggerImmediateScan: failed to start ${workflowId} (org=${org.id})`, startErr);
          anyError = true;
        }
      }
    }

    return { status: anyError ? 'error' : 'signaled' };
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
          await this._syncRedditMetrics(reply.post.id, reply.post.releaseURL, reply.id, reply.opportunity.authorUsername ?? '');
          updated++;
        } else if (p === 'x' && reply.post?.releaseURL) {
          await this._syncXMetrics(reply.organizationId, reply.id, reply.post.id, reply.post.releaseURL, reply.opportunity.externalPostId ?? '', reply.opportunity.authorUsername ?? '');
          updated++;
        }
      } catch (err) {
        this.logger.warn(`resyncEngageMetrics: failed for sentReplyId=${reply.id}: ${(err as Error).message}`);
        errors++;
      }
    }

    return { found: pending.length, updated, errors };
  }

  private async _syncRedditMetrics(postId: string, releaseURL: string, sentReplyId: string, authorUsername: string): Promise<void> {
    const { getRedditToken, redditAuthHeaders } = await import('@gitroom/nestjs-libraries/engage/reddit-auth');
    const commentId = releaseURL.match(/\/comments\/[^/]+\/[^/]+\/([a-z0-9]+)\/?/)?.[1] ?? null;
    if (!commentId) return;

    const token = await getRedditToken();
    const infoUrl = token
      ? `https://oauth.reddit.com/api/info?id=t1_${commentId}`
      : `https://www.reddit.com/api/info.json?id=t1_${commentId}`;
    const infoHeaders = token ? redditAuthHeaders(token) : { 'User-Agent': 'AISEE-Engage/1.0' };

    const infoRes = await fetch(infoUrl, { headers: infoHeaders });
    if (!infoRes.ok) return;

    const infoJson = (await infoRes.json()) as { data?: { children?: Array<{ data: { score: number; num_comments: number } }> } };
    const commentData = infoJson.data?.children?.[0]?.data;
    if (!commentData) return;

    const today = new Date().toISOString().slice(0, 10);
    const analytics = [
      { label: 'score', data: [{ total: String(commentData.score), date: today }], percentageChange: 0 },
      { label: 'comments', data: [{ total: String(commentData.num_comments), date: today }], percentageChange: 0 },
    ];
    // Reddit_traffic_index = score×1 + num_comments×3 (Appendix formula).
    const trafficScore = commentData.score * 1 + commentData.num_comments * 3;
    await this._engageRepository.updatePostMetrics(
      postId,
      Math.round((commentData.score + commentData.num_comments) * 20),
      analytics,
      trafficScore
    );

    const threadMatch = releaseURL.match(/\/r\/([^/]+)\/comments\/([a-z0-9]+)\//);
    if (!threadMatch || !authorUsername) return;
    const [, subreddit, postId_] = threadMatch;
    const threadToken = await getRedditToken();
    const threadUrl = threadToken
      ? `https://oauth.reddit.com/r/${subreddit}/comments/${postId_}?comment=${commentId}&depth=1&limit=25`
      : `https://www.reddit.com/r/${subreddit}/comments/${postId_}/.json?comment=${commentId}&depth=1&limit=25`;
    const threadRes = await fetch(threadUrl, { headers: threadToken ? redditAuthHeaders(threadToken) : { 'User-Agent': 'AISEE-Engage/1.0' } });
    if (!threadRes.ok) return;
    const threadJson = (await threadRes.json()) as Array<{ data?: { children?: Array<{ data?: { replies?: { data?: { children?: Array<{ data?: { author?: string } }> } } } }> } }>;
    const childReplies = threadJson[1]?.data?.children?.[0]?.data?.replies?.data?.children ?? [];
    if (childReplies.some((r) => r.data?.author === authorUsername)) {
      await this._engageRepository.markAuthorReplied(sentReplyId);
    }
  }

  private async _syncXMetrics(orgId: string, sentReplyId: string, postId: string, replyTweetUrl: string, originalTweetId: string, authorUsername: string): Promise<void> {
    // Fetch the reply tweet's metrics through the integration's own OAuth token
    // (the same path regular posts use), so impression_count and bookmark_count
    // are captured and the X traffic index + impressions are written back to the
    // Post. The engage posts are excluded from the global analytics job
    // (source != 'engage'), so we drive it explicitly here.
    try {
      await this._postsService.checkPostAnalytics(orgId, postId, Date.now());
    } catch (err) {
      this.logger.warn(`X analytics sync failed for post ${postId}: ${(err as Error).message}`);
    }

    // Author-replied detection uses the app-only bearer (conversation search),
    // which is independent of the per-integration analytics token above.
    const bearerToken = process.env.X_BEARER_TOKEN;
    if (!bearerToken) return;
    const replyTweetId = replyTweetUrl.match(/\/status\/(\d+)/)?.[1];
    if (!replyTweetId) return;

    const authorRes = await fetch(`https://api.twitter.com/2/users/by/username/${authorUsername}`, { headers: { Authorization: `Bearer ${bearerToken}` } });
    if (!authorRes.ok) return;
    const authorJson = (await authorRes.json()) as { data?: { id: string } };
    const originalAuthorId = authorJson.data?.id;
    if (!originalAuthorId) return;

    const res = await fetch(
      `https://api.twitter.com/2/tweets/search/recent?query=conversation_id:${originalTweetId}&tweet.fields=author_id&max_results=50`,
      { headers: { Authorization: `Bearer ${bearerToken}` } }
    );
    if (!res.ok) return;
    const json = (await res.json()) as { data?: Array<{ id: string; author_id: string }> };
    if ((json.data ?? []).some((t) => t.author_id === originalAuthorId && BigInt(t.id) > BigInt(replyTweetId))) {
      await this._engageRepository.markAuthorReplied(sentReplyId);
    }
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
