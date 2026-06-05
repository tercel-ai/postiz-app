import {
  continueAsNew,
  log,
  proxyActivities,
  sleep,
} from '@temporalio/workflow';
import type { EngageDataTicksActivity } from '@gitroom/orchestrator/activities/engage-data-ticks.activity';

const { aggregateDailyEngageTicks } = proxyActivities<EngageDataTicksActivity>({
  startToCloseTimeout: '30 minutes',
  // engage-data-ticks.activity emits Context.heartbeat() per org while aggregating.
  heartbeatTimeout: '2 minutes',
  retry: {
    maximumAttempts: 3,
    backoffCoefficient: 2,
    initialInterval: '5 minutes',
  },
});

// Daily re-fetch hits external APIs (X/Reddit) once per reply in the lookback
// window, so it gets a longer timeout and heartbeats per reply. Retries are
// capped lower than the aggregation — a partial resync still leaves Post values
// fresher than before, and the run repeats tomorrow regardless.
const { resyncRecentEngageMetrics } = proxyActivities<EngageDataTicksActivity>({
  startToCloseTimeout: '60 minutes',
  heartbeatTimeout: '2 minutes',
  retry: {
    maximumAttempts: 2,
    backoffCoefficient: 2,
    initialInterval: '5 minutes',
  },
});

/**
 * Daily Engage metrics refresh + DataTicks aggregation — runs at UTC 01:00.
 * Runs after dataTicksSyncWorkflow (00:05) so calendar Post metrics are fresh.
 * Step 1 re-polls every engage reply published in the lookback window so its
 * Post.impressions/trafficScore keep updating daily (the dashboard and
 * /engage/sent read Post directly); step 2 rolls yesterday's values into
 * EngageDataTicks. Resync failure is logged but does not block aggregation.
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
    await resyncRecentEngageMetrics();
  } catch (err) {
    log.error('engageDataTicksWorkflow: metrics resync failed', { error: String(err) });
  }

  try {
    await aggregateDailyEngageTicks();
  } catch (err) {
    log.error('engageDataTicksWorkflow failed', { error: String(err) });
  }

  await continueAsNew<typeof engageDataTicksWorkflow>();
}
