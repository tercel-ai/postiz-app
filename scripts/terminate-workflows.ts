/**
 * Terminate all running Temporal post workflows so they restart with new code.
 *
 * Usage:
 *   npx ts-node scripts/terminate-workflows.ts --dry-run
 *   npx ts-node scripts/terminate-workflows.ts --execute
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { Connection, Client } from '@temporalio/client';

const WORKFLOW_TYPES = [
  'postWorkflowV101',
  'missingPostWorkflow',
  'dataTicksSyncWorkflow',
  'refreshTokenWorkflow',
];

async function main() {
  const dryRun = !process.argv.includes('--execute');
  const address = process.env.TEMPORAL_ADDRESS || 'localhost:7233';
  const namespace = process.env.TEMPORAL_NAMESPACE || 'default';

  console.log('=== Terminate Temporal Workflows ===\n');
  console.log(`Mode:      ${dryRun ? 'DRY RUN' : 'EXECUTE'}`);
  console.log(`Address:   ${address}`);
  console.log(`Namespace: ${namespace}`);
  console.log('');

  const connection = await Connection.connect({ address });
  const client = new Client({ connection, namespace });

  let totalTerminated = 0;

  for (const workflowType of WORKFLOW_TYPES) {
    console.log(`--- ${workflowType} ---`);

    const query = `WorkflowType='${workflowType}' AND ExecutionStatus='Running'`;
    let count = 0;

    try {
      for await (const workflow of client.workflow.list({ query })) {
        count++;
        const id = workflow.workflowId;
        const runId = workflow.runId;

        if (dryRun) {
          console.log(`  [DRY RUN] Would terminate: ${id} (run: ${runId?.slice(0, 8)}...)`);
        } else {
          try {
            const handle = client.workflow.getHandle(id, runId);
            await handle.terminate('Orchestrator redeploy — restart with new code');
            console.log(`  Terminated: ${id}`);
            totalTerminated++;
          } catch (err: any) {
            console.log(`  Failed to terminate ${id}: ${err?.message || err}`);
          }
        }
      }
    } catch (err: any) {
      console.log(`  Error listing: ${err?.message || err}`);
    }

    if (count === 0) {
      console.log('  (no running workflows)');
    } else if (dryRun) {
      console.log(`  Found ${count} running workflow(s)`);
    }
    console.log('');
  }

  if (dryRun) {
    console.log('--- DRY RUN complete. Run with --execute to terminate. ---');
  } else {
    console.log(`Done. Terminated ${totalTerminated} workflow(s).`);
    console.log('Restart orchestrator now: pm2 restart orchestrator');
    console.log('missingPostWorkflow will recreate post workflows within minutes.');
  }

  await connection.close();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
