/**
 * Diagnose account leakage or unexpected account visibility in sending-context.
 *
 * This script is strictly read-only. It only uses Prisma findMany queries and
 * refuses to run unless DATABASE_URL targets aisee_postiz_dev.
 *
 * Usage:
 *   pnpm exec ts-node scripts/diagnose-sending-context.ts \
 *     <firstUserId> <secondUserId> [firstProjectId] [secondProjectId]
 */

import { createHash } from 'node:crypto';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';

dotenv.config();

const EXPECTED_DATABASE = 'aisee_postiz_dev';
const CONTROLLED_PROVIDERS = [
  'x',
  'reddit',
  'linkedin',
  'linkedin-page',
  'medium',
  'quora',
  'hackernews',
  'devto',
];

type UserTarget = {
  userId: string;
  projectId?: string;
};

function databaseName(databaseUrl: string | undefined): string | null {
  if (!databaseUrl) return null;
  try {
    return decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ''));
  } catch {
    return null;
  }
}

function identityFingerprint(provider: string, namespace: string, internalId: string): string {
  return createHash('sha256')
    .update(`${provider}\0${namespace}\0${internalId}`)
    .digest('hex')
    .slice(0, 12);
}

function iso(value: Date | null | undefined): string {
  return value?.toISOString() ?? '-';
}

function usage(): never {
  console.error(
    'Usage: pnpm exec ts-node scripts/diagnose-sending-context.ts ' +
      '<firstUserId> <secondUserId> [firstProjectId] [secondProjectId]'
  );
  process.exit(1);
}

async function main() {
  const [firstUserId, secondUserId, firstProjectId, secondProjectId] = process.argv.slice(2);
  if (!firstUserId || !secondUserId) usage();

  const configuredDatabase = databaseName(process.env.DATABASE_URL);
  if (configuredDatabase !== EXPECTED_DATABASE) {
    throw new Error(
      `Refusing to run: expected database ${EXPECTED_DATABASE}, got ${configuredDatabase ?? 'unknown'}`
    );
  }

  const targets: UserTarget[] = [
    { userId: firstUserId, projectId: firstProjectId },
    { userId: secondUserId, projectId: secondProjectId },
  ];
  const userIds = targets.map((target) => target.userId);
  const projectIds = targets.flatMap((target) => (target.projectId ? [target.projectId] : []));
  const prisma = new PrismaClient();

  try {
    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: {
        id: true,
        email: true,
        activated: true,
        createdAt: true,
        organizations: {
          select: {
            organizationId: true,
            role: true,
            disabled: true,
            createdAt: true,
            organization: { select: { name: true } },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    const organizationIds = [
      ...new Set(users.flatMap((user) => user.organizations.map((membership) => membership.organizationId))),
    ];
    const organizations = organizationIds.length
      ? await prisma.organization.findMany({
          where: { id: { in: organizationIds } },
          select: {
            id: true,
            name: true,
            users: {
              select: {
                userId: true,
                role: true,
                disabled: true,
                createdAt: true,
              },
              orderBy: { createdAt: 'asc' },
            },
          },
          orderBy: { createdAt: 'asc' },
        })
      : [];
    const integrations = organizationIds.length
      ? await prisma.integration.findMany({
          where: {
            organizationId: { in: organizationIds },
            providerIdentifier: { in: CONTROLLED_PROVIDERS },
          },
          select: {
            id: true,
            organizationId: true,
            providerIdentifier: true,
            identityNamespace: true,
            internalId: true,
            name: true,
            profile: true,
            disabled: true,
            deletedAt: true,
            createdAt: true,
            updatedAt: true,
            metadata: true,
            integrationProjects: {
              where: projectIds.length ? { projectId: { in: projectIds } } : undefined,
              select: {
                projectId: true,
                organizationId: true,
                disabled: true,
                engageEnabled: true,
                createdAt: true,
              },
              orderBy: { createdAt: 'asc' },
            },
          },
          orderBy: [{ organizationId: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        })
      : [];

    const nodes = organizationIds.length
      ? await prisma.extensionNode.findMany({
          where: { organizationId: { in: organizationIds } },
          select: {
            id: true,
            organizationId: true,
            registeredByUserId: true,
            nodeId: true,
            name: true,
            browser: true,
            status: true,
            protocolVersion: true,
            extensionVersion: true,
            capabilities: true,
            lastReportSequence: true,
            createdAt: true,
            lastSeenAt: true,
            sessions: {
              select: {
                id: true,
                platform: true,
                actorKey: true,
                integrationId: true,
                accountIdentity: true,
                verificationStatus: true,
                sessionRevision: true,
                evidenceKind: true,
                probeId: true,
                identityObservedAt: true,
                observedAt: true,
                receivedAt: true,
                verifiedAt: true,
                verificationExpiresAt: true,
              },
              orderBy: [{ platform: 'asc' }, { id: 'asc' }],
            },
          },
          orderBy: [{ organizationId: 'asc' }, { createdAt: 'asc' }],
        })
      : [];

    console.log(`Database: ${configuredDatabase}`);
    console.log(`Users found: ${users.length}/${userIds.length}`);

    for (const target of targets) {
      const user = users.find((candidate) => candidate.id === target.userId);
      console.log(`\n=== User ${target.userId} ===`);
      if (!user) {
        console.log('User not found.');
        continue;
      }
      console.log(`Email: ${user.email}`);
      console.log(`Activated: ${user.activated}`);
      console.log(`Created: ${iso(user.createdAt)}`);
      console.log(`Requested project: ${target.projectId ?? '-'}`);
      console.log('Memberships:');
      for (const membership of user.organizations) {
        console.log(
          `  ${membership.organizationId} | ${membership.organization.name} | ` +
            `role=${membership.role} | disabled=${membership.disabled} | joined=${iso(membership.createdAt)}`
        );
      }
    }

    console.log('\n=== Organization to user membership ===');
    for (const organization of organizations) {
      console.log(`\n${organization.id} | ${organization.name}`);
      for (const membership of organization.users) {
        console.log(
          `  user=${membership.userId} | role=${membership.role} | ` +
            `disabled=${membership.disabled} | joined=${iso(membership.createdAt)}`
        );
      }
    }

    console.log('\n=== Controlled integrations by organization ===');
    for (const organizationId of organizationIds) {
      console.log(`\nOrganization ${organizationId}`);
      const rows = integrations.filter((integration) => integration.organizationId === organizationId);
      for (const row of rows) {
        const metadata =
          row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
            ? (row.metadata as Record<string, unknown>)
            : {};
        const stableIdentity =
          metadata.stableIdentity &&
          typeof metadata.stableIdentity === 'object' &&
          !Array.isArray(metadata.stableIdentity)
            ? (metadata.stableIdentity as Record<string, unknown>)
            : {};
        const credentialSource = String(metadata.credentialSource ?? '-');
        const identitySource = String(stableIdentity.source ?? '-');
        const fingerprint = identityFingerprint(
          row.providerIdentifier,
          row.identityNamespace,
          row.internalId
        );
        const relations = row.integrationProjects.length
          ? row.integrationProjects
              .map(
                (relation) =>
                  `${relation.projectId}(disabled=${relation.disabled},engage=${relation.engageEnabled})`
              )
              .join(',')
          : '-';
        console.log(
          `  ${row.id} | ${row.providerIdentifier} | ${row.profile ?? row.name} | ` +
            `identity=${fingerprint} | disabled=${row.disabled} | deleted=${iso(row.deletedAt)} | ` +
            `created=${iso(row.createdAt)} | source=${credentialSource}/${identitySource} | projects=${relations}`
        );
      }
    }

    const byStableIdentity = new Map<string, typeof integrations>();
    const byHandle = new Map<string, typeof integrations>();
    for (const integration of integrations.filter((row) => !row.deletedAt)) {
      const stableKey = `${integration.providerIdentifier}\0${integration.identityNamespace}\0${integration.internalId}`;
      byStableIdentity.set(stableKey, [...(byStableIdentity.get(stableKey) ?? []), integration]);
      const handle = integration.profile?.trim().toLocaleLowerCase();
      if (handle) {
        const handleKey = `${integration.providerIdentifier}\0${handle}`;
        byHandle.set(handleKey, [...(byHandle.get(handleKey) ?? []), integration]);
      }
    }

    const spansOrganizations = (rows: typeof integrations) =>
      new Set(rows.map((row) => row.organizationId)).size > 1;
    const stableDuplicates = [...byStableIdentity.values()].filter(spansOrganizations);
    const handleDuplicates = [...byHandle.values()].filter(spansOrganizations);

    console.log('\n=== Cross-organization duplicate identities ===');
    if (!stableDuplicates.length) console.log('None.');
    for (const rows of stableDuplicates) {
      const sample = rows[0];
      console.log(
        `  ${sample.providerIdentifier}/${sample.profile ?? sample.name} | ` +
          `identity=${identityFingerprint(sample.providerIdentifier, sample.identityNamespace, sample.internalId)}`
      );
      for (const row of rows) console.log(`    ${row.organizationId} -> ${row.id}`);
    }

    console.log('\n=== Cross-organization duplicate handles ===');
    if (!handleDuplicates.length) console.log('None.');
    for (const rows of handleDuplicates) {
      const sample = rows[0];
      console.log(`  ${sample.providerIdentifier}/${sample.profile}`);
      for (const row of rows) {
        console.log(
          `    ${row.organizationId} -> ${row.id} ` +
            `(identity=${identityFingerprint(row.providerIdentifier, row.identityNamespace, row.internalId)})`
        );
      }
    }

    console.log('\n=== Extension nodes and session links ===');
    for (const node of nodes) {
      const capabilities =
        node.capabilities && typeof node.capabilities === 'object' && !Array.isArray(node.capabilities)
          ? (node.capabilities as Record<string, unknown>)
          : {};
      console.log(
        `\n  ${node.id} | org=${node.organizationId} | user=${node.registeredByUserId} | ` +
          `${node.browser}/${node.name} | status=${node.status} | protocol=${node.protocolVersion} | ` +
          `extension=${node.extensionVersion ?? '-'} | reportSequence=${node.lastReportSequence} | ` +
          `lastSeen=${iso(node.lastSeenAt)}`
      );
      console.log(`    capabilities=${JSON.stringify(capabilities)}`);
      for (const session of node.sessions) {
        const identity =
          session.accountIdentity &&
          typeof session.accountIdentity === 'object' &&
          !Array.isArray(session.accountIdentity)
            ? (session.accountIdentity as Record<string, unknown>)
            : {};
        console.log(
          `    ${session.platform} | handle=${String(identity.handle ?? identity.id ?? '-')} | ` +
            `namespace=${String(identity.namespace ?? '-')} | actorKey=${session.actorKey || '-'} | ` +
            `integration=${session.integrationId ?? '-'} | verification=${session.verificationStatus} | ` +
            `revision=${session.sessionRevision} | evidence=${session.evidenceKind} | ` +
            `probe=${session.probeId ?? '-'} | identityObserved=${iso(session.identityObservedAt)} | ` +
            `observed=${iso(session.observedAt)} | received=${iso(session.receivedAt)} | ` +
            `verified=${iso(session.verifiedAt)} | expires=${iso(session.verificationExpiresAt)}`
        );
      }
    }

    console.log('\n=== Interpretation ===');
    console.log(
      'Integration has no userId column. sending-context intentionally reads every active integration in the authenticated organization.'
    );
    console.log(
      'If an unexpected account appears above under the second organization, the endpoint is returning stored organization data; it is not copying the first response at request time.'
    );
    console.log(
      'Matching identity fingerprints across organizations prove that the same social identity was connected to both organizations. Matching handles with different fingerprints are only a review signal.'
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
