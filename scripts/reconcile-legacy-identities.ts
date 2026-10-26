/**
 * Preview or safely reconcile legacy social-account identities for affected users.
 *
 * The script never updates Integration directly. In --apply mode it calls the
 * protected POST /integrations/:id/identity/verify endpoint, which performs a
 * live read-only OAuth actor probe, conflict checks, and identity audit writes.
 * Session-only accounts are reported and repaired automatically by a fresh
 * controlled-mode extension login.
 *
 * Usage:
 *   pnpm exec ts-node --project scripts/tsconfig.json scripts/reconcile-legacy-identities.ts \
 *     --user <userId> --user <userId>
 *   AISEE_AUTH_TOKEN=... pnpm exec ts-node --project scripts/tsconfig.json \
 *     scripts/reconcile-legacy-identities.ts --users <id,id> --apply
 */
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import {
  planLegacyIdentity,
  type LegacyIdentityPlan,
} from '@gitroom/nestjs-libraries/extension/legacy-identity-reconciliation';

dotenv.config();

const DEFAULT_EXPECTED_DATABASE = 'aisee_postiz_dev';

export interface CliOptions {
  apply: boolean;
  allUsers: boolean;
  userIds: string[];
  integrationIds: string[];
  organizationId?: string;
  baseUrl?: string;
  expectedDatabase: string;
}

export interface PreviewCandidate {
  userId: string;
  membershipId: string;
  organizationId: string;
  integrationId: string;
  providerIdentifier: string;
  token: string;
}

export function parseOptions(argv: string[]): CliOptions {
  const flags = new Set<string>();
  const inputs = new Map<string, string[]>();
  const valueOptions = new Set([
    '--user',
    '--users',
    '--integration',
    '--integrations',
    '--org',
    '--base-url',
    '--expected-database',
  ]);
  for (let index = 0; index < argv.length; index++) {
    const option = argv[index];
    if (['--all', '--apply', '--help'].includes(option)) {
      flags.add(option);
      continue;
    }
    if (!valueOptions.has(option)) throw new Error(`Unknown option: ${option}`);
    const value = argv[++index]?.trim();
    if (!value || value.startsWith('--'))
      throw new Error(`A value is required for ${option}`);
    const entries = inputs.get(option) ?? [];
    entries.push(value);
    inputs.set(option, entries);
  }
  const ids = (singular: string, plural: string) => [
    ...new Set(
      [
        ...(inputs.get(singular) ?? []),
        ...(inputs.get(plural) ?? []).flatMap((entry) => entry.split(',')),
      ]
        .map((entry) => entry.trim())
        .filter(Boolean)
    ),
  ];
  const userIds = ids('--user', '--users');
  const integrationIds = ids('--integration', '--integrations');
  const organizationId = inputs.get('--org')?.[0];
  const allUsers = flags.has('--all');
  if (
    (inputs.has('--users') && !userIds.length) ||
    (inputs.has('--integrations') && !integrationIds.length)
  ) {
    throw new Error('At least one nonblank ID is required for an ID list');
  }
  if (allUsers && (userIds.length || integrationIds.length)) {
    throw new Error('--all cannot be combined with user or integration IDs');
  }
  if (
    !flags.has('--help') &&
    !allUsers &&
    !userIds.length &&
    !integrationIds.length &&
    !organizationId
  ) {
    throw new Error(
      'Specify --all, --user/--users, --integration/--integrations, or --org'
    );
  }
  for (const option of ['--org', '--base-url', '--expected-database']) {
    if ((inputs.get(option)?.length ?? 0) > 1)
      throw new Error(`${option} may only be specified once`);
  }
  return {
    apply: flags.has('--apply'),
    allUsers,
    userIds,
    integrationIds,
    organizationId,
    baseUrl:
      inputs.get('--base-url')?.[0] ?? process.env.NEXT_PUBLIC_BACKEND_URL,
    expectedDatabase:
      inputs.get('--expected-database')?.[0] ?? DEFAULT_EXPECTED_DATABASE,
  };
}

export async function collectCandidates(
  prisma: Pick<
    PrismaClient,
    'user' | 'integration' | 'userOrganization' | 'settings'
  >,
  options: CliOptions
) {
  const users = options.userIds.length
    ? await prisma.user.findMany({
        where: { id: { in: options.userIds } },
        select: { id: true },
      })
    : [];
  const foundUsers = new Set(users.map((user) => user.id));
  const integrations = await prisma.integration.findMany({
    where: {
      identityNamespace: 'legacy',
      deletedAt: null,
      ...(options.organizationId
        ? { organizationId: options.organizationId }
        : {}),
      ...(options.integrationIds.length
        ? { id: { in: options.integrationIds } }
        : {}),
      ...(options.userIds.length
        ? {
            organization: {
              users: {
                some: {
                  userId: { in: options.userIds },
                  disabled: false,
                },
              },
            },
          }
        : {}),
    },
    select: {
      id: true,
      organizationId: true,
      providerIdentifier: true,
      token: true,
    },
    orderBy: [{ organizationId: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
  });
  const organizationIds = [
    ...new Set(integrations.map((row) => row.organizationId)),
  ];
  const [members, modeRows] = organizationIds.length
    ? await Promise.all([
        prisma.userOrganization.findMany({
          where: {
            organizationId: { in: organizationIds },
            disabled: false,
            role: { in: ['ADMIN', 'SUPERADMIN'] },
            user: { activated: true },
          },
          select: { id: true, userId: true, organizationId: true },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        }),
        prisma.settings.findMany({
          where: {
            key: {
              in: organizationIds.map(
                (id) => `sending.organization_mode:${id}`
              ),
            },
          },
          select: { key: true, value: true },
        }),
      ])
    : [[], []];
  const administrators = new Map<
    string,
    { userId: string; membershipId: string }
  >();
  for (const member of members) {
    if (!administrators.has(member.organizationId))
      administrators.set(member.organizationId, {
        userId: member.userId,
        membershipId: member.id,
      });
  }
  const controlledOrganizations = new Set(
    modeRows
      .filter((row) => {
        const mode = row.value as { mode?: unknown; revision?: unknown } | null;
        return (
          mode?.mode === 'CONTROLLED' &&
          Number.isInteger(mode.revision) &&
          (mode.revision as number) > 0
        );
      })
      .map((row) => row.key.slice('sending.organization_mode:'.length))
  );
  const candidates: PreviewCandidate[] = [];
  const skipped: Array<{
    integrationId: string;
    organizationId: string;
    code: string;
  }> = [];
  for (const integration of integrations) {
    const admin = administrators.get(integration.organizationId);
    const code = !controlledOrganizations.has(integration.organizationId)
      ? 'ORGANIZATION_NOT_CONTROLLED'
      : !admin
      ? 'ORGANIZATION_ADMIN_REQUIRED'
      : null;
    if (code) {
      skipped.push({
        integrationId: integration.id,
        organizationId: integration.organizationId,
        code,
      });
      continue;
    }
    candidates.push({
      ...admin!,
      organizationId: integration.organizationId,
      integrationId: integration.id,
      providerIdentifier: integration.providerIdentifier,
      token: integration.token,
    });
  }
  const foundIntegrations = new Set(integrations.map((row) => row.id));
  return {
    candidates,
    skipped,
    organizationCount: organizationIds.length,
    missingUserIds: options.userIds.filter((id) => !foundUsers.has(id)),
    unmatchedIntegrationIds: options.integrationIds.filter(
      (id) => !foundIntegrations.has(id)
    ),
  };
}

export function databaseName(databaseUrl: string | undefined): string | null {
  if (!databaseUrl) return null;
  try {
    return decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ''));
  } catch {
    return null;
  }
}

export function previewPlan(
  candidate: Pick<PreviewCandidate, 'providerIdentifier' | 'token'>
): LegacyIdentityPlan {
  return planLegacyIdentity(candidate);
}

function usage(): void {
  console.log(`Reconcile legacy social-account identities through the protected API.

  --user <id>                 Affected user ID; repeat for multiple users
  --users <id,id>             Comma-separated affected user IDs
  --integration <id>          Social-account Integration ID; repeat as needed
  --integrations <id,id>      Comma-separated social-account Integration IDs
  --all                      Scan legacy accounts across all users
  --org <id>                  Limit any selection to one organization
  --apply                     Call the verification API (default: preview only)
  --base-url <url>            Backend URL (default: NEXT_PUBLIC_BACKEND_URL)
  --expected-database <name>  Required database name (default: ${DEFAULT_EXPECTED_DATABASE})
  --help                      Show this help

Apply mode reads AISEE_AUTH_TOKEN from the environment. For users outside the
token owner's organizations, use a super-admin token; the request impersonates
an active administrator membership in each organization. Cross-organization
--all --apply requires a super-admin token. User, organization, and integration
filters intersect; --all cannot be combined with user/integration IDs.
Only Controlled organizations are eligible; other organizations are reported
as skipped. No sending mode is changed.`);
}

async function responseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function verifyThroughApi(
  baseUrl: string,
  token: string,
  candidate: PreviewCandidate
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const response = await fetch(
    `${baseUrl.replace(/\/$/, '')}/integrations/${encodeURIComponent(
      candidate.integrationId
    )}/identity/verify`,
    {
      method: 'POST',
      signal: AbortSignal.timeout(60_000),
      headers: {
        authorization: `Bearer ${token}`,
        showorg: candidate.organizationId,
        impersonate: candidate.membershipId,
      },
    }
  );
  return {
    ok: response.ok,
    status: response.status,
    body: await responseBody(response),
  };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (process.argv.includes('--help')) {
    usage();
    return;
  }
  const configuredDatabase = databaseName(process.env.DATABASE_URL);
  if (configuredDatabase !== options.expectedDatabase) {
    throw new Error(
      `Refusing to run: expected database ${options.expectedDatabase}, got ${
        configuredDatabase ?? 'unknown'
      }`
    );
  }
  if (options.apply && !options.baseUrl) {
    throw new Error(
      '--base-url or NEXT_PUBLIC_BACKEND_URL is required with --apply'
    );
  }
  const authToken = process.env.AISEE_AUTH_TOKEN;
  if (options.apply && !authToken) {
    throw new Error('AISEE_AUTH_TOKEN is required with --apply');
  }

  const prisma = new PrismaClient();
  try {
    const selection = await collectCandidates(prisma, options);
    const { candidates, skipped } = selection;
    for (const userId of selection.missingUserIds)
      console.log(`MISSING_USER ${userId}`);
    for (const integrationId of selection.unmatchedIntegrationIds)
      console.log(
        `SKIP_UNMATCHED_INTEGRATION integration=${integrationId} code=NOT_LEGACY_OR_OUTSIDE_SCOPE`
      );
    for (const entry of skipped)
      console.log(
        `SKIPPED organization=${entry.organizationId} integration=${entry.integrationId} code=${entry.code}`
      );

    console.log(`Mode: ${options.apply ? 'APPLY' : 'PREVIEW'}`);
    console.log(`Database: ${configuredDatabase}`);
    console.log(
      `User filter: ${
        options.allUsers
          ? 'ALL'
          : options.userIds.length
          ? options.userIds.join(',')
          : 'NONE'
      }`
    );
    console.log(`Organizations: ${selection.organizationCount}`);
    console.log(`Legacy integrations: ${candidates.length + skipped.length}`);

    let fixed = 0;
    let waiting = 0;
    let failed = 0;
    for (const candidate of candidates) {
      const plan = previewPlan(candidate);
      const prefix = `user=${candidate.userId} organization=${candidate.organizationId} integration=${candidate.integrationId} provider=${candidate.providerIdentifier}`;
      if (plan.action === 'WAIT_FOR_SESSION') {
        waiting++;
        console.log(`WAIT_FOR_SESSION ${prefix} code=${plan.reason}`);
        continue;
      }
      if (!options.apply) {
        console.log(`READY ${prefix}`);
        continue;
      }
      try {
        const response = await verifyThroughApi(
          options.baseUrl!,
          authToken!,
          candidate
        );
        if (response.ok) {
          fixed++;
          console.log(`FIXED ${prefix}`);
        } else {
          failed++;
          console.log(
            `FAILED ${prefix} http=${response.status} body=${JSON.stringify(
              response.body
            )}`
          );
        }
      } catch (error) {
        failed++;
        console.log(
          `FAILED ${prefix} code=${
            error instanceof Error ? error.message : 'REQUEST_FAILED'
          }`
        );
      }
    }
    console.log(
      `Summary: fixed=${fixed} waitingForSession=${waiting} skipped=${
        skipped.length + selection.unmatchedIntegrationIds.length
      } failed=${failed}`
    );
    if (!options.apply) {
      console.log('Preview complete; no verification API calls were made.');
    }
    if (failed > 0) process.exitCode = 2;
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
