/**
 * Inspect a queued reply without claiming it or writing to the database.
 * Refuses every database except aisee_postiz_dev. Output excludes credentials
 * and reply content; all collection queries are scoped and bounded.
 *
 * Usage from the repository root:
 *   pnpm exec ts-node --project scripts/tsconfig.json scripts/diagnose-reply-claim.ts \
 *     --organization-id <organizationId> --reply-id <sentReplyId> --node-id <publicNodeId>
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { sanitizePlatformPacing } from '../libraries/nestjs-libraries/src/engage/platform-pacing-config.service';
import { resolvePacingRangeMs } from '../libraries/helpers/src/extension/platform-pacing';

async function main() {
  const { values } = parseArgs({
    options: {
      'organization-id': { type: 'string' },
      'reply-id': { type: 'string' },
      'node-id': { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(
      'Usage: diagnose-reply-claim.ts --organization-id <id> --reply-id <id> --node-id <publicNodeId>'
    );
    return;
  }
  const organizationId = values['organization-id'];
  const replyId = values['reply-id'];
  const nodeId = values['node-id'];
  if (!organizationId || !replyId || !nodeId)
    throw new Error('MISSING_ARGUMENTS');
  const envPath = resolve(__dirname, '../.env');
  const env = existsSync(envPath) ? dotenv.parse(readFileSync(envPath)) : {};
  const connection = new URL(
    process.env.DATABASE_URL || env.DATABASE_URL || ''
  );
  if (
    !['postgres:', 'postgresql:'].includes(connection.protocol) ||
    decodeURIComponent(connection.pathname.slice(1)) !== 'aisee_postiz_dev'
  )
    throw new Error('DATABASE_MUST_BE_AISEE_POSTIZ_DEV');
  connection.searchParams.set('connect_timeout', '5');
  connection.searchParams.set('pool_timeout', '5');
  const db = new PrismaClient({
    datasources: { db: { url: connection.href } },
    log: [],
  });
  try {
    const observedAt = new Date();
    const reply = await db.engageSentReply.findFirst({
      where: { id: replyId, organizationId },
      select: { id: true, postId: true },
    });
    if (!reply?.postId) throw new Error('SAVED_REPLY_NOT_FOUND');
    const post = await db.post.findFirst({
      where: { id: reply.postId, organizationId },
      select: {
        id: true,
        state: true,
        projectId: true,
        integrationId: true,
        sendIntentId: true,
        providerIdentifier: true,
        publishMethod: true,
        publishDate: true,
        createdAt: true,
        routeRevision: true,
        contentRevision: true,
        deletedAt: true,
        parentPostId: true,
      },
    });
    if (!post?.sendIntentId) throw new Error('SEND_INTENT_NOT_FOUND');
    const intent = await db.sendIntent.findFirst({
      where: { id: post.sendIntentId, organizationId },
      select: {
        id: true,
        rootPostId: true,
        status: true,
        platform: true,
        action: true,
        sendOrigin: true,
        integrationId: true,
        canonicalAccountKey: true,
        target: true,
        routeRevision: true,
        contentRevision: true,
        policySnapshot: true,
        hasConfirmedSegments: true,
        activeExecutionId: true,
      },
    });
    if (!intent?.integrationId || !intent.canonicalAccountKey)
      throw new Error('ACCOUNT_BINDING_MISSING');
    const integrationId = intent.integrationId;
    const platform = intent.platform;
    const accountScope = {
      organizationId,
      canonicalAccountKey: intent.canonicalAccountKey,
    };
    const [
      node,
      integration,
      relation,
      account,
      executions,
      confirmed,
      settings,
      config,
    ] = await Promise.all([
      db.extensionNode.findFirst({
        where: { organizationId, nodeId },
        select: {
          id: true,
          status: true,
          capabilities: true,
          lastSeenAt: true,
        },
      }),
      db.integration.findFirst({
        where: { id: integrationId, organizationId },
        select: {
          id: true,
          providerIdentifier: true,
          internalId: true,
          identityNamespace: true,
          disabled: true,
          deletedAt: true,
          inBetweenSteps: true,
        },
      }),
      db.integrationProject.findFirst({
        where: { organizationId, projectId: post.projectId, integrationId },
        select: { id: true, disabled: true, engageEnabled: true },
      }),
      db.accountWriteState.findFirst({
        where: accountScope,
        select: {
          canonicalAccountKey: true,
          rolloutReady: true,
          activeExecutionId: true,
          nextWriteNotBefore: true,
          lastConfirmedAt: true,
        },
      }),
      db.sendExecution.findMany({
        where: {
          ...accountScope,
          status: { in: ['RESERVED', 'SENDING', 'RECONCILING'] },
        },
        take: 10,
        orderBy: { lastProgressAt: 'desc' },
        select: {
          id: true,
          sendIntentId: true,
          status: true,
          leaseExpiresAt: true,
          extensionNodeId: true,
        },
      }),
      db.sendExecution.findMany({
        where: { ...accountScope, status: 'SUCCEEDED' },
        orderBy: { lastProgressAt: 'desc' },
        take: 5,
        select: {
          id: true,
          action: true,
          gapMs: true,
          lastProgressAt: true,
          intent: {
            select: { sendOrigin: true, projectId: true, rootPostId: true },
          },
          segments: {
            where: { status: 'CONFIRMED' },
            orderBy: { segmentIndex: 'desc' },
            take: 1,
            select: { segmentIndex: true, confirmedAt: true },
          },
        },
      }),
      db.settings.findMany({
        where: {
          key: {
            in: [
              'platform_pacing',
              'engage_reply_pacing',
              'extension_publish.min_gap',
            ],
          },
        },
        select: { key: true, value: true, updatedAt: true },
      }),
      db.engageConfig.findFirst({
        where: { organizationId, projectId: post.projectId },
        select: { metadata: true },
      }),
    ]);
    const snapshot = intent.policySnapshot as {
      policyOwnerUserId?: string;
    } | null;
    const [sessions, member] = await Promise.all([
      node
        ? db.extensionNodeSession.findMany({
            where: { organizationId, extensionNodeId: node.id, platform },
            take: 10,
            orderBy: { verificationExpiresAt: 'desc' },
            select: {
              integrationId: true,
              accountIdentity: true,
              verificationStatus: true,
              verificationExpiresAt: true,
              sessionRevision: true,
            },
          })
        : [],
      snapshot?.policyOwnerUserId
        ? db.userOrganization.findUnique({
            where: {
              userId_organizationId: {
                userId: snapshot.policyOwnerUserId,
                organizationId,
              },
            },
            select: { disabled: true },
          })
        : null,
    ]);
    const pacing = sanitizePlatformPacing(
      settings.find((row) => row.key === 'platform_pacing')?.value
    );
    const accountSafetyGapMs = resolvePacingRangeMs(
      pacing,
      platform,
      'write'
    )[0];
    const storedGapMs =
      account?.lastConfirmedAt && account.nextWriteNotBefore
        ? account.nextWriteNotBefore.getTime() -
          account.lastConfirmedAt.getTime()
        : null;
    const metadata = config?.metadata as {
      replyPolicies?: Record<string, unknown>;
    } | null;
    const { policySnapshot, ...safeIntent } = intent;
    console.log(
      JSON.stringify(
        {
          observedAt,
          database: 'aisee_postiz_dev',
          reply,
          post,
          intent: {
            ...safeIntent,
            policyOwnerPresent: !!snapshot?.policyOwnerUserId,
            policyOwnerMembership: member,
          },
          node,
          integration,
          relation,
          account,
          sessions,
          executions,
          confirmed,
          pacing: {
            accountSafetyGapMs,
            storedGapMs,
            remainingCooldownMs: Math.max(
              0,
              (account?.nextWriteNotBefore?.getTime() ?? 0) -
                observedAt.getTime()
            ),
            note: 'A gap above the platform floor can be valid for other operations; compare the latest confirmed execution and its origin.',
          },
          platformPacing: pacing.platforms?.[platform] ?? pacing.default,
          replyPacing: settings.find((row) => row.key === 'engage_reply_pacing')
            ?.value,
          replyPolicy: metadata?.replyPolicies?.[platform],
        },
        null,
        2
      )
    );
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  // Prisma error messages can contain connection details; expose only a safe code.
  const safeCodes = [
    'MISSING_ARGUMENTS',
    'DATABASE_MUST_BE_AISEE_POSTIZ_DEV',
    'SAVED_REPLY_NOT_FOUND',
    'SEND_INTENT_NOT_FOUND',
    'ACCOUNT_BINDING_MISSING',
  ];
  console.error(
    'Read-only diagnosis failed:',
    safeCodes.includes(error?.message)
      ? error.message
      : error?.code || error?.name || 'UNKNOWN_ERROR'
  );
  process.exitCode = 1;
});
