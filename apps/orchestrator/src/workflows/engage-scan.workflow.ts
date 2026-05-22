import {
  condition,
  continueAsNew,
  defineSignal,
  log,
  proxyActivities,
  setHandler,
} from '@temporalio/workflow';
import type { EngageScanActivity } from '@gitroom/orchestrator/activities/engage-scan.activity';

// Carries the keyword IDs to scan; empty array means "scan all enabled keywords".
export const triggerScanNowSignal = defineSignal<[string[]]>('triggerScanNow');

const { runDailyScan } = proxyActivities<EngageScanActivity>({
  startToCloseTimeout: '20 minutes',
  // Detect worker death between heartbeats faster than startToCloseTimeout —
  // engage-scan.activity emits Context.heartbeat() inside every per-keyword and
  // per-channel iteration.
  heartbeatTimeout: '2 minutes',
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
 *
 * Pass runImmediately=true on the first invocation (setup completion) to skip
 * the initial sleep and scan right away. All continueAsNew calls pass false so
 * subsequent runs follow the normal daily schedule.
 */
export async function engageScanWorkflow(orgId: string, runImmediately = false): Promise<void> {
  // Signal handler — fires when a manual "Scan Now" request signals the workflow.
  // keywordIds: IDs to scan; empty = scan all enabled keywords.
  let runNow = runImmediately;
  let pendingKeywordIds: string[] = [];
  setHandler(triggerScanNowSignal, (ids: string[]) => {
    runNow = true;
    pendingKeywordIds = ids;
  });

  if (!runNow) {
    // Sleep until next UTC 00:30 + per-org stagger, but allow early wake via signal.
    const now = Date.now();
    const next = new Date();
    next.setUTCHours(0, 30, 0, 0);
    if (next.getTime() <= now) {
      next.setUTCDate(next.getUTCDate() + 1);
    }
    const delay = next.getTime() - now + orgStaggerOffsetMs(orgId);

    // condition(predicate, timeout) resolves when the predicate becomes true
    // (signal received) or after the timeout — no dangling timer.
    await condition(() => runNow, delay);
  }

  try {
    await runDailyScan(orgId, pendingKeywordIds.length ? pendingKeywordIds : undefined);
  } catch (err) {
    log.error(`engageScanWorkflow failed for org=${orgId}`, { error: String(err) });
  }

  await continueAsNew<typeof engageScanWorkflow>(orgId, false);
}
