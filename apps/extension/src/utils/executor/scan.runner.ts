// Drives the chained engage-scan loop:
//   bootstrap  → ingest({ want }) claims the first due unit
//   per unit   → scan with the session → ingest({ completed, want }) persists it
//                and claims the next, until nextTasks comes back empty.
// The backend is the scheduler (what's due, leasing, scoring); this is the
// executor (how to fetch). One unit is processed per round-trip (want:1) so the
// single `completed` slot always lines up with the unit just scanned.

import { backendCall, NotAuthenticatedError } from './api';
import {
  EngageScanIngestResponse,
  EngageScanSyncBody,
  EngageScanTask,
  ScanRunResult,
} from './executor.types';
import { scanReddit } from './scan.reddit';
import { scanX } from './scan.x';
import { X_EXECUTOR_ENABLED } from './flags';
import {
  applyDelay,
  remainingHourlyBudget,
  selectUnitDelay,
  tryConsumeHourly,
} from './pacing';

const SCAN_ENDPOINT = '/engage/scan-tasks/ingest';
// Safety bound on units processed in one drive (the loop also self-terminates
// when the backend reports nothing due).
const MAX_UNITS_PER_RUN = 20;

export type ScanStopReason =
  | 'idle' // backend reported nothing due
  | 'cap' // hourly request budget exhausted
  | 'max-units' // hit the per-run safety bound
  | 'error'
  | 'not-authenticated'
  | 'busy'; // another run is already in flight

export interface ScanRunSummary {
  units: number;
  posts: number;
  accepted: number;
  stoppedReason: ScanStopReason;
}

// SW instances are single-threaded but a manual trigger could overlap an alarm;
// a simple guard keeps two loops from double-claiming leases.
let scanInFlight = false;

async function scanOne(task: EngageScanTask): Promise<ScanRunResult> {
  const gate = () => tryConsumeHourly(task.pacing.hourlyRequestCap);
  if (task.platform === 'reddit') return scanReddit(task, gate);
  if (task.platform === 'x') {
    // X is account-risky and OFF by default (see flags.ts). Refuse the task
    // WITHOUT touching x.com; mark exhausted so the backend stops re-leasing it.
    if (!X_EXECUTOR_ENABLED) {
      console.warn('[aisee][scan] X disabled (ENGAGE_X_ENABLED!=true) — skipping');
      return { posts: [], nextCursor: task.cursor, exhausted: true };
    }
    return scanX(task, gate);
  }
  console.warn('[aisee][scan] unknown platform', task.platform);
  return { posts: [], nextCursor: task.cursor, exhausted: true };
}

function toCompleted(
  task: EngageScanTask,
  result: ScanRunResult
): NonNullable<EngageScanSyncBody['completed']> {
  return {
    taskId: task.taskId,
    posts: result.posts,
    nextCursor: result.nextCursor,
    exhausted: result.exhausted,
  };
}

async function ingest(
  body: EngageScanSyncBody
): Promise<EngageScanIngestResponse | null> {
  const resp = await backendCall<EngageScanIngestResponse>(
    SCAN_ENDPOINT,
    'POST',
    body
  );
  if (!resp.ok) {
    console.warn('[aisee][scan] ingest HTTP', resp.status, resp.data);
    return null;
  }
  return resp.data;
}

export async function runScanLoop(): Promise<ScanRunSummary> {
  console.log('[aisee][scan] runScanLoop start', new Date().toISOString());
  const summary: ScanRunSummary = {
    units: 0,
    posts: 0,
    accepted: 0,
    stoppedReason: 'idle',
  };
  if (scanInFlight) {
    console.log('[aisee][scan] runScanLoop skipped — already in flight');
    summary.stoppedReason = 'busy';
    return summary;
  }
  scanInFlight = true;
  let completed: EngageScanSyncBody['completed'] | undefined;
  try {
    for (let i = 0; i < MAX_UNITS_PER_RUN; i++) {
      let data: EngageScanIngestResponse | null;
      try {
        data = await ingest({ completed, want: 1 });
      } catch (e) {
        summary.stoppedReason =
          e instanceof NotAuthenticatedError ? 'not-authenticated' : 'error';
        if (!(e instanceof NotAuthenticatedError)) {
          console.warn('[aisee][scan] ingest failed', e);
        }
        completed = undefined; // don't double-flush a failed send
        break;
      }
      if (completed) summary.accepted += data?.accepted ?? 0;
      completed = undefined; // the pending unit was just persisted

      if (!data) {
        summary.stoppedReason = 'error';
        break;
      }
      const tasks = data.nextTasks ?? [];
      if (!tasks.length) {
        summary.stoppedReason = 'idle';
        break;
      }
      const task = tasks[0];

      if ((await remainingHourlyBudget(task.pacing.hourlyRequestCap)) <= 0) {
        summary.stoppedReason = 'cap'; // claimed unit will be reclaimed on TTL
        break;
      }
      if (summary.units > 0) {
        // Inter-keyword spacing. X reuses pageDelay/pageJitter (it has no
        // pagination — see scan.x.ts); other platforms use interUnit*.
        const { baseMs, jitterMs } = selectUnitDelay(task.platform, task.pacing);
        await applyDelay(baseMs, jitterMs);
      }

      const result = await scanOne(task);
      summary.units += 1;
      summary.posts += result.posts.length;
      completed = toCompleted(task, result);
      console.debug(
        `[aisee][scan] ${task.platform}/${task.scanType}/${task.scanKey}: ` +
          `${result.posts.length} post(s), exhausted=${result.exhausted}`
      );

      if (i === MAX_UNITS_PER_RUN - 1) summary.stoppedReason = 'max-units';
    }

    // Flush a unit scanned but not yet sent (we broke on cap / max-units).
    if (completed) {
      try {
        const data = await ingest({ completed });
        if (data) summary.accepted += data.accepted ?? 0;
      } catch (e) {
        console.warn('[aisee][scan] final flush failed', e);
      }
    }
  } finally {
    scanInFlight = false;
  }
  console.log('[aisee][scan] run complete', summary);
  return summary;
}
