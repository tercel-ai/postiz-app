import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Organization, User } from '@prisma/client';
import { Response } from 'express';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { GetUserFromRequest } from '@gitroom/nestjs-libraries/user/user.from.request';
import { EngageService } from '@gitroom/nestjs-libraries/engage/engage.service';
import { EngageDraftService } from '@gitroom/nestjs-libraries/engage/engage-draft.service';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
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
  UpdateKeywordDto,
  UpdateMonitoredChannelDto,
  UpdateReplyAccountDto,
  UpdateTrackedAccountDto,
} from '@gitroom/nestjs-libraries/engage/dtos/engage.dto';

@ApiTags('Engage')
@Controller('/engage')
export class EngageController {
  constructor(
    private _engageService: EngageService,
    private _engageDraftService: EngageDraftService,
    private _postsService: PostsService,
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

  @Post('/opportunities/:id/draft')
  async generateDraft(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body() body: GenerateDraftDto,
    @Res() res: Response
  ) {
    const opportunity = await this._engageService.getOpportunityById(org, id);

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
    // getOpportunityForReply also enforces idempotency: throws if already REPLIED/SCHEDULED
    const opportunity = await this._engageService.getOpportunityForReply(org, id);

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

    const postId = created?.[0]?.id;
    if (!postId) throw new Error('Post creation failed');

    const sentReply = await this._engageRepository.createSentReply({
      organizationId: org.id,
      opportunityId: id,
      postId,
      strategy: body.strategy,
      brandStrength: body.brandStrength,
    });

    await this._engageRepository.setOpportunityStatus(id, 'REPLIED');
    // Start 24h metrics sync workflow (best-effort; failure logged but not thrown)
    await this._engageService.startMetricsSyncForReply(sentReply.id);
    return sentReply;
  }

  @Post('/opportunities/:id/schedule')
  async scheduleReply(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Body() body: ScheduleReplyDto
  ) {
    const opportunity = await this._engageService.getOpportunityForReply(org, id);

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

    const postId = created?.[0]?.id;
    if (!postId) throw new Error('Post creation failed');

    const sentReply = await this._engageRepository.createSentReply({
      organizationId: org.id,
      opportunityId: id,
      postId,
      strategy: body.strategy,
      brandStrength: body.brandStrength,
    });

    await this._engageRepository.setOpportunityStatus(id, 'SCHEDULED');
    await this._engageService.startMetricsSyncForReply(sentReply.id);
    return sentReply;
  }

  // ─── Reddit manual reply (2-step) ─────────────────────────────────────────

  @Post('/opportunities/:id/manual-reply')
  async confirmManualReply(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Body() body: ConfirmManualReplyDto
  ) {
    void user;
    // Step 1: create Post(PUBLISHED, no releaseURL) + EngageSentReply immediately.
    // User has already posted to Reddit manually; we record it here for metrics tracking.
    // Post.releaseURL remains null until Step 2 (PATCH /sent/:id/reply-url).
    const post = await this._engageRepository.createManualRedditPost({
      organizationId: org.id,
      content: body.draftContent,
      date: new Date(),
    });

    const sentReply = await this._engageRepository.createSentReply({
      organizationId: org.id,
      opportunityId: id,
      postId: post.id,
      strategy: body.strategy,
      brandStrength: body.brandStrength,
    });

    await this._engageRepository.setOpportunityStatus(id, 'REPLIED');
    // Start metrics sync — Reddit path: waits for user to submit URL then checks for author reply
    await this._engageService.startMetricsSyncForReply(sentReply.id);
    return sentReply;
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
    @Body() body: { url: string }
  ) {
    return this._engageService.submitManualReplyUrl(org, id, body.url);
  }

  // ─── Dashboard Stats ──────────────────────────────────────────────────────

  @Get('/dashboard-stats')
  getDashboardStats(@GetOrgFromRequest() org: Organization) {
    return this._engageService.getSentStats(org);
  }
}
