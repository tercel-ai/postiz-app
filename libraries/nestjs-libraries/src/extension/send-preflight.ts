import { ConflictException } from '@nestjs/common';
import { ExtensionNode, Prisma } from '@prisma/client';
import {
  AccountObservation,
  SessionReading,
  LIVE_EVIDENCE,
} from './extension-node.protocol';
import { matchesSendActor, sendHash } from './send-coordination.utils';

export async function confirmSendPreflight(
  tx: Prisma.TransactionClient,
  node: ExtensionNode,
  observation: AccountObservation & { preflightChallenge?: string },
  session: SessionReading,
  previousProbe: string | null | undefined,
  now: Date
) {
  if (!observation.preflightChallenge) return;
  const segment = await tx.sendSegment.findFirst({
    where: {
      organizationId: node.organizationId,
      challengeHash: sendHash(observation.preflightChallenge),
      status: 'PENDING',
    },
  });
  if (!segment) throw new ConflictException('SEND_PREFLIGHT_CHALLENGE_INVALID');
  const execution = await tx.sendExecution.findUniqueOrThrow({
    where: { id: segment.executionId },
  });
  const at = new Date(observation.identityObservedAt ?? '');
  if (
    (observation.identityNamespace === 'linkedin.organization_id' &&
      (observation.actorContext !== 'COMPOSER' || observation.evidenceKind !== 'LIVE_PAGE_ACTOR')) ||
    execution.extensionNodeId !== node.id ||
    execution.nodeCredentialVersion !== node.credentialVersion ||
    execution.platform !== observation.platform ||
    session.integrationId !== execution.integrationId ||
    session.verificationStatus !== 'VERIFIED' ||
    !LIVE_EVIDENCE.includes(observation.evidenceKind as any) ||
    !observation.probeId ||
    observation.probeId === previousProbe ||
    !Number.isFinite(at.getTime()) ||
    at > now ||
    now.getTime() - at.getTime() > 30_000 ||
    !segment.challengeIssuedAt ||
    at < segment.challengeIssuedAt ||
    !segment.challengeExpiresAt ||
    segment.challengeExpiresAt <= now ||
    !matchesSendActor(execution.target as any, {
      id: observation.id!,
      idNamespace: observation.identityNamespace!,
    })
  )
    throw new ConflictException('SEND_PREFLIGHT_EVIDENCE_INVALID');
  const intent = await tx.sendIntent.findUniqueOrThrow({
    where: { id: execution.sendIntentId },
  });
  if (
    intent.activeExecutionId !== execution.id ||
    intent.fencingVersion !== execution.fencingVersion
  )
    throw new ConflictException('STALE_SEND_EXECUTION');
  await tx.sendSegment.update({
    where: { id: segment.id },
    data: {
      evidenceSessionRevision: session.sessionRevision,
      evidenceObservedAt: at,
      probeId: observation.probeId,
    },
  });
}
