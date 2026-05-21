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

// Deterministic stagger based on orgId — Temporal workflows must be deterministic,
// so this avoids Math.random() and keeps replay safe. djb2-style hash, capped at
// 30 minutes so daily-scan load is spread across UTC 00:30–01:00 instead of all
// orgs firing at the same instant (the spec called for stagger but the previous
// implementation aligned every org on UTC 00:30 exactly).
const STAGGER_WINDOW_MS = 30 * 60 * 1000;
function orgStaggerOffsetMs(orgId: string): number {
  let h = 5381;
  for (let i = 0; i < orgId.length; i++) {
    h = (h * 33) ^ orgId.charCodeAt(i);
  }
  // Force unsigned then modulo into the stagger window.
  return (h >>> 0) % STAGGER_WINDOW_MS;
}

/**
 * Daily scan workflow — runs at UTC 00:30 per org (+ deterministic 0-30min stagger).
 * Fetches X keywords + monitored channels, scores, classifies, persists.
 * Uses continueAsNew to prevent event history growth.
 */
export async function engageScanWorkflow(orgId: string): Promise<void> {
  // Sleep until next UTC 00:30, then add per-org stagger to avoid burst.
  const now = Date.now();
  const next = new Date();
  next.setUTCHours(0, 30, 0, 0);
  if (next.getTime() <= now) {
    next.setUTCDate(next.getUTCDate() + 1);
  }

  await sleep(next.getTime() - now + orgStaggerOffsetMs(orgId));

  try {
    await runDailyScan(orgId);
  } catch (err) {
    log.error(`engageScanWorkflow failed for org=${orgId}`, { error: String(err) });
  }

  await continueAsNew<typeof engageScanWorkflow>(orgId);
}
