/**
 * Terminate all running Temporal workflows so they restart with new code.
 *
 * Usage:
 *   npx ts-node --project scripts/tsconfig.json scripts/terminate-workflows.ts --dry-run
 *   npx ts-node --project scripts/tsconfig.json scripts/terminate-workflows.ts --execute
 *
 * Options:
 *   --only-posts   Only terminate postWorkflowV101 (skip infrastructure workflows)
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { Connection, Client } from '@temporalio/client';

// Post workflows — must be terminated when workflow function code changes
const POST_WORKFLOW_TYPES = [
  'postWorkflowV101',
];

// Infrastructure workflows — auto-restart on orchestrator boot (InfiniteWorkflowRegister)
const INFRA_WORKFLOW_TYPES = [
  'missingPostWorkflow',
  'dataTicksSyncWorkflow',
];

// On-demand workflows — started by application logic, NOT auto-restarted.
// Only terminate these when their workflow function code changes.
const ON_DEMAND_WORKFLOW_TYPES = [
  'autoPostWorkflow',
  'refreshTokenWorkflow',
  'digestEmailWorkflow',
  'sendEmailWorkflow',
];

async function main() {
  const dryRun = !process.argv.includes('--execute');
  const onlyPosts = process.argv.includes('--only-posts');
  const address = process.env.TEMPORAL_ADDRESS || 'localhost:7233';
  const namespace = process.env.TEMPORAL_NAMESPACE || 'default';

  const workflowTypes = onlyPosts
    ? [...POST_WORKFLOW_TYPES, ...INFRA_WORKFLOW_TYPES]
    : [...POST_WORKFLOW_TYPES, ...INFRA_WORKFLOW_TYPES, ...ON_DEMAND_WORKFLOW_TYPES];

  console.log('=== Terminate Temporal Workflows ===\n');
  console.log(`Mode:      ${dryRun ? 'DRY RUN' : 'EXECUTE'}`);
  console.log(`Scope:     ${onlyPosts ? 'post + infra only' : 'ALL workflows'}`);
  console.log(`Address:   ${address}`);
  console.log(`Namespace: ${namespace}`);
  console.log('');

  const connection = await Connection.connect({ address });
  const client = new Client({ connection, namespace });

  let totalTerminated = 0;

  for (const workflowType of workflowTypes) {
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
    console.log('');
    console.log('Auto-restart on boot: missingPostWorkflow, dataTicksSyncWorkflow');
    console.log('NOT auto-restarted:   refreshTokenWorkflow (on-demand), autoPostWorkflow (on-demand)');
  }

  await connection.close();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
