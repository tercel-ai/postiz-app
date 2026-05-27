import {
  condition,
  continueAsNew,
  defineSignal,
  log,
  proxyActivities,
  setHandler,
} from '@temporalio/workflow';
import type { EngageScanActivity } from '@gitroom/orchestrator/activities/engage-scan.activity';

export const triggerChannelScanNowSignal = defineSignal('triggerChannelScanNow');

const { runGlobalChannelScan } = proxyActivities<EngageScanActivity>({
  startToCloseTimeout: '20 minutes',
  heartbeatTimeout: '2 minutes',
  retry: {
    maximumAttempts: 3,
    backoffCoefficient: 2,
    initialInterval: '5 minutes',
  },
});

/**
 * Global monitored-channel scan workflow — single instance, interval-based.
 * Searches each unique subreddit × all enabled keywords across orgs,
 * then fans out to per-org EngageOpportunity rows.
 * Interval controlled by ENGAGE_CHANNEL_SCAN_INTERVAL_HOURS (default 3h).
 */
export async function engageGlobalChannelScanWorkflow(
  runImmediately = false,
  intervalHours = 3
): Promise<void> {
  let runNow = runImmediately;
  setHandler(triggerChannelScanNowSignal, () => {
    runNow = true;
  });

  if (!runNow) {
    await condition(() => runNow, intervalHours * 60 * 60 * 1000);
  }

  runNow = false;

  try {
    await runGlobalChannelScan();
  } catch (err) {
    log.error('engageGlobalChannelScanWorkflow failed', { error: String(err) });
  }

  await continueAsNew<typeof engageGlobalChannelScanWorkflow>(runNow, intervalHours);
}
