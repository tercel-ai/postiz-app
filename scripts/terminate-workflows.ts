/**
 * Terminate running Temporal workflows.
 *
 * Usage:
 *   npx tsx scripts/terminate-workflows.ts [options]
 *
 * Options:
 *   --execute               Actually terminate (default: dry-run)
 *   --all                   Terminate every running workflow EXCEPT postWorkflowV101.
 *                           postWorkflowV101 is excluded because it represents in-flight
 *                           scheduled posts — terminating it would cause those posts to
 *                           never be published. Everything else auto-restarts on boot.
 *   --only-posts            Only terminate postWorkflowV101 + infra workflows
 *   --task-queues=q1,q2     Only terminate postWorkflowV101 on these task queues
 *   --namespace=<ns>        Temporal namespace (default: $TEMPORAL_NAMESPACE or 'default')
 *   --address=<host:port>   Temporal address (default: $TEMPORAL_ADDRESS or 'localhost:7233')
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { Connection, Client } from '@temporalio/client';

// Per-post workflows: represent in-flight scheduled publishing.
// NEVER safe to bulk-terminate — each instance is a post that would be lost.
const POST_WORKFLOW_TYPES = [
  'postWorkflowV101',
];

// Infrastructure workflows — auto-restart on orchestrator boot (InfiniteWorkflowRegister
// + EngageService.onApplicationBootstrap).
const INFRA_WORKFLOW_TYPES = [
  'missingPostWorkflow',
  'dataTicksSyncWorkflow',
  'refreshWorkflowRecoveryWorkflow',
  'engageDataTicksWorkflow',
  'engageGlobalKeywordScanWorkflow',
  'engageGlobalChannelScanWorkflow',
  'engageGlobalTrackedWorkflow',
];

// On-demand workflows — started by application logic, NOT auto-restarted.
const ON_DEMAND_WORKFLOW_TYPES = [
  'autoPostWorkflow',
  'refreshTokenWorkflow',
  'digestEmailWorkflow',
  'sendEmailWorkflow',
];

async function terminateByQuery(
  client: Client,
  query: string,
  label: string,
  dryRun: boolean,
  reason: string
): Promise<number> {
  console.log(`--- ${label} ---`);
  let count = 0;
  let terminated = 0;
  try {
    for await (const wf of client.workflow.list({ query })) {
      count++;
      const { workflowId, runId, type } = wf;
      const typeLabel = type ? ` [${type}]` : '';
      if (dryRun) {
        console.log(`  [DRY RUN] Would terminate: ${workflowId}${typeLabel} (run: ${runId?.slice(0, 8)}...)`);
      } else {
        try {
          await client.workflow.getHandle(workflowId, runId).terminate(reason);
          console.log(`  Terminated: ${workflowId}${typeLabel}`);
          terminated++;
        } catch (err: any) {
          console.log(`  Failed: ${workflowId}: ${err?.message ?? err}`);
        }
      }
    }
  } catch (err: any) {
    console.log(`  Error listing: ${err?.message ?? err}`);
  }
  if (count === 0) {
    console.log('  (none running)');
  } else if (dryRun) {
    console.log(`  Found ${count} running workflow(s)`);
  }
  console.log('');
  return terminated;
}

async function main() {
  const dryRun = !process.argv.includes('--execute');
  const allMode = process.argv.includes('--all');
  const onlyPosts = process.argv.includes('--only-posts');

  const argNamespace = process.argv.find((a) => a.startsWith('--namespace='))?.split('=')[1];
  const argAddress = process.argv.find((a) => a.startsWith('--address='))?.split('=')[1];
  const argTaskQueues = process.argv.find((a) => a.startsWith('--task-queues='))?.split('=')[1];

  const address = argAddress || process.env.TEMPORAL_ADDRESS || 'localhost:7233';
  const namespace = argNamespace || process.env.TEMPORAL_NAMESPACE || 'default';
  const taskQueues = argTaskQueues
    ? argTaskQueues.split(',').map((q) => q.trim()).filter(Boolean)
    : null;

  console.log('=== Terminate Temporal Workflows ===\n');
  console.log(`Mode:       ${dryRun ? 'DRY RUN (pass --execute to terminate)' : 'EXECUTE'}`);
  console.log(
    `Scope:      ${
      allMode
        ? 'ALL except postWorkflowV101 (safe: everything else auto-restarts)'
        : taskQueues
        ? `postWorkflowV101 on task queues [${taskQueues.join(', ')}]`
        : onlyPosts
        ? 'post + infra only'
        : 'post + infra + on-demand (by type list)'
    }`
  );
  console.log(`Address:    ${address}`);
  console.log(`Namespace:  ${namespace}`);
  console.log('');

  const connection = await Connection.connect({ address });
  const client = new Client({ connection, namespace });

  const reason = 'Orchestrator redeploy — restart with new code';
  let totalTerminated = 0;

  if (allMode) {
    // Query everything running, skip postWorkflowV101
    const excludeClause = POST_WORKFLOW_TYPES.map((t) => `WorkflowType!='${t}'`).join(' AND ');
    const query = `ExecutionStatus='Running' AND ${excludeClause}`;
    totalTerminated += await terminateByQuery(client, query, 'All non-post workflows', dryRun, reason);
  } else {
    const workflowTypes = taskQueues
      ? POST_WORKFLOW_TYPES
      : onlyPosts
      ? [...POST_WORKFLOW_TYPES, ...INFRA_WORKFLOW_TYPES]
      : [...POST_WORKFLOW_TYPES, ...INFRA_WORKFLOW_TYPES, ...ON_DEMAND_WORKFLOW_TYPES];

    for (const workflowType of workflowTypes) {
      const taskQueueFilter = taskQueues
        ? ` AND TaskQueue IN (${taskQueues.map((q) => `'${q}'`).join(',')})`
        : '';
      const query = `WorkflowType='${workflowType}' AND ExecutionStatus='Running'${taskQueueFilter}`;
      totalTerminated += await terminateByQuery(client, query, workflowType, dryRun, reason);
    }
  }

  if (dryRun) {
    console.log('--- DRY RUN complete. Pass --execute to terminate. ---');
  } else {
    console.log(`Done. Terminated ${totalTerminated} workflow(s).`);
    console.log('');
    console.log('Auto-restart on boot (InfiniteWorkflowRegister + EngageService.onApplicationBootstrap):');
    console.log('  missingPostWorkflow, refreshWorkflowRecoveryWorkflow,');
    console.log('  engageGlobalKeywordScanWorkflow, engageGlobalChannelScanWorkflow, engageGlobalTrackedWorkflow');
    console.log('Gated by env (not auto-restarted unless flag is set):');
    console.log('  dataTicksSyncWorkflow (POST_ANALYSE_ENABLE=true)');
    console.log('  engageDataTicksWorkflow (ENGAGE_DATA_TICKS=true)');
    console.log('NOT auto-restarted:');
    console.log('  refreshTokenWorkflow, autoPostWorkflow, digestEmailWorkflow, sendEmailWorkflow');
  }

  await connection.close();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
