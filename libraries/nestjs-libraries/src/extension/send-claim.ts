import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma, SendExecution } from '@prisma/client';
import { PrismaService } from '../database/prisma/prisma.service';
import { ExtensionNodeService } from './extension-node.service';
import { SendCoordinatorService } from './send-coordinator.service';
import type { NodeAuthentication } from './send-execution.service';
import { canonicalControlledPlatform } from './controlled-platforms';
import { hashSecret } from './extension-node.protocol';
import { sendHash, sendLease, sendTransaction } from './send-coordination.utils';

type Claim = { requestId: string; action: 'POST' | 'REPLY'; rootPostId?: string };
type Position = { publishDate: Date; id: string };
const PAGE_SIZE = 25;
const SCAN_LIMIT = 100;

export async function claimControlledSend<T>(
  db: PrismaService,
  nodes: ExtensionNodeService,
  sends: SendCoordinatorService,
  auth: NodeAuthentication,
  body: Claim,
  response: (execution: SendExecution, nodeId: string) => T
): Promise<{ items: T[]; reason?: string; executionId?: string; status?: string }> {
  await sends.enabled(auth.org);
  if (!body.requestId?.trim() || body.requestId.length > 128 || !['POST', 'REPLY'].includes(body.action))
    throw new BadRequestException('INVALID_SEND_CLAIM');
  const fingerprint = sendHash(body);
  const keyFor = (node: { id: string }) => ({
    organizationId: auth.org, userId: auth.user,
    operation: `node-send-claim:${node.id}`, requestId: body.requestId,
  });
  const replayIn = async (tx: Prisma.TransactionClient, node: { id: string; nodeId: string; credentialVersion: number }) => {
    const receipt = await tx.sendMutationReceipt.findUnique({
      where: { organizationId_userId_operation_requestId: keyFor(node) },
    });
    const original = receipt
      ? (receipt.result as { executionId: string | null }).executionId
        ? await sends.execution(tx, auth.org, (receipt.result as { executionId: string }).executionId)
        : null
      : await tx.sendExecution.findFirst({ where: {
          organizationId: auth.org, kind: 'EXTENSION', executorKey: `${node.id}:${body.requestId}`,
        } });
    if (!receipt && !original) return null;
    if ((receipt?.requestHash ?? original!.requestHash) !== fingerprint)
      throw new ConflictException('CLAIM_REQUEST_CONFLICT');
    if (!original) return { items: [] as T[], reason: (receipt?.result as { reason?: string })?.reason ?? 'REPLAYED_EMPTY_RESULT' };
    if (original.status !== 'RESERVED' || original.leaseExpiresAt <= new Date() ||
        original.nodeCredentialVersion !== node.credentialVersion)
      return { items: [] as T[], reason: 'REPLAYED_EXECUTION_UNAVAILABLE', executionId: original.id, status: original.status };
    return { items: [response(original, node.nodeId)] };
  };
  const initial = await sendTransaction(db, async (tx) => {
    const modeState = await sends.assertControlledIn(tx, auth.org, { drainDiscovery: true });
    const node = await nodes.authenticateIn(tx, auth.org, auth.user, auth.nodeId, auth.token);
    const replay = await replayIn(tx, node);
    if (replay) return { replay };
    if (modeState.mode !== 'CONTROLLED') return { replay: { items: [] as T[], reason: 'CONTROLLED_SEND_NOT_ACTIVE' } };
    await sends.verifyPolicyIn(tx);
    const sessions = (await tx.extensionNodeSession.findMany({ where: {
      extensionNodeId: node.id, organizationId: auth.org, verificationStatus: 'VERIFIED',
      verificationExpiresAt: { gt: new Date() }, integrationId: { not: null },
    } })).filter((s) => {
      const capability = (node.capabilities as any)?.[s.platform];
      return capability?.strictAccountVerification === true &&
        capability[body.action === 'POST' ? 'post' : 'reply'] === true;
    });
    const cursor = body.rootPostId ? null : await tx.sendClaimCursor.findUnique({
      where: { extensionNodeId_action: { extensionNodeId: node.id, action: body.action } },
    });
    return { node, sessions, cursor };
  });
  if ('replay' in initial) return initial.replay;
  const { node, sessions, cursor } = initial;
  const start: Position | null = cursor?.afterPublishDate && cursor.afterPostId
    ? { publishDate: cursor.afterPublishDate, id: cursor.afterPostId } : null;
  let position = start;
  let cycleStartedAt = start && cursor?.cycleStartedAt ? cursor.cycleStartedAt : new Date();
  let wrapped = !start;
  let scanned = 0;
  let reason = sessions.length ? 'NO_MATCHING_DUE_POST' : 'NO_VERIFIED_SESSION_WITH_CAPABILITY';
  const eligible: Prisma.PostWhereInput = {
    organizationId: auth.org, state: 'QUEUE', parentPostId: null, deletedAt: null,
    executionProtocol: 'ACCOUNT_BOUND_V1', publishMethod: 'EXTENSION',
    sendIntent: { action: body.action, status: { in: ['QUEUED', 'RESERVED'] } },
    OR: sessions.map((session) => ({
      providerIdentifier: { in: session.platform === 'linkedin' ? ['linkedin', 'linkedin-page'] : [session.platform] },
      OR: [
        { integrationId: session.integrationId },
        ...(!session.actorKey ? [{ integrationId: null, accountSelectionMode: 'CURRENT_SESSION',
          accountResolution: { not: 'PRESELECTION_REQUIRED' } }] : []),
      ],
    })),
  };
  const cycleWhere = (): Prisma.PostWhereInput => ({
    ...eligible, createdAt: { lte: cycleStartedAt }, publishDate: { lte: cycleStartedAt },
  });
  const saveIn = async (tx: Prisma.TransactionClient, executionId: string | null, after: Position | null, emptyReason?: string) => {
    if (!body.rootPostId) {
      const current = await tx.sendClaimCursor.findUnique({ where: {
        extensionNodeId_action: { extensionNodeId: node.id, action: body.action },
      } });
      if ((current?.revision ?? 0) !== (cursor?.revision ?? 0))
        throw new ConflictException('CLAIM_SCAN_CHANGED');
      const saved = cursor
        ? await tx.sendClaimCursor.updateMany({
            where: { extensionNodeId: node.id, organizationId: auth.org, action: body.action, revision: cursor.revision },
            data: { afterPublishDate: after?.publishDate ?? null, afterPostId: after?.id ?? null,
              cycleStartedAt, revision: { increment: 1 } },
          })
        : await tx.sendClaimCursor.create({ data: {
            extensionNodeId: node.id, organizationId: auth.org, action: body.action,
            afterPublishDate: after?.publishDate ?? null, afterPostId: after?.id ?? null,
            cycleStartedAt, revision: 1,
          } }).then(() => ({ count: 1 }));
      if (saved.count !== 1) throw new ConflictException('CLAIM_SCAN_CHANGED');
    }
    await tx.sendMutationReceipt.create({ data: {
      ...keyFor(node), requestHash: fingerprint, result: { executionId, ...(emptyReason ? { reason: emptyReason } : {}) },
    } });
  };
  const projectVerdicts = new Map<string, boolean>();
  while (scanned < SCAN_LIMIT && sessions.length) {
    const range: Prisma.PostWhereInput[] = [];
    if (position) range.push({ OR: [
      { publishDate: { gt: position.publishDate } },
      { publishDate: position.publishDate, id: { gt: position.id } },
    ] });
    // Discovery holds no locks and grants no right. Each candidate is revalidated below.
    const candidates = await db.post.findMany({
      where: { ...cycleWhere(), ...(body.rootPostId ? { id: body.rootPostId } : { AND: range }) },
      orderBy: [{ publishDate: 'asc' }, { id: 'asc' }],
      take: Math.min(PAGE_SIZE, SCAN_LIMIT - scanned),
      select: { id: true, publishDate: true, projectId: true },
    });
    if (!candidates.length) {
      if (!body.rootPostId && !wrapped) {
        position = null; cycleStartedAt = new Date(); wrapped = true; continue;
      }
      position = null;
      cycleStartedAt = new Date();
      break;
    }
    for (const candidate of candidates) {
      scanned++;
      position = { publishDate: candidate.publishDate, id: candidate.id };
      if (!candidate.projectId) { reason = 'POST_PROJECT_MISSING'; continue; }
      if (!projectVerdicts.has(candidate.projectId))
        projectVerdicts.set(candidate.projectId, await sends.claimProjectActive(auth.org, candidate.projectId));
      if (!projectVerdicts.get(candidate.projectId)) { reason = 'PROJECT_UNAVAILABLE_OR_INACTIVE'; continue; }
      const result = await sendTransaction(db, async (tx) => {
        await sends.assertControlledIn(tx, auth.org);
        const currentNode = await nodes.authenticateIn(tx, auth.org, auth.user, auth.nodeId, auth.token);
        const replay = await replayIn(tx, currentNode);
        if (replay) return replay;
        await sends.verifyPolicyIn(tx);
        const post = await tx.post.findFirst({ where: { ...cycleWhere(), id: candidate.id, projectId: candidate.projectId } });
        if (!post) return null;
        const capability = (currentNode.capabilities as any)?.[canonicalControlledPlatform(post.providerIdentifier!)];
        if (capability?.strictAccountVerification !== true || capability[body.action === 'POST' ? 'post' : 'reply'] !== true)
          return null;
        const session = await tx.extensionNodeSession.findFirst({ where: {
          extensionNodeId: currentNode.id, organizationId: auth.org,
          platform: canonicalControlledPlatform(post.providerIdentifier!),
          ...(post.integrationId ? { integrationId: post.integrationId } : { actorKey: '' }),
          verificationStatus: 'VERIFIED', verificationExpiresAt: { gt: new Date() },
        } });
        if (!session) { reason = 'VERIFIED_SESSION_UNAVAILABLE'; return null; }
        const claimabilityReason = await sends.claimabilityReasonIn(tx, auth.org, post, session, body.action, new Date());
        if (claimabilityReason) {
          reason = claimabilityReason;
          return null;
        }
        const intent = post.integrationId
          ? await tx.sendIntent.findUniqueOrThrow({ where: { id: post.sendIntentId! } })
          : await sends.bindCurrentActorIn(tx, auth.org, post.id, session, new Date());
        if (!intent?.integrationId) return null;
        let execution = await sends.reserveIn(tx, auth.org, post.id, 'EXTENSION', `${node.id}:${body.requestId}`, {
          extensionNodeId: currentNode.id, nodeCredentialVersion: currentNode.credentialVersion,
          sessionRevision: session.sessionRevision,
        }, new Date());
        execution = await tx.sendExecution.update({ where: { id: execution.id }, data: {
          leaseTokenHash: hashSecret(sendLease(execution)), requestHash: fingerprint,
        } });
        await saveIn(tx, execution.id, position);
        return { items: [response(execution, currentNode.nodeId)] };
      }).catch((error: unknown) => {
        // Only candidate-local failures may be skipped. Authentication, policy and cursor failures abort.
        if (error instanceof ConflictException && [
          'CONTROLLED_MEDIA_NOT_RESOLVED', 'INVALID_SEND_CHAIN', 'SEND_CONTENT_CHANGED',
          'SEND_INTENT_CHANGED', 'SEND_ALREADY_OWNED', 'CONTENT_NOT_SENDABLE',
          'PARTIAL_SEND_REQUIRES_RECONCILIATION',
        ].includes(error.message)) { reason = error.message; return null; }
        throw error;
      });
      if (result) return result;
    }
    if (body.rootPostId) break;
  }
  return sendTransaction(db, async (tx) => {
    await sends.assertControlledIn(tx, auth.org);
        const currentNode = await nodes.authenticateIn(tx, auth.org, auth.user, auth.nodeId, auth.token);
    const replay = await replayIn(tx, currentNode);
    if (replay) return replay;
    await sends.verifyPolicyIn(tx);
    if (scanned >= SCAN_LIMIT) reason = 'SCAN_LIMIT_REACHED';
    await saveIn(tx, null, position, reason);
    return { items: [], reason };
  });
}
