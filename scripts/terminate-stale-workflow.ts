/**
 * One-shot script: terminate the stale 'engageTrackedAccountsWorkflow' execution
 * that was created under the workflowId 'engage-tracked-global'.
 *
 * Run with:
 *   dotenv -e .env -- npx ts-node -e "$(cat scripts/terminate-stale-workflow.ts)"
 * or:
 *   dotenv -e .env -- npx tsx scripts/terminate-stale-workflow.ts
 */
import { Client, Connection } from '@temporalio/client';

async function main() {
  const address = process.env.TEMPORAL_ADDRESS || 'localhost:7233';
  const namespace = process.env.TEMPORAL_NAMESPACE || 'default';

  console.log(`Connecting to Temporal at ${address}, namespace=${namespace}`);

  const connection = await Connection.connect({ address });
  const client = new Client({ connection, namespace });

  const workflowId = 'engage-tracked-global';

  try {
    const handle = client.workflow.getHandle(workflowId);
    const desc = await handle.describe();
    console.log(`Found workflow: id=${desc.workflowId} type=${desc.workflowType} status=${desc.status.name}`);

    if (desc.status.name === 'RUNNING') {
      await handle.terminate('Terminated: workflow type renamed to engageGlobalTrackedWorkflow');
      console.log('Terminated successfully.');
    } else {
      console.log(`Workflow is not RUNNING (status=${desc.status.name}), no action needed.`);
    }
  } catch (err: any) {
    if (err.code === 5 || err.message?.includes('not found')) {
      console.log(`Workflow '${workflowId}' not found — already gone or never started.`);
    } else {
      throw err;
    }
  }

  await connection.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
