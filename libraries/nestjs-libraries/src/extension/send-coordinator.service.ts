import { SendModeService } from './send-mode.service';
import { CONTROLLED_SEND_PLATFORMS, canonicalControlledPlatform, controlledReplySettings, hasControlledReplyTarget } from './controlled-platforms';
import { stripHtmlValidation } from '@gitroom/helpers/utils/strip.html.validation';
import { hashSecret } from './extension-node.protocol';
import { sendBusinessSummary } from './send-business-summary';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma, SendExecution, SendIntent } from '@prisma/client';
import { randomBytes, randomUUID } from 'node:crypto';
import { PrismaService } from '../database/prisma/prisma.service';
import { ProjectValidationService } from '../projects/project-validation.service';
import { SendBindingService } from './send-binding.service';
import { SendPolicyService } from './send-policy.service';
import { SendQuotaService } from './send-quota.service';
import {
  canonicalSendAccount,
  matchesSendActor,
  postSendHash,
  sendHash,
  sendJson,
  sendTransaction,
} from './send-coordination.utils';

export interface SendActor {
  id: string;
  idNamespace: string;
  credentialHash?: string;
  observedAt?: string;
}
export interface SendOutcome {
  eventId: string;
  status: 'confirmed' | 'unknown' | 'definitely_not_submitted';
  platformId?: string;
  url?: string;
  stopped?: boolean;
  evidence?: string;
  removal?: 'removed' | 'gone';
}
export interface EnqueueSend {
  userId: string;
  origin: 'MANUAL' | 'AUTOMATION';
  action?: 'POST' | 'REPLY';
  context?: { channel?: string; matchedKeywords?: string[] };
  now?: Date;
  contentUnitId?: string;
  explicitIntegrationId?: string;
  publishMethod?: 'API' | 'EXTENSION';
  publishDate?: Date;
  sentReplyId?: string;
  selection?: {
    integrationId?: string | null;
    expectedRouteRevision?: number;
    expectedContentRevision?: number;
    requestId?: string;
  };
}
const active = ['RESERVED', 'SENDING', 'RECONCILING'];
const reject = (message: string): never => {
  throw new ConflictException(message);
};

@Injectable()
export class SendCoordinatorService {
  constructor(
    private readonly db: PrismaService,
    private readonly bindings: SendBindingService,
    private readonly policies: SendPolicyService,
    private readonly projects: ProjectValidationService,
    private readonly quotas: SendQuotaService,
    private readonly modes: SendModeService = new SendModeService(db)
  ) {}

  async enabled(org: string) {
    const state = await this.modes.stateIn(this.db, org);
    if (state.mode !== 'CONTROLLED') throw new ConflictException('SEND_MODE_CONTROLLED_REQUIRED');
  }

  isControlled(org: string, tx?: Prisma.TransactionClient) { return this.modes.isControlled(org, tx); }

  assertControlledIn(tx: Prisma.TransactionClient, org: string) {
    return this.modes.assertControlledIn(tx, org);
  }

  async autonomousTransaction<T>(org: string, work: (tx: Prisma.TransactionClient) => Promise<T>) {
    return sendTransaction(this.db, async tx => {
      await this.modes.assertAutonomousIn(tx, org);
      return work(tx);
    });
  }

  private async assertMember(tx: Prisma.TransactionClient, org: string, user: string) {
    if (!user) throw new ForbiddenException('AUTHENTICATED_USER_REQUIRED');
    const member = await tx.userOrganization.findUnique({
      where: { userId_organizationId: { userId: user, organizationId: org } },
    });
    if (!member || member.disabled) throw new ForbiddenException('ORGANIZATION_MEMBERSHIP_REQUIRED');
  }

  async businessSummary(org: string, user: string, postId: string) {
    await this.assertMember(this.db, org, user);
    const scope = await this.db.post.findFirst({ where: { id: postId, organizationId: org, deletedAt: null } });
    if (!scope) throw new NotFoundException('SEND_ROOT_NOT_FOUND');
    if (scope.projectId) await this.projects.assertProjectAccess(org, scope.projectId);
    const activation = scope.projectId ? await this.projects.getActivationVerdict(org, scope.projectId) : 'inactive';
    const operationBlockCode = !scope.projectId ? 'SEND_PROJECT_REQUIRED' : activation === 'active' ? null
      : activation === 'inactive' ? 'PROJECT_INACTIVE' : 'PROJECT_VALIDATION_UNAVAILABLE';
    return sendTransaction(this.db, async tx => {
      await this.assertMember(tx, org, user);
      const post = await tx.post.findFirst({ where: { id: postId, organizationId: org, projectId: scope.projectId, deletedAt: null } });
      if (!post) throw new NotFoundException('SEND_ROOT_NOT_FOUND');
      const intent = post.sendIntentId ? await tx.sendIntent.findFirst({
        where: { id: post.sendIntentId, organizationId: org, projectId: post.projectId! },
      }) : null;
      if (post.sendIntentId && !intent) reject('SEND_INTENT_SCOPE_MISMATCH');
      const root = intent && intent.rootPostId !== post.id ? await tx.post.findFirst({
        where: { id: intent.rootPostId, organizationId: org, projectId: post.projectId, sendIntentId: intent.id, parentPostId: null, deletedAt: null },
      }) : post;
      if (!root) reject('SEND_INTENT_SCOPE_MISMATCH');
      const executions = intent ? await tx.sendExecution.findMany({
        where: { organizationId: org, sendIntentId: intent.id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }) : [];
      const segments = executions.length ? await tx.sendSegment.findMany({
        where: { organizationId: org, executionId: { in: executions.map(e => e.id) } }, orderBy: { segmentIndex: 'asc' },
      }) : [];
      return sendBusinessSummary(root, intent, executions, segments, operationBlockCode, await this.isControlled(org, tx));
    });
  }

  verifyPolicyIn(tx: Prisma.TransactionClient) {
    return this.policies.getSystem(tx);
  }

  async claimProjectActive(org: string, project: string) {
    try {
      await this.projects.assertProjectActive(org, project);
      return true;
    } catch {
      return false;
    }
  }

  async claimableIn(
    tx: Prisma.TransactionClient,
    org: string,
    post: import('@prisma/client').Post,
    session: import('@prisma/client').ExtensionNodeSession,
    action: 'POST' | 'REPLY',
    now: Date
  ) {
    const intent = post.sendIntentId
      ? await tx.sendIntent.findUnique({ where: { id: post.sendIntentId } }) : null;
    if (!intent || intent.organizationId !== org || intent.rootPostId !== post.id ||
        intent.projectId !== post.projectId || intent.action !== action ||
        intent.platform !== canonicalControlledPlatform(post.providerIdentifier!) ||
        intent.routeRevision !== post.routeRevision || intent.contentRevision !== post.contentRevision ||
        !['QUEUED', 'RESERVED'].includes(intent.status) || intent.hasConfirmedSegments ||
        !session.integrationId || session.verificationStatus !== 'VERIFIED' ||
        !session.verificationExpiresAt || session.verificationExpiresAt <= now)
      return false;
    const owner = (intent.policySnapshot as { policyOwnerUserId?: string }).policyOwnerUserId;
    const member = owner ? await tx.userOrganization.findUnique({
      where: { userId_organizationId: { userId: owner, organizationId: org } },
    }) : null;
    if (!member || member.disabled) return false;
    const integration = await tx.integration.findFirst({ where: {
      id: session.integrationId, organizationId: org, disabled: false, deletedAt: null,
    } });
    const relation = await tx.integrationProject.findFirst({ where: {
      organizationId: org, projectId: intent.projectId, integrationId: session.integrationId, disabled: false,
    } });
    const actor = session.accountIdentity as { id?: string; namespace?: string } | null;
    if (!integration || integration.inBetweenSteps || !relation ||
        (action === 'REPLY' && relation.engageEnabled !== true) ||
        canonicalControlledPlatform(integration.providerIdentifier) !== intent.platform ||
        !integration.identityNamespace || integration.identityNamespace === 'legacy' ||
        !actor?.id || !actor.namespace || !matchesSendActor({
          id: integration.internalId, idNamespace: integration.identityNamespace,
        }, { id: actor.id, idNamespace: actor.namespace })) return false;
    if (intent.integrationId && (intent.integrationId !== session.integrationId ||
        post.integrationId !== intent.integrationId || !intent.target ||
        !matchesSendActor(intent.target as unknown as SendActor, { id: actor.id, idNamespace: actor.namespace })))
      return false;
    const account = await tx.accountWriteState.findFirst({ where: {
      organizationId: org, integrationId: session.integrationId,
      ...(intent.canonicalAccountKey ? { canonicalAccountKey: intent.canonicalAccountKey } : {}),
    } });
    if (!account?.rolloutReady || account.activeExecutionId ||
        (account.nextWriteNotBefore && account.nextWriteNotBefore > now)) return false;
    if (intent.activeExecutionId) {
      const previous = await tx.sendExecution.findUnique({ where: { id: intent.activeExecutionId } });
      if (!previous || previous.status !== 'RESERVED' || previous.leaseExpiresAt > now) return false;
    }
    if (intent.sendOrigin === 'AUTOMATION') {
      try { await this.quotas.resolve(tx, intent, account, 0, now); }
      catch (error) {
        if (error instanceof ForbiddenException || error instanceof BadRequestException) return false;
        throw error;
      }
    }
    return true;
  }

  private async chain(
    tx: Prisma.TransactionClient,
    org: string,
    rootId: string
  ) {
    const root = await tx.post.findFirst({
      where: { id: rootId, organizationId: org, deletedAt: null },
    });
    if (!root || root.parentPostId)
      throw new NotFoundException('SEND_ROOT_NOT_FOUND');
    const rows = await tx.post.findMany({
      where: { organizationId: org, group: root.group, deletedAt: null },
    });
    const chain = [root];
    for (;;) {
      const children = rows.filter(
        (p) => p.parentPostId === chain[chain.length - 1].id
      );
      if (!children.length) break;
      if (children.length !== 1 || chain.some((p) => p.id === children[0].id))
        reject('INVALID_SEND_CHAIN');
      if (
        children[0].projectId !== root.projectId ||
        children[0].providerIdentifier !== root.providerIdentifier
      )
        reject('INVALID_SEND_CHAIN');
      chain.push(children[0]);
    }
    return chain;
  }

  async enqueue(org: string, rootId: string, options: EnqueueSend) {
    await this.enabled(org);
    const now = options.now ?? new Date();
    const root = await this.db.post.findFirst({
      where: { id: rootId, organizationId: org, deletedAt: null },
    });
    if (!root?.projectId)
      throw new BadRequestException('SEND_PROJECT_REQUIRED');
    await this.projects.assertProjectActive(org, root.projectId);
    return sendTransaction(this.db, async (tx) => {
      await this.assertControlledIn(tx, org);
      const posts = await this.chain(tx, org, rootId);
      const first = posts[0];
      const selection = options.selection;
      const receiptKey = {
        organizationId: org, userId: options.userId,
        operation: `queue-reply:${rootId}`, requestId: selection?.requestId ?? '',
      };
      const receiptRequestId = selection?.requestId;
      const fingerprint = receiptRequestId ? sendHash({ rootId, selection }) : '';
      if (selection || options.sentReplyId) await this.assertMember(tx, org, options.userId);
      if (receiptRequestId) {
        const receipt = await tx.sendMutationReceipt.findUnique({
          where: { organizationId_userId_operation_requestId: receiptKey },
        });
        if (receipt) {
          if (receipt.requestHash !== fingerprint) reject('REQUEST_ID_CONFLICT');
          return first;
        }
      }
      if (first.intervalInDays)
        throw new BadRequestException(
          'CONTROLLED_RECURRING_OCCURRENCE_REQUIRED'
        );
      const reply =
        first.source === 'engage'
          ? await tx.engageSentReply.findUnique({
              where: { postId: first.id },
              include: { opportunity: true },
            })
          : null;
      if (
        reply &&
        (reply.organizationId !== org || reply.projectId !== first.projectId)
      )
        reject('REPLY_SCOPE_MISMATCH');
      if (options.sentReplyId && reply?.id !== options.sentReplyId)
        reject('REPLY_SCOPE_MISMATCH');
      const unit =
        first.contentUnitId ??
        options.contentUnitId ??
        (reply
          ? `reply-primary:${first.projectId}:${reply.opportunityId}`
          : first.id);
      const existing = await tx.sendIntent.findUnique({
        where: {
          organizationId_contentUnitId: {
            organizationId: org,
            contentUnitId: unit,
          },
        },
      });
      if (existing && existing.rootPostId !== first.id) reject('CONTENT_ROOT_CONFLICT');
      // The saved reply itself is the idempotency key. A replay never grants
      // another execution, changes the frozen actor, or touches quota ledgers.
      if (existing && options.sentReplyId && !receiptRequestId) {
        if (first.sendIntentId !== existing.id || existing.action !== 'REPLY')
          reject('SEND_CONTENT_CHANGED');
        const requestedAccount = selection?.integrationId;
        if ((typeof requestedAccount === 'string' && requestedAccount !== existing.integrationId) ||
            (requestedAccount === null && first.accountSelectionMode === 'EXPLICIT'))
          reject('SEND_INTENT_IMMUTABLE');
        return first;
      }
      if (first.state === 'PUBLISHED' || first.releaseId)
        reject('CONTENT_ALREADY_SUBMITTED');
      if (existing) {
        if (selection) reject('SEND_INTENT_IMMUTABLE');
        if (existing.status !== 'QUEUED')
          reject('SEND_INTENT_REQUIRES_EXPLICIT_RETRY');
        return first;
      }
      if (
        posts.some(
          (p) =>
            !['DRAFT', 'QUEUE'].includes(p.state) ||
            p.sendIntentId ||
            p.releaseId
        )
      )
        reject('CONTENT_NOT_ENQUEUEABLE');
      if (selection) {
        if (first.state !== 'DRAFT') reject('CONTENT_NOT_ENQUEUEABLE');
        if ((selection.expectedRouteRevision !== undefined && first.routeRevision !== selection.expectedRouteRevision) ||
            (selection.expectedContentRevision !== undefined && first.contentRevision !== selection.expectedContentRevision))
          reject('SEND_CONTENT_REVISION_CONFLICT');
        if (selection.integrationId !== undefined) {
          first.accountSelectionMode = selection.integrationId === null ? 'INHERIT' : 'EXPLICIT';
          first.integrationId = selection.integrationId;
          first.routeRevision++;
        }
      }
      const action =
        options.action ?? (first.source === 'engage' ? 'REPLY' : 'POST');
      if (reply) {
        const target = reply.opportunity.externalPostId;
        if (!target) reject('REPLY_TARGET_REQUIRED');
        const settings = JSON.parse(first.settings || '{}');
        const targetSettings = controlledReplySettings(first.providerIdentifier!, target, reply.opportunity.externalPostUrl);
        if (!targetSettings) reject('REPLY_PLATFORM_NOT_SUPPORTED');
        Object.assign(settings, targetSettings);
        first.settings = JSON.stringify(settings);
        await tx.post.update({
          where: { id: first.id },
          data: { settings: first.settings },
        });
      }
      if (action === 'REPLY') {
        const settings = JSON.parse(first.settings || '{}');
        if (!hasControlledReplyTarget(first.providerIdentifier!, settings))
          reject('REPLY_TARGET_REQUIRED');
      }
      const replyState = reply
        ? await tx.engageOpportunityState.findFirst({
            where: {
              organizationId: org,
              projectId: first.projectId,
              opportunityId: reply.opportunityId,
            },
          })
        : null;
      // Both saved-reply and generic Post entry points must claim the opportunity.
      if (options.sentReplyId || (reply && options.origin === 'MANUAL')) {
        if (!replyState || !['NEW', 'AUTO_QUEUED'].includes(replyState.status))
          reject('REPLY_OPPORTUNITY_NOT_ACTIONABLE');
        const claimed = await tx.engageOpportunityState.updateMany({
          where: { id: replyState.id, organizationId: org, projectId: first.projectId,
            opportunityId: reply!.opportunityId, status: { in: ['NEW', 'AUTO_QUEUED'] } },
          data: { status: 'SCHEDULED' },
        });
        if (claimed.count !== 1) reject('REPLY_OPPORTUNITY_NOT_ACTIONABLE');
      }
      if (
        first.integrationId &&
        first.accountSelectionMode == null &&
        options.explicitIntegrationId === undefined
      )
        throw new BadRequestException('SEND_BINDING_RECONFIRMATION_REQUIRED');
      if (!(CONTROLLED_SEND_PLATFORMS as readonly string[]).includes(canonicalControlledPlatform(first.providerIdentifier!)))
        throw new BadRequestException('CONTROLLED_PLATFORM_UNSUPPORTED');
      if (posts.length > 1 && ['medium', 'quora', 'devto'].includes(canonicalControlledPlatform(first.providerIdentifier!)))
        throw new BadRequestException('CONTROLLED_PLATFORM_THREAD_UNSUPPORTED');
      const policy = await this.policies.snapshotInTransaction(
        tx,
        options.userId
      );
      const route = await this.bindings.resolveForEnqueueInTransaction(
        tx,
        org,
        first.projectId!,
        canonicalControlledPlatform(first.providerIdentifier!),
        action,
        options.explicitIntegrationId ??
          (first.accountSelectionMode === 'EXPLICIT'
            ? first.integrationId ?? undefined
            : undefined),
        policy.requirePreselectedAccount === false &&
          first.accountSelectionMode !== 'EXPLICIT'
      );
      if (first.providerIdentifier === 'linkedin-page' && route?.providerIdentifier !== 'linkedin-page')
        throw new BadRequestException('LINKEDIN_COMPANY_ACCOUNT_REQUIRED');
      // Enrollment deliberately blocks all legacy writers before an account is audited.
      if (route)
        await tx.accountWriteState.upsert({
          where: {
            organizationId_canonicalAccountKey: {
              organizationId: org,
              canonicalAccountKey: route.canonicalAccountKey,
            },
          },
          create: {
            id: route.canonicalAccountKey,
            organizationId: org,
            canonicalAccountKey: route.canonicalAccountKey,
            integrationId: route.integrationId,
          },
          update: {},
        });
      const intent = await tx.sendIntent.create({
        data: {
          organizationId: org,
          contentUnitId: unit,
          rootPostId: first.id,
          projectId: first.projectId!,
          platform: canonicalControlledPlatform(first.providerIdentifier!),
          action,
          sendOrigin: options.origin,
          status: 'QUEUED',
          integrationId: route?.integrationId ?? null,
          canonicalAccountKey: route?.canonicalAccountKey ?? null,
          target: route ? sendJson(route.targetAccount) : Prisma.DbNull,
          routeRevision: first.routeRevision,
          contentRevision: first.contentRevision,
          policySnapshot: sendJson(policy),
          ...(options.context || reply
            ? {
                context: sendJson(
                  options.context ?? {
                    channel: reply!.opportunity.channelId,
                    matchedKeywords:
                      replyState?.matchedKeywords ?? reply!.matchedKeywords,
                  }
                ),
              }
            : {}),
        },
      });
      const queued = await tx.post.updateMany({
        where: {
          organizationId: org,
          id: { in: posts.map((p) => p.id) },
          sendIntentId: null,
          releaseId: null,
        },
        data: {
          contentUnitId: unit,
          sendIntentId: intent.id,
          integrationId: route?.integrationId ?? null,
          executionProtocol: 'ACCOUNT_BOUND_V1',
          sendTarget: route ? sendJson(route.targetAccount) : Prisma.DbNull,
          accountResolution: route ? 'RESOLVED' : 'AWAITING_CURRENT_ACTOR',
          bindingSource: route?.bindingSource ?? 'CURRENT_SESSION',
          bindingSourceRevision: route?.bindingRevision ?? null,
          routeRevision: first.routeRevision,
          state: 'QUEUE',
          ...(options.publishDate ? { publishDate: options.publishDate } : {}),
          sendOrigin: options.origin,
          // The legacy request field remains accepted; new intents execute through the plugin only.
          publishMethod: 'EXTENSION',
          accountSelectionMode: !route
            ? 'CURRENT_SESSION'
            : options.explicitIntegrationId ||
              first.accountSelectionMode === 'EXPLICIT'
            ? 'EXPLICIT'
            : 'INHERIT',
        },
      });
      if (queued.count !== posts.length) reject('SEND_CONTENT_CHANGED');
      if (receiptRequestId) await tx.sendMutationReceipt.create({
        data: { ...receiptKey, requestHash: fingerprint, result: { rootPostId: rootId, sendIntentId: intent.id } },
      });
      return tx.post.findUniqueOrThrow({ where: { id: rootId } });
    });
  }

  async bindCurrentActorIn(
    tx: Prisma.TransactionClient,
    org: string,
    rootId: string,
    session: {
      integrationId: string | null;
      accountIdentity: unknown;
      verificationStatus: string;
      verificationExpiresAt: Date | null;
    },
    now: Date
  ) {
    // Policy writers and first binding lock in the same order. Bound tasks never acquire this global lock.
    await this.assertControlledIn(tx, org);
    const current = await this.policies.lockSystemInTransaction(tx);
    const posts = await this.chain(tx, org, rootId);
    const root = posts[0];
    const intent = root.sendIntentId
      ? await tx.sendIntent.findUnique({ where: { id: root.sendIntentId } })
      : null;
    if (!intent || intent.integrationId) return intent;
    if (
      intent.status !== 'QUEUED' ||
      intent.activeExecutionId ||
      intent.hasConfirmedSegments ||
      root.accountSelectionMode !== 'CURRENT_SESSION' ||
      root.publishMethod !== 'EXTENSION'
    )
      return null;
    const snapshot =
      intent.policySnapshot as unknown as import('./send-policy.service').SendPolicySnapshot & {
        policyOwnerUserId?: string;
      };
    if (this.policies.requiresPreselection(snapshot, current)) {
      await tx.post.updateMany({
        where: { organizationId: org, sendIntentId: intent.id },
        data: { accountResolution: 'PRESELECTION_REQUIRED' },
      });
      return null;
    }
    const member = snapshot.policyOwnerUserId
      ? await tx.userOrganization.findUnique({
          where: {
            userId_organizationId: {
              userId: snapshot.policyOwnerUserId,
              organizationId: org,
            },
          },
        })
      : null;
    if (
      !member ||
      member.disabled ||
      !session.integrationId ||
      session.verificationStatus !== 'VERIFIED' ||
      !session.verificationExpiresAt ||
      session.verificationExpiresAt <= now
    )
      return null;
    let route;
    try {
      route = await this.bindings.resolveCurrentActorInTransaction(
        tx,
        org,
        intent.projectId,
        intent.platform,
        intent.action as 'POST' | 'REPLY',
        session.integrationId
      );
    } catch (error) {
      if (
        error instanceof ForbiddenException ||
        error instanceof BadRequestException
      )
        return null;
      throw error;
    }
    const observed = session.accountIdentity as {
      id?: string;
      namespace?: string;
    } | null;
    if (
      !observed?.id ||
      !observed.namespace ||
      !matchesSendActor(route.targetAccount, {
        id: observed.id,
        idNamespace: observed.namespace,
      })
    )
      return null;
    const account = await tx.accountWriteState.findUnique({
      where: {
        organizationId_canonicalAccountKey: {
          organizationId: org,
          canonicalAccountKey: route.canonicalAccountKey,
        },
      },
    });
    if (
      !account?.rolloutReady ||
      account.activeExecutionId ||
      (account.nextWriteNotBefore && account.nextWriteNotBefore > now)
    )
      return null;
    const revision = intent.routeRevision + 1;
    const saved = await tx.sendIntent.updateMany({
      where: {
        id: intent.id,
        organizationId: org,
        revision: intent.revision,
        integrationId: null,
        activeExecutionId: null,
        status: 'QUEUED',
      },
      data: {
        integrationId: route.integrationId,
        canonicalAccountKey: route.canonicalAccountKey,
        target: sendJson(route.targetAccount),
        routeRevision: revision,
        revision: { increment: 1 },
      },
    });
    if (saved.count !== 1) reject('SEND_INTENT_CHANGED');
    const changed = await tx.post.updateMany({
      where: {
        organizationId: org,
        sendIntentId: intent.id,
        integrationId: null,
        routeRevision: intent.routeRevision,
      },
      data: {
        integrationId: route.integrationId,
        sendTarget: sendJson(route.targetAccount),
        accountResolution: 'RESOLVED',
        bindingSource: 'CURRENT_SESSION',
        routeRevision: revision,
      },
    });
    if (changed.count !== posts.length) reject('SEND_CONTENT_CHANGED');
    return tx.sendIntent.findUniqueOrThrow({ where: { id: intent.id } });
  }

  async enqueueSavedReply(org: string, userId: string, sentReplyId: string,
    options: import('./send-execution.dto').QueueStoredReplyDto = { sentReplyId }) {
    await this.assertMember(this.db, org, userId);
    await this.enabled(org);
    const reply = await this.db.engageSentReply.findFirst({
      where: { id: sentReplyId, organizationId: org },
    });
    if (!reply) throw new NotFoundException('SAVED_REPLY_NOT_FOUND');
    if (!reply.projectId) throw new BadRequestException('SEND_PROJECT_REQUIRED');
    await this.projects.assertProjectActive(org, reply.projectId);
    const existing = await this.db.post.findFirst({
      where: { id: reply.postId, organizationId: org },
    });
    if (!existing || existing.source !== 'engage' || existing.projectId !== reply.projectId || existing.deletedAt)
      throw new NotFoundException('SAVED_REPLY_NOT_FOUND');
    const versioned = options.requestId !== undefined ||
      options.expectedRouteRevision !== undefined || options.expectedContentRevision !== undefined;
    if (versioned && (!options.requestId?.trim() || options.requestId.length > 128 ||
        !Number.isSafeInteger(options.expectedRouteRevision) || options.expectedRouteRevision! < 0 ||
        !Number.isSafeInteger(options.expectedContentRevision) || options.expectedContentRevision! < 1 ||
        (options.integrationId != null && !options.integrationId.trim())))
      throw new BadRequestException('SEND_SELECTION_VERSION_REQUIRED');
    if (options.integrationId != null &&
        (typeof options.integrationId !== 'string' || !options.integrationId.trim()))
      throw new BadRequestException('INVALID_SEND_ACCOUNT_SELECTION');
    return this.enqueue(org, reply.postId, {
      userId,
      origin: 'MANUAL',
      action: 'REPLY',
      sentReplyId,
      publishMethod: 'EXTENSION',
      ...(versioned ? { selection: {
        integrationId: options.integrationId, requestId: options.requestId!,
        expectedRouteRevision: options.expectedRouteRevision!,
        expectedContentRevision: options.expectedContentRevision!,
      } } : options.integrationId !== undefined
        ? { selection: { integrationId: options.integrationId } } : {}),
    });
  }

  async prepareCreation(
    org: string,
    user: string,
    requestId: string,
    itemKey: string,
    fingerprint: string,
    preferredRootId?: string
  ) {
    if (
      !requestId?.trim() ||
      requestId.length > 128 ||
      !itemKey?.trim() ||
      itemKey.length > 128
    )
      throw new BadRequestException('SEND_REQUEST_ID_REQUIRED');
    return sendTransaction(this.db, async (tx) => {
      await this.assertControlledIn(tx, org);
      const key = {
        organizationId: org,
        userId: user,
        operation: `send-create:${itemKey}`,
        requestId,
      };
      const prior = await tx.sendMutationReceipt.findUnique({
        where: { organizationId_userId_operation_requestId: key },
      });
      if (prior) {
        if (prior.requestHash !== fingerprint)
          reject('SEND_CREATE_REQUEST_CONFLICT');
        return (prior.result as { rootPostId: string }).rootPostId;
      }
      if (
        preferredRootId &&
        (await tx.post.findFirst({
          where: {
            id: preferredRootId,
            organizationId: org,
            sendIntentId: { not: null },
          },
        }))
      )
        reject('SEND_INTENT_IMMUTABLE');
      const rootPostId = preferredRootId || randomUUID();
      await tx.sendMutationReceipt.create({
        data: { ...key, requestHash: fingerprint, result: { rootPostId } },
      });
      return rootPostId;
    });
  }

  async hasContentIntent(org: string, contentUnitId: string) {
    return !!(await this.db.sendIntent.findUnique({
      where: {
        organizationId_contentUnitId: { organizationId: org, contentUnitId },
      },
    }));
  }

  async assertLegacyAccount(org: string, _integrationId: string) {
    await this.autonomousTransaction(org, async () => undefined);
  }

  async legacyBlockedPlatforms(org: string) {
    const state = await this.modes.stateIn(this.db, org);
    return state.mode === 'AUTONOMOUS' && state.autonomousAllowed
      ? [] : [...CONTROLLED_SEND_PLATFORMS, 'linkedin-page'];
  }

  async assertLegacyPosts(org: string, posts: { id: string; projectId?: string | null; sendIntentId?: string | null; executionProtocol?: string | null }[]) {
    for (const post of posts) if (post.sendIntentId || post.executionProtocol === 'ACCOUNT_BOUND_V1') reject('SEND_COORDINATOR_REQUIRED');
    await this.autonomousTransaction(org, async () => undefined);
  }

  async assertProjectSendActive(org: string, executionId: string) {
    const execution = await this.db.sendExecution.findFirst({
      where: { id: executionId, organizationId: org },
    });
    if (!execution) throw new NotFoundException('SEND_EXECUTION_NOT_FOUND');
    await this.projects.assertProjectActive(org, execution.projectId);
  }

  async assertMutable(org: string, rootId: string) {
    const post = await this.db.post.findFirst({
      where: { id: rootId, organizationId: org },
    });
    if (post?.sendIntentId) reject('SEND_INTENT_IMMUTABLE');
  }

  async reserveApi(
    org: string,
    rootId: string,
    executorKey: string,
    now = new Date()
  ) {
    await this.enabled(org);
    return sendTransaction(this.db, (tx) =>
      this.reserveIn(tx, org, rootId, 'API', executorKey, {}, now)
    );
  }

  private async extensionMedia(
    tx: Prisma.TransactionClient,
    org: string,
    image: string | null
  ) {
    let items: Array<{
      id?: string;
      path?: string;
      url?: string;
    }>;
    try { items = JSON.parse(image || '[]'); }
    catch { reject('CONTROLLED_MEDIA_NOT_RESOLVED'); }
    if (!Array.isArray(items) || items.some(item => !item || typeof item !== 'object'))
      reject('CONTROLLED_MEDIA_NOT_RESOLVED');
    return Promise.all(
      items.map(async (item) => {
        const media = item.id
          ? await tx.media.findFirst({
              where: { id: item.id, organizationId: org },
            })
          : null;
        const path = media?.path ?? item.path ?? item.url;
        if (!path) reject('CONTROLLED_MEDIA_NOT_RESOLVED');
        const url = /^https?:\/\//.test(path)
          ? path
          : `${process.env.FRONTEND_URL}/${process.env.NEXT_PUBLIC_UPLOAD_STATIC_DIRECTORY}${path}`;
        if (!/^https?:\/\//.test(url)) reject('CONTROLLED_MEDIA_NOT_RESOLVED');
        return url;
      })
    );
  }

  async reserveIn(
    tx: Prisma.TransactionClient,
    org: string,
    rootId: string,
    kind: 'API' | 'EXTENSION',
    executorKey: string,
    node: {
      extensionNodeId?: string;
      nodeCredentialVersion?: number;
      sessionRevision?: number;
    },
    now: Date
  ) {
    await this.assertControlledIn(tx, org);
    if (!executorKey?.trim())
      throw new BadRequestException('SEND_EXECUTOR_KEY_REQUIRED');
    const posts = await this.chain(tx, org, rootId);
    const root = posts[0];
    const intent =
      root.sendIntentId &&
      (await tx.sendIntent.findFirst({
        where: { id: root.sendIntentId, organizationId: org },
      }));
    if (
      !intent ||
      !intent.integrationId ||
      !intent.canonicalAccountKey ||
      !intent.target
    )
      reject('SEND_INTENT_REQUIRED');
    const requestKey = sendHash([root.id, executorKey]);
    const prior = await tx.sendExecution.findUnique({
      where: {
        organizationId_kind_requestKey: {
          organizationId: org,
          kind,
          requestKey,
        },
      },
    });
    if (prior) return prior;
    if (intent.activeExecutionId) {
      const previous = await tx.sendExecution.findUniqueOrThrow({
        where: { id: intent.activeExecutionId },
      });
      if (previous.status !== 'RESERVED' || previous.leaseExpiresAt > now)
        reject('SEND_ALREADY_OWNED');
      await tx.sendExecution.update({
        where: { id: previous.id },
        data: { status: 'EXPIRED' },
      });
      await tx.sendIntent.update({
        where: { id: intent.id },
        data: { activeExecutionId: null, status: 'QUEUED' },
      });
    } else if (intent.status !== 'QUEUED') reject('CONTENT_NOT_SENDABLE');
    if (intent.hasConfirmedSegments)
      reject('PARTIAL_SEND_REQUIRES_RECONCILIATION');
    const payload = await Promise.all(
      posts.map(async (p) => ({
        id: p.id,
        content: p.content,
        ...(kind === 'EXTENSION'
          ? {
              text: stripHtmlValidation('normal', p.content || '', true),
              mediaUrls: await this.extensionMedia(tx, org, p.image),
            }
          : {}),
        settings: p.settings,
        image: p.image,
        title: p.title,
        contentHash: postSendHash(p),
      }))
    );
    const execution = await tx.sendExecution.create({
      data: {
        organizationId: org,
        sendIntentId: intent.id,
        kind,
        requestKey,
        requestHash: sendHash(payload),
        executorKey,
        ...node,
        projectId: intent.projectId,
        platform: intent.platform,
        action: intent.action,
        integrationId: intent.integrationId,
        canonicalAccountKey: intent.canonicalAccountKey,
        target: intent.target as Prisma.InputJsonValue,
        ...(intent.context
          ? { context: intent.context as Prisma.InputJsonValue }
          : {}),
        fencingVersion: intent.fencingVersion + 1,
        routeRevision: intent.routeRevision,
        contentRevision: intent.contentRevision,
        leaseExpiresAt: new Date(now.getTime() + 120_000),
        payload: sendJson(payload),
      },
    });
    for (const [index, post] of posts.entries())
      await tx.sendSegment.create({
        data: {
          organizationId: org,
          executionId: execution.id,
          segmentIndex: index,
          postId: post.id,
          contentHash: postSendHash(post),
        },
      });
    const saved = await tx.sendIntent.updateMany({
      where: { id: intent.id, revision: intent.revision },
      data: {
        activeExecutionId: execution.id,
        fencingVersion: execution.fencingVersion,
        status: 'RESERVED',
        revision: { increment: 1 },
      },
    });
    if (saved.count !== 1) reject('SEND_INTENT_CHANGED');
    return execution;
  }

  async authorizeApiSegment(
    org: string,
    executionId: string,
    index: number,
    observed: SendActor,
    now = new Date()
  ) {
    await this.enabled(org);
    await this.assertProjectSendActive(org, executionId);
    return sendTransaction(this.db, async (tx) => {
      const execution = await this.execution(tx, org, executionId);
      if (execution.kind !== 'API') reject('EXECUTION_CHANNEL_MISMATCH');
      return this.authorizeIn(tx, execution, index, observed, now);
    });
  }

  async authorizeIn(
    tx: Prisma.TransactionClient,
    execution: SendExecution,
    index: number,
    observed: SendActor,
    now: Date
  ) {
    const org = execution.organizationId;
    await this.assertControlledIn(tx, org);
    await this.verifyPolicyIn(tx);
    const account = await tx.accountWriteState.findUnique({
      where: {
        organizationId_canonicalAccountKey: {
          organizationId: org,
          canonicalAccountKey: execution.canonicalAccountKey,
        },
      },
    });
    if (!account?.rolloutReady) reject('ACCOUNT_COORDINATION_AUDIT_REQUIRED');
    // A revision update obtains the account lock before any intent or quota row.
    const locked = await tx.accountWriteState.updateMany({
      where: { id: account.id, revision: account.revision },
      data: { revision: { increment: 1 } },
    });
    if (locked.count !== 1) reject('ACCOUNT_WRITE_STATE_CHANGED');
    const intent = await tx.sendIntent.findUniqueOrThrow({
      where: { id: execution.sendIntentId },
    });
    const owner = (intent.policySnapshot as { policyOwnerUserId?: string })
      .policyOwnerUserId;
    const member = owner
      ? await tx.userOrganization.findUnique({
          where: {
            userId_organizationId: { userId: owner, organizationId: org },
          },
        })
      : null;
    if (!member || member.disabled)
      throw new ForbiddenException('SEND_POLICY_OWNER_UNAVAILABLE');
    const segment = await tx.sendSegment.findUnique({
      where: {
        executionId_segmentIndex: {
          executionId: execution.id,
          segmentIndex: index,
        },
      },
    });
    if (!segment) throw new NotFoundException('SEND_SEGMENT_NOT_FOUND');
    if (segment.status !== 'PENDING')
      return { granted: false as const, status: segment.status };
    if (
      intent.activeExecutionId !== execution.id ||
      intent.fencingVersion !== execution.fencingVersion ||
      !active.includes(execution.status) ||
      execution.status === 'RECONCILING'
    )
      reject('STALE_SEND_EXECUTION');
    if (execution.status === 'RESERVED' && execution.leaseExpiresAt <= now)
      reject('SEND_LEASE_EXPIRED');
    if (
      intent.routeRevision !== execution.routeRevision ||
      intent.contentRevision !== execution.contentRevision
    )
      reject('SEND_REVISION_CHANGED');
    if (!matchesSendActor(execution.target as unknown as SendActor, observed))
      reject('ACCOUNT_MISMATCH');
    const integration = await tx.integration.findFirst({
      where: {
        id: execution.integrationId,
        organizationId: org,
        disabled: false,
        deletedAt: null,
      },
    });
    const relation = await tx.integrationProject.findFirst({
      where: {
        organizationId: org,
        projectId: execution.projectId,
        integrationId: execution.integrationId,
        disabled: false,
      },
    });
    if (
      integration &&
      observed.credentialHash &&
      sendHash([integration.token, integration.refreshToken]) !==
        observed.credentialHash
    )
      reject('SEND_CREDENTIAL_CHANGED');
    if (
      observed.observedAt &&
      (now.getTime() - Date.parse(observed.observedAt) > 30_000 ||
        Date.parse(observed.observedAt) > now.getTime() ||
        !Number.isFinite(Date.parse(observed.observedAt)))
    )
      reject('FRESH_SEND_PREFLIGHT_REQUIRED');
    if (
      !integration ||
      !matchesSendActor(execution.target as unknown as SendActor, {
        id: integration.internalId,
        idNamespace: integration.identityNamespace!,
      }) ||
      integration.inBetweenSteps ||
      !relation ||
      (execution.action === 'REPLY' && !relation.engageEnabled)
    )
      throw new ForbiddenException('SEND_ACCOUNT_UNAVAILABLE');
    if (account.activeExecutionId && account.activeExecutionId !== execution.id)
      reject('ACCOUNT_WRITE_BUSY');
    const post = await tx.post.findFirst({
      where: { id: segment.postId, organizationId: org, deletedAt: null },
    });
    if (
      !post ||
      post.sendIntentId !== intent.id ||
      postSendHash(post) !== segment.contentHash
    )
      reject('SEND_CONTENT_CHANGED');
    if (post.publishDate && post.publishDate > now) reject('SEND_NOT_DUE');
    if (index > 0) {
      const parent = await tx.sendSegment.findUnique({
        where: {
          executionId_segmentIndex: {
            executionId: execution.id,
            segmentIndex: index - 1,
          },
        },
      });
      if (parent?.status !== 'CONFIRMED')
        reject('PREVIOUS_SEGMENT_NOT_CONFIRMED');
    }
    const plan = await this.quotas.resolve(tx, intent, account, index, now);
    const next = Math.max(
      account.nextWriteNotBefore?.getTime() ?? 0,
      account.lastConfirmedAt
        ? account.lastConfirmedAt.getTime() + plan.gapMs
        : 0
    );
    if (next > now.getTime()) reject('ACCOUNT_WRITE_INTERVAL');
    const submitBefore = new Date(
      Math.min(
        now.getTime() + 30_000,
        ...plan.budgets.map((b) => b.windowEnd.getTime() - 1_000)
      )
    );
    if (submitBefore.getTime() - now.getTime() < 1_000)
      reject('SEND_QUOTA_WINDOW_CLOSING');
    await this.quotas.reserve(tx, org, execution.id, index, plan.budgets, now);
    const permit = randomBytes(32).toString('base64url');
    const changed = await tx.sendSegment.updateMany({
      where: { id: segment.id, status: 'PENDING' },
      data: {
        status: 'AUTHORIZED',
        permitHash: hashSecret(permit),
        submitBefore,
        authorizedAt: now,
      },
    });
    if (changed.count !== 1) reject('SEND_SEGMENT_CHANGED');
    await tx.sendExecution.update({
      where: { id: execution.id },
      data: {
        status: 'SENDING',
        startedAt: execution.startedAt ?? now,
        lastProgressAt: now,
        gapMs: plan.gapMs,
      },
    });
    await tx.sendIntent.update({
      where: { id: intent.id },
      data: { status: 'SENDING', revision: { increment: 1 } },
    });
    await tx.accountWriteState.update({
      where: { id: account.id },
      data: { activeExecutionId: execution.id },
    });
    return {
      granted: true as const,
      attemptId: execution.id,
      segmentIndex: index,
      fencingVersion: execution.fencingVersion,
      routeRevision: execution.routeRevision,
      contentRevision: execution.contentRevision,
      contentHash: segment.contentHash,
      targetAccount: execution.target,
      permit,
      submitBefore: submitBefore.toISOString(),
      serverNow: now.toISOString(),
    };
  }

  async execution(tx: Prisma.TransactionClient, org: string, id: string) {
    const row = await tx.sendExecution.findFirst({
      where: { id, organizationId: org },
    });
    if (!row) throw new NotFoundException('SEND_EXECUTION_NOT_FOUND');
    return row;
  }

  async apiOutcome(
    org: string,
    executionId: string,
    index: number,
    outcome: SendOutcome,
    now = new Date()
  ) {
    const result = await sendTransaction(this.db, async (tx) => {
      const execution = await this.execution(tx, org, executionId);
      if (execution.kind !== 'API') reject('EXECUTION_CHANNEL_MISMATCH');
      return this.outcomeIn(tx, execution, index, outcome, now);
    });
    if (result.conflict)
      reject('SEND_OUTCOME_CONFLICT_REQUIRES_RECONCILIATION');
    return result;
  }

  async outcomeIn(
    tx: Prisma.TransactionClient,
    execution: SendExecution,
    index: number,
    outcome: SendOutcome,
    now: Date
  ) {
    if (
      outcome.url &&
      (!outcome.url.startsWith('https://') || outcome.url.length > 2048)
    )
      throw new BadRequestException('INVALID_SEND_RESULT_URL');
    if (
      !outcome.eventId?.trim() ||
      outcome.eventId.length > 200 ||
      !['confirmed', 'unknown', 'definitely_not_submitted'].includes(
        outcome.status
      )
    )
      throw new BadRequestException('INVALID_SEND_OUTCOME');
    const org = execution.organizationId;
    const account = await tx.accountWriteState.findUniqueOrThrow({
      where: {
        organizationId_canonicalAccountKey: {
          organizationId: org,
          canonicalAccountKey: execution.canonicalAccountKey,
        },
      },
    });
    const locked = await tx.accountWriteState.updateMany({
      where: { id: account.id, revision: account.revision },
      data: { revision: { increment: 1 } },
    });
    if (locked.count !== 1) reject('ACCOUNT_WRITE_STATE_CHANGED');
    const intent = await tx.sendIntent.findUniqueOrThrow({
      where: { id: execution.sendIntentId },
    });
    const segment = await tx.sendSegment.findUniqueOrThrow({
      where: {
        executionId_segmentIndex: {
          executionId: execution.id,
          segmentIndex: index,
        },
      },
    });
    const key = {
      executionId: execution.id,
      segmentIndex: index,
      eventId: outcome.eventId,
    };
    const hash = sendHash(outcome);
    const prior = await tx.sendOutcomeEvent.findUnique({
      where: { executionId_segmentIndex_eventId: key },
    });
    if (prior) {
      if (prior.requestHash !== hash) reject('SEND_OUTCOME_EVENT_CONFLICT');
      return prior.result as { status: string; conflict?: boolean };
    }
    if (outcome.status === 'confirmed' && !outcome.platformId?.trim())
      throw new BadRequestException('PLATFORM_RESULT_REQUIRED');
    const previousResult = segment.result as { platformId?: string } | null;
    if (outcome.removal !== undefined) {
      if (!['removed', 'gone'].includes(outcome.removal) || outcome.status !== 'confirmed' ||
          segment.status !== 'CONFIRMED' || previousResult?.platformId !== outcome.platformId ||
          !outcome.evidence?.trim())
        reject('CONFIRMED_REMOVAL_EVIDENCE_REQUIRED');
      const published = await tx.post.findFirst({ where: {
        organizationId: org, id: segment.postId, sendIntentId: intent.id, releaseId: outcome.platformId,
      } });
      if (!published) reject('CONFIRMED_REMOVAL_EVIDENCE_REQUIRED');
      // A removal appends a fact to a confirmed submission. It never settles quota again.
      await tx.post.updateMany({ where: {
        organizationId: org, id: segment.postId, sendIntentId: intent.id, removedAt: null,
      }, data: { removedAt: now, removedReason: outcome.removal } });
      await tx.engageSentReply.updateMany({ where: {
        organizationId: org, postId: segment.postId, removedAt: null,
      }, data: { removedAt: now, removedReason: outcome.removal } });
      if (outcome.url) await tx.post.updateMany({ where: {
        organizationId: org, id: segment.postId, sendIntentId: intent.id, releaseURL: null,
      }, data: { releaseURL: outcome.url } });
      const result: { status: string; removal: string; conflict?: boolean } = { status: 'CONFIRMED', removal: outcome.removal };
      await tx.sendOutcomeEvent.create({ data: {
        organizationId: org, ...key, requestHash: hash, evidence: sendJson(outcome), result,
      } });
      return result;
    }
    let conflict =
      segment.status === 'CONFIRMED' &&
      outcome.status === 'confirmed' &&
      previousResult?.platformId !== outcome.platformId;
    if (segment.status === 'NOT_SUBMITTED' && outcome.status === 'confirmed')
      conflict = true;
    if (
      segment.status === 'PENDING' &&
      (outcome.status !== 'definitely_not_submitted' ||
        intent.activeExecutionId !== execution.id ||
        !['RESERVED', 'SENDING'].includes(execution.status))
    )
      reject('SEND_NOT_AUTHORIZED');
    if (conflict) {
      // Persist conflicting evidence and freeze the current owner; never roll this back by throwing inside the transaction.
      await tx.sendIntent.update({
        where: { id: intent.id },
        data: { status: 'RECONCILING', revision: { increment: 1 } },
      });
      const owner = account.activeExecutionId ?? intent.activeExecutionId ?? execution.id;
      // Keep both the content owner and any other in-flight account owner frozen.
      for (const id of new Set([execution.id, owner, intent.activeExecutionId ?? execution.id])) {
        const affected = await tx.sendExecution.update({
          where: { id },
          data: { status: 'RECONCILING', lastProgressAt: now },
        });
        if (affected.sendIntentId !== intent.id)
          await tx.sendIntent.update({
            where: { id: affected.sendIntentId },
            data: { status: 'RECONCILING', revision: { increment: 1 } },
          });
      }
      await tx.accountWriteState.update({
        where: { id: account.id },
        // A later receipt may clear an owner, but only a fresh deployment audit can lift quarantine.
        data: { activeExecutionId: owner, rolloutReady: false },
      });
      if (segment.status === 'NOT_SUBMITTED') {
        await this.quotas.correctLateConfirmation(
          tx,
          org,
          execution.id,
          index,
          now
        );
        await tx.sendSegment.update({
          where: { id: segment.id },
          data: {
            status: 'CONFIRMED',
            confirmedAt: now,
            result: sendJson(outcome),
          },
        });
        await tx.post.updateMany({
          where: { id: segment.postId, organizationId: org, releaseId: null },
          data: {
            state: 'PUBLISHED',
            releaseId: outcome.platformId,
            releaseURL: outcome.url ?? null,
            publishDate: now,
            error: null,
          },
        });
        await tx.sendIntent.update({
          where: { id: intent.id },
          data: { hasConfirmedSegments: true },
        });
        await tx.accountWriteState.update({
          where: { id: account.id },
          data: {
            firstConfirmedAt: account.firstConfirmedAt ?? now,
            lastConfirmedAt: now,
            nextWriteNotBefore: new Date(now.getTime() + execution.gapMs),
          },
        });
      }
    } else if (
      segment.status !== 'CONFIRMED' &&
      segment.status !== 'NOT_SUBMITTED'
    ) {
      if (outcome.status === 'definitely_not_submitted') {
        if (
          segment.status === 'PENDING' &&
          (await tx.sendSegment.count({
            where: {
              executionId: execution.id,
              segmentIndex: { lt: index },
              status: { not: 'CONFIRMED' },
            },
          }))
        )
          reject('PREVIOUS_SEGMENT_NOT_CONFIRMED');
        if (
          !outcome.stopped ||
          !outcome.evidence?.trim() ||
          (segment.submitBefore && segment.submitBefore > now)
        )
          reject('STOP_CONFIRMATION_REQUIRED');
        await this.quotas.settle(tx, org, execution.id, index, false, now);
        await tx.sendSegment.update({
          where: { id: segment.id },
          data: { status: 'NOT_SUBMITTED', result: sendJson(outcome) },
        });
        await tx.sendExecution.update({
          where: { id: execution.id },
          data: { status: 'FAILED_FINAL', lastProgressAt: now },
        });
        await tx.sendIntent.update({
          where: { id: intent.id },
          data: {
            status: 'FAILED_FINAL',
            activeExecutionId: null,
            revision: { increment: 1 },
          },
        });
        await tx.accountWriteState.updateMany({
          where: { id: account.id, activeExecutionId: execution.id },
          data: { activeExecutionId: null },
        });
        await tx.post.updateMany({
          where: { organizationId: org, id: segment.postId, releaseId: null },
          data: { state: 'ERROR', error: 'SEND_DEFINITELY_NOT_SUBMITTED' },
        });
      } else if (outcome.status === 'unknown') {
        await tx.sendSegment.update({
          where: { id: segment.id },
          data: { status: 'UNKNOWN', result: sendJson(outcome) },
        });
        await tx.sendExecution.update({
          where: { id: execution.id },
          data: { status: 'RECONCILING', lastProgressAt: now },
        });
        await tx.sendIntent.update({
          where: { id: intent.id },
          data: { status: 'RECONCILING', revision: { increment: 1 } },
        });
      } else {
        await this.quotas.settle(tx, org, execution.id, index, true, now);
        await tx.sendSegment.update({
          where: { id: segment.id },
          data: {
            status: 'CONFIRMED',
            confirmedAt: now,
            result: sendJson(outcome),
          },
        });
        await tx.post.updateMany({
          where: { organizationId: org, id: segment.postId, releaseId: null },
          data: {
            state: 'PUBLISHED',
            releaseId: outcome.platformId,
            releaseURL: outcome.url ?? null,
            publishDate: now,
            error: null,
          },
        });
        if (index === 0 && execution.action === 'REPLY') {
          const reply = await tx.engageSentReply.findUnique({
            where: { postId: segment.postId },
          });
          if (reply) {
            await tx.engageOpportunityState.updateMany({
              where: {
                organizationId: org,
                projectId: execution.projectId,
                opportunityId: reply.opportunityId,
                status: { in: ['NEW', 'AUTO_QUEUED', 'SCHEDULED'] },
              },
              data: { status: 'REPLIED' },
            });
            const keywords = (
              execution.context as { matchedKeywords?: string[] } | null
            )?.matchedKeywords;
            if (keywords)
              await tx.engageSentReply.update({
                where: { id: reply.id },
                data: { matchedKeywords: keywords },
              });
          }
        }
        const remaining = await tx.sendSegment.count({
          where: { executionId: execution.id, status: { not: 'CONFIRMED' } },
        });
        // An unknown intermediate segment is not automatically resumed by a late receipt.
        const complete = remaining === 0;
        const status = complete
          ? 'SUCCEEDED'
          : execution.status === 'RECONCILING'
          ? 'RECONCILING'
          : 'SENDING';
        await tx.sendIntent.update({
          where: { id: intent.id },
          data: {
            status,
            hasConfirmedSegments: true,
            ...(complete ? { activeExecutionId: null } : {}),
            revision: { increment: 1 },
          },
        });
        await tx.sendExecution.update({
          where: { id: execution.id },
          data: { status, lastProgressAt: now },
        });
        await tx.accountWriteState.update({
          where: { id: account.id },
          data: {
            firstConfirmedAt: account.firstConfirmedAt ?? now,
            lastConfirmedAt: now,
            nextWriteNotBefore: new Date(now.getTime() + execution.gapMs),
            ...(complete && account.activeExecutionId === execution.id
              ? { activeExecutionId: null }
              : {}),
          },
        });
      }
    }
    if (
      !conflict &&
      segment.status === 'CONFIRMED' &&
      outcome.status === 'confirmed' &&
      outcome.url
    ) {
      await tx.post.updateMany({
        where: { organizationId: org, id: segment.postId, releaseId: outcome.platformId, releaseURL: null },
        data: { releaseURL: outcome.url },
      });
    }
    const result = {
      status: conflict
        ? 'RECONCILING'
        : outcome.status === 'unknown' && segment.status === 'CONFIRMED'
        ? 'CONFIRMED'
        : outcome.status,
      ...(conflict ? { conflict: true } : {}),
    };
    await tx.sendOutcomeEvent.create({
      data: {
        organizationId: org,
        ...key,
        requestHash: hash,
        evidence: sendJson(outcome),
        result: sendJson(result),
      },
    });
    return result;
  }

  async apiContext(org: string, executionId: string, index: number) {
    return sendTransaction(this.db, async (tx) => {
      const execution = await this.execution(tx, org, executionId);
      const intent = await tx.sendIntent.findUniqueOrThrow({
        where: { id: execution.sendIntentId },
      });
      const segment = await tx.sendSegment.findUniqueOrThrow({
        where: {
          executionId_segmentIndex: { executionId, segmentIndex: index },
        },
      });
      const post = await tx.post.findUniqueOrThrow({
        where: { id: segment.postId },
      });
      const integration = await tx.integration.findUniqueOrThrow({
        where: { id: execution.integrationId },
      });
      const previous =
        index > 0
          ? await tx.sendSegment.findUnique({
              where: {
                executionId_segmentIndex: {
                  executionId,
                  segmentIndex: index - 1,
                },
              },
            })
          : null;
      const account = await tx.accountWriteState.findUniqueOrThrow({
        where: {
          organizationId_canonicalAccountKey: {
            organizationId: org,
            canonicalAccountKey: execution.canonicalAccountKey,
          },
        },
      });
      return {
        execution,
        intent,
        segment,
        post,
        integration,
        previousResult: previous?.result as { platformId?: string } | null,
        nextWriteNotBefore: account.nextWriteNotBefore,
      };
    });
  }

  async reconciliationView(
    org: string,
    administrator: string,
    executionId: string
  ) {
    return sendTransaction(this.db, async (tx) => {
      const user = await tx.user.findUnique({ where: { id: administrator } });
      const member = await tx.userOrganization.findUnique({
        where: {
          userId_organizationId: { userId: administrator, organizationId: org },
        },
      });
      if (!user?.isSuperAdmin || !member || member.disabled)
        throw new ForbiddenException('SEND_RECONCILIATION_PERMISSION_REQUIRED');
      const execution = await this.execution(tx, org, executionId);
      const segments = await tx.sendSegment.findMany({
        where: { executionId, organizationId: org },
        orderBy: { segmentIndex: 'asc' },
        select: {
          segmentIndex: true,
          status: true,
          authorizedAt: true,
          submitBefore: true,
          confirmedAt: true,
          result: true,
        },
      });
      return {
        executionId,
        sendIntentId: execution.sendIntentId,
        status: execution.status,
        resolutionRevision: execution.resolutionRevision,
        integrationId: execution.integrationId,
        projectId: execution.projectId,
        platform: execution.platform,
        action: execution.action,
        targetAccount: execution.target,
        segments,
      };
    });
  }

  async reconcile(
    org: string,
    administrator: string,
    executionId: string,
    index: number,
    expectedRevision: number,
    outcome: SendOutcome
  ) {
    const result = await sendTransaction(this.db, async (tx) => {
      const user = await tx.user.findUnique({ where: { id: administrator } });
      const member = await tx.userOrganization.findUnique({
        where: {
          userId_organizationId: { userId: administrator, organizationId: org },
        },
      });
      if (!user?.isSuperAdmin || !member || member.disabled)
        throw new ForbiddenException('SEND_RECONCILIATION_PERMISSION_REQUIRED');
      const execution = await this.execution(tx, org, executionId);
      const event = {
        ...outcome,
        eventId: `admin:${administrator}:${sendHash(outcome.eventId)}`,
        evidence: `Administrator ${administrator}: ${outcome.evidence ?? ''}`,
      };
      const prior = await tx.sendOutcomeEvent.findUnique({
        where: {
          executionId_segmentIndex_eventId: {
            executionId,
            segmentIndex: index,
            eventId: event.eventId,
          },
        },
      });
      if (
        !prior &&
        (!Number.isSafeInteger(expectedRevision) ||
          expectedRevision !== execution.resolutionRevision)
      )
        reject('SEND_RESOLUTION_REVISION_CONFLICT');
      if (!outcome.evidence?.trim())
        throw new BadRequestException('SEND_RECONCILIATION_EVIDENCE_REQUIRED');
      const recorded = await this.outcomeIn(
        tx,
        execution,
        index,
        event,
        new Date()
      );
      if (!prior)
        await tx.sendExecution.update({
          where: { id: execution.id },
          data: { resolutionRevision: { increment: 1 } },
        });
      return recorded;
    });
    if (result.conflict)
      reject('SEND_OUTCOME_CONFLICT_REQUIRES_RECONCILIATION');
    return result;
  }

  async retry(org: string, rootId: string, userId: string, now = new Date()) {
    await this.assertMember(this.db, org, userId);
    await this.enabled(org);
    const scope = await this.db.post.findFirst({ where: { id: rootId, organizationId: org, deletedAt: null } });
    if (!scope?.projectId) reject('SEND_RETRY_UNSAFE');
    await this.projects.assertProjectActive(org, scope.projectId!);
    return sendTransaction(this.db, async (tx) => {
      await this.assertControlledIn(tx, org);
      await this.assertMember(tx, org, userId);
      const post = await tx.post.findFirst({
        where: { organizationId: org, id: rootId, projectId: scope.projectId, parentPostId: null, deletedAt: null },
      });
      const intent =
        post?.sendIntentId &&
        (await tx.sendIntent.findFirst({ where: { id: post.sendIntentId, organizationId: org, projectId: post.projectId!, rootPostId: post.id } }));
      if (
        !intent ||
        intent.status !== 'FAILED_FINAL' ||
        intent.activeExecutionId ||
        intent.hasConfirmedSegments
      )
        reject('SEND_RETRY_UNSAFE');
      const executions = await tx.sendExecution.findMany({ where: { organizationId: org, sendIntentId: intent.id } });
      const segments = executions.length ? await tx.sendSegment.findMany({
        where: { organizationId: org, executionId: { in: executions.map(e => e.id) } },
      }) : [];
      if (!sendBusinessSummary(post!, intent, executions, segments, null, true).allowedActions.retry.allowed)
        reject('SEND_RETRY_UNSAFE');
      await tx.sendIntent.update({
        where: { id: intent.id },
        data: { status: 'QUEUED', revision: { increment: 1 } },
      });
      await tx.post.updateMany({
        where: { organizationId: org, sendIntentId: intent.id },
        data: { state: 'QUEUE', error: null, publishDate: now },
      });
      return { sendIntentId: intent.id, status: 'QUEUED' };
    });
  }
}
