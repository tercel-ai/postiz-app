import { readPublishNowRequestedAt } from './send-dispatch';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma, SendExecution } from '@prisma/client';
import { PrismaService } from '../database/prisma/prisma.service';
import { ExtensionNodeService } from './extension-node.service';
import { SendCoordinatorService } from './send-coordinator.service';
import type { NodeAuthentication } from './send-execution.service';
import { canonicalControlledPlatform } from './controlled-platforms';
import { hashSecret } from './extension-node.protocol';
import { sendHash, sendLease, sendTransaction } from './send-coordination.utils';

type Claim = { requestId: string; action: 'POST' | 'REPLY'; rootPostId?: string; authorizationMode?: 'NATIVE_FLOW_V1' };
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
  if ((body.authorizationMode !== undefined && body.authorizationMode !== 'NATIVE_FLOW_V1') || !body.requestId?.trim() || body.requestId.length > 128 || !['POST', 'REPLY'].includes(body.action))
    throw new BadRequestException('INVALID_SEND_CLAIM');
  const transaction = <R>(work: (tx: Prisma.TransactionClient) => Promise<R>) =>
    sendTransaction(db, work, { backoffOnConflict: true }).catch((error: unknown) => {
      if ((error as { code?: string })?.code === 'P2034')
        throw new ConflictException({
          code: 'CLAIM_BUSY',
          message: 'Another send operation is updating the queue. Retry the claim.',
        });
      throw error;
    });
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
  const initial = await transaction(async (tx) => {
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
    const actions = body.rootPostId || body.action === 'REPLY' ? [body.action] : ['POST_NOW', 'POST'];
    const cursors = await Promise.all(actions.map(action => body.rootPostId ? null : tx.sendClaimCursor.findUnique({
      where: { extensionNodeId_action: { extensionNodeId: node.id, action } },
    })));
    return { node, sessions, actions, cursors };
  });
  if ('replay' in initial) return initial.replay;
  const { node, sessions } = initial;
  const lanes = initial.actions.map((action, index) => {
    const cursor = initial.cursors[index];
    const start: Position | null = cursor?.afterPublishDate && cursor.afterPostId
      ? { publishDate: cursor.afterPublishDate, id: cursor.afterPostId } : null;
    return { action, cursor, position: start, wrapped: !start, scanned: 0, visited: false,
      cycleStartedAt: action !== 'POST_NOW' && start && cursor?.cycleStartedAt ? cursor.cycleStartedAt : new Date() };
  });
  type Lane = typeof lanes[number];
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
  const cycleWhere = (lane: Lane): Prisma.PostWhereInput => ({
    ...eligible, createdAt: { lte: lane.cycleStartedAt }, publishDate: { lte: lane.cycleStartedAt },
  });
  const saveIn = async (tx: Prisma.TransactionClient, executionId: string | null, emptyReason?: string) => {
    for (const lane of lanes.filter(lane => lane.visited && !body.rootPostId)) {
      const { cursor, action, position: after, cycleStartedAt } = lane;
      const current = await tx.sendClaimCursor.findUnique({ where: {
        extensionNodeId_action: { extensionNodeId: node.id, action },
      } });
      if ((current?.revision ?? 0) !== (cursor?.revision ?? 0))
        throw new ConflictException('CLAIM_SCAN_CHANGED');
      const saved = cursor
        ? await tx.sendClaimCursor.updateMany({
            where: { extensionNodeId: node.id, organizationId: auth.org, action, revision: cursor.revision },
            data: { afterPublishDate: after?.publishDate ?? null, afterPostId: after?.id ?? null,
              cycleStartedAt, revision: { increment: 1 } },
          })
        : await tx.sendClaimCursor.create({ data: {
            extensionNodeId: node.id, organizationId: auth.org, action,
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
  // A poll observes one dispatch snapshot. New requests are discovered on the next
  // poll; transaction revalidation below still fences changes to observed rows.
  const snapshotAt = new Date();
  const priorityRows = !body.rootPostId && body.action === 'POST' && sessions.length
    ? (await db.post.findMany({
        where: { ...eligible, createdAt: { lte: snapshotAt }, publishDate: { lte: snapshotAt },
          sendTarget: { path: ['dispatch', 'mode'], equals: 'now' } },
        select: { id: true, sendTarget: true, publishDate: true, projectId: true },
      })).flatMap(row => {
        const requestedAt = readPublishNowRequestedAt(row.sendTarget);
        return requestedAt ? [{ ...row, requestedAt }] : [];
      }).sort((a, b) => +a.requestedAt - +b.requestedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    : [];
  const priorityIds = priorityRows.map(row => row.id);
  for (const lane of lanes) {
    lane.visited = true;
    // Each lane has its own finite budget, so blocked urgent work cannot starve other accounts.
    while (lane.scanned < SCAN_LIMIT && sessions.length) {
      const range: Prisma.PostWhereInput[] = [];
      if (lane.position) range.push({ OR: [
        { publishDate: { gt: lane.position.publishDate } },
        { publishDate: lane.position.publishDate, id: { gt: lane.position.id } },
      ] });
      const pageSize = Math.min(PAGE_SIZE, SCAN_LIMIT - lane.scanned);
      // Discovery holds no locks and grants no right. Each candidate is revalidated below.
      const candidates = lane.action === 'POST_NOW'
        ? priorityRows.filter(row => {
            const at = row.requestedAt;
            return at <= lane.cycleStartedAt && (!lane.position || at > lane.position.publishDate ||
              (+at === +lane.position.publishDate && row.id > lane.position.id));
          }).slice(0, pageSize)
        : await db.post.findMany({
            where: { ...cycleWhere(lane),
              ...(body.rootPostId ? { id: body.rootPostId } : {
                AND: range, ...(priorityIds.length ? { id: { notIn: priorityIds } } : {}),
              }),
            },
            orderBy: [{ publishDate: 'asc' }, { id: 'asc' }], take: pageSize,
            select: { id: true, publishDate: true, sendTarget: true, projectId: true },
          });
      if (!candidates.length) {
        if (!body.rootPostId && !lane.wrapped) {
          lane.position = null; lane.cycleStartedAt = new Date(); lane.wrapped = true; continue;
        }
        lane.position = null;
        lane.cycleStartedAt = new Date();
        break;
      }
      for (const candidate of candidates) {
        lane.scanned++;
        lane.position = { publishDate: lane.action === 'POST_NOW' ? readPublishNowRequestedAt(candidate.sendTarget)! : candidate.publishDate, id: candidate.id };
        if (!candidate.projectId) { reason = 'POST_PROJECT_MISSING'; continue; }
        if (!projectVerdicts.has(candidate.projectId))
          projectVerdicts.set(candidate.projectId, await sends.claimProjectActive(auth.org, candidate.projectId));
        if (!projectVerdicts.get(candidate.projectId)) { reason = 'PROJECT_UNAVAILABLE_OR_INACTIVE'; continue; }
        const result = await transaction(async (tx) => {
          await sends.assertControlledIn(tx, auth.org);
          const currentNode = await nodes.authenticateIn(tx, auth.org, auth.user, auth.nodeId, auth.token);
          const replay = await replayIn(tx, currentNode);
          if (replay) return replay;
          await sends.verifyPolicyIn(tx);
          const post = await tx.post.findFirst({ where: { ...cycleWhere(lane), id: candidate.id, projectId: candidate.projectId } });
          if (!post) return null;
          if (!body.rootPostId && body.action === 'POST') {
            const at = readPublishNowRequestedAt(post.sendTarget);
            if (lane.action === 'POST_NOW' ? !at || at > lane.cycleStartedAt : !!at) return null;
          }
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
            ...(body.authorizationMode ? { context: { ...(execution.context as Record<string, any> | null), authorizationMode: body.authorizationMode } } : {}),
          } });
          // A successful urgent grant restarts FIFO discovery; only budget exhaustion retains progress.
          if (lane.action === 'POST_NOW') { lane.position = null; lane.cycleStartedAt = new Date(); }
          await saveIn(tx, execution.id);
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
  }
  return transaction(async (tx) => {
    await sends.assertControlledIn(tx, auth.org);
    const currentNode = await nodes.authenticateIn(tx, auth.org, auth.user, auth.nodeId, auth.token);
    const replay = await replayIn(tx, currentNode);
    if (replay) return replay;
    await sends.verifyPolicyIn(tx);
    if (lanes.some(lane => lane.scanned >= SCAN_LIMIT)) reason = 'SCAN_LIMIT_REACHED';
    await saveIn(tx, null, reason);
    return { items: [], reason };
  });
}
