import {
  continueAsNew,
  log,
  proxyActivities,
  sleep,
} from '@temporalio/workflow';
import type { EngageScanActivity } from '@gitroom/orchestrator/activities/engage-scan.activity';

const { runTrackedAccountsScan } = proxyActivities<EngageScanActivity>({
  startToCloseTimeout: '10 minutes',
  retry: {
    maximumAttempts: 3,
    backoffCoefficient: 2,
    initialInterval: '5 minutes',
  },
});

const THREE_HOURS_MS = 3 * 60 * 60 * 1000;

/**
 * Tracked-accounts polling workflow — runs every 3 hours per org.
 * Fetches new tweets from EngageTrackedAccount list, applies +5 score bonus.
 * Uses continueAsNew to prevent event history growth.
 */
export async function engageTrackedAccountsWorkflow(
  orgId: string
): Promise<void> {
  try {
    await runTrackedAccountsScan(orgId);
  } catch (err) {
    log.error(`engageTrackedAccountsWorkflow failed for org=${orgId}`, { error: String(err) });
  }

  await sleep(THREE_HOURS_MS);
  await continueAsNew<typeof engageTrackedAccountsWorkflow>(orgId);
}
