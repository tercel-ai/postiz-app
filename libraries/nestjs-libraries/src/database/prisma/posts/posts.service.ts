import {
  BadRequestException,
  Injectable,
  Logger,
  ValidationPipe,
} from '@nestjs/common';
import { PostsRepository } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.repository';
import { CreatePostDto } from '@gitroom/nestjs-libraries/dtos/posts/create.post.dto';
import dayjs from 'dayjs';
import { IntegrationManager } from '@gitroom/nestjs-libraries/integrations/integration.manager';
import { Integration, Post, Media, From, State } from '@prisma/client';
import { GetPostsDto } from '@gitroom/nestjs-libraries/dtos/posts/get.posts.dto';
import { GetPostsListDto } from '@gitroom/nestjs-libraries/dtos/posts/get.posts-list.dto';
import { LocatePostInListDto } from '@gitroom/nestjs-libraries/dtos/posts/locate.post-in-list.dto';
import { shuffle } from 'lodash';
import { CreateGeneratedPostsDto } from '@gitroom/nestjs-libraries/dtos/generator/create.generated.posts.dto';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import { makeId } from '@gitroom/nestjs-libraries/services/make.is';
import utc from 'dayjs/plugin/utc';
import { MediaService } from '@gitroom/nestjs-libraries/database/prisma/media/media.service';
import { ShortLinkService } from '@gitroom/nestjs-libraries/short-linking/short.link.service';
import { CreateTagDto } from '@gitroom/nestjs-libraries/dtos/posts/create.tag.dto';
import axios from 'axios';
import sharp from 'sharp';
import { UploadFactory } from '@gitroom/nestjs-libraries/upload/upload.factory';
import { Readable } from 'stream';
import { OpenaiService } from '@gitroom/nestjs-libraries/openai/openai.service';
dayjs.extend(utc);
import * as Sentry from '@sentry/nestjs';
import { TemporalService } from 'nestjs-temporal-core';
import { TypedSearchAttributes } from '@temporalio/common';
import {
  organizationId,
  postId as postIdSearchParam,
} from '@gitroom/nestjs-libraries/temporal/temporal.search.attribute';
import { AnalyticsData } from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import { computeTrafficScore } from '@gitroom/nestjs-libraries/integrations/social/traffic.calculator';
import { extractMetrics } from '@gitroom/nestjs-libraries/integrations/social/analytics.utils';
import { timer } from '@gitroom/helpers/utils/timer';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';
import { RefreshToken } from '@gitroom/nestjs-libraries/integrations/social.abstract';
import { RefreshIntegrationService } from '@gitroom/nestjs-libraries/integrations/refresh.integration.service';
import { PostOverageService } from '@gitroom/nestjs-libraries/database/prisma/posts/post-overage.service';
import { PostingTimesV2 } from '@gitroom/nestjs-libraries/dtos/integrations/posting-times.types';
import { resolveTimeSlotsForDate } from '@gitroom/nestjs-libraries/dtos/integrations/posting-times.utils';
import { getSocialTaskQueue } from '@gitroom/nestjs-libraries/temporal/task-queue';
import {
  parseXHandle,
} from '@gitroom/nestjs-libraries/engage/resolve-x-reply-integration';
import { fetchXAuthorProfile } from '@gitroom/nestjs-libraries/engage/x-tweet';
import { EngageAuthorProfile } from '@gitroom/nestjs-libraries/engage/engage-author';
type PostWithConditionals = Post & {
  integration?: Integration;
  childrenPost: Post[];
};

@Injectable()
export class PostsService {
  private readonly logger = new Logger(PostsService.name);
  private storage = UploadFactory.createStorage();
  constructor(
    private _postRepository: PostsRepository,
    private _integrationManager: IntegrationManager,
    private _integrationService: IntegrationService,
    private _mediaService: MediaService,
    private _shortLinkService: ShortLinkService,
    private _openaiService: OpenaiService,
    private _temporalService: TemporalService,
    private _refreshIntegrationService: RefreshIntegrationService,
    private _postOverageService: PostOverageService
  ) {}

  searchForMissingThreeHoursPosts() {
    return this._postRepository.searchForMissingThreeHoursPosts();
  }

  /**
   * Pre-publish step for recurring posts: create a QUEUE clone as an
   * idempotent lock for the given cycle.  Returns:
   *  - { clone, alreadyHandled: true }  → skip publishing (already done)
   *  - { clone, alreadyHandled: false } → proceed to postSocial
   *  - null                             → not a recurring post
   */
  async prepareRecurringCycle(postId: string, expectedPublishDate: Date, claimToken: string) {
    const post = await this._postRepository.getPostById(postId);
    if (!post || !post.intervalInDays || post.intervalInDays <= 0 || post.parentPostId) {
      return null;
    }

    return this._postRepository.findOrCreateCycleClone(post, expectedPublishDate, claimToken);
  }

  /**
   * Post-publish step for recurring posts: mark the clone as
   * PUBLISHED or ERROR, then advance publishDate to the next cycle.
   * Always advances regardless of success/failure so the next cycle
   * is never blocked.
   */
  async finalizeRecurringCycle(
    postId: string,
    cloneId: string,
    expectedPublishDate: Date,
    result: {
      state: 'PUBLISHED' | 'ERROR';
      releaseId?: string;
      releaseURL?: string;
      error?: string;
    }
  ) {
    const post = await this._postRepository.getPostById(postId);
    if (!post || !post.intervalInDays) return;

    // 1. Finalize clone state
    await this._postRepository.finalizeCycleClone(cloneId, result);

    // 2. Advance publishDate to next cycle (always, regardless of result)
    const advanced = await this._postRepository.advancePublishDate(
      post.id,
      expectedPublishDate,
      post.intervalInDays
    );

    if (!advanced) {
      console.warn(
        `[finalizeRecurringCycle] publishDate already advanced for post ${postId} from ${expectedPublishDate}`
      );
    }
  }

  async claimPostForPublishing(id: string, claimToken: string): Promise<boolean> {
    return this._postRepository.claimPostForPublishing(id, claimToken);
  }

  async resetClaimForPost(id: string): Promise<void> {
    return this._postRepository.resetClaimForPost(id);
  }

  async markStaleQueuePostsAsError(): Promise<number> {
    return this._postRepository.markStaleQueuePostsAsError();
  }

  async updatePost(id: string, postId: string, releaseURL: string) {
    // Defense-in-depth: recurring originals must NEVER be directly published.
    // They use the clone-per-cycle mechanism (prepareRecurringCycle + finalizeRecurringCycle).
    const post = await this._postRepository.getPostById(id);
    if (post?.intervalInDays && post.intervalInDays > 0 && !post.parentPostId) {
      this.logger.error(
        `updatePost: Blocked direct publish of recurring original post ${id} (intervalInDays=${post.intervalInDays}). ` +
        `This indicates the workflow did not recognize the post as recurring. releaseId=${postId} releaseURL=${releaseURL}`
      );
      return null;
    }

    return this._postRepository.updatePost(id, postId, releaseURL);
  }

  async recordFailedRelease(postId: string, releaseId: string, error: string) {
    // Non-recurring failures are captured by changeState(ERROR) on the
    // original post.  This method is kept for backward compatibility but
    // recurring posts now use prepareRecurringCycle + finalizeRecurringCycle.
  }

  async checkPostAnalytics(
    orgId: string,
    postId: string,
    date: number,
    forceRefresh = false
  ): Promise<AnalyticsData[]> {
    const post = await this._postRepository.getPostById(postId, orgId);
    // No integration → no OAuth token to authenticate the analytics call. This
    // is the engage "manual reply without an X account" case: the reply exists
    // on-platform but Postiz has no connected account to read its metrics with.
    if (!post || !post.releaseId || !post.integration) {
      return [];
    }

    const integrationProvider = this._integrationManager.getSocialIntegration(
      post.integration.providerIdentifier
    );

    if (!integrationProvider.postAnalytics) {
      return [];
    }

    const getIntegration = post.integration!;

    if (
      dayjs(getIntegration?.tokenExpiration).isBefore(dayjs()) ||
      forceRefresh
    ) {
      const data = await this._refreshIntegrationService.refresh(
        getIntegration
      );
      if (!data) {
        return [];
      }

      const { accessToken } = data;

      if (accessToken) {
        getIntegration.token = accessToken;

        if (integrationProvider.refreshWait) {
          await timer(10000);
        }
      } else {
        await this._integrationService.disconnectChannel(orgId, getIntegration);
        return [];
      }
    }

    const getIntegrationData = await ioRedis.get(
      `integration:${orgId}:${post.id}:${date}`
    );
    if (getIntegrationData) {
      return JSON.parse(getIntegrationData);
    }

    try {
      const loadAnalytics = await integrationProvider.postAnalytics(
        getIntegration.internalId,
        getIntegration.token,
        post.releaseId,
        date
      );

      // Append computed Traffic score as an additional metric
      const trafficScore = computeTrafficScore(
        post.integration.providerIdentifier,
        loadAnalytics
      );
      if (trafficScore !== null) {
        loadAnalytics.push({
          label: 'Traffic',
          data: [{ total: String(trafficScore), date: dayjs.utc().format('YYYY-MM-DD') }],
          percentageChange: 0,
        });
      }

      // 5-minute TTL — balances platform rate limits against UX freshness.
      // Most platform APIs update post-level metrics on a 1-15min cadence, so
      // shorter TTLs (e.g. 60s) would mostly hit unchanged data; 1h felt
      // noticeably stale for users watching engagement come in.
      await ioRedis.set(
        `integration:${orgId}:${post.id}:${date}`,
        JSON.stringify(loadAnalytics),
        'EX',
        !process.env.NODE_ENV || process.env.NODE_ENV === 'development'
          ? 1
          : 300
      );

      const { impressions, trafficScore: extractedTrafficScore, rawMetrics } =
        extractMetrics(post.integration.providerIdentifier, loadAnalytics);
      if (impressions > 0 || extractedTrafficScore !== null) {
        this._postRepository
          .batchUpdatePostAnalytics([
            {
              id: post.id,
              // Only write impressions when > 0: a transient/partial read that
              // reports 0 impressions must not clobber a real value captured by
              // an earlier successful sync. The trafficScore/analytics snapshot
              // is still refreshed each sync.
              impressions: impressions > 0 ? impressions : undefined,
              trafficScore: extractedTrafficScore ?? undefined,
              analytics: rawMetrics,
            },
          ])
          .catch((e) =>
            console.error(`Post analytics write-back error for ${post.id}:`, e)
          );
      }

      return loadAnalytics;
    } catch (e: any) {
      if (e instanceof RefreshToken) {
        return this.checkPostAnalytics(orgId, postId, date, true);
      }
      // Re-throw rate limit errors so callers (e.g. dashboard) can detect and skip
      if (e?.code === 429 || e?.rateLimit) {
        throw e;
      }
      console.log(e);
    }

    return [];
  }

  /**
   * App-only analytics fallback for X ENGAGE replies whose own integration token
   * is dead (expired + refresh failed / refreshNeeded). Reads the reply tweet's
   * public_metrics via an app-only bearer minted from X_API_KEY/X_API_SECRET (no
   * user token), then appends Traffic and writes back to the Post using the SAME
   * machinery as checkPostAnalytics. Returns the analytics array, or [] if the
   * app-only read yielded nothing.
   *
   * Engage-only by design — do NOT route regular posts here. A normal post's
   * integration IS its author, so a dead token there should prompt the user to
   * reconnect, not silently fall back to app-level credentials.
   *
   * impression_count + bookmark_count are part of public_metrics and ARE returned
   * by the app-only token (they are not owner-only), so this fallback yields the
   * full metric set, not a degraded subset.
   */
  async checkPostAnalyticsAppOnly(
    orgId: string,
    postId: string,
    date: number
  ): Promise<AnalyticsData[]> {
    const post = await this._postRepository.getPostById(postId, orgId);
    if (!post || !post.releaseId) {
      return [];
    }
    const providerIdentifier = post.integration?.providerIdentifier ?? 'x';
    if (providerIdentifier !== 'x') {
      return [];
    }

    const xProvider = this._integrationManager.getSocialIntegration('x') as {
      postAnalyticsAppOnly?: (postId: string, date: number) => Promise<AnalyticsData[]>;
    };
    if (typeof xProvider?.postAnalyticsAppOnly !== 'function') {
      return [];
    }

    const loadAnalytics = await xProvider.postAnalyticsAppOnly(post.releaseId, date);
    if (!loadAnalytics || loadAnalytics.length === 0) {
      return [];
    }

    const trafficScore = computeTrafficScore('x', loadAnalytics);
    if (trafficScore !== null) {
      loadAnalytics.push({
        label: 'Traffic',
        data: [{ total: String(trafficScore), date: dayjs.utc().format('YYYY-MM-DD') }],
        percentageChange: 0,
      });
    }

    const { impressions, trafficScore: extractedTrafficScore, rawMetrics } =
      extractMetrics('x', loadAnalytics);
    if (impressions > 0 || extractedTrafficScore !== null) {
      this._postRepository
        .batchUpdatePostAnalytics([
          {
            id: post.id,
            impressions: impressions > 0 ? impressions : undefined,
            trafficScore: extractedTrafficScore ?? undefined,
            analytics: rawMetrics,
          },
        ])
        .catch((e) =>
          console.error(`Post app-only analytics write-back error for ${post.id}:`, e)
        );
    }

    return loadAnalytics;
  }

  /**
   * Engage X analytics read with a token fallback chain. Used by the demand-
   * driven reply-metrics sync (EngageService.refreshMetricsForPosts) and any
   * manual/admin resync, so they behave identically:
   *   1. the reply's own integration token — but only when that integration is
   *      healthy (not refreshNeeded/disabled/deleted), so a dead token doesn't
   *      burn a doomed refresh;
   *   2. app-only fallback (checkPostAnalyticsAppOnly) — full metrics incl.
   *      impression + bookmark, zero user token, works even with no live account.
   *
   * Engage-only: regular posts must keep using checkPostAnalytics directly (a
   * normal post's integration IS its author — a dead token there means reconnect).
   */
  async checkEngageXAnalyticsWithFallback(
    orgId: string,
    postId: string,
    date: number
  ): Promise<AnalyticsData[]> {
    const post = await this._postRepository.getPostById(postId, orgId);
    if (!post || !post.releaseId) {
      return [];
    }
    const intg = post.integration;
    const userTokenViable =
      !!intg && !intg.refreshNeeded && !intg.disabled && !intg.deletedAt;

    if (userTokenViable) {
      const primary = await this.checkPostAnalytics(orgId, postId, date);
      if (Array.isArray(primary) && primary.length > 0) {
        return primary;
      }
    }

    return this.checkPostAnalyticsAppOnly(orgId, postId, date);
  }

  /**
   * Best-effort lookup of an engage reply's author (the @handle in the reply URL)
   * for storing in Post.settings.engageAuthor. Prefers an org-connected X account's
   * OAuth token — refreshing it when expired — so author enrichment (id / name /
   * avatar) works WITHOUT a global X_BEARER_TOKEN. Falls back, inside
   * fetchXAuthorProfile, to the app-only bearer and finally to handle-only. Never
   * throws.
   *
   * Engage-only: the org's own connected account is just a credential to read a
   * PUBLIC profile by username; it is unrelated to who authored the reply.
   */
  async fetchEngageXAuthor(
    orgId: string,
    replyUrl: string | null | undefined
  ): Promise<EngageAuthorProfile | null> {
    if (!parseXHandle(replyUrl)) return null;

    let token: string | undefined;
    try {
      const integrations = await this._integrationService.getIntegrationsList(orgId);
      const x = (integrations || []).find(
        (i) =>
          i.providerIdentifier === 'x' &&
          !i.disabled &&
          !i.deletedAt &&
          !i.refreshNeeded
      );
      if (x) {
        if (x.tokenExpiration && dayjs(x.tokenExpiration).isBefore(dayjs())) {
          const refreshed = await this._refreshIntegrationService
            .refresh(x)
            .catch(() => false as const);
          token = refreshed && refreshed.accessToken ? refreshed.accessToken : undefined;
        } else {
          token = x.token;
        }
      }
    } catch {
      /* best-effort: fall through to app-only / handle-only */
    }

    return fetchXAuthorProfile(replyUrl, token);
  }

  async getStatistics(orgId: string, id: string) {
    const getPost = await this.getPostsRecursively(id, true, orgId, true);
    const content = getPost.map((p) => p.content);
    const shortLinksTracking = await this._shortLinkService.getStatistics(
      content
    );

    return {
      clicks: shortLinksTracking,
    };
  }

  async mapTypeToPost(
    body: CreatePostDto,
    organization: string,
    replaceDraft: boolean = false
  ): Promise<CreatePostDto> {
    if (!body?.posts?.every((p) => p?.integration?.id)) {
      throw new BadRequestException('All posts must have an integration id');
    }

    const mappedValues = {
      ...body,
      type: replaceDraft ? 'schedule' : body.type,
      posts: await Promise.all(
        body.posts.map(async (post) => {
          const integration = await this._integrationService.getIntegrationById(
            organization,
            post.integration.id
          );

          if (!integration) {
            throw new BadRequestException(
              `Integration with id ${post.integration.id} not found`
            );
          }

          return {
            ...post,
            settings: {
              ...(post.settings || ({} as any)),
              __type: integration.providerIdentifier,
            },
          };
        })
      ),
    };

    const validationPipe = new ValidationPipe({
      skipMissingProperties: false,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    });

    return await validationPipe.transform(mappedValues, {
      type: 'body',
      metatype: CreatePostDto,
    });
  }

  async getPostsRecursively(
    id: string,
    includeIntegration = false,
    orgId?: string,
    isFirst?: boolean
  ): Promise<PostWithConditionals[]> {
    const post = await this._postRepository.getPost(
      id,
      includeIntegration,
      orgId,
      isFirst
    );

    if (!post) {
      return [];
    }

    return [
      post!,
      ...(post?.childrenPost?.length
        ? await this.getPostsRecursively(
            post?.childrenPost?.[0]?.id,
            false,
            orgId,
            false
          )
        : []),
    ];
  }

  async getPosts(orgId: string, query: GetPostsDto, tz?: string) {
    return this._postRepository.getPosts(orgId, query, tz);
  }

  async getPostsList(orgId: string, query: GetPostsListDto) {
    return this._postRepository.getPostsList(orgId, query);
  }

  async locatePostInList(orgId: string, query: LocatePostInListDto) {
    return this._postRepository.locatePostInList(orgId, query);
  }

  async getAllPostsList(query: GetPostsListDto & { organizationId?: string | string[] }) {
    return this._postRepository.getAllPostsList(query);
  }

  getPostByIdForAdmin(id: string) {
    return this._postRepository.getPostByIdForAdmin(id);
  }

  async updateMedia(id: string, imagesList: any[], convertToJPEG = false) {
    try {
      let imageUpdateNeeded = false;
      const getImageList = await Promise.all(
        (
          await Promise.all(
            (imagesList || []).map(async (p: any) => {
              if (!p.path && p.id) {
                imageUpdateNeeded = true;
                return this._mediaService.getMediaById(p.id);
              }

              return p;
            })
          )
        )
          .map((m) => {
            return {
              ...m,
              url:
                m.path.indexOf('http') === -1
                  ? process.env.FRONTEND_URL +
                    '/' +
                    process.env.NEXT_PUBLIC_UPLOAD_STATIC_DIRECTORY +
                    m.path
                  : m.path,
              type: 'image',
              path:
                m.path.indexOf('http') === -1
                  ? process.env.UPLOAD_DIRECTORY + m.path
                  : m.path,
            };
          })
          .map(async (m) => {
            if (!convertToJPEG) {
              return m;
            }

            if (m.path.indexOf('.png') > -1) {
              imageUpdateNeeded = true;
              const response = await axios.get(m.url, {
                responseType: 'arraybuffer',
              });

              const imageBuffer = Buffer.from(response.data);

              // Use sharp to get the metadata of the image
              const buffer = await sharp(imageBuffer)
                .jpeg({ quality: 100 })
                .toBuffer();

              const { path, originalname } = await this.storage.uploadFile({
                buffer,
                mimetype: 'image/jpeg',
                size: buffer.length,
                path: '',
                fieldname: '',
                destination: '',
                stream: new Readable(),
                filename: '',
                originalname: '',
                encoding: '',
              });

              return {
                ...m,
                name: originalname,
                url:
                  path.indexOf('http') === -1
                    ? process.env.FRONTEND_URL +
                      '/' +
                      process.env.NEXT_PUBLIC_UPLOAD_STATIC_DIRECTORY +
                      path
                    : path,
                type: 'image',
                path:
                  path.indexOf('http') === -1
                    ? process.env.UPLOAD_DIRECTORY + path
                    : path,
              };
            }

            return m;
          })
      );

      if (imageUpdateNeeded) {
        await this._postRepository.updateImages(
          id,
          JSON.stringify(getImageList)
        );
      }

      return getImageList;
    } catch (err: any) {
      return imagesList;
    }
  }

  async getPostsByGroup(orgId: string, group: string) {
    const convertToJPEG = false;
    const loadAll = await this._postRepository.getPostsByGroup(orgId, group);
    const posts = this.arrangePostsByGroup(loadAll, undefined);

    return {
      group: posts?.[0]?.group,
      posts: await Promise.all(
        (posts || []).map(async (post) => ({
          ...post,
          image: await this.updateMedia(
            post.id,
            JSON.parse(post.image || '[]'),
            convertToJPEG
          ),
        }))
      ),
      integrationPicture: posts[0]?.integration?.picture,
      integration: posts[0].integrationId,
      settings: JSON.parse(posts[0].settings || '{}'),
    };
  }

  arrangePostsByGroup(all: any, parent?: string): PostWithConditionals[] {
    const findAll = all
      .filter((p: any) =>
        !parent ? !p.parentPostId : p.parentPostId === parent
      )
      .map(({ integration, ...all }: any) => ({
        ...all,
        ...(!parent ? { integration } : {}),
      }));

    return [
      ...findAll,
      ...(findAll.length
        ? findAll.flatMap((p: any) => this.arrangePostsByGroup(all, p.id))
        : []),
    ];
  }

  async getPost(orgId: string, id: string, convertToJPEG = false) {
    const posts = await this.getPostsRecursively(id, true, orgId, true);
    const list = {
      group: posts?.[0]?.group,
      posts: await Promise.all(
        (posts || []).map(async (post) => ({
          ...post,
          image: await this.updateMedia(
            post.id,
            JSON.parse(post.image || '[]'),
            convertToJPEG
          ),
        }))
      ),
      integrationPicture: posts[0]?.integration?.picture,
      integration: posts[0].integrationId,
      settings: JSON.parse(posts[0].settings || '{}'),
    };

    return list;
  }

  async getOldPosts(orgId: string, date: string) {
    return this._postRepository.getOldPosts(orgId, date);
  }

  public async updateTags(orgId: string, post: Post[]): Promise<Post[]> {
    const plainText = JSON.stringify(post);
    const extract = Array.from(
      plainText.match(/\(post:[a-zA-Z0-9-_]+\)/g) || []
    );
    if (!extract.length) {
      return post;
    }

    const ids = (extract || []).map((e) =>
      e.replace('(post:', '').replace(')', '')
    );
    const urls = await this._postRepository.getPostUrls(orgId, ids);
    const newPlainText = ids.reduce((acc, value) => {
      const findUrl = urls?.find?.((u) => u.id === value)?.releaseURL || '';
      return acc.replace(
        new RegExp(`\\(post:${value}\\)`, 'g'),
        findUrl.split(',')[0]
      );
    }, plainText);

    return this.updateTags(orgId, JSON.parse(newPlainText) as Post[]);
  }

  public async checkInternalPlug(
    integration: Integration,
    orgId: string,
    id: string,
    settings: any
  ) {
    const plugs = Object.entries(settings).filter(([key]) => {
      return key.indexOf('plug-') > -1;
    });

    if (plugs.length === 0) {
      return [];
    }

    const parsePlugs = plugs.reduce((all, [key, value]) => {
      const [_, name, identifier] = key.split('--');
      all[name] = all[name] || { name };
      all[name][identifier] = value;
      return all;
    }, {} as any);

    const list: {
      name: string;
      integrations: { id: string }[];
      delay: string;
      active: boolean;
    }[] = Object.values(parsePlugs);

    return (list || []).flatMap((trigger) => {
      return (trigger?.integrations || []).flatMap((int) => ({
        type: 'internal-plug',
        post: id,
        originalIntegration: integration.id,
        integration: int.id,
        plugName: trigger.name,
        orgId: orgId,
        delay: +trigger.delay,
        information: trigger,
      }));
    });
  }

  public async checkPlugs(
    orgId: string,
    providerName: string,
    integrationId: string
  ) {
    const loadAllPlugs = this._integrationManager.getAllPlugs();
    const getPlugs = await this._integrationService.getPlugs(
      orgId,
      integrationId
    );

    const currentPlug = loadAllPlugs.find((p) => p.identifier === providerName);

    return getPlugs
      .filter((plug) => {
        return currentPlug?.plugs?.some(
          (p: any) => p.methodName === plug.plugFunction
        );
      })
      .map((plug) => {
        const runPlug = currentPlug?.plugs?.find(
          (p: any) => p.methodName === plug.plugFunction
        )!;
        return {
          type: 'global',
          plugId: plug.id,
          delay: runPlug.runEveryMilliseconds,
          totalRuns: runPlug.totalRuns,
        };
      });
  }

  async deletePost(orgId: string, group: string) {
    const post = await this._postRepository.deletePost(orgId, group);

    if (post?.id) {
      try {
        const workflows = this._temporalService.client
          .getRawClient()
          ?.workflow.list({
            query: `postId="${post.id}" AND ExecutionStatus="Running"`,
          });

        for await (const executionInfo of workflows) {
          try {
            const workflow =
              await this._temporalService.client.getWorkflowHandle(
                executionInfo.workflowId
              );
            if (
              workflow &&
              (await workflow.describe()).status.name !== 'TERMINATED'
            ) {
              await workflow.terminate();
            }
          } catch (err) {}
        }
      } catch (err) {}
    }

    return { error: true };
  }

  async countPostsFromDay(orgId: string, date: Date) {
    return this._postRepository.countPostsFromDay(orgId, date);
  }

  getPostByForWebhookId(id: string) {
    return this._postRepository.getPostByForWebhookId(id);
  }

  async startWorkflow(taskQueue: string, postId: string, orgId: string, postNow = false) {
    let terminated = false;
    try {
      const workflows = this._temporalService.client
        .getRawClient()
        ?.workflow.list({
          query: `postId="${postId}" AND ExecutionStatus="Running"`,
        });

      for await (const executionInfo of workflows) {
        try {
          const workflow = await this._temporalService.client.getWorkflowHandle(
            executionInfo.workflowId
          );
          if (
            workflow &&
            (await workflow.describe()).status.name !== 'TERMINATED'
          ) {
            await workflow.terminate();
            terminated = true;
          }
        } catch (err) {}
      }
    } catch (err) {}

    // If a previous workflow was terminated, it may have already claimed the post
    // (set releaseId). Reset releaseId so the new workflow can claim it.
    if (terminated) {
      await this._postRepository.resetClaimForPost(postId);
    }

    const rawClient = this._temporalService.client.getRawClient();
    if (!rawClient) {
      const msg = `Temporal client unavailable — cannot start workflow for postId=${postId}`;
      this.logger.error(`startWorkflow: ${msg}`);
      throw new Error(msg);
    }

    await rawClient.workflow.start('postWorkflowV101', {
      workflowId: `post_${postId}`,
      taskQueue: 'main',
      args: [
        {
          taskQueue: taskQueue,
          postId: postId,
          organizationId: orgId,
          postNow: postNow,
          ...(postNow ? { postNowRetry: process.env.POST_NOW_RETRY === 'true' } : {}),
        },
      ],
      typedSearchAttributes: new TypedSearchAttributes([
        {
          key: postIdSearchParam,
          value: postId,
        },
        {
          key: organizationId,
          value: orgId,
        },
      ]),
    });

    // When postNow=true, poll until the first attempt resolves (PUBLISHED/ERROR)
    // so the caller gets immediate feedback. Retries (if enabled) continue in background.
    if (postNow) {
      const maxWaitMs = 60_000; // 1 minute max
      const intervalMs = 500;
      const start = Date.now();
      while (Date.now() - start < maxWaitMs) {
        const post = await this._postRepository.getPostById(postId);
        if (post && post.state !== 'QUEUE') {
          return; // PUBLISHED or ERROR — first attempt done
        }
        await new Promise((r) => setTimeout(r, intervalMs));
      }
      this.logger.warn(`startWorkflow: postNow poll timed out after ${maxWaitMs}ms for postId=${postId}`);
    }
  }

  async createPost(orgId: string, body: CreatePostDto, userId?: string): Promise<any[]> {
    this.logger.log(
      `createPost: orgId=${orgId} userId=${userId ?? 'N/A'} type=${body.type} postsCount=${body.posts?.length ?? 0}`
    );
    const postList = [];
    const postNowErrors: string[] = [];
    const allCreatedPostIds: string[] = [];
    for (const post of body.posts) {
      const messages = (post.value || []).map((p) => p.content);
      const updateContent = !body.shortLink
        ? messages
        : await this._shortLinkService.convertTextToShortLinks(orgId, messages);

      post.value = (post.value || []).map((p, i) => ({
        ...p,
        content: updateContent[i],
      }));

      const { posts } = await this._postRepository.createOrUpdatePost(
        body.type,
        orgId,
        body.type === 'now' ? dayjs().format('YYYY-MM-DDTHH:mm:00') : body.date,
        post,
        body.tags,
        body.inter,
        body.source
      );

      if (!posts?.length) {
        return [] as any[];
      }

      // Accumulate IDs so subsequent iterations won't soft-delete these posts
      allCreatedPostIds.push(...posts.map((p) => p.id));

      if (body.type === 'now') {
        try {
          await this.startWorkflow(
            getSocialTaskQueue(post.settings.__type),
            posts[0].id,
            orgId,
            true
          );
        } catch (err) {
          // Workflow failed or was rejected — check if post ended up as ERROR
          const failedPost = await this._postRepository.getPostById(posts[0].id);
          if (failedPost?.state === 'ERROR') {
            // Post already marked ERROR by the workflow — return it with error info
            this.logger.warn(`createPost: postNow workflow threw but post already in ERROR state, postId=${posts[0].id}: ${(err as Error)?.message || err}`);
          } else {
            await this.changeState(posts[0].id, 'ERROR', `Workflow failed: ${(err as Error)?.message || err}`);
          }
        }
      } else {
        this.startWorkflow(
          getSocialTaskQueue(post.settings.__type),
          posts[0].id,
          orgId
        ).catch((err) => {
          Sentry.captureException(err, {
            extra: { postId: posts[0].id, orgId },
          });
        });
      }

      Sentry.metrics.count('post_created', 1);
      const createdPostId = posts[0].id;

      // For postNow, fetch the final state after workflow completes.
      // Collect errors per account so all accounts are attempted before throwing.
      // Scheduled-post errors are saved to DB only (caller never waits for them).
      if (body.type === 'now') {
        const finalPost = await this._postRepository.getPostById(createdPostId);
        if (!finalPost || finalPost.state === 'ERROR') {
          postNowErrors.push(finalPost?.error || 'Post failed');
        } else {
          postList.push({
            postId: createdPostId,
            integration: post.integration.id,
            state: finalPost.state,
            releaseURL: finalPost.releaseURL || null,
          });
        }
      } else {
        postList.push({
          postId: createdPostId,
          integration: post.integration.id,
        });
      }

      // Trigger overage deduction (fire-and-forget).
      // Pass body.source so the overage record is attributed to the actual
      // originator (calendar | chat | engage) instead of defaulting to 'calendar'.
      if (userId) {
        this._postOverageService
          .deductIfOverage(orgId, userId, createdPostId, body.source ?? 'calendar')
          .catch((err) => {
            this.logger.error(`createPost: deductIfOverage failed for postId=${createdPostId}:`, err);
          });
      } else {
        this.logger.warn(
          `createPost: skipping deductIfOverage for postId=${createdPostId} — no userId provided`
        );
      }
    }

    // Clean up stale QUEUE/DRAFT posts from previous edit AFTER all accounts are processed.
    // Must happen after the loop so no iteration soft-deletes a sibling that hasn't been upserted yet.
    const group = body.posts[0]?.group;
    const isEditingExisting = body.posts.some((p) => p.value?.some((v) => !!v.id));
    if (group && isEditingExisting && allCreatedPostIds.length > 0) {
      await this._postRepository.softDeleteGroupPosts(group, {
        excludeIds: allCreatedPostIds,
      });
    }

    if (postNowErrors.length > 0) {
      throw new BadRequestException(postNowErrors.join(' | '));
    }

    return postList;
  }

  async separatePosts(content: string, len: number) {
    return this._openaiService.separatePosts(content, len);
  }

  async logError(id: string, err?: any, body?: any) {
    return this._postRepository.logError(id, err, body);
  }

  async changeState(id: string, state: State, err?: any, body?: any) {
    // For recurring posts, don't set ERROR on the original — it needs to stay
    // QUEUE so that subsequent scheduled sends can proceed. The error is
    // captured in the cycle clone (via finalizeRecurringCycle) instead.
    if (state === 'ERROR') {
      const post = await this._postRepository.getPostById(id);
      if (post?.intervalInDays && post.intervalInDays > 0 && !post.parentPostId) {
        // Don't change original state, but log the error for observability
        await this._postRepository.logError(id, err, body);
        return;
      }
    }
    return this._postRepository.changeState(id, state, err, body);
  }

  async retryPost(orgId: string, postId: string) {
    const post = await this._postRepository.getPostById(postId, orgId);
    if (!post) {
      throw new BadRequestException('Post not found');
    }
    if (!post.integration) {
      throw new BadRequestException('Integration not found or has been removed');
    }
    if (post.state !== 'ERROR') {
      throw new BadRequestException('Only failed posts can be retried');
    }

    // Recurring originals should never be retried directly — they use the
    // clone-per-cycle mechanism.  Only clones (intervalInDays=null) or
    // plain non-recurring posts are retryable.
    if (post.intervalInDays && post.intervalInDays > 0 && !post.parentPostId) {
      throw new BadRequestException('Recurring posts cannot be retried directly');
    }

    // Fail fast: if integration is broken, don't bother starting a workflow.
    // The workflow would silently return without setting ERROR (pre-existing gap),
    // leaving the post stuck in QUEUE.
    if (post.integration.refreshNeeded) {
      throw new BadRequestException(
        `Cannot retry: ${post.integration.name} needs to be reconnected`
      );
    }
    if (post.integration.disabled) {
      throw new BadRequestException(
        `Cannot retry: ${post.integration.name} is disabled`
      );
    }

    // Recurring clones: only allow retry within the same day.
    // The next day a new clone is created automatically, so retrying old ones is pointless.
    // Non-recurring posts: no day restriction — there's no auto-retry mechanism for them.
    const isRecurringClone = !post.intervalInDays
      && await this._postRepository.hasRecurringOriginalInGroup(post.group);
    if (isRecurringClone && !dayjs.utc().isSame(dayjs.utc(post.publishDate), 'day')) {
      throw new BadRequestException('Can only retry recurring posts from today');
    }

    // Atomically reset clone to QUEUE — returns false if already reset (double-click guard)
    const didReset = await this._postRepository.resetPostForRetry(postId, orgId);
    if (!didReset) {
      throw new BadRequestException('Post is already being retried');
    }

    const taskQueue = getSocialTaskQueue(post.integration.providerIdentifier);
    try {
      // Clone has no intervalInDays, so the workflow treats it as a normal (non-recurring) post
      await this.startWorkflow(taskQueue, postId, orgId, true);
    } catch (err) {
      // Only set ERROR if the post is still QUEUE (workflow never ran or failed before publishing).
      // If the post is already PUBLISHED or ERROR, the workflow handled it — don't overwrite.
      const failedPost = await this._postRepository.getPostById(postId);
      if (failedPost?.state === 'QUEUE') {
        await this.changeState(postId, 'ERROR', `Retry workflow failed: ${(err as Error)?.message || err}`);
      }
    }

    const finalPost = await this._postRepository.getPostById(postId);
    if (!finalPost || finalPost.state === 'ERROR') {
      throw new BadRequestException(finalPost?.error || 'Retry failed');
    }

    // Safety net: if the workflow returned without publishing (e.g., integration
    // state changed between our check and the workflow execution), the post is
    // stuck in QUEUE.  Reset it back to ERROR so the user can try again later.
    if (finalPost.state === 'QUEUE') {
      await this.changeState(postId, 'ERROR',
        'Retry did not complete — the integration may need to be reconnected');
      throw new BadRequestException('Retry did not complete — check your integration status');
    }

    return {
      postId: finalPost.id,
      state: finalPost.state,
      releaseURL: finalPost.releaseURL || null,
    };
  }

  /**
   * Reschedule a QUEUE post.
   *
   * Two gates protect against the "modify-mid-publish" race that causes
   * duplicate sends on the social platform:
   *   1. claim gate — releaseId='claim_xxx' means a workflow has already
   *      claimed this post and may be in postSocial. Terminating its workflow
   *      cannot cancel the in-flight HTTP call to the platform, so any new
   *      workflow we start would publish a second copy.
   *   2. window gate — workflow timer fires exactly at publishDate. Refusing
   *      changes within RESCHEDULE_LOCKOUT_MS guarantees the workflow is still
   *      sleeping when startWorkflow runs, making terminate() clean.
   *      30s covers worker scheduling + visibility-index lag + clock skew,
   *      well above the few seconds startWorkflow itself takes to complete.
   */
  async changeDate(orgId: string, id: string, date: string) {
    const RESCHEDULE_LOCKOUT_MS = 30_000;

    const post = await this._postRepository.getPostById(id, orgId);
    if (!post) throw new BadRequestException('Post not found');
    if (!post.integration) {
      throw new BadRequestException('Integration not found or has been removed');
    }
    if (post.state !== 'QUEUE') {
      throw new BadRequestException('Post is not pending — cannot reschedule');
    }
    if (post.releaseId?.startsWith('claim_')) {
      throw new BadRequestException(
        'Post is already being published — cannot reschedule. Please wait for the result.'
      );
    }
    const msToPublish = dayjs(post.publishDate).diff(dayjs(), 'millisecond');
    if (msToPublish < RESCHEDULE_LOCKOUT_MS) {
      const seconds = Math.max(0, Math.ceil(msToPublish / 1000));
      throw new BadRequestException(
        `Post will be published in ${seconds}s — too late to reschedule.`
      );
    }

    const newDate = await this._postRepository.changeDate(orgId, id, date);

    try {
      await this.startWorkflow(
        getSocialTaskQueue(post.integration.providerIdentifier),
        post.id,
        orgId
      );
    } catch (err) {
      this.logger.error(
        `changeDate: startWorkflow failed for postId=${id}: ${(err as Error)?.message || err}`
      );
      Sentry.captureException(err, { extra: { postId: id, orgId, date } });
      throw new BadRequestException('Reschedule failed, please try again');
    }

    return newDate;
  }

  async generatePostsDraft(orgId: string, body: CreateGeneratedPostsDto) {
    const getAllIntegrations = (
      await this._integrationService.getIntegrationsList(orgId)
    ).filter((f) => !f.disabled && f.providerIdentifier !== 'reddit');

    // const posts = chunk(body.posts, getAllIntegrations.length);
    const allDates = dayjs()
      .isoWeek(body.week)
      .year(body.year)
      .startOf('isoWeek');

    const dates = [...new Array(7)].map((_, i) => {
      return allDates.add(i, 'day').format('YYYY-MM-DD');
    });

    const findTime = (): string => {
      const totalMinutes = Math.floor(Math.random() * 144) * 10;

      // Convert total minutes to hours and minutes
      const hours = Math.floor(totalMinutes / 60);
      const minutes = totalMinutes % 60;

      // Format hours and minutes to always be two digits
      const formattedHours = hours.toString().padStart(2, '0');
      const formattedMinutes = minutes.toString().padStart(2, '0');
      const randomDate =
        shuffle(dates)[0] + 'T' + `${formattedHours}:${formattedMinutes}:00`;

      if (dayjs(randomDate).isBefore(dayjs())) {
        return findTime();
      }

      return randomDate;
    };

    for (const integration of getAllIntegrations) {
      for (const toPost of body.posts) {
        const group = makeId(10);
        const randomDate = findTime();

        await this.createPost(orgId, {
          type: 'draft',
          date: randomDate,
          order: '',
          shortLink: false,
          tags: [],
          posts: [
            {
              group,
              integration: {
                id: integration.id,
              },
              settings: {
                __type: integration.providerIdentifier as any,
                title: '',
                tags: [],
                subreddit: [],
              },
              value: [
                ...toPost.list.map((l) => ({
                  id: '',
                  content: l.post,
                  delay: 0,
                  image: [],
                })),
                {
                  id: '',
                  delay: 0,
                  content: `Check out the full story here:\n${
                    body.postId || body.url
                  }`,
                  image: [],
                },
              ],
            },
          ],
        });
      }
    }
  }

  findAllExistingCategories() {
    return this._postRepository.findAllExistingCategories();
  }

  findAllExistingTopicsOfCategory(category: string) {
    return this._postRepository.findAllExistingTopicsOfCategory(category);
  }

  findPopularPosts(category: string, topic?: string) {
    return this._postRepository.findPopularPosts(category, topic);
  }

  async findFreeDateTime(orgId: string, integrationId?: string) {
    const timesConfig = await this._integrationService.findFreeDateTime(
      orgId,
      integrationId
    );
    return this.findFreeDateTimeRecursive(
      orgId,
      timesConfig,
      dayjs.utc().startOf('day')
    );
  }

  async createPopularPosts(post: {
    category: string;
    topic: string;
    content: string;
    hook: string;
  }) {
    return this._postRepository.createPopularPosts(post);
  }

  private async findFreeDateTimeRecursive(
    orgId: string,
    timesConfig: PostingTimesV2,
    date: dayjs.Dayjs,
    depth = 0
  ): Promise<string> {
    if (depth >= 365) {
      throw new BadRequestException(
        'No available posting time slot found within the next 365 days'
      );
    }

    const times = resolveTimeSlotsForDate(timesConfig, date);

    if (!times.length) {
      return this.findFreeDateTimeRecursive(
        orgId,
        timesConfig,
        date.add(1, 'day'),
        depth + 1
      );
    }

    const list = await this._postRepository.getPostsCountsByDates(
      orgId,
      times,
      date
    );

    if (!list.length) {
      return this.findFreeDateTimeRecursive(
        orgId,
        timesConfig,
        date.add(1, 'day'),
        depth + 1
      );
    }

    const num = list.reduce<null | number>((prev, curr) => {
      if (prev === null || prev > curr) {
        return curr;
      }
      return prev;
    }, null) as number;

    return date.clone().add(num, 'minutes').format('YYYY-MM-DDTHH:mm:00');
  }

  getComments(postId: string) {
    return this._postRepository.getComments(postId);
  }

  getTags(orgId: string) {
    return this._postRepository.getTags(orgId);
  }

  createTag(orgId: string, body: CreateTagDto) {
    return this._postRepository.createTag(orgId, body);
  }

  editTag(id: string, orgId: string, body: CreateTagDto) {
    return this._postRepository.editTag(id, orgId, body);
  }

  createComment(
    orgId: string,
    userId: string,
    postId: string,
    comment: string
  ) {
    return this._postRepository.createComment(orgId, userId, postId, comment);
  }

  /**
   * Resolve which of the candidate (currently-viewed) post ids are DUE for a
   * metrics fetch, given the org's effective monitoring window (days) and fetch
   * interval (hours). Translates the policy values into concrete date cutoffs
   * and delegates the filtered query to the repository.
   */
  getDueMetricsPosts(
    orgId: string,
    ids: string[],
    windowDays: number,
    intervalHours: number
  ) {
    if (!ids?.length) {
      return Promise.resolve([]);
    }
    const now = dayjs.utc();
    const windowStart = now.subtract(windowDays, 'day').toDate();
    const intervalCutoff = now.subtract(intervalHours, 'hour').toDate();
    return this._postRepository.getDueMetricsPosts(
      orgId,
      ids,
      windowStart,
      intervalCutoff
    );
  }

  /** Stamp the given org-owned posts as fetched-now (backfill dedup gate). */
  markMetricsFetched(orgId: string, ids: string[]) {
    if (!ids?.length) {
      return Promise.resolve({ count: 0 });
    }
    return this._postRepository.markMetricsFetched(orgId, ids, dayjs.utc().toDate());
  }

  /**
   * Ingest post metrics fetched by the browser extension (demand-driven path).
   * This is a pure DATA SUBMISSION — the extension read the metrics on the
   * user's own session client-side; the server makes NO provider API call, it
   * only persists. For each org-owned post, the platform is resolved server-side
   * (never trusting the caller) and the SAME pipeline as `checkPostAnalytics` is
   * run: `extractMetrics` derives impressions + the weighted Traffic score and
   * the raw snapshot, which are persisted; impressions are only overwritten when
   * positive so a partial read never clobbers an earlier real value. Every
   * org-owned post in the batch is then stamped fetched (dedup gate holds even
   * when a post legitimately has zero metrics).
   */
  async ingestMetrics(
    orgId: string,
    items: { postId: string; analytics: AnalyticsData[] }[]
  ): Promise<{ updated: string[]; stamped: string[] }> {
    if (!items?.length) {
      return { updated: [], stamped: [] };
    }
    const ids = items.map((i) => i.postId);
    const posts = await this._postRepository.getPostsProviderByIds(orgId, ids);
    const providerById = new Map(
      posts.map((p) => [p.id, p.integration?.providerIdentifier])
    );

    const updates: Array<{
      id: string;
      impressions?: number;
      trafficScore?: number;
      analytics?: any;
    }> = [];
    const stamped: string[] = [];

    for (const item of items) {
      const platform = providerById.get(item.postId);
      // Not org-owned, or no connected integration to attribute a platform to →
      // skip silently (auth boundary; also nothing to weight metrics against).
      if (!platform) {
        continue;
      }
      stamped.push(item.postId);
      const { impressions, trafficScore, rawMetrics } = extractMetrics(
        platform,
        item.analytics ?? []
      );
      if (impressions > 0 || trafficScore !== null) {
        updates.push({
          id: item.postId,
          impressions: impressions > 0 ? impressions : undefined,
          trafficScore: trafficScore ?? undefined,
          analytics: rawMetrics,
        });
      }
    }

    await this._postRepository.batchUpdatePostAnalytics(updates);
    await this.markMetricsFetched(orgId, stamped);
    // NOTE: no API-usage/cost telemetry here on purpose. This endpoint is a pure
    // DATA SUBMISSION — the browser extension already read the metrics on the
    // user's own session client-side, so the backend makes NO social-provider
    // API call and incurs NO app API cost. API-cost stats track backend provider
    // calls only; counting client-submitted data here would misattribute cost.
    return { updated: updates.map((u) => u.id), stamped };
  }

  /**
   * Sync extension-fetched metrics directly into a Post (matched by releaseURL
   * containing the external post id). No re-fetch; client-side data only.
   */
  async syncPostMetrics(
    orgId: string,
    platform: string,
    externalPostId: string,
    metrics: Record<string, number>
  ): Promise<{ updated: boolean }> {
    if (!platform || !externalPostId || !metrics || !Object.keys(metrics).length) {
      return { updated: false };
    }
    return this._postRepository.syncPostMetrics(orgId, externalPostId, metrics);
  }
}
