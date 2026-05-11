import { Injectable } from '@nestjs/common';
import {
  Activity,
  ActivityMethod,
  TemporalService,
} from 'nestjs-temporal-core';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import {
  NotificationService,
  NotificationType,
} from '@gitroom/nestjs-libraries/database/prisma/notifications/notification.service';
import { Integration, Post, State } from '@prisma/client';
import { stripHtmlValidation } from '@gitroom/helpers/utils/strip.html.validation';
import { IntegrationManager } from '@gitroom/nestjs-libraries/integrations/integration.manager';
import { AuthTokenDetails } from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import {
  RefreshIntegrationService,
  TransientRefreshError,
} from '@gitroom/nestjs-libraries/integrations/refresh.integration.service';
import { timer } from '@gitroom/helpers/utils/timer';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import { WebhooksService } from '@gitroom/nestjs-libraries/database/prisma/webhooks/webhooks.service';
import { TypedSearchAttributes } from '@temporalio/common';
import {
  organizationId,
  postId as postIdSearchParam,
} from '@gitroom/nestjs-libraries/temporal/temporal.search.attribute';
import { getSocialTaskQueue } from '@gitroom/nestjs-libraries/temporal/task-queue';

@Injectable()
@Activity()
export class PostActivity {
  constructor(
    private _postService: PostsService,
    private _notificationService: NotificationService,
    private _integrationManager: IntegrationManager,
    private _integrationService: IntegrationService,
    private _refreshIntegrationService: RefreshIntegrationService,
    private _webhookService: WebhooksService,
    private _temporalService: TemporalService
  ) {}

  @ActivityMethod()
  async getIntegrationById(orgId: string, id: string) {
    return this._integrationService.getIntegrationById(orgId, id);
  }

  @ActivityMethod()
  async searchForMissingThreeHoursPosts() {
    const list = await this._postService.searchForMissingThreeHoursPosts();
    for (const post of list) {
      // Reset any orphaned claim token before signaling/starting the workflow.
      // Safe for in-flight workflows: they use Temporal event history for the
      // claim result, not the DB value, so resetting here can't cause duplicates.
      await this._postService.resetClaimForPost(post.id);
      await this._temporalService.client
        .getRawClient()
        .workflow.signalWithStart('postWorkflowV101', {
          workflowId: `post_${post.id}`,
          taskQueue: 'main',
          signal: 'poke',
          workflowIdConflictPolicy: 'USE_EXISTING',
          signalArgs: [],
          args: [
            {
              taskQueue: getSocialTaskQueue(post.integration.providerIdentifier),
              postId: post.id,
              organizationId: post.organizationId,
            },
          ],
          typedSearchAttributes: new TypedSearchAttributes([
            {
              key: postIdSearchParam,
              value: post.id,
            },
            {
              key: organizationId,
              value: post.organizationId,
            },
          ]),
        });
    }
  }

  @ActivityMethod()
  async markStaleQueuePostsAsError() {
    return this._postService.markStaleQueuePostsAsError();
  }

  @ActivityMethod()
  async prepareRecurringCycle(postId: string, expectedPublishDate: string, claimToken: string) {
    return this._postService.prepareRecurringCycle(postId, new Date(expectedPublishDate), claimToken);
  }

  @ActivityMethod()
  async finalizeRecurringCycle(
    postId: string,
    cloneId: string,
    expectedPublishDate: string,
    result: {
      state: 'PUBLISHED' | 'ERROR';
      releaseId?: string;
      releaseURL?: string;
      error?: string;
    }
  ) {
    return this._postService.finalizeRecurringCycle(
      postId, cloneId, new Date(expectedPublishDate), result
    );
  }

  @ActivityMethod()
  async claimPostForPublishing(id: string, claimToken: string): Promise<boolean> {
    return this._postService.claimPostForPublishing(id, claimToken);
  }

  @ActivityMethod()
  async updatePost(id: string, postId: string, releaseURL: string) {
    return this._postService.updatePost(id, postId, releaseURL);
  }

  @ActivityMethod()
  async recordFailedRelease(postId: string, releaseId: string, error: string) {
    return this._postService.recordFailedRelease(postId, releaseId, error);
  }

  @ActivityMethod()
  async getPostsList(orgId: string, postId: string) {
    const getPosts = await this._postService.getPostsRecursively(postId, true, orgId);
    if (!getPosts || getPosts.length === 0 || getPosts[0].parentPostId) {
      return [];
    }

    return getPosts;
  }

  @ActivityMethod()
  async isCommentable(integration: Integration) {
    const getIntegration = this._integrationManager.getSocialIntegration(
      integration.providerIdentifier
    );

    return !!getIntegration.comment;
  }

  @ActivityMethod()
  async postComment(
    postId: string,
    lastPostId: string | undefined,
    integration: Integration,
    posts: Post[]
  ) {
    const getIntegration = this._integrationManager.getSocialIntegration(
      integration.providerIdentifier
    );

    const newPosts = await this._postService.updateTags(
      integration.organizationId,
      posts
    );

    return getIntegration.comment(
      integration.internalId,
      postId,
      lastPostId,
      integration.token,
      await Promise.all(
        (newPosts || []).map(async (p) => ({
          id: p.id,
          message: stripHtmlValidation(
            getIntegration.editor,
            p.content,
            true,
            false,
            !/<\/?[a-z][\s\S]*>/i.test(p.content),
            getIntegration.mentionFormat
          ),
          settings: JSON.parse(p.settings || '{}'),
          media: await this._postService.updateMedia(
            p.id,
            JSON.parse(p.image || '[]'),
            getIntegration?.convertToJPEG || false
          ),
        }))
      ),
      integration
    );
  }

  @ActivityMethod()
  async postSocial(integration: Integration, posts: Post[]) {
    const getIntegration = this._integrationManager.getSocialIntegration(
      integration.providerIdentifier
    );

    const newPosts = await this._postService.updateTags(
      integration.organizationId,
      posts
    );

    return getIntegration.post(
      integration.internalId,
      integration.token,
      await Promise.all(
        (newPosts || []).map(async (p) => ({
          id: p.id,
          message: stripHtmlValidation(
            getIntegration.editor,
            p.content,
            true,
            false,
            !/<\/?[a-z][\s\S]*>/i.test(p.content),
            getIntegration.mentionFormat
          ),
          settings: JSON.parse(p.settings || '{}'),
          media: await this._postService.updateMedia(
            p.id,
            JSON.parse(p.image || '[]'),
            getIntegration?.convertToJPEG || false
          ),
        }))
      ),
      integration
    );
  }

  @ActivityMethod()
  async inAppNotification(
    orgId: string,
    subject: string,
    message: string,
    sendEmail = false,
    digest = false,
    type: NotificationType = 'success'
  ) {
    return this._notificationService.inAppNotification(
      orgId,
      subject,
      message,
      sendEmail,
      digest,
      type
    );
  }

  @ActivityMethod()
  async globalPlugs(integration: Integration) {
    return this._postService.checkPlugs(
      integration.organizationId,
      integration.providerIdentifier,
      integration.id
    );
  }

  @ActivityMethod()
  async logError(id: string, err?: any, body?: any) {
    return this._postService.logError(id, err, body);
  }

  @ActivityMethod()
  async changeState(id: string, state: State, err?: any, body?: any) {
    return this._postService.changeState(id, state, err, body);
  }

  @ActivityMethod()
  async internalPlugs(integration: Integration, settings: any) {
    return this._postService.checkInternalPlug(
      integration,
      integration.organizationId,
      integration.id,
      settings
    );
  }

  @ActivityMethod()
  async sendWebhooks(postId: string, orgId: string, integrationId: string) {
    const webhooks = (await this._webhookService.getWebhooks(orgId)).filter(
      (f) => {
        return (
          f.integrations.length === 0 ||
          f.integrations.some((i) => i.integration.id === integrationId)
        );
      }
    );

    const post = await this._postService.getPostByForWebhookId(postId);
    return Promise.all(
      webhooks.map(async (webhook) => {
        try {
          await fetch(webhook.url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(post),
          });
        } catch (e) {
          /**empty**/
        }
      })
    );
  }
  @ActivityMethod()
  async processPlug(data: {
    plugId: string;
    postId: string;
    delay: number;
    totalRuns: number;
    currentRun: number;
  }) {
    return this._integrationService.processPlugs(data);
  }

  @ActivityMethod()
  async processInternalPlug(data: {
    post: string;
    originalIntegration: string;
    integration: string;
    plugName: string;
    orgId: string;
    delay: number;
    information: any;
  }) {
    return this._integrationService.processInternalPlug(data);
  }

  @ActivityMethod()
  async postThreadFinisher(
    mainPostId: string,
    lastCommentId: string,
    integration: Integration,
    finisherText: string,
    releaseURL: string
  ) {
    const getIntegration = this._integrationManager.getSocialIntegration(
      integration.providerIdentifier
    );

    const message = stripHtmlValidation(
      getIntegration.editor,
      finisherText,
      true,
      false,
      !/<\/?[a-z][\s\S]*>/i.test(finisherText),
      getIntegration.mentionFormat
    );

    return getIntegration.comment!(
      integration.internalId,
      mainPostId,
      lastCommentId,
      integration.token,
      [
        {
          id: `finisher-${mainPostId}`,
          message: message + '\n' + releaseURL,
          settings: {},
          media: [],
        },
      ],
      integration
    );
  }

  @ActivityMethod()
  async refreshToken(
    integration: Integration
  ): Promise<false | AuthTokenDetails> {
    const getIntegration = this._integrationManager.getSocialIntegration(
      integration.providerIdentifier
    );

    try {
      const refresh = await this._refreshIntegrationService.refresh(
        integration
      );
      if (!refresh) {
        // Permanent failure: refreshProcess already called refreshNeeded() +
        // disconnectChannel(). Return false so callers know the token is
        // permanently dead — no Temporal retry needed (would only re-confirm
        // the same outcome and waste platform API quota).
        return false;
      }

      if (getIntegration.refreshWait) {
        await timer(10000);
      }

      return refresh;
    } catch (err) {
      // CRITICAL: rethrow transient errors so Temporal's activity retry
      // policy ({maximumAttempts: 3, initialInterval: 2 min}) actually
      // engages. The previous catch-all swallowed these errors, making the
      // retry config a no-op and causing a single network blip to look like
      // a successful "no refresh available" outcome.
      if (err instanceof TransientRefreshError) {
        throw err;
      }

      // Truly unexpected error (e.g. DB write failure mid-refresh, code bug).
      // Park the integration in inBetweenSteps so the user is informed and an
      // operator can investigate. This matches the pre-fix behavior for the
      // "unknown error" case, but is now narrowed to actually unexpected
      // errors instead of being triggered by every network glitch.
      try {
        await this._refreshIntegrationService.setBetweenSteps(integration);
      } catch (_) {}
      return false;
    }
  }

  /**
   * Proactive token refresh, called by post.workflow.v1.0.1 right before
   * `postSocial`. Reads the freshest copy of the Integration row from the DB
   * (the one carried by the workflow may be stale — the per-platform
   * refreshTokenWorkflow could have rotated the token while the post slept
   * until publishDate) and refreshes if it is within `bufferMs` of expiry.
   *
   * Why this matters:
   *  - Without this, scheduled posts at night / on weekends often fire with
   *    an already-expired token, get a 401 from the platform, and only THEN
   *    refresh — but for OAuth 1.0a-style providers without `refreshToken`,
   *    or when the refresh fails on first try, the post hard-fails.
   *  - The per-platform refreshTokenWorkflow only covers integrations with
   *    `refreshCron = true` (currently X / Threads / Instagram Standalone).
   *    LinkedIn / TikTok / Facebook / YouTube etc. have NO background
   *    refresh — this pre-send check is their only proactive path.
   *
   * Return value:
   *  - `null` if no refresh was needed or no refresh is possible (permanent
   *    token, no expiration set, integration missing). Caller keeps using
   *    the token already on `integration`.
   *  - The refreshed `Integration` row (with the new token + expiration) on
   *    success. Caller should replace `post.integration` with this.
   *  - `false` if a refresh was attempted but failed. Caller should fall
   *    through to the existing reactive-refresh path (postSocial will throw
   *    `refresh_token` on 401 and the workflow retries once).
   */
  @ActivityMethod()
  async ensureFreshToken(
    integration: Integration,
    bufferMs: number = 10 * 60 * 1000
  ): Promise<Integration | null | false> {
    // Re-read the integration to pick up any token rotation that happened
    // while the workflow was sleeping until publishDate.
    const fresh = await this._integrationService.getIntegrationById(
      integration.organizationId,
      integration.id
    );
    if (!fresh || fresh.deletedAt || fresh.refreshNeeded || fresh.disabled) {
      return null;
    }

    // Permanent tokens (OAuth 1.0a) have no expiration and no refresh flow.
    if (!fresh.tokenExpiration) {
      return null;
    }

    const socialProvider = this._integrationManager.getSocialIntegration(
      fresh.providerIdentifier
    );
    if (socialProvider.isTokenPermanent?.(fresh.token)) {
      return null;
    }

    const msToExpiry = new Date(fresh.tokenExpiration).getTime() - Date.now();
    if (msToExpiry > bufferMs) {
      // Token is comfortably fresh — no work to do. Return the (possibly
      // newer) DB copy so the caller benefits from any concurrent rotation.
      return fresh;
    }

    try {
      const refresh = await this._refreshIntegrationService.refresh(fresh);
      if (!refresh || !refresh.accessToken) {
        return false;
      }
      if (socialProvider.refreshWait) {
        await timer(10000);
      }
      // Re-read so the caller sees the updated token + new tokenExpiration.
      return (
        (await this._integrationService.getIntegrationById(
          fresh.organizationId,
          fresh.id
        )) || null
      );
    } catch (err) {
      // Transient errors: silently fall through. ensureFreshToken is
      // best-effort — the reactive 401-refresh path inside post.workflow
      // will get another chance once postSocial actually fails. We
      // explicitly DO NOT call setBetweenSteps here, because that would
      // disable the integration on every network blip during pre-flight
      // checks.
      if (err instanceof TransientRefreshError) {
        return false;
      }

      // Truly unexpected error — same conservative treatment as
      // refreshToken: park in inBetweenSteps so an operator can investigate.
      try {
        await this._refreshIntegrationService.setBetweenSteps(fresh);
      } catch (_) {}
      return false;
    }
  }
}
