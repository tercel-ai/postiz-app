/**
 * One-time migration: start proactive refresh workflows for all active X integrations
 * that use OAuth 2.0 tokens (bearer format, no colon).
 *
 * Safe to run multiple times — workflowIdConflictPolicy=TERMINATE_EXISTING means
 * each run simply restarts any already-running workflow with fresh state.
 *
 * Usage:
 *   npx ts-node --project scripts/tsconfig.json scripts/start-x-refresh-workflows.ts --dry-run
 *   npx ts-node --project scripts/tsconfig.json scripts/start-x-refresh-workflows.ts --execute
 *   npx ts-node --project scripts/tsconfig.json scripts/start-x-refresh-workflows.ts --org <orgId> --execute
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { Connection, Client } from '@temporalio/client';
import { PrismaClient } from '@prisma/client';

/** Mirrors XProvider.isOAuth1Token. */
function isOAuth1Token(token: string): boolean {
  const colonIdx = token.indexOf(':');
  return colonIdx > 0 && token.length > colonIdx + 1;
}

function parseArgs() {
  const args = process.argv.slice(2);
  let dryRun = true;
  let orgId: string | null = null;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--execute': dryRun = false; break;
      case '--dry-run': dryRun = true; break;
      case '--org':
        orgId = args[++i] ?? null;
        if (!orgId) { console.error('--org requires a value'); process.exit(1); }
        break;
      case '--help':
        console.log('Usage: start-x-refresh-workflows.ts [--dry-run|--execute] [--org <id>]');
        process.exit(0);
        break;
      default:
        console.error(`Unknown argument: ${args[i]}`);
        process.exit(1);
    }
  }
  return { dryRun, orgId };
}

async function main() {
  const { dryRun, orgId } = parseArgs();

  const address = process.env.TEMPORAL_ADDRESS || 'localhost:7233';
  const namespace = process.env.TEMPORAL_NAMESPACE || 'default';

  console.log('=== Start X OAuth 2.0 Refresh Workflows ===\n');
  console.log(`Mode:      ${dryRun ? 'DRY RUN (no workflows started)' : 'EXECUTE'}`);
  console.log(`Temporal:  ${address} / ${namespace}`);
  if (orgId) console.log(`Org:       ${orgId}`);
  console.log('');

  const prisma = new PrismaClient();

  const integrations = await prisma.integration.findMany({
    where: {
      providerIdentifier: 'x',
      deletedAt: null,
      disabled: false,
      refreshNeeded: false,
      ...(orgId ? { organizationId: orgId } : {}),
    },
    select: {
      id: true,
      name: true,
      token: true,
      tokenExpiration: true,
      organizationId: true,
    },
    orderBy: { createdAt: 'asc' },
  });

  await prisma.$disconnect();

  const oauth2 = integrations.filter((i) => i.token && !isOAuth1Token(i.token));
  const oauth1 = integrations.filter((i) => i.token && isOAuth1Token(i.token));
  const empty  = integrations.filter((i) => !i.token);

  console.log(`Found ${integrations.length} active X integrations:`);
  console.log(`  OAuth 2.0 (need workflow): ${oauth2.length}`);
  console.log(`  OAuth 1.0a (skip):         ${oauth1.length}`);
  console.log(`  Empty token (skip):        ${empty.length}\n`);

  if (oauth2.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  if (dryRun) {
    console.log('OAuth 2.0 integrations that would get a refresh workflow:');
    for (const i of oauth2) {
      const exp = i.tokenExpiration?.toISOString() ?? 'null';
      console.log(`  [${i.id}] ${i.name} (org=${i.organizationId}, expiry=${exp})`);
    }
    console.log('\n--- DRY RUN complete. Run with --execute to start workflows. ---');
    return;
  }

  const connection = await Connection.connect({ address });
  const client = new Client({ connection, namespace });

  let started = 0;
  let failed = 0;

  for (const integration of oauth2) {
    const workflowId = `refresh_${integration.id}`;
    process.stdout.write(`  Starting workflow for [${integration.id}] ${integration.name} ... `);
    try {
      await client.workflow.start('refreshTokenWorkflow', {
        workflowId,
        args: [{ integrationId: integration.id, organizationId: integration.organizationId }],
        taskQueue: 'main',
        // Safe to call multiple times — terminates any existing workflow with the same ID.
        workflowIdConflictPolicy: 'TERMINATE_EXISTING' as any,
      });
      console.log('OK');
      started++;
    } catch (err: any) {
      console.log(`FAILED: ${err?.message ?? err}`);
      failed++;
    }
  }

  console.log(`\nDone: ${started} started, ${failed} failed.`);
  await connection.close();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
