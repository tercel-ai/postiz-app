import {
  condition,
  continueAsNew,
  defineSignal,
  log,
  proxyActivities,
  setHandler,
} from '@temporalio/workflow';
import type { EngageScanActivity } from '@gitroom/orchestrator/activities/engage-scan.activity';

// Wake-and-scan signals. Both wake the workflow from its indefinite wait; they
// differ only in how they treat the per-unit cadence gate:
//   triggerScanNow → force = true: scan ALL units immediately, bypassing the
//                    per-unit cadence gate (still honors the rate-limit
//                    cooldown). For explicit user actions (engage setup/enable).
//   triggerDueScan → force = false: wake and scan only units whose per-unit
//                    cadence is DUE. For the page-visit trigger.
export const triggerScanNowSignal = defineSignal('triggerScanNow');
export const triggerDueScanSignal = defineSignal('triggerDueScan');

const { runDueScans } = proxyActivities<EngageScanActivity>({
  startToCloseTimeout: '20 minutes',
  heartbeatTimeout: '2 minutes',
  // maximumAttempts:1 — the scan activity includes non-idempotent hit-count
  // increments. A retry would double-count. The next trigger recovers.
  retry: { maximumAttempts: 1 },
});

/**
 * Single engage scan executor — one global instance (workflowId
 * `engage-scan-ticker`). PURELY EVENT-DRIVEN: there is NO periodic timer.
 * Scheduled/interval scanning has been abolished — a scan happens only when a
 * page visit (triggerDueScan) or an explicit user action (triggerScanNow)
 * signals it. The workflow blocks indefinitely on a wake signal, then runs
 * whichever scan units are DUE (or ALL, on a force signal). The per-unit
 * cadence and the rate-limit cooldown are enforced inside the activity
 * (runDueScans), so a non-force wake mostly no-ops at the lease layer.
 *
 * Signals that arrive while a scan is in flight are not lost: the wake/force
 * flags are carried into the next run via continueAsNew, which re-fires
 * immediately.
 *
 * Replaces the three fixed-interval workflows (engage-keyword/channel/tracked)
 * and the former 5-minute ticker.
 */
export async function engageScanTickerWorkflow(
  initialWake = false,
  initialForce = false
): Promise<void> {
  let wake = initialWake;
  let force = initialForce;
  setHandler(triggerScanNowSignal, () => {
    wake = true;
    force = true;
  });
  setHandler(triggerDueScanSignal, () => {
    wake = true;
  });

  // No timeout: block until a signal wakes us. This is what makes scanning
  // event-driven instead of periodic.
  await condition(() => wake);

  const runForce = force;
  // Reset BEFORE the activity so a signal arriving during the run sets the flags
  // afresh and is carried into the next run (no lost wakes).
  wake = false;
  force = false;

  try {
    await runDueScans(runForce);
  } catch (err) {
    log.error('engageScanTickerWorkflow runDueScans failed', {
      error: String(err),
    });
  }

  // Carry any wake/force that arrived during the scan into the next run, which
  // re-evaluates the condition immediately and scans again.
  await continueAsNew<typeof engageScanTickerWorkflow>(wake, force);
}
