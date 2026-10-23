import { isAccountBoundSendingEnabled } from './account-bound-sending.config';
import { Post, SendIntent, SendExecution, SendSegment } from '@prisma/client';

type PublicPost = Partial<Pick<Post, 'id' | 'executionProtocol' | 'releaseId' | 'state' | 'integrationId' |
  'accountSelectionMode' | 'routeRevision' | 'contentRevision' | 'publishDate' | 'sendIntentId'>>;
type PublicIntent = Partial<Pick<SendIntent, 'id' | 'status' | 'activeExecutionId' | 'hasConfirmedSegments' |
  'target' | 'integrationId' | 'revision'>>;
type PublicExecution = Partial<Pick<SendExecution, 'id' | 'status' | 'resolutionRevision'>>;
type PublicSegment = Partial<Pick<SendSegment, 'executionId' | 'status' | 'result' | 'segmentIndex' | 'postId' | 'confirmedAt'>>;

export const needsSendSummary = (post: PublicPost, controlled = false) => controlled ||
  post?.executionProtocol === 'ACCOUNT_BOUND_V1' || !!post?.sendIntentId;

/** Public projection only: execution credentials and raw evidence must never escape. */
export function sendBusinessSummary(post: PublicPost, intent: PublicIntent | null, executions: PublicExecution[], segments: PublicSegment[], operationBlockCode: string | null = null, enabled = isAccountBoundSendingEnabled(), continuingExecution = false) {
  const controlled = !!intent || post.executionProtocol === 'ACCOUNT_BOUND_V1';
  const latest = executions.find(e => e.id === intent?.activeExecutionId) ?? executions[0];
  const confirmed = intent?.hasConfirmedSegments === true || segments.some(s => s.status === 'CONFIRMED');
  const uncertain = segments.some(s => s.status === 'UNKNOWN') || intent?.status === 'RECONCILING';
  const retrySafe = !!intent && intent.status === 'FAILED_FINAL' && !intent.activeExecutionId && !confirmed &&
    !uncertain && !segments.some(s => s.status === 'AUTHORIZED') &&
    !executions.some(e => ['RESERVED', 'SENDING', 'RECONCILING'].includes(e.status));
  const frozen = !!intent || !!post.releaseId || post.state !== 'DRAFT';
  const actionable = enabled && !operationBlockCode;
  const decision = (allowed: boolean, reason: string) => ({ allowed, reason: allowed ? null : reason });
  const actor = intent?.target as { id?: string; idNamespace?: string; handle?: string } | null;
  return {
    protocol: controlled || enabled ? 'ACCOUNT_BOUND_V1' : 'LEGACY',
    paused: (controlled || enabled) && !enabled && !continuingExecution,
    rootPostId: post.id,
    sendIntentId: intent?.id ?? null,
    intentStatus: intent?.status ?? null,
    status: uncertain ? 'RECONCILING' : confirmed && intent?.status !== 'SUCCEEDED' ? 'PARTIAL_SUCCESS' : intent?.status ?? post.state,
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
      enqueue: decision(actionable && !frozen, operationBlockCode ?? (intent ? 'SEND_INTENT_IMMUTABLE' : !enabled ? 'ACCOUNT_BINDINGS_NOT_ENABLED' : 'CONTENT_NOT_ENQUEUEABLE')),
      selectAccount: decision(actionable && !frozen, operationBlockCode ?? (intent ? 'SEND_INTENT_IMMUTABLE' : !enabled ? 'ACCOUNT_BINDINGS_NOT_ENABLED' : 'CONTENT_NOT_ENQUEUEABLE')),
      reschedule: decision(false, intent ? 'SEND_INTENT_REQUIRES_CONTROLLED_RESCHEDULE' : 'CONTROLLED_RESCHEDULE_NOT_SUPPORTED'),
      retry: decision(actionable && retrySafe, operationBlockCode ?? (!enabled ? 'ACCOUNT_BINDINGS_NOT_ENABLED' : 'SEND_RETRY_UNSAFE')),
    },
  };
}
