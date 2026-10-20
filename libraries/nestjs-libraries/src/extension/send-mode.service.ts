import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma/prisma.service';
import { sendHash, sendJson, sendTransaction } from './send-coordination.utils';
import {
  ResolveAutonomousEffectDto,
  SaveSendModeDto,
  SaveSystemSendModeDto,
} from './send-mode.dto';
import { isLegacyExecution } from './legacy-execution';

export const SEND_MODE_SYSTEM_KEY = 'sending.account_bound_enabled';
export const SEND_MODE_ORGANIZATION_PREFIX = 'sending.organization_mode:';
export const organizationSendModeKey = (organizationId: string) =>
  `${SEND_MODE_ORGANIZATION_PREFIX}${organizationId}`;
export type OrganizationSendingMode = 'AUTONOMOUS' | 'CONTROLLED';
const AUTONOMOUS_EFFECT_OPERATION = 'autonomous-side-effect';
export interface AutonomousEffectRequest {
  integrationId: string;
  action: 'POST' | 'COMMENT' | 'PLUG' | 'INTERNAL_PLUG' | 'THREAD_FINISHER';
  quotaWriteKind?: 'WRITE' | 'REPLY';
  quotaUnits?: number;
  [key: string]: unknown;
}
interface AutonomousEffectResult {
  status: 'AUTHORIZED' | 'UNKNOWN' | 'CONFIRMED' | 'NOT_SUBMITTED';
  revision: number;
  action: AutonomousEffectRequest['action'];
  integrationId: string;
  hasResult?: boolean;
  undefinedResult?: boolean;
  result?: Prisma.JsonValue;
  evidence?: string;
  resolvedByUserId?: string;
  postIds?: string[];
  targetPostId?: string;
  occurrenceKey?: string;
  recurring?: boolean;
  confirmedAt?: string;
  quotaWriteKind?: 'WRITE' | 'REPLY';
  quotaUnits?: number;
}
export interface SendModeBlockers {
  legacyQueuedPosts: number;
  legacyReplyDrafts: number;
  legacyClaims: number;
  nonterminalIntents: number;
  activeExecutions: number;
  uncertainSegments: number;
  heldQuotaReservations: number;
  accountLocks: number;
  controlledPendingPosts: number;
  autonomousEffects: number;
}
export interface SendModeState {
  organizationId: string;
  mode: OrganizationSendingMode | 'PAUSED';
  configuredMode: OrganizationSendingMode | null;
  revision: number;
  systemEnabled: boolean;
  systemRevision: number;
  autonomousAllowed: boolean;
  blockers: SendModeBlockers;
}
const validRevision = (value: unknown): value is number =>
  Number.isInteger(value) &&
  (value as number) >= 0 &&
  (value as number) <= 2147483647;
const retryConflict = () =>
  Object.assign(new Error('SEND_MODE_CONFIGURATION_CHANGED'), {
    code: 'P2034',
  });

@Injectable()
export class SendModeService {
  constructor(private readonly db: PrismaService) {}

  private parseSystem(raw: unknown) {
    if (raw === undefined || raw === null)
      return {
        enabled: process.env.ACCOUNT_BOUND_SENDING_ENABLED === 'true',
        revision: 0,
      };
    const value = raw as { enabled: boolean; revision: number };
    if (
      !value ||
      typeof value.enabled !== 'boolean' ||
      !validRevision(value.revision) ||
      value.revision === 0
    )
      throw new ServiceUnavailableException('SEND_MODE_CONFIGURATION_INVALID');
    return { enabled: value.enabled, revision: value.revision };
  }

  private parseOrganization(raw: unknown): {
    mode: OrganizationSendingMode | null;
    revision: number;
  } {
    if (raw === undefined || raw === null) return { mode: null, revision: 0 };
    const value = raw as { mode: OrganizationSendingMode; revision: number };
    if (
      !value ||
      !['AUTONOMOUS', 'CONTROLLED'].includes(value.mode) ||
      !validRevision(value.revision) ||
      value.revision === 0
    )
      throw new ServiceUnavailableException('SEND_MODE_CONFIGURATION_INVALID');
    return { mode: value.mode, revision: value.revision };
  }

  private async systemIn(tx: Pick<Prisma.TransactionClient, 'settings'>) {
    const row = await tx.settings.findUnique({
      where: { key: SEND_MODE_SYSTEM_KEY },
    });
    const value = this.parseSystem(row?.value);
    const environmentOverride =
      process.env.ACCOUNT_BOUND_SENDING_ENABLED === 'false'
        ? ('DISABLED' as const)
        : null;
    return {
      key: SEND_MODE_SYSTEM_KEY,
      value,
      effectiveEnabled: environmentOverride ? false : value.enabled,
      environmentOverride,
    };
  }

  getSystem() {
    return this.systemIn(this.db);
  }

  private async blockersIn(
    tx: Prisma.TransactionClient,
    organizationId: string
  ): Promise<SendModeBlockers> {
    const scope = { organizationId };
    const legacy = {
      organizationId,
      deletedAt: null,
      sendIntentId: null,
      OR: [
        { executionProtocol: null },
        { executionProtocol: { not: 'ACCOUNT_BOUND_V1' } },
      ],
    };
    const counts = await Promise.all([
      tx.post.count({ where: { ...legacy, state: 'QUEUE' } }),
      // Autonomous manual replies can be submitted while their stored Post is still DRAFT.
      tx.post.count({ where: { ...legacy, source: 'engage', state: 'DRAFT' } }),
      tx.post.count({
        where: {
          ...legacy,
          state: { not: 'PUBLISHED' },
          releaseId: { not: null },
          claimedAt: { not: null },
        },
      }),
      tx.sendIntent.count({
        where: {
          ...scope,
          status: { notIn: ['SUCCEEDED', 'FAILED_FINAL', 'CANCELLED'] },
        },
      }),
      tx.sendExecution.count({
        where: {
          ...scope,
          status: { in: ['RESERVED', 'SENDING', 'RECONCILING'] },
        },
      }),
      tx.sendSegment.count({
        where: { ...scope, status: { in: ['AUTHORIZED', 'UNKNOWN'] } },
      }),
      tx.sendQuotaReservation.count({ where: { ...scope, state: 'HELD' } }),
      tx.accountWriteState.count({
        where: { ...scope, activeExecutionId: { not: null } },
      }),
      tx.post.count({
        where: {
          ...scope,
          deletedAt: null,
          executionProtocol: 'ACCOUNT_BOUND_V1',
          sendIntentId: null,
          state: { in: ['DRAFT', 'QUEUE'] },
        },
      }),
      this.pendingAutonomousIn(tx, organizationId).then((rows) => rows.length),
    ]);
    return Object.fromEntries(
      [
        'legacyQueuedPosts',
        'legacyReplyDrafts',
        'legacyClaims',
        'nonterminalIntents',
        'activeExecutions',
        'uncertainSegments',
        'heldQuotaReservations',
        'accountLocks',
        'controlledPendingPosts',
        'autonomousEffects',
      ].map((key, index) => [key, counts[index]])
    ) as unknown as SendModeBlockers;
  }

  private controlledObligations(blockers: SendModeBlockers) {
    return (
      blockers.nonterminalIntents +
      blockers.activeExecutions +
      blockers.uncertainSegments +
      blockers.heldQuotaReservations +
      blockers.accountLocks +
      blockers.controlledPendingPosts
    );
  }

  private async hasControlledHistory(
    tx: Prisma.TransactionClient,
    organizationId: string
  ) {
    const [intents, executions, accounts, posts] = await Promise.all([
      tx.sendIntent.count({ where: { organizationId } }),
      tx.sendExecution.count({ where: { organizationId } }),
      tx.accountWriteState.count({ where: { organizationId } }),
      tx.post.count({
        where: { organizationId, executionProtocol: 'ACCOUNT_BOUND_V1' },
      }),
    ]);
    return intents + executions + accounts + posts > 0;
  }

  async stateIn(
    tx: Prisma.TransactionClient,
    organizationId: string
  ): Promise<SendModeState> {
    const system = await this.systemIn(tx);
    const row = await tx.settings.findUnique({
      where: { key: organizationSendModeKey(organizationId) },
    });
    const configured = this.parseOrganization(row?.value);
    const blockers = await this.blockersIn(tx, organizationId);
    const history =
      configured.mode === null &&
      (await this.hasControlledHistory(tx, organizationId));
    const autonomousAllowed =
      configured.mode !== 'CONTROLLED' &&
      !history &&
      this.controlledObligations(blockers) === 0;
    const mode =
      configured.mode === 'CONTROLLED'
        ? system.effectiveEnabled && blockers.autonomousEffects === 0
          ? 'CONTROLLED'
          : 'PAUSED'
        : autonomousAllowed
        ? 'AUTONOMOUS'
        : 'PAUSED';
    return {
      organizationId,
      mode,
      configuredMode: configured.mode,
      revision: configured.revision,
      systemEnabled: system.effectiveEnabled,
      systemRevision: system.value.revision,
      autonomousAllowed,
      blockers,
    };
  }

  // Both configuration writers and send authorizers acquire rows in this order.
  private async lockSettingIn(tx: Prisma.TransactionClient, key: string) {
    const row = await tx.settings.findUnique({ where: { key } });
    if (!row) {
      // JSON null is an internal lock sentinel: absent configuration semantics remain unchanged.
      await tx.settings.create({
        data: { key, type: 'object', value: Prisma.JsonNull },
      });
      return;
    }
    const value =
      row.value === null
        ? Prisma.JsonNull
        : (row.value as Prisma.InputJsonValue);
    const result = await tx.settings.updateMany({
      where: { key, value: { equals: value } },
      data: { value, updatedAt: row.updatedAt },
    });
    if (result.count !== 1) throw retryConflict();
  }

  async lockIn(tx: Prisma.TransactionClient, organizationId: string) {
    await this.lockSettingIn(tx, SEND_MODE_SYSTEM_KEY);
    await this.lockSettingIn(tx, organizationSendModeKey(organizationId));
    return this.stateIn(tx, organizationId);
  }

  async assertControlledIn(
    tx: Prisma.TransactionClient,
    organizationId: string
  ) {
    const state = await this.lockIn(tx, organizationId);
    if (state.mode !== 'CONTROLLED')
      throw new ConflictException('SEND_MODE_CONTROLLED_REQUIRED');
    return state;
  }

  async assertAutonomousIn(
    tx: Prisma.TransactionClient,
    organizationId: string
  ) {
    const state = await this.lockIn(tx, organizationId);
    if (state.mode !== 'AUTONOMOUS' || !state.autonomousAllowed)
      throw new ConflictException('SEND_MODE_AUTONOMOUS_REQUIRED');
    return state;
  }

  async isControlled(organizationId: string, tx?: Prisma.TransactionClient) {
    const state = tx
      ? await this.stateIn(tx, organizationId)
      : await sendTransaction(this.db, (tx) =>
          this.stateIn(tx, organizationId)
        );
    return state.mode === 'CONTROLLED';
  }

  private async memberIn(
    tx: Prisma.TransactionClient,
    organizationId: string,
    userId: string
  ) {
    const member =
      userId &&
      (await tx.userOrganization.findUnique({
        where: { userId_organizationId: { userId, organizationId } },
      }));
    if (!member || member.disabled)
      throw new ForbiddenException('ORGANIZATION_MEMBERSHIP_REQUIRED');
    return member;
  }

  async get(organizationId: string, userId: string) {
    return sendTransaction(this.db, async (tx) => {
      const member = await this.memberIn(tx, organizationId, userId);
      return {
        ...(await this.stateIn(tx, organizationId)),
        userId,
        canManage: ['ADMIN', 'SUPERADMIN'].includes(member.role),
      };
    });
  }

  private validateMutation(
    body: SaveSendModeDto | SaveSystemSendModeDto | ResolveAutonomousEffectDto
  ) {
    if (
      !body ||
      !validRevision(body.expectedRevision) ||
      body.expectedRevision === 2147483647 ||
      typeof body.requestId !== 'string' ||
      !body.requestId.trim() ||
      body.requestId.length > 128
    )
      throw new BadRequestException('INVALID_SEND_MODE_MUTATION');
  }

  async save(organizationId: string, userId: string, body: SaveSendModeDto) {
    this.validateMutation(body);
    if (!['AUTONOMOUS', 'CONTROLLED'].includes(body.mode))
      throw new BadRequestException('INVALID_SEND_MODE_MUTATION');
    if (
      typeof body.expectedOrganizationId !== 'string' ||
      !body.expectedOrganizationId.trim() ||
      body.expectedOrganizationId.length > 128 ||
      typeof body.expectedUserId !== 'string' ||
      !body.expectedUserId.trim() ||
      body.expectedUserId.length > 128
    )
      throw new BadRequestException('INVALID_SEND_MODE_MUTATION');
    if (
      body.expectedOrganizationId !== organizationId ||
      body.expectedUserId !== userId
    )
      throw new ForbiddenException('SEND_OWNER_CHANGED');
    const requestHash = sendHash({
      mode: body.mode,
      expectedRevision: body.expectedRevision,
    });
    return sendTransaction(this.db, async (tx) => {
      const member = await this.memberIn(tx, organizationId, userId);
      if (!['ADMIN', 'SUPERADMIN'].includes(member.role))
        throw new ForbiddenException('ORGANIZATION_ADMIN_REQUIRED');
      const key = {
        organizationId,
        userId,
        operation: 'organization-send-mode',
        requestId: body.requestId,
      };
      const receipt = await tx.sendMutationReceipt.findUnique({
        where: { organizationId_userId_operation_requestId: key },
      });
      if (receipt) {
        if (receipt.requestHash !== requestHash)
          throw new ConflictException('REQUEST_ID_CONFLICT');
        return receipt.result as unknown as SendModeState & {
          canManage: boolean;
          userId: string;
        };
      }
      const current = await this.lockIn(tx, organizationId);
      if (current.revision !== body.expectedRevision)
        throw new ConflictException('SEND_MODE_REVISION_CONFLICT');
      if (body.mode === 'CONTROLLED' && !current.systemEnabled)
        throw new ServiceUnavailableException('ACCOUNT_BINDINGS_NOT_ENABLED');
      const blocked =
        body.mode === 'CONTROLLED'
          ? current.blockers.legacyQueuedPosts +
            current.blockers.legacyReplyDrafts +
            current.blockers.legacyClaims +
            current.blockers.autonomousEffects
          : this.controlledObligations(current.blockers) +
            current.blockers.autonomousEffects;
      if (
        (current.configuredMode !== body.mode && blocked > 0) ||
        (body.mode === 'CONTROLLED' && current.blockers.autonomousEffects > 0)
      )
        throw new ConflictException({
          code: 'SEND_MODE_SWITCH_UNSAFE',
          message: 'SEND_MODE_SWITCH_UNSAFE',
          blockers: current.blockers,
        });
      await tx.settings.updateMany({
        where: { key: organizationSendModeKey(organizationId) },
        data: { value: { mode: body.mode, revision: current.revision + 1 } },
      });
      const result = {
        ...(await this.stateIn(tx, organizationId)),
        userId,
        canManage: true,
      };
      await tx.sendMutationReceipt.create({
        data: { ...key, requestHash, result: sendJson(result) },
      });
      return result;
    });
  }

  async saveSystem(userId: string, body: SaveSystemSendModeDto) {
    this.validateMutation(body);
    if (typeof body.enabled !== 'boolean')
      throw new BadRequestException('INVALID_SEND_MODE_MUTATION');
    const requestHash = sendHash({
      enabled: body.enabled,
      expectedRevision: body.expectedRevision,
    });
    return sendTransaction(this.db, async (tx) => {
      if (
        !userId ||
        !(
          await tx.user.findUnique({
            where: { id: userId },
            select: { isSuperAdmin: true },
          })
        )?.isSuperAdmin
      )
        throw new ForbiddenException('PLATFORM_SUPERADMIN_REQUIRED');
      const key = { userId, requestId: `send-mode:${body.requestId}` };
      const receipt = await tx.systemSendPolicyMutationReceipt.findUnique({
        where: { userId_requestId: key },
      });
      if (receipt) {
        if (receipt.requestHash !== requestHash)
          throw new ConflictException('REQUEST_ID_CONFLICT');
        return receipt.result as unknown as Awaited<
          ReturnType<SendModeService['getSystem']>
        >;
      }
      await this.lockSettingIn(tx, SEND_MODE_SYSTEM_KEY);
      const current = await this.systemIn(tx);
      if (current.value.revision !== body.expectedRevision)
        throw new ConflictException('SEND_MODE_REVISION_CONFLICT');
      await tx.settings.updateMany({
        where: { key: SEND_MODE_SYSTEM_KEY },
        data: {
          value: {
            enabled: body.enabled,
            revision: current.value.revision + 1,
          },
        },
      });
      const result = await this.systemIn(tx);
      await tx.systemSendPolicyMutationReceipt.create({
        data: { ...key, requestHash, result: sendJson(result) },
      });
      return result;
    });
  }

  private async autonomousRecordsIn(
    tx: Prisma.TransactionClient,
    organizationId: string
  ) {
    const rows = await tx.sendMutationReceipt.findMany({
      where: { organizationId, operation: AUTONOMOUS_EFFECT_OPERATION },
      orderBy: { createdAt: 'asc' },
      select: { id: true, createdAt: true, result: true },
    });
    return rows.map((row) => ({ row, result: this.effectResult(row.result) }));
  }

  private async pendingAutonomousIn(
    tx: Prisma.TransactionClient,
    organizationId: string
  ) {
    const rows = await this.autonomousRecordsIn(tx, organizationId);
    return rows.filter(
      ({ result }) => !['CONFIRMED', 'NOT_SUBMITTED'].includes(result.status)
    );
  }

  private effectResult(raw: unknown): AutonomousEffectResult {
    const value = raw as AutonomousEffectResult;
    if (
      !value ||
      !['AUTHORIZED', 'UNKNOWN', 'CONFIRMED', 'NOT_SUBMITTED'].includes(
        value.status
      ) ||
      !validRevision(value.revision) ||
      value.revision === 0 ||
      !['POST', 'COMMENT', 'PLUG', 'INTERNAL_PLUG', 'THREAD_FINISHER'].includes(
        value.action
      ) ||
      typeof value.integrationId !== 'string'
    )
      throw new ServiceUnavailableException('AUTONOMOUS_EFFECT_RECORD_INVALID');
    if (
      (value.confirmedAt !== undefined &&
        (typeof value.confirmedAt !== 'string' ||
          !Number.isFinite(Date.parse(value.confirmedAt)))) ||
      ((value.quotaWriteKind !== undefined || value.quotaUnits !== undefined) &&
        (!['WRITE', 'REPLY'].includes(value.quotaWriteKind!) ||
          !validRevision(value.quotaUnits)))
    )
      throw new ServiceUnavailableException('AUTONOMOUS_EFFECT_RECORD_INVALID');
    if (
      value.postIds !== undefined &&
      (!Array.isArray(value.postIds) ||
        value.postIds.length > 100 ||
        value.postIds.some(
          (id) => typeof id !== 'string' || !id || id.length > 128
        ) ||
        new Set(value.postIds).size !== value.postIds.length)
    )
      throw new ServiceUnavailableException('AUTONOMOUS_EFFECT_RECORD_INVALID');
    if (
      value.targetPostId !== undefined &&
      (typeof value.targetPostId !== 'string' ||
        value.targetPostId.length > 2048)
    )
      throw new ServiceUnavailableException('AUTONOMOUS_EFFECT_RECORD_INVALID');
    if (
      ['POST', 'COMMENT'].includes(value.action) &&
      (!value.postIds?.length ||
        typeof value.occurrenceKey !== 'string' ||
        !value.occurrenceKey ||
        value.occurrenceKey.length > 2048 ||
        typeof value.recurring !== 'boolean')
    )
      throw new ServiceUnavailableException('AUTONOMOUS_EFFECT_RECORD_INVALID');
    return value;
  }

  private safeEffectResult(value: unknown): Prisma.JsonValue {
    if (value === undefined || value === null) return null;
    if (typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (Array.isArray(value))
      return value.map((item) => this.safeEffectResult(item));
    if (typeof value === 'object') {
      const keys = ['postId', 'releaseURL', 'status', 'id', 'releaseId', 'url'];
      return Object.fromEntries(
        Object.entries(value)
          .filter(([key, item]) => keys.includes(key) && item !== undefined)
          .map(([key, item]) => [key, this.safeEffectResult(item)])
      );
    }
    throw new ServiceUnavailableException('AUTONOMOUS_EFFECT_RESULT_INVALID');
  }

  async autonomousEffect<T>(
    organizationId: string,
    operationKey: string,
    request: AutonomousEffectRequest,
    work: () => Promise<T>
  ): Promise<T> {
    if (
      typeof operationKey !== 'string' ||
      !operationKey.trim() ||
      operationKey.length > 2048 ||
      !request ||
      typeof request.integrationId !== 'string' ||
      !request.integrationId ||
      !['POST', 'COMMENT', 'PLUG', 'INTERNAL_PLUG', 'THREAD_FINISHER'].includes(
        request.action
      ) ||
      ((request.quotaWriteKind !== undefined || request.quotaUnits !== undefined) &&
        (!['WRITE', 'REPLY'].includes(request.quotaWriteKind!) ||
          !validRevision(request.quotaUnits) || request.quotaUnits === 0))
    )
      throw new BadRequestException('INVALID_AUTONOMOUS_EFFECT');
    const requestId = sendHash(['autonomous-effect-v1', operationKey]);
    const requestHash = sendHash(request);
    const admitted = await sendTransaction(this.db, async (tx) => {
      const state = await this.lockIn(tx, organizationId);
      const prior = await tx.sendMutationReceipt.findFirst({
        where: {
          organizationId,
          operation: AUTONOMOUS_EFFECT_OPERATION,
          requestId,
        },
      });
      if (prior) {
        if (prior.requestHash !== requestHash)
          throw new ConflictException('AUTONOMOUS_EFFECT_REQUEST_CONFLICT');
        const result = this.effectResult(prior.result);
        if (result.status === 'CONFIRMED' && result.hasResult === true)
          return {
            replay: true as const,
            value: result.undefinedResult ? undefined : result.result,
          };
        if (result.status === 'NOT_SUBMITTED')
          throw new ConflictException('AUTONOMOUS_EFFECT_NOT_SUBMITTED');
        throw new ConflictException(
          'AUTONOMOUS_EFFECT_RECONCILIATION_REQUIRED'
        );
      }
      if (state.mode !== 'AUTONOMOUS' || !state.autonomousAllowed)
        throw new ConflictException('SEND_MODE_AUTONOMOUS_REQUIRED');
      const integration = await tx.integration.findFirst({
        where: {
          id: request.integrationId,
          organizationId,
          disabled: false,
          deletedAt: null,
        },
        select: { id: true },
      });
      if (!integration)
        throw new ForbiddenException('AUTONOMOUS_EFFECT_ACCOUNT_REQUIRED');
      const owner = await tx.userOrganization.findFirst({
        where: { organizationId, disabled: false },
        orderBy: { userId: 'asc' },
        select: { userId: true },
      });
      if (!owner)
        throw new ForbiddenException('ORGANIZATION_MEMBERSHIP_REQUIRED');
      const postIds = Array.isArray(request.postIds)
        ? request.postIds
        : undefined;
      if (
        postIds &&
        (postIds.length > 100 ||
          postIds.some(
            (id) => typeof id !== 'string' || !id || id.length > 128
          ) ||
          new Set(postIds).size !== postIds.length)
      )
        throw new BadRequestException('INVALID_AUTONOMOUS_EFFECT');
      const previousEffects = await this.autonomousRecordsIn(
        tx,
        organizationId
      );
      if (
        previousEffects.some(
          ({ result }) =>
            !['CONFIRMED', 'NOT_SUBMITTED'].includes(result.status) &&
            (result.integrationId === request.integrationId ||
              result.postIds?.some((id) => postIds?.includes(id)))
        )
      )
        throw new ConflictException(
          'AUTONOMOUS_EFFECT_RECONCILIATION_REQUIRED'
        );
      let occurrenceKey: string | undefined;
      let recurring = false;
      if (['POST', 'COMMENT'].includes(request.action)) {
        if (!postIds?.length)
          throw new BadRequestException('INVALID_AUTONOMOUS_EFFECT');
        const postSelect = {
          id: true,
          state: true,
          sendIntentId: true,
          executionProtocol: true,
          group: true,
          parentPostId: true,
          intervalInDays: true,
          publishDate: true,
        } as const;
        const posts = await tx.post.findMany({
          where: {
            organizationId,
            deletedAt: null,
            id: { in: postIds as string[] },
          },
          select: postSelect,
        });
        if (
          posts.length !== postIds.length ||
          posts.some(
            (post) =>
              post.state !== 'QUEUE' ||
              post.sendIntentId ||
              !isLegacyExecution(post.executionProtocol)
          )
        )
          throw new ConflictException('AUTONOMOUS_EFFECT_CONTENT_CHANGED');
        const first = posts.find((post) => post.id === postIds[0])!;
        if (
          (request.action === 'POST' && first.parentPostId) ||
          (request.action === 'COMMENT' && !first.parentPostId)
        )
          throw new ConflictException('AUTONOMOUS_EFFECT_CONTENT_CHANGED');
        // Recurring cycle clones share the group and have no parent. Only the
        // persisted parent chain identifies the root whose result authorizes a comment.
        let root = first;
        const ancestors = new Set([first.id]);
        while (root.parentPostId) {
          if (ancestors.has(root.parentPostId))
            throw new ConflictException('AUTONOMOUS_EFFECT_CONTENT_CHANGED');
          const parent = await tx.post.findFirst({
            where: {
              id: root.parentPostId,
              organizationId,
              deletedAt: null,
            },
            select: postSelect,
          });
          if (
            !parent ||
            parent.group !== first.group ||
            parent.sendIntentId ||
            !isLegacyExecution(parent.executionProtocol)
          )
            throw new ConflictException('AUTONOMOUS_EFFECT_CONTENT_CHANGED');
          ancestors.add(parent.id);
          root = parent;
        }
        if (
          !root ||
          root.sendIntentId ||
          !isLegacyExecution(root.executionProtocol)
        )
          throw new ConflictException('AUTONOMOUS_EFFECT_CONTENT_CHANGED');
        recurring =
          typeof root.intervalInDays === 'number' && root.intervalInDays > 0;
        const rootDate = recurring
          ? new Date(root.publishDate).toISOString()
          : 'single';
        if (request.action === 'POST') {
          occurrenceKey = rootDate;
          if (
            (request.occurrenceKey !== undefined || recurring) &&
            request.occurrenceKey !== occurrenceKey
          )
            throw new ConflictException('AUTONOMOUS_EFFECT_CONTENT_CHANGED');
        } else {
          if (
            typeof request.parentPostId !== 'string' ||
            !request.parentPostId ||
            (request.occurrenceKey !== undefined &&
              request.occurrenceKey !== request.parentPostId)
          )
            throw new ConflictException('AUTONOMOUS_EFFECT_CONTENT_CHANGED');
          occurrenceKey = request.parentPostId;
          const verifiedParent = previousEffects.some(
            ({ result }) =>
              result.action === 'POST' &&
              result.status === 'CONFIRMED' &&
              result.hasResult === true &&
              result.postIds?.includes(root.id) &&
              result.occurrenceKey === rootDate &&
              Array.isArray(result.result) &&
              result.result.some(
                (item) =>
                  item &&
                  typeof item === 'object' &&
                  !Array.isArray(item) &&
                  item.postId === request.parentPostId
              )
          );
          if (!verifiedParent)
            throw new ConflictException('AUTONOMOUS_EFFECT_CONTENT_CHANGED');
        }
      }
      if (
        postIds?.length &&
        previousEffects.some(
          ({ result }) =>
            result.postIds?.some((id) => postIds.includes(id)) &&
            !(
              recurring &&
              result.recurring === true &&
              result.status === 'CONFIRMED' &&
              result.hasResult === true &&
              result.occurrenceKey !== occurrenceKey
            )
        )
      )
        throw new ConflictException(
          'AUTONOMOUS_EFFECT_CONTENT_ALREADY_ADMITTED'
        );
      if (request.action === 'THREAD_FINISHER') {
        if (typeof request.mainPostId !== 'string' || !request.mainPostId)
          throw new BadRequestException('INVALID_AUTONOMOUS_EFFECT');
        const roots = await tx.post.findMany({
          where: {
            organizationId,
            integrationId: request.integrationId,
            releaseId: request.mainPostId,
          },
          select: { sendIntentId: true, executionProtocol: true },
        });
        if (
          roots.some(
            (root) =>
              root.sendIntentId || !isLegacyExecution(root.executionProtocol)
          )
        )
          throw new ConflictException('AUTONOMOUS_EFFECT_CONTENT_CHANGED');
      }
      const targetPostId = [
        request.mainPostId,
        request.postId,
        request.post,
        request.parentPostId,
      ].find((value) => typeof value === 'string') as string | undefined;
      if (targetPostId && targetPostId.length > 2048)
        throw new BadRequestException('INVALID_AUTONOMOUS_EFFECT');
      const result: AutonomousEffectResult = {
        status: 'AUTHORIZED',
        revision: 1,
        action: request.action,
        integrationId: request.integrationId,
        ...(postIds ? { postIds: postIds as string[] } : {}),
        ...(targetPostId ? { targetPostId } : {}),
        ...(occurrenceKey ? { occurrenceKey, recurring } : {}),
        ...(request.action === 'THREAD_FINISHER'
          ? { quotaWriteKind: 'REPLY' as const, quotaUnits: 1 }
          : request.quotaWriteKind !== undefined
          ? { quotaWriteKind: request.quotaWriteKind, quotaUnits: request.quotaUnits }
          : {}),
      };
      const receipt = await tx.sendMutationReceipt.create({
        data: {
          organizationId,
          userId: owner.userId,
          operation: AUTONOMOUS_EFFECT_OPERATION,
          requestId,
          requestHash,
          result: sendJson(result),
        },
      });
      return { replay: false as const, id: receipt.id };
    });
    if (admitted.replay) return admitted.value as T;
    try {
      // The remote call is deliberately outside the retryable database transaction.
      const returned = await work();
      const result = this.safeEffectResult(returned);
      await sendTransaction(this.db, async (tx) => {
        await this.lockIn(tx, organizationId);
        const row = await tx.sendMutationReceipt.findFirst({
          where: {
            id: admitted.id,
            organizationId,
            operation: AUTONOMOUS_EFFECT_OPERATION,
          },
        });
        const current = this.effectResult(row?.result);
        if (!['AUTHORIZED', 'UNKNOWN'].includes(current.status))
          throw new ConflictException(
            'AUTONOMOUS_EFFECT_RECONCILIATION_REQUIRED'
          );
        const saved = await tx.sendMutationReceipt.updateMany({
          where: {
            id: admitted.id,
            organizationId,
            result: { equals: row!.result as Prisma.InputJsonValue },
          },
          data: {
            result: sendJson({
              ...current,
              status: 'CONFIRMED',
              revision: current.revision + 1,
              confirmedAt: new Date().toISOString(),
              ...(current.action === 'PLUG' && returned === false &&
                current.quotaWriteKind !== undefined && current.quotaUnits !== undefined
                ? { quotaUnits: 0 }
                : {}),
              hasResult: true,
              undefinedResult: returned === undefined,
              result,
            }),
          },
        });
        if (saved.count !== 1) throw retryConflict();
      });
      return (returned === undefined ? undefined : result) as T;
    } catch {
      // A crash or failed result write never releases this durable admission for retry.
      await sendTransaction(this.db, async (tx) => {
        await this.lockIn(tx, organizationId);
        const row = await tx.sendMutationReceipt.findFirst({
          where: {
            id: admitted.id,
            organizationId,
            operation: AUTONOMOUS_EFFECT_OPERATION,
          },
        });
        const current = this.effectResult(row?.result);
        if (!['AUTHORIZED', 'UNKNOWN'].includes(current.status)) return;
        const saved = await tx.sendMutationReceipt.updateMany({
          where: {
            id: admitted.id,
            organizationId,
            result: { equals: row!.result as Prisma.InputJsonValue },
          },
          data: {
            result: sendJson({
              ...current,
              status: 'UNKNOWN',
              revision: current.revision + 1,
            }),
          },
        });
        if (saved.count !== 1) throw retryConflict();
      }).catch(() => undefined);
      throw new ConflictException('AUTONOMOUS_EFFECT_RECONCILIATION_REQUIRED');
    }
  }

  private effectView(
    row: { id: string; createdAt: Date },
    result: AutonomousEffectResult
  ) {
    return {
      id: row.id,
      action: result.action,
      integrationId: result.integrationId,
      status: result.status,
      revision: result.revision,
      createdAt: row.createdAt.toISOString(),
      ...(result.postIds ? { postIds: result.postIds } : {}),
      ...(result.targetPostId ? { targetPostId: result.targetPostId } : {}),
    };
  }

  async listAutonomousEffects(organizationId: string, userId: string) {
    return sendTransaction(this.db, async (tx) => {
      const member = await this.memberIn(tx, organizationId, userId);
      if (!['ADMIN', 'SUPERADMIN'].includes(member.role))
        throw new ForbiddenException('ORGANIZATION_ADMIN_REQUIRED');
      const rows = await this.pendingAutonomousIn(tx, organizationId);
      return {
        organizationId,
        userId,
        items: rows
          .slice(0, 100)
          .map(({ row, result }) => this.effectView(row, result)),
      };
    });
  }

  async resolveAutonomousEffect(
    organizationId: string,
    userId: string,
    id: string,
    body: ResolveAutonomousEffectDto
  ) {
    this.validateMutation(body);
    if (
      !body ||
      !['CONFIRMED', 'NOT_SUBMITTED'].includes(body.decision) ||
      body.executorStopped !== true ||
      body.noPendingSubmit !== true ||
      typeof body.evidence !== 'string' ||
      !body.evidence.trim() ||
      body.evidence.length > 2000 ||
      typeof body.expectedOrganizationId !== 'string' ||
      typeof body.expectedUserId !== 'string'
    )
      throw new BadRequestException('INVALID_AUTONOMOUS_EFFECT_RESOLUTION');
    if (
      body.expectedOrganizationId !== organizationId ||
      body.expectedUserId !== userId
    )
      throw new ForbiddenException('SEND_OWNER_CHANGED');
    return sendTransaction(this.db, async (tx) => {
      const member = await this.memberIn(tx, organizationId, userId);
      if (!['ADMIN', 'SUPERADMIN'].includes(member.role))
        throw new ForbiddenException('ORGANIZATION_ADMIN_REQUIRED');
      await this.lockIn(tx, organizationId);
      const key = {
        organizationId,
        userId,
        operation: 'autonomous-effect-resolution',
        requestId: body.requestId,
      };
      const requestHash = sendHash({
        id,
        decision: body.decision,
        expectedRevision: body.expectedRevision,
        evidence: body.evidence,
      });
      const receipt = await tx.sendMutationReceipt.findUnique({
        where: { organizationId_userId_operation_requestId: key },
      });
      if (receipt) {
        if (receipt.requestHash !== requestHash)
          throw new ConflictException('REQUEST_ID_CONFLICT');
        return receipt.result as unknown as ReturnType<
          SendModeService['effectView']
        >;
      }
      const row = await tx.sendMutationReceipt.findFirst({
        where: { id, organizationId, operation: AUTONOMOUS_EFFECT_OPERATION },
      });
      if (!row) throw new BadRequestException('AUTONOMOUS_EFFECT_NOT_FOUND');
      const previous = this.effectResult(row.result);
      if (previous.revision !== body.expectedRevision)
        throw new ConflictException('AUTONOMOUS_EFFECT_REVISION_CONFLICT');
      if (!['AUTHORIZED', 'UNKNOWN'].includes(previous.status))
        throw new ConflictException('AUTONOMOUS_EFFECT_ALREADY_RESOLVED');
      const resolved: AutonomousEffectResult = {
        ...previous,
        status: body.decision,
        revision: previous.revision + 1,
        evidence: body.evidence,
        resolvedByUserId: userId,
        ...(body.decision === 'CONFIRMED'
          ? { confirmedAt: new Date().toISOString() }
          : {}),
      };
      const saved = await tx.sendMutationReceipt.updateMany({
        where: {
          id,
          organizationId,
          result: { equals: row.result as Prisma.InputJsonValue },
        },
        data: { result: sendJson(resolved) },
      });
      if (saved.count !== 1) throw retryConflict();
      const result = this.effectView(row, resolved);
      await tx.sendMutationReceipt.create({
        data: { ...key, requestHash, result: sendJson(result) },
      });
      return result;
    });
  }
}
