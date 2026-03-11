import {
  proxyActivities,
  sleep,
  continueAsNew,
} from '@temporalio/workflow';
import { DataTicksActivity } from '@gitroom/orchestrator/activities/data-ticks.activity';

const { syncDailyTicks } = proxyActivities<DataTicksActivity>({
  startToCloseTimeout: '30 minutes',
  retry: {
    maximumAttempts: 3,
    backoffCoefficient: 2,
    initialInterval: '5 minutes',
  },
});

/**
 * Workflow that triggers daily analytics sync at UTC 00:05.
 * Uses continueAsNew after each sync to prevent event history growth.
 */
export async function dataTicksSyncWorkflow() {
  // Calculate ms until next UTC 00:05 (5 min buffer for data availability)
  const now = Date.now();
  const nextRun = new Date();
  nextRun.setUTCHours(0, 5, 0, 0);
  if (nextRun.getTime() <= now) {
    nextRun.setUTCDate(nextRun.getUTCDate() + 1);
  }

  await sleep(nextRun.getTime() - now);

  try {
    await syncDailyTicks();
  } catch (err) {
    console.error('DataTicks sync workflow: all retries exhausted', err);
  }

  // Reset event history to avoid unbounded growth
  await continueAsNew<typeof dataTicksSyncWorkflow>();
}
