import { canonicalControlledPlatform } from './controlled-platforms';
import { hashSecret, sessionActorKey } from './extension-node.protocol';
import { StopSendDto } from './send-execution.dto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, SendExecution } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../database/prisma/prisma.service';
import { ExtensionNodeService } from './extension-node.service';
import {
  SendCoordinatorService,
  SendActor,
  SendOutcome,
} from './send-coordinator.service';
import {
  sendHash,
  sendLease,
  sendTransaction,
} from './send-coordination.utils';

export interface NodeAuthentication {
  org: string;
  user: string;
  nodeId: string;
  token: string;
}
@Injectable()
export class SendExecutionService {
  constructor(
    private readonly db: PrismaService,
    private readonly nodes: ExtensionNodeService,
    private readonly sends: SendCoordinatorService
  ) {}

  async claim(
    auth: NodeAuthentication,
    body: { requestId: string; action: 'POST' | 'REPLY'; rootPostId?: string }
  ) {
    this.sends.enabled();
    if (
      !body.requestId?.trim() ||
      body.requestId.length > 128 ||
      !['POST', 'REPLY'].includes(body.action)
    )
      throw new BadRequestException('INVALID_SEND_CLAIM');
    return sendTransaction(this.db, async (tx) => {
      const node = await this.nodes.authenticateIn(
        tx,
        auth.org,
        auth.user,
        auth.nodeId,
        auth.token
      );
      const receiptKey = {
        organizationId: auth.org,
        userId: auth.user,
        operation: `node-send-claim:${node.id}`,
        requestId: body.requestId,
      };
      const receipt = await tx.sendMutationReceipt.findUnique({
        where: { organizationId_userId_operation_requestId: receiptKey },
      });
      const fingerprint = sendHash(body);
      if (receipt) {
        if (receipt.requestHash !== fingerprint)
          throw new ConflictException('CLAIM_REQUEST_CONFLICT');
        const recorded = receipt.result as { executionId: string | null };
        if (!recorded.executionId) return { items: [] };
        const original = await this.sends.execution(
          tx,
          auth.org,
          recorded.executionId
        );
        if (
          original.status !== 'RESERVED' ||
          original.leaseExpiresAt <= new Date() ||
          original.nodeCredentialVersion !== node.credentialVersion
        )
          return {
            items: [],
            executionId: original.id,
            status: original.status,
          };
        return { items: [this.claimResponse(original, node.nodeId)] };
      }
      const executorKey = `${node.id}:${body.requestId}`;
      const prior = await tx.sendExecution.findFirst({
        where: { organizationId: auth.org, kind: 'EXTENSION', executorKey },
      });
      if (prior) {
        if (prior.requestHash !== sendHash(body))
          throw new ConflictException('CLAIM_REQUEST_CONFLICT');
        if (
          prior.status !== 'RESERVED' ||
          prior.leaseExpiresAt <= new Date() ||
          prior.nodeCredentialVersion !== node.credentialVersion
        )
          return { items: [], executionId: prior.id, status: prior.status };
        return { items: [this.claimResponse(prior, node.nodeId)] };
      }
      const sessions = await tx.extensionNodeSession.findMany({
        where: {
          extensionNodeId: node.id,
          organizationId: auth.org,
          verificationStatus: 'VERIFIED',
          verificationExpiresAt: { gt: new Date() },
          integrationId: { not: null },
        },
      });
      const candidates = await tx.post.findMany({
        where: {
          organizationId: auth.org,
          ...(body.rootPostId ? { id: body.rootPostId } : {}),
          state: 'QUEUE',
          OR: [
            {
              integrationId: {
                in: sessions.map((session) => session.integrationId!),
              },
            },
            {
              integrationId: null,
              accountSelectionMode: 'CURRENT_SESSION',
              accountResolution: { not: 'PRESELECTION_REQUIRED' },
            },
          ],
          parentPostId: null,
          deletedAt: null,
          executionProtocol: 'ACCOUNT_BOUND_V1',
          publishMethod: 'EXTENSION',
          publishDate: { lte: new Date() },
          sendIntent: {
            action: body.action,
            status: { in: ['QUEUED', 'RESERVED'] },
          },
        },
        orderBy: { publishDate: 'asc' },
        take: 25,
      });
      for (const post of candidates) {
        const session = sessions.find(
          (s) =>
            s.platform === canonicalControlledPlatform(post.providerIdentifier!) &&
            (post.integrationId ? s.integrationId === post.integrationId : !s.actorKey)
        );
        const capability = (node.capabilities as any)?.[
          canonicalControlledPlatform(post.providerIdentifier!)
        ];
        if (
          !session ||
          !capability?.strictAccountVerification ||
          capability[body.action === 'POST' ? 'post' : 'reply'] !== true
        )
          continue;
        const existing = !post.integrationId
          ? await this.sends.bindCurrentActorIn(
              tx,
              auth.org,
              post.id,
              session,
              new Date()
            )
          : await tx.sendIntent.findUniqueOrThrow({
              where: { id: post.sendIntentId! },
            });
        if (!existing?.integrationId || !existing.canonicalAccountKey) continue;
        if (existing.activeExecutionId) {
          const owner = await tx.sendExecution.findUniqueOrThrow({
            where: { id: existing.activeExecutionId },
          });
          if (owner.status !== 'RESERVED' || owner.leaseExpiresAt > new Date())
            continue;
        }
        const account = await tx.accountWriteState.findUnique({
          where: {
            organizationId_canonicalAccountKey: {
              organizationId: auth.org,
              canonicalAccountKey: existing.canonicalAccountKey!,
            },
          },
        });
        if (
          !account?.rolloutReady ||
          account.activeExecutionId ||
          (account.nextWriteNotBefore &&
            account.nextWriteNotBefore > new Date())
        )
          continue;
        let execution = await this.sends.reserveIn(
          tx,
          auth.org,
          post.id,
          'EXTENSION',
          executorKey,
          {
            extensionNodeId: node.id,
            nodeCredentialVersion: node.credentialVersion,
            sessionRevision: session.sessionRevision,
          },
          new Date()
        );
        execution = await tx.sendExecution.update({
          where: { id: execution.id },
          data: {
            leaseTokenHash: hashSecret(sendLease(execution)),
            requestHash: sendHash(body),
          },
        });
        await tx.sendMutationReceipt.create({
          data: {
            ...receiptKey,
            requestHash: fingerprint,
            result: { executionId: execution.id },
          },
        });
        return { items: [this.claimResponse(execution, node.nodeId)] };
      }
      await tx.sendMutationReceipt.create({
        data: {
          ...receiptKey,
          requestHash: fingerprint,
          result: { executionId: null },
        },
      });
      return { items: [] };
    });
  }

  private claimResponse(execution: SendExecution, nodeId: string) {
    return {
      executionId: execution.id,
      sendIntentId: execution.sendIntentId,
      leaseToken: sendLease(execution),
      leaseExpiresAt: execution.leaseExpiresAt,
      fencingVersion: execution.fencingVersion,
      routeRevision: execution.routeRevision,
      contentRevision: execution.contentRevision,
      nodeId,
      nodeCredentialVersion: execution.nodeCredentialVersion,
      sessionRevision: execution.sessionRevision,
      integrationId: execution.integrationId,
      platform: execution.platform,
      action: execution.action,
      targetAccount: execution.target,
      segments: execution.payload,
    };
  }

  private async authenticate(
    tx: Prisma.TransactionClient,
    auth: NodeAuthentication,
    id: string,
    lease: string,
    allowHistorical = false
  ) {
    const node = await this.nodes.authenticateIn(
      tx,
      auth.org,
      auth.user,
      auth.nodeId,
      auth.token,
      allowHistorical
    );
    const execution = await this.sends.execution(tx, auth.org, id);
    if (
      execution.kind !== 'EXTENSION' ||
      execution.extensionNodeId !== node.id ||
      execution.nodeCredentialVersion !== node.credentialVersion ||
      !lease ||
      execution.leaseTokenHash !== hashSecret(lease)
    )
      throw new ConflictException('SEND_LEASE_AUTHENTICATION_FAILED');
    return { execution, node };
  }

  async renew(auth: NodeAuthentication, id: string, lease: string) {
    this.sends.enabled();
    return sendTransaction(this.db, async (tx) => {
      const { execution } = await this.authenticate(tx, auth, id, lease);
      const now = new Date();
      const intent = await tx.sendIntent.findUniqueOrThrow({
        where: { id: execution.sendIntentId },
      });
      if (
        execution.status !== 'RESERVED' ||
        execution.leaseExpiresAt <= now ||
        intent.activeExecutionId !== id ||
        intent.fencingVersion !== execution.fencingVersion
      )
        throw new ConflictException('SEND_LEASE_NOT_RENEWABLE');
      const until = new Date(
        Math.min(
          now.getTime() + 120_000,
          execution.createdAt.getTime() + 1_800_000
        )
      );
      if (until <= now)
        throw new ConflictException('SEND_PREPARATION_DEADLINE');
      await tx.sendExecution.update({
        where: { id },
        data: { leaseExpiresAt: until },
      });
      return {
        leaseExpiresAt: until.toISOString(),
        serverNow: now.toISOString(),
      };
    });
  }

  async preflight(
    auth: NodeAuthentication,
    id: string,
    index: number,
    lease: string
  ) {
    this.sends.enabled();
    return sendTransaction(this.db, async (tx) => {
      const { execution } = await this.authenticate(tx, auth, id, lease);
      const segment = await tx.sendSegment.findUnique({
        where: {
          executionId_segmentIndex: { executionId: id, segmentIndex: index },
        },
      });
      if (!segment || segment.status !== 'PENDING')
        throw new ConflictException('SEGMENT_NOT_PENDING');
      if (
        execution.status === 'RESERVED' &&
        execution.leaseExpiresAt <= new Date()
      )
        throw new ConflictException('SEND_LEASE_EXPIRED');
      const intent = await tx.sendIntent.findUniqueOrThrow({
        where: { id: execution.sendIntentId },
      });
      if (
        intent.activeExecutionId !== id ||
        intent.fencingVersion !== execution.fencingVersion ||
        !['RESERVED', 'SENDING'].includes(execution.status)
      )
        throw new ConflictException('STALE_SEND_EXECUTION');
      const challenge = randomBytes(32).toString('base64url');
      const now = new Date();
      await tx.sendSegment.update({
        where: { id: segment.id },
        data: {
          challengeHash: sendHash(challenge),
          challengeIssuedAt: now,
          challengeExpiresAt: new Date(now.getTime() + 30_000),
          evidenceSessionRevision: null,
          evidenceObservedAt: null,
          probeId: null,
        },
      });
      return {
        challenge,
        expiresAt: new Date(now.getTime() + 30_000).toISOString(),
        serverNow: now.toISOString(),
      };
    });
  }

  async start(
    auth: NodeAuthentication,
    id: string,
    index: number,
    lease: string
  ) {
    this.sends.enabled();
    await this.sends.assertProjectSendActive(auth.org, id);
    return sendTransaction(this.db, async (tx) => {
      const { execution, node } = await this.authenticate(tx, auth, id, lease);
      const segment = await tx.sendSegment.findUniqueOrThrow({
        where: {
          executionId_segmentIndex: { executionId: id, segmentIndex: index },
        },
      });
      if (segment.status !== 'PENDING')
        return { granted: false, status: segment.status };
      const now = new Date();
      const session = await tx.extensionNodeSession.findUnique({
        where: {
          extensionNodeId_platform: {
            extensionNodeId: node.id,
            platform: execution.platform,
            actorKey: sessionActorKey({ id: (execution.target as any)?.id, namespace: (execution.target as any)?.idNamespace }),
          },
        },
      });
      const caps = (node.capabilities as any)?.[execution.platform];
      if (
        !caps?.strictAccountVerification ||
        caps[execution.action === 'POST' ? 'post' : 'reply'] !== true ||
        !session ||
        session.verificationStatus !== 'VERIFIED' ||
        session.integrationId !== execution.integrationId ||
        !session.verificationExpiresAt ||
        session.verificationExpiresAt <= now ||
        !segment.challengeExpiresAt ||
        segment.challengeExpiresAt <= now ||
        !segment.probeId ||
        segment.probeId !== session.probeId ||
        segment.evidenceSessionRevision !== session.sessionRevision ||
        !segment.evidenceObservedAt ||
        now.getTime() - segment.evidenceObservedAt.getTime() > 30_000
      )
        throw new ConflictException('FRESH_SEND_PREFLIGHT_REQUIRED');
      const identity = session.accountIdentity as {
        id?: string;
        namespace?: string;
      };
      return this.sends.authorizeIn(
        tx,
        execution,
        index,
        { id: identity.id!, idNamespace: identity.namespace! },
        now
      );
    });
  }

  async outcome(
    auth: NodeAuthentication,
    id: string,
    index: number,
    lease: string,
    body: SendOutcome
  ) {
    if (body.status === 'definitely_not_submitted')
      throw new BadRequestException('STRUCTURED_STOP_CONFIRMATION_REQUIRED');
    const result = await sendTransaction(this.db, async (tx) => {
      const { execution } = await this.authenticate(tx, auth, id, lease, true);
      return this.sends.outcomeIn(tx, execution, index, body, new Date());
    });
    if (result.conflict)
      throw new ConflictException(
        'SEND_OUTCOME_CONFLICT_REQUIRES_RECONCILIATION'
      );
    return result;
  }

  async stop(
    auth: NodeAuthentication,
    id: string,
    index: number,
    lease: string,
    body: StopSendDto
  ) {
    return sendTransaction(this.db, async (tx) => {
      const { execution } = await this.authenticate(tx, auth, id, lease, true);
      const outcome = {
        status: 'definitely_not_submitted' as const,
        eventId: body.eventId,
        stopped: true,
        evidence: JSON.stringify(body),
      };
      const prior = await tx.sendOutcomeEvent.findUnique({
        where: {
          executionId_segmentIndex_eventId: {
            executionId: id,
            segmentIndex: index,
            eventId: body.eventId,
          },
        },
      });
      if (prior)
        return this.sends.outcomeIn(tx, execution, index, outcome, new Date());
      const segment = await tx.sendSegment.findUniqueOrThrow({
        where: {
          executionId_segmentIndex: { executionId: id, segmentIndex: index },
        },
      });
      const at = new Date(body.executorStoppedAt);
      const now = new Date();
      const permitted = segment.permitHash
        ? !!segment.authorizedAt &&
          at >= segment.authorizedAt &&
          !!segment.submitBefore &&
          segment.submitBefore <= now &&
          body.permitHash === segment.permitHash
        : segment.status === 'PENDING' &&
          body.permitHash === '' &&
          at >= execution.createdAt;
      if (
        !/^[a-f0-9]{64}$/.test(body.journalDigest ?? '') ||
        body.noPendingSubmit !== true ||
        !['PREPARED', 'CANCELLED_BEFORE_SUBMIT'].includes(body.lastPhase) ||
        !Number.isFinite(at.getTime()) ||
        at > now ||
        !permitted
      )
        throw new ConflictException('STOP_CONFIRMATION_REQUIRED');
      return this.sends.outcomeIn(tx, execution, index, outcome, now);
    });
  }

  async status(auth: NodeAuthentication, id: string, lease: string) {
    return sendTransaction(this.db, async (tx) => {
      const { execution } = await this.authenticate(tx, auth, id, lease, true);
      const segments = await tx.sendSegment.findMany({
        where: { executionId: id, organizationId: auth.org },
        orderBy: { segmentIndex: 'asc' },
        select: {
          segmentIndex: true,
          status: true,
          submitBefore: true,
          result: true,
        },
      });
      const account = await tx.accountWriteState.findUnique({
        where: {
          organizationId_canonicalAccountKey: {
            organizationId: auth.org,
            canonicalAccountKey: execution.canonicalAccountKey,
          },
        },
      });
      return {
        executionId: id,
        status: execution.status,
        segments,
        leaseExpiresAt: execution.leaseExpiresAt,
        nextWriteNotBefore: account?.nextWriteNotBefore ?? null,
        serverNow: new Date().toISOString(),
      };
    });
  }
}
