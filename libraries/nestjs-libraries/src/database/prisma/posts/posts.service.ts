import {
  BadRequestException,
  Injectable,
  Logger,
  ValidationPipe,
} from '@nestjs/common';
import { PostsRepository } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.repository';
import { CreatePostDto } from '@gitroom/nestjs-libraries/dtos/posts/create.post.dto';
import { randomUUID } from 'crypto';
import dayjs from 'dayjs';
import {
  IntegrationManager,
  PublishMethod,
  PublishMethodError,
  isExtensionOnlyProvider,
  isExtensionPublishablePlatform,
  resolvePublishMethod,
} from '@gitroom/nestjs-libraries/integrations/integration.manager';
import { Integration, Post, Media, From, State, PublishMethod as PrismaPublishMethod } from '@prisma/client';
import { GetPostsDto } from '@gitroom/nestjs-libraries/dtos/posts/get.posts.dto';
import { GetPostsListDto } from '@gitroom/nestjs-libraries/dtos/posts/get.posts-list.dto';
import { LocatePostInListDto } from '@gitroom/nestjs-libraries/dtos/posts/locate.post-in-list.dto';
import { shuffle } from 'lodash';
import { CreateGeneratedPostsDto } from '@gitroom/nestjs-libraries/dtos/generator/create.generated.posts.dto';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import { makeId } from '@gitroom/nestjs-libraries/services/make.is';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { MediaService } from '@gitroom/nestjs-libraries/database/prisma/media/media.service';
import { ShortLinkService } from '@gitroom/nestjs-libraries/short-linking/short.link.service';
import { CreateTagDto } from '@gitroom/nestjs-libraries/dtos/posts/create.tag.dto';
import axios from 'axios';
import sharp from 'sharp';
import { UploadFactory } from '@gitroom/nestjs-libraries/upload/upload.factory';
import { Readable } from 'stream';
import { OpenaiService } from '@gitroom/nestjs-libraries/openai/openai.service';
dayjs.extend(utc);
dayjs.extend(timezone);
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
import { stripHtmlValidation } from '@gitroom/helpers/utils/strip.html.validation';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';
import { RefreshToken } from '@gitroom/nestjs-libraries/integrations/social.abstract';
import { RefreshIntegrationService } from '@gitroom/nestjs-libraries/integrations/refresh.integration.service';
import { PostOverageService } from '@gitroom/nestjs-libraries/database/prisma/posts/post-overage.service';
import {
  DEFAULT_MIN_GAP_MINUTES,
  ExtensionPublishConfigService,
  redistributePublishTimeIfOutsideWindow,
  redistributePublishTimesWithinWindow,
} from '@gitroom/nestjs-libraries/database/prisma/posts/extension-publish-config.service';
import { titleFromSettings } from '@gitroom/nestjs-libraries/database/prisma/posts/settings-title';
import { ProjectValidationService } from '@gitroom/nestjs-libraries/projects/project-validation.service';
import {
  isPublishingActive,
  ProjectPublishingService,
} from '@gitroom/nestjs-libraries/automation/project-publishing.service';
import { PublishPlatform } from '@gitroom/helpers/extension/post-publish';
import { PostingTimesV2 } from '@gitroom/nestjs-libraries/dtos/integrations/posting-times.types';
import { resolveTimeSlotsForDate } from '@gitroom/nestjs-libraries/dtos/integrations/posting-times.utils';
import { getSocialTaskQueue } from '@gitroom/nestjs-libraries/temporal/task-queue';
import {
  parseXHandle,
} from '@gitroom/nestjs-libraries/engage/resolve-x-reply-integration';
import { fetchXAuthorProfile } from '@gitroom/nestjs-libraries/engage/x-tweet';
import { EngageAuthorProfile } from '@gitroom/nestjs-libraries/engage/engage-author';
/**
 * One thread segment the extension reported as PUBLISHED (the transport shape is
 * PublishedSegmentDto). `postId` is OUR Post id echoed from the due-item, so
 * segments are settled by identity rather than by position in the list — the
 * chain can change during the lease window, and a positional match would stamp a
 * live permalink onto the wrong row.
 */
interface PublishedSegment {
  postId: string;
  url?: string;
  releaseId?: string;
}

type PostWithConditionals = Post & {
  integration?: Integration;
  childrenPost: Post[];
};

function resolveScheduledPostPlatform(post: {
  providerIdentifier?: string | null;
  integration?: { providerIdentifier?: string | null } | null;
  settings?: unknown;
}) {
  const persistedPlatform =
    post.providerIdentifier || post.integration?.providerIdentifier;
  if (persistedPlatform) return persistedPlatform;

  try {
    const settings =
      typeof post.settings === 'string'
        ? JSON.parse(post.settings)
        : post.settings;
    return typeof (settings as { __type?: unknown } | null)?.__type === 'string'
      ? (settings as { __type: string }).__type
      : '';
  } catch {
    return '';
  }
}

/**
 * How close to its publish time a QUEUE post stops being reschedulable.
 *
 * The workflow's timer fires exactly at publishDate, so refusing changes inside
 * this window is what guarantees the workflow is still SLEEPING when
 * startWorkflow terminates it — which is what makes the terminate clean. 30s
 * covers worker scheduling + visibility-index lag + clock skew, well above the
 * few seconds startWorkflow itself takes.
 *
 * Shared by changeDate (one post, rejects) and rescheduleQueuedPlanPosts (a
 * batch, skips): the two disagree about what to DO about it, never about where
 * the line is.
 */
const RESCHEDULE_LOCKOUT_MS = 30_000;

/**
 * Why a post the window pass looked at was left where it is.
 *
 * `claimed` / `imminent` are the two changeDate gates — a send that may already
 * be in flight, and one too close to its timer to terminate cleanly.
 * `window-passed` is the pass declining to move a post BACKWARDS across the
 * clock (see _resolveWindowPlacement).
 */
type SkipReason = 'claimed' | 'imminent' | 'window-passed';

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
    private _postOverageService: PostOverageService,
    private _extensionPublishConfigService: ExtensionPublishConfigService,
    // Optional so the many unit tests that build this service positionally keep
    // working; DatabaseModule always provides it at runtime.
    private _projectValidation?: ProjectValidationService,
    // Same reason as above. Only the project-scoped plan branch of
    // schedulePlanPosts touches it, and that branch requires a projectId the
    // legacy positional test callers never pass.
    private _projectPublishingService?: ProjectPublishingService
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

  /**
   * The single choke point every scheduled publish passes through, so it is
   * also where a deactivated project stops one. The post is flipped to ERROR
   * with an explanatory message rather than left in QUEUE: a QUEUE post that is
   * never claimed gets swept into a bare ERROR by markStaleQueuePostsAsError
   * anyway, and the user would see an unexplained failure. Nothing is deleted —
   * the post stays visible and can be rescheduled once the project is
   * reactivated.
   */
  async claimPostForPublishing(id: string, claimToken: string): Promise<boolean> {
    if (this._projectValidation) {
      const scope = await this._postRepository.getPostProjectScope(id);
      const active =
        !scope?.projectId ||
        (await this._projectValidation.isProjectActive(
          scope.organizationId,
          scope.projectId
        ));
      if (!active) {
        // Scope the write to a post still waiting in QUEUE: changeState is an
        // unconditional update by id, so writing unguarded would let a retried
        // activity turn an already-PUBLISHED post into an ERROR.
        if (scope?.state === 'QUEUE') {
          await this._postRepository.changeState(
            id,
            'ERROR',
            new Error(
              'Project is deactivated — publishing was skipped. Reactivate the project and reschedule this post.'
            )
          );
        }
        return false;
      }
    }

    return this._postRepository.claimPostForPublishing(id, claimToken);
  }

  async resetClaimForPost(id: string): Promise<void> {
    return this._postRepository.resetClaimForPost(id);
  }

  async markStaleQueuePostsAsError(): Promise<number> {
    // Pass the extension-routed providers so the sweep excludes both explicit
    // EXTENSION posts and legacy null-method posts on those integrations (they
    // wait for the browser, not Temporal — see repository method).
    return this._postRepository.markStaleQueuePostsAsError(
      this._integrationManager.extensionPublishProviderIds()
    );
  }

  /**
   * Extension publish-on-success callback for a Post. The browser extension
   * published the post in-browser (X / Reddit) with the user's own platform
   * session and reports the permalink (+ platform post id) back; flip the saved
   * Post to PUBLISHED and backfill its releaseURL/releaseId — the Post-side
   * mirror of the Engage `publishExtensionReply` closed loop. Org-scoped and
   * idempotent (a duplicate/retried callback for an already-PUBLISHED post is a
   * no-op success).
   */
  async markPublishedFromExtension(
    orgId: string,
    id: string,
    releaseURL?: string,
    releaseId?: string,
    segments?: PublishedSegment[]
  ): Promise<{ ok: boolean; alreadyPublished?: boolean; reason?: string }> {
    const post = await this._postRepository.getPostById(id, orgId);
    if (!post) return { ok: false, reason: 'not-found' };
    if (post.state === 'PUBLISHED') return { ok: true, alreadyPublished: true };
    // updatePost carries the recurring-original guard (returns null there).
    // releaseURL may be empty for a URL-less publish (e.g. Quora) — the post
    // still flips PUBLISHED so it leaves QUEUE and is never re-published.
    const updated = await this.updatePost(id, releaseId || '', releaseURL || '');
    if (!updated) return { ok: false, reason: 'blocked-recurring-original' };
    // A thread is published as ONE extension task that reports back against the
    // anchor only, so settle its children here. Best-effort: the anchor is
    // already PUBLISHED and must not be un-done because a follow-up write
    // failed — a child left QUEUE is recoverable, a re-published anchor is not.
    if (!post.parentPostId && post.group) {
      try {
        // Per-segment permalinks first, so each follow-up carries its OWN url
        // (they exist only in the extension's queue state — unrecoverable once
        // it settles). Then the group-wide sweep mops up anything not reported:
        // it is QUEUE-guarded, so it never touches what was just published, and
        // it is what keeps an older extension (no `segments`) working.
        const reported = new Map(
          (segments || [])
            .filter((sg) => sg?.postId && sg.postId !== id)
            .map((sg) => [sg.postId, sg])
        );
        if (reported.size) {
          // Only ids that are genuinely children of THIS chain. The reported
          // list is client input: without this intersection a caller could name
          // any other QUEUE post of the org and have a permalink stamped on it.
          // The failure path constrains the same way — the two must not differ.
          const nodes = await this._postRepository.getExtensionPublishChainNodes(
            orgId,
            [post.group]
          );
          const children = nodes
            .filter((n) => n.parentPostId && reported.has(n.id))
            .map((n) => ({
              id: n.id,
              url: reported.get(n.id)?.url,
              releaseId: reported.get(n.id)?.releaseId,
            }));
          if (children.length) {
            await this._postRepository.publishExtensionChainNodes(orgId, children);
          }
        }
        await this._postRepository.publishExtensionChainChildren(orgId, post.group);
      } catch (err) {
        this.logger.warn(
          `markPublishedFromExtension: settling thread children failed for postId=${id} group=${post.group}: ${(err as Error)?.message || err}`
        );
      }
    }
    return { ok: true };
  }

  /**
   * Extension publish-FAILED callback: the in-browser send settled as an error
   * (platform rejected it, wrong account, or the send could not be verified),
   * so flip the row QUEUE → ERROR with the reason. Without this the row sat in
   * QUEUE forever, re-offered on every publish-due poll. Org-scoped; never
   * touches a row that already reached PUBLISHED, and recurring originals keep
   * their clone-per-cycle mechanism untouched.
   *
   * PARTIAL SUCCESS is the normal case for a thread: segments publish one by one
   * and the run stops at the first failure, so the anchor is usually already
   * live. `segments` names the ones that went out — they are recorded PUBLISHED
   * with their own permalinks and only the remainder becomes ERROR. Marking a
   * live post ERROR would drop it out of every metrics path permanently: the
   * permalinks exist only in the extension's queue state, which is discarded
   * when the task settles.
   *
   * `partial` in the result tells the caller which shape it got.
   */
  async markPublishFailedFromExtension(
    orgId: string,
    id: string,
    error?: string,
    segments?: PublishedSegment[]
  ): Promise<{ ok: boolean; reason?: string; partial?: boolean; published?: number }> {
    const post = await this._postRepository.getPostById(id, orgId);
    if (!post) return { ok: false, reason: 'not-found' };
    if (post.state === 'PUBLISHED')
      return { ok: false, reason: 'already-published' };
    if (post.intervalInDays && post.intervalInDays > 0 && !post.parentPostId) {
      return { ok: false, reason: 'blocked-recurring-original' };
    }
    const reason = error || 'extension publish failed';
    const published = (segments || []).filter((sg) => sg?.postId);
    const publishedById = new Map(published.map((sg) => [sg.postId, sg]));

    // The ANCHOR itself is commonly among the published segments — a thread
    // breaks mid-chain, not at the start. Recording it ERROR while it is live on
    // the platform is the single worst outcome here, so settle it by what was
    // reported rather than by the callback's name.
    const anchorPublished = publishedById.get(id);
    if (anchorPublished) {
      await this._postRepository.publishExtensionChainNodes(orgId, [
        { id, url: anchorPublished.url, releaseId: anchorPublished.releaseId },
      ]);
    } else {
      await this._postRepository.changeState(id, 'ERROR', reason);
    }

    // Children are never re-offered on their own (the due query is roots-only),
    // so leaving them QUEUE strands them until the stale sweep renames the cause.
    if (!post.parentPostId && post.group) {
      try {
        if (published.length) {
          // Split the chain by what actually went out. Reading the chain back is
          // what makes "the rest" precise — the reported list alone cannot say
          // which nodes are missing from it.
          const nodes = await this._postRepository.getExtensionPublishChainNodes(
            orgId,
            [post.group]
          );
          const childIds = nodes
            .filter((n) => n.parentPostId && n.id !== id)
            .map((n) => n.id);
          const live = childIds
            .filter((cid) => publishedById.has(cid))
            .map((cid) => ({
              id: cid,
              url: publishedById.get(cid)?.url,
              releaseId: publishedById.get(cid)?.releaseId,
            }));
          const dead = childIds.filter((cid) => !publishedById.has(cid));
          if (live.length) {
            await this._postRepository.publishExtensionChainNodes(orgId, live);
          }
          await this._postRepository.failExtensionChainNodesByIds(orgId, dead, reason);
        } else {
          // Nothing reported → nothing went out (or an older extension that
          // cannot report). Previous all-or-nothing behaviour.
          await this._postRepository.failExtensionChainChildren(orgId, post.group, reason);
        }
      } catch (err) {
        this.logger.warn(
          `markPublishFailedFromExtension: settling thread children failed for postId=${id} group=${post.group}: ${(err as Error)?.message || err}`
        );
      }
    }
    return published.length
      ? { ok: true, partial: true, published: published.length }
      : { ok: true };
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
    // A post MAY have no integration: `Post.integrationId` is nullable, and
    // operation-plan posts for a platform the org never connected are
    // materialized without one and published in-browser by the extension, which
    // identifies the platform from `Post.providerIdentifier`. Such a post
    // therefore carries its own `providerIdentifier` (or, for back-compat,
    // `settings.__type`) and there is no account to look up — requiring an
    // integration here would make that whole flow unreachable over HTTP.
    const missingPlatform = (body?.posts || []).find(
      (p) => !p?.integration?.id && !p?.providerIdentifier && !(p?.settings as any)?.__type
    );
    if (missingPlatform) {
      throw new BadRequestException(
        'A post must have either an integration id or a providerIdentifier'
      );
    }

    const mappedValues = {
      ...body,
      type: replaceDraft ? 'schedule' : body.type,
      posts: await Promise.all(
        body.posts.map(async (post) => {
          // No account to resolve the platform from — keep the caller's
          // `providerIdentifier` (falling back to legacy `settings.__type`),
          // which the guard above proved is present.
          if (!post.integration?.id) {
            const providerIdentifier =
              post.providerIdentifier || (post.settings as any)?.__type;
            return { ...post, providerIdentifier };
          }

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
            providerIdentifier: integration.providerIdentifier,
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
    isFirst?: boolean,
    projectId?: string
  ): Promise<PostWithConditionals[]> {
    const post = await this._postRepository.getPost(
      id,
      includeIntegration,
      orgId,
      isFirst,
      projectId
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
            false,
            projectId
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

  async getAllPostsList(
    query: GetPostsListDto & {
      organizationId?: string | string[];
      publishMethod?: PrismaPublishMethod[];
    }
  ) {
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

  async getPost(
    orgId: string,
    id: string,
    convertToJPEG = false,
    projectId?: string
  ) {
    const posts = await this.getPostsRecursively(
      id,
      true,
      orgId,
      true,
      projectId
    );
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
      await this._terminateRunningWorkflow(post.id);
    }

    return { error: true };
  }

  async deletePostById(orgId: string, id: string) {
    const deleted = await this._postRepository.deletePostById(orgId, id);

    if (deleted) {
      await this._terminateRunningWorkflow(id);
    }

    return { error: true };
  }

  private async _terminateRunningWorkflow(postId: string) {
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
          }
        } catch (err) {}
      }
    } catch (err) {}
  }

  async countPostsFromDay(orgId: string, date: Date) {
    return this._postRepository.countPostsFromDay(orgId, date);
  }

  getPostByForWebhookId(id: string) {
    return this._postRepository.getPostByForWebhookId(id);
  }

  async startWorkflow(taskQueue: string, postId: string, orgId: string, postNow = false) {
    // Publishing divert: extension-published providers (hackernews/quora, or any
    // platform an operator routed to the extension via EXTENSION_PUBLISH_PLATFORMS)
    // are NOT published by Temporal — the backend has no usable write API for
    // them. Leave the Post in QUEUE; the browser extension's publish-due loop
    // claims it, publishes in-browser with the user's own session, and backfills
    // via /posts/:id/extension-published. No Temporal workflow is started, so no
    // recovery path re-triggers it. (postNow callers poll for a non-QUEUE state
    // and time out gracefully — the post is queued for the extension instead.)
    try {
      const post = await this._postRepository.getPostById(postId);
      // No integration (operation-plan post for an unconnected platform) means
      // the platform is only knowable from Post.providerIdentifier. Falls back
      // to the bound integration for the rare row written before the
      // providerIdentifier backfill ran. Without either, such a post would be
      // sent down the Temporal path, which has no account to publish with.
      const providerId =
        post?.providerIdentifier || post?.integration?.providerIdentifier || '';
      // The persisted publishMethod is authoritative (set at schedule time and
      // shared with the extension publish-due query, so the two paths stay
      // mutually exclusive). Only fall back to the platform-capability check when
      // it is unset (legacy posts created before the field existed).
      // Engage replies are NEVER extension-published: the publish-due query
      // excludes source='engage' (the due-item shape has no reply target), so
      // diverting one here would strand it in QUEUE with no executor. They are
      // stamped publishMethod=API at creation; this guard covers legacy rows.
      const isExtension =
        post?.source !== 'engage' &&
        (post?.publishMethod === 'EXTENSION' ||
          (post?.publishMethod == null &&
            !!providerId &&
            this._integrationManager.isExtensionPublish(providerId)));
      // A post with no bound account has nothing for Temporal to publish WITH,
      // and — not being extension-routed — nothing else will claim it either:
      // the extension publish-due query matches EXTENSION posts or null-method
      // posts on an extension-routed INTEGRATION, and a null integrationId is
      // neither. Left in QUEUE it would sit invisible until the 7-day stale
      // sweep flips it to ERROR with a message naming the wrong cause, so fail
      // it now, with the reason.
      if (post && !post.integrationId && !isExtension) {
        const reason = `No connected account for ${providerId || 'this platform'}, and it cannot be published by the browser extension`;
        this.logger.warn(
          `startWorkflow: postId=${postId} has no bound integration and is not extension-publishable — marking ERROR`
        );
        await this.changeState(postId, 'ERROR', reason);
        return;
      }
      if (isExtension) {
        this.logger.log(
          `startWorkflow: postId=${postId} is extension-published (method=${post?.publishMethod ?? 'legacy:' + providerId}) — skipping Temporal; it stays QUEUE for the browser extension`
        );
        return;
      }
    } catch (err) {
      // A lookup hiccup must not block normal publishing — fall through to the
      // regular Temporal path (the safe default for API-capable providers).
      this.logger.warn(
        `startWorkflow: extension-publish check failed for postId=${postId}, proceeding with Temporal: ${(err as Error)?.message || err}`
      );
    }

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

      // Explicit send-path choice on the editor: validate + resolve against the
      // post's platform + bound account, so an impossible choice (e.g. 'api' on
      // an extension-only platform, or on a post with no connected account) is
      // rejected up-front rather than stranding the post in QUEUE. Omitted →
      // undefined → routing falls back to the capability check at publish time.
      let resolvedMethod: PublishMethod | undefined;
      if (post.publishMethod) {
        try {
          resolvedMethod = resolvePublishMethod({
            platform: post.providerIdentifier || post.settings.__type,
            hasBoundIntegration: !!post.integration?.id,
            choice: post.publishMethod,
          });
        } catch (err) {
          if (err instanceof PublishMethodError) {
            throw new BadRequestException(err.message);
          }
          throw err;
        }
      }

      const { posts } = await this._postRepository.createOrUpdatePost(
        body.type,
        orgId,
        body.type === 'now' ? dayjs().format('YYYY-MM-DDTHH:mm:00') : body.date,
        post,
        body.tags,
        body.inter,
        body.source,
        body.projectId,
        resolvedMethod === 'api' ? 'API' : resolvedMethod === 'extension' ? 'EXTENSION' : undefined
      );

      if (!posts?.length) {
        return [] as any[];
      }

      // Accumulate IDs so subsequent iterations won't soft-delete these posts
      allCreatedPostIds.push(...posts.map((p) => p.id));

      if (body.type === 'now') {
        try {
          await this.startWorkflow(
            getSocialTaskQueue(post.providerIdentifier || post.settings.__type),
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
          getSocialTaskQueue(post.providerIdentifier || post.settings.__type),
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
            integration: post.integration?.id ?? null,
            state: finalPost.state,
            releaseURL: finalPost.releaseURL || null,
            // A postNow that comes back STILL QUEUE was not sent: either it is
            // extension-routed (startWorkflow skips Temporal by design and leaves
            // it for the extension's pull loop) or the Temporal poll timed out.
            // The caller cannot tell those apart from `state` alone, and they
            // need different things said to the user — so report the decision.
            publishMethod: finalPost.publishMethod,
          });
        }
      } else {
        postList.push({
          postId: createdPostId,
          integration: post.integration?.id ?? null,
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
    const post = await this._postRepository.getPostById(id, orgId);
    if (!post) throw new BadRequestException('Post not found');
    // An accountless post reaches QUEUE through POST /posts/schedule and is
    // published by the extension, so a missing integration is a legitimate
    // state here — resolve the platform from Post.providerIdentifier the same
    // way startWorkflow does, and reject only when neither source yields one.
    const platform =
      post.providerIdentifier || post.integration?.providerIdentifier || '';
    if (!platform) {
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
      await this.startWorkflow(getSocialTaskQueue(platform), post.id, orgId);
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

  async findFreeDateTime(
    orgId: string,
    integrationId?: string,
    projectId?: string
  ) {
    const timesConfig = await this._integrationService.findFreeDateTime(
      orgId,
      integrationId,
      projectId
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

  /**
   * Extension publish-due: the QUEUE posts on extension-routed integrations that
   * are due to publish, shaped for the browser extension's publish queue
   * (taskId = post.id, so its extension-published backfill flips the same row).
   * The extension publishes each in-browser with the user's own session; the
   * backend never calls a provider API here (mirrors metrics-due / scan-tasks:
   * backend = scheduler, extension = executor).
   */
  /**
   * Start of the window a still-valid lease must have been taken in. Shared by
   * the claim and the read-only count so the two can never disagree about which
   * posts are "already with a browser" — a count using a different cutoff would
   * report work as claimable that the very next poll refuses to hand out.
   */
  private static extensionLeaseCutoff(now: dayjs.Dayjs): Date {
    const leaseMinutes = Math.max(
      1,
      Number(process.env.EXTENSION_PUBLISH_LEASE_MINUTES) || 10
    );
    return now.subtract(leaseMinutes, 'minute').toDate();
  }

  /**
   * How much the extension publish queue is holding for this org, without
   * taking any of it — the read-only counterpart of {@link getDuePublishPosts},
   * which leases everything it returns and so cannot be polled for a display.
   */
  async countDuePublishPosts(orgId: string) {
    const providerIds = this._integrationManager.extensionPublishProviderIds();
    const now = dayjs.utc();
    return this._postRepository.countDueExtensionPublishPosts(
      orgId,
      providerIds,
      now.toDate(),
      PostsService.extensionLeaseCutoff(now)
    );
  }

  async getDuePublishPosts(orgId: string, limit = 10) {
    // providerIds only feeds the LEGACY (publishMethod=null) fallback branch;
    // explicit publishMethod=EXTENSION posts are returned regardless of it, so we
    // no longer short-circuit when the env allowlist is empty.
    const providerIds = this._integrationManager.extensionPublishProviderIds();
    const now = dayjs.utc();
    // Lease: hand each due post to at most one browser instance for the lease
    // window; only re-offer it once the lease expires (covers a crashed /
    // reinstalled extension that never backfilled). The token makes the claim
    // unambiguous under concurrency.
    const leaseToken = `ext_${randomUUID()}`;
    const leaseCutoff = PostsService.extensionLeaseCutoff(now);
    const rows = await this._postRepository.claimDueExtensionPublishPosts(
      orgId,
      providerIds,
      now.toDate(),
      Math.max(1, Math.min(limit, 50)),
      leaseToken,
      leaseCutoff
    );
    // Per-platform thread segment-gap ranges (admin-editable setting), resolved
    // once per poll and stamped on each item so the extension paces threads the
    // way the operator configured, not by its own hardcoded fallback.
    const segmentGaps = await this._extensionPublishConfigService.getSegmentGaps();
    // Expand each claimed ROOT into its thread chain. One query for the whole
    // batch (not one per root) — a poll can claim up to 50.
    const chainNodes = await this._postRepository.getExtensionPublishChainNodes(
      orgId,
      [...new Set(rows.map((r) => r.group).filter(Boolean))]
    );
    // parentPostId -> node, so a chain is walked from its anchor in order. Keyed
    // by parent rather than by group because only nodes actually REACHABLE from
    // the root belong to the thread: a malformed row that shares the group but
    // hangs off nothing is simply never visited.
    const nodeByParent = new Map<string, (typeof chainNodes)[number]>();
    for (const node of chainNodes) {
      if (node.parentPostId) nodeByParent.set(node.parentPostId, node);
    }
    const due = await Promise.all(rows.map(async (p) => {
      let settings: Record<string, any> = {};
      try {
        settings = JSON.parse(p.settings || '{}') || {};
      } catch {
        /* malformed settings → publish without them */
      }
      // Walk the chain from this anchor: [root, ...thread parts] in publish
      // order. A cap of chainNodes.length makes a cyclic parentPostId (corrupt
      // data) terminate instead of hanging the poll.
      const chain: Array<{ id: string; content: string | null; image: string | null }> =
        [p];
      for (let cursor = nodeByParent.get(p.id), guard = 0;
           cursor && guard < chainNodes.length;
           cursor = nodeByParent.get(cursor.id), guard++) {
        chain.push(cursor);
      }
      // Resolve each node's stored media ({id}/{path} refs) into absolute URLs
      // the extension can download and hand to the platform's own upload
      // pipeline (see updateMedia). Best-effort per node: a bad/missing media ref
      // must never block the text from publishing.
      const segments = await Promise.all(
        chain.map(async (node, segmentIndex) => {
          let images: string[] = [];
          try {
            const resolved = await this.updateMedia(
              node.id,
              JSON.parse(node.image || '[]')
            );
            images = (resolved || [])
              .map((m: any) => m?.url)
              .filter((url: any): url is string => typeof url === 'string' && !!url);
          } catch {
            /* malformed/missing media → publish text-only */
          }
          // Media is only publishable on the ANCHOR. Every platform's thread
          // continuation is a reply/comment whose poster takes text only (X
          // reply, LinkedIn comment, HN comment), and the extension rejects the
          // whole item when a later segment carries images. A rejected item never
          // leaves Post.state=QUEUE, so it would be re-offered on every poll
          // forever — dropping the image here publishes the thread instead of
          // stranding it. Plan thread parts CAN carry media (materializePlanPosts
          // writes `image` on every chain node), so this is reachable, not
          // theoretical.
          if (segmentIndex > 0 && images.length) {
            this.logger.warn(
              `getDuePublishPosts: dropping ${images.length} image(s) on thread segment ${segmentIndex} of post ${p.id} — thread continuations are text-only`
            );
            images = [];
          }
          return {
            // OUR Post id for this segment. The extension echoes it back on the
            // settle callbacks so each segment is recorded against the right row
            // by identity — the chain can change during the lease window, so a
            // positional match would stamp a live permalink onto the wrong post.
            postId: node.id,
            text: stripHtmlValidation('normal', node.content || '', true),
            ...(images.length ? { images } : {}),
          };
        })
      );
      // Platform is the persisted Post.providerIdentifier (set from the bound
      // integration when present, else the caller-supplied platform — see
      // mapTypeToPost / createOrUpdatePost). The trailing fallbacks only serve
      // rows written before the backfill ran (settings is parsed above anyway,
      // so the legacy read is free here).
      const platform =
        p.providerIdentifier ||
        p.integration?.providerIdentifier ||
        settings.__type;
      const segmentGap = segmentGaps[platform as PublishPlatform];
      return {
        id: p.id,
        platform,
        // Post.title is the canonical field and createOrUpdatePost now
        // persists it, but rows written before that (and any caller that
        // shaped settings by hand) only carry the title inside settings —
        // where it lives is per-platform, hence titleFromSettings. Without
        // this fallback such a post reaches the extension titleless, is
        // rejected ("reddit post needs a title"), and — since a rejected item
        // never leaves Post.state=QUEUE — is re-offered on every poll forever.
        title: p.title || titleFromSettings(platform, settings) || undefined,
        // RedditSettingsDto.subreddit is an ARRAY of { value: { subreddit, ... } }
        // (multi-subreddit submission support on the Temporal path — see
        // reddit.provider.ts). The extension's publish queue only supports a
        // single subreddit string; forwarding the raw array made
        // queue.ts's `.trim()` validation throw on every poll, which was
        // silently swallowed by publish.runner's caller — the post stayed in
        // QUEUE and was re-offered every cycle without ever publishing.
        subreddit: settings.subreddit?.[0]?.value?.subreddit || undefined,
        // Reddit post flair as a LABEL, not an id — the extension matches it
        // against the options Reddit renders on the submit page (see
        // PublishPostItem.flairLabel). Absent for every other platform.
        ...(settings.subreddit?.[0]?.value?.flairLabel
          ? { flairLabel: settings.subreddit[0].value.flairLabel }
          : {}),
        // Whether this community was OBSERVED to force flair. Lets the executor
        // skip a submit that is guaranteed to bounce — see
        // PublishPostItem.flairRequired. Absent for every other platform, and
        // absent here too when nothing has been observed.
        ...(settings.subreddit?.[0]?.value?.flairRequired
          ? { flairRequired: true }
          : {}),
        // Dev.to tags. settings.tags holds DevToSettingsDto's {value,label}
        // pairs, where `value` is a dev.to tag id the extension has no use for —
        // dev.to's own API takes tag NAMES — so only the labels cross the
        // boundary. Absent for every other platform.
        ...(Array.isArray(settings.tags) && settings.tags.length
          ? {
              tags: settings.tags
                .map((t: any) => (typeof t === 'string' ? t : t?.label))
                .filter((label: unknown): label is string => !!label),
            }
          : {}),
        segments,
        publishDate: p.publishDate?.toISOString?.() ?? null,
        // Admin-configured [min, max] seconds pause between THREAD segments for
        // this platform (extension_publish.segment_gap). Only meaningful on
        // multi-segment items, but stamped unconditionally so the extension
        // never falls back to its hardcoded default when a config exists.
        // Absent for platforms outside the extension-publishable set.
        ...(segmentGap ? { segmentGapSeconds: segmentGap } : {}),
        // WHICH account this post must go out as. The extension publishes with
        // the browser's own logged-in session, which is NOT necessarily the
        // account the post was composed for — and posting to the wrong account
        // cannot be undone, so the extension refuses to publish when the two
        // disagree. `id` is the platform-side account id (survives renames);
        // `handle` is only for the message shown to the user.
        //
        // Omitted when the post has NO bound integration (operation-plan posts
        // publish by platform): there is no intended account to contradict, so
        // publishing as whoever is logged in IS the intent and the extension
        // skips the check rather than failing every such post.
        ...(p.integration?.internalId
          ? {
              targetAccount: {
                id: p.integration.internalId,
                handle: p.integration.profile || undefined,
                name: p.integration.name || undefined,
              },
            }
          : {}),
      };
    }));
    return { due };
  }

  /**
   * Per-platform publish-method capability for the SCHEDULING UI (org-scoped, so
   * any signed-in user can call it — unlike the superadmin-only
   * GET /admin/social-providers). Lets the editor render the send-path choice
   * correctly BEFORE committing: which methods are selectable, the default the
   * backend would auto-pick, and why a platform is unavailable (so the UI can
   * prompt "connect an account").
   *
   * It returns the RESOLVED answer, not raw flags: capability depends on both the
   * platform (static) and whether THIS org has a bound account (dynamic), and the
   * rules are exactly the ones resolvePublishMethod enforces at schedule time —
   * computed here, once, so the UI can never offer a choice the commit rejects
   * and no rule logic is duplicated client-side.
   */
  async getPublishMethods(orgId: string) {
    const integrations = await this._integrationService.getIntegrationsList(orgId);
    const boundPlatforms = new Set(
      (integrations || [])
        .filter((i: any) => !i.disabled && !i.deletedAt)
        .map((i: any) => (i.providerIdentifier || '').toLowerCase())
    );
    // Every registered provider — the client fetches this once and caches it, so
    // there is no per-request platform filter to keep in sync.
    const uniquePlatforms = [
      ...new Set(
        this._integrationManager
          .getSocialProviderList()
          .map((p) => (p.identifier || '').toLowerCase())
          .filter(Boolean)
      ),
    ];
    return uniquePlatforms.map((platform) => {
      const hasBoundIntegration = boundPlatforms.has(platform);
      const extensionCapable = isExtensionPublishablePlatform(platform);
      const apiCapable = hasBoundIntegration && !isExtensionOnlyProvider(platform);
      const methods: PublishMethod[] = [];
      if (extensionCapable) methods.push('extension');
      if (apiCapable) methods.push('api');
      let defaultMethod: PublishMethod | null = null;
      let reason: string | undefined;
      try {
        defaultMethod = resolvePublishMethod({ platform, hasBoundIntegration });
      } catch (err) {
        if (err instanceof PublishMethodError) reason = err.code;
      }
      return {
        platform,
        extensionCapable,
        apiCapable,
        hasBoundIntegration,
        methods,
        defaultMethod,
        ...(reason ? { reason } : {}),
      };
    });
  }

  /**
   * Commit a batch of DRAFT posts to the send queue (DRAFT -> QUEUE). This is the
   * single entry point that turns generated/operation-plan drafts into work the
   * send paths pick up, and where the send-path decision is made ONCE per post:
   *   - resolvePublishMethod stamps EXTENSION or API on the post (+ its thread
   *     chain) based on platform capability, the bound account, and the user's
   *     optional choice; a post that cannot honour the choice fails individually.
   *   - API posts additionally start the Temporal workflow; EXTENSION posts just
   *     stay QUEUE for the extension publish-due loop.
   * Partial success: each post is scheduled independently and failures are
   * reported per id (so one unbindable platform never blocks the rest).
   */
  async schedulePosts(
    orgId: string,
    items: Array<{ id: string; publishMethod?: PublishMethod; date?: string }>
  ) {
    const ids = [...new Set(items.map((i) => i.id))];
    const itemById = new Map(items.map((i) => [i.id, i]));
    const posts = await this._postRepository.getSchedulablePostsByIds(orgId, ids);
    const postById = new Map(posts.map((p) => [p.id, p]));

    const scheduled: Array<{ id: string; publishMethod: PublishMethod | null }> = [];
    const failed: Array<{ id: string; code: string; message: string }> = [];

    for (const id of ids) {
      const post = postById.get(id);
      if (!post) {
        failed.push({ id, code: 'NOT_FOUND', message: 'Post not found' });
        continue;
      }
      // Idempotent: a post already scheduled/published is a no-op success.
      if (post.state !== 'DRAFT') {
        if (post.state === 'QUEUE' || post.state === 'PUBLISHED') {
          // Report the STORED method as-is: null (legacy/unset) stays null rather
          // than being guessed as 'extension' (a null-method post routes by the
          // capability fallback, which may be API).
          scheduled.push({
            id,
            publishMethod:
              post.publishMethod === 'API'
                ? 'api'
                : post.publishMethod === 'EXTENSION'
                  ? 'extension'
                  : null,
          });
        } else {
          failed.push({
            id,
            code: 'INVALID_STATE',
            message: `Cannot schedule a post in state ${post.state}`,
          });
        }
        continue;
      }

      const platform = resolveScheduledPostPlatform(post);
      const hasBoundIntegration =
        !!post.integrationId && post.integration?.disabled !== true;

      // A send path already stamped on the post is an explicit choice the user
      // made in the editor (POST /posts persists it). Without this fallback a
      // batch schedule silently discards it — auto-resolve prefers `extension`
      // for every extension-capable platform, so an "api" pick would be
      // overwritten the moment the page was reloaded and the client-side memory
      // of the pick was gone. Priority: this request's choice > the persisted
      // choice > auto-resolve. Keeping the choice does not bypass validation —
      // resolvePublishMethod still rejects it if the account was since removed.
      const persistedChoice: PublishMethod | null =
        post.publishMethod === 'API'
          ? 'api'
          : post.publishMethod === 'EXTENSION'
            ? 'extension'
            : null;

      let method: PublishMethod;
      try {
        method = resolvePublishMethod({
          platform,
          hasBoundIntegration,
          choice: itemById.get(id)?.publishMethod ?? persistedChoice,
        });
      } catch (err) {
        if (err instanceof PublishMethodError) {
          failed.push({ id, code: err.code, message: err.message });
        } else {
          failed.push({
            id,
            code: 'SCHEDULE_FAILED',
            message: (err as Error)?.message || 'Failed to resolve send method',
          });
        }
        continue;
      }

      const newDate = itemById.get(id)?.date;
      await this._postRepository.schedulePostGroupToQueue(
        orgId,
        post.group,
        method === 'api' ? 'API' : 'EXTENSION',
        newDate ? dayjs(newDate).toDate() : undefined
      );

      // API posts publish through Temporal; EXTENSION posts stay QUEUE for the
      // extension pull loop. startWorkflow re-reads publishMethod and no-ops for
      // extension, so this call is the API-only trigger.
      if (method === 'api') {
        try {
          await this.startWorkflow(getSocialTaskQueue(platform), id, orgId);
        } catch (err) {
          this.logger.warn(
            `schedulePosts: startWorkflow failed for postId=${id}: ${(err as Error)?.message || err}`
          );
          // Leave it QUEUE; a stuck-QUEUE backstop / manual retry recovers it,
          // rather than failing the whole batch after the DB flip succeeded.
        }
      }

      scheduled.push({ id, publishMethod: method });
    }

    return { scheduled, failed };
  }

  /**
   * Align a project's still-DRAFT plan posts with their platform's publish time
   * window, spacing the ones it moves at least `min_gap` minutes apart.
   *
   * WHY IT EXISTS. Window alignment used to happen only at commit time
   * (schedulePlanPosts), which meant a freshly generated plan showed the
   * generator's own times on the calendar — times that would silently change the
   * moment the plan was committed. Running the same alignment at generation, and
   * again whenever the publishing settings are turned on, makes what the user
   * sees the time the post actually goes out.
   *
   * It does NOT replace the commit-time pass. A window configured or edited
   * AFTER generation still has to take effect, and only the commit-time pass can
   * see it — so both run, and the second is a no-op whenever the first already
   * did the work.
   *
   * DRAFT ONLY, deliberately. A QUEUE post's publish time is not a database
   * field you can move: for API posts the Temporal workflow captured the date
   * when it started and aborts on finding it changed, so rescheduling one means
   * terminating and restarting its workflow behind the claim + lockout gates
   * `changeDate` implements. That is a different operation with a different
   * failure model and it does not belong behind the same call.
   *
   * Only posts OUTSIDE their window move — see
   * redistributePublishTimesWithinWindow for why, and for what the minimum gap
   * does and does not guarantee.
   *
   * Reported as a count rather than thrown on: this runs as a follow-up to
   * generating or saving, and neither should fail because the schedule could not
   * be tidied.
   */
  async alignPlanDraftPublishDates(
    orgId: string,
    projectId: string,
    operationPlanId?: string
  ): Promise<{ aligned: number; skipped: 'inactive' | 'no-windows' | null }> {
    if (!this._projectPublishingService) {
      throw new Error(
        'ProjectPublishingService is required to align operation-plan publish dates'
      );
    }
    const plan = await this._resolveWindowPlacement(
      orgId,
      projectId,
      'DRAFT',
      operationPlanId
    );
    if (plan.skipped) return { aligned: 0, skipped: plan.skipped };

    await this._postRepository.updateDraftGroupPublishDates(
      orgId,
      plan.moves.map((move) => ({ group: move.group, publishDate: move.publishDate }))
    );
    return { aligned: plan.moves.length, skipped: null };
  }

  /**
   * Move a project's already-QUEUED plan posts back inside their publish time
   * window — the QUEUE counterpart of alignPlanDraftPublishDates, and a
   * deliberately separate method because rescheduling a queued post is a
   * different operation, not a different filter.
   *
   * A QUEUE post's publish time is not a column you can move. An API post's
   * Temporal workflow read its publishDate when it started, sleeps until then,
   * and RETURNS on waking to find the date changed — so a bare UPDATE strands it
   * in QUEUE until the stale sweep turns it into an unexplained ERROR. Moving
   * one means terminating and restarting its workflow, behind the same two gates
   * `changeDate` uses:
   *
   *   - the CLAIM gate: `releaseId` starting with `claim_` means a workflow may
   *     already be inside postSocial, and terminating it cannot cancel an
   *     in-flight HTTP call — a new workflow would publish a second copy.
   *   - the LOCKOUT gate: within 30s of publishing, the workflow may no longer
   *     be sleeping, which is what makes terminate() clean.
   *
   * Both gates SKIP rather than fail. This runs as a follow-up to saving
   * settings, where "one of eleven posts is publishing right now" is a normal
   * state of the world, not an error the save should surface as a failure. Every
   * skip is returned with its reason so the caller can say what was left alone.
   *
   * Extension-published posts pass through the same path: `startWorkflow`
   * recognises them and returns without touching Temporal, and the extension's
   * publish-due query is `publishDate <= now`, so the row change is all they
   * need. The gates still apply — a post inside its 30s lockout is one the
   * extension may already be publishing.
   */
  async rescheduleQueuedPlanPosts(
    orgId: string,
    projectId: string,
    operationPlanId?: string
  ): Promise<{
    rescheduled: number;
    skipped: Array<{ id: string; reason: SkipReason | 'workflow-failed' }>;
    inactive: 'inactive' | 'no-windows' | null;
  }> {
    const plan = await this._resolveWindowPlacement(
      orgId,
      projectId,
      'QUEUE',
      operationPlanId
    );
    if (plan.skipped) {
      return { rescheduled: 0, skipped: [], inactive: plan.skipped };
    }

    const skipped: Array<{
      id: string;
      reason: SkipReason | 'workflow-failed';
    }> = [...plan.pinnedReasons];
    let rescheduled = 0;

    // Serial, not Promise.all: each move terminates and restarts a Temporal
    // workflow, and a burst of those against the same namespace is exactly the
    // load pattern that makes terminate() race the timer it is trying to beat.
    // A settings save moves a handful of posts, not thousands.
    for (const move of plan.moves) {
      await this._postRepository.updateGroupPublishDate(
        orgId,
        move.group,
        'QUEUE',
        move.publishDate
      );
      try {
        // Root id only: one workflow owns a whole chain (it walks the group
        // itself), which is the same thing schedulePosts relies on.
        await this.startWorkflow(
          getSocialTaskQueue(move.platform),
          move.id,
          orgId
        );
        rescheduled++;
      } catch (err) {
        // The date is already written and the old workflow already terminated,
        // so this post now has no timer. Not reverted — a revert can fail too,
        // and would leave the same post in the same place with a less honest
        // report. Named loudly instead; it is recoverable by rescheduling.
        this.logger.error(
          `rescheduleQueuedPlanPosts: startWorkflow failed for postId=${move.id} ` +
            `orgId=${orgId} projectId=${projectId} — the post has no timer and must be rescheduled: ` +
            `${(err as Error)?.message || err}`
        );
        Sentry.captureException(err, {
          extra: { postId: move.id, orgId, projectId },
        });
        skipped.push({ id: move.id, reason: 'workflow-failed' });
      }
    }

    return { rescheduled, skipped, inactive: null };
  }

  /**
   * The shared half of the two window passes: resolve the project's settings,
   * read every not-yet-published plan post root, and work out where the ones
   * this pass may move should go.
   *
   * Both states are always READ, whichever one is being moved: a DRAFT and a
   * QUEUE post can sit in the same window on the same day, so a pass blind to
   * the other's posts would place one on top of the other. The posts this pass
   * does not own are handed to the allocator pinned — they occupy their slot and
   * the minimum gap is measured against them.
   */
  private async _resolveWindowPlacement(
    orgId: string,
    projectId: string,
    moving: 'DRAFT' | 'QUEUE',
    operationPlanId?: string
  ): Promise<{
    skipped: 'inactive' | 'no-windows' | null;
    moves: Array<{ id: string; group: string; platform: string; publishDate: Date }>;
    pinnedReasons: Array<{ id: string; reason: SkipReason }>;
  }> {
    const empty = {
      moves: [] as Array<{
        id: string;
        group: string;
        platform: string;
        publishDate: Date;
      }>,
      pinnedReasons: [] as Array<{ id: string; reason: SkipReason }>,
    };
    if (!this._projectPublishingService) {
      throw new Error(
        'ProjectPublishingService is required to align operation-plan publish dates'
      );
    }
    const projectPublishing = await this._projectPublishingService.resolve(
      orgId,
      projectId
    );
    // Same gate as the commit path, through the same function: master switch
    // AND the scheduled-publishing feature switch. A project that has not turned
    // publishing on has not authorized us to rewrite its schedule either.
    if (!isPublishingActive(projectPublishing)) {
      return { ...empty, skipped: 'inactive' };
    }
    const windows = projectPublishing.windows;
    if (!Object.keys(windows).length) {
      // No window at any tier = unconstrained, which is the out-of-the-box
      // state. Nothing to align against, so nothing is touched.
      return { ...empty, skipped: 'no-windows' };
    }

    const roots = await this._postRepository.getPlanPostRootsForProject(
      orgId,
      projectId,
      ['DRAFT', 'QUEUE'],
      operationPlanId
    );
    if (!roots.length) return { ...empty, skipped: null };

    const minGaps = await this._extensionPublishConfigService.getMinGapMinutes();
    const pinnedReasons: Array<{ id: string; reason: SkipReason }> = [];
    const now = dayjs();

    // Why a post may not be moved by THIS pass. Null = it may.
    const pinReason = (root: (typeof roots)[number]): 'claimed' | 'imminent' | null => {
      if (root.state !== moving) return null; // owned by the other pass
      if (moving === 'DRAFT') return null; // a draft has no timer to race
      if (root.releaseId?.startsWith('claim_')) return 'claimed';
      if (dayjs(root.publishDate).diff(now, 'millisecond') < RESCHEDULE_LOCKOUT_MS) {
        return 'imminent';
      }
      return null;
    };

    // Per PLATFORM: the window and the gap are both per-platform, and posts on
    // different platforms have no reason to avoid each other — two channels
    // publishing at the same minute is a person with two tabs open, not a bot.
    const byPlatform = new Map<PublishPlatform, typeof roots>();
    for (const root of roots) {
      const platform = root.providerIdentifier?.toLowerCase() as
        | PublishPlatform
        | undefined;
      if (!platform || !windows[platform]) continue;
      const bucket = byPlatform.get(platform);
      if (bucket) bucket.push(root);
      else byPlatform.set(platform, [root]);
    }

    const moves: Array<{
      id: string;
      group: string;
      platform: string;
      publishDate: Date;
    }> = [];
    for (const [platform, platformRoots] of byPlatform) {
      const { moved, degraded } = redistributePublishTimesWithinWindow(
        platformRoots.map((root) => {
          const reason = pinReason(root);
          if (reason) pinnedReasons.push({ id: root.id, reason });
          return {
            id: root.id,
            publishDate: root.publishDate,
            movable: root.state === moving && !reason,
          };
        }),
        windows[platform]!,
        // A platform with a project window but outside the publishable set has
        // no resolved entry; the built-in default is the safe read, not "no
        // spacing at all".
        minGaps[platform] ?? DEFAULT_MIN_GAP_MINUTES
      );
      for (const root of platformRoots) {
        const date = moved.get(root.id);
        if (!date) continue;
        // Never move a post to a time that has already passed. The window is
        // anchored to the post's own local day, so a post scheduled for tonight
        // can be offered this morning's window — and applying that would
        // publish it on the spot, which is the exact opposite of what a window
        // is for. Leaving it where it is keeps it in the future; the next pass
        // (or the commit) gets another go once its own day comes round.
        if (dayjs(date).diff(now, 'millisecond') < RESCHEDULE_LOCKOUT_MS) {
          pinnedReasons.push({ id: root.id, reason: 'window-passed' });
          continue;
        }
        moves.push({
          id: root.id,
          group: root.group,
          platform,
          publishDate: date,
        });
      }
      // Never silent: a window too narrow for its posts still produces a
      // schedule, but the operator asked for spacing they did not get and the
      // only place that is visible is here.
      for (const instance of degraded) {
        this.logger.warn(
          `Publish window ${platform} starting ${instance.windowStart.toISOString()} ` +
            `could not honour a ${instance.requestedGapMinutes}min gap for orgId=${orgId} projectId=${projectId} — ` +
            `spaced at ${instance.appliedGapMinutes.toFixed(1)}min instead. Widen the window or lower extension_publish.min_gap.`
        );
      }
    }

    return { skipped: null, moves, pinnedReasons };
  }

  /** When this project last actually published something; null if never. */
  getLastPublishedAt(orgId: string, projectId: string) {
    return this._postRepository.getLastPublishedAt(orgId, projectId);
  }

  /**
   * Plan-scoped DRAFT -> QUEUE: commit every still-draft post of one operation
   * plan in a single call. Exists so "activate this plan" is one action on the
   * plan itself — the client never has to enumerate the plan's post ids, which
   * it cannot keep in sync anyway (re-running a plan re-materializes them).
   *
   * Deliberately a thin expansion over schedulePosts rather than a second commit
   * path: send-path resolution, the thread-chain flip, the Temporal trigger and
   * per-post failure reporting must stay identical for both entry points — once
   * committed, a plan post and a hand-picked post are the same thing. Splitting
   * them would let the two drift, and the send-path decision is the structural
   * double-publish guard.
   *
   * `alreadyScheduled` is reported separately from `scheduled` so a re-run is
   * legible: total > 0 with an empty `scheduled` means the plan is already
   * committed, while total = 0 means the plan has no posts (or is not this org's).
   *
   * Manual posts are structurally out of reach here: the plan query matches
   * `operationPlanId` by equality, so a hand-created post (operationPlanId
   * null) can never join this batch no matter what the caller passes. Turning
   * Automation on therefore cannot touch anything the user typed themselves.
   *
   * `projectId` is REQUIRED, not optional: a plan is a project's artifact, so
   * committing one is always a project-scoped action. Taking it as a parameter
   * rather than inferring it is what lets this method assert the plan actually
   * belongs to the project the caller was authorized for — and making it
   * mandatory means no future caller can reach the plan path without that
   * assertion running. The only caller is AutomationService, reached through
   * /projects/:projectId/automation, where ProjectAuthGuard has already
   * authorized the id against the request's org.
   */
  async schedulePlanPosts(
    orgId: string,
    operationPlanId: string,
    projectId: string,
    publishMethod?: PublishMethod,
    platforms?: string[]
  ) {
    if (!this._projectPublishingService) {
      // Only reachable if someone constructs this service positionally without
      // the dependency. Failing loudly beats silently skipping the ownership
      // assertion, which is the whole point of this path.
      throw new Error(
        'ProjectPublishingService is required to schedule an operation plan'
      );
    }
    // Ownership first: a plan from a sibling project must not even reveal how
    // many posts it has, so this runs before any counting.
    await this._projectPublishingService.assertPlanBelongsToProject(
      orgId,
      projectId,
      operationPlanId
    );
    const projectPublishing = await this._projectPublishingService.resolve(
      orgId,
      projectId
    );

    // The switch chain, in order: master -> scheduled-publishing feature. The
    // per-platform level is applied below, per post.
    //
    // Gates what ENTERS the queue, nothing else. A post already in QUEUE — or
    // one the extension is mid-send on — is past this point and finishes;
    // turning publishing off is a configuration change, not a recall. Reported
    // as a plain empty batch rather than an error: the caller (saving publishing
    // settings with `commit`) is doing something legitimate, it simply has
    // nothing to commit while the feature is off.
    if (!isPublishingActive(projectPublishing)) {
      return { scheduled: [], failed: [], total: 0, alreadyScheduled: 0 };
    }

    const allRoots = await this._postRepository.getSchedulablePostRootsByPlan(
      orgId,
      operationPlanId
    );
    // Filtered EARLY so every number below (`total`, `alreadyScheduled`,
    // `scheduled`, `failed`) is scoped to what the caller asked for — a caller
    // that filtered to `['x']` on a plan that also has linkedin/medium posts
    // must not see `total` counting posts it never asked to touch, which would
    // make the "already done" signal misleading.
    // Explicit `platforms` wins; otherwise a project-scoped call falls back to
    // the platforms the project itself has publishing turned on for. That
    // fallback is what makes the saved setting REAL — before it, the stored
    // per-platform toggle was decoration and the only thing that decided what
    // got queued was the list the client happened to send.
    //
    // `enabledPlatforms: null` means the project never expressed a preference,
    // which stays unconstrained (pre-existing behaviour); an EMPTY array means
    // every platform was explicitly turned off, and correctly queues nothing.
    const effectivePlatforms =
      platforms?.length ? platforms : projectPublishing.enabledPlatforms ?? undefined;
    const platformSet = effectivePlatforms
      ? new Set(effectivePlatforms.map((p) => p.toLowerCase()))
      : null;
    const roots = platformSet
      ? allRoots.filter(
          (p) =>
            !!p.providerIdentifier &&
            platformSet.has(p.providerIdentifier.toLowerCase())
        )
      : allRoots;
    const drafts = roots.filter((p) => p.state === 'DRAFT');
    // Per-platform publish time windows — resolved once for the whole batch,
    // then applied per-post below. A platform absent from this map is
    // unconstrained: its posts keep their materialized time untouched.
    //
    // Already resolved by ProjectPublishingService, which layered the PROJECT's
    // own window over the admin tiers (platform override -> global default).
    const timeWindows = drafts.length ? projectPublishing.windows : {};
    const now = dayjs();
    // Empty input is safe: schedulePosts short-circuits on an empty id list, so
    // an already-committed (or unknown, or platform-filtered-to-nothing) plan is
    // a no-op success, not an error.
    const result = await this.schedulePosts(
      orgId,
      drafts.map((p) => {
        const platform = p.providerIdentifier?.toLowerCase() as
          | PublishPlatform
          | undefined;
        const window = platform ? timeWindows[platform] : undefined;
        // Re-pick (not clamp) a time inside the window: the materialized time
        // is just the plan's default and has no value worth preserving once a
        // window says it's the wrong time of day.
        const redistributed = window
          ? redistributePublishTimeIfOutsideWindow(p.publishDate, window)
          : undefined;
        // ...but never BACKWARDS across the clock. The window is anchored to the
        // post's own local day, so committing at 19:00 a post dated 22:00 today
        // against a 09:00-18:00 window offers a time this morning — and a QUEUE
        // post dated in the past publishes on the spot, which is the precise
        // opposite of what a publish window is for. The post keeps its own time
        // instead; out-of-window is bad, published-right-now is worse. Same rule
        // _resolveWindowPlacement applies, so the two paths cannot disagree
        // about it.
        const usable =
          redistributed && redistributed.getTime() > now.valueOf()
            ? redistributed
            : undefined;
        const dateOverride =
          usable && usable.getTime() !== p.publishDate.getTime()
            ? usable.toISOString()
            : undefined;
        return {
          id: p.id,
          ...(publishMethod ? { publishMethod } : {}),
          ...(dateOverride ? { date: dateOverride } : {}),
        };
      })
    );
    return {
      ...result,
      total: roots.length,
      alreadyScheduled: roots.length - drafts.length,
    };
  }

  /** Stamp the given org-owned posts as fetched-now (backfill dedup gate). */
  markMetricsFetched(orgId: string, ids: string[], fetchedAt = dayjs.utc().toDate()) {
    if (!ids?.length) {
      return Promise.resolve({ count: 0 });
    }
    return this._postRepository.markMetricsFetched(orgId, ids, fetchedAt);
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
  ): Promise<{
    updated: string[];
    stamped: string[];
    results: Array<{
      postId: string;
      impressions: number;
      trafficScore: number | null;
      analytics: AnalyticsData[];
      metrics: Record<string, number>;
      lastMetricsFetchAt: Date;
    }>;
  }> {
    if (!items?.length) {
      return { updated: [], stamped: [], results: [] };
    }
    const ids = items.map((i) => i.postId);
    const posts = await this._postRepository.getPostsProviderByIds(orgId, ids);
    const providerById = new Map(
      posts.map((p) => [p.id, p.providerIdentifier || p.integration?.providerIdentifier])
    );
    // Currently persisted values, so a fresh read that declines to overwrite
    // (zero impressions / null traffic) can echo the stored value instead of 0.
    const persistedById = new Map(
      posts.map((p) => [
        p.id,
        { impressions: p.impressions ?? 0, trafficScore: p.trafficScore ?? null },
      ])
    );

    const updates: Array<{
      id: string;
      impressions?: number;
      trafficScore?: number;
      analytics?: any;
    }> = [];
    const stamped: string[] = [];
    const lastMetricsFetchAt = dayjs.utc().toDate();
    const results: Array<{
      postId: string;
      impressions: number;
      trafficScore: number | null;
      analytics: AnalyticsData[];
      metrics: Record<string, number>;
      lastMetricsFetchAt: Date;
    }> = [];

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
      const metrics = Object.fromEntries(
        rawMetrics.map((metric) => {
          const latest = metric.data[metric.data.length - 1];
          const value = Number(latest?.total);
          return [metric.label, Number.isFinite(value) ? value : 0];
        })
      );
      // Mirror the persistence rule below: impressions are only overwritten when
      // positive and trafficScore only when present, so a transient zero/partial
      // read never clobbers an earlier real value. The response must echo the
      // same EFFECTIVE value we keep on disk, otherwise the UI shows 0 until the
      // next reload restores the old value.
      const persisted = persistedById.get(item.postId);
      const effectiveImpressions =
        impressions > 0 ? impressions : persisted?.impressions ?? 0;
      const effectiveTrafficScore =
        trafficScore !== null ? trafficScore : persisted?.trafficScore ?? null;
      results.push({
        postId: item.postId,
        impressions: effectiveImpressions,
        trafficScore: effectiveTrafficScore,
        analytics: rawMetrics,
        metrics,
        lastMetricsFetchAt,
      });
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
    await this.markMetricsFetched(orgId, stamped, lastMetricsFetchAt);
    // NOTE: no API-usage/cost telemetry here on purpose. This endpoint is a pure
    // DATA SUBMISSION — the browser extension already read the metrics on the
    // user's own session client-side, so the backend makes NO social-provider
    // API call and incurs NO app API cost. API-cost stats track backend provider
    // calls only; counting client-submitted data here would misattribute cost.
    return { updated: updates.map((u) => u.id), stamped, results };
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
