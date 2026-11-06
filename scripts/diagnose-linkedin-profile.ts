/** Read-only LinkedIn identity/profile diagnosis. No API calls or database writes. */
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { databaseNameFromUrl } from './lib/database-url';

const NAMESPACE = 'linkedin.fs_miniProfile';
const normalize = (value: string) => value.trim().toLowerCase().replace(/^@/, '').replace(/^u\//, '');

export interface AccountRow {
  id: string;
  organizationId: string;
  providerIdentifier: string;
  type: string;
  profile: string | null;
  internalId: string;
  identityNamespace: string | null;
  disabled: boolean;
  deletedAt: Date | string | null;
}

export function parseOptions(argv: string[]) {
  const options = { id: '', handle: '', org: undefined as string | undefined,
    backendDir: process.env.AISEE_BACKEND_DIR || resolve(__dirname, '..'),
    help: false };
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (seen.has(flag)) throw new Error('DUPLICATE_OPTION');
    seen.add(flag);
    if (flag === '--help') { options.help = true; continue; }
    if (!['--id', '--handle', '--org', '--backend-dir'].includes(flag)) throw new Error('UNKNOWN_OPTION');
    const value = argv[++index]?.trim();
    if (!value || value.startsWith('--')) throw new Error('OPTION_VALUE_REQUIRED');
    if (flag === '--id') options.id = value;
    if (flag === '--handle') options.handle = value;
    if (flag === '--org') options.org = value;
    if (flag === '--backend-dir') options.backendDir = resolve(value);
  }
  if (!options.help && (!/^[A-Za-z0-9_-]+$/.test(options.id) ||
    !/^[A-Za-z0-9_-]+$/.test(normalize(options.handle)))) throw new Error('VALID_ID_AND_HANDLE_REQUIRED');
  return options;
}

export function validateDatabaseUrl(raw: string | undefined): string {
  databaseNameFromUrl(raw);
  const url = new URL(raw!);
  url.searchParams.set('connect_timeout', '5');
  url.searchParams.set('socket_timeout', '15');
  return url.href;
}

/** Mirrors only the resolver's initial identity/profile gates, not session or recovery authorization. */
export function analyzeLinkedinAccounts(accounts: AccountRow[], target: { id: string; handle: string }, org?: string) {
  const rows = accounts.filter(row => row.providerIdentifier === 'linkedin' && (!org || row.organizationId === org));
  const profile = normalize(target.handle);
  const relevant = (row: AccountRow) => normalize(row.profile ?? '') === profile || row.internalId.trim() === target.id;
  const organizations = org ? [org] : [...new Set(rows.filter(relevant).map(row => row.organizationId))].sort();
  return organizations.map(organizationId => {
    const scoped = rows.filter(row => row.organizationId === organizationId);
    const matches = scoped.filter(row => [NAMESPACE, 'legacy'].includes(row.identityNamespace ?? '') &&
      row.internalId.trim() === target.id);
    const account = matches.length === 1 ? matches[0] : undefined;
    const foreignNamespace = scoped.some(row => ![NAMESPACE, 'legacy'].includes(row.identityNamespace ?? '') &&
      row.internalId.trim() === target.id);
    const requiresProfileCheck = account?.identityNamespace === 'legacy' ||
      ((!account || account.type === 'social') &&
        (!account || !!account.deletedAt || normalize(account.profile ?? '') !== profile));
    const owners = scoped.filter(row => row.type === 'social' && !row.deletedAt &&
      normalize(row.profile ?? '') === profile && row.id !== account?.id);
    const profileGate = matches.length > 1 ? 'ACCOUNT_IDENTITY_CONFLICT'
      : foreignNamespace ? 'ACCOUNT_IDENTITY_UNRESOLVED'
      : requiresProfileCheck && owners.length ? 'ACCOUNT_PROFILE_CONFLICT' : 'NO_PROFILE_CONFLICT';
    const legacyCandidates = !account ? scoped.filter(row => row.identityNamespace === 'legacy' &&
      !row.deletedAt && row.type === 'social' && normalize(row.profile ?? '') === profile) : [];
    const legacyRecoveryCandidateId = legacyCandidates.length === 1 ? legacyCandidates[0].id : null;
    return {
      organizationId, profileGate, matchedIntegrationId: account?.id ?? null,
      matchedIdentityIntegrationIds: matches.map(row => row.id),
      conflictingIntegrationIds: profileGate === 'ACCOUNT_PROFILE_CONFLICT' ? owners.map(row => row.id) : [],
      sameProfileIntegrationIds: scoped.filter(row => normalize(row.profile ?? '') === profile).map(row => row.id),
      legacyRecoveryCandidateId,
      legacyRecoveryEligibility: 'NOT_CHECKED' as const,
      relatedAccounts: scoped.filter(relevant).map(row => ({
        id: row.id, internalId: row.internalId, identityNamespace: row.identityNamespace,
        profile: row.profile, type: row.type, disabled: row.disabled, deletedAt: row.deletedAt,
        matchesReportedId: row.internalId.trim() === target.id,
        matchesReportedProfile: normalize(row.profile ?? '') === profile,
      })),
      nextStep: profileGate === 'ACCOUNT_PROFILE_CONFLICT'
        ? legacyRecoveryCandidateId
          ? 'This is a profile-only suggestion; stored browser identity provenance and recovery eligibility were not inspected. After deploying the recovery fix, open extension Settings and check Browser account connections. If the backend offers Verify old account, review and confirm it. Known conflicting browser identities, coordinated references, and other recovery guards may still block the change. Refresh alone cannot confirm recovery.'
          : 'Review the listed profile owners and identity namespaces. Ambiguous or canonical accounts cannot be merged by handle or repaired by editing IDs directly.'
        : profileGate !== 'NO_PROFILE_CONFLICT'
        ? 'Review duplicate IDs or incompatible namespaces before attempting recovery.'
        : 'The initial profile gate does not reproduce the conflict. Check the actual request organization, deployed backend version and database, recovery path, and server logs. This does not prove session registration will succeed.',
    };
  });
}

async function main() {
  let stage = 'arguments';
  let db: { $disconnect(): Promise<void> } | undefined;
  try {
    const options = parseOptions(process.argv.slice(2));
    if (options.help) {
      console.log(`Usage: pnpm exec ts-node --project scripts/tsconfig.json scripts/diagnose-linkedin-profile.ts
  --id <LinkedIn-miniProfile-id> --handle <publicIdentifier> [--org <organization-id>]
  [--backend-dir <postiz-app-directory>]

Reads DATABASE_URL from the environment, then postiz-app/.env as fallback.
The database name is parsed from DATABASE_URL. Uses the backend's installed Prisma client.
Without --org, scans LinkedIn member accounts but reports only related organizations.
Outputs JSON without credentials. No recovery, deletion, or session-report requests.
Exit codes: 0 = no initial gate block found, 2 = gate block found, 1 = diagnosis failed.
No matching organization is not evidence that the API request should succeed.`);
      return;
    }
    stage = 'configuration';
    const requireBackend = createRequire(resolve(options.backendDir, 'package.json'));
    let rawUrl = process.env.DATABASE_URL;
    const envPath = resolve(options.backendDir, '.env');
    if (!rawUrl && existsSync(envPath)) rawUrl = requireBackend('dotenv').parse(readFileSync(envPath)).DATABASE_URL;
    const databaseUrl = validateDatabaseUrl(rawUrl);
    const url = new URL(databaseUrl);
    stage = 'database-read';
    const { PrismaClient } = requireBackend('@prisma/client');
    const client = new PrismaClient({ datasources: { db: { url: databaseUrl } }, log: [] });
    db = client;
    const rows: AccountRow[] = [];
    let after: string | undefined;
    for (;;) {
      const batch: AccountRow[] = await client.integration.findMany({
        where: { providerIdentifier: 'linkedin', ...(options.org ? { organizationId: options.org } : {}),
          ...(after ? { id: { gt: after } } : {}) },
        select: { id: true, organizationId: true, providerIdentifier: true, type: true, profile: true,
          internalId: true, identityNamespace: true, disabled: true, deletedAt: true },
        orderBy: { id: 'asc' }, take: 500,
      });
      rows.push(...batch);
      if (rows.length > 10000) throw new Error('SCAN_LIMIT_EXCEEDED_USE_ORG');
      if (batch.length < 500) break;
      after = batch[batch.length - 1].id;
    }
    const reports = analyzeLinkedinAccounts(rows, options, options.org);
    console.log(JSON.stringify({ observedAt: new Date().toISOString(), readOnly: true,
      database: databaseNameFromUrl(databaseUrl), databaseHost: url.hostname, databasePort: url.port || '5432',
      target: { id: options.id, handle: options.handle, identityNamespace: NAMESPACE },
      organizationFilter: options.org ?? null, scannedAccounts: rows.length, reports,
      scope: 'Initial identity/profile gates only; no session, permission, channel-limit or controlled-recovery checks. Compare the reported database host with the API deployment.',
    }, null, 2));
    if (reports.some(report => report.profileGate !== 'NO_PROFILE_CONFLICT')) process.exitCode = 2;
  } catch (error) {
    const known = ['DUPLICATE_OPTION', 'UNKNOWN_OPTION', 'OPTION_VALUE_REQUIRED', 'VALID_ID_AND_HANDLE_REQUIRED',
      'DATABASE_URL is required',
      'DATABASE_URL must be a valid PostgreSQL URL with an explicit database name',
      'SCAN_LIMIT_EXCEEDED_USE_ORG'];
    const message = error instanceof Error && known.includes(error.message) ? error.message : 'DIAGNOSIS_FAILED';
    // Database errors may embed connection strings or credentials; never print the raw error.
    console.log(JSON.stringify({ error: message, stage,
      hint: 'Check arguments, backend dependencies, DATABASE_URL, and database reachability. Credentials are intentionally omitted.' }));
    process.exitCode = 1;
  } finally {
    if (db) {
      try { await db.$disconnect(); } catch {
        console.log(JSON.stringify({ error: 'DATABASE_DISCONNECT_FAILED' }));
        process.exitCode = 1;
      }
    }
  }
}

if (require.main === module) void main();
