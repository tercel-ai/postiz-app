/** Read-only account clock and claim replay inspection; no platform content or credentials. */
import { parseArgs } from 'node:util';
import { recoveryDatabase } from './lib/recovery-database';

async function main() {
  const { values } = parseArgs({ options: {
    'organization-id': { type: 'string', default: 'b4314faf-59f8-48e3-a25c-145221e78239' },
    'post-id': { type: 'string', default: 'cmvued1gp0003qm95vruumn8v' },
    'request-id': { type: 'string' }, 'database-verified': { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('Usage: ts-node --project scripts/tsconfig.json scripts/diagnose-account-cooldown.ts --database-verified [--post-id id] [--request-id id]');
    return;
  }
  const connection = recoveryDatabase(values['database-verified']);
  const { PrismaClient } = await import('@prisma/client');
  const db = new PrismaClient({ datasources: { db: { url: connection.url } }, log: [] });
  try {
    const organizationId = values['organization-id']!;
    const post = await db.post.findFirst({ where: { organizationId, id: values['post-id'] },
      select: { id: true, state: true, integrationId: true, sendIntentId: true, providerIdentifier: true } });
    if (!post?.sendIntentId) throw new Error('POST_OR_SEND_INTENT_NOT_FOUND');
    const intent = await db.sendIntent.findFirst({ where: { id: post.sendIntentId, organizationId },
      select: { id: true, status: true, canonicalAccountKey: true, integrationId: true, sendOrigin: true } });
    if (!intent?.canonicalAccountKey) throw new Error('ACCOUNT_BINDING_NOT_FOUND');
    const scope = { organizationId, canonicalAccountKey: intent.canonicalAccountKey };
    const [account, executions, receipts, pacing] = await Promise.all([
      db.accountWriteState.findFirst({ where: scope, select: { integrationId: true, nextWriteNotBefore: true,
        lastConfirmedAt: true, activeExecutionId: true, rolloutReady: true, updatedAt: true } }),
      db.sendExecution.findMany({ where: scope, orderBy: { lastProgressAt: 'desc' }, take: 10,
        select: { id: true, sendIntentId: true, status: true, action: true, kind: true, gapMs: true,
          createdAt: true, lastProgressAt: true, leaseExpiresAt: true,
          intent: { select: { rootPostId: true, sendOrigin: true, projectId: true } },
          segments: { orderBy: { segmentIndex: 'asc' }, select: { segmentIndex: true, status: true, confirmedAt: true } } } }),
      values['request-id'] ? db.sendMutationReceipt.findMany({ where: { organizationId,
        requestId: values['request-id'], operation: { startsWith: 'node-send-claim:' } }, take: 10,
        select: { id: true, requestId: true, createdAt: true, result: true } }) : Promise.resolve([]),
      db.settings.findUnique({ where: { key: 'platform_pacing' }, select: { value: true } }),
    ]);
    const observedAt = new Date();
    const remainingCooldownMs = Math.max(0, (account?.nextWriteNotBefore?.getTime() ?? 0) - observedAt.getTime());
    const storedGapMs = account?.lastConfirmedAt && account.nextWriteNotBefore
      ? account.nextWriteNotBefore.getTime() - account.lastConfirmedAt.getTime() : null;
    const claims = receipts.map(row => {
      const result = row.result as { reason?: string; executionId?: string | null; status?: string } | null;
      return { id: row.id, requestId: row.requestId, createdAt: row.createdAt, reason: result?.reason,
        executionId: result?.executionId, status: result?.status,
        staleCooldownReplay: result?.reason === 'ACCOUNT_COOLDOWN_ACTIVE' && remainingCooldownMs === 0 };
    });
    console.log(JSON.stringify({ databaseTarget: connection.target, observedAt, organizationId, post,
      intent: { id: intent.id, status: intent.status, integrationId: intent.integrationId, sendOrigin: intent.sendOrigin },
      account, remainingCooldownMs, remainingCooldownMinutes: Math.ceil(remainingCooldownMs / 60_000), storedGapMs,
      recentExecutions: executions, matchingClaimReceipts: claims, platformPacing: pacing?.value ?? null,
      note: 'Claim receipt replay does not re-evaluate the account clock. No timestamps or locks were modified.' }, null, 2));
  } finally { await db.$disconnect(); }
}
main().catch(() => { console.error('Cooldown diagnostic stopped; verify the database target, post scope, and connection.'); process.exitCode = 1; });
