/**
 * Read-only audit of social-account profile uniqueness within an organization
 * and provider. Includes deleted rows; never merges or repairs accounts.
 *
 * pnpm exec ts-node --project scripts/tsconfig.json scripts/audit-integration-profiles.ts
 */
import type { PrismaClient } from '@prisma/client';
import { normalizeHandle } from '../libraries/nestjs-libraries/src/database/prisma/integrations/extension-session.utils';

const EXPECTED_DATABASE = 'aisee_postiz_dev';
const BATCH_SIZE = 500;

export interface ProfileAccount {
  id: string;
  organizationId: string;
  providerIdentifier: string;
  name: string;
  profile: string | null;
  internalId: string;
  identityNamespace: string | null;
  disabled: boolean;
  deletedAt: Date | null;
}

interface Options {
  organizationId?: string;
  platform?: string;
  json: boolean;
  help: boolean;
}

export function parseOptions(argv: string[]): Options {
  const result: Options = { json: false, help: false };
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index++) {
    const option = argv[index];
    if (seen.has(option)) throw new Error(`Repeated option: ${option}`);
    seen.add(option);
    if (option === '--json') result.json = true;
    else if (option === '--help') result.help = true;
    else if (option === '--org' || option === '--platform') {
      const value = argv[++index]?.trim();
      if (!value || value.startsWith('--'))
        throw new Error(`A value is required for ${option}`);
      if (option === '--org') result.organizationId = value;
      else result.platform = value;
    } else throw new Error(`Unknown option: ${option}`);
  }
  return result;
}

export function assertAuditDatabase(databaseUrl: string | undefined): string {
  let url: URL;
  try {
    url = new URL(databaseUrl ?? '');
  } catch {
    throw new Error('A valid PostgreSQL DATABASE_URL is required.');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
    url.pathname !== `/${EXPECTED_DATABASE}`) {
    throw new Error(`DATABASE_URL must point to ${EXPECTED_DATABASE}; refusing to connect.`);
  }
  return EXPECTED_DATABASE;
}

function unresolved(account: ProfileAccount): boolean {
  return !account.internalId?.trim() || !account.identityNamespace?.trim() ||
    account.identityNamespace === 'legacy';
}

export function analyzeProfiles(accounts: ProfileAccount[]) {
  const groups = new Map<string, {
    organizationId: string;
    providerIdentifier: string;
    normalizedProfile: string;
    accounts: ProfileAccount[];
  }>();
  const missingProfiles: ProfileAccount[] = [];
  for (const account of accounts) {
    const normalizedProfile = normalizeHandle(account.profile ?? '');
    if (!normalizedProfile) {
      missingProfiles.push(account);
      continue;
    }
    const key = JSON.stringify([
      account.organizationId, account.providerIdentifier, normalizedProfile,
    ]);
    let group = groups.get(key);
    if (!group) {
      group = {
        organizationId: account.organizationId,
        providerIdentifier: account.providerIdentifier,
        normalizedProfile,
        accounts: [],
      };
      groups.set(key, group);
    }
    group.accounts.push(account);
  }
  const duplicates = [...groups.values()]
    .filter(group => group.accounts.length > 1)
    .map(group => {
      const identities = new Set(group.accounts.map(account => JSON.stringify([
        account.identityNamespace,
        account.identityNamespace === 'reddit.user_id'
          ? account.internalId?.trim().replace(/^t2_/i, '').toLowerCase()
          : account.internalId?.trim(),
      ])));
      return {
        ...group,
        nonDeletedAccounts: group.accounts.filter(account => !account.deletedAt).length,
        identityComparison: group.accounts.some(unresolved)
          ? 'UNRESOLVED_IDENTITY' : identities.size === 1
          ? 'SAME_IDENTITY' : 'DIFFERENT_IDENTITIES',
      };
    });
  const unresolvedIdentities = accounts.filter(unresolved);
  return {
    summary: {
      scannedAccounts: accounts.length,
      missingProfileAccounts: missingProfiles.length,
      unresolvedIdentityAccounts: unresolvedIdentities.length,
      duplicateGroups: duplicates.length,
      duplicateAccounts: duplicates.reduce((total, group) => total + group.accounts.length, 0),
      groupsWithMultipleNonDeletedAccounts: duplicates.filter(group => group.nonDeletedAccounts > 1).length,
      groupsInvolvingDeletedAccounts: duplicates.filter(group => group.nonDeletedAccounts < group.accounts.length).length,
    },
    duplicates,
    missingProfiles,
    unresolvedIdentities,
  };
}

export async function collectProfileAudit(
  db: Pick<PrismaClient, 'integration'>,
  filters: Pick<Options, 'organizationId' | 'platform'> = {}
) {
  const accounts: ProfileAccount[] = [];
  let after: string | undefined;
  for (;;) {
    const batch = await db.integration.findMany({
      where: {
        type: 'social',
        ...(filters.organizationId ? { organizationId: filters.organizationId } : {}),
        ...(filters.platform ? { providerIdentifier: filters.platform } : {}),
        ...(after ? { id: { gt: after } } : {}),
      },
      select: {
        id: true,
        organizationId: true,
        providerIdentifier: true,
        name: true,
        profile: true,
        internalId: true,
        identityNamespace: true,
        disabled: true,
        deletedAt: true,
      },
      orderBy: { id: 'asc' },
      take: BATCH_SIZE,
    });
    accounts.push(...batch);
    if (batch.length < BATCH_SIZE) break;
    after = batch[batch.length - 1].id;
  }
  return analyzeProfiles(accounts);
}

function printReport(report: ReturnType<typeof analyzeProfiles>) {
  console.log('Read-only social account profile audit (includes deleted accounts)');
  console.table(report.summary);
  for (const group of report.duplicates) {
    console.log(`Duplicate: organization=${group.organizationId} provider=${group.providerIdentifier} profile=${group.normalizedProfile} identity=${group.identityComparison}`);
    console.table(group.accounts);
  }
  if (report.missingProfiles.length) {
    console.log('Missing profiles (informational; not grouped as duplicates):');
    console.table(report.missingProfiles);
  }
  if (report.unresolvedIdentities.length) {
    console.log('Missing or legacy identity fields (informational):');
    console.table(report.unresolvedIdentities);
  }
  console.log(report.duplicates.length
    ? 'Duplicate profiles found. No data was changed. Review identities and references before any cleanup.'
    : 'No duplicate profiles found in the selected scope. No data was changed.');
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    console.log(`Usage: pnpm exec ts-node --project scripts/tsconfig.json scripts/audit-integration-profiles.ts [options]

  --org <id>         Limit to one organization
  --platform <name>  Limit to one exact provider (e.g. x, linkedin, linkedin-page)
  --json             Print a JSON report instead of tables
  --help             Show this help without connecting to a database

DATABASE_URL must target ${EXPECTED_DATABASE}. Deleted rows are included.
Exit codes: 0 = no duplicates; 2 = duplicates found; 1 = invalid input or audit failure.
Missing profiles and missing/legacy identity fields are informational.
Only Prisma findMany reads are performed. No write or repair mode exists.`);
    return;
  }
  const dotenv = await import('dotenv');
  dotenv.config();
  const databaseUrl = process.env.DATABASE_URL;
  const database = assertAuditDatabase(databaseUrl);
  const { PrismaClient } = await import('@prisma/client');
  const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    const report = await collectProfileAudit(db, options);
    if (options.json) console.log(JSON.stringify({ database, ...report }, null, 2));
    else {
      console.log(`Database: ${database}`);
      printReport(report);
    }
    process.exitCode = report.duplicates.length ? 2 : 0;
  } catch {
    // Prisma failures may include connection strings; do not print credentials.
    throw new Error('Profile audit failed. Check database access and the deployed Prisma schema.');
  } finally {
    await db.$disconnect();
  }
}

if (typeof require !== 'undefined' && require.main === module) {
  main().catch((error: Error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
