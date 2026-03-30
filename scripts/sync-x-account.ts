/**
 * Sync X account info (followers, following, tweet count, etc.) for integrations.
 *
 * Fetches live data from the X API and writes it into the integration's
 * additionalSettings (same format used by the dashboard account metrics flow).
 * Also optionally refreshes the stored name and picture.
 *
 * Usage:
 *   npx ts-node scripts/sync-x-account.ts --dry-run
 *   npx ts-node scripts/sync-x-account.ts --integration <id> --execute
 *   npx ts-node scripts/sync-x-account.ts --org <orgId> --execute
 *   npx ts-node scripts/sync-x-account.ts --execute          # all active X integrations
 *   npx ts-node scripts/sync-x-account.ts --integration <id> --update-profile --execute
 */

import { PrismaClient } from '@prisma/client';
import { TwitterApi } from 'twitter-api-v2';

interface CliArgs {
  integrationId: string | null;
  orgId: string | null;
  dryRun: boolean;
  updateProfile: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let integrationId: string | null = null;
  let orgId: string | null = null;
  let dryRun = true;
  let updateProfile = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--integration': {
        integrationId = args[++i] ?? null;
        if (!integrationId) {
          console.error('Error: --integration requires a value');
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
      case '--update-profile':
        updateProfile = true;
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

  return { integrationId, orgId, dryRun, updateProfile };
}

function printHelp(): void {
  console.log(`
Usage: npx ts-node scripts/sync-x-account.ts [options]

Options:
  --integration <id>  Target a specific integration by ID
  --org <id>          Target all active X integrations in an organization
  --update-profile    Also update the stored name and profile picture
  --dry-run           Show what would be updated without making changes (default)
  --execute           Actually perform the update
  --help              Show this help message

Examples:
  npx ts-node scripts/sync-x-account.ts --dry-run
  npx ts-node scripts/sync-x-account.ts --execute
  npx ts-node scripts/sync-x-account.ts --integration clxyz123 --execute
  npx ts-node scripts/sync-x-account.ts --org org_123 --execute
  npx ts-node scripts/sync-x-account.ts --integration clxyz123 --update-profile --execute
`);
}

interface AccountInfo {
  followers: number;
  following: number;
  tweets: number;
  listed: number;
  name: string;
  username: string;
  picture: string;
  isPremium: boolean;
}

async function fetchXAccountInfo(token: string): Promise<AccountInfo> {
  const [accessToken, accessSecret] = token.split(':');
  const client = new TwitterApi({
    appKey: process.env.X_API_KEY!,
    appSecret: process.env.X_API_SECRET!,
    accessToken,
    accessSecret,
  });

  try {
    const { data } = await client.v2.me({
      'user.fields': [
        'public_metrics',
        'username',
        'name',
        'profile_image_url',
        'verified',
        'verified_type',
      ],
    });
    return {
      followers: data.public_metrics?.followers_count ?? 0,
      following: data.public_metrics?.following_count ?? 0,
      tweets: data.public_metrics?.tweet_count ?? 0,
      listed: data.public_metrics?.listed_count ?? 0,
      name: data.name,
      username: data.username,
      picture: data.profile_image_url || '',
      // verified_type === 'blue' → X Premium subscriber
      // legacy `verified` covers org/celebrity checkmarks
      isPremium: data.verified_type === 'blue' || !!data.verified,
    };
  } catch (v2Err: any) {
    // Fallback to v1.1 if v2 fails
    console.warn(`  v2.me failed (${v2Err?.code ?? '?'}), trying v1.1 fallback...`);
    const v1User = await client.v1.verifyCredentials();
    return {
      followers: v1User.followers_count ?? 0,
      following: v1User.friends_count ?? 0,
      tweets: v1User.statuses_count ?? 0,
      listed: v1User.listed_count ?? 0,
      name: v1User.name,
      username: v1User.screen_name,
      picture: v1User.profile_image_url_https || '',
      // v1.1 API has no verified_type equivalent; `verified` only covers
      // org/celebrity checkmarks — X Premium (Blue) cannot be detected via v1.1.
      isPremium: !!v1User.verified,
    };
  }
}

function mergeAdditionalSettings(
  existing: string | null,
  metrics: Record<string, number>,
  isPremium: boolean,
): string {
  const settings: Array<{ title: string; description: string; type: string; value: any }> =
    JSON.parse(existing || '[]');

  for (const [key, value] of Object.entries(metrics)) {
    const title = `account:${key}`;
    const existing = settings.find((s) => s.title === title);
    if (existing) {
      existing.value = value;
    } else {
      settings.push({ title, description: key, type: 'readonly', value });
    }
  }

  // Sync the Verified (X Premium) flag using verified_type === 'blue',
  // which correctly identifies paid subscribers (the legacy `verified` field
  // only covers org/celebrity checkmarks and is unreliable for Premium).
  const verifiedEntry = settings.find((s) => s.title === 'Verified');
  if (verifiedEntry) {
    verifiedEntry.value = isPremium;
  } else {
    settings.push({
      title: 'Verified',
      description: 'Is this a verified user? (Premium)',
      type: 'checkbox',
      value: isPremium,
    });
  }

  return JSON.stringify(settings);
}

async function main(): Promise<void> {
  const { integrationId, orgId, dryRun, updateProfile } = parseArgs();

  if (!process.env.DATABASE_URL) {
    console.error('Error: DATABASE_URL environment variable is not set');
    process.exit(1);
  }
  if (!process.env.X_API_KEY || !process.env.X_API_SECRET) {
    console.error('Error: X_API_KEY and X_API_SECRET environment variables are required');
    process.exit(1);
  }

  console.log('=== X Account Sync Script ===\n');
  console.log(`Mode:           ${dryRun ? 'DRY RUN (no changes will be made)' : 'EXECUTE'}`);
  console.log(`Update profile: ${updateProfile ? 'yes (name + picture)' : 'no'}`);
  if (integrationId) console.log(`Integration:    ${integrationId}`);
  if (orgId) console.log(`Org:            ${orgId}`);
  console.log('');

  const prisma = new PrismaClient();

  try {
    const integrations = await prisma.integration.findMany({
      where: {
        providerIdentifier: 'x',
        deletedAt: null,
        disabled: false,
        refreshNeeded: false,
        ...(integrationId ? { id: integrationId } : {}),
        ...(orgId ? { organizationId: orgId } : {}),
      },
      select: {
        id: true,
        name: true,
        internalId: true,
        organizationId: true,
        token: true,
        additionalSettings: true,
        picture: true,
      },
    });

    if (integrations.length === 0) {
      console.log('No active X integrations found matching the criteria.');
      return;
    }

    console.log(`Found ${integrations.length} X integration(s):\n`);
    for (const i of integrations) {
      console.log(`  [${i.id}] ${i.name} (org: ${i.organizationId})`);
    }
    console.log('');

    if (dryRun) {
      console.log('--- DRY RUN: fetching live data to preview changes ---\n');
    }

    let successCount = 0;
    let errorCount = 0;

    for (const integration of integrations) {
      process.stdout.write(`  Syncing [${integration.id}] ${integration.name} ... `);

      let info: AccountInfo;
      try {
        info = await fetchXAccountInfo(integration.token);
      } catch (err: any) {
        console.log(`ERROR: ${err?.message || err}`);
        errorCount++;
        continue;
      }

      const metrics: Record<string, number> = {
        followers: info.followers,
        following: info.following,
        posts: info.tweets,
        listed: info.listed,
      };

      console.log(
        `followers=${info.followers}, following=${info.following}, tweets=${info.tweets}, listed=${info.listed}, premium=${info.isPremium}`,
      );

      if (dryRun) {
        if (updateProfile) {
          console.log(`    -> would also update name="${info.name}", picture="${info.picture}"`);
        }
        successCount++;
        continue;
      }

      const newSettings = mergeAdditionalSettings(integration.additionalSettings, metrics, info.isPremium);
      const updateData: Record<string, any> = { additionalSettings: newSettings };

      if (updateProfile) {
        updateData.name = info.name;
        updateData.picture = info.picture;
        console.log(`    -> also updating name="${info.name}", picture="${info.picture}"`);
      }

      await prisma.integration.update({
        where: { id: integration.id },
        data: updateData,
      });

      successCount++;
    }

    console.log('');
    if (dryRun) {
      console.log(`--- DRY RUN complete: ${successCount} would be updated, ${errorCount} error(s) ---`);
      console.log('Run with --execute to apply changes.');
    } else {
      console.log(`Done: ${successCount} updated, ${errorCount} error(s).`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
