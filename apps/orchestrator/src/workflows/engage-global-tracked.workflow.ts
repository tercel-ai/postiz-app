import {
  condition,
  continueAsNew,
  defineSignal,
  log,
  proxyActivities,
  setHandler,
} from '@temporalio/workflow';
import type { EngageScanActivity } from '@gitroom/orchestrator/activities/engage-scan.activity';

export const triggerTrackedScanNowSignal = defineSignal('triggerTrackedScanNow');

const { runGlobalTrackedAccountsScan } = proxyActivities<EngageScanActivity>({
  startToCloseTimeout: '20 minutes',
  heartbeatTimeout: '2 minutes',
  retry: { maximumAttempts: 1 },
});

/**
 * Global tracked-accounts scan workflow — single instance, interval-based.
 * Fetches each unique tracked X username once, fans out to per-org EngageOpportunity rows.
 * Interval controlled by ENGAGE_TRACKED_SCAN_INTERVAL_HOURS (default 3h).
 */
export async function engageGlobalTrackedWorkflow(
  runImmediately = false,
  intervalHours = 3
): Promise<void> {
  let runNow = runImmediately;
  setHandler(triggerTrackedScanNowSignal, () => {
    runNow = true;
  });

  if (!runNow) {
    await condition(() => runNow, intervalHours * 60 * 60 * 1000);
  }

  runNow = false;

  try {
    await runGlobalTrackedAccountsScan();
  } catch (err) {
    log.error('engageGlobalTrackedWorkflow failed', { error: String(err) });
  }

  await continueAsNew<typeof engageGlobalTrackedWorkflow>(runNow, intervalHours);
}
