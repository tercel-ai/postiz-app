import { canChangePostAccount, canEditUnsentReply } from './send-account-change';
import { isAccountBoundSendingEnabled } from './account-bound-sending.config';
import { Post, SendIntent, SendExecution, SendSegment } from '@prisma/client';

type PublicPost = Partial<Pick<Post, 'id' | 'executionProtocol' | 'releaseId' | 'state' | 'integrationId' |
  'releaseURL' | 'claimedAt' | 'accountSelectionMode' | 'routeRevision' | 'contentRevision' | 'publishDate' | 'sendIntentId' | 'publishMethod'>>;
type PublicIntent = Partial<Pick<SendIntent, 'id' | 'status' | 'activeExecutionId' | 'hasConfirmedSegments' |
  'rootPostId' | 'target' | 'integrationId' | 'revision' | 'action' | 'routeRevision' | 'contentRevision' | 'context'>>;
type PublicExecution = Partial<Pick<SendExecution, 'id' | 'status' | 'resolutionRevision' | 'kind' | 'action' | 'context' | 'startedAt' | 'payload' | 'routeRevision' | 'contentRevision'>>;
type PublicSegment = Partial<Pick<SendSegment, 'executionId' | 'status' | 'result' | 'segmentIndex' | 'postId' | 'confirmedAt' | 'authorizedAt' | 'permitHash' | 'submitBefore' | 'contentHash'>>;

export const needsSendSummary = (post: PublicPost, controlled = false) => controlled ||
  post?.executionProtocol === 'ACCOUNT_BOUND_V1' || !!post?.sendIntentId;

export type SendActionDecision = { allowed: boolean; reason: string | null };

/** Public projection only: execution credentials and raw evidence must never escape. */
export function sendBusinessSummary(post: PublicPost, intent: PublicIntent | null, executions: PublicExecution[], segments: PublicSegment[], operationBlockCode: string | null = null, enabled = isAccountBoundSendingEnabled(), continuingExecution = false, queuedReplyEnqueue?: SendActionDecision) {
  const controlled = !!intent || post.executionProtocol === 'ACCOUNT_BOUND_V1';
  const currentExecutions = executions.filter(e => e.status !== 'RETRY_REQUESTED');
  const supersededIds = new Set(executions.filter(e => e.status === 'RETRY_REQUESTED').map(e => e.id));
  const currentSegments = segments.filter(s => !supersededIds.has(s.executionId));
  const latest = currentExecutions.find(e => e.id === intent?.activeExecutionId) ?? currentExecutions[0];
  const confirmed = intent?.hasConfirmedSegments === true || segments.some(s => s.status === 'CONFIRMED');
  const uncertain = currentSegments.some(s => s.status === 'UNKNOWN') || intent?.status === 'RECONCILING';
  const retrySafe = !!intent && intent.status === 'FAILED_FINAL' && !intent.activeExecutionId && !confirmed &&
    !uncertain && !currentSegments.some(s => s.status === 'AUTHORIZED') &&
    !executions.some(e => ['RESERVED', 'SENDING', 'RECONCILING'].includes(e.status));
  const rescheduleSafe = !!intent?.id && intent.action === 'POST' && post.publishMethod === 'EXTENSION' && post.state === 'QUEUE' && post.sendIntentId === intent.id &&
    intent.status === 'QUEUED' && !intent.activeExecutionId && !confirmed && !uncertain &&
    executions.every(execution => ['FAILED_FINAL', 'CANCELLED', 'EXPIRED'].includes(execution.status ?? '')) &&
    segments.every(segment => segment.status === 'NOT_SUBMITTED');
  const accountChangeSafe = intent?.action === 'REPLY' ? canEditUnsentReply(post, intent, executions, segments) : canChangePostAccount(post, intent, executions, segments);
  const frozen = !!intent || !!post.releaseId || post.state !== 'DRAFT';
  // Enqueueing an unclaimed saved reply is not editing its frozen account selection.
  const enqueueable = !intent && !post.sendIntentId && !post.releaseId &&
    (post.state === 'DRAFT' || (post.state === 'QUEUE' && queuedReplyEnqueue?.allowed === true));
  const actionable = enabled && !operationBlockCode;
  const decision = (allowed: boolean, reason: string) => ({ allowed, reason: allowed ? null : reason });
  const actor = intent?.target as { id?: string; idNamespace?: string; handle?: string } | null;
  return {
    protocol: controlled || enabled ? 'ACCOUNT_BOUND_V1' : 'LEGACY',
    paused: (controlled || enabled) && !enabled && !continuingExecution,
    rootPostId: post.id,
    sendIntentId: intent?.id ?? null,
    intentStatus: intent?.status ?? null,
    status: post.state === 'DRAFT' && intent?.status === 'CANCELLED' && accountChangeSafe ? 'DRAFT' : uncertain ? 'RECONCILING' : confirmed && intent?.status !== 'SUCCEEDED' ? 'PARTIAL_SUCCESS' : intent?.status ?? post.state,
    integrationId: intent?.integrationId ?? post.integrationId ?? null,
    accountSelectionMode: post.accountSelectionMode,
    routeRevision: post.routeRevision,
    contentRevision: post.contentRevision,
    intentRevision: intent?.revision ?? null,
    publishDate: post.publishDate,
    hasConfirmedSegments: confirmed,
    targetAccount: actor ? { id: actor.id, idNamespace: actor.idNamespace, ...(actor.handle ? { handle: actor.handle } : {}) } : null,
    execution: latest ? { id: latest.id, status: latest.status, resolutionRevision: latest.resolutionRevision } : null,
    segments: segments.filter(s => s.executionId === latest?.id).map(s => {
      const result = s.result as { platformId?: string; url?: string } | null;
      return { segmentIndex: s.segmentIndex, postId: s.postId, status: s.status,
        confirmedAt: s.confirmedAt, platformId: result?.platformId ?? null, url: result?.url ?? null };
    }),
    allowedActions: {
      edit: decision(actionable && (!frozen || accountChangeSafe), operationBlockCode ?? 'SEND_EDIT_UNSAFE'),
      enqueue: decision(actionable && enqueueable, operationBlockCode ?? (intent ? 'SEND_INTENT_IMMUTABLE' : !enabled ? 'ACCOUNT_BINDINGS_NOT_ENABLED' : queuedReplyEnqueue?.reason ?? 'CONTENT_NOT_ENQUEUEABLE')),
      selectAccount: decision(actionable && (!frozen || accountChangeSafe), operationBlockCode ?? (intent ? 'SEND_INTENT_IMMUTABLE' : !enabled ? 'ACCOUNT_BINDINGS_NOT_ENABLED' : 'CONTENT_NOT_ENQUEUEABLE')),
      reschedule: decision(actionable && rescheduleSafe, operationBlockCode ?? (intent ? 'SEND_INTENT_REQUIRES_CONTROLLED_RESCHEDULE' : 'CONTROLLED_RESCHEDULE_NOT_SUPPORTED')),
      retry: decision(actionable && retrySafe, operationBlockCode ?? (!enabled ? 'ACCOUNT_BINDINGS_NOT_ENABLED' : 'SEND_RETRY_UNSAFE')),
    },
  };
}
