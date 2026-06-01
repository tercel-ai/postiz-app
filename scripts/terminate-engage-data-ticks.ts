/**
 * One-shot script: terminate the running engageDataTicksWorkflow execution(s).
 *
 * Why this exists:
 *   engageDataTicksWorkflow is an infinite continueAsNew loop. Its registration
 *   was gated off by default in infinite.workflow.register.ts (ENGAGE_DATA_TICKS
 *   flag), which prevents NEW starts but does NOT stop an instance already
 *   running in Temporal. This script terminates the live execution so the daily
 *   EngageDataTicks aggregation actually stops. EngageDataTicks is write-only and
 *   fully backfillable from Post via scripts/backfill-engage-data-ticks.ts, so
 *   terminating loses nothing.
 *
 * Targets every Running execution of WorkflowType 'engageDataTicksWorkflow'
 * (the singleton workflowId is 'engage-data-ticks-workflow', but matching by
 * type also catches any orphaned runs).
 *
 * Run with:
 *   npx tsx scripts/terminate-engage-data-ticks.ts            # dry-run (default)
 *   npx tsx scripts/terminate-engage-data-ticks.ts --execute  # actually terminate
 *
 * Sanity check first: if you get "0 found" and aren't sure whether you're on the
 * live cluster, use the general-purpose lister to see ALL running workflows:
 *   npx tsx scripts/list-running-workflows.ts
 *   npx tsx scripts/list-running-workflows.ts --type engageDataTicksWorkflow
 *
 * Honors TEMPORAL_ADDRESS (default localhost:7233) and TEMPORAL_NAMESPACE
 * (default 'default'), loaded from .env. NOTE: if you do not see your expected
 * running execution, double-check these point at the SAME cluster/namespace the
 * orchestrator deploys to — a fallback to localhost will silently report 0.
 */
import * as dotenv from 'dotenv';
dotenv.config();

import { Client, Connection } from '@temporalio/client';

const WORKFLOW_TYPE = 'engageDataTicksWorkflow';
const TERMINATE_REASON =
  'EngageDataTicks deferred — write-only table, backfillable from Post ' +
  '(scripts/backfill-engage-data-ticks.ts). Registration gated off via ENGAGE_DATA_TICKS.';

async function main() {
  const dryRun = !process.argv.includes('--execute');
  const address = process.env.TEMPORAL_ADDRESS || 'localhost:7233';
  const namespace = process.env.TEMPORAL_NAMESPACE || 'default';

  console.log(`Connecting to Temporal at ${address}, namespace=${namespace}`);
  console.log(`Mode: ${dryRun ? 'DRY RUN (pass --execute to terminate)' : 'EXECUTE'}\n`);

  const connection = await Connection.connect({ address });
  const client = new Client({ connection, namespace });

  let found = 0;
  let terminated = 0;

  console.log(`--- ${WORKFLOW_TYPE} ---`);
  const query = `WorkflowType='${WORKFLOW_TYPE}' AND ExecutionStatus='Running'`;

  try {
    for await (const wf of client.workflow.list({ query })) {
      found++;
      const { workflowId, runId } = wf;
      if (dryRun) {
        console.log(`  [DRY RUN] Would terminate: ${workflowId} (run: ${runId?.slice(0, 8)}...)`);
      } else {
        try {
          await client.workflow.getHandle(workflowId, runId).terminate(TERMINATE_REASON);
          console.log(`  Terminated: ${workflowId}`);
          terminated++;
        } catch (err: any) {
          console.log(`  Failed to terminate ${workflowId}: ${err?.message ?? err}`);
        }
      }
    }
  } catch (err: any) {
    console.log(`  Error listing: ${err?.message ?? err}`);
  }

  if (found === 0) {
    console.log('  (no running engageDataTicksWorkflow found — nothing to do)');
  }
  console.log('');

  if (dryRun) {
    console.log(`Found ${found} running execution(s). Run with --execute to terminate.`);
  } else {
    console.log(`Done. Terminated ${terminated} / ${found} execution(s).`);
  }

  await connection.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
