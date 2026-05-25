import {
  Body,
  Controller,
  Delete,
  Get,
  Logger,
  NotFoundException,
  Param,
  ParseArrayPipe,
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
import {
  AddKeywordDto,
  AddKeywordsBulkDto,
  AddMonitoredChannelDto,
  AddTrackedAccountDto,
  ConfirmManualReplyDto,
  GenerateDraftDto,
  ListOpportunitiesDto,
  ListSentDto,
  SaveEngageConfigDto,
  SetupEngageDto,
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
    private _engageDraftService: EngageDraftService
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

  @Post('/setup')
  setupEngage(
    @GetOrgFromRequest() org: Organization,
    @Body() body: SetupEngageDto
  ) {
    return this._engageService.setupEngage(org, body);
  }

  // ─── Keywords ─────────────────────────────────────────────────────────────

  @Post('/keywords')
  addKeyword(
    @GetOrgFromRequest() org: Organization,
    @Body() body: AddKeywordDto
  ) {
    return this._engageService.addKeyword(org, body);
  }

  @Post('/keywords/bulk')
  addKeywordsBulk(
    @GetOrgFromRequest() org: Organization,
    @Body() body: AddKeywordsBulkDto
  ) {
    return this._engageService.addKeywordsBulk(org, body);
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
    return this._engageService.searchChannels(org, body.platform, body.query);
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

  // ─── Manual scan trigger ──────────────────────────────────────────────────

  // 5 manual triggers per org per hour — prevents API abuse while allowing
  // legitimate re-scans after adding new keywords.
  @Throttle({ default: { limit: 5, ttl: 3_600_000 } })
  @Post('/scan')
  triggerScan(
    @GetOrgFromRequest() org: Organization,
    @Body(new ParseArrayPipe({ items: String, optional: true }))
    keywordIds: string[]
  ) {
    return this._engageService.triggerImmediateScan(org, keywordIds);
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
    // Set SSE headers FIRST so a pre-stream failure (e.g. opportunity not found)
    // still surfaces as an SSE error frame instead of JSON over an EventSource
    // connection that expects text/event-stream.
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    try {
      // Only generate drafts for actionable opportunities (not REPLIED/DISMISSED/EXPIRED).
      const opportunity = await this._engageService.getOpportunityForReply(org, id);
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
        const errorCode =
          err instanceof NotFoundException
            ? 'opportunity_unavailable'
            : 'generation_failed';
        res.write(`data: ${JSON.stringify({ error: errorCode })}\n\n`);
        res.write(`data: [DONE]\n\n`);
      }
    } finally {
      res.end();
    }
  }

  // ─── Send / Schedule Reply (X via Post pipeline) ─────────────────────────

  @Post('/opportunities/:id/reply')
  sendReply(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Body() body: SendReplyDto
  ) {
    return this._engageService.sendReply(org, user?.id, id, body);
  }

  @Post('/opportunities/:id/schedule')
  scheduleReply(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Body() body: ScheduleReplyDto
  ) {
    return this._engageService.scheduleReply(org, user?.id, id, body);
  }

  // ─── Reddit manual reply (2-step) ─────────────────────────────────────────

  @Post('/opportunities/:id/manual-reply')
  confirmManualReply(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Body() body: ConfirmManualReplyDto
  ) {
    return this._engageService.confirmManualReply(org, user?.id, id, body);
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
