import { proxyActivities, sleep } from '@temporalio/workflow';
import { PostActivity } from '@gitroom/orchestrator/activities/post.activity';

const { searchForMissingThreeHoursPosts, markStaleQueuePostsAsError } = proxyActivities<PostActivity>({
  startToCloseTimeout: '10 minute',
  retry: {
    maximumAttempts: 3,
    backoffCoefficient: 1,
    initialInterval: '2 minutes',
  },
});

export async function missingPostWorkflow() {
  await searchForMissingThreeHoursPosts();
  await markStaleQueuePostsAsError();
  while (true) {
    await sleep('1 hour');
    await searchForMissingThreeHoursPosts();
    await markStaleQueuePostsAsError();
  }
}
