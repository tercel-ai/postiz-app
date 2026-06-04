import { PostActivity } from '@gitroom/orchestrator/activities/post.activity';
import {
  ActivityFailure,
  ApplicationFailure,
  continueAsNew,
  proxyActivities,
  sleep,
} from '@temporalio/workflow';
import dayjs from 'dayjs';
import { Integration } from '@prisma/client';
import { capitalize, sortBy } from 'lodash';
import { PostResponse } from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import { makeId } from '@gitroom/nestjs-libraries/services/make.is';

const proxyTaskQueue = (taskQueue: string, noRetry = false) => {
  return proxyActivities<PostActivity>({
    startToCloseTimeout: '10 minute',
    taskQueue,
    retry: noRetry
      ? { maximumAttempts: 1 }
      : {
          maximumAttempts: 3,
          backoffCoefficient: 1,
          initialInterval: '2 minutes',
        },
  });
};

// Heavy activities (postSocial, postComment) get a longer timeout to accommodate
// large media uploads (LinkedIn/X videos) that can exceed 10 minutes.
const proxyTaskQueueHeavy = (taskQueue: string, noRetry = false) => {
  return proxyActivities<PostActivity>({
    startToCloseTimeout: '30 minute',
    taskQueue,
    retry: noRetry
      ? { maximumAttempts: 1 }
      : {
          maximumAttempts: 3,
          backoffCoefficient: 1,
          initialInterval: '2 minutes',
        },
  });
};

const {
  getPostsList,
  inAppNotification,
  changeState,
  logError,
  updatePost,
  sendWebhooks,
  isCommentable,
  claimPostForPublishing,
  prepareRecurringCycle,
  finalizeRecurringCycle,
  syncEngageOnPublish,
} = proxyActivities<PostActivity>({
  startToCloseTimeout: '10 minute',
  retry: {
    maximumAttempts: 3,
    backoffCoefficient: 1,
    initialInterval: '2 minutes',
  },
});


const iterate = Array.from({ length: 5 });

export async function postWorkflowV101({
  taskQueue,
  postId,
  organizationId,
  postNow = false,
  postNowRetry = false,
}: {
  taskQueue: string;
  postId: string;
  organizationId: string;
  postNow?: boolean;
  /** Whether to retry on failure for postNow. Controlled by POST_NOW_RETRY env var, resolved at call site. */
  postNowRetry?: boolean;
}) {
  // noRetry=true when posting immediately AND retry is disabled (postNowRetry=false).
  // Scheduled posts always use the full retry policy.
  const noRetry = postNow && !postNowRetry;

  // Dynamic task queue, for concurrency
  const {
    postThreadFinisher,
    getIntegrationById,
    refreshToken,
    ensureFreshToken,
    markIntegrationRefreshNeeded,
    internalPlugs,
    globalPlugs,
    processInternalPlug,
    processPlug,
  } = proxyTaskQueue(taskQueue, noRetry);

  const { postSocial, postComment } = proxyTaskQueueHeavy(taskQueue, noRetry);

  // get all the posts and comments to post
  const postsListBefore = await getPostsList(organizationId, postId);
  const [post] = postsListBefore;
  // publishDate arrives as an ISO string from JSON serialization across
  // the Temporal activity boundary, but TypeScript types it as Date.
  const publishDateStr = String(post?.publishDate ?? '');

  // in case doesn't exists for some reason, fail it
  if (!post || (!postNow && post.state !== 'QUEUE')) {
    return;
  }

  // Defensive guard: the publish pipeline below dereferences post.integration
  // unconditionally (token refresh, providerIdentifier, webhooks). A null
  // integration must never reach here — engage manual replies are created as
  // PUBLISHED and bypass this workflow, and send/schedule require an integration —
  // but if one ever does, return rather than throw a TypeError mid-publish.
  if (!post.integration) {
    return;
  }

  // sleep until publishDate
  if (!postNow) {
    await sleep(
      dayjs(post.publishDate).isBefore(dayjs())
        ? 0
        : dayjs(post.publishDate).diff(dayjs(), 'millisecond')
    );
  }

  // Re-check post state after sleep to prevent duplicate publishing.
  // Another workflow may have already published and advanced the
  // publishDate while we were sleeping.
  if (!postNow) {
    const postsListAfterSleep = await getPostsList(organizationId, postId);
    const [freshPost] = postsListAfterSleep;
    if (!freshPost || freshPost.state !== 'QUEUE') {
      return;
    }
    // For recurring posts, state stays QUEUE after publishing — the only
    // indicator that this cycle was already handled is an advanced publishDate.
    if (freshPost.publishDate && post.publishDate &&
        new Date(freshPost.publishDate).getTime() !== new Date(post.publishDate).getTime()) {
      return;
    }
  }

  const isRecurring = !!(post as any).intervalInDays;
  let cycleCloneId: string | null = null;
  const claimToken = `claim_${new Date().toISOString()}_${makeId(6)}`;

  // ── Recurring post: pre-publish idempotent lock ──
  // Create a QUEUE clone BEFORE calling postSocial. The claimToken acts as
  // an atomic lock — only one workflow can claim a QUEUE clone. If the clone
  // is already PUBLISHED/ERROR or claimed by another workflow, skip.
  // NOTE: After deploying this code, all old Temporal workflow executions
  // must be terminated so they restart with this new activity sequence.
  if (isRecurring) {
    const prepared = await prepareRecurringCycle(postId, publishDateStr, claimToken);
    if (prepared?.alreadyHandled) {
      return;
    }
    cycleCloneId = prepared?.clone?.id ?? null;
  }

  // if refresh is needed from last time, let's inform the user
  if (post.integration?.refreshNeeded) {
    await inAppNotification(
      post.organizationId,
      `We couldn't post to ${post.integration?.providerIdentifier} for ${post?.integration?.name}`,
      `We couldn't post to ${post.integration?.providerIdentifier} for ${post?.integration?.name} because you need to reconnect it. Please enable it and try again.`,
      true,
      false,
      'info'
    );
    if (isRecurring && cycleCloneId) {
      await finalizeRecurringCycle(postId, cycleCloneId, publishDateStr, {
        state: 'ERROR',
        error: 'Integration requires reconnection',
      });
    }
    // Non-recurring posts must be explicitly marked ERROR — without this they
    // remain in QUEUE indefinitely and appear "pending" to the user.
    if (!isRecurring) {
      await changeState(postId, 'ERROR', 'Integration requires reconnection', postsListBefore);
    }
    if (isRecurring) {
      await continueAsNew<typeof postWorkflowV101>({ taskQueue, postId, organizationId });
    }
    return;
  }

  // if it's disabled, inform the user
  if (post.integration?.disabled) {
    await inAppNotification(
      post.organizationId,
      `We couldn't post to ${post.integration?.providerIdentifier} for ${post?.integration?.name}`,
      `We couldn't post to ${post.integration?.providerIdentifier} for ${post?.integration?.name} because it's disabled. Please enable it and try again.`,
      true,
      false,
      'info'
    );
    if (isRecurring && cycleCloneId) {
      await finalizeRecurringCycle(postId, cycleCloneId, publishDateStr, {
        state: 'ERROR',
        error: 'Integration is disabled',
      });
    }
    // Same as above — non-recurring posts must be explicitly marked ERROR.
    if (!isRecurring) {
      await changeState(postId, 'ERROR', 'Integration is disabled', postsListBefore);
    }
    if (isRecurring) {
      await continueAsNew<typeof postWorkflowV101>({ taskQueue, postId, organizationId });
    }
    return;
  }

  // ── Non-recurring post: atomic claim before publishing ──
  if (!isRecurring) {
    const claimed = await claimPostForPublishing(postId, claimToken);
    if (!claimed) {
      return;
    }
  }

  // ── Proactive token refresh ──
  // Before contacting the social platform, make sure the access token is not
  // about to expire. This is the only proactive refresh path for providers
  // without `refreshCron = true` (LinkedIn / TikTok / Facebook / YouTube /
  // Mastodon / Bluesky / Pinterest etc.) and an extra safety net for the rest.
  //
  // Behavior:
  //   - Non-fatal: any failure here falls through to postSocial; the existing
  //     reactive 401 → refresh → retry path inside the loop still runs.
  //   - 10-minute buffer matches refresh.token.workflow.ts. See that file for
  //     the rationale (refresh activity itself can take up to ~6 min worst-case).
  try {
    const refreshed = await ensureFreshToken(post.integration as Integration, 10 * 60 * 1000);
    // ensureFreshToken returns Integration | null | false; only Integration is truthy.
    if (refreshed) {
      post.integration = refreshed as any;
    }
  } catch (_) {
    // Activity-level errors are intentionally swallowed — see comment above.
  }

  // Do we need to post comment for this social?
  const toComment: boolean =
    postsListBefore.length === 1
      ? false
      : await isCommentable(post.integration);

  const postsList = toComment ? postsListBefore : [postsListBefore[0]];

  // list of all the saved results
  const postsResults: PostResponse[] = [];

  // iterate over the posts
  for (let i = 0; i < postsList.length; i++) {
    const before = postsResults.length;
    let lastErr: unknown = null;

    // When i=0 (main post) fails, mark the main post ERROR (covers the whole group
    // since the main post was never published).
    // When i>0 (thread item) fails, the main post is already PUBLISHED — mark only
    // the failed thread item and any remaining unposted items as ERROR.
    // Loop starts at j=i, so already-PUBLISHED items (j<i) are never touched.
    const markError = async (errMsg: string) => {
      if (i === 0) {
        await changeState(postsList[0].id, 'ERROR', errMsg, postsList);
      } else {
        for (let j = i; j < postsList.length; j++) {
          const reason = j === i ? errMsg : 'Thread chain broken — previous item failed to post';
          await changeState(postsList[j].id, 'ERROR', reason, postsList);
        }
      }
    };

    // For recurring posts: finalize the cycle clone with the correct state.
    // When i=0 fails, the main post was never published → ERROR.
    // When i>0 fails, the main post was already published → PUBLISHED (thread
    // item failure is tracked separately via markError on the thread posts).
    // TODO(webhooks): when i>0 fails, sendWebhooks/plugs should still fire for
    // the successfully-published main post. Currently the error paths return early
    // before reaching sendWebhooks. Restructuring requires extracting the thread
    // loop — defer until a full workflow refactor.
    const finalizeCycle = async (errMsg: string) => {
      if (!isRecurring || !cycleCloneId) return;
      if (i === 0) {
        await finalizeRecurringCycle(postId, cycleCloneId, publishDateStr, {
          state: 'ERROR',
          error: errMsg,
        });
      } else {
        await finalizeRecurringCycle(postId, cycleCloneId, publishDateStr, {
          state: 'PUBLISHED',
          releaseId: postsResults[0].postId,
          releaseURL: postsResults[0].releaseURL,
        });
      }
    };

    // Apply thread delay once, BEFORE the retry loop — retries should not re-wait.
    // delay field unit: minutes (1 → 60 000 ms). Note: plug delays elsewhere in
    // this workflow are already in milliseconds and do NOT multiply by 60000.
    if (i > 0 && postsList[i].delay) {
      await sleep(60000 * Math.max(0, Number(postsList[i].delay ?? 0)));
    }

    // Retry loop: noRetry (postNow + POST_NOW_RETRY=false) gets 1 attempt,
    // otherwise 5 attempts (postNow+retry=true or scheduled posts).
    //
    // IMPORTANT: updatePost is intentionally outside this loop. Putting it
    // inside would cause postSocial to be retried if the DB write fails —
    // the social platform call already succeeded and a retry would duplicate
    // the post. updatePost is called once after the loop succeeds.
    const maxAttempts = noRetry ? [undefined] : iterate;
    // SINGLE-REFRESH POLICY: a fresh access_token obtained from a successful
    // refresh call must not need another refresh on the very next postSocial.
    // If it does, the refresh_token itself is rotated/revoked/dead and the
    // user must reconnect — looping more would only burn OAuth refresh quota
    // and delay the user-facing "please reconnect" signal.
    let alreadyRefreshed = false;
    for (const _ of maxAttempts) {
      try {
        // first post the main post
        if (i === 0) {
          postsResults.push(
            ...(await postSocial(post.integration as Integration, [
              postsList[i],
            ]))
          );

          // then post the comments if any
        } else {
          postsResults.push(
            ...(await postComment(
              postsResults[0].postId,
              postsResults.length === 1
                ? undefined
                : postsResults[i - 1].postId,
              post.integration,
              [postsList[i]]
            ))
          );
        }

        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;

        // if token refresh is needed, do it and repeat
        if (
          err instanceof ActivityFailure &&
          err.cause instanceof ApplicationFailure &&
          err.cause.type === 'refresh_token'
        ) {
          // GUARD: if we already refreshed once in this retry loop and the
          // brand-new access_token STILL gets refresh_token errors, the
          // refresh_token itself is no longer functional. Stop the loop,
          // mark the integration as refreshNeeded so the user is prompted to
          // reconnect, and bail this post.
          if (alreadyRefreshed) {
            await markIntegrationRefreshNeeded(post.integration as Integration);
            const reason =
              'X authentication is no longer valid (refresh succeeded but the new token was rejected). Please reconnect your account.';
            await markError(reason);
            await finalizeCycle(reason);
            if (isRecurring) {
              await continueAsNew<typeof postWorkflowV101>({ taskQueue, postId, organizationId });
            }
            return false;
          }

          // refreshToken activity may throw if Temporal exhausted its retries
          // on a transient platform error (5xx / 429 / network). When that
          // happens the integration is healthy but unreachable right now —
          // we must NOT mark refreshNeeded; just fail this post attempt and
          // let the outer retry / next workflow cycle try again.
          let refresh: false | { accessToken?: string } = false;
          let refreshTransient = false;
          try {
            refresh = await refreshToken(post.integration);
          } catch (refreshErr) {
            refreshTransient = true;
          }

          if (!refresh || !refresh.accessToken) {
            // refresh = false means the refresh API call returned a permanent
            // failure (refresh_token 401 / invalid_grant / 4xx). refreshProcess
            // already marked refreshNeeded=true + disconnectChannel. Don't
            // double-mark; just surface a clear user-facing message.
            const reason = refreshTransient
              ? 'Token refresh temporarily unavailable (platform 5xx / rate-limited). Will retry on next scheduled cycle.'
              : 'Token refresh failed — please reconnect your account';
            await markError(reason);
            await finalizeCycle(reason);
            if (isRecurring) {
              await continueAsNew<typeof postWorkflowV101>({ taskQueue, postId, organizationId });
            }
            return false;
          }

          alreadyRefreshed = true;

          post.integration.token = refresh.accessToken;
          continue;
        }

        // specific case for bad body errors — no point retrying
        if (
          err instanceof ActivityFailure &&
          err.cause instanceof ApplicationFailure &&
          err.cause.type === 'bad_body'
        ) {
          const errMsg = err.cause.message || err.cause.type || 'Unknown error';
          await logError(postsList[i].id, err, postsList);
          await finalizeCycle(errMsg);
          await markError(errMsg);
          await inAppNotification(
            post.organizationId,
            `Error posting${i === 0 ? ' ' : ' comments '}on ${
              post.integration?.providerIdentifier
            } for ${post?.integration?.name}`,
            `An error occurred while posting${i === 0 ? ' ' : ' comments '}on ${
              post.integration?.providerIdentifier
            }${err?.cause?.message ? `: ${err?.cause?.message}` : ``}`,
            true,
            false,
            'fail'
          );
          if (isRecurring) {
            await continueAsNew<typeof postWorkflowV101>({ taskQueue, postId, organizationId });
          }
          return false;
        }

        // Other errors: don't log yet — there may be more retries (log once at exhaustion).
      }
    }

    if (postsResults.length === before) {
      // all retries exhausted without success — log once here (not per retry attempt)
      const errMsg = lastErr instanceof ActivityFailure && lastErr.cause instanceof ApplicationFailure
        ? lastErr.cause.message || lastErr.cause.type || 'Unknown error'
        : String(lastErr ?? 'Unknown error');
      await logError(postsList[i].id, lastErr, postsList);
      await finalizeCycle(errMsg);
      await markError(errMsg);
      if (isRecurring) {
        await continueAsNew<typeof postWorkflowV101>({ taskQueue, postId, organizationId });
      }
      return false;
    }

    // For non-recurring posts: update the DB record with the platform post ID and URL.
    // This is intentionally outside the postSocial retry loop — a DB write failure
    // must NOT cause the social platform call to be retried (which would duplicate the post).
    //
    // If updatePost itself fails after all Temporal retries (persistent DB outage),
    // we do NOT let the workflow crash — a crashed workflow leaves the post in QUEUE
    // with a stale claim token, which the recovery cron would clear and re-publish
    // (another duplicate). Instead we log and mark ERROR with a message that includes
    // the platform post ID so the user knows the content WAS actually published.
    if (!isRecurring) {
      try {
        await updatePost(
          postsList[i].id,
          postsResults[i].postId,
          postsResults[i].releaseURL
        );
      } catch (updateErr) {
        const platformPostId = postsResults[i].postId;
        const releaseURL = postsResults[i].releaseURL;
        const errMsg = `Post was published on ${post.integration?.providerIdentifier} (${releaseURL}, id=${platformPostId}) but the DB record could not be updated. Please manually mark this post as published.`;
        console.error(`[postWorkflow] updatePost failed for post=${postsList[i].id} platformId=${platformPostId}:`, (updateErr as any)?.message || updateErr);
        await logError(postsList[i].id, updateErr, postsList);
        await finalizeCycle(errMsg);
        await markError(errMsg);
        if (isRecurring) {
          await continueAsNew<typeof postWorkflowV101>({ taskQueue, postId, organizationId });
        }
        return false;
      }

      // Best-effort: if this was a scheduled engage reply, transition
      // EngageOpportunityState SCHEDULED → REPLIED and start metrics sync.
      try {
        await syncEngageOnPublish(postsList[i].id);
      } catch {
        // non-fatal — engage sync failure must not affect the post's PUBLISHED state
      }
    }

    // send notification after successful post (outside try-catch to avoid
    // notification failures overwriting the PUBLISHED state to ERROR)
    if (i === 0) {
      try {
        await inAppNotification(
          post.integration.organizationId,
          `Your post has been published on ${capitalize(
            post.integration.providerIdentifier
          )}`,
          `Your post has been published on ${capitalize(
            post.integration.providerIdentifier
          )} at ${postsResults[0].releaseURL}`,
          true,
          true
        );
      } catch (_) {
        // notification failure should not affect post state
      }
    }
  }

  // ── Thread finisher: append a wrap-up reply after all posted items ──
  if (postsResults.length > 0) {
    try {
      const firstSettings = JSON.parse(postsList[0].settings || '{}');
      const canComment = await isCommentable(post.integration);
      if (
        canComment &&
        firstSettings.active_thread_finisher &&
        firstSettings.thread_finisher
      ) {
        await postThreadFinisher(
          postsResults[0].postId,
          postsResults[postsResults.length - 1].postId,
          post.integration as Integration,
          firstSettings.thread_finisher,
          postsResults[0].releaseURL
        );
      }
    } catch (err) {
      // Thread finisher failure should not affect the overall post state
      console.warn('[workflow] Thread finisher failed:', err);
    }
  }

  // ── Recurring post: finalize with PUBLISHED + advance publishDate ──
  if (isRecurring && cycleCloneId) {
    await finalizeRecurringCycle(postId, cycleCloneId, publishDateStr, {
      state: 'PUBLISHED',
      releaseId: postsResults[0].postId,
      releaseURL: postsResults[0].releaseURL,
    });
  }

  // send webhooks for the post
  await sendWebhooks(
    postsResults[0].postId,
    post.organizationId,
    post.integration.id
  );

  // load internal plugs like repost by other users
  const internalPlugsList = await internalPlugs(
    post.integration,
    JSON.parse(post.settings)
  );

  // load global plugs, like repost a post if it gets to a certain number of likes
  const globalPlugsList = (await globalPlugs(post.integration)).reduce(
    (all, current) => {
      for (let i = 1; i <= current.totalRuns; i++) {
        all.push({
          ...current,
          delay: current.delay * i,
        });
      }

      return all;
    },
    []
  );

  // Sort all the actions by delay, so we can process them in order
  const list = sortBy(
    [...internalPlugsList, ...globalPlugsList],
    'delay'
  );

  // process all the plugs in order
  while (list.length > 0) {
    const todo = list.shift();

    await sleep(Math.max(0, Number(todo.delay ?? 0)));

    if (todo.type === 'internal-plug') {
      for (const _ of iterate) {
        try {
          await processInternalPlug({ ...todo, post: postsResults[0].postId });
        } catch (err) {
          if (
            err instanceof ActivityFailure &&
            err.cause instanceof ApplicationFailure &&
            err.cause.type === 'refresh_token'
          ) {
            // refreshToken may now throw on transient platform errors;
            // catch so plug failure cannot crash the parent workflow.
            let refresh: false | { accessToken?: string } = false;
            try {
              refresh = await refreshToken(
                await getIntegrationById(organizationId, todo.integration)
              );
            } catch (_) {
              refresh = false;
            }
            if (!refresh || !refresh.accessToken) {
              break;
            }
            continue;
          }
          if (
            err instanceof ActivityFailure &&
            err.cause instanceof ApplicationFailure &&
            err.cause.type === 'bad_body'
          ) {
            break;
          }
          continue;
        }
        break;
      }
    }

    if (todo.type === 'global') {
      for (const _ of iterate) {
        try {
          const process = await processPlug({
            ...todo,
            postId: postsResults[0].postId,
          });
          if (process) {
            const toDelete = list
              .reduce((all, current, index) => {
                if (current.plugId === todo.plugId) {
                  all.push(index);
                }
                return all;
              }, [])
              .reverse();

            for (const index of toDelete) {
              list.splice(index, 1);
            }
          }
        } catch (err) {
          if (
            err instanceof ActivityFailure &&
            err.cause instanceof ApplicationFailure &&
            err.cause.type === 'refresh_token'
          ) {
            // Same transient-safe wrapper as the internal-plug path above.
            let refresh: false | { accessToken?: string } = false;
            try {
              refresh = await refreshToken(post.integration);
            } catch (_) {
              refresh = false;
            }
            if (!refresh || !refresh.accessToken) {
              break;
            }
            continue;
          }
          if (
            err instanceof ActivityFailure &&
            err.cause instanceof ApplicationFailure &&
            err.cause.type === 'bad_body'
          ) {
            break;
          }
          continue;
        }
        break;
      }
    }
  }

  // ── Recurring post: schedule the next cycle ──
  if (isRecurring) {
    await continueAsNew<typeof postWorkflowV101>({ taskQueue, postId, organizationId });
  }
}
