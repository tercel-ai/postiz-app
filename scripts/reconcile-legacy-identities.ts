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
  userIds: string[];
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

function values(argv: string[], name: string): string[] {
  const found: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === `--${name}` && argv[index + 1]) {
      found.push(argv[++index]);
    }
  }
  return found;
}

function value(argv: string[], name: string): string | undefined {
  return values(argv, name)[0];
}

export function parseOptions(argv: string[]): CliOptions {
  const userIds = [
    ...values(argv, 'user'),
    ...values(argv, 'users').flatMap((entry) => entry.split(',')),
  ]
    .map((entry) => entry.trim())
    .filter(Boolean);
  return {
    apply: argv.includes('--apply'),
    userIds: [...new Set(userIds)],
    organizationId: value(argv, 'org'),
    baseUrl: value(argv, 'base-url') ?? process.env.NEXT_PUBLIC_BACKEND_URL,
    expectedDatabase:
      value(argv, 'expected-database') ?? DEFAULT_EXPECTED_DATABASE,
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
  --org <id>                  Limit to one organization
  --apply                     Call the verification API (default: preview only)
  --base-url <url>            Backend URL (default: NEXT_PUBLIC_BACKEND_URL)
  --expected-database <name>  Required database name (default: ${DEFAULT_EXPECTED_DATABASE})
  --help                      Show this help

Apply mode reads AISEE_AUTH_TOKEN from the environment. For users outside the
token owner's organizations, use a super-admin token; the request impersonates
each affected user and remains subject to the endpoint's ADMIN/SUPERADMIN check.`);
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
  if (!options.userIds.length) {
    usage();
    throw new Error('At least one --user or --users value is required');
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
    const users = await prisma.user.findMany({
      where: { id: { in: options.userIds } },
      select: {
        id: true,
        organizations: {
          where: {
            disabled: false,
            ...(options.organizationId
              ? { organizationId: options.organizationId }
              : {}),
          },
          select: { id: true, organizationId: true, role: true },
        },
      },
    });
    const foundUsers = new Set(users.map((user) => user.id));
    for (const userId of options.userIds) {
      if (!foundUsers.has(userId)) console.log(`MISSING_USER ${userId}`);
    }

    const organizations = new Map<
      string,
      { userId: string; membershipId: string }
    >();
    for (const user of users) {
      for (const membership of user.organizations) {
        if (!['ADMIN', 'SUPERADMIN'].includes(membership.role)) {
          console.log(
            `SKIP_NON_ADMIN user=${user.id} organization=${membership.organizationId}`
          );
          continue;
        }
        organizations.set(membership.organizationId, {
          userId: user.id,
          membershipId: membership.id,
        });
      }
    }
    const organizationIds = [...organizations.keys()];
    const integrations = organizationIds.length
      ? await prisma.integration.findMany({
          where: {
            organizationId: { in: organizationIds },
            identityNamespace: 'legacy',
            deletedAt: null,
          },
          select: {
            id: true,
            organizationId: true,
            providerIdentifier: true,
            token: true,
          },
          orderBy: [
            { organizationId: 'asc' },
            { createdAt: 'asc' },
            { id: 'asc' },
          ],
        })
      : [];
    const candidates: PreviewCandidate[] = integrations.map((integration) => ({
      userId: organizations.get(integration.organizationId)!.userId,
      membershipId: organizations.get(integration.organizationId)!.membershipId,
      organizationId: integration.organizationId,
      integrationId: integration.id,
      providerIdentifier: integration.providerIdentifier,
      token: integration.token,
    }));

    console.log(`Mode: ${options.apply ? 'APPLY' : 'PREVIEW'}`);
    console.log(`Database: ${configuredDatabase}`);
    console.log(`Users: ${options.userIds.length}`);
    console.log(`Organizations: ${organizationIds.length}`);
    console.log(`Legacy integrations: ${candidates.length}`);

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
      `Summary: fixed=${fixed} waitingForSession=${waiting} failed=${failed}`
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
