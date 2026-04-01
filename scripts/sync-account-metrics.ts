/**
 * Sync account-level metrics (followers, following, etc.) for all or specific integrations.
 *
 * Uses the SAME DataTicksService.syncAccountMetricsById() method as the daily
 * cron workflow, with cooldown skipped so it can be run on-demand.
 *
 * Usage:
 *   npx ts-node scripts/sync-account-metrics.ts --dry-run
 *   npx ts-node scripts/sync-account-metrics.ts --execute
 *   npx ts-node scripts/sync-account-metrics.ts --integration <id> --execute
 *   npx ts-node scripts/sync-account-metrics.ts --org <orgId> --execute
 *   npx ts-node scripts/sync-account-metrics.ts --platform x --execute
 */

// Suppress Sentry noise in script mode
process.env.NODE_ENV = process.env.NODE_ENV || 'production';
process.env.TZ = 'UTC';

import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { DatabaseModule } from '@gitroom/nestjs-libraries/database/prisma/database.module';
import { DataTicksService } from '@gitroom/nestjs-libraries/database/prisma/data-ticks/data-ticks.service';
import { PrismaClient } from '@prisma/client';

@Module({
  imports: [DatabaseModule],
})
class ScriptModule {}

interface CliArgs {
  integrationId: string | null;
  orgId: string | null;
  platform: string | null;
  dryRun: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let integrationId: string | null = null;
  let orgId: string | null = null;
  let platform: string | null = null;
  let dryRun = true;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--integration':
        integrationId = args[++i] ?? null;
        if (!integrationId) { console.error('--integration requires a value'); process.exit(1); }
        break;
      case '--org':
        orgId = args[++i] ?? null;
        if (!orgId) { console.error('--org requires a value'); process.exit(1); }
        break;
      case '--platform':
        platform = args[++i] ?? null;
        if (!platform) { console.error('--platform requires a value'); process.exit(1); }
        break;
      case '--execute':
        dryRun = false;
        break;
      case '--dry-run':
        dryRun = true;
        break;
      case '--help':
        printHelp();
        process.exit(0);
        break;
      default:
        console.error(`Unknown argument: ${args[i]}`);
        printHelp();
        process.exit(1);
    }
  }

  return { integrationId, orgId, platform, dryRun };
}

function printHelp(): void {
  console.log(`
Usage: npx ts-node scripts/sync-account-metrics.ts [options]

Options:
  --integration <id>  Sync a specific integration
  --org <id>          Sync all active integrations in an organization
  --platform <name>   Filter by platform (x, linkedin, instagram, etc.)
  --dry-run           List integrations without syncing (default)
  --execute           Actually perform the sync
  --help              Show this help message

Examples:
  npx ts-node scripts/sync-account-metrics.ts --dry-run
  npx ts-node scripts/sync-account-metrics.ts --execute
  npx ts-node scripts/sync-account-metrics.ts --org org_123 --execute
  npx ts-node scripts/sync-account-metrics.ts --platform x --execute
  npx ts-node scripts/sync-account-metrics.ts --integration clxyz123 --execute
`);
}

async function main(): Promise<void> {
  const { integrationId, orgId, platform, dryRun } = parseArgs();

  console.log('=== Account Metrics Sync Script ===\n');
  console.log(`Mode:     ${dryRun ? 'DRY RUN (no changes)' : 'EXECUTE'}`);
  if (integrationId) console.log(`Integration: ${integrationId}`);
  if (orgId) console.log(`Org:         ${orgId}`);
  if (platform) console.log(`Platform:    ${platform}`);
  console.log('');

  // Use raw Prisma to list target integrations
  const prisma = new PrismaClient();
  const integrations = await prisma.integration.findMany({
    where: {
      deletedAt: null,
      disabled: false,
      type: 'social',
      ...(integrationId ? { id: integrationId } : {}),
      ...(orgId ? { organizationId: orgId } : {}),
      ...(platform ? { providerIdentifier: platform } : {}),
    },
    select: {
      id: true,
      name: true,
      providerIdentifier: true,
      organizationId: true,
      additionalSettings: true,
    },
    orderBy: { createdAt: 'asc' },
  });
  await prisma.$disconnect();

  if (integrations.length === 0) {
    console.log('No active integrations found matching the criteria.');
    return;
  }

  console.log(`Found ${integrations.length} integration(s):\n`);
  for (const i of integrations) {
    console.log(`  [${i.id}] ${i.name} (${i.providerIdentifier}, org: ${i.organizationId})`);
  }
  console.log('');

  if (dryRun) {
    console.log('--- DRY RUN complete. Run with --execute to sync. ---');
    return;
  }

  // Bootstrap NestJS app context to get the real DataTicksService
  console.log('Bootstrapping NestJS context...\n');
  const app = await NestFactory.createApplicationContext(ScriptModule, {
    logger: ['error', 'warn'],
  });

  const dataTicksService = app.get(DataTicksService);

  let successCount = 0;
  let errorCount = 0;
  let skippedCount = 0;

  for (const integration of integrations) {
    process.stdout.write(`  Syncing [${integration.id}] ${integration.name} (${integration.providerIdentifier}) ... `);

    try {
      // skipCooldown=true so the script can run multiple times
      const metrics = await dataTicksService.syncAccountMetricsById(integration.id, true);

      if (metrics === null) {
        console.log('SKIPPED (provider has no accountMetrics or integration unavailable)');
        skippedCount++;
      } else {
        const summary = Object.entries(metrics)
          .map(([k, v]) => `${k}=${v}`)
          .join(', ');
        console.log(`OK: ${summary}`);
        successCount++;
      }
    } catch (err: any) {
      console.log(`ERROR: ${err?.message || err}`);
      errorCount++;
    }
  }

  console.log(`\nDone: ${successCount} synced, ${skippedCount} skipped, ${errorCount} error(s).`);

  await app.close();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
