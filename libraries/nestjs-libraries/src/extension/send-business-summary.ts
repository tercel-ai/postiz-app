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

const PUBLIC_UNCONFIRMED_PHASES = new Set(['AUTHORIZING', 'AUTHORIZED', 'SUBMITTING']);

/** Closed allowlist of safe public diagnostic codes for UNKNOWN segments; raw evidence never escapes. */
const PUBLIC_UNCONFIRMED_CODES = new Set([
  'SEND_RESULT_RESOURCE_UNVERIFIED',
  'SEND_RESULT_COMMENT_UNVERIFIED',
  'SEND_RESULT_UNCONFIRMED',
  'CONTROLLED_PLATFORM_SEND_UNCONFIRMED',
  'CONTROLLED_X_SEND_UNCONFIRMED',
  'SEND_RESULT_ACTOR_MISSING',
  'SEND_RESULT_ACTOR_MISMATCH',
  'SEND_RESULT_MISSING_AFTER_EXPIRY',
  'SEND_WORKER_RESTARTED',
  'SEND_UPGRADE_REQUIRED',
  'CONTROLLED_COMPOSER_NOT_READY',
  'CONTROLLED_PLATFORM_NOT_PREPARED',
  'PAGE_SEND_BUTTON_NOT_READY',
  'PAGE_SEND_CONTENT_CHANGED',
  'PAGE_SEND_CONTEXT_INVALID',
  'PAGE_SEND_PERMISSION_INVALID',
  'PAGE_SEND_COMMAND_CONSUMED',
  'PAGE_SEND_ACTOR_UNREADABLE',
  'MEDIUM_EDITOR_FOCUS_LOST',
  'CONTROLLED_MEDIUM_DRAFT_CHANGED',
  'CONTROLLED_MEDIUM_DRAFT_UNRESOLVED',
  'CONTROLLED_MEDIUM_CONTENT_CHANGED',
  'QUORA_COMMENT_PREPARATION_UNREADABLE',
  'QUORA_COMMENT_BASELINE_UNREADABLE',
  'QUORA_COMMENT_SCRIPT_RESULT_UNAVAILABLE',
  'LINKEDIN_COMPANY_UNAVAILABLE',
  'TARGET_POST_UNAVAILABLE',
  'REPLIES_DISABLED',
  'THREAD_LOCKED',
  'SEND_PERMIT_EXPIRED',
  'SEND_LEASE_EXPIRED',
  'SEND_PREPARATION_DEADLINE',
  'SEND_EXECUTION_DEADLINE_EXPIRED',
  'SEND_CLOCK_CHANGED',
  'SEND_ACTOR_CHANGED',
  'ACCOUNT_MISMATCH',
  'SESSION_ACCOUNT_MISMATCH',
  'SEND_TARGET_ACCOUNT_MISMATCH',
  'SEND_ACTOR_SESSION_UNAVAILABLE',
  'SEND_ACTOR_UNVERIFIED',
]);

function publicUnconfirmedReason(
  status: string | undefined,
  result: unknown
): { unconfirmedPhase?: string; unconfirmedCode?: string } {
  if (status !== 'UNKNOWN' || !result || typeof result !== 'object' || Array.isArray(result)) return {};
  const evidence = typeof (result as { evidence?: unknown }).evidence === 'string'
    ? (result as { evidence: string }).evidence
    : '';
  if (!evidence) return {};
  if (evidence.includes('Worker restarted; no platform submission will be replayed.')) {
    return { unconfirmedCode: 'SEND_WORKER_RESTARTED' };
  }
  const match = /\bPhase: (AUTHORIZING|AUTHORIZED|SUBMITTING); code: ([A-Z][A-Z0-9_]{1,127})\./.exec(evidence);
  if (!match) return {};
  const phase = PUBLIC_UNCONFIRMED_PHASES.has(match[1]) ? match[1] : undefined;
  const code = PUBLIC_UNCONFIRMED_CODES.has(match[2]) ? match[2] : undefined;
  return {
    ...(phase ? { unconfirmedPhase: phase } : {}),
    ...(code ? { unconfirmedCode: code } : {}),
  };
}

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
        confirmedAt: s.confirmedAt, platformId: result?.platformId ?? null, url: result?.url ?? null,
        ...publicUnconfirmedReason(s.status, s.result) };
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
