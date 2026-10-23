import { createHash, createHmac } from 'node:crypto';
import { ServiceUnavailableException } from '@nestjs/common';
import { AccountWriteState, Prisma, SendExecution } from '@prisma/client';

export function sendHash(value: unknown): string {
  const normalize = (v: any): any =>
    v instanceof Date
      ? v.toISOString()
      : Array.isArray(v)
      ? v.map(normalize)
      : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .filter((k) => v[k] !== undefined)
            .map((k) => [k, normalize(v[k])])
        )
      : v;
  return createHash('sha256')
    .update(JSON.stringify(normalize(value)))
    .digest('hex');
}
export const sendJson = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value));
export function sendLease(execution: {
  id: string;
  executorKey: string;
  fencingVersion: number;
  nodeCredentialVersion?: number | null;
}): string {
  const key = process.env.SEND_EXECUTION_CREDENTIAL_KEY;
  if (!key || key.length < 32)
    throw new ServiceUnavailableException(
      'SEND_EXECUTION_CREDENTIAL_KEY_REQUIRED'
    );
  return createHmac('sha256', key)
    .update(
      JSON.stringify([
        execution.id,
        execution.executorKey,
        execution.fencingVersion,
        execution.nodeCredentialVersion,
      ])
    )
    .digest('base64url');
}
export function normalizedActor(namespace: string, id: string): string {
  const value = id.trim();
  return namespace === 'reddit.user_id'
    ? value.replace(/^t2_/i, '').toLowerCase()
    : value;
}

export function sendPreflightChallenge(
  execution: Parameters<typeof sendLease>[0] & { routeRevision: number; contentRevision: number },
  index: number,
  issuedAt: Date
) {
  return createHmac('sha256', sendLease(execution))
    .update(JSON.stringify(['preflight-v1', index, execution.routeRevision,
      execution.contentRevision, issuedAt.toISOString()]))
    .digest('base64url');
}
export function canonicalSendAccount(
  org: string,
  provider: string,
  namespace: string,
  id: string
) {
  return sendHash([
    'actor-v1',
    org,
    provider,
    namespace,
    normalizedActor(namespace, id),
  ]);
}
export function matchesSendActor(
  target: { id: string; idNamespace: string },
  observed: { id: string; idNamespace: string }
) {
  return (
    !!observed &&
    !!observed.id &&
    target.idNamespace === observed.idNamespace &&
    normalizedActor(target.idNamespace, target.id) ===
      normalizedActor(observed.idNamespace, observed.id)
  );
}
export function postSendHash(post: {
  content: string;
  settings?: string | null;
  image?: string | null;
  title?: string | null;
  parentPostId?: string | null;
}) {
  return sendHash({
    content: post.content,
    settings: post.settings,
    image: post.image,
    title: post.title,
    parentPostId: post.parentPostId,
  });
}
export async function sendTransaction<T>(
  db: { $transaction: Function },
  work: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.$transaction(work, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      if (
        attempt < 3 &&
        ['P2002', 'P2034'].includes((error as { code?: string }).code ?? '')
      )
        continue;
      throw error;
    }
  }
}


/** Reconciliation fences further starts; only persisted expired permits end its writer occupancy. */
export async function uncertainWriterExpiredIn(
  tx: Prisma.TransactionClient, execution: SendExecution, now: Date
): Promise<boolean> {
  if (execution.status !== 'RECONCILING') return false;
  const segments = await tx.sendSegment.findMany({ where: {
    organizationId: execution.organizationId, executionId: execution.id,
    status: { in: ['AUTHORIZED', 'UNKNOWN'] },
  } });
  return segments.some(segment => segment.status === 'UNKNOWN') &&
    segments.every(segment => segment.submitBefore &&
      Number.isFinite(segment.submitBefore.getTime()) && segment.submitBefore <= now);
}

/** Clear only an expired reconciliation mutex, preserving the original task and held quota. */
export async function releaseExpiredAccountWriterIn(
  tx: Prisma.TransactionClient, account: AccountWriteState, now: Date
): Promise<AccountWriteState> {
  if (!account.activeExecutionId || !account.rolloutReady) return account;
  const execution = await tx.sendExecution.findFirst({ where: {
    organizationId: account.organizationId, id: account.activeExecutionId,
    canonicalAccountKey: account.canonicalAccountKey,
  } });
  if (!execution || !await uncertainWriterExpiredIn(tx, execution, now)) return account;
  const changed = await tx.accountWriteState.updateMany({ where: {
    id: account.id, organizationId: account.organizationId,
    activeExecutionId: execution.id, revision: account.revision,
  }, data: { activeExecutionId: null, revision: { increment: 1 } } });
  if (changed.count !== 1) throw Object.assign(new Error('ACCOUNT_WRITE_STATE_CHANGED'), { code: 'P2034' });
  console.log('[sending-writer] released expired reconciliation occupancy', {
    organizationId: account.organizationId, executionId: execution.id, accountId: account.id,
  });
  return { ...account, activeExecutionId: null, revision: account.revision + 1 };
}
