import type { Post, SendIntent, SendExecution, SendSegment } from '@prisma/client';

type PostScope = Partial<Pick<Post, 'id' | 'state' | 'publishMethod' | 'sendIntentId' | 'releaseId' | 'releaseURL' | 'claimedAt' | 'routeRevision' | 'contentRevision'>>;
type IntentScope = Partial<Pick<SendIntent, 'id' | 'rootPostId' | 'action' | 'status' | 'activeExecutionId' | 'hasConfirmedSegments' | 'routeRevision' | 'contentRevision' | 'context'>>;
type ExecutionScope = Partial<Pick<SendExecution, 'id' | 'status' | 'kind' | 'action' | 'context' | 'startedAt' | 'payload' | 'routeRevision' | 'contentRevision'>>;
type SegmentScope = Partial<Pick<SendSegment, 'executionId' | 'status' | 'result' | 'authorizedAt' | 'permitHash' | 'submitBefore' | 'confirmedAt' | 'segmentIndex' | 'postId' | 'contentHash'>>;

export const ACCOUNT_CHANGE_CANCELLATION = 'account_change_before_native';

function hasUnpermittedStop(segment: SegmentScope): boolean {
  const result = segment.result as { status?: string; stopped?: boolean; evidence?: string } | null;
  if (segment.status !== 'NOT_SUBMITTED' || result?.status !== 'definitely_not_submitted' || result.stopped !== true || typeof result.evidence !== 'string') return false;
  try {
    const proof = JSON.parse(result.evidence);
    return proof.permitHash === '' && proof.noPendingSubmit === true &&
      ['PREPARED', 'CANCELLED_BEFORE_SUBMIT'].includes(proof.lastPhase) &&
      /^[a-f0-9]{64}$/.test(proof.journalDigest ?? '') && Number.isFinite(Date.parse(proof.executorStoppedAt));
  } catch { return false; }
}

export function isAccountChangeRevokedExecution(execution: ExecutionScope): boolean {
  const context = execution.context as { accountChangeRevocation?: { reason?: string } } | null;
  return context?.accountChangeRevocation?.reason === ACCOUNT_CHANGE_CANCELLATION;
}

/** Shared permission for the public summary and the transactional account mutation. */
function canEditUnsentContent(post: PostScope, intent: IntentScope | null, executions: ExecutionScope[], segments: SegmentScope[], action: 'POST' | 'REPLY'): boolean {
  const dormant = post.state === 'DRAFT' && intent?.status === 'CANCELLED' && (intent.context as {editableDraft?:boolean}|null)?.editableDraft === true;
  if (!intent?.id || intent.action !== action || (!dormant && !['QUEUE', 'ERROR'].includes(post.state ?? '')) || !['EXTENSION','API'].includes(post.publishMethod ?? '') ||
      post.sendIntentId !== intent.id || post.id !== intent.rootPostId || post.routeRevision !== intent.routeRevision || post.contentRevision !== intent.contentRevision || post.releaseId || post.releaseURL || post.claimedAt || intent.hasConfirmedSegments ||
      (!dormant && !['QUEUED', 'RESERVED', 'FAILED_FINAL'].includes(intent.status ?? '')) ||
      (post.state === 'ERROR' && intent.status !== 'FAILED_FINAL') ||
      (intent.status === 'FAILED_FINAL' && (post.state !== 'ERROR' || !!intent.activeExecutionId)) ||
      (intent.status === 'RESERVED' && !intent.activeExecutionId)) return false;
  if (intent.activeExecutionId && !executions.some(execution => execution.id === intent.activeExecutionId && execution.status === 'RESERVED')) return false;
  if (!executions.length) return (dormant || intent.status === 'QUEUED') && !intent.activeExecutionId && segments.length === 0;
  if (segments.some(segment => !executions.some(execution => execution.id === segment.executionId))) return false;
  return executions.every(execution => {
    const context = execution.context as { authorizationMode?: string } | null;
    const revoked = isAccountChangeRevokedExecution(execution);
    if (!execution.id || execution.kind !== 'EXTENSION' || execution.action !== action || execution.startedAt || context?.authorizationMode !== 'NATIVE_FLOW_V1' ||
        (revoked ? execution.status !== 'CANCELLED' : !['RESERVED', 'EXPIRED', 'FAILED_FINAL'].includes(execution.status ?? '') ||
          execution.routeRevision !== intent.routeRevision || execution.contentRevision !== intent.contentRevision)) return false;
    const rows = segments.filter(segment => segment.executionId === execution.id).sort((a,b) => (a.segmentIndex ?? -1) - (b.segmentIndex ?? -1));
    const payload = execution.payload as Array<{ id?: string; contentHash?: string }> | null;
    const failed = execution.status === 'FAILED_FINAL';
    if (failed && !rows.some(hasUnpermittedStop)) return false;
    return Array.isArray(payload) && payload.length > 0 && rows.length === payload.length && rows[0]?.postId === post.id &&
      rows.every((segment,index) => segment.segmentIndex === index && segment.postId === payload[index]?.id &&
        !!segment.contentHash && segment.contentHash === payload[index]?.contentHash &&
        !segment.authorizedAt && !segment.permitHash && !segment.submitBefore && !segment.confirmedAt &&
        (revoked ? segment.status === 'NOT_SUBMITTED' && ((segment.result as { status?: string } | null)?.status === ACCOUNT_CHANGE_CANCELLATION || hasUnpermittedStop(segment))
          : (failed && hasUnpermittedStop(segment)) || (segment.status === 'PENDING' && segment.result == null)));
  });
}

export function canChangePostAccount(post: PostScope, intent: IntentScope | null, executions: ExecutionScope[], segments: SegmentScope[]): boolean {
  return canEditUnsentContent(post, intent, executions, segments, 'POST');
}

export function canEditUnsentReply(post: PostScope, intent: IntentScope | null, executions: ExecutionScope[], segments: SegmentScope[]): boolean {
  return canEditUnsentContent(post, intent, executions, segments, 'REPLY');
}
