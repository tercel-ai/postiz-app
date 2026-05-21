import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  InternalServerErrorException,
  Logger,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Organization, User } from '@prisma/client';
import { Response } from 'express';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { GetUserFromRequest } from '@gitroom/nestjs-libraries/user/user.from.request';
import { EngageService } from '@gitroom/nestjs-libraries/engage/engage.service';
import { EngageDraftService } from '@gitroom/nestjs-libraries/engage/engage-draft.service';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import { PostOverageService } from '@gitroom/nestjs-libraries/database/prisma/posts/post-overage.service';
import { EngageRepository } from '@gitroom/nestjs-libraries/engage/engage.repository';
import {
  AddKeywordDto,
  AddMonitoredChannelDto,
  AddTrackedAccountDto,
  ConfirmManualReplyDto,
  GenerateDraftDto,
  ListOpportunitiesDto,
  ListSentDto,
  SaveEngageConfigDto,
  ScheduleReplyDto,
  ScoreStatsDto,
  SearchChannelsDto,
  SendReplyDto,
  SubmitManualReplyUrlDto,
  UpdateKeywordDto,
  UpdateMonitoredChannelDto,
  UpdateReplyAccountDto,
  UpdateTrackedAccountDto,
} from '@gitroom/nestjs-libraries/engage/dtos/engage.dto';

@ApiTags('Engage')
@Controller('/engage')
export class EngageController {
  private readonly logger = new Logger(EngageController.name);

  constructor(
    private _engageService: EngageService,
    private _engageDraftService: EngageDraftService,
    private _postsService: PostsService,
    private _postOverageService: PostOverageService,
    private _engageRepository: EngageRepository
  ) {}

  // ─── Config ───────────────────────────────────────────────────────────────

  @Get('/config')
  getConfig(@GetOrgFromRequest() org: Organization) {
    return this._engageService.getConfig(org);
  }

  @Post('/config')
  saveConfig(
    @GetOrgFromRequest() org: Organization,
    @Body() body: SaveEngageConfigDto
  ) {
    return this._engageService.saveConfig(org, body);
  }

  @Post('/config/reset')
  resetConfig(@GetOrgFromRequest() org: Organization) {
    return this._engageService.resetConfig(org);
  }

  // ─── Keywords ─────────────────────────────────────────────────────────────

  @Post('/keywords')
  addKeyword(
    @GetOrgFromRequest() org: Organization,
    @Body() body: AddKeywordDto
  ) {
    return this._engageService.addKeyword(org, body);
  }

  @Patch('/keywords/:id')
  updateKeyword(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body() body: UpdateKeywordDto
  ) {
    return this._engageService.updateKeyword(org, id, body);
  }

  @Delete('/keywords/:id')
  deleteKeyword(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this._engageService.deleteKeyword(org, id);
  }

  // ─── Monitored Channels ───────────────────────────────────────────────────

  @Get('/monitored-channels')
  listMonitoredChannels(@GetOrgFromRequest() org: Organization) {
    return this._engageService.listMonitoredChannels(org);
  }

  @Post('/monitored-channels')
  addMonitoredChannel(
    @GetOrgFromRequest() org: Organization,
    @Body() body: AddMonitoredChannelDto
  ) {
    return this._engageService.addMonitoredChannel(org, body);
  }

  @Patch('/monitored-channels/:id')
  updateMonitoredChannel(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body() body: UpdateMonitoredChannelDto
  ) {
    return this._engageService.updateMonitoredChannel(org, id, body);
  }

  @Delete('/monitored-channels/:id')
  removeMonitoredChannel(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this._engageService.removeMonitoredChannel(org, id);
  }

  @Post('/monitored-channels/search')
  searchChannels(
    @GetOrgFromRequest() org: Organization,
    @Body() body: SearchChannelsDto
  ) {
    void org;
    return this._engageService.searchChannels(body.platform, body.query);
  }

  // ─── Tracked Accounts ─────────────────────────────────────────────────────

  @Get('/tracked-accounts')
  listTrackedAccounts(@GetOrgFromRequest() org: Organization) {
    return this._engageService.listTrackedAccounts(org);
  }

  @Post('/tracked-accounts')
  addTrackedAccount(
    @GetOrgFromRequest() org: Organization,
    @Body() body: AddTrackedAccountDto
  ) {
    return this._engageService.addTrackedAccount(org, body);
  }

  @Patch('/tracked-accounts/:id')
  updateTrackedAccount(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body() body: UpdateTrackedAccountDto
  ) {
    return this._engageService.updateTrackedAccount(org, id, body);
  }

  @Delete('/tracked-accounts/:id')
  removeTrackedAccount(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this._engageService.removeTrackedAccount(org, id);
  }

  // ─── Reply Accounts ───────────────────────────────────────────────────────

  @Get('/reply-accounts')
  listReplyAccounts(@GetOrgFromRequest() org: Organization) {
    return this._engageService.listReplyAccounts(org);
  }

  @Patch('/reply-accounts/:integrationId')
  updateReplyAccountSettings(
    @GetOrgFromRequest() org: Organization,
    @Param('integrationId') integrationId: string,
    @Body() body: UpdateReplyAccountDto
  ) {
    return this._engageService.updateReplyAccountSettings(
      org,
      integrationId,
      body
    );
  }

  // ─── Opportunities ────────────────────────────────────────────────────────

  @Get('/opportunities/score-stats')
  getScoreStats(
    @GetOrgFromRequest() org: Organization,
    @Query() query: ScoreStatsDto
  ) {
    return this._engageService.getScoreStats(org, query);
  }

  @Get('/opportunities')
  listOpportunities(
    @GetOrgFromRequest() org: Organization,
    @Query() query: ListOpportunitiesDto
  ) {
    return this._engageService.listOpportunities(org, query);
  }

  @Patch('/opportunities/:id/dismiss')
  dismissOpportunity(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this._engageService.dismissOpportunity(org, id);
  }

  @Patch('/opportunities/:id/bookmark')
  toggleBookmark(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this._engageService.toggleBookmark(org, id);
  }

  // ─── Draft Generation (SSE) ───────────────────────────────────────────────

  // Spec §11 (tech-design.md): 20 generations/user/hour. Each call opens a
  // Claude Sonnet streaming completion; without a cap an authenticated user
  // can replay the request and bleed Anthropic spend.
  @Throttle({ default: { limit: 20, ttl: 3_600_000 } })
  @Post('/opportunities/:id/draft')
  async generateDraft(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body() body: GenerateDraftDto,
    @Res() res: Response
  ) {
    // Only generate drafts for actionable opportunities (not already REPLIED/DISMISSED/EXPIRED)
    const opportunity = await this._engageService.getOpportunityForReply(org, id);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    try {
      for await (const chunk of this._engageDraftService.generateDraft(
        opportunity,
        body.strategy,
        body.brandStrength
      )) {
        res.write(`data: ${JSON.stringify({ text: chunk })}\n\n`);
      }
      res.write(`data: [DONE]\n\n`);
    } catch (err) {
      this.logger.error(
        `generateDraft failed for opportunity ${id} (org ${org.id})`,
        err instanceof Error ? err.stack : err
      );
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ error: 'generation_failed' })}\n\n`);
        res.write(`data: [DONE]\n\n`);
      }
    } finally {
      res.end();
    }
  }

  // ─── Send / Schedule Reply (X via Post pipeline) ─────────────────────────

  @Post('/opportunities/:id/reply')
  async sendReply(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Body() body: SendReplyDto
  ) {
    // Atomic claim: marks status=REPLIED iff currently NEW/AUTO_QUEUED. Loser of a
    // concurrent race throws NotFoundException here, BEFORE createPost — eliminates
    // duplicate X publishes and orphan Post rows.
    const { opp: opportunity, priorStatus } =
      await this._engageRepository.claimOpportunityForReply(org.id, id, 'REPLIED');

    // Phase 1 — invoke the post pipeline. type='now' BLOCKS until X publish completes,
    // so a failure here means the reply either never made it to X or was rejected by X.
    // Full rollback is safe in this window.
    let postId: string | undefined;
    let created: Array<{ postId?: string }> | undefined;
    try {
      created = await this._postsService.createPost(
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
              value: [{ content: body.draftContent, image: [], delay: 0, id: '' } as never],
              group: '',
              settings: {
                __type: 'x',
                reply_to_tweet_id: opportunity.externalPostId,
                who_can_reply_post: 'everyone',
              } as never,
            } as never,
          ],
        },
        user?.id
      );
      // PostsService.createPost returns objects keyed `postId` (not `id`) —
      // see libraries/nestjs-libraries/src/database/prisma/posts/posts.service.ts:847,855
      postId = created?.[0]?.postId;
      if (!postId) throw new Error('Post creation failed');
    } catch (err) {
      // Pre-publish failure: roll back fully so the user can retry.
      if (postId) await this._engageRepository.deletePostById(postId);
      await this._engageRepository.releaseOpportunityClaim(org.id, id, priorStatus);
      throw err;
    }

    // Phase 2 — at this point the X reply IS LIVE on twitter.com. We MUST NOT roll back
    // the claim or delete the Post: doing so would let the user retry and produce a
    // duplicate live reply. Instead, log the inconsistency and return a specific error.
    try {
      const sentReply = await this._engageRepository.createSentReply({
        organizationId: org.id,
        opportunityId: id,
        postId,
        strategy: body.strategy,
        brandStrength: body.brandStrength,
      });
      // 24h metrics sync — best-effort; the inner method swallows + logs on failure.
      await this._engageService.startMetricsSyncForReply(sentReply.id);
      return sentReply;
    } catch (err) {
      this.logger.error(
        `sendReply: X reply published (postId=${postId}, opportunityId=${id}, orgId=${org.id}) ` +
          `but failed to record EngageSentReply. Manual reconciliation required.`,
        err instanceof Error ? err.stack : err
      );
      throw new InternalServerErrorException(
        'Reply was published but the tracking record could not be created. ' +
          'Contact support to reconcile.'
      );
    }
  }

  @Post('/opportunities/:id/schedule')
  async scheduleReply(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Body() body: ScheduleReplyDto
  ) {
    if (new Date(body.scheduledAt) <= new Date()) {
      throw new BadRequestException('scheduledAt must be a future date');
    }

    const { opp: opportunity, priorStatus } =
      await this._engageRepository.claimOpportunityForReply(org.id, id, 'SCHEDULED');

    // Scheduled posts are not published until their scheduled time — full rollback
    // on any failure is safe.
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
              value: [{ content: body.draftContent, image: [], delay: 0, id: '' } as never],
              group: '',
              settings: {
                __type: 'x',
                reply_to_tweet_id: opportunity.externalPostId,
                who_can_reply_post: 'everyone',
              } as never,
            } as never,
          ],
        },
        user?.id
      );

      // PostsService.createPost returns objects keyed `postId` (not `id`) —
      // see libraries/nestjs-libraries/src/database/prisma/posts/posts.service.ts:847,855
      postId = created?.[0]?.postId;
      if (!postId) throw new Error('Post creation failed');

      const sentReply = await this._engageRepository.createSentReply({
        organizationId: org.id,
        opportunityId: id,
        postId,
        strategy: body.strategy,
        brandStrength: body.brandStrength,
      });

      // NOTE: metrics sync is NOT started here for scheduled posts. The 24h sync must
      // begin after the post actually publishes; the post workflow triggers it via
      // engage-metrics-sync-on-publish.
      return sentReply;
    } catch (err) {
      if (postId) await this._engageRepository.deletePostById(postId);
      await this._engageRepository.releaseOpportunityClaim(org.id, id, priorStatus);
      throw err;
    }
  }

  // ─── Reddit manual reply (2-step) ─────────────────────────────────────────

  @Post('/opportunities/:id/manual-reply')
  async confirmManualReply(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Body() body: ConfirmManualReplyDto
  ) {
    // Atomic claim — same race guard as sendReply / scheduleReply
    const { priorStatus } =
      await this._engageRepository.claimOpportunityForReply(org.id, id, 'REPLIED');

    // Phase 1 — record the Post locally. The user has already manually posted on
    // Reddit, but we haven't yet stored anything on our side, so a failure here can
    // be safely rolled back (they just won't see the metric tracking until they retry).
    let postId: string | undefined;
    try {
      const post = await this._engageRepository.createManualRedditPost({
        organizationId: org.id,
        content: body.draftContent,
        date: new Date(),
      });
      postId = post.id;
    } catch (err) {
      await this._engageRepository.releaseOpportunityClaim(org.id, id, priorStatus);
      throw err;
    }

    // Engage shares the regular post quota. The Reddit manual path bypasses
    // PostsService.createPost, so we must trigger the overage check here to stay
    // symmetric with the X path (posts.service.ts:863). Fire-and-forget — billing
    // failures must not break the user-visible flow.
    if (user?.id) {
      this._postOverageService
        .deductIfOverage(org.id, user.id, postId, 'engage')
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

    // Phase 2 — at this point the user's Reddit reply has happened AND we have a
    // local Post record. Do not roll back the claim (the user can't un-post on
    // Reddit, and clearing REPLIED would invite a confusing retry). Log + surface
    // a specific error if SentReply creation fails.
    try {
      const sentReply = await this._engageRepository.createSentReply({
        organizationId: org.id,
        opportunityId: id,
        postId,
        strategy: body.strategy,
        brandStrength: body.brandStrength,
      });
      // Start metrics sync — Reddit path: waits for user to submit URL then checks for author reply
      await this._engageService.startMetricsSyncForReply(sentReply.id);
      return sentReply;
    } catch (err) {
      this.logger.error(
        `confirmManualReply: Reddit reply recorded (postId=${postId}, opportunityId=${id}, ` +
          `orgId=${org.id}) but failed to record EngageSentReply. Manual reconciliation required.`,
        err instanceof Error ? err.stack : err
      );
      throw new InternalServerErrorException(
        'Reply was recorded but the tracking record could not be created. ' +
          'Contact support to reconcile.'
      );
    }
  }

  // ─── Sent Replies ─────────────────────────────────────────────────────────

  @Get('/sent')
  listSentReplies(
    @GetOrgFromRequest() org: Organization,
    @Query() query: ListSentDto
  ) {
    return this._engageService.listSentReplies(org, query);
  }

  @Get('/sent/stats')
  getSentStats(@GetOrgFromRequest() org: Organization) {
    return this._engageService.getSentStats(org);
  }

  @Patch('/sent/:id/reply-url')
  submitManualReplyUrl(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body() body: SubmitManualReplyUrlDto
  ) {
    return this._engageService.submitManualReplyUrl(org, id, body.url);
  }

  // ─── Dashboard Stats ──────────────────────────────────────────────────────

  @Get('/dashboard-stats')
  getDashboardStats(@GetOrgFromRequest() org: Organization) {
    return this._engageService.getSentStats(org);
  }
}
