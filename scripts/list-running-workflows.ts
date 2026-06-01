/**
 * List running Temporal workflows in a namespace — a general-purpose sanity /
 * diagnostic tool (read-only, terminates nothing).
 *
 * Useful for: confirming you are pointed at the live cluster/namespace, seeing
 * which cron/infinite workflows are actually running, and checking whether a
 * specific workflow type is present before terminating it.
 *
 * Run with:
 *   npx tsx scripts/list-running-workflows.ts                 # all running workflows
 *   npx tsx scripts/list-running-workflows.ts --type engageDataTicksWorkflow
 *   npx tsx scripts/list-running-workflows.ts --status Completed   # any ExecutionStatus
 *   npx tsx scripts/list-running-workflows.ts --query "WorkflowType='postWorkflowV101'"
 *
 * Reads TEMPORAL_ADDRESS (default localhost:7233) and TEMPORAL_NAMESPACE
 * (default 'default') from .env. An empty result means this namespace has no
 * matching workflows — e.g. the cron process (RUN_CRON) is not running here, or
 * you are pointed at the wrong cluster.
 */
import * as dotenv from 'dotenv';
dotenv.config();

import { Client, Connection } from '@temporalio/client';

interface CliArgs {
  type: string | null;
  status: string;
  query: string | null;
}

function printHelp(): void {
  console.log(`
Usage: npx tsx scripts/list-running-workflows.ts [options]

Options:
  --type <WorkflowType>   Filter to one workflow type (e.g. engageDataTicksWorkflow)
  --status <Status>       ExecutionStatus to match (default: Running).
                          One of: Running | Completed | Failed | Canceled |
                          Terminated | ContinuedAsNew | TimedOut
  --query "<visibility>"  Raw Temporal visibility query (overrides --type/--status)
  --help                  Show this help message

Reads TEMPORAL_ADDRESS / TEMPORAL_NAMESPACE from .env.
`);
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let type: string | null = null;
  let status = 'Running';
  let query: string | null = null;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--type':
        type = args[++i] ?? null;
        break;
      case '--status':
        status = args[++i] ?? 'Running';
        break;
      case '--query':
        query = args[++i] ?? null;
        break;
      case '--help':
        printHelp();
        process.exit(0);
      default:
        console.error(`Unknown argument: ${args[i]}`);
        printHelp();
        process.exit(1);
    }
  }
  return { type, status, query };
}

async function main(): Promise<void> {
  const args = parseArgs();
  const address = process.env.TEMPORAL_ADDRESS || 'localhost:7233';
  const namespace = process.env.TEMPORAL_NAMESPACE || 'default';

  // Build the visibility query: explicit --query wins, else status + optional type.
  const query =
    args.query ??
    `ExecutionStatus='${args.status}'` +
      (args.type ? ` AND WorkflowType='${args.type}'` : '');

  console.log(`Connecting to Temporal at ${address}, namespace=${namespace}`);
  console.log(`Query: ${query}\n`);

  const connection = await Connection.connect({ address });
  const client = new Client({ connection, namespace });

  let total = 0;
  const byType = new Map<string, number>();

  try {
    for await (const wf of client.workflow.list({ query })) {
      total++;
      byType.set(wf.type, (byType.get(wf.type) ?? 0) + 1);
      console.log(
        `  ${wf.type.padEnd(34)} ${wf.workflowId} (run: ${wf.runId?.slice(0, 8)}...)`
      );
    }
  } catch (err: any) {
    console.log(`  Error listing: ${err?.message ?? err}`);
  }

  console.log('');
  if (total === 0) {
    console.log(
      'No matching workflows in this namespace — nothing is running here for ' +
        'this query (check RUN_CRON / cluster / namespace if that is unexpected).'
    );
  } else {
    console.log(`${total} workflow(s) across ${byType.size} type(s):`);
    for (const [type, n] of [...byType].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(4)}  ${type}`);
    }
  }

  await connection.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
