/**
 * One-shot script: terminate all stale engage workflow executions left over from
 * the 538d7cc8 refactor that renamed per-org scan workflows to global singletons.
 *
 * Stale types:
 *   - engageScanWorkflow          (was per-org, workflowId: engage-scan-<orgId>)
 *   - engageTrackedAccountsWorkflow (was per-org / engage-tracked-global)
 *   - engageGlobalScanWorkflow    (intermediate name, any workflowId)
 *
 * Run with:
 *   npx tsx scripts/terminate-stale-workflow.ts [--dry-run]
 *
 * Defaults to dry-run. Pass --execute to actually terminate.
 */
import { Client, Connection } from '@temporalio/client';

const STALE_TYPES = [
  'engageScanWorkflow',
  'engageTrackedAccountsWorkflow',
  'engageGlobalScanWorkflow',
];

async function main() {
  const dryRun = !process.argv.includes('--execute');
  const address = process.env.TEMPORAL_ADDRESS || 'localhost:7233';
  const namespace = process.env.TEMPORAL_NAMESPACE || 'default';

  console.log(`Connecting to Temporal at ${address}, namespace=${namespace}`);
  console.log(`Mode: ${dryRun ? 'DRY RUN (pass --execute to terminate)' : 'EXECUTE'}\n`);

  const connection = await Connection.connect({ address });
  const client = new Client({ connection, namespace });

  let totalFound = 0;
  let totalTerminated = 0;

  for (const workflowType of STALE_TYPES) {
    console.log(`--- ${workflowType} ---`);
    const query = `WorkflowType='${workflowType}' AND ExecutionStatus='Running'`;
    let count = 0;

    try {
      for await (const wf of client.workflow.list({ query })) {
        count++;
        totalFound++;
        const { workflowId, runId } = wf;
        if (dryRun) {
          console.log(`  [DRY RUN] Would terminate: ${workflowId} (run: ${runId?.slice(0, 8)}...)`);
        } else {
          try {
            await client.workflow.getHandle(workflowId, runId).terminate(
              `Terminated: stale workflow type '${workflowType}' renamed in 538d7cc8 refactor`
            );
            console.log(`  Terminated: ${workflowId}`);
            totalTerminated++;
          } catch (err: any) {
            console.log(`  Failed to terminate ${workflowId}: ${err?.message ?? err}`);
          }
        }
      }
    } catch (err: any) {
      console.log(`  Error listing: ${err?.message ?? err}`);
    }

    if (count === 0) {
      console.log('  (no running workflows found)');
    } else if (dryRun) {
      console.log(`  Found ${count} running workflow(s)`);
    }
    console.log('');
  }

  if (dryRun) {
    console.log(`Found ${totalFound} stale workflow(s) total. Run with --execute to terminate them.`);
  } else {
    console.log(`Done. Terminated ${totalTerminated} / ${totalFound} workflow(s).`);
  }

  await connection.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
