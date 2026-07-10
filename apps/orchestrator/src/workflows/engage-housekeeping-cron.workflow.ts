import { continueAsNew, proxyActivities, sleep } from '@temporalio/workflow';
import type { EngageHousekeepingActivity } from '@gitroom/orchestrator/activities/engage-housekeeping.activity';

const { runDueMaintenanceJobs } = proxyActivities<EngageHousekeepingActivity>({
  startToCloseTimeout: '10 minutes',
  retry: {
    maximumAttempts: 3,
    backoffCoefficient: 1,
    initialInterval: '2 minutes',
  },
});

// Hourly ticks per workflow execution before truncating history via
// continueAsNew. ~1 day of ticks keeps the event history small and bounded
// (each tick appends a durable timer + an activity), so the run never
// approaches Temporal's history-size cap.
const TICKS_PER_EXECUTION = 24;

/**
 * Engage housekeeping cron — a single global instance that hourly-ticks every
 * registered engage DB-maintenance job (see EngageHousekeepingActivity). This
 * is intentionally NOT a bespoke "engage opportunity expiry workflow": future
 * cheap, all-DB periodic engage jobs (orphan cleanup, lease reaping, etc.)
 * register into the same activity instead of spawning another bare workflow.
 *
 * Unlike the older sibling crons (missingPostWorkflow /
 * refreshWorkflowRecoveryWorkflow), which loop unbounded, this bounds event
 * history via continueAsNew every TICKS_PER_EXECUTION ticks — the same
 * history-bounding discipline engageScanTickerWorkflow uses. The tick runs
 * once immediately (fresh start / redeploy), then hourly; continueAsNew
 * re-enters and runs the next tick immediately, so the hourly cadence is
 * unbroken across the boundary with no double-run.
 */
export async function engageHousekeepingCronWorkflow() {
  for (let i = 0; i < TICKS_PER_EXECUTION; i++) {
    await runDueMaintenanceJobs();
    await sleep('1 hour');
  }
  await continueAsNew();
}
