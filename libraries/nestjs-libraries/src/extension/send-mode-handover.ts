import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CONTROLLED_SEND_PLATFORMS, canonicalControlledPlatform } from './controlled-platforms';
import { canonicalSendAccount, sendHash, uncertainWriterExpiredIn, releaseExpiredAccountWriterIn } from './send-coordination.utils';
import type {
  SendModeBlockers,
  SendModeTransitionState,
} from './send-mode.service';

export const TERMINAL_SEND_INTENT_STATUSES = [
  'SUCCEEDED',
  'FAILED_FINAL',
  'CANCELLED',
  'HANDED_OVER',
];
const activeExecutions = ['RESERVED', 'SENDING', 'RECONCILING'];
const isUnsupportedCompanyHandover = (
  post: { publishMethod?: string | null; providerIdentifier?: string | null },
  namespace: unknown
) => post.publishMethod === 'EXTENSION' &&
  (post.providerIdentifier === 'linkedin-page' || namespace === 'linkedin.organization_id');
export interface ControlledDrain {
  version: 1;
  targetMode: 'AUTONOMOUS';
  requestedAt: string;
  requestedByUserId: string;
  intentIds: string[];
  initialPendingCount: number;
  issues: Array<{ postId: string; code: string }>;
}
export function parseControlledDrain(raw: unknown): ControlledDrain | null {
  const value = (raw as { controlledDrain?: ControlledDrain } | null)
    ?.controlledDrain;
  if (value == null) return null;
  if (
    value.version !== 1 ||
    value.targetMode !== 'AUTONOMOUS' ||
    typeof value.requestedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.requestedAt)) ||
    typeof value.requestedByUserId !== 'string' ||
    !value.requestedByUserId ||
    value.requestedByUserId.length > 128 ||
    !Array.isArray(value.intentIds) ||
    value.intentIds.length > 5000 ||
    value.intentIds.some(
      (id) => typeof id !== 'string' || !id || id.length > 128
    ) ||
    new Set(value.intentIds).size !== value.intentIds.length ||
    !Number.isSafeInteger(value.initialPendingCount) ||
    value.initialPendingCount < value.intentIds.length ||
    !Array.isArray(value.issues) ||
    value.issues.length > 100 ||
    value.issues.some(
      (issue) =>
        !issue ||
        typeof issue.postId !== 'string' ||
        typeof issue.code !== 'string'
    )
  )
    throw new ServiceUnavailableException('SEND_MODE_CONFIGURATION_INVALID');
  return value;
}

/** Called under the organization mode lock; any execution history keeps its original route. */
export async function handoverControlledIn(
  tx: Prisma.TransactionClient,
  org: string,
  user: string
): Promise<ControlledDrain> {
  const intents = await tx.sendIntent.findMany({
    where: {
      organizationId: org,
      status: { notIn: TERMINAL_SEND_INTENT_STATUSES },
    },
    take: 5001,
  });
  const drafts = await tx.post.findMany({
    where: {
      organizationId: org,
      executionProtocol: 'ACCOUNT_BOUND_V1',
      sendIntentId: null,
      deletedAt: null,
      state: { in: ['DRAFT', 'QUEUE'] },
    },
    take: 5001,
  });
  if (intents.length + drafts.length > 5000)
    throw new ConflictException('SEND_MODE_TRANSITION_TOO_LARGE');
  const ids = intents.map((intent) => intent.id);
  const [executions, boundPosts] = await Promise.all([
    tx.sendExecution.findMany({
      where: { organizationId: org, sendIntentId: { in: ids } },
      select: { sendIntentId: true },
    }),
    tx.post.findMany({
      where: { organizationId: org, sendIntentId: { in: ids } },
    }),
  ]);
  const executed = new Set(
    executions.map((execution) => execution.sendIntentId)
  );
  const postsByIntent = new Map<string, typeof boundPosts>();
  for (const post of boundPosts) {
    const posts = postsByIntent.get(post.sendIntentId!) ?? [];
    posts.push(post);
    postsByIntent.set(post.sendIntentId!, posts);
  }
  const transfers = new Map<
    string,
    {
      integrationId: string;
      target: Prisma.JsonObject;
      intentIds: string[];
      postIds: string[];
    }
  >();
  const remaining: string[] = [];
  const issues: ControlledDrain['issues'] = [];
  const issue = (postId: string, code: string) => {
    if (issues.length < 100) issues.push({ postId, code });
  };
  for (const intent of intents) {
    const history = executed.has(intent.id);
    const posts = postsByIntent.get(intent.id) ?? [];
    const target = intent.target as {
      id?: string;
      idNamespace?: string;
    } | null;
    let reason: string | null = null;
    if (history || intent.activeExecutionId || intent.hasConfirmedSegments)
      reason = 'IN_FLIGHT';
    else if (!['DRAFT', 'QUEUED'].includes(intent.status))
      reason = 'RECONCILIATION_REQUIRED';
    else if (
      !posts.some((post) => post.id === intent.rootPostId) ||
      posts.some(
        (post) =>
          post.deletedAt ||
          post.releaseId ||
          post.releaseURL ||
          !['DRAFT', 'QUEUE'].includes(post.state)
      )
    )
      reason = 'RECONCILIATION_REQUIRED';
    else if (posts.some(post => isUnsupportedCompanyHandover(post, target?.idNamespace)))
      reason = 'HANDOVER_LINKEDIN_COMPANY_UNSUPPORTED';
    else if (
      !intent.integrationId ||
      typeof target?.id !== 'string' ||
      !target.id ||
      typeof target.idNamespace !== 'string' ||
      !target.idNamespace
    )
      reason = 'ACCOUNT_IDENTITY_UNRESOLVED';
    if (reason) {
      remaining.push(intent.id);
      if (reason !== 'IN_FLIGHT') issue(intent.rootPostId, reason);
      continue;
    }
    const key = sendHash([intent.integrationId, intent.target]);
    const transfer = transfers.get(key) ?? {
      integrationId: intent.integrationId!,
      target: intent.target as Prisma.JsonObject,
      intentIds: [],
      postIds: [],
    };
    transfer.intentIds.push(intent.id);
    transfer.postIds.push(...posts.map((post) => post.id));
    transfers.set(key, transfer);
  }
  for (const transfer of transfers.values()) {
    const updated = await tx.sendIntent.updateMany({
      where: {
        organizationId: org,
        id: { in: transfer.intentIds },
        status: { in: ['DRAFT', 'QUEUED'] },
        activeExecutionId: null,
      },
      data: { status: 'HANDED_OVER', revision: { increment: 1 } },
    });
    if (updated.count !== transfer.intentIds.length)
      throw new ConflictException('SEND_INTENT_CHANGED');
    const posts = await tx.post.updateMany({
      where: {
        organizationId: org,
        sendIntentId: { in: transfer.intentIds },
        id: { in: transfer.postIds },
        releaseId: null,
      },
      data: {
        sendIntentId: null,
        executionProtocol: 'LEGACY',
        integrationId: transfer.integrationId,
        sendTarget: { ...transfer.target, handoverMode: 'AUTONOMOUS' },
        accountSelectionMode: 'EXPLICIT',
      },
    });
    if (posts.count !== transfer.postIds.length)
      throw new ConflictException('SEND_CONTENT_CHANGED');
  }
  const integrations = await tx.integration.findMany({
    where: {
      organizationId: org,
      id: {
        in: [
          ...new Set(
            drafts
              .map((post) => post.integrationId)
              .filter((id): id is string => !!id)
          ),
        ],
      },
    },
  });
  const draftById = new Map(drafts.map((post) => [post.id, post]));
  const draftTransfers = new Map<
    string,
    { target: Prisma.JsonObject | null; ids: string[] }
  >();
  for (const post of drafts) {
    let ancestor = post;
    const seen = new Set([post.id]);
    while (
      ancestor.parentPostId &&
      draftById.has(ancestor.parentPostId) &&
      !seen.has(ancestor.parentPostId)
    ) {
      seen.add(ancestor.parentPostId);
      ancestor = draftById.get(ancestor.parentPostId)!;
    }
    if (
      post.releaseId ||
      post.releaseURL ||
      ancestor.parentPostId ||
      ancestor.releaseId ||
      ancestor.releaseURL
    ) {
      issue(post.id, 'RECONCILIATION_REQUIRED');
      continue;
    }
    const originalAccount = integrations.find(
      (account) => account.id === post.integrationId
    );
    const stored = post.sendTarget as Prisma.JsonObject | null;
    const target =
      stored &&
      typeof stored.id === 'string' &&
      typeof stored.idNamespace === 'string'
        ? stored
        : originalAccount?.internalId &&
          originalAccount.identityNamespace &&
          originalAccount.identityNamespace !== 'legacy'
        ? {
            id: originalAccount.internalId,
            idNamespace: originalAccount.identityNamespace,
          }
        : null;
    if (isUnsupportedCompanyHandover(post, target?.idNamespace)) {
      issue(post.id, 'HANDOVER_LINKEDIN_COMPANY_UNSUPPORTED');
      continue;
    }
    if (!target && (post.integrationId || post.state === 'QUEUE')) {
      issue(post.id, 'ACCOUNT_IDENTITY_UNRESOLVED');
      continue;
    }
    const key = sendHash(target);
    const transfer = draftTransfers.get(key) ?? { target, ids: [] };
    transfer.ids.push(post.id);
    draftTransfers.set(key, transfer);
  }
  for (const transfer of draftTransfers.values()) {
    const posts = await tx.post.updateMany({
      where: {
        id: { in: transfer.ids },
        organizationId: org,
        sendIntentId: null,
        releaseId: null,
      },
      data: {
        executionProtocol: 'LEGACY',
        ...(transfer.target
          ? {
              sendTarget: { ...transfer.target, handoverMode: 'AUTONOMOUS' },
            }
          : {}),
      },
    });
    if (posts.count !== transfer.ids.length)
      throw new ConflictException('SEND_CONTENT_CHANGED');
  }
  return {
    version: 1,
    targetMode: 'AUTONOMOUS',
    requestedAt: new Date().toISOString(),
    requestedByUserId: user,
    intentIds: remaining,
    initialPendingCount:
      remaining.length +
      issues.filter(
        (item) => !intents.some((intent) => intent.rootPostId === item.postId)
      ).length,
    issues,
  };
}

export async function controlledDrainStateIn(
  tx: Prisma.TransactionClient,
  org: string,
  value: ControlledDrain,
  blockers: SendModeBlockers
): Promise<SendModeTransitionState & { issues: ControlledDrain['issues'] }> {
  const pending = await tx.sendIntent.findMany({
    where: {
      organizationId: org,
      id: { in: value.intentIds },
      status: { notIn: TERMINAL_SEND_INTENT_STATUSES },
    },
  });
  const existing = await tx.sendIntent.count({
    where: { organizationId: org, id: { in: value.intentIds } },
  });
  const missing = value.intentIds.length - existing;
  const artifacts =
    blockers.activeExecutions +
    blockers.uncertainSegments +
    blockers.heldQuotaReservations +
    blockers.accountLocks;
  const remainingCount = Math.max(
    pending.length + missing + blockers.controlledPendingPosts,
    artifacts ? 1 : 0
  );
  const liveIssues = value.issues.filter(
    (issue) =>
      pending.some((intent) => intent.rootPostId === issue.postId) ||
      !value.intentIds.length ||
      blockers.controlledPendingPosts > 0
  );
  const attention =
    missing > 0 ||
    blockers.uncertainSegments > 0 ||
    liveIssues.length > 0 ||
    (remainingCount > 0 &&
      !pending.length &&
      blockers.controlledPendingPosts === 0);
  return {
    targetMode: 'AUTONOMOUS',
    status: attention ? 'NEEDS_ATTENTION' : 'DRAINING',
    requestedAt: value.requestedAt,
    requestedByUserId: value.requestedByUserId,
    initialPendingCount: Math.max(value.initialPendingCount, remainingCount),
    remainingCount,
    completedCount: Math.max(0, value.initialPendingCount - remainingCount),
    scheduledNotBefore: null,
    estimatedCompletionAt: null,
    waitReason: remainingCount
      ? attention
        ? 'RECONCILIATION_REQUIRED'
        : 'IN_FLIGHT'
      : null,
    lastCheckedAt: new Date().toISOString(),
    pendingByKind: {
      intents: pending.length,
      missing,
      activeExecutions: blockers.activeExecutions,
      uncertainSegments: blockers.uncertainSegments,
      heldQuotaReservations: blockers.heldQuotaReservations,
      accountLocks: blockers.accountLocks,
    },
    issues: liveIssues,
  };
}

/** A reverse drain authorizes only roots captured before the mode transaction committed. */
export async function controlledDrainAllowsIn(
  tx: Prisma.TransactionClient,
  org: string,
  value: ControlledDrain | null,
  reference: { rootPostId?: string; executionId?: string }
): Promise<boolean> {
  if (!value) return false;
  const execution = reference.executionId
    ? await tx.sendExecution.findFirst({
        where: { organizationId: org, id: reference.executionId },
      })
    : null;
  const intent = await tx.sendIntent.findFirst({
    where: {
      organizationId: org,
      id: { in: value.intentIds },
      ...(execution
        ? { id: execution.sendIntentId }
        : { rootPostId: reference.rootPostId ?? '' }),
      status: { notIn: TERMINAL_SEND_INTENT_STATUSES },
    },
  });
  return (
    !!intent &&
    value.intentIds.includes(intent.id) &&
    (!reference.executionId || !!execution)
  );
}

async function controlledHoldsIn(tx: Prisma.TransactionClient, org: string) {
  const uncertain = await tx.sendSegment.findMany({
    where: { organizationId: org, status: { in: ['AUTHORIZED', 'UNKNOWN'] } },
  });
  const [locks, reservations] = await Promise.all([
    tx.accountWriteState.findMany({ where: { organizationId: org, activeExecutionId: { not: null } } }),
    tx.sendQuotaReservation.findMany({ where: { organizationId: org, state: 'HELD' } }),
  ]);
  const referenced = new Set([
    ...uncertain.map(segment => segment.executionId),
    ...locks.map(lock => lock.activeExecutionId!),
    ...reservations.map(reservation => reservation.executionId),
  ]);
  const executions = await tx.sendExecution.findMany({ where: {
    organizationId: org, OR: [{ status: { in: activeExecutions } }, { id: { in: [...referenced] } }],
  } });
  const orphaned = [...referenced].some(id => !executions.some(execution => execution.id === id));
  const currentLocks = await Promise.all(locks.map(lock => releaseExpiredAccountWriterIn(tx, lock, new Date())));
  const live = [];
  for (const execution of executions) {
    const retainedWriter = currentLocks.some(lock => lock.activeExecutionId === execution.id);
    if (retainedWriter || !await uncertainWriterExpiredIn(tx, execution, new Date())) live.push(execution);
  }
  const liveIds = new Set(live.map(execution => execution.id));
  return { executions: live,
    locks: currentLocks.filter(lock => lock.activeExecutionId && liveIds.has(lock.activeExecutionId)),
    reservations: reservations.filter(reservation => liveIds.has(reservation.executionId)), orphaned };
}

/** Due discovery and final admission use the same observed account holds. */
export async function controlledBlockedPlatformsIn(tx: Prisma.TransactionClient, org: string): Promise<string[]> {
  const holds = await controlledHoldsIn(tx, org);
  if (holds.orphaned || holds.executions.some(execution => !execution.platform)) return [...CONTROLLED_SEND_PLATFORMS, 'linkedin-page'];
  const platforms = new Set(holds.executions.map(execution => canonicalControlledPlatform(execution.platform)));
  if (platforms.has('linkedin')) platforms.add('linkedin-page');
  return [...platforms];
}

/** Browser identity is unknown before dispatch, so browser admission protects the entire platform family. */
export async function assertAutonomousAccountIn(
  tx: Prisma.TransactionClient,
  org: string,
  selection: { integrationId?: string; platform?: string }
) {
  const { executions, locks, reservations, orphaned } = await controlledHoldsIn(tx, org);
  if (orphaned) throw new ConflictException('CONTROLLED_ACCOUNT_DRAIN_REQUIRED');
  const target = selection.integrationId
    ? await tx.integration.findFirst({
        where: { organizationId: org, id: selection.integrationId },
      })
    : null;
  const canonical =
    target?.internalId && target.identityNamespace
      ? canonicalSendAccount(
          org,
          target.providerIdentifier,
          target.identityNamespace,
          target.internalId
        )
      : null;
  const platform = canonicalControlledPlatform(
    selection.platform ?? target?.providerIdentifier ?? ''
  );
  for (const execution of executions) {
    if (
      !execution.platform ||
      !platform ||
      (canonical
        ? execution.canonicalAccountKey === canonical ||
          execution.integrationId === target!.id
        : canonicalControlledPlatform(execution.platform) === platform)
    )
      throw new ConflictException('CONTROLLED_ACCOUNT_DRAIN_REQUIRED');
  }
  for (const lock of locks) {
    if (canonical && lock.canonicalAccountKey === canonical)
      throw new ConflictException('CONTROLLED_ACCOUNT_DRAIN_REQUIRED');
    if (
      !executions.some((execution) => execution.id === lock.activeExecutionId)
    )
      throw new ConflictException('CONTROLLED_ACCOUNT_DRAIN_REQUIRED');
  }
  for (const reservation of reservations) {
    if (
      !executions.some((execution) => execution.id === reservation.executionId)
    )
      throw new ConflictException('CONTROLLED_ACCOUNT_DRAIN_REQUIRED');
  }
}
