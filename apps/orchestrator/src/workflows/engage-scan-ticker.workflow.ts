import {
  condition,
  continueAsNew,
  defineSignal,
  log,
  proxyActivities,
  setHandler,
} from '@temporalio/workflow';
import type { EngageScanActivity } from '@gitroom/orchestrator/activities/engage-scan.activity';

// Forces the next run to scan ALL units immediately (bypassing the per-type
// cadence gate, but not the rate-limit cooldown). Used for user-triggered
// "scan now".
export const triggerScanNowSignal = defineSignal('triggerScanNow');

const { runDueScans } = proxyActivities<EngageScanActivity>({
  startToCloseTimeout: '20 minutes',
  heartbeatTimeout: '2 minutes',
  // maximumAttempts:1 — the scan activity includes non-idempotent hit-count
  // increments. A retry would double-count. The next tick recovers.
  retry: { maximumAttempts: 1 },
});

/**
 * Single engage scan ticker — one global instance (workflowId
 * `engage-scan-ticker`). Wakes every `tickMinutes` and runs whichever scan
 * units are DUE; the per-type cadence + per-unit rate-limit cooldown are
 * enforced inside the activity (runDueScans), so a frequent tick lets a
 * cooled-down unit recover on the next tick — finer than the long keyword
 * cadence. A `triggerScanNow` signal wakes it early and forces all units.
 *
 * Replaces the three fixed-interval workflows (engage-keyword/channel/tracked).
 * Interval via ENGAGE_SCAN_TICK_MINUTES (default 5).
 */
export async function engageScanTickerWorkflow(tickMinutes = 5): Promise<void> {
  let force = false;
  setHandler(triggerScanNowSignal, () => {
    force = true;
  });

  // Sleep one tick, but wake immediately if a force signal arrives.
  await condition(() => force, tickMinutes * 60 * 1000);

  const runForce = force;
  force = false;

  try {
    await runDueScans(runForce);
  } catch (err) {
    log.error('engageScanTickerWorkflow runDueScans failed', {
      error: String(err),
    });
  }

  await continueAsNew<typeof engageScanTickerWorkflow>(tickMinutes);
}
