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
      await this.parkIntegration(integration, err);
      return false;
    }
  }

  /**
   * Best-effort park: mark integration as inBetweenSteps + emit operator
   * notification. Wraps the underlying service call so a failure here does
   * not crash the activity, but DOES log the underlying error — the
   * pre-existing empty `catch (_) {}` was effectively a black hole that made
   * partial-disabled integrations un-diagnosable in production (D8 finding).
   */
  private async parkIntegration(integration: Integration, originalErr: unknown) {
    try {
      await this._refreshIntegrationService.setBetweenSteps(integration);
    } catch (parkErr) {
      console.warn(
        `[parkIntegration] setBetweenSteps failed for integration=${integration.id} provider=${integration.providerIdentifier}. ` +
          `Original error: ${(originalErr as any)?.message ?? originalErr}. ` +
          `Park error: ${(parkErr as any)?.message ?? parkErr}`
      );
    }
  }

  /**
   * Proactive token refresh, called by post.workflow.v1.0.1 right before
   * `postSocial`. Reads the freshest copy of the Integration row from the DB
   * (the one carried by the workflow may be stale — the per-platform
   * refreshTokenWorkflow could have rotated the token while the post slept
   * until publishDate) and refreshes if it is within `bufferMs` of expiry.
   *
   * Scope (CRITICAL — fixes Layer-1/Layer-2 race condition):
   *  - For providers with `refreshCron = true` (X / Threads / Instagram-Standalone),
   *    a per-integration `refreshTokenWorkflow` already proactively refreshes
   *    via a workflowId-bound Temporal workflow (refresh.integration.service.ts
   *    startRefreshWorkflow). Running ensureFreshToken in parallel with that
   *    workflow can cause both code paths to call `socialProvider.refreshToken`
   *    simultaneously, and on providers that rotate refresh_tokens (X v2,
   *    Threads, IG) the second call sees an already-revoked refresh_token →
   *    400/invalid_grant → permanent failure path → refreshNeeded=true →
   *    healthy account flipped to disabled. This re-introduces the exact bug
   *    the proactive-refresh design is supposed to eliminate.
   *  - SOLUTION: refreshCron providers are SKIPPED here. Layer 1 covers them.
   *    If Layer 1 is broken (workflow died, recovery cron hasn't run yet),
   *    Layer 3 (reactive 401 inside post.workflow's retry loop) is the
   *    fallback — still strictly better than racing.
   *  - ensureFreshToken's job is the non-refreshCron platforms (LinkedIn,
   *    TikTok, Facebook, YouTube, Mastodon, Bluesky, Pinterest, etc.) which
   *    have NO background refresh and previously relied entirely on reactive
   *    401 handling.
   *
   * Best-effort semantics:
   *  - This activity is documented as best-effort. The reactive 401 path
   *    inside post.workflow is the source of truth for "is the token usable".
   *    Failures here MUST NOT disable a healthy account — a Prisma connection
   *    blip during ensureFreshToken caused a confirmed regression in
   *    pre-review behavior.
   *
   * Return value:
   *  - `null` if no refresh was needed or no refresh is possible (permanent
   *    token, no expiration set, integration missing, refreshCron skip).
   *    Caller keeps using the token already on `integration`.
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

    // inBetweenSteps means Layer 1 (or a prior Layer-2 invocation) is
    // currently transitioning this integration. Concurrent refresh would
    // race; defer to whatever is in flight.
    if (fresh.inBetweenSteps) {
      return null;
    }

    const socialProvider = this._integrationManager.getSocialIntegration(
      fresh.providerIdentifier
    );
    if (socialProvider.isTokenPermanent?.(fresh.token)) {
      return null;
    }

    // Race-prevention: providers with refreshCron=true have a dedicated
    // workflowId-bound refresh workflow. Skip here to avoid the dual-refresh
    // refresh-token-rotation race described in the doc comment above.
    if (socialProvider.refreshCron) {
      return fresh;
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
        // refreshProcess already marked refreshNeeded + disconnected for
        // permanent failures. Nothing more to do here.
        console.warn(
          `[ensureFreshToken] permanent refresh failure for integration=${fresh.id} provider=${fresh.providerIdentifier}; integration marked refreshNeeded by refreshProcess`
        );
        return false;
      }
      if (socialProvider.refreshWait) {
        await timer(10000);
      }
      console.info(
        `[ensureFreshToken] refreshed token for integration=${fresh.id} provider=${fresh.providerIdentifier} msToExpiry_before=${msToExpiry}`
      );
      // Re-read so the caller sees the updated token + new tokenExpiration.
      return (
        (await this._integrationService.getIntegrationById(
          fresh.organizationId,
          fresh.id
        )) || null
      );
    } catch (err) {
      // Transient errors (TransientRefreshError) — silently fall through.
      // The reactive 401 path inside post.workflow will handle once
      // postSocial actually fails. We DO NOT setBetweenSteps here because
      // ensureFreshToken is best-effort and the reactive path is robust.
      if (err instanceof TransientRefreshError) {
        console.warn(
          `[ensureFreshToken] transient refresh failure for integration=${fresh.id} provider=${fresh.providerIdentifier}: ${(err as any)?.message ?? err}. Falling through to reactive 401 path.`
        );
        return false;
      }

      // Truly unexpected error — this is best-effort pre-flight. A bug here
      // (Prisma blip, code path bug, integrationManager surprise) must NOT
      // disable a healthy account. We log loudly and fall through; the
      // reactive 401 path is responsible for actual token validity.
      console.error(
        `[ensureFreshToken] unexpected error for integration=${fresh.id} provider=${fresh.providerIdentifier}: ${(err as any)?.message ?? err}. Returning false; integration NOT disabled (reactive path is authoritative).`,
        err
      );
      return false;
    }
  }
}
