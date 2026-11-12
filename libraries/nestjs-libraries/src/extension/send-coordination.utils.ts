import { createHash, createHmac } from 'node:crypto';
import { ServiceUnavailableException } from '@nestjs/common';
import { AccountWriteState, Prisma, SendExecution, SendSegment } from '@prisma/client';

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
  work: (tx: Prisma.TransactionClient) => Promise<T>,
  { backoffOnConflict = false } = {}
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.$transaction(work, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (attempt >= 3 || (code !== 'P2002' && code !== 'P2034')) throw error;
      if (backoffOnConflict && code === 'P2034') {
        const delay = 25 * 2 ** attempt + Math.floor(Math.random() * 25);
        await new Promise<void>(resolve => setTimeout(resolve, delay));
      }
    }
  }
}


export const SEND_PREPARATION_LIMIT_MS = 30 * 60_000;

function expiredUnexposedPartialThread(execution: SendExecution, segments: SendSegment[], now: Date): boolean {
  return execution.kind === 'EXTENSION' && execution.leaseExpiresAt <= now &&
    execution.createdAt.getTime() + SEND_PREPARATION_LIMIT_MS <= now.getTime() &&
    segments.some(segment => segment.status === 'CONFIRMED') &&
    segments.some(segment => segment.status === 'PENDING') &&
    segments.every(segment => segment.status === 'CONFIRMED' || (segment.status === 'PENDING' &&
      !segment.authorizedAt && !segment.submitBefore && !segment.permitHash &&
      (segment.result as { status?: string } | null)?.status !== 'draft_exposed'));
}

/** Expiring app authority releases the account, never the uncertain content. */
function expiredXDraftBoundary(execution: SendExecution, segments: SendSegment[], now: Date): Date | null {
  if (execution.kind !== 'EXTENSION' || execution.platform !== 'x' || execution.leaseExpiresAt > now ||
      execution.createdAt.getTime() + SEND_PREPARATION_LIMIT_MS > now.getTime()) return null;
  const unpermitted = (segment: SendSegment) => !segment.authorizedAt && !segment.submitBefore && !segment.permitHash;
  if (!segments.some(segment => unpermitted(segment) && (segment.status === 'UNKNOWN' ||
      segment.status === 'PENDING' && (segment.result as { status?: string } | null)?.status === 'draft_exposed'))) return null;
  if (!segments.every(segment => segment.status === 'CONFIRMED' || segment.status === 'NOT_SUBMITTED' ||
      unpermitted(segment) && ['PENDING', 'UNKNOWN'].includes(segment.status) ||
      ['AUTHORIZED', 'UNKNOWN'].includes(segment.status) && segment.submitBefore &&
        Number.isFinite(segment.submitBefore.getTime()) && segment.submitBefore <= now)) return null;
  return new Date(Math.max(execution.leaseExpiresAt.getTime(), execution.createdAt.getTime() + SEND_PREPARATION_LIMIT_MS,
    ...segments.filter(segment => segment.submitBefore && Number.isFinite(segment.submitBefore.getTime())).map(segment => segment.submitBefore!.getTime())));
}

export function confirmationCooldown(account: AccountWriteState, now: Date, gapMs: number): Date {
  return new Date(Math.max(account.nextWriteNotBefore?.getTime() ?? 0, now.getTime() + gapMs));
}

function expiredPermitSegments(segments: SendSegment[], now: Date): SendSegment[] {
  if (segments.some(segment => segment.status === 'PENDING' &&
      (segment.result as { status?: string } | null)?.status === 'draft_exposed')) return [];
  const permits = segments.filter(segment => ['AUTHORIZED', 'UNKNOWN'].includes(segment.status));
  return permits.every(segment => segment.submitBefore && segment.submitBefore <= now) ? permits : [];
}

/** Reconciliation fences further starts, but may still hold a permit or an exposed draft. */
export async function uncertainWriterExpiredIn(
  tx: Prisma.TransactionClient, execution: SendExecution, now: Date
): Promise<boolean> {
  if (execution.status !== 'RECONCILING') return false;
  const segments = await tx.sendSegment.findMany({ where: {
    organizationId: execution.organizationId, executionId: execution.id,
  } });
  return !!expiredXDraftBoundary(execution, segments, now) || expiredUnexposedPartialThread(execution, segments, now) ||
    expiredPermitSegments(segments, now).some(segment => segment.status === 'UNKNOWN');
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
  if (!execution) return account;

  const expiredSender = execution.kind === 'EXTENSION' && execution.status === 'SENDING' &&
    execution.leaseExpiresAt <= now;
  if (!expiredSender && execution.status !== 'RECONCILING') return account;

  const segments = await tx.sendSegment.findMany({
    where: { organizationId: account.organizationId, executionId: execution.id },
  });
  const draftBoundary = expiredXDraftBoundary(execution, segments, now);
  const permits = draftBoundary
    ? segments.filter(segment => ['AUTHORIZED', 'UNKNOWN'].includes(segment.status) && segment.submitBefore)
    : expiredPermitSegments(segments, now);
  const interruptedThread = expiredUnexposedPartialThread(execution, segments, now);
  const unreportedPermitIds = expiredSender || draftBoundary
    ? permits.filter(segment => segment.status === 'AUTHORIZED').map(segment => segment.id) : [];
  if (expiredSender) {
    if (!interruptedThread && !draftBoundary && !unreportedPermitIds.length) return account;
    const intent = await tx.sendIntent.findFirst({
      where: { id: execution.sendIntentId, organizationId: account.organizationId,
        activeExecutionId: execution.id, fencingVersion: execution.fencingVersion, status: 'SENDING' },
      select: { id: true },
    });
    if (!intent) return account;
  } else if (!interruptedThread && !draftBoundary && !permits.some(segment => segment.status === 'UNKNOWN')) return account;
  if (draftBoundary && !expiredSender && !await tx.sendIntent.findFirst({ where: {
    id: execution.sendIntentId, organizationId: account.organizationId, activeExecutionId: execution.id,
    fencingVersion: execution.fencingVersion, status: 'RECONCILING',
  }, select: { id: true } })) return account;

  // A submit may have happened just before the permit expired, regardless of how uncertainty was recorded.
  const nextWriteNotBefore = draftBoundary ? confirmationCooldown(account, draftBoundary, execution.gapMs ?? 0) : permits.length
    ? confirmationCooldown(account, new Date(Math.max(...permits.map(segment => segment.submitBefore!.getTime()))), execution.gapMs)
    : account.nextWriteNotBefore;
  const changed = await tx.accountWriteState.updateMany({ where: {
    id: account.id, organizationId: account.organizationId,
    activeExecutionId: execution.id, revision: account.revision,
  }, data: { activeExecutionId: null, nextWriteNotBefore, revision: { increment: 1 } } });
  if (changed.count !== 1) throw Object.assign(new Error('ACCOUNT_WRITE_STATE_CHANGED'), { code: 'P2034' });
  if (draftBoundary) {
    const exposed = segments.filter(segment => segment.status === 'PENDING' &&
      (segment.result as { status?: string } | null)?.status === 'draft_exposed').map(segment => segment.id);
    if (exposed.length) await tx.sendSegment.updateMany({
      where: { id: { in: exposed }, executionId: execution.id, status: 'PENDING' },
      data: { status: 'UNKNOWN', result: sendJson({ status: 'unknown',
        evidence: 'The X draft exceeded the browser lease and preparation deadline. Account occupancy expired; publication remains unconfirmed. Code: SEND_X_DRAFT_PREPARATION_EXPIRED.',
      }) },
    });
  }
  if (unreportedPermitIds.length) {
    await tx.sendSegment.updateMany({
      where: { id: { in: unreportedPermitIds }, executionId: execution.id, status: 'AUTHORIZED' },
      data: { status: 'UNKNOWN', result: sendJson({
        status: 'unknown',
        evidence: 'The browser lease and submit permit expired before a result was reported. Phase: AUTHORIZED; code: SEND_RESULT_MISSING_AFTER_EXPIRY.',
      }) },
    });
  }
  if (expiredSender) {
    await tx.sendExecution.update({
      where: { id: execution.id }, data: { status: 'RECONCILING', lastProgressAt: now },
    });
    await tx.sendIntent.update({
      where: { id: execution.sendIntentId }, data: { status: 'RECONCILING', revision: { increment: 1 } },
    });
  }
  console.log('[sending-writer] released expired reconciliation occupancy', {
    organizationId: account.organizationId, executionId: execution.id, accountId: account.id,
  });
  return { ...account, activeExecutionId: null, nextWriteNotBefore, revision: account.revision + 1 };
}

/** Both the persisted prior-write clock and the current operation floor must elapse. */
export function accountWriteNotBefore(
  account: { nextWriteNotBefore?: Date | null; lastConfirmedAt?: Date | null },
  gapMs: number
): Date | null {
  const next = Math.max(
    account.nextWriteNotBefore?.getTime() ?? 0,
    account.lastConfirmedAt ? account.lastConfirmedAt.getTime() + gapMs : 0
  );
  return next > 0 ? new Date(next) : null;
}
