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
const FIRST_RUN_STAGGER_WINDOW_MS = 5 * 60 * 1000; // 0–5 min jitter on first iteration

// Deterministic hash so replay stays consistent — same logic as engageScanWorkflow.
function orgStaggerOffsetMs(orgId: string, windowMs: number): number {
  let h = 5381;
  for (let i = 0; i < orgId.length; i++) {
    h = (h * 33) ^ orgId.charCodeAt(i);
  }
  return (h >>> 0) % windowMs;
}

/**
 * Tracked-accounts polling workflow — runs every 3 hours per org (+ deterministic
 * first-run stagger up to 5 minutes). Without the stagger, when many orgs onboard
 * in a single window all of them would fire `runTrackedAccountsScan` at the same
 * wall-clock instant and burst the X API.
 * Fetches new tweets from EngageTrackedAccount list, applies +5 score bonus.
 * Uses continueAsNew to prevent event history growth.
 */
export async function engageTrackedAccountsWorkflow(
  orgId: string
): Promise<void> {
  await sleep(orgStaggerOffsetMs(orgId, FIRST_RUN_STAGGER_WINDOW_MS));

  try {
    await runTrackedAccountsScan(orgId);
  } catch (err) {
    log.error(`engageTrackedAccountsWorkflow failed for org=${orgId}`, { error: String(err) });
  }

  await sleep(THREE_HOURS_MS);
  await continueAsNew<typeof engageTrackedAccountsWorkflow>(orgId);
}
