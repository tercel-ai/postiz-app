/**
 * Trace an X Engage reply from its saved record to browser session and receipt.
 * Run from postiz-app with --user-id, --text, --handle and optional --node-prefix.
 * Performs bounded Prisma reads against aisee_postiz_dev.
 */
import { parseArgs } from 'node:util';
import { Prisma, PrismaClient } from '@prisma/client';
import { canEditUnsentReply } from '../libraries/nestjs-libraries/src/extension/send-account-change';
import { recoveryDatabase } from './lib/recovery-database';

const platforms = ['x', 'twitter'];
const postSelect = {
  id: true, state: true, projectId: true, source: true, publishMethod: true,
  executionProtocol: true, sendIntentId: true, sendBlockCode: true,
  accountSelectionMode: true, integrationId: true, routeRevision: true,
  contentRevision: true, publishDate: true, createdAt: true, updatedAt: true,
  deletedAt: true, claimedAt: true, releaseId: true, releaseURL: true, error: true,
  bindingSource: true, bindingSourceRevision: true,
} satisfies Prisma.PostSelect;

async function main() {
  const { values } = parseArgs({ options: {
    'user-id': { type: 'string' }, text: { type: 'string' }, handle: { type: 'string' },
    'node-prefix': { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('Usage: diagnose-x-reply-availability.ts --user-id ID --text SNIPPET --handle HANDLE [--node-prefix PREFIX]');
    return;
  }
  const userId = values['user-id'];
  const snippet = values.text?.trim();
  const handle = values.handle?.replace(/^@/, '').toLowerCase();
  const nodePrefix = values['node-prefix'];
  if (!userId || !snippet || !handle) throw new Error('MISSING_USER_TEXT_OR_HANDLE');

  const connection = recoveryDatabase(true);
  if (connection.target.database !== 'aisee_postiz_dev') throw new Error('DATABASE_URL_MUST_TARGET_AISEE_POSTIZ_DEV');
  const db = new PrismaClient({ datasources: { db: { url: connection.url } }, log: [] });
  try {
    const report = await db.$transaction(async tx => {
      const memberships = await tx.userOrganization.findMany({
        where: { userId, disabled: false }, select: { organizationId: true },
      });
      const organizations = [];
      for (const { organizationId } of memberships) {
        const [replies, integrations, nodes, nearbyXPosts] = await Promise.all([
          tx.engageSentReply.findMany({
            where: { organizationId, opportunity: { platform: { in: platforms } },
              post: { content: { contains: snippet, mode: 'insensitive' } } },
            orderBy: { updatedAt: 'desc' }, take: 10,
            select: { id: true, projectId: true, createdAt: true, updatedAt: true, removedAt: true,
              opportunity: { select: { externalPostUrl: true } }, post: { select: postSelect } },
          }),
          tx.integration.findMany({
            where: { organizationId, providerIdentifier: { in: platforms }, OR: [
              { profile: { equals: handle, mode: 'insensitive' } },
              { profile: { equals: '@' + handle, mode: 'insensitive' } },
              { name: { equals: handle, mode: 'insensitive' } },
            ] },
            take: 20, select: { id: true, profile: true, internalId: true, identityNamespace: true,
              disabled: true, deletedAt: true, inBetweenSteps: true, activeSessionClient: true,
              extensionSessionCheckedAt: true },
          }),
          tx.extensionNode.findMany({
            where: { organizationId, registeredByUserId: userId,
              ...(nodePrefix ? { nodeId: { startsWith: nodePrefix } } : {}) },
            orderBy: { lastSeenAt: 'desc' }, take: 10,
            select: { id: true, nodeId: true, status: true, lastSeenAt: true,
              extensionVersion: true, protocolVersion: true,
              sessions: { where: { platform: { in: platforms } }, take: 10,
                select: { integrationId: true, verificationStatus: true, actorKey: true,
                  observedAt: true, verifiedAt: true, verificationExpiresAt: true, evidenceKind: true } } },
          }),
          tx.post.findMany({
            where: { organizationId, providerIdentifier: { in: platforms },
              source: { not: 'engage' }, parentPostId: null, deletedAt: null },
            orderBy: { updatedAt: 'desc' }, take: 5,
            select: { id: true, projectId: true, state: true, publishDate: true,
              releaseURL: true, sendBlockCode: true },
          }),
        ]);
        const ids = [...new Set([...integrations.map(i => i.id),
          ...replies.flatMap(r => r.post.integrationId ? [r.post.integrationId] : []),
          ...nodes.flatMap(n => n.sessions.flatMap(s => s.integrationId ? [s.integrationId] : []))])];
        const [storedIntents, accounts, cursors, projectAccounts, resolvedAccounts, bindings, orgBindings, mode, system] = await Promise.all([
          tx.sendIntent.findMany({
            where: { organizationId, rootPostId: { in: replies.map(r => r.post.id) } },
            include: { executions: { orderBy: { createdAt: 'desc' }, take: 101,
              include: { segments: { orderBy: { segmentIndex: 'asc' } } } } },
          }),
          tx.accountWriteState.findMany({
            where: { organizationId, integrationId: { in: ids } }, take: 20,
            select: { integrationId: true, canonicalAccountKey: true, rolloutReady: true,
              nextWriteNotBefore: true, lastConfirmedAt: true,
              activeExecution: { select: { id: true, status: true, leaseExpiresAt: true,
                sendIntentId: true, action: true } } },
          }),
          tx.sendClaimCursor.findMany({
            where: { organizationId, extensionNodeId: { in: nodes.map(n => n.id) }, action: 'REPLY' },
            select: { extensionNodeId: true, afterPublishDate: true, afterPostId: true,
              cycleStartedAt: true },
          }),
          tx.integrationProject.findMany({
            where: { organizationId, integrationId: { in: ids },
              projectId: { in: replies.flatMap(r => r.projectId ? [r.projectId] : []) } },
            take: 20, select: { projectId: true, integrationId: true, disabled: true, engageEnabled: true },
          }),
          tx.integration.findMany({
            where: { organizationId, id: { in: ids } },
            select: { id: true, profile: true, name: true, disabled: true, deletedAt: true },
          }),
          tx.projectSendBinding.findMany({
            where: { organizationId, platform: { in: platforms }, action: 'REPLY',
              projectId: { in: replies.flatMap(r => r.projectId ? [r.projectId] : []) } },
            take: 20, select: { projectId: true, integrationId: true, revision: true, updatedAt: true },
          }),
          tx.organizationSendBinding.findMany({
            where: { organizationId, platform: { in: platforms }, action: 'REPLY' },
            take: 2, select: { integrationId: true, revision: true, updatedAt: true },
          }),
          tx.settings.findUnique({ where: { key: 'sending.organization_mode:' + organizationId },
            select: { value: true } }),
          tx.settings.findUnique({ where: { key: 'sending.account_bound_enabled' },
            select: { value: true } }),
        ]);
        const intents = storedIntents.map(intent => {
          const post = replies.find(reply => reply.post.id === intent.rootPostId)!.post;
          const executions = intent.executions;
          const segments = executions.flatMap(execution => execution.segments);
          const target = intent.target as { handle?: string } | null;
          return {
            id: intent.id, rootPostId: intent.rootPostId, status: intent.status,
            action: intent.action, sendOrigin: intent.sendOrigin, integrationId: intent.integrationId,
            targetHandle: target?.handle, activeExecutionId: intent.activeExecutionId,
            hasConfirmedSegments: intent.hasConfirmedSegments,
            editEvidenceEligible: executions.length > 100 ? null : canEditUnsentReply(post, intent, executions, segments),
            executions: executions.slice(0, 10).map(execution => ({
              id: execution.id, status: execution.status, extensionNodeId: execution.extensionNodeId,
              createdAt: execution.createdAt, leaseExpiresAt: execution.leaseExpiresAt,
              lastProgressAt: execution.lastProgressAt,
              authorizationMode: (execution.context as { authorizationMode?: string } | null)?.authorizationMode,
              segments: execution.segments.map(segment => ({
                status: segment.status, segmentIndex: segment.segmentIndex,
                authorizedAt: segment.authorizedAt, submitBefore: segment.submitBefore,
                confirmedAt: segment.confirmedAt,
                resultStatus: (segment.result as { status?: string } | null)?.status,
              })),
            })),
          };
        });
        organizations.push({
          organizationId,
          configuredMode: (mode?.value as { mode?: string } | null)?.mode,
          configuredSystemEnabled: (system?.value as { enabled?: boolean } | null)?.enabled,
          replies: replies.map(({ post: { releaseId, ...post }, ...reply }) => ({
            ...reply, post: { ...post, releaseIdPresent: Boolean(releaseId) },
          })),
          intents, integrations, resolvedAccounts, nodes, accounts, projectAccounts,
          bindings, orgBindings, cursors, nearbyXPosts,
        });
      }
      return organizations;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 20000 });
    console.log(JSON.stringify({ database: connection.target.database, observedAt: new Date(), organizations: report }, null, 2));
  } finally {
    await db.$disconnect();
  }
}

void main().catch((error: unknown) => {
  const failure = error as { name?: string; code?: string; errorCode?: string };
  console.error('Diagnostic failed:', failure.name, failure.code ?? failure.errorCode ?? (failure.name === 'Error' ? (error as Error).message : undefined));
  process.exitCode = 1;
});
