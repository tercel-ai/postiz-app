import { PostActivity } from '@gitroom/orchestrator/activities/post.activity';
import {
  ActivityFailure,
  ApplicationFailure,
  proxyActivities,
  sleep,
} from '@temporalio/workflow';
import dayjs from 'dayjs';
import { Integration } from '@prisma/client';
import { capitalize, sortBy } from 'lodash';
import { PostResponse } from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import { makeId } from '@gitroom/nestjs-libraries/services/make.is';

const proxyTaskQueue = (taskQueue: string) => {
  return proxyActivities<PostActivity>({
    startToCloseTimeout: '10 minute',
    taskQueue,
    retry: {
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
  updatePost,
  sendWebhooks,
  isCommentable,
  prepareRecurringCycle,
  finalizeRecurringCycle,
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
}: {
  taskQueue: string;
  postId: string;
  organizationId: string;
  postNow?: boolean;
}) {
  // Dynamic task queue, for concurrency
  const {
    postSocial,
    postComment,
    getIntegrationById,
    refreshToken,
    internalPlugs,
    globalPlugs,
    processInternalPlug,
    processPlug,
  } = proxyTaskQueue(taskQueue);

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

  // ── Recurring post: pre-publish idempotent lock ──
  // Create a QUEUE clone BEFORE calling postSocial.  The claimToken acts as
  // an atomic lock — only one workflow can claim a QUEUE clone.  If the clone
  // is already PUBLISHED/ERROR or claimed by another workflow, skip.
  const isRecurring = !!(post as any).intervalInDays;
  let cycleCloneId: string | null = null;
  const claimToken = `claim_${new Date().toISOString()}_${makeId(6)}`;

  if (isRecurring) {
    const prepared = await prepareRecurringCycle(postId, publishDateStr, claimToken);
    if (prepared?.alreadyHandled) {
      // Another workflow already claimed, published, or recorded failure
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
    return;
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

    // this is a small trick to repeat an action in case of token refresh
    for (const _ of iterate) {
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
          if (postsList[i].delay) {
            await sleep(60000 * Math.max(0, Number(postsList[i].delay ?? 0)));
          }

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

        // For non-recurring posts: update original in place
        if (!isRecurring) {
          await updatePost(
            postsList[i].id,
            postsResults[i].postId,
            postsResults[i].releaseURL
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
          const refresh = await refreshToken(post.integration);
          if (!refresh || !refresh.accessToken) {
            await changeState(postsList[0].id, 'ERROR', err, postsList);
            if (isRecurring && cycleCloneId) {
              await finalizeRecurringCycle(postId, cycleCloneId, publishDateStr, {
                state: 'ERROR',
                error: 'Token refresh failed',
              });
            }
            return false;
          }

          post.integration.token = refresh.accessToken;
          continue;
        }

        // Log error for observability (for recurring posts this only writes to
        // Errors table without changing the original's state).
        await changeState(postsList[0].id, 'ERROR', err, postsList);

        // specific case for bad body errors — no point retrying
        if (
          err instanceof ActivityFailure &&
          err.cause instanceof ApplicationFailure &&
          err.cause.type === 'bad_body'
        ) {
          const errMsg = err.cause.message || err.cause.type || 'Unknown error';
          if (isRecurring && cycleCloneId) {
            await finalizeRecurringCycle(postId, cycleCloneId, publishDateStr, {
              state: 'ERROR',
              error: errMsg,
            });
          }
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
          return false;
        }

        // Other errors: don't record failure yet — there may be more retries.
      }
    }

    if (postsResults.length === before) {
      // all retries exhausted without success
      const errMsg = lastErr instanceof ActivityFailure && lastErr.cause instanceof ApplicationFailure
        ? lastErr.cause.message || lastErr.cause.type || 'Unknown error'
        : String(lastErr);
      if (isRecurring && cycleCloneId) {
        await finalizeRecurringCycle(postId, cycleCloneId, publishDateStr, {
          state: 'ERROR',
          error: errMsg,
        });
      }
      return false;
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
            const refresh = await refreshToken(
              await getIntegrationById(organizationId, todo.integration)
            );
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
            const refresh = await refreshToken(post.integration);
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
}
