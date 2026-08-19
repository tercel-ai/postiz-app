import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
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
import { EngageScanTasksService } from '@gitroom/nestjs-libraries/engage/engage-scan-tasks.service';
import {
  EngageScanSyncDto,
  scanIngestPostToRawPost,
} from '@gitroom/nestjs-libraries/dtos/engage/scan-ingest.dto';
import { EngageDraftService } from '@gitroom/nestjs-libraries/engage/engage-draft.service';
import {
  assertDraftWithinPlatformLimit,
  outputLengthForLength,
} from '@gitroom/nestjs-libraries/engage/engage-draft-length';
import { EngageAutoReplyService } from '@gitroom/nestjs-libraries/engage/engage-auto-reply.service';
import {
  AddKeywordDto,
  AddKeywordsBulkDto,
  AddMonitoredChannelDto,
  ReportRedditChannelCapabilityDto,
  AddTrackedAccountDto,
  ConfirmManualReplyDto,
  DashboardImpressionsDto,
  DashboardRepliesTrendDto,
  DashboardSummaryDto,
  DashboardTrafficsDto,
  GenerateDraftDto,
  ListOpportunitiesDto,
  ListSentDto,
  LocateOpportunityDto,
  LocateSentReplyDto,
  OpportunityCountsSummaryDto,
  SentCountsSummaryDto,
  RefreshMetricsDto,
  IngestReplyMetricsDto,
  SaveDraftDto,
  SaveEngageConfigDto,
  SetupEngageDto,
  BatchScheduleReplyDto,
  BatchSendReplyDto,
  ScheduleReplyDto,
  ScoreStatsDto,
  SearchChannelsDto,
  PublishExtensionReplyDto,
  SendReplyDto,
  SubmitManualReplyUrlDto,
  UpdateKeywordDto,
  UpdateMonitoredChannelDto,
  UpdateReplyAccountDto,
  UpdateTrackedAccountDto,
  UpdateScheduledReplyDto,
} from '@gitroom/nestjs-libraries/engage/dtos/engage.dto';

// Soft target the model aims for vs. the hard ceiling we actually reject above
@ApiTags('Engage')
@Controller('/engage')
export class EngageController {
  private readonly logger = new Logger(EngageController.name);

  constructor(
    private _engageService: EngageService,
    private _engageDraftService: EngageDraftService,
    private _scanTasksService: EngageScanTasksService,
    private _engageAutoReplyService: EngageAutoReplyService
  ) {}

  // ─── Extension scan loop ──────────────────────────────────────────────────

  @ApiOperation({
    summary:
      'Extension scan loop: ingest a completed unit (optional) and claim the next batch of due units',
  })
  @Post('/scan-tasks/ingest')
  async scanTasksIngest(
    @GetOrgFromRequest() org: Organization,
    @Body() body: EngageScanSyncDto
  ) {
    console.log(
      '[ingest-ctrl] completed=',
      JSON.stringify(body.completed)?.slice(0, 200)
    );
    const completed = body.completed
      ? {
          taskId: body.completed.taskId,
          posts: (body.completed.posts ?? []).map(scanIngestPostToRawPost),
          nextCursor: body.completed.nextCursor
            ? {
                lastSeenExternalId:
                  body.completed.nextCursor.lastSeenExternalId ?? null,
                lastSeenAt: body.completed.nextCursor.lastSeenAt
                  ? new Date(body.completed.nextCursor.lastSeenAt)
                  : null,
              }
            : undefined,
          exhausted: body.completed.exhausted,
        }
      : undefined;
    return this._scanTasksService.sync(org.id, {
      completed,
      want: body.want,
      force: body.force,
      selectedUnits: body.selectedUnits,
    });
  }

  @ApiOperation({
    summary:
      'Cheap probe (one Redis GET) telling the extension whether it is worth ' +
      'calling /scan-tasks/ingest right now. Fast lane only — the extension ' +
      'still polls ingest unconditionally on its slower backstop alarm.',
  })
  @Get('/scan-tasks/hint')
  async scanTasksHint(@GetOrgFromRequest() org: Organization) {
    return { work: await this._scanTasksService.hasPendingWork(org.id) };
  }

  @ApiOperation({
    summary:
      'Release a held scan-task lease so the unit can be re-claimed. ' +
      'Resets status → IDLE without advancing the cursor; select and claim the unit afterwards to bypass cadence.',
  })
  @Post('/scan-tasks/release')
  async scanTasksRelease(@Body() body: { taskId: string }) {
    if (!body?.taskId) return { released: false };
    const released = await this._scanTasksService.releaseTask(body.taskId);
    return { released };
  }

  @ApiOperation({
    summary:
      'Ingest posts collected by the extension outside a claimed scan task.',
  })
  @Post('/scan-posts/ingest')
  async ingestScanPosts(
    @GetOrgFromRequest() org: Organization,
    @Body() body: { posts?: any[] }
  ) {
    const posts = (body?.posts ?? []).map(scanIngestPostToRawPost);
    const result = await this._scanTasksService.ingestCollectedPosts(
      org.id,
      posts
    );
    return result;
  }

  // ─── Config ───────────────────────────────────────────────────────────────

  @ApiOperation({
    summary: 'Get Engage config and keywords/channels/accounts for this org',
  })
  @Get('/config')
  getConfig(
    @GetOrgFromRequest() org: Organization,
    @Query('projectId') projectId?: string
  ) {
    return this._engageService.getConfig(org, projectId);
  }

  @ApiOperation({
    summary:
      "Update Engage config: enable/disable, and the project's unattended reply mode (off | review | auto)",
  })
  @ApiResponse({
    status: 400,
    description:
      'autoReplyMode other than "off" was sent without a projectId — unattended replying is driven by a project\'s operation plan, so it cannot be set on the legacy null-project config',
  })
  @Post('/config')
  saveConfig(
    @GetOrgFromRequest() org: Organization,
    @Body() body: SaveEngageConfigDto
  ) {
    return this._engageService.saveConfig(org, body);
  }

  @ApiOperation({ summary: 'Reset Engage config to disabled state' })
  @Post('/config/reset')
  resetConfig(
    @GetOrgFromRequest() org: Organization,
    @Query('projectId') projectId?: string
  ) {
    return this._engageService.resetConfig(org, projectId);
  }

  @ApiOperation({
    summary:
      'Atomic bulk setup: create config + keywords + channels + tracked accounts',
  })
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

  @ApiOperation({
    summary: 'Bulk-add keywords (idempotent; duplicates skipped)',
  })
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
  //
  // A THIN ALIAS since the scan-target merge: channels are EngageTrackedAccount
  // rows whose platform has a channel scope (reddit). These routes keep the old
  // paths and the old channelId/channelName response shape so the frontend and
  // the extension needed no coordinated release — the repository does the
  // translation. Retire them once every client reads /tracked-accounts.

  @ApiOperation({ summary: 'List monitored channels for this org' })
  @Get('/monitored-channels')
  listMonitoredChannels(
    @GetOrgFromRequest() org: Organization,
    @Query('projectId') projectId?: string
  ) {
    return this._engageService.listMonitoredChannels(org, projectId);
  }

  @ApiOperation({ summary: 'Add a subreddit to monitor' })
  @ApiResponse({
    status: 400,
    description:
      'Platform has no channel scope (only reddit does), or the community name is not a valid subreddit',
  })
  @ApiResponse({
    status: 409,
    description: 'Channel already monitored by this config',
  })
  @Post('/monitored-channels')
  addMonitoredChannel(
    @GetOrgFromRequest() org: Organization,
    @Body() body: AddMonitoredChannelDto
  ) {
    return this._engageService.addMonitoredChannel(org, body);
  }

  @ApiOperation({
    summary: 'Update a monitored channel (enable/disable, metadata)',
  })
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

  @ApiOperation({
    summary:
      "Report a subreddit's observed posting rules (flair options, flair/tag required)",
    description:
      "Reddit's flair endpoints answer USER_REQUIRED to unauthenticated callers and this deployment has no Reddit API credentials, so a flair list can only be read where Reddit renders it: the extension's submit tab. This is that observation coming back. Returns updated:0 when the org does not monitor the subreddit — no row is created for a cache.",
  })
  @Post('/monitored-channels/reddit/capability')
  reportRedditChannelCapability(
    @GetOrgFromRequest() org: Organization,
    @Body() body: ReportRedditChannelCapabilityDto
  ) {
    return this._engageService.reportRedditChannelCapability(org, body);
  }

  // There is deliberately no GET counterpart. The capability record has exactly
  // one reader — the operation-plan resolver, which calls the repository
  // directly (operation-plan.service.ts -> getRedditChannelCapability) and never
  // crosses HTTP. A read route existed briefly with no caller anywhere in the
  // repo; add one back when a UI actually needs to show a subreddit's known
  // flair set, and validate `subreddit` at the boundary when you do.

  @ApiOperation({
    summary: 'Search for channels to add (e.g. Reddit subreddit search)',
  })
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
  listTrackedAccounts(
    @GetOrgFromRequest() org: Organization,
    @Query('projectId') projectId?: string
  ) {
    return this._engageService.listTrackedAccounts(org, projectId);
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

  @ApiOperation({
    summary: "List this org's X integrations with Engage reply settings",
  })
  @Get('/reply-accounts')
  listReplyAccounts(
    @GetOrgFromRequest() org: Organization,
    @Query('projectId') projectId?: string
  ) {
    return this._engageService.listReplyAccounts(org, projectId);
  }

  @ApiOperation({
    summary: 'Create or update reply account settings for a project',
  })
  @ApiResponse({ status: 400, description: 'projectId is required' })
  @ApiResponse({ status: 404, description: 'Integration not found' })
  @Post('/reply-accounts/:integrationId')
  upsertReplyAccountSettings(
    @GetOrgFromRequest() org: Organization,
    @Param('integrationId') integrationId: string,
    @Body() body: UpdateReplyAccountDto
  ) {
    return this._engageService.upsertReplyAccountSettings(
      org,
      integrationId,
      body
    );
  }

  // ─── Unattended reply driver ──────────────────────────────────────────────

  /**
   * Drafts due to be replied to right now, for the projects that opted into
   * unattended replying (`EngageConfig.autoReplyMode`).
   *
   * The mirror of `POST /posts/publish-due`: backend = scheduler, extension =
   * executor. This makes NO platform call — it reads the project's plan budget,
   * picks the opportunities, generates and PARKS the drafts, and hands back what
   * is ready. Each item is already a saved `DRAFT` row, so it also shows up in
   * Awaiting review; `mode: 'review'` means a human must send it, `mode: 'auto'`
   * means the extension may.
   *
   * Deliberately org-scoped with no `planId`: the plan decides HOW MUCH to reply,
   * which this endpoint reads server-side — the executor never needs to know
   * which plans exist (the same reason publish-due takes no planId).
   */
  @ApiOperation({
    summary:
      'Drafts due for unattended reply (extension pull; org-scoped, paced)',
  })
  @Post('/reply-due')
  async getDueReplies(@GetOrgFromRequest() org: Organization) {
    const due = await this._engageAutoReplyService.getDueReplies(org);
    return { due };
  }

  // ─── Manual scan trigger ──────────────────────────────────────────────────

  // 5 manual triggers per org per hour — prevents API abuse while allowing
  // legitimate re-scans after adding new keywords.
  // Uses triggerDueScan (not force): newly added units (null cursor) are
  // always "due" so they scan immediately; units still in cooldown are
  // skipped. Force-scan is reserved for first-time setup (saveConfig /
  // setupEngage) where nothing has a cursor yet.
  @ApiOperation({
    summary:
      'Trigger a due-only keyword/channel scan (new units scan immediately, cooldown-respecting)',
  })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded (5/hour)' })
  @Throttle({ default: { limit: 5, ttl: 3_600_000 } })
  @Post('/scan')
  triggerScan(@GetOrgFromRequest() org: Organization) {
    return this._engageService.triggerDueScan(org);
  }

  @ApiOperation({
    summary:
      "Page-visit trigger: fire-and-forget kick of this org's DUE scan (keywords/tracked/channels). Returns { status, coldStart, nextRefreshAt }; the client caches nextRefreshAt and skips calling again until then. Metrics are NOT handled here — refresh them via POST /sent/metrics/refresh with the post ids on screen.",
  })
  @Post('/refresh-on-visit')
  refreshOnVisit(@GetOrgFromRequest() org: Organization) {
    return this._engageService.refreshOnVisit(org);
  }

  @ApiOperation({
    summary:
      'Event-driven metrics refresh: the client posts the exact post ids it is showing on /engage/sent (any sort/filter/page). The server refreshes only those PUBLISHED, in-window, and past their per-plan metrics interval — then fire-and-forgets the X/Reddit fetch. Returns { accepted, throttled, nextRefreshAt }. When `accepted` is non-empty a fetch was kicked; re-read GET /sent to surface the new impressions/trafficScore once it lands (NOT GET /sent/:id/status — that returns state/replyUrl only, no metrics).',
  })
  @Post('/sent/metrics/refresh')
  refreshSentMetrics(
    @GetOrgFromRequest() org: Organization,
    @Body() body: RefreshMetricsDto
  ) {
    return this._engageService.refreshMetricsForPosts(org, body.postIds);
  }

  // ─── Opportunities ────────────────────────────────────────────────────────

  @ApiOperation({
    summary: 'Score distribution and top-opportunity stats for this org',
  })
  @Get('/opportunities/score-stats')
  getScoreStats(
    @GetOrgFromRequest() org: Organization,
    @Query() query: ScoreStatsDto
  ) {
    return this._engageService.getScoreStats(org, query);
  }

  @ApiOperation({
    summary:
      'Rollup for tab/platform badges: total + byStatus + byPlatform in one call, all computed under the SAME conditions — the /opportunities filter contract minus status/platform (those are the breakdown axes here, not filters). Replaces doing N separate limit=1 list calls just to read totals.',
  })
  @Get(['/opportunities/counts', '/opportunities/counts/summary'])
  getOpportunityCountsSummary(
    @GetOrgFromRequest() org: Organization,
    @Query() query: OpportunityCountsSummaryDto
  ) {
    return this._engageService.getOpportunityCountsSummary(org, query);
  }

  @ApiOperation({
    summary:
      'Filtered counts under EXACTLY the same filters as GET /opportunities: `total` honors every filter (status/platform included, same number the list returns); `byStatus` honors every filter except `status` itself (the breakdown axis), so per-status badges stay complete while platform/keywords/date narrow them. Sort/pagination params are accepted and ignored, so clients can reuse the list query string verbatim.',
  })
  @Get('/opportunities/count')
  countOpportunities(
    @GetOrgFromRequest() org: Organization,
    @Query() query: ListOpportunitiesDto
  ) {
    return this._engageService.countOpportunities(org, query);
  }

  @ApiOperation({
    summary:
      'Locate the page of a given opportunityStateId within /opportunities using the same filters and sort. Returns null page when the opportunity does not match the filters.',
  })
  @Get('/opportunities/locate')
  locateOpportunity(
    @GetOrgFromRequest() org: Organization,
    @Query() query: LocateOpportunityDto
  ) {
    return this._engageService.locateOpportunity(org, query);
  }

  @ApiOperation({
    summary: 'Paginated list of signal-feed opportunities for this org',
  })
  @Get('/opportunities')
  listOpportunities(
    @GetOrgFromRequest() org: Organization,
    @Query() query: ListOpportunitiesDto
  ) {
    return this._engageService.listOpportunities(org, query);
  }

  @ApiOperation({
    summary:
      'Get a single signal-feed opportunity by id; response shape matches one item from /opportunities',
  })
  @ApiResponse({ status: 404, description: 'Opportunity not found' })
  @Get('/opportunities/:id')
  getOpportunityById(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Query('projectId') projectId?: string
  ) {
    return this._engageService.getOpportunityById(org, id, projectId);
  }

  @ApiOperation({
    summary: 'Dismiss an opportunity (moves it to DISMISSED status)',
  })
  @ApiResponse({
    status: 404,
    description: 'Opportunity not found or no longer actionable',
  })
  @Patch('/opportunities/:id/dismiss')
  dismissOpportunity(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Query('projectId') projectId?: string
  ) {
    return this._engageService.dismissOpportunity(org, id, projectId);
  }

  @ApiOperation({ summary: 'Toggle bookmark on an opportunity' })
  @ApiResponse({ status: 404, description: 'Opportunity not found' })
  @Patch('/opportunities/:id/bookmark')
  toggleBookmark(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Query('projectId') projectId?: string
  ) {
    return this._engageService.toggleBookmark(org, id, projectId);
  }

  // ─── Draft Generation (SSE) ───────────────────────────────────────────────

  // Spec §11 (tech-design.md): 20 generations/user/hour. Each call opens a
  // Claude Sonnet streaming completion; without a cap an authenticated user
  // can replay the request and bleed Anthropic spend.
  @ApiOperation({
    summary: 'Stream an AI-generated reply draft via SSE (text/event-stream)',
  })
  @ApiResponse({
    status: 200,
    description:
      'SSE stream of text chunks; ends with [DONE]. Non-actionable statuses (expired/replied/scheduled/dismissed) end the stream with a typed error frame carrying a human-readable reason.',
  })
  @ApiResponse({ status: 404, description: 'Opportunity not found' })
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

    // Length tier drives both the credit cost and (when outputLength is omitted)
    // the generation target. Defaults to 'medium' when the client omits it.
    const length = body.length ?? 'medium';

    // The reservation written at precheck. Held so we can release it (uncount it)
    // on any failure/abort after it was taken.
    let reservation: { cost: number; taskId: string } | null = null;

    try {
      // Only generate drafts for actionable opportunities (not REPLIED/DISMISSED/EXPIRED).
      const opportunity = await this._engageService.getOpportunityForReply(
        org,
        id,
        body.projectId
      );

      // Pre-flight gate (spec §3.3): monthly cap + credit balance must clear
      // BEFORE any model call, and the cap-ledger row is written up front so the
      // cap holds against concurrent requests. A block ends the stream without
      // generating (no reservation is taken).
      reservation = await this._engageService.reserveReplyGeneration(
        org,
        length,
        opportunity.id
      );

      const outputLength =
        body.outputLength ??
        outputLengthForLength(opportunity.platform, length);

      let draft = '';
      for await (const chunk of this._engageDraftService.generateDraft(
        opportunity,
        body.strategy,
        body.brandStrength,
        body.mentions,
        abortController.signal,
        outputLength
      )) {
        if (abortController.signal.aborted) break;
        draft += chunk;
      }
      if (abortController.signal.aborted) {
        // Client gone mid-stream — uncount the reservation; nothing delivered.
        await this._engageService.releaseReplyGeneration(reservation.taskId);
      } else {
        assertDraftWithinPlatformLimit(
          opportunity.platform,
          draft,
          outputLength
        );
        // Settle only after a successful, non-aborted generation (spec §3.3).
        // Best-effort: a billing hiccup must not fail an already-produced draft —
        // the reservation stays counted (status reserved/unbilled) so the cap holds.
        try {
          await this._engageService.settleReplyGeneration(
            org,
            reservation.taskId,
            length,
            reservation.cost
          );
        } catch (billErr) {
          this.logger.error(
            `Reply credit settle failed for opportunity ${id} (org ${org.id})`,
            billErr instanceof Error ? billErr.stack : billErr
          );
        }
        // Persist THIS generation to the opportunity's per-org version history so
        // a user who regenerates several times keeps every draft (linked to the
        // BillingRecord taskId charged for it). Best-effort: a generation that was
        // produced and charged must still be delivered even if the audit write
        // fails — never let it break the SSE response.
        try {
          await this._engageService.recordGeneration(
            org,
            opportunity.id,
            {
            source: 'ai',
            content: draft,
            length,
            cost: reservation.cost,
            strategy: body.strategy,
            brandStrength: body.brandStrength,
            mentions: body.mentions,
            billingTaskId: reservation.taskId,
            createdAt: new Date().toISOString(),
            },
            opportunity.projectId
          );
        } catch (histErr) {
          this.logger.error(
            `Reply generation history write failed for opportunity ${id} (org ${org.id})`,
            histErr instanceof Error ? histErr.stack : histErr
          );
        }
        res.write(`data: ${JSON.stringify({ text: draft })}\n\n`);
        res.write(`data: [DONE]\n\n`);
      }
    } catch (err) {
      // Generation failed/aborted after the reservation was taken — uncount it.
      if (reservation) {
        await this._engageService
          .releaseReplyGeneration(reservation.taskId)
          .catch(() => undefined);
      }
      if ((err as Error)?.name === 'AbortError') {
        // Client disconnected — no-op; connection is already closed
        return;
      }
      // Gate blocks surface the precise reason (opportunity expired, monthly
      // cap reached, insufficient credits, …) so the UI can show why generation
      // was refused and prompt the right next step (upgrade / top-up).
      if (err instanceof ForbiddenException) {
        if (!res.writableEnded) {
          const response = err.getResponse();
          const payload =
            typeof response === 'object' && response !== null
              ? (response as Record<string, unknown>)
              : { message: response };
          res.write(
            `data: ${JSON.stringify({
              error: (payload.code as string) ?? 'forbidden',
              detail: payload,
            })}\n\n`
          );
          res.write(`data: [DONE]\n\n`);
        }
        if (!res.writableEnded) res.end();
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

  // ─── Save Draft (unpublished working copy) ───────────────────────────────

  @ApiOperation({
    summary:
      'Save (upsert) an unpublished working draft reply for an opportunity — one DRAFT per opportunity. Content may be AI-generated, edited, or hand-typed. Surfaces in GET /sent?status=awaiting (Post.state=DRAFT). Does NOT claim the opportunity, charge credits, or sync metrics.',
  })
  @ApiResponse({ status: 404, description: 'Opportunity not found' })
  @ApiResponse({
    status: 403,
    description:
      'Opportunity is no longer actionable (expired / replied / scheduled / dismissed)',
  })
  @Post('/opportunities/:id/save-draft')
  saveDraft(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body() body: SaveDraftDto
  ) {
    return this._engageService.saveDraft(org, id, body);
  }

  // ─── Send / Schedule Reply (X via Post pipeline) ─────────────────────────

  @ApiOperation({ summary: 'Cancel a scheduled reply and immediately send it' })
  @ApiResponse({
    status: 400,
    description: 'No scheduled reply found, or post already published',
  })
  @Post('/opportunities/:id/send-now')
  cancelAndSendNow(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Body() body: SendReplyDto
  ) {
    return this._engageService.cancelAndSendNow(org, user?.id, id, body);
  }

  @ApiOperation({
    summary: 'Schedule a reply to an opportunity for future publishing',
  })
  @ApiResponse({ status: 404, description: 'Opportunity not found' })
  @ApiResponse({
    status: 403,
    description:
      'Opportunity is no longer actionable (replied / scheduled / dismissed / expired) — carries a typed { code, message } reason',
  })
  @ApiResponse({
    status: 409,
    description: 'Opportunity was just claimed by another concurrent request',
  })
  @Post('/opportunities/:id/schedule')
  scheduleReply(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Body() body: ScheduleReplyDto
  ) {
    return this._engageService.scheduleReply(org, user?.id, id, body);
  }

  @ApiOperation({
    summary:
      'Schedule replies from multiple integrations at different times in one request',
  })
  @ApiResponse({
    status: 400,
    description:
      'Any scheduledAt is not in the future, or items array is invalid',
  })
  @ApiResponse({ status: 404, description: 'Opportunity not found' })
  @ApiResponse({
    status: 403,
    description:
      'Opportunity is no longer actionable (replied / scheduled / dismissed / expired) — carries a typed { code, message } reason',
  })
  @ApiResponse({
    status: 409,
    description: 'Opportunity was just claimed by another concurrent request',
  })
  @Post('/opportunities/:id/batch-schedule')
  batchScheduleReply(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Body() body: BatchScheduleReplyDto
  ) {
    return this._engageService.batchScheduleReply(org, user?.id, id, body);
  }

  @ApiOperation({
    summary:
      'Send replies from multiple integrations immediately in one request',
  })
  @ApiResponse({ status: 404, description: 'Opportunity not found' })
  @ApiResponse({
    status: 403,
    description:
      'Opportunity is no longer actionable (replied / scheduled / dismissed / expired) — carries a typed { code, message } reason',
  })
  @ApiResponse({
    status: 409,
    description: 'Opportunity was just claimed by another concurrent request',
  })
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

  @ApiOperation({
    summary:
      'Confirm a manual reply (Reddit or X) and record it in the system. X requires replyUrl + integrationId.',
  })
  @ApiResponse({ status: 404, description: 'Opportunity not found' })
  @ApiResponse({
    status: 403,
    description:
      'Opportunity is no longer actionable (replied / scheduled / dismissed / expired) — carries a typed { code, message } reason',
  })
  @ApiResponse({
    status: 409,
    description: 'Opportunity was just claimed by another concurrent request',
  })
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

  @ApiOperation({
    summary:
      'Locate the page of a given sentReplyId within /sent using the same filters. Returns null page when the reply does not match the filters.',
  })
  @Get('/sent/locate')
  locateSentReply(
    @GetOrgFromRequest() org: Organization,
    @Query() query: LocateSentReplyDto
  ) {
    return this._engageService.locateSentReply(org, query);
  }

  @ApiOperation({
    summary:
      "Paginated list of Engage replies. Optional status filter: published | scheduled | manual | error | draft, plus rollups — settled (published + scheduled) and awaiting (draft + manual link-pending + failed publishes) — and awaiting's own sub-filters for the Awaiting-review tabs: awaiting-draft (still-actionable draft), awaiting-expired (draft whose opportunity aged out), awaiting-link (link-pending or failed publish)",
  })
  @Get('/sent')
  listSentReplies(
    @GetOrgFromRequest() org: Organization,
    @Query() query: ListSentDto
  ) {
    return this._engageService.listSentReplies(org, query);
  }

  @ApiOperation({
    summary:
      'Aggregate stats for sent replies, scoped by the same date/platform/status filters as /sent (no date = all-time)',
  })
  @Get('/sent/stats')
  getSentStats(
    @GetOrgFromRequest() org: Organization,
    @Query() query: ListSentDto
  ) {
    return this._engageService.getSentStats(org, {
      date: query.date,
      platform: query.platform,
      status: query.status,
      projectId: query.projectId,
    });
  }

  @ApiOperation({
    summary:
      "Rollup for the sent tabs' badges: total + byPlatform + rollups (settled/awaiting) + awaitingBreakdown (drafts/link/expired) in one call, all computed under the SAME conditions — the /sent filter contract minus status/platform (those are the breakdown axes here, not filters). Replaces doing N separate limit=1 /sent calls just to read totals.",
  })
  @Get('/sent/counts/summary')
  getSentCountsSummary(
    @GetOrgFromRequest() org: Organization,
    @Query() query: SentCountsSummaryDto
  ) {
    return this._engageService.getSentCountsSummary(org, query);
  }

  @ApiOperation({
    summary:
      'Filtered counts under EXACTLY the same filters as GET /sent: `total` honors every filter (status/platform/date included, same number the list returns); each breakdown honors every filter except its own axis — byPlatform drops platform, rollups and awaitingBreakdown drop status — so badges stay complete while the other filters narrow them. Pagination params are accepted and ignored, so clients can reuse the list query string verbatim.',
  })
  @Get('/sent/count')
  countSentReplies(
    @GetOrgFromRequest() org: Organization,
    @Query() query: ListSentDto
  ) {
    return this._engageService.countSentReplies(org, query);
  }

  @ApiOperation({
    summary:
      'Lightweight status of one sent reply — for the frontends to poll while an in-browser extension reply posts and self-backfills. Returns { id, state, replyUrl }; replyUrl flips non-null on success.',
  })
  @ApiResponse({ status: 404, description: 'Sent reply not found' })
  @Get('/sent/:id/status')
  getSentReplyStatus(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this._engageService.getSentReplyStatus(org, id);
  }

  @ApiOperation({
    summary:
      'Get a single sent reply by id; response shape matches one item from /sent',
  })
  @ApiResponse({ status: 404, description: 'Sent reply not found' })
  @Get('/sent/:id')
  getSentReplyById(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this._engageService.getSentReplyItemById(org, id);
  }

  @ApiOperation({
    summary: 'Edit content / schedule of a scheduled (QUEUE) engage reply',
  })
  @ApiResponse({
    status: 400,
    description: 'Reply already sent, or scheduledAt is not in the future',
  })
  @ApiResponse({ status: 404, description: 'Sent reply not found' })
  @Patch('/sent/:id')
  updateScheduledReply(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body() body: UpdateScheduledReplyDto
  ) {
    return this._engageService.updateScheduledReply(org, id, body);
  }

  @ApiOperation({
    summary:
      'Submit the reply URL (+ optional author) for a manual reply (X or Reddit)',
  })
  @ApiResponse({ status: 404, description: 'Sent reply not found' })
  @ApiResponse({
    status: 400,
    description:
      'Invalid URL format, not an X/Reddit reply, or the reply is not a posted reply awaiting its link (e.g. still a DRAFT)',
  })
  @Patch('/sent/:id/reply-url')
  submitManualReplyUrl(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body() body: SubmitManualReplyUrlDto
  ) {
    return this._engageService.submitManualReplyUrl(
      org,
      id,
      body.url,
      body.author
    );
  }

  @ApiOperation({
    summary:
      'Extension publish-on-success callback: backfill the reply URL, flip the saved DRAFT to PUBLISHED, claim the opportunity, and charge — the only place the extension reply path bills. Idempotent for an already-published reply.',
  })
  @ApiResponse({ status: 404, description: 'Sent reply not found' })
  @ApiResponse({
    status: 400,
    description: 'Only valid for X or Reddit replies',
  })
  @Patch('/sent/:id/publish-reply')
  publishExtensionReply(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Body() body: PublishExtensionReplyDto
  ) {
    return this._engageService.publishExtensionReply(
      org,
      user?.id,
      id,
      body.url,
      body.author
    );
  }

  @ApiOperation({
    summary:
      "Persist extension-scraped metrics for one published reply. The browser extension reads the reply's own page (X TweetDetail / Reddit comment .json) and posts the raw public counters here; the server computes impressions/traffic and returns the normalized metrics so the page can update the card in place.",
  })
  @ApiResponse({ status: 404, description: 'Sent reply not found' })
  @ApiResponse({
    status: 400,
    description:
      'Not an X/Reddit reply, platform mismatch, or the reply has no published post to attach metrics to',
  })
  @Patch('/sent/:id/metrics')
  ingestReplyMetrics(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body() body: IngestReplyMetricsDto
  ) {
    return this._engageService.ingestReplyMetrics(org, id, body);
  }

  // ─── Dashboard Stats ──────────────────────────────────────────────────────

  // Panel ① "Engage Performance": weekly count, response rate, impressions,
  // traffic index, likes/upvotes, per-platform split, and this week's best reply.
  @ApiOperation({
    summary:
      'Engage Performance panel: headline stats, optional platform filter, platform split, best reply',
  })
  @Get('/dashboard/summary')
  getDashboardSummary(
    @GetOrgFromRequest() org: Organization,
    @Query() query: DashboardSummaryDto
  ) {
    return this._engageService.getDashboardSummary(org, {
      projectId: query.projectId,
      platform: query.platform,
      date: query.date,
    });
  }

  // Panel ② "Your Posts" overlay: Engage reply counts bucketed by publish day.
  @ApiOperation({
    summary:
      'Daily Engage reply counts over a trailing window (for the Your Posts chart overlay)',
  })
  @Get('/dashboard/replies-trend')
  getDashboardRepliesTrend(
    @GetOrgFromRequest() org: Organization,
    @Query() query: DashboardRepliesTrendDto
  ) {
    return this._engageService.getDashboardRepliesTrend(
      org,
      query.period as 'daily' | 'weekly' | 'monthly' | undefined,
      query.projectId
    );
  }

  // Panel ③ "Traffic from Engage": total traffic index + per-reply breakdown.
  @ApiOperation({
    summary:
      'Total Engage traffic index plus per-reply breakdown (Traffic from Engage panel)',
  })
  @Get('/dashboard/traffics')
  getDashboardTraffics(
    @GetOrgFromRequest() org: Organization,
    @Query() query: DashboardTrafficsDto
  ) {
    return this._engageService.getDashboardTraffics(org, {
      projectId: query.projectId,
      platform: query.platform,
      limit: query.limit,
    });
  }

  // Panel ④ "Engage Impressions Trend": impressions by publish date and
  // platform, bucketed by period. Response shape matches /dashboard/impressions.
  @ApiOperation({
    summary:
      'Engage impressions trend by period and platform (daily/weekly/monthly)',
  })
  @Get('/dashboard/impressions')
  getDashboardImpressions(
    @GetOrgFromRequest() org: Organization,
    @Query() query: DashboardImpressionsDto
  ) {
    return this._engageService.getDashboardImpressions(
      org,
      (query.period as 'daily' | 'weekly' | 'monthly') || 'daily',
      query.projectId
    );
  }

  // Panel ⑤ "Top engage sources": engage replies grouped by the original post
  // author (traffic source), ranked by traffic index. Reuses the traffics query
  // params (optional platform filter + limit).
  @ApiOperation({
    summary:
      'Top engage traffic sources grouped by original author (Top engage sources panel)',
  })
  @Get('/dashboard/top-sources')
  getDashboardTopSources(
    @GetOrgFromRequest() org: Organization,
    @Query() query: DashboardTrafficsDto
  ) {
    return this._engageService.getDashboardTopSources(org, {
      projectId: query.projectId,
      platform: query.platform,
      limit: query.limit,
    });
  }

  // ─── Admin: resync metrics ─────────────────────────────────────────────────

  @ApiOperation({
    summary:
      'Re-fetch Reddit/X metrics for published engage replies with missing stats',
  })
  // Org-admin only: this re-fetches external Reddit/X metrics and must not be
  // triggerable by an ordinary org member. Throttled like the other
  // external-API endpoints (/scan, /draft) to bound the upstream call volume.
  @CheckPolicies([AuthorizationActions.Create, Sections.ADMIN])
  @Throttle({ default: { limit: 5, ttl: 3_600_000 } })
  @Post('/admin/resync-metrics')
  resyncEngageMetrics(
    @GetOrgFromRequest() org: Organization,
    @Query('platform') platform?: string,
    @Query('dry_run') dryRun?: string
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
  @ApiOperation({
    summary:
      'Manually wake up engage reply-metrics collection and return before/after stats.',
  })
  @CheckPolicies([AuthorizationActions.Create, Sections.ADMIN])
  @Throttle({ default: { limit: 5, ttl: 3_600_000 } })
  @Post('/admin/sync-metrics')
  syncEngageMetrics(
    @GetOrgFromRequest() org: Organization,
    @Query('platform') platform?: string,
    @Query('dry_run') dryRun?: string,
    @Query('backfill') backfill?: string
  ) {
    return this._engageService.syncEngageMetricsWithStats(org, {
      platform,
      dryRun: dryRun === 'true',
      backfill: backfill !== 'false',
    });
  }
}
