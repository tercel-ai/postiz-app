import {
  continueAsNew,
  log,
  proxyActivities,
  sleep,
} from '@temporalio/workflow';
import type { EngageScanActivity } from '@gitroom/orchestrator/activities/engage-scan.activity';

const { runDailyScan } = proxyActivities<EngageScanActivity>({
  startToCloseTimeout: '20 minutes',
  retry: {
    maximumAttempts: 3,
    backoffCoefficient: 2,
    initialInterval: '5 minutes',
  },
});

/**
 * Daily scan workflow — runs at UTC 00:30 per org.
 * Fetches X keywords + monitored channels, scores, classifies, persists.
 * Uses continueAsNew to prevent event history growth.
 */
export async function engageScanWorkflow(orgId: string): Promise<void> {
  // Sleep until next UTC 00:30
  const now = Date.now();
  const next = new Date();
  next.setUTCHours(0, 30, 0, 0);
  if (next.getTime() <= now) {
    next.setUTCDate(next.getUTCDate() + 1);
  }

  await sleep(next.getTime() - now);

  try {
    await runDailyScan(orgId);
  } catch (err) {
    log.error(`engageScanWorkflow failed for org=${orgId}`, { error: String(err) });
  }

  await continueAsNew<typeof engageScanWorkflow>(orgId);
}
