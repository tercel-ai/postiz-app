import {
  BadRequestException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Organization } from '@prisma/client';
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
  ScheduleReplyDto,
  ScoreStatsDto,
  SendReplyDto,
  UpdateKeywordDto,
  UpdateMonitoredChannelDto,
  UpdateReplyAccountDto,
  UpdateTrackedAccountDto,
} from '@gitroom/nestjs-libraries/engage/dtos/engage.dto';
import { getRedditToken, redditAuthHeaders } from '@gitroom/nestjs-libraries/engage/reddit-auth';

// Anchored at $ to reject trailing query strings / fragments that would otherwise
// pollute the stored releaseURL (e.g. `?utm_source=...`). Matches spec §12.4.
const REDDIT_COMMENT_URL_RE =
  /^https?:\/\/(www\.)?reddit\.com\/r\/[^/]+\/comments\/[^/]+\/[^/]+\/[a-z0-9]+\/?$/i;

@Injectable()
export class EngageService {
  private readonly logger = new Logger(EngageService.name);

  constructor(
    private _engageRepository: EngageRepository,
    private _temporalService: TemporalService,
    private _postsService: PostsService,
    private _postOverageService: PostOverageService
  ) {}

  // ─── Config ───────────────────────────────────────────────────────────────

  getConfig(org: Organization) {
    return this._engageRepository.getOrCreateConfig(org.id);
  }

  async saveConfig(org: Organization, dto: SaveEngageConfigDto) {
    const result = await this._engageRepository.saveConfig(org.id, dto);
    if (dto.enabled) {
      await this._startEngageWorkflowsForOrg(org.id);
    }
    return result;
  }

  async setupEngage(org: Organization, dto: SetupEngageDto) {
    const result = await this._engageRepository.setupEngage(org.id, dto);
    await this._startEngageWorkflowsForOrg(org.id);
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

  async searchChannels(platform: string, query: string) {
    // Platform-specific channel search stub.
    // V1: Reddit search via public API; others return empty.
    if (platform === 'reddit') {
      return this._searchRedditSubreddits(query);
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

  async getOpportunityForReply(org: Organization, id: string) {
    return this._engageRepository.getOpportunityForReply(org.id, id);
  }

  // ─── Sent Replies ─────────────────────────────────────────────────────────

  async listSentReplies(org: Organization, dto: ListSentDto) {
    return this._engageRepository.listSentReplies(org.id, dto);
  }

  async getSentStats(org: Organization) {
    return this._engageRepository.getSentStats(org.id);
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

  private async _searchRedditSubreddits(query: string) {
    // Strip leading "r/" so users can type either "SEO" or "r/SEO".
    const normalized = query.replace(/^r\//i, '').trim();
    if (!normalized) return [];

    const token = await getRedditToken();
    if (!token) return [];

    // Primary: subreddit search via OAuth API.
    try {
      const url = `https://oauth.reddit.com/subreddits/search?q=${encodeURIComponent(normalized)}&limit=10&type=sr`;
      const res = await fetch(url, {
        headers: redditAuthHeaders(token),
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const json = (await res.json()) as {
          data?: { children?: Array<{ data: Record<string, unknown> }> };
        };
        const results = (json?.data?.children ?? []).map((c) => ({
          platform: 'reddit',
          channelId: c.data.display_name as string,
          channelName: `r/${c.data.display_name as string}`,
          audienceSize: Number(c.data.subscribers ?? 0),
          metadata: {
            description: c.data.public_description,
            url: `https://reddit.com/r/${c.data.display_name}`,
          },
        }));
        if (results.length) return results;
      }
    } catch {
      // fall through to direct lookup
    }

    // Fallback: exact subreddit name — useful for small/new subreddits not in search.
    try {
      const aboutRes = await fetch(
        `https://oauth.reddit.com/r/${encodeURIComponent(normalized)}/about`,
        {
          headers: redditAuthHeaders(token),
          signal: AbortSignal.timeout(8000),
        }
      );
      if (!aboutRes.ok) return [];
      const about = (await aboutRes.json()) as { data?: Record<string, unknown> };
      const d = about.data;
      if (!d || d.subreddit_type === 'private') return [];
      return [
        {
          platform: 'reddit',
          channelId: d.display_name as string,
          channelName: `r/${d.display_name as string}`,
          audienceSize: Number(d.subscribers ?? 0),
          metadata: {
            description: d.public_description,
            url: `https://reddit.com/r/${d.display_name}`,
          },
        },
      ];
    } catch {
      return [];
    }
  }

  // Starts per-org Temporal workflows when setup completes.
  // USE_EXISTING policy prevents double-starting if the org re-saves config.
  private async _startEngageWorkflowsForOrg(orgId: string): Promise<void> {
    const client = this._temporalService.client?.getRawClient();
    if (!client) return;
    const workflows: Array<{ workflowId: string; name: string; args: unknown[] }> = [
      // runImmediately=true → skip the initial UTC 00:30 sleep on first setup.
      { workflowId: `engage-scan-${orgId}`, name: 'engageScanWorkflow', args: [orgId, true] },
      { workflowId: `engage-tracked-${orgId}`, name: 'engageTrackedAccountsWorkflow', args: [orgId] },
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
        this.logger.error(`Failed to start ${name} for org ${orgId}:`, err);
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
        strategy: body.strategy,
        brandStrength: body.brandStrength,
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
        strategy: body.strategy,
        brandStrength: body.brandStrength,
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
        strategy: body.strategy,
        brandStrength: body.brandStrength,
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

  async triggerImmediateScan(org: Organization, keywordIds: string[] = []): Promise<void> {
    const client = this._temporalService.client?.getRawClient();
    if (!client) return;
    try {
      const handle = client.workflow.getHandle(`engage-scan-${org.id}`);
      await handle.signal('triggerScanNow', keywordIds);
    } catch (err) {
      this.logger.warn(`triggerImmediateScan: could not signal workflow for org ${org.id}:`, err);
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
