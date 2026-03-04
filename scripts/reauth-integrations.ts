/**
 * Re-authorization script for integrations after API key rotation.
 *
 * Invalidates OAuth tokens for affected providers without destroying
 * posts, schedules, settings, or any other associated data.
 *
 * Usage:
 *   npx ts-node scripts/reauth-integrations.ts --dry-run
 *   npx ts-node scripts/reauth-integrations.ts --provider x --execute
 *   npx ts-node scripts/reauth-integrations.ts --provider x,linkedin,facebook --execute
 *   npx ts-node scripts/reauth-integrations.ts --provider x --org org_123 --execute
 */

import { PrismaClient, Prisma } from '@prisma/client';
import * as readline from 'readline';

// Providers whose tokens depend on server-level API keys (OAuth-based).
const OAUTH_PROVIDERS: Record<string, string[]> = {
  x: ['X_API_KEY', 'X_API_SECRET'],
  facebook: ['FACEBOOK_APP_ID', 'FACEBOOK_APP_SECRET'],
  'instagram-business': ['FACEBOOK_APP_ID', 'FACEBOOK_APP_SECRET'],
  instagram: ['INSTAGRAM_APP_ID', 'INSTAGRAM_APP_SECRET'],
  linkedin: ['LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET'],
  'linkedin-page': ['LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET'],
  youtube: ['YOUTUBE_CLIENT_ID', 'YOUTUBE_CLIENT_SECRET'],
  tiktok: ['TIKTOK_CLIENT_ID', 'TIKTOK_CLIENT_SECRET'],
  reddit: ['REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET'],
  pinterest: ['PINTEREST_CLIENT_ID', 'PINTEREST_CLIENT_SECRET'],
  discord: ['DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET'],
  slack: ['SLACK_ID', 'SLACK_SECRET'],
  threads: ['THREADS_APP_ID', 'THREADS_APP_SECRET'],
  twitch: ['TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET'],
  kick: ['KICK_CLIENT_ID', 'KICK_SECRET'],
  vk: ['VK_ID'],
  dribbble: ['DRIBBBLE_CLIENT_ID', 'DRIBBBLE_CLIENT_SECRET'],
};

interface CliArgs {
  providers: string[];
  dryRun: boolean;
  orgId: string | null;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let providers: string[] = Object.keys(OAUTH_PROVIDERS);
  let dryRun = true;
  let orgId: string | null = null;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--provider': {
        const val = args[++i];
        if (!val) {
          console.error('Error: --provider requires a value');
          process.exit(1);
        }
        providers = val.split(',').map((p) => p.trim().toLowerCase());
        const invalid = providers.filter((p) => !(p in OAUTH_PROVIDERS));
        if (invalid.length) {
          console.error(`Error: Unknown provider(s): ${invalid.join(', ')}`);
          console.error(`Valid providers: ${Object.keys(OAUTH_PROVIDERS).join(', ')}`);
          process.exit(1);
        }
        break;
      }
      case '--org': {
        orgId = args[++i] ?? null;
        if (!orgId) {
          console.error('Error: --org requires a value');
          process.exit(1);
        }
        break;
      }
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

  return { providers, dryRun, orgId };
}

function printHelp(): void {
  console.log(`
Usage: npx ts-node scripts/reauth-integrations.ts [options]

Options:
  --provider <name>  Target specific provider(s), comma-separated (default: all OAuth providers)
  --dry-run          Show what would be updated without making changes (default)
  --execute          Actually perform the update
  --org <id>         Target a specific organization
  --help             Show this help message

Examples:
  npx ts-node scripts/reauth-integrations.ts --dry-run
  npx ts-node scripts/reauth-integrations.ts --provider x --execute
  npx ts-node scripts/reauth-integrations.ts --provider x,linkedin,facebook --execute
  npx ts-node scripts/reauth-integrations.ts --provider x --org org_123 --execute
`);
}

function confirm(message: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${message} (yes/no): `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'yes');
    });
  });
}

async function main(): Promise<void> {
  const { providers, dryRun, orgId } = parseArgs();

  if (!process.env.DATABASE_URL) {
    console.error('Error: DATABASE_URL environment variable is not set');
    process.exit(1);
  }

  console.log('=== Integration Re-authorization Script ===\n');
  console.log(`Mode:      ${dryRun ? 'DRY RUN (no changes will be made)' : 'EXECUTE'}`);
  console.log(`Providers: ${providers.join(', ')}`);
  if (orgId) console.log(`Org:       ${orgId}`);
  console.log('');

  const prisma = new PrismaClient();

  try {
    // Build the where clause
    const where: Prisma.IntegrationWhereInput = {
      providerIdentifier: { in: providers },
      deletedAt: null,
      disabled: false,
      ...(orgId ? { organizationId: orgId } : {}),
    };

    // Fetch affected integrations for the summary
    const affected = await prisma.integration.findMany({
      where,
      select: {
        id: true,
        name: true,
        providerIdentifier: true,
        organizationId: true,
        refreshNeeded: true,
      },
      orderBy: [
        { providerIdentifier: 'asc' },
        { organizationId: 'asc' },
      ],
    });

    if (affected.length === 0) {
      console.log('No active integrations found matching the criteria.');
      return;
    }

    // Build summary by provider and organization
    const byProvider = new Map<string, number>();
    const byOrg = new Map<string, number>();
    let alreadyFlagged = 0;

    for (const integration of affected) {
      byProvider.set(
        integration.providerIdentifier,
        (byProvider.get(integration.providerIdentifier) ?? 0) + 1,
      );
      byOrg.set(
        integration.organizationId,
        (byOrg.get(integration.organizationId) ?? 0) + 1,
      );
      if (integration.refreshNeeded) {
        alreadyFlagged++;
      }
    }

    console.log(`Found ${affected.length} integration(s) to update:\n`);

    console.log('By provider:');
    byProvider.forEach((count, provider) => {
      const envVars = OAUTH_PROVIDERS[provider]?.join(', ') ?? 'unknown';
      console.log(`  ${provider}: ${count} integration(s)  [env: ${envVars}]`);
    });

    console.log('\nBy organization:');
    byOrg.forEach((count, org) => {
      console.log(`  ${org}: ${count} integration(s)`);
    });

    if (alreadyFlagged > 0) {
      console.log(`\nNote: ${alreadyFlagged} integration(s) already have refreshNeeded = true`);
    }

    console.log('\nAffected integrations:');
    for (const integration of affected) {
      const flagStatus = integration.refreshNeeded ? ' (already flagged)' : '';
      console.log(
        `  [${integration.providerIdentifier}] ${integration.name} (${integration.id})${flagStatus}`,
      );
    }

    if (dryRun) {
      console.log('\n--- DRY RUN: No changes were made ---');
      console.log('Run with --execute to apply changes.');
      return;
    }

    // Confirm before executing
    const confirmed = await confirm(
      `\nThis will invalidate tokens for ${affected.length} integration(s). Continue?`,
    );
    if (!confirmed) {
      console.log('Aborted.');
      return;
    }

    console.log('\nApplying changes...');

    const result = await prisma.integration.updateMany({
      where,
      data: {
        refreshNeeded: true,
        token: '',
        refreshToken: null,
        tokenExpiration: null,
      },
    });

    console.log(`\nUpdated ${result.count} integration(s).`);
    console.log('  - refreshNeeded → true');
    console.log('  - token → cleared');
    console.log('  - refreshToken → null');
    console.log('  - tokenExpiration → null');
    console.log('\nAll posts, schedules, and settings are preserved.');
    console.log('Affected users will see "re-authorization needed" in the UI.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
