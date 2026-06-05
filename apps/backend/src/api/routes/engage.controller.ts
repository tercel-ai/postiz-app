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
  Req,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Organization, User } from '@prisma/client';
import { Request, Response } from 'express';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { GetUserFromRequest } from '@gitroom/nestjs-libraries/user/user.from.request';
import { CheckPolicies } from '@gitroom/backend/services/auth/permissions/permissions.ability';
import {
  AuthorizationActions,
  Sections,
} from '@gitroom/backend/services/auth/permissions/permission.exception.class';
import { EngageService } from '@gitroom/nestjs-libraries/engage/engage.service';
import { EngageDraftService } from '@gitroom/nestjs-libraries/engage/engage-draft.service';
import { weightedLength } from '@gitroom/helpers/utils/count.length';
import {
  AddKeywordDto,
  AddKeywordsBulkDto,
  AddMonitoredChannelDto,
  AddTrackedAccountDto,
  ConfirmManualReplyDto,
  DashboardImpressionsDto,
  DashboardRepliesTrendDto,
  DashboardSummaryDto,
  DashboardTrafficsDto,
  GenerateDraftDto,
  ListOpportunitiesDto,
  ListSentDto,
  SaveEngageConfigDto,
  SetupEngageDto,
  BatchScheduleReplyDto,
  BatchSendReplyDto,
  ScheduleReplyDto,
  ScoreStatsDto,
  SearchChannelsDto,
  SendReplyDto,
  SubmitManualReplyUrlDto,
  UpdateKeywordDto,
  UpdateMonitoredChannelDto,
  UpdateReplyAccountDto,
  UpdateTrackedAccountDto,
  UpdateScheduledReplyDto,
} from '@gitroom/nestjs-libraries/engage/dtos/engage.dto';

const X_WEIGHTED_CHAR_LIMIT = 260;
const REDDIT_CHAR_LIMIT = 1000;

function normalizeEngagePlatform(platform: string): string {
  const normalized = platform.toLowerCase();
  return normalized === 'twitter' ? 'x' : normalized;
}

function assertDraftWithinPlatformLimit(platform: string, draft: string) {
  const normalized = normalizeEngagePlatform(platform);
  if (normalized === 'x' && weightedLength(draft) > X_WEIGHTED_CHAR_LIMIT) {
    throw new Error(
      `Generated X draft exceeded ${X_WEIGHTED_CHAR_LIMIT} Twitter-weighted characters.`
    );
  }
  if (normalized === 'reddit' && draft.length > REDDIT_CHAR_LIMIT) {
    throw new Error(`Generated Reddit draft exceeded ${REDDIT_CHAR_LIMIT} characters.`);
  }
}

@ApiTags('Engage')
@Controller('/engage')
export class EngageController {
  private readonly logger = new Logger(EngageController.name);

  constructor(
    private _engageService: EngageService,
    private _engageDraftService: EngageDraftService
  ) {}

  // ─── Config ───────────────────────────────────────────────────────────────

  @ApiOperation({ summary: 'Get Engage config and keywords/channels/accounts for this org' })
  @Get('/config')
  getConfig(@GetOrgFromRequest() org: Organization) {
    return this._engageService.getConfig(org);
  }

  @ApiOperation({ summary: 'Update Engage config (enable/disable)' })
  @Post('/config')
  saveConfig(
    @GetOrgFromRequest() org: Organization,
    @Body() body: SaveEngageConfigDto
  ) {
    return this._engageService.saveConfig(org, body);
  }

  @ApiOperation({ summary: 'Reset Engage config to disabled state' })
  @Post('/config/reset')
  resetConfig(@GetOrgFromRequest() org: Organization) {
    return this._engageService.resetConfig(org);
  }

  @ApiOperation({ summary: 'Atomic bulk setup: create config + keywords + channels + tracked accounts' })
  @Post('/setup')
  setupEngage(
    @GetOrgFromRequest() org: Organization,
    @Body() body: SetupEngageDto
  ) {
    return this._engageService.setupEngage(org, body);
  }

  // ─── Keywords ─────────────────────────────────────────────────────────────

  @ApiOperation({ summary: 'Add a keyword to monitor' })
  @Post('/keywords')
  addKeyword(
    @GetOrgFromRequest() org: Organization,
    @Body() body: AddKeywordDto
  ) {
    return this._engageService.addKeyword(org, body);
  }

  @ApiOperation({ summary: 'Bulk-add keywords (idempotent; duplicates skipped)' })
  @Post('/keywords/bulk')
  addKeywordsBulk(
    @GetOrgFromRequest() org: Organization,
    @Body() body: AddKeywordsBulkDto
  ) {
    return this._engageService.addKeywordsBulk(org, body);
  }

  @ApiOperation({ summary: 'Update keyword enabled state or type' })
  @ApiResponse({ status: 404, description: 'Keyword not found' })
  @Patch('/keywords/:id')
  updateKeyword(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body() body: UpdateKeywordDto
  ) {
    return this._engageService.updateKeyword(org, id, body);
  }

  @ApiOperation({ summary: 'Delete a keyword' })
  @ApiResponse({ status: 404, description: 'Keyword not found' })
  @Delete('/keywords/:id')
  deleteKeyword(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this._engageService.deleteKeyword(org, id);
  }

  @ApiOperation({ summary: 'Preview recent posts matching a keyword' })
  @ApiResponse({ status: 404, description: 'Keyword not found' })
  @Get('/keywords/:id/posts')
  getKeywordPosts(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this._engageService.getKeywordPosts(org, id);
  }

  // ─── Monitored Channels ───────────────────────────────────────────────────

  @ApiOperation({ summary: 'List monitored channels for this org' })
  @Get('/monitored-channels')
  listMonitoredChannels(@GetOrgFromRequest() org: Organization) {
    return this._engageService.listMonitoredChannels(org);
  }

  @ApiOperation({ summary: 'Add a channel to monitor (Reddit subreddit, etc.)' })
  @Post('/monitored-channels')
  addMonitoredChannel(
    @GetOrgFromRequest() org: Organization,
    @Body() body: AddMonitoredChannelDto
  ) {
    return this._engageService.addMonitoredChannel(org, body);
  }

  @ApiOperation({ summary: 'Update a monitored channel (enable/disable, metadata)' })
  @ApiResponse({ status: 404, description: 'Channel not found' })
  @Patch('/monitored-channels/:id')
  updateMonitoredChannel(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body() body: UpdateMonitoredChannelDto
  ) {
    return this._engageService.updateMonitoredChannel(org, id, body);
  }

  @ApiOperation({ summary: 'Remove a monitored channel' })
  @ApiResponse({ status: 404, description: 'Channel not found' })
  @Delete('/monitored-channels/:id')
  removeMonitoredChannel(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this._engageService.removeMonitoredChannel(org, id);
  }

  @ApiOperation({ summary: 'Search for channels to add (e.g. Reddit subreddit search)' })
  @Post('/monitored-channels/search')
  searchChannels(
    @GetOrgFromRequest() org: Organization,
    @Body() body: SearchChannelsDto
  ) {
    return this._engageService.searchChannels(org, body.platform, body.query);
  }

  // ─── Tracked Accounts ─────────────────────────────────────────────────────

  @ApiOperation({ summary: 'List external X accounts tracked by this org' })
  @Get('/tracked-accounts')
  listTrackedAccounts(@GetOrgFromRequest() org: Organization) {
    return this._engageService.listTrackedAccounts(org);
  }

  @ApiOperation({ summary: 'Add an external X account to track' })
  @Post('/tracked-accounts')
  addTrackedAccount(
    @GetOrgFromRequest() org: Organization,
    @Body() body: AddTrackedAccountDto
  ) {
    return this._engageService.addTrackedAccount(org, body);
  }

  @ApiOperation({ summary: 'Update a tracked account (enable/disable, label)' })
  @ApiResponse({ status: 404, description: 'Tracked account not found' })
  @Patch('/tracked-accounts/:id')
  updateTrackedAccount(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body() body: UpdateTrackedAccountDto
  ) {
    return this._engageService.updateTrackedAccount(org, id, body);
  }

  @ApiOperation({ summary: 'Remove a tracked account' })
  @ApiResponse({ status: 404, description: 'Tracked account not found' })
  @Delete('/tracked-accounts/:id')
  removeTrackedAccount(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this._engageService.removeTrackedAccount(org, id);
  }

  // ─── Reply Accounts ───────────────────────────────────────────────────────

  @ApiOperation({ summary: "List this org's X integrations with Engage reply settings" })
  @Get('/reply-accounts')
  listReplyAccounts(@GetOrgFromRequest() org: Organization) {
    return this._engageService.listReplyAccounts(org);
  }

  @ApiOperation({ summary: 'Update reply account settings (auto-reply window, strategy)' })
  @ApiResponse({ status: 404, description: 'Integration not found' })
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
  @ApiOperation({ summary: 'Manually trigger an immediate keyword/channel scan' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded (5/hour)' })
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

  @ApiOperation({ summary: 'Score distribution and top-opportunity stats for this org' })
  @Get('/opportunities/score-stats')
  getScoreStats(
    @GetOrgFromRequest() org: Organization,
    @Query() query: ScoreStatsDto
  ) {
    return this._engageService.getScoreStats(org, query);
  }

  @ApiOperation({ summary: 'Paginated list of signal-feed opportunities for this org' })
  @Get('/opportunities')
  listOpportunities(
    @GetOrgFromRequest() org: Organization,
    @Query() query: ListOpportunitiesDto
  ) {
    return this._engageService.listOpportunities(org, query);
  }

  @ApiOperation({ summary: 'Get full detail for a single opportunity; includes sentReply when status is SCHEDULED or REPLIED' })
  @ApiResponse({ status: 404, description: 'Opportunity not found' })
  @Get('/opportunities/:id')
  getOpportunityDetail(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this._engageService.getOpportunityDetail(org, id);
  }

  @ApiOperation({ summary: 'Dismiss an opportunity (moves it to DISMISSED status)' })
  @ApiResponse({ status: 404, description: 'Opportunity not found or no longer actionable' })
  @Patch('/opportunities/:id/dismiss')
  dismissOpportunity(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this._engageService.dismissOpportunity(org, id);
  }

  @ApiOperation({ summary: 'Toggle bookmark on an opportunity' })
  @ApiResponse({ status: 404, description: 'Opportunity not found' })
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
  @ApiOperation({ summary: 'Stream an AI-generated reply draft via SSE (text/event-stream)' })
  @ApiResponse({ status: 200, description: 'SSE stream of text chunks; ends with [DONE]' })
  @ApiResponse({ status: 404, description: 'Opportunity not found or already replied' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded (20/hour)' })
  @Throttle({ default: { limit: 20, ttl: 3_600_000 } })
  @Post('/opportunities/:id/draft')
  async generateDraft(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body() body: GenerateDraftDto,
    @Req() req: Request,
    @Res() res: Response
  ) {
    // Set SSE headers FIRST so a pre-stream failure (e.g. opportunity not found)
    // still surfaces as an SSE error frame instead of JSON over an EventSource
    // connection that expects text/event-stream.
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const abortController = new AbortController();
    req.on('close', () => abortController.abort());

    try {
      // Only generate drafts for actionable opportunities (not REPLIED/DISMISSED/EXPIRED).
      const opportunity = await this._engageService.getOpportunityForReply(org, id);
      let draft = '';
      for await (const chunk of this._engageDraftService.generateDraft(
        opportunity,
        body.strategy,
        body.brandStrength,
        body.mentions,
        abortController.signal,
        body.outputLength
      )) {
        if (abortController.signal.aborted) break;
        draft += chunk;
      }
      if (!abortController.signal.aborted) {
        assertDraftWithinPlatformLimit(opportunity.platform, draft);
        res.write(`data: ${JSON.stringify({ text: draft })}\n\n`);
      }
      if (!abortController.signal.aborted) {
        res.write(`data: [DONE]\n\n`);
      }
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') {
        // Client disconnected — no-op; connection is already closed
        return;
      }
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
      if (!res.writableEnded) res.end();
    }
  }

  // ─── Send / Schedule Reply (X via Post pipeline) ─────────────────────────

  @ApiOperation({ summary: 'Cancel a scheduled reply and immediately send it' })
  @ApiResponse({ status: 400, description: 'No scheduled reply found, or post already published' })
  @Post('/opportunities/:id/send-now')
  cancelAndSendNow(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Body() body: SendReplyDto
  ) {
    return this._engageService.cancelAndSendNow(org, user?.id, id, body);
  }

  @ApiOperation({ summary: 'Schedule a reply to an opportunity for future publishing' })
  @ApiResponse({ status: 404, description: 'Opportunity not found or already replied' })
  @Post('/opportunities/:id/schedule')
  scheduleReply(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Body() body: ScheduleReplyDto
  ) {
    return this._engageService.scheduleReply(org, user?.id, id, body);
  }

  @ApiOperation({ summary: 'Schedule replies from multiple integrations at different times in one request' })
  @ApiResponse({ status: 400, description: 'Any scheduledAt is not in the future, or items array is invalid' })
  @ApiResponse({ status: 404, description: 'Opportunity not found or already replied' })
  @Post('/opportunities/:id/batch-schedule')
  batchScheduleReply(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Body() body: BatchScheduleReplyDto
  ) {
    return this._engageService.batchScheduleReply(org, user?.id, id, body);
  }

  @ApiOperation({ summary: 'Send replies from multiple integrations immediately in one request' })
  @ApiResponse({ status: 404, description: 'Opportunity not found or already replied' })
  @Post('/opportunities/:id/batch-send')
  batchSendReply(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Body() body: BatchSendReplyDto
  ) {
    return this._engageService.batchSendReply(org, user?.id, id, body);
  }

  // ─── Manual reply (Reddit + X) ────────────────────────────────────────────

  @ApiOperation({ summary: 'Confirm a manual reply (Reddit or X) and record it in the system. X requires replyUrl + integrationId.' })
  @ApiResponse({ status: 404, description: 'Opportunity not found or already replied' })
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

  @ApiOperation({ summary: 'Paginated list of sent Engage replies' })
  @Get('/sent')
  listSentReplies(
    @GetOrgFromRequest() org: Organization,
    @Query() query: ListSentDto
  ) {
    return this._engageService.listSentReplies(org, query);
  }

  @ApiOperation({ summary: 'Aggregate stats for sent replies, scoped by the same date/platform/status filters as /sent (no date = all-time)' })
  @Get('/sent/stats')
  getSentStats(
    @GetOrgFromRequest() org: Organization,
    @Query() query: ListSentDto
  ) {
    return this._engageService.getSentStats(org, {
      date: query.date,
      platform: query.platform,
      status: query.status,
    });
  }

  @ApiOperation({ summary: 'Edit content / schedule of a scheduled (QUEUE) engage reply' })
  @ApiResponse({ status: 400, description: 'Reply already sent, or scheduledAt is not in the future' })
  @ApiResponse({ status: 404, description: 'Sent reply not found' })
  @Patch('/sent/:id')
  updateScheduledReply(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body() body: UpdateScheduledReplyDto
  ) {
    return this._engageService.updateScheduledReply(org, id, body);
  }

  @ApiOperation({ summary: 'Submit the Reddit comment URL for a manual reply' })
  @ApiResponse({ status: 404, description: 'Sent reply not found' })
  @ApiResponse({ status: 400, description: 'Only valid for Reddit manual replies' })
  @Patch('/sent/:id/reply-url')
  submitManualReplyUrl(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body() body: SubmitManualReplyUrlDto
  ) {
    return this._engageService.submitManualReplyUrl(org, id, body.url);
  }

  // ─── Dashboard Stats ──────────────────────────────────────────────────────

  // Panel ① "Engage Performance": weekly count, response rate, impressions,
  // traffic index, likes/upvotes, per-platform split, and this week's best reply.
  @ApiOperation({ summary: 'Engage Performance panel: headline stats, optional platform filter, platform split, best reply' })
  @Get('/dashboard/summary')
  getDashboardSummary(
    @GetOrgFromRequest() org: Organization,
    @Query() query: DashboardSummaryDto
  ) {
    return this._engageService.getDashboardSummary(org, {
      platform: query.platform,
      date: query.date,
    });
  }

  // Panel ② "Your Posts" overlay: Engage reply counts bucketed by publish day.
  @ApiOperation({ summary: 'Daily Engage reply counts over a trailing window (for the Your Posts chart overlay)' })
  @Get('/dashboard/replies-trend')
  getDashboardRepliesTrend(
    @GetOrgFromRequest() org: Organization,
    @Query() query: DashboardRepliesTrendDto
  ) {
    return this._engageService.getDashboardRepliesTrend(org, query.days);
  }

  // Panel ③ "Traffic from Engage": total traffic index + per-reply breakdown.
  @ApiOperation({ summary: 'Total Engage traffic index plus per-reply breakdown (Traffic from Engage panel)' })
  @Get('/dashboard/traffics')
  getDashboardTraffics(
    @GetOrgFromRequest() org: Organization,
    @Query() query: DashboardTrafficsDto
  ) {
    return this._engageService.getDashboardTraffics(org, {
      platform: query.platform,
      limit: query.limit,
    });
  }

  // Panel ④ "Engage Impressions Trend": impressions by publish date and
  // platform, bucketed by period. Response shape matches /dashboard/impressions.
  @ApiOperation({ summary: 'Engage impressions trend by period and platform (daily/weekly/monthly)' })
  @Get('/dashboard/impressions')
  getDashboardImpressions(
    @GetOrgFromRequest() org: Organization,
    @Query() query: DashboardImpressionsDto
  ) {
    return this._engageService.getDashboardImpressions(
      org,
      (query.period as 'daily' | 'weekly' | 'monthly') || 'daily'
    );
  }

  // Panel ⑤ "Top engage sources": engage replies grouped by the original post
  // author (traffic source), ranked by traffic index. Reuses the traffics query
  // params (optional platform filter + limit).
  @ApiOperation({ summary: 'Top engage traffic sources grouped by original author (Top engage sources panel)' })
  @Get('/dashboard/top-sources')
  getDashboardTopSources(
    @GetOrgFromRequest() org: Organization,
    @Query() query: DashboardTrafficsDto
  ) {
    return this._engageService.getDashboardTopSources(org, {
      platform: query.platform,
      limit: query.limit,
    });
  }

  // ─── Admin: resync metrics ─────────────────────────────────────────────────

  @ApiOperation({ summary: 'Re-fetch Reddit/X metrics for published engage replies with missing stats' })
  // Org-admin only: this re-fetches external Reddit/X metrics and must not be
  // triggerable by an ordinary org member. Throttled like the other
  // external-API endpoints (/scan, /draft) to bound the upstream call volume.
  @CheckPolicies([AuthorizationActions.Create, Sections.ADMIN])
  @Throttle({ default: { limit: 5, ttl: 3_600_000 } })
  @Post('/admin/resync-metrics')
  resyncEngageMetrics(
    @GetOrgFromRequest() org: Organization,
    @Query('platform') platform?: string,
    @Query('dry_run') dryRun?: string,
  ) {
    return this._engageService.resyncEngageMetrics({
      orgId: org.id,
      platform,
      dryRun: dryRun === 'true',
    });
  }

  // Org-admin only: one-shot "manual wake-up" — backfill missing X integrations,
  // resync metrics for replies with null impressions, and return before/after
  // per-platform stats. Same external-API call budget as /resync-metrics, so it
  // shares the 5/hour throttle. backfill defaults on; pass backfill=false to skip
  // and dry_run=true for a read-only preview.
  @ApiOperation({ summary: 'Manually wake up engage reply-metrics collection and return before/after stats.' })
  @CheckPolicies([AuthorizationActions.Create, Sections.ADMIN])
  @Throttle({ default: { limit: 5, ttl: 3_600_000 } })
  @Post('/admin/sync-metrics')
  syncEngageMetrics(
    @GetOrgFromRequest() org: Organization,
    @Query('platform') platform?: string,
    @Query('dry_run') dryRun?: string,
    @Query('backfill') backfill?: string,
  ) {
    return this._engageService.syncEngageMetricsWithStats(org, {
      platform,
      dryRun: dryRun === 'true',
      backfill: backfill !== 'false',
    });
  }
}
