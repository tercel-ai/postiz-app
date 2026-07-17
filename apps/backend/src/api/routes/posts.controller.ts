import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import { EngageEntitlementService } from '@gitroom/nestjs-libraries/engage/engage-entitlement.service';
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
    private _engageEntitlement: EngageEntitlementService
  ) {}

  /**
   * Demand-driven metrics fetch gate for the browser extension. The extension
   * sends the post ids it is currently viewing (one page); the server resolves
   * the org's effective monitoring window + fetch interval and returns ONLY the
   * subset due for a refresh — the "visible ∩ due" intersection. Covers own
   * posts and engage replies alike (both are Post rows).
   */
  @Post('/metrics/due')
  async getDueMetrics(
    @GetOrgFromRequest() org: Organization,
    @Body() body: MetricsDueDto
  ) {
    const [windowDays, intervalHours] = await Promise.all([
      this._engageEntitlement.getMetricsWindowDays(org.id),
      this._engageEntitlement.getMetricsFetchIntervalHours(org.id),
    ]);
    const due = await this._postsService.getDueMetricsPosts(
      org.id,
      body.ids,
      windowDays,
      intervalHours
    );
    return { windowDays, intervalHours, due };
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
  async findSlot(@GetOrgFromRequest() org: Organization) {
    return { date: await this._postsService.findFreeDateTime(org.id) };
  }

  @Get('/find-slot/:id')
  async findSlotIntegration(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return { date: await this._postsService.findFreeDateTime(org.id, id) };
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
          integration: { type: 'string' },
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

  @Post('/separate-posts')
  async separatePosts(
    @GetOrgFromRequest() org: Organization,
    @Body() body: { content: string; len: number }
  ) {
    return this._postsService.separatePosts(body.content, body.len);
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
