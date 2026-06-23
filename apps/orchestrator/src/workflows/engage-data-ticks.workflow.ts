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

// Cheap settings read — gates the whole periodic body. Short timeout; a read
// failure defaults to "disabled" (see workflow body) so a settings outage can
// never silently turn the background refresh back on.
const { isPeriodicMetricsEnabled } = proxyActivities<EngageDataTicksActivity>({
  startToCloseTimeout: '30 seconds',
  retry: {
    maximumAttempts: 2,
    backoffCoefficient: 2,
    initialInterval: '5 seconds',
  },
});

/**
 * Daily Engage metrics refresh + DataTicks aggregation — runs at UTC 01:00.
 * Runs after dataTicksSyncWorkflow (00:05) so calendar Post metrics are fresh.
 *
 * Gated by the `engage_periodic_metrics_enabled` setting (read fresh each cycle
 * via isPeriodicMetricsEnabled). When DISABLED (the default), the whole body is
 * skipped: metrics refresh on page-visit only ("no views → no update"), and the
 * workflow just loops to stay alive so an admin can flip it on without a restart.
 * When ENABLED: step 1 re-polls every engage reply published in the lookback
 * window so its Post.impressions/trafficScore keep updating daily (the dashboard
 * and /engage/sent read Post directly); step 2 rolls yesterday's values into
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

  // Default to disabled on read failure: a settings outage must never silently
  // re-enable the background refresh the product deliberately turned off.
  let periodicEnabled = false;
  try {
    periodicEnabled = await isPeriodicMetricsEnabled();
  } catch (err) {
    log.warn(
      'engageDataTicksWorkflow: failed to read periodic-metrics toggle, defaulting to disabled',
      { error: String(err) }
    );
  }

  if (periodicEnabled) {
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
  } else {
    log.info(
      'engageDataTicksWorkflow: periodic metrics disabled (settings) — skipping background refresh; metrics update on page-visit only'
    );
  }

  await continueAsNew<typeof engageDataTicksWorkflow>();
}
