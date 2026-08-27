import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import { PlatformPacingConfigService } from '@gitroom/nestjs-libraries/engage/platform-pacing-config.service';
import { EngageEntitlementService } from '@gitroom/nestjs-libraries/engage/engage-entitlement.service';
import { EngageScanConfigService } from '@gitroom/nestjs-libraries/engage/engage-scan-config.service';
import { MetricsDueDto } from '@gitroom/nestjs-libraries/dtos/posts/metrics-due.dto';
import { MetricsIngestDto } from '@gitroom/nestjs-libraries/dtos/posts/metrics-ingest.dto';
import { PostReleaseService } from '@gitroom/nestjs-libraries/database/prisma/post-releases/post-release.service';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { Organization, User } from '@prisma/client';
import { GetPostsDto } from '@gitroom/nestjs-libraries/dtos/posts/get.posts.dto';
import { GetPostsListDto } from '@gitroom/nestjs-libraries/dtos/posts/get.posts-list.dto';
import { LocatePostInListDto } from '@gitroom/nestjs-libraries/dtos/posts/locate.post-in-list.dto';
import { GetPostReleasesDto } from '@gitroom/nestjs-libraries/dtos/posts/get.post-releases.dto';
import { CheckPolicies } from '@gitroom/backend/services/auth/permissions/permissions.ability';
import { ApiBody, ApiOkResponse, ApiTags, getSchemaPath } from '@nestjs/swagger';
import { GeneratorDto } from '@gitroom/nestjs-libraries/dtos/generator/generator.dto';
import { CreateGeneratedPostsDto } from '@gitroom/nestjs-libraries/dtos/generator/create.generated.posts.dto';
import { AgentGraphService } from '@gitroom/nestjs-libraries/agent/agent.graph.service';
import { Response } from 'express';
import { GetUserFromRequest } from '@gitroom/nestjs-libraries/user/user.from.request';
import { ShortLinkService } from '@gitroom/nestjs-libraries/short-linking/short.link.service';
import { CreateTagDto } from '@gitroom/nestjs-libraries/dtos/posts/create.tag.dto';
import { CreatePostDto } from '@gitroom/nestjs-libraries/dtos/posts/create.post.dto';
import { MarkExtensionPublishedDto } from '@gitroom/nestjs-libraries/dtos/posts/mark-extension-published.dto';
import { MarkExtensionPublishFailedDto } from '@gitroom/nestjs-libraries/dtos/posts/mark-extension-publish-failed.dto';
import { SchedulePostsDto } from '@gitroom/nestjs-libraries/dtos/posts/schedule-posts.dto';
import {
  AuthorizationActions,
  Sections,
} from '@gitroom/backend/services/auth/permissions/permission.exception.class';
import { GetTimezone } from '@gitroom/nestjs-libraries/user/timezone.from.request';

@ApiTags('Posts')
@Controller('/posts')
export class PostsController {
  constructor(
    private _postsService: PostsService,
    private _postReleaseService: PostReleaseService,
    private _agentGraphService: AgentGraphService,
    private _shortLinkService: ShortLinkService,
    private _engageEntitlement: EngageEntitlementService,
    private _engageScanConfig: EngageScanConfigService,
    private _platformPacing: PlatformPacingConfigService
  ) {}

  /**
   * Demand-driven metrics fetch gate for the browser extension. The extension
   * sends the post ids it is currently viewing (one page); the server resolves
   * the org's effective monitoring window + fetch interval and returns ONLY the
   * subset due for a refresh — the "visible ∩ due" intersection. Covers own
   * posts and engage replies alike (both are Post rows).
   *
   * Session-risky platforms (LinkedIn/Medium/Quora — fetched by driving the
   * user's own logged-in session) are additionally gated by the scan platform
   * allowlist, the same single switch that gates their scan tasks. The
   * extension has no build-time flag for them anymore, so filtering here is
   * what keeps a disallowed platform's session untouched. Public-API platforms
   * (Reddit/Dev.to/HN) and X (extension-side ENGAGE_X_ENABLED build gate) are
   * not filtered.
   */
  @Post('/metrics/due')
  async getDueMetrics(
    @GetOrgFromRequest() org: Organization,
    @Body() body: MetricsDueDto
  ) {
    const [windowDays, intervalHours, allowedPlatforms] = await Promise.all([
      this._engageEntitlement.getMetricsWindowDays(org.id),
      this._engageEntitlement.getMetricsFetchIntervalHours(org.id),
      this._engageScanConfig.getSupportedScanPlatforms(),
    ]);
    const due = await this._postsService.getDueMetricsPosts(
      org.id,
      body.ids,
      windowDays,
      intervalHours
    );
    const sessionGated = new Set(['linkedin', 'medium', 'quora']);
    const allowed = new Set<string>(allowedPlatforms);
    const filtered = due.filter((p) => {
      const platform = p.integration?.providerIdentifier;
      return !platform || !sessionGated.has(platform) || allowed.has(platform);
    });
    return { windowDays, intervalHours, due: filtered };
  }

  /**
   * Ingest for the demand-driven fetch: the extension submits the metrics it
   * read from the platform (on the user's own session) for the viewed posts.
   * Pure data submission — the server makes NO provider API call; it resolves
   * each post's platform from ownership, runs the same extract/traffic pipeline
   * as the OAuth analytics sync, persists impressions/traffic/snapshot, and
   * stamps `lastMetricsFetchAt` so the interval gate holds. Named `ingest` to
   * match `/engage/scan-tasks/ingest` (same concept: extension submits fetched
   * data, server only persists).
   */
  @Post('/metrics/ingest')
  async ingestMetrics(
    @GetOrgFromRequest() org: Organization,
    @Body() body: MetricsIngestDto
  ) {
    return this._postsService.ingestMetrics(org.id, body.items as any);
  }

  /**
   * @deprecated Legacy alias of POST /metrics/ingest, kept only so already-
   * deployed browser extensions (which still POST to /metrics/backfill) keep
   * working until they update. Remove once old extension builds are phased out.
   */
  @Post('/metrics/backfill')
  async ingestMetricsLegacy(
    @GetOrgFromRequest() org: Organization,
    @Body() body: MetricsIngestDto
  ) {
    return this._postsService.ingestMetrics(org.id, body.items as any);
  }

  @Get('/:id/statistics')
  async getStatistics(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this._postsService.getStatistics(org.id, id);
  }

  @Post('/should-shortlink')
  async shouldShortlink(@Body() body: { messages: string[] }) {
    return { ask: this._shortLinkService.askShortLinkedin(body.messages) };
  }

  @Post('/:id/comments')
  async createComment(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Body() body: { comment: string }
  ) {
    return this._postsService.createComment(org.id, user.id, id, body.comment);
  }

  @Get('/tags')
  async getTags(@GetOrgFromRequest() org: Organization) {
    return { tags: await this._postsService.getTags(org.id) };
  }

  @Post('/tags')
  async createTag(
    @GetOrgFromRequest() org: Organization,
    @Body() body: CreateTagDto
  ) {
    return this._postsService.createTag(org.id, body);
  }

  @Put('/tags/:id')
  async editTag(
    @GetOrgFromRequest() org: Organization,
    @Body() body: CreateTagDto,
    @Param('id') id: string
  ) {
    return this._postsService.editTag(id, org.id, body);
  }

  @Get('/')
  @ApiOkResponse({
    description: 'Returns a list of posts',
    schema: {
      type: 'object',
      properties: {
        posts: {
          type: 'array',
          items: { type: 'object' },
        },
      },
    },
  })
  async getPosts(
    @GetOrgFromRequest() org: Organization,
    @Query() query: GetPostsDto,
    @GetTimezone() tz?: string
  ) {
    const posts = await this._postsService.getPosts(org.id, query, tz);

    return {
      posts,
    };
  }

  @Get('/find-slot')
  async findSlot(
    @GetOrgFromRequest() org: Organization,
    @Query('projectId') projectId?: string
  ) {
    return {
      date: await this._postsService.findFreeDateTime(
        org.id,
        undefined,
        projectId
      ),
    };
  }

  @Get('/find-slot/:id')
  async findSlotIntegration(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Query('projectId') projectId?: string
  ) {
    return {
      date: await this._postsService.findFreeDateTime(org.id, id, projectId),
    };
  }

  @Get('/release-list')
  async getPostReleases(
    @GetOrgFromRequest() org: Organization,
    @Query() query: GetPostReleasesDto
  ) {
    return this._postReleaseService.getReleasesForPostPaginated(
      query.postId,
      org.id,
      query.page,
      query.pageSize
    );
  }

  @Get('/list')
  @ApiOkResponse({
    description: 'Returns a paginated list of posts',
    schema: {
      type: 'object',
      properties: {
        total: { type: 'number' },
        posts: { type: 'array', items: { type: 'object' } },
      },
    },
  })
  async getPostsList(
    @GetOrgFromRequest() org: Organization,
    @Query() query: GetPostsListDto
  ) {
    return this._postsService.getPostsList(org.id, query);
  }

  @Get('/list/locate')
  @ApiOkResponse({
    description:
      'Locate the page of a given postId within /posts/list using the same filters and sort. Returns null page when the post does not match the filters.',
    schema: {
      type: 'object',
      properties: {
        found: { type: 'boolean' },
        page: { type: 'number', nullable: true },
        position: { type: 'number', nullable: true },
        total: { type: 'number' },
        pageSize: { type: 'number' },
        totalPages: { type: 'number' },
      },
    },
  })
  async locatePostInList(
    @GetOrgFromRequest() org: Organization,
    @Query() query: LocatePostInListDto
  ) {
    return this._postsService.locatePostInList(org.id, query);
  }

  @Get('/old')
  oldPosts(
    @GetOrgFromRequest() org: Organization,
    @Query('date') date: string
  ) {
    return this._postsService.getOldPosts(org.id, date);
  }

  @Get('/group/:group')
  getPostsByGroup(@GetOrgFromRequest() org: Organization, @Param('group') group: string) {
    return this._postsService.getPostsByGroup(org.id, group);
  }

  /**
   * Read-only backlog counts for the extension publish queue.
   *
   * Separate route rather than a flag on POST /publish-due, because that one
   * LEASES what it returns: a client polling it to render a number would hold
   * a batch away from the browser meant to publish it for the whole lease
   * window. Nothing here claims, stamps or state-changes anything.
   *
   * MUST stay declared BEFORE `@Get('/:id')` — a later static route would be
   * shadowed by the param route and resolve 'publish-due' as an id.
   */
  @Get('/publish-due/count')
  async countDuePublish(@GetOrgFromRequest() org: Organization) {
    return this._postsService.countDuePublishPosts(org.id);
  }

  /**
   * Publish-method capability for the scheduling/editor UI: for EVERY registered
   * platform, which send paths (extension / api) are selectable, the default the
   * backend would auto-pick, and whether an account must be connected first.
   *
   * A pure, side-effect-free read of ORG-level state (the platform registry ∩ the
   * org's bound accounts), so it is a GET with no parameters and the client is
   * expected to fetch it ONCE and cache it — same shape as GET /engage/config —
   * rather than per post or per editor keystroke.
   *
   * Org-scoped, so any signed-in user can call it: GET /admin/social-providers is
   * superadmin-only and static, and cannot answer "does THIS org have a bound
   * account". The UI renders the choice from this before committing via
   * POST /posts/schedule or setting posts[].publishMethod on POST /posts.
   *
   * MUST stay declared BEFORE `@Get('/:id')` — a later static route would be
   * shadowed by the `:id` wildcard and never reached.
   */
  @Get('/publish-methods')
  async getPublishMethods(@GetOrgFromRequest() org: Organization) {
    return this._postsService.getPublishMethods(org.id);
  }

  @Get('/:id')
  getPost(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Query('projectId') projectId?: string
  ) {
    return this._postsService.getPost(org.id, id, false, projectId);
  }

  @Post('/')
  @ApiBody({ type: CreatePostDto })
  @ApiOkResponse({
    description: 'Creates one or more posts',
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          postId: { type: 'string' },
          // null for a post with no bound account (published by the extension,
          // platform carried by providerIdentifier).
          integration: { type: 'string', nullable: true },
          state: { type: 'string' },
          releaseURL: { type: 'string', nullable: true },
        },
      },
    },
  })
  @CheckPolicies([AuthorizationActions.Create, Sections.POSTS_PER_MONTH])
  async createPost(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Body() rawBody: any
  ) {
    const body = await this._postsService.mapTypeToPost(rawBody, org.id);
    return this._postsService.createPost(org.id, body, user.id);
  }

  @Post('/generator/draft')
  @CheckPolicies([AuthorizationActions.Create, Sections.POSTS_PER_MONTH])
  generatePostsDraft(
    @GetOrgFromRequest() org: Organization,
    @Body() body: CreateGeneratedPostsDto
  ) {
    return this._postsService.generatePostsDraft(org.id, body);
  }

  @Post('/generator')
  @CheckPolicies([AuthorizationActions.Create, Sections.POSTS_PER_MONTH])
  async generatePosts(
    @GetOrgFromRequest() org: Organization,
    @Body() body: GeneratorDto,
    @Res({ passthrough: false }) res: Response
  ) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    for await (const event of this._agentGraphService.start(org.id, body)) {
      res.write(JSON.stringify(event) + '\n');
    }

    res.end();
  }

  @Delete('/:group')
  deletePost(
    @GetOrgFromRequest() org: Organization,
    @Param('group') group: string
  ) {
    return this._postsService.deletePost(org.id, group);
  }

  @Delete('/id/:id')
  deletePostById(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this._postsService.deletePostById(org.id, id);
  }

  @Post('/:id/retry')
  retryPost(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this._postsService.retryPost(org.id, id);
  }

  @Put('/:id/date')
  changeDate(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body('date') date: string
  ) {
    return this._postsService.changeDate(org.id, id, date);
  }

  /**
   * Commit a batch of hand-picked DRAFT posts to the send queue (DRAFT ->
   * QUEUE): the DB QUEUE state becomes the single source of truth and the send
   * path (extension vs API) is decided here per post. API posts start their
   * Temporal workflow; extension posts stay QUEUE for the extension publish-due
   * loop. Returns per-post scheduled/failed so one unbindable platform never
   * blocks the rest.
   *
   * Explicit ids only. Committing a whole operation plan lives at
   * POST /projects/:projectId/automation/publishing — see SchedulePostsDto for
   * why that moved off this route.
   */
  @Post('/schedule')
  async schedulePosts(
    @GetOrgFromRequest() org: Organization,
    @Body() body: SchedulePostsDto
  ) {
    return this._postsService.schedulePosts(org.id, body.posts);
  }

  @Post('/separate-posts')
  async separatePosts(
    @GetOrgFromRequest() org: Organization,
    @Body() body: { content: string; len: number }
  ) {
    return this._postsService.separatePosts(body.content, body.len);
  }

  /**
   * Extension publish-on-success callback: the browser extension published this
   * Post in-browser (X / Reddit) with the user's own platform session and
   * reports back the permalink (+ platform post id). Flip the saved Post to
   * PUBLISHED and backfill releaseURL/releaseId — the Post-side mirror of
   * PATCH /engage/sent/:id/publish-reply. Org-scoped and idempotent.
   */
  @Patch('/:id/extension-published')
  markExtensionPublished(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body() body: MarkExtensionPublishedDto
  ) {
    return this._postsService.markPublishedFromExtension(
      org.id,
      id,
      body.releaseURL,
      body.releaseId,
      body.segments
    );
  }

  /**
   * Extension publish-failed callback: the in-browser send settled as an error,
   * so flip the row QUEUE → ERROR with the reason instead of leaving it in
   * QUEUE to be re-offered forever. Org-scoped; a row already PUBLISHED is
   * never touched.
   *
   * `segments` makes a PARTIAL thread failure recordable: the segments that did
   * publish are marked PUBLISHED with their own permalinks and only the rest
   * becomes ERROR. Optional, so an older extension keeps the all-or-nothing
   * behaviour.
   */
  @Patch('/:id/extension-publish-failed')
  markExtensionPublishFailed(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body() body: MarkExtensionPublishFailedDto
  ) {
    return this._postsService.markPublishFailedFromExtension(
      org.id,
      id,
      body?.error,
      body?.segments
    );
  }

  /**
   * Extension publish-due: the browser extension polls this for QUEUE posts on
   * extension-routed integrations (hackernews/quora, or any platform routed via
   * EXTENSION_PUBLISH_PLATFORMS) that are due to publish. It publishes each
   * in-browser with the user's own session and reports back via
   * PATCH /:id/extension-published. Org-scoped; the backend makes no provider
   * API call (backend = scheduler, extension = executor — same as metrics/due).
   */
  @Post('/publish-due')
  async getDuePublish(
    @GetOrgFromRequest() org: Organization,
    @Body() body: { limit?: number }
  ) {
    const [due, pacing] = await Promise.all([
      this._postsService.getDuePublishPosts(org.id, body?.limit),
      this._platformPacing.getPlatformPacing(),
    ]);
    // Spread, so the `due` key this endpoint has always returned is untouched —
    // it is an EXECUTION CONTRACT field, and the extension reads `data.due`
    // directly. `pacing` is added beside it.
    //
    // It rides at the top level rather than on each item because it describes
    // the platform ACCOUNT, not any single post, and the extension installs it
    // once for every track to read.
    //
    // Sent here as well as on /engage/reply-due because the two polls are
    // independent — an org that publishes but never runs engage would otherwise
    // never receive a config change and would be stuck on the extension's
    // built-in floor, with no way for an operator to tune it.
    return { ...due, pacing };
  }

  @Post('/sync-metrics')
  async syncPostMetrics(
    @GetOrgFromRequest() org: Organization,
    @Body() body: { platform: string; externalPostId: string; metrics: Record<string, number> }
  ) {
    const result = await this._postsService.syncPostMetrics(
      org.id,
      body.platform,
      body.externalPostId,
      body.metrics ?? {}
    );
    return result;
  }
}
