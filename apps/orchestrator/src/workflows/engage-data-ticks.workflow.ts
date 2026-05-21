import {
  continueAsNew,
  log,
  proxyActivities,
  sleep,
} from '@temporalio/workflow';
import type { EngageDataTicksActivity } from '@gitroom/orchestrator/activities/engage-data-ticks.activity';

const { aggregateDailyEngageTicks } = proxyActivities<EngageDataTicksActivity>({
  startToCloseTimeout: '30 minutes',
  retry: {
    maximumAttempts: 3,
    backoffCoefficient: 2,
    initialInterval: '5 minutes',
  },
});

/**
 * Daily Engage DataTicks aggregation — runs at UTC 01:00.
 * Runs after dataTicksSyncWorkflow (00:05) so Post.impressions/trafficScore are fresh.
 * Uses continueAsNew to prevent event history growth.
 */
export async function engageDataTicksWorkflow(): Promise<void> {
  const now = Date.now();
  const next = new Date();
  next.setUTCHours(1, 0, 0, 0);
  if (next.getTime() <= now) {
    next.setUTCDate(next.getUTCDate() + 1);
  }

  await sleep(next.getTime() - now);

  try {
    await aggregateDailyEngageTicks();
  } catch (err) {
    log.error('engageDataTicksWorkflow failed', { error: String(err) });
  }

  await continueAsNew<typeof engageDataTicksWorkflow>();
}
