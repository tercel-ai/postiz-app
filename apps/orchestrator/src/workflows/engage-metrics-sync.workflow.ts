import { log, proxyActivities, sleep } from '@temporalio/workflow';
import type { EngageDataTicksActivity } from '@gitroom/orchestrator/activities/engage-data-ticks.activity';

const { syncEngageMetrics } = proxyActivities<EngageDataTicksActivity>({
  startToCloseTimeout: '10 minutes',
  retry: {
    maximumAttempts: 3,
    backoffCoefficient: 2,
    initialInterval: '5 minutes',
  },
});

const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

/**
 * Metrics sync for a single Engage sent reply.
 * Sleeps 24h after send, then:
 *   - X path:      check if original author replied to our reply → set authorReplied
 *   - Reddit path: fetch comment metrics → write to Post.analytics + check authorReplied
 */
export async function engageMetricsSyncWorkflow(
  sentReplyId: string
): Promise<void> {
  await sleep(TWENTY_FOUR_HOURS);

  try {
    await syncEngageMetrics(sentReplyId);
  } catch (err) {
    log.error(`engageMetricsSyncWorkflow failed for sentReplyId=${sentReplyId}`, { error: String(err) });
  }
}
