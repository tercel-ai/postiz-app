import {
  condition,
  continueAsNew,
  defineSignal,
  log,
  proxyActivities,
  setHandler,
} from '@temporalio/workflow';
import type { EngageScanActivity } from '@gitroom/orchestrator/activities/engage-scan.activity';

export const triggerKeywordScanNowSignal = defineSignal('triggerKeywordScanNow');

const { runGlobalKeywordScan } = proxyActivities<EngageScanActivity>({
  startToCloseTimeout: '20 minutes',
  heartbeatTimeout: '2 minutes',
  // maximumAttempts:1 — the scan activity includes non-idempotent hit-count
  // increments. A retry would double-count. On transient failure the next
  // scheduled scan (default every 24h) will recover.
  retry: { maximumAttempts: 1 },
});

/**
 * Global keyword scan workflow — single instance, interval-based.
 * Searches X (OR-batched) + Reddit global for all enabled keywords across orgs,
 * then fans out to per-org EngageOpportunity rows.
 * Interval controlled by ENGAGE_KEYWORD_SCAN_INTERVAL_HOURS (default 24h).
 */
export async function engageGlobalKeywordScanWorkflow(
  runImmediately = false,
  intervalHours = 24
): Promise<void> {
  let runNow = runImmediately;
  setHandler(triggerKeywordScanNowSignal, () => {
    runNow = true;
  });

  if (!runNow) {
    await condition(() => runNow, intervalHours * 60 * 60 * 1000);
  }

  runNow = false;

  try {
    await runGlobalKeywordScan();
  } catch (err) {
    log.error('engageGlobalKeywordScanWorkflow failed', { error: String(err) });
  }

  await continueAsNew<typeof engageGlobalKeywordScanWorkflow>(runNow, intervalHours);
}
