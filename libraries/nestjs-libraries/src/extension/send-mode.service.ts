import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma/prisma.service';
import { canonicalSendAccount, sendHash, sendJson, sendTransaction } from './send-coordination.utils';
import {
  BeginBrowserWriteDto,
  BrowserWriteOutcomeDto,
  BrowserReplyRecoveryDto,
  CancelSendModeTransitionDto,
  ResolveAutonomousEffectDto,
  ResolveLegacyReplyRecoveryDto,
  SaveSendModeDto,
  SaveSystemSendModeDto,
} from './send-mode.dto';
import { TERMINAL_SEND_INTENT_STATUSES, parseControlledDrain, handoverControlledIn, controlledDrainStateIn, controlledDrainAllowsIn, assertAutonomousAccountIn } from './send-mode-handover';
import { isLegacyExecution } from './legacy-execution';
import { canonicalControlledPlatform } from './controlled-platforms';

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
  source?: 'BROWSER';
  platform?: string;
  browserUserId?: string;
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
  legacyClaim?: { releaseId: string; claimedAt: string };
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
interface PendingSendModeTransition {
  version: 1 | 2;
  targetMode: 'CONTROLLED';
  requestedAt: string;
  requestedByUserId: string;
  eligiblePostIds: string[];
  eligiblePostOccurrences: Record<string, string | null>;
  initialPendingCount: number;
  effectReceiptIds?: string[];
}
interface PendingReallocation {
  version: 1;
  requestedAt: string;
  requestedByUserId: string;
  initialCount: number;
  blockedPostIds?: string[];
  issues: Array<{ postId: string; code: string }>;
}
export interface SendModeTransitionState {
  targetMode: OrganizationSendingMode;
  status: 'DRAINING' | 'NEEDS_ATTENTION';
  requestedAt: string;
  requestedByUserId: string;
  initialPendingCount: number;
  remainingCount: number;
  completedCount: number;
  scheduledNotBefore: string | null;
  estimatedCompletionAt: null;
  waitReason:
    | 'SCHEDULED_WORK'
    | 'IN_FLIGHT'
    | 'RECONCILIATION_REQUIRED'
    | 'SYSTEM_DISABLED'
    | 'RECURRING_SCHEDULE'
    | null;
  lastCheckedAt: string;
  pendingByKind: Record<string, number>;
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
  transition: SendModeTransitionState | null;
  legacyDrain: SendModeTransitionState | null;
  controlledDrain?: (SendModeTransitionState & { issues: Array<{ postId: string; code: string }> }) | null;
  reallocation: { remainingCount: number; completedCount: number; blockedCount: number;
    issues: Array<{ postId: string; code: string }> } | null;
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
  private readonly logger = new Logger(SendModeService.name);

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
    transition: PendingSendModeTransition | null;
    legacyDrain: PendingSendModeTransition | null;
  } {
    if (raw === undefined || raw === null)
      return { mode: null, revision: 0, transition: null, legacyDrain: null };
    const value = raw as {
      mode: OrganizationSendingMode;
      revision: number;
      transition?: PendingSendModeTransition;
      legacyDrain?: PendingSendModeTransition;
    };
    if (
      !value ||
      !['AUTONOMOUS', 'CONTROLLED'].includes(value.mode) ||
      !validRevision(value.revision) ||
      value.revision === 0
    )
      throw new ServiceUnavailableException('SEND_MODE_CONFIGURATION_INVALID');
    if ((value.transition != null && value.mode !== 'AUTONOMOUS') ||
        (value.transition != null && value.legacyDrain != null))
      throw new ServiceUnavailableException('SEND_MODE_CONFIGURATION_INVALID');
    const pending = value.transition ?? value.legacyDrain;
    if (
      pending != null &&
      (![1, 2].includes(pending.version) ||
        pending.targetMode !== 'CONTROLLED' ||
        typeof pending.requestedAt !== 'string' ||
        !Number.isFinite(Date.parse(pending.requestedAt)) ||
        typeof pending.requestedByUserId !== 'string' ||
        !pending.requestedByUserId.trim() ||
        pending.requestedByUserId.length > 128 ||
        !Array.isArray(pending.eligiblePostIds) ||
        pending.eligiblePostIds.length > 5000 ||
        pending.eligiblePostIds.some(
          (id) => typeof id !== 'string' || !id || id.length > 128
        ) ||
        new Set(pending.eligiblePostIds).size !==
          pending.eligiblePostIds.length ||
        (pending.effectReceiptIds !== undefined && (!Array.isArray(pending.effectReceiptIds) ||
          pending.effectReceiptIds.length > 5000 || pending.effectReceiptIds.some(id =>
            typeof id !== 'string' || !id || id.length > 128))) ||
        !validRevision(pending.initialPendingCount) ||
        pending.initialPendingCount < pending.eligiblePostIds.length ||
        !pending.eligiblePostOccurrences ||
        typeof pending.eligiblePostOccurrences !== 'object' ||
        Array.isArray(pending.eligiblePostOccurrences) ||
        Object.keys(pending.eligiblePostOccurrences).length !==
          pending.eligiblePostIds.length ||
        pending.eligiblePostIds.some(
          (id) =>
            !Object.prototype.hasOwnProperty.call(
              pending.eligiblePostOccurrences,
              id
            ) ||
            (pending.eligiblePostOccurrences[id] !== null &&
              (typeof pending.eligiblePostOccurrences[id] !== 'string' ||
                !Number.isFinite(
                  Date.parse(pending.eligiblePostOccurrences[id]!)
                )))
        ))
    )
      throw new ServiceUnavailableException('SEND_MODE_CONFIGURATION_INVALID');
    return {
      mode: value.mode,
      revision: value.revision,
      transition: value.transition ?? null,
      legacyDrain: value.legacyDrain ?? null,
    };
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
    const legacy: Prisma.PostWhereInput = {
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
          status: { notIn: TERMINAL_SEND_INTENT_STATUSES },
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
    const reverse = parseControlledDrain(row?.value);
    const blockers = await this.blockersIn(tx, organizationId);
    const history =
      configured.mode === null &&
      (await this.hasControlledHistory(tx, organizationId));
    const autonomousAllowed =
      configured.mode !== 'CONTROLLED' &&
      !history &&
      (this.controlledObligations(blockers) === 0 || reverse !== null);
    const mode =
      configured.mode === 'CONTROLLED'
        ? system.effectiveEnabled
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
      transition: configured.transition
        ? await this.transitionStateIn(
            tx,
            organizationId,
            configured.transition,
            system.effectiveEnabled
          )
        : null,
      legacyDrain: configured.legacyDrain
        ? await this.transitionStateIn(tx, organizationId, configured.legacyDrain, system.effectiveEnabled)
        : null,
      controlledDrain: reverse ? await controlledDrainStateIn(tx, organizationId, reverse, blockers) : null,
      reallocation: configured.mode === 'CONTROLLED' ? await this.reallocationStateIn(tx, organizationId, row?.value) : null,
    };
  }

  private async pendingPostsIn(
    tx: Prisma.TransactionClient,
    organizationId: string
  ) {
    const setting = await tx.settings.findUnique({ where: { key: organizationSendModeKey(organizationId) } });
    const config = this.parseOrganization(setting?.value);
    const captured = config.legacyDrain ?? config.transition;
    const capturedIds = captured?.eligiblePostIds ?? [];
    const records = await this.autonomousRecordsIn(tx, organizationId);
    const evidencedIds = [...new Set(records.filter(({ result }) => result.status !== 'NOT_SUBMITTED')
      .flatMap(({ result }) => result.postIds ?? []))];
    const posts = await tx.post.findMany({
      where: {
        organizationId,
        OR: [{ deletedAt: null }, { releaseId: { not: null } }, { id: { in: capturedIds } }],
        sendIntentId: null,
        AND: [
          {
            OR: [
              { executionProtocol: null },
              { executionProtocol: { not: 'ACCOUNT_BOUND_V1' } },
            ],
          },
          {
            OR: [
              { id: { in: capturedIds } },
              { id: { in: evidencedIds }, state: { not: 'PUBLISHED' } },
              { state: 'QUEUE' },
              { state: 'DRAFT', parentPostId: { not: null } },
              {
                state: { not: 'PUBLISHED' },
                releaseId: { not: null },
                claimedAt: { not: null },
              },
            ],
          },
        ],
      },
      select: {
        id: true,
        state: true,
        publishDate: true,
        releaseId: true,
        claimedAt: true,
        intervalInDays: true,
        source: true,
        parentPostId: true,
        releaseURL: true,
        createdAt: true,
        sendIntentId: true,
        executionProtocol: true,
        integrationId: true,
        providerIdentifier: true,
        publishMethod: true,
      },
      take: 5001,
    });
    if (posts.length > 5000)
      throw new ConflictException('SEND_MODE_TRANSITION_TOO_LARGE');
    const byId = new Map(posts.map(post => [post.id, post]));
    const missingParentIds = [...new Set(posts.map(post => post.parentPostId)
      .filter((id): id is string => !!id && !byId.has(id)))];
    // Absence from the work query does not mean a thread has already started:
    // ordinary draft and failed roots are deliberately outside that query.
    const parents = missingParentIds.length ? await tx.post.findMany({
      where: { organizationId, deletedAt: null, id: { in: missingParentIds } },
      select: { id: true, state: true, releaseId: true, releaseURL: true,
        publishDate: true, executionProtocol: true, sendIntentId: true },
    }) : [];
    const parentById = new Map(parents.map(post => [post.id, post]));
    const active = new Set(posts.filter(post => {
      if (post.state === 'PUBLISHED') return false;
      if (post.releaseId || post.releaseURL) return true;
      if (!post.parentPostId) return false;
      const parent = byId.get(post.parentPostId) ?? parentById.get(post.parentPostId);
      if (byId.has(post.parentPostId) && parent?.state !== 'PUBLISHED') return false;
      return !parent || parent.state === 'PUBLISHED' || !!parent.releaseId || !!parent.releaseURL ||
        !!parent.sendIntentId || !isLegacyExecution(parent.executionProtocol);
    }).map(post => post.id));
    // A background error/lease reset is not proof that an admitted send stopped.
    // Durable captured ownership survives volatile task fields until settlement.
    for (const post of posts) {
      if (!capturedIds.includes(post.id) || post.state === 'PUBLISHED') continue;
      // v1 also captured untouched future queue rows; retain only its failed
      // records here, leaving live claims and receipts to the evidence below.
      if (!config.legacyDrain && captured?.version === 1 && post.state !== 'ERROR') continue;
      const ancestry = new Set([post.id]);
      let parent = post.parentPostId;
      while (parent && !ancestry.has(parent)) {
        ancestry.add(parent); parent = byId.get(parent)?.parentPostId ?? null;
      }
      const stopped = !post.releaseId && !post.releaseURL && records.some(({ row, result }) =>
        captured?.effectReceiptIds?.includes(row.id) && result.status === 'NOT_SUBMITTED' &&
        result.postIds?.some(id => ancestry.has(id) && (!result.recurring ||
          result.occurrenceKey === captured.eligiblePostOccurrences[id])));
      if (!stopped) active.add(post.id);
    }
    for (const { result } of records) {
      if (result.status === 'NOT_SUBMITTED') continue;
      for (const id of result.postIds ?? []) {
        const post = byId.get(id) ?? parentById.get(id);
        if (post && post.state !== 'PUBLISHED' && (!result.recurring || Date.parse(result.occurrenceKey ?? '') === new Date(post.publishDate).getTime()))
          active.add(id);
      }
    }
    // Keep an already started thread with its original executor and account.
    const neighbors = new Map<string, string[]>();
    for (const post of posts) {
      if (!post.parentPostId) continue;
      neighbors.set(post.id, [...(neighbors.get(post.id) ?? []), post.parentPostId]);
      neighbors.set(post.parentPostId, [...(neighbors.get(post.parentPostId) ?? []), post.id]);
    }
    const queue = [...active];
    for (let index = 0; index < queue.length; index++) {
      for (const id of neighbors.get(queue[index]) ?? []) {
        if (!active.has(id)) { active.add(id); queue.push(id); }
      }
    }
    return posts.filter(post => post.state !== 'PUBLISHED' && active.has(post.id));
  }

  private parseReallocation(raw: unknown): PendingReallocation | null {
    const marker = (raw as { reallocation?: PendingReallocation } | null)?.reallocation;
    if (marker == null) return null;
    if (marker.version !== 1 || typeof marker.requestedByUserId !== 'string' || !marker.requestedByUserId ||
      marker.requestedByUserId.length > 128 || typeof marker.requestedAt !== 'string' || !Number.isFinite(Date.parse(marker.requestedAt)) ||
      !validRevision(marker.initialCount) || marker.initialCount > 5000 ||
      (marker.blockedPostIds !== undefined && (!Array.isArray(marker.blockedPostIds) || marker.blockedPostIds.length > 5000 ||
        marker.blockedPostIds.some(id => typeof id !== 'string' || !id || id.length > 128))) || !Array.isArray(marker.issues) || marker.issues.length > 100 ||
      marker.issues.some(issue => !issue || typeof issue.postId !== 'string' || typeof issue.code !== 'string' ||
        !issue.postId || issue.postId.length > 128 || !/^[A-Z][A-Z0-9_]{2,100}$/.test(issue.code)))
      throw new ServiceUnavailableException('SEND_MODE_REALLOCATION_INVALID');
    return marker;
  }

  private async reallocationPostsIn(tx: Prisma.TransactionClient, organizationId: string) {
    const posts = await tx.post.findMany({ where: { organizationId, deletedAt: null,
      sendIntentId: null, state: 'QUEUE', OR: [{ executionProtocol: null },
        { executionProtocol: { not: 'ACCOUNT_BOUND_V1' } }] }, select: { id: true, parentPostId: true }, take: 5001 });
    if (posts.length > 5000) throw new ConflictException('SEND_MODE_REALLOCATION_TOO_LARGE');
    const active = new Set((await this.pendingPostsIn(tx, organizationId)).map(post => post.id));
    return posts.filter(post => !active.has(post.id));
  }

  private async newReallocationIn(tx: Prisma.TransactionClient, organizationId: string, userId: string): Promise<PendingReallocation | null> {
    const posts = await this.reallocationPostsIn(tx, organizationId);
    return posts.length ? { version: 1 as const, requestedAt: new Date().toISOString(),
      requestedByUserId: userId, initialCount: posts.length, issues: [] } : null;
  }

  private async reallocationStateIn(tx: Prisma.TransactionClient, organizationId: string, raw: unknown) {
    const marker = this.parseReallocation(raw);
    if (!marker) return null;
    const posts = await this.reallocationPostsIn(tx, organizationId);
    const ids = new Set(posts.map(post => post.id));
    const owner = await tx.userOrganization.findUnique({ where: { userId_organizationId: {
      organizationId, userId: marker.requestedByUserId,
    } } });
    const issues = !owner || owner.disabled
      ? posts.slice(0, 100).map(post => ({ postId: post.id, code: 'ORGANIZATION_MEMBERSHIP_REQUIRED' }))
      : marker.issues.filter(issue => ids.has(issue.postId));
    const blocked = new Set(marker.blockedPostIds ?? marker.issues.map(issue => issue.postId));
    const children = new Map<string, string[]>();
    for (const post of posts) {
      if (post.parentPostId) children.set(post.parentPostId, [...(children.get(post.parentPostId) ?? []), post.id]);
    }
    // Progress uses queued post rows, including every segment of a blocked root.
    const queue = [...blocked];
    for (let index = 0; index < queue.length; index++) {
      for (const id of children.get(queue[index]) ?? []) {
        if (!blocked.has(id)) { blocked.add(id); queue.push(id); }
      }
    }
    return { remainingCount: posts.length, completedCount: Math.max(0, marker.initialCount - posts.length),
      blockedCount: !owner || owner.disabled ? posts.length : posts.filter(post => blocked.has(post.id)).length, issues };
  }

  async pendingReallocations() {
    const rows = await this.db.settings.findMany({ where: { key: { startsWith: SEND_MODE_ORGANIZATION_PREFIX },
      value: { path: ['reallocation', 'version'], equals: 1 } } });
    return rows.flatMap(row => {
      const marker = this.parseReallocation(row.value);
      const config = this.parseOrganization(row.value);
      return marker && config.mode === 'CONTROLLED' ? [{
        organizationId: row.key.slice(SEND_MODE_ORGANIZATION_PREFIX.length), userId: marker.requestedByUserId,
      }] : [];
    });
  }

  async recordReallocationIssues(organizationId: string, issues: Array<{ postId: string; code: string }>) {
    return sendTransaction(this.db, async tx => {
      await this.lockIn(tx, organizationId);
      const row = await tx.settings.findUnique({ where: { key: organizationSendModeKey(organizationId) } });
      const marker = this.parseReallocation(row?.value);
      if (!marker || this.parseOrganization(row?.value).mode !== 'CONTROLLED') return;
      const posts = await this.reallocationPostsIn(tx, organizationId);
      const ids = new Set(posts.map(post => post.id));
      const { reallocation: _old, ...value } = row!.value as Prisma.JsonObject;
      const currentIssues = issues.filter(issue => ids.has(issue.postId));
      await tx.settings.updateMany({ where: { key: row!.key }, data: { value: sendJson({ ...value,
        ...(posts.length ? { reallocation: { ...marker,
          blockedPostIds: [...new Set(currentIssues.map(issue => issue.postId))], issues: currentIssues.slice(0, 100) } } : {}),
      }) } });
    });
  }

  private pendingCount(
    postIds: string[],
    effects: Awaited<ReturnType<SendModeService['pendingAutonomousIn']>>
  ) {
    const ids = new Set(postIds);
    let standalone = 0;
    for (const { result } of effects) {
      if (result.postIds?.length) result.postIds.forEach((id) => ids.add(id));
      else standalone++;
    }
    return ids.size + standalone;
  }

  private async transitionStateIn(
    tx: Prisma.TransactionClient,
    organizationId: string,
    pending: PendingSendModeTransition,
    systemEnabled: boolean
  ): Promise<SendModeTransitionState> {
    const [remainingPosts, effects, owner] = await Promise.all([
      this.pendingPostsIn(tx, organizationId),
      this.pendingAutonomousIn(tx, organizationId),
      tx.userOrganization.findUnique({
        where: {
          userId_organizationId: {
            userId: pending.requestedByUserId,
            organizationId,
          },
        },
      }),
    ]);
    const existing = await tx.post.findMany({ where: { organizationId, id: { in: pending.eligiblePostIds } }, select: { id: true } });
    const existingIds = new Set(existing.map(post => post.id));
    const missingIds = pending.eligiblePostIds.filter(id => !existingIds.has(id));
    const remainingCount = this.pendingCount(
      [...remainingPosts.map(post => post.id), ...missingIds], effects
    );
    const pacing = await tx.settings.findUnique({
      where: { key: 'engage_reply_pacing' },
    });
    const configuredReplyLease =
      pacing?.value && typeof pacing.value === 'object' && !Array.isArray(pacing.value)
        ? Number(pacing.value.claimLeaseMinutes)
        : 0;
    // Mirror the executor lease windows for diagnostics only; never clear claims.
    const publishLeaseMinutes = Math.max(
      1,
      Number(process.env.EXTENSION_PUBLISH_LEASE_MINUTES) || 10
    );
    const replyLeaseMinutes = Number.isFinite(configuredReplyLease) && configuredReplyLease > 0
      ? configuredReplyLease : 30;
    const receipts = await this.autonomousRecordsIn(tx, organizationId);
    const needsReconciliation = missingIds.length > 0 ||
      remainingPosts.some(post =>
        !!post.releaseURL ||
        (post.parentPostId && !remainingPosts.some(parent => parent.id === post.parentPostId)) ||
        receipts.some(({ result }) => result.status === 'CONFIRMED' && result.postIds?.includes(post.id) &&
          !(result.recurring && result.occurrenceKey !== new Date(post.publishDate).toISOString()))) ||
      effects.some(
        ({ result, row }) =>
          result.status === 'UNKNOWN' ||
          Date.now() - new Date(row.createdAt).getTime() > 600_000
      ) ||
      remainingPosts.some(
        (post) =>
          post.state !== 'QUEUE' ||
          (post.releaseId && post.claimedAt &&
            Date.now() - new Date(post.claimedAt).getTime() >
              (post.source === 'engage' ? replyLeaseMinutes : publishLeaseMinutes) * 60_000) ||
          !pending.eligiblePostIds.includes(post.id) ||
          pending.eligiblePostOccurrences[post.id] !==
            (post.publishDate &&
            Number.isFinite(new Date(post.publishDate).getTime())
              ? new Date(post.publishDate).toISOString()
              : null)
      ) ||
      !owner ||
      owner.disabled ||
      !['ADMIN', 'SUPERADMIN'].includes(owner.role);
    const scheduledNotBefore: string | null = null;
    const waitReason = !systemEnabled
      ? 'SYSTEM_DISABLED'
      : needsReconciliation
      ? 'RECONCILIATION_REQUIRED'
      : remainingCount
      ? 'IN_FLIGHT'
      : null;
    return {
      targetMode: pending.targetMode,
      status:
        !systemEnabled || needsReconciliation
          ? 'NEEDS_ATTENTION'
          : 'DRAINING',
      requestedAt: pending.requestedAt,
      requestedByUserId: pending.requestedByUserId,
      initialPendingCount: pending.initialPendingCount,
      remainingCount,
      completedCount: Math.max(0, pending.initialPendingCount - remainingCount),
      scheduledNotBefore,
      estimatedCompletionAt: null,
      waitReason,
      lastCheckedAt: new Date().toISOString(),
      pendingByKind: {
        queuedPosts: remainingPosts.filter((post) => post.state === 'QUEUE')
          .length,
        claimedPosts: remainingPosts.filter(
          (post) => post.releaseId && post.claimedAt
        ).length,
        autonomousEffects: effects.length,
      },
    };
  }

  private async normalizeTransitionIn(tx: Prisma.TransactionClient, organizationId: string, previous: PendingSendModeTransition): Promise<PendingSendModeTransition> {
    if (previous.version === 2) return { ...previous,
      effectReceiptIds: previous.effectReceiptIds ?? (await this.pendingAutonomousIn(tx, organizationId)).map(({ row }) => row.id) };
    const activePosts = await this.pendingPostsIn(tx, organizationId);
    const active = new Map(activePosts.map(post => [post.id, post]));
    const existing = await tx.post.findMany({ where: { organizationId,
      id: { in: previous.eligiblePostIds } }, select: { id: true } });
    const existingIds = new Set(existing.map(post => post.id));
    // Old cleanup could delete a claimed row without stopping its executor.
    // Missing captured work remains uncertain; absence never proves settlement.
    const eligible = previous.eligiblePostIds.filter(id => active.has(id) || !existingIds.has(id));
    const captured = new Set(eligible);
    const anchors = new Set(eligible.filter(id => {
      const post = active.get(id);
      return !!post && previous.eligiblePostOccurrences[id] ===
        (post.publishDate ? new Date(post.publishDate).toISOString() : null);
    }));
    const completedAncestors = await tx.post.findMany({
      where: { organizationId, deletedAt: null, state: 'PUBLISHED',
        id: { in: previous.eligiblePostIds.filter(id => !active.has(id)) } },
      select: { id: true, publishDate: true, intervalInDays: true },
    });
    const facts = await this.autonomousRecordsIn(tx, organizationId);
    for (const ancestor of completedAncestors) {
      const sameOccurrence = previous.eligiblePostOccurrences[ancestor.id] ===
        new Date(ancestor.publishDate).toISOString();
      const confirmedSingle = !ancestor.intervalInDays && facts.some(({ result }) =>
        result.status === 'CONFIRMED' && result.recurring === false &&
        result.occurrenceKey === 'single' && result.postIds?.includes(ancestor.id));
      if (sameOccurrence || confirmedSingle) anchors.add(ancestor.id);
    }
    const occurrences = Object.fromEntries(eligible.map(id => [id, previous.eligiblePostOccurrences[id]]));
    // v1 captured queue rows, but its executor also expanded existing
    // draft continuations. Recover only that already recorded chain.
    for (const post of activePosts) {
      if (post.state !== 'DRAFT' || !post.parentPostId || captured.has(post.id) ||
          new Date(post.createdAt).getTime() > Date.parse(previous.requestedAt)) continue;
      let ancestor = post.parentPostId;
      const seen = new Set([post.id]);
      while (!anchors.has(ancestor)) {
        if (seen.has(ancestor)) break;
        seen.add(ancestor);
        const parent = active.get(ancestor);
        if (!parent?.parentPostId || new Date(parent.createdAt).getTime() > Date.parse(previous.requestedAt)) break;
        ancestor = parent.parentPostId;
      }
      if (!anchors.has(ancestor)) continue;
      captured.add(post.id);
      anchors.add(post.id);
      eligible.push(post.id);
      occurrences[post.id] = post.publishDate ? new Date(post.publishDate).toISOString() : null;
    }
    const effects = await this.pendingAutonomousIn(tx, organizationId);
    return { ...previous, version: 2, eligiblePostIds: eligible,
      eligiblePostOccurrences: occurrences, effectReceiptIds: effects.map(({ row }) => row.id),
      initialPendingCount: this.pendingCount(eligible, effects) };
  }

  async reconcilePendingTransitions() {
    const rows = await this.db.settings.findMany({
      where: {
        key: { startsWith: SEND_MODE_ORGANIZATION_PREFIX },
        OR: [{ value: { path: ['transition', 'targetMode'], equals: 'CONTROLLED' } },
          { value: { path: ['legacyDrain', 'targetMode'], equals: 'CONTROLLED' } },
          { value: { path: ['controlledDrain', 'targetMode'], equals: 'AUTONOMOUS' } }],
      },
      select: { key: true },
    });
    const results = [];
    for (const row of rows) {
      const organizationId = row.key.slice(
        SEND_MODE_ORGANIZATION_PREFIX.length
      );
      try {
        results.push(
          await sendTransaction(this.db, async (tx) => {
            let state = await this.lockIn(tx, organizationId);
            const stored = await tx.settings.findUnique({ where: { key: row.key } });
            const previous = this.parseOrganization(stored?.value).transition;
            if (previous?.version === 1) {
              const normalized = await this.normalizeTransitionIn(tx, organizationId, previous);
              await tx.settings.updateMany({ where: { key: row.key }, data: { value: sendJson({
                mode: 'AUTONOMOUS', revision: state.revision, transition: normalized,
              }) } });
              state = await this.stateIn(tx, organizationId);
            }
            const setting = await tx.settings.findUnique({ where: { key: row.key } });
            const config = this.parseOrganization(setting?.value);
            const reverse = parseControlledDrain(setting?.value);
            if (config.mode === 'AUTONOMOUS' && reverse) {
              const { controlledDrain: _reverse, legacyDrain: _legacy, reallocation: _allocation, ...rest } = setting!.value as Prisma.JsonObject;
              await tx.settings.updateMany({ where: { key: row.key }, data: { value: sendJson({ ...rest,
                ...(state.controlledDrain?.remainingCount ? { controlledDrain: reverse } : {}),
                ...(state.legacyDrain?.remainingCount ? { legacyDrain: config.legacyDrain } : {}),
              }) } });
              return false;
            }
            if (config.legacyDrain) {
              const reallocation = this.parseReallocation(setting?.value) ??
                await this.newReallocationIn(tx, organizationId, config.legacyDrain.requestedByUserId);
              const { legacyDrain: _old, reallocation: _allocation, ...value } = setting!.value as Prisma.JsonObject;
              await tx.settings.updateMany({ where: { key: row.key }, data: { value: sendJson({ ...value,
                ...(state.legacyDrain!.remainingCount ? { legacyDrain: config.legacyDrain } : {}),
                ...(reallocation ? { reallocation } : {}),
              }) } });
              return false;
            }
            if (!config.transition || !state.systemEnabled) return false;
            if (state.revision >= 2147483647)
              throw new ServiceUnavailableException('SEND_MODE_REVISION_EXHAUSTED');
            const reallocation = await this.newReallocationIn(tx, organizationId, config.transition.requestedByUserId);
            await tx.settings.updateMany({ where: { key: row.key }, data: { value: sendJson({
              mode: 'CONTROLLED', revision: state.revision + 1,
              ...(state.transition!.remainingCount ? { legacyDrain: await this.normalizeTransitionIn(tx, organizationId, config.transition) } : {}),
              ...(reallocation ? { reallocation } : {}),
            }) } });
            return true;
          })
        );
      } catch (error) {
        this.logger.error(
          `Sending mode transition reconciliation failed for organization ${organizationId}`,
          error instanceof Error ? error.stack : error
        );
        results.push(false);
      }
    }
    return results;
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
    organizationId: string,
    reference: { rootPostId?: string; executionId?: string; drainDiscovery?: boolean } = {}
  ) {
    const state = await this.lockIn(tx, organizationId);
    const row = await tx.settings.findUnique({ where: { key: organizationSendModeKey(organizationId) } });
    if (state.mode !== 'CONTROLLED' && !(state.systemEnabled && ((reference.drainDiscovery && state.controlledDrain) || await controlledDrainAllowsIn(tx, organizationId, parseControlledDrain(row?.value), reference))))
      throw new ConflictException('SEND_MODE_CONTROLLED_REQUIRED');
    return state;
  }

  async assertAutonomousIn(
    tx: Prisma.TransactionClient,
    organizationId: string,
    existingPostIds?: string[]
  ) {
    const state = await this.lockIn(tx, organizationId);
    if (state.configuredMode === 'CONTROLLED' && state.legacyDrain && existingPostIds?.length) {
      const captured = await this.capturedWorkIn(tx, organizationId);
      const active = new Set((await this.pendingPostsIn(tx, organizationId)).map(post => post.id));
      if (existingPostIds.every(id => captured?.eligiblePostIds.includes(id) && active.has(id))) return state;
      throw new ConflictException('SEND_MODE_TRANSITION_PENDING');
    }
    if (state.mode !== 'AUTONOMOUS' || !state.autonomousAllowed)
      throw new ConflictException('SEND_MODE_AUTONOMOUS_REQUIRED');
    if (state.transition) {
      const allowed = await this.autonomousDrainPostIdsIn(tx, organizationId);
      if (!existingPostIds?.length || existingPostIds.some(id => !allowed!.includes(id)))
        throw new ConflictException('SEND_MODE_TRANSITION_PENDING');
    }
    return state;
  }

  private async capturedWorkIn(tx: Prisma.TransactionClient, organizationId: string) {
    const row = await tx.settings.findUnique({ where: { key: organizationSendModeKey(organizationId) } });
    const config = this.parseOrganization(row?.value);
    return config.legacyDrain ?? config.transition;
  }

  async autonomousDrainPostIdsIn(tx: Prisma.TransactionClient, organizationId: string): Promise<string[] | null> {
    const state = await this.lockIn(tx, organizationId);
    // Switching never transfers an old lease to another legacy executor.
    if (state.configuredMode === 'CONTROLLED') return [];
    if (state.mode !== 'AUTONOMOUS' || !state.autonomousAllowed)
      throw new ConflictException('SEND_MODE_AUTONOMOUS_REQUIRED');
    if (!state.transition) return null;
    const captured = await this.capturedWorkIn(tx, organizationId);
    const active = new Set((await this.pendingPostsIn(tx, organizationId)).map(post => post.id));
    return captured!.eligiblePostIds.filter(id => active.has(id));
  }

  async activeLegacyPostIdsIn(tx: Prisma.TransactionClient, organizationId: string) {
    return (await this.pendingPostsIn(tx, organizationId)).map(post => post.id);
  }

  private async settledLegacyReplyWritersIn(
    tx: Prisma.TransactionClient, organizationId: string,
    posts: Awaited<ReturnType<SendModeService['pendingPostsIn']>>,
    records: Awaited<ReturnType<SendModeService['autonomousRecordsIn']>>
  ) {
    const byPost = new Map<string, typeof records>();
    for (const record of records) for (const id of record.result.postIds ?? []) {
      const proofs = byPost.get(id) ?? [];
      proofs.push(record); byPost.set(id, proofs);
    }
    const candidates = posts.filter(post => {
      if (post.source !== 'engage' || !isLegacyExecution(post.executionProtocol) ||
          post.publishMethod === 'API' || post.parentPostId ||
          post.intervalInDays || post.releaseURL || !post.providerIdentifier ||
          !(post.claimedAt instanceof Date) || !Number.isFinite(post.claimedAt.getTime())) return false;
      const proofs = byPost.get(post.id) ?? [];
      if (!proofs.length || !proofs.every(({ result }) =>
        result.status === 'NOT_SUBMITTED' && result.source === 'BROWSER' && result.action === 'COMMENT' &&
        result.postIds?.length === 1 && result.recurring === false && result.occurrenceKey === 'single' &&
        canonicalControlledPlatform(result.platform!) === canonicalControlledPlatform(post.providerIdentifier!))) return false;
      // An old receipt cannot settle a newer claim. Historical receipts without
      // a lease binding must have been admitted after the current claim began.
      return proofs.some(({ row, result }) => result.legacyClaim
        ? result.legacyClaim.releaseId === post.releaseId &&
          Date.parse(result.legacyClaim.claimedAt) === post.claimedAt!.getTime()
        : row.createdAt instanceof Date && Number.isFinite(row.createdAt.getTime()) &&
          row.createdAt >= post.claimedAt!);
    });
    if (!candidates.length) return new Set<string>();
    // Even settled or removed children keep a thread out of single-reply isolation.
    const children = await tx.post.findMany({ where: { organizationId,
      parentPostId: { in: candidates.map(post => post.id) } }, select: { parentPostId: true } });
    const parents = new Set(children.map(child => child.parentPostId));
    return new Set(candidates.filter(post => !parents.has(post.id)).map(post => post.id));
  }

  async legacyAccountBlockedIn(tx: Prisma.TransactionClient, organizationId: string, integrationId: string | null, browserPlatform?: string) {
    const [posts, records, setting] = await Promise.all([
      this.pendingPostsIn(tx, organizationId), this.autonomousRecordsIn(tx, organizationId),
      tx.settings.findUnique({ where: { key: organizationSendModeKey(organizationId) } }),
    ]);
    const config = this.parseOrganization(setting?.value);
    const captured = config.legacyDrain ?? config.transition;
    if (captured?.eligiblePostIds.length) {
      const existing = await tx.post.findMany({ where: { organizationId, id: { in: captured.eligiblePostIds } }, select: { id: true } });
      if (existing.length !== captured.eligiblePostIds.length) return true;
    }
    const associated = new Map(posts.map(post => [post.id, { id: post.id, parentPostId: post.parentPostId, publishDate: post.publishDate }]));
    let parents = posts.map(post => post.parentPostId).filter((id): id is string => !!id && !associated.has(id));
    while (parents.length) {
      if (associated.size > 5000) throw new ConflictException('SEND_MODE_TRANSITION_TOO_LARGE');
      const rows = await tx.post.findMany({ where: { organizationId, id: { in: parents } },
        select: { id: true, parentPostId: true, publishDate: true } });
      const seen = new Set(parents);
      for (const row of rows) associated.set(row.id, row);
      parents = rows.map(row => row.parentPostId).filter((id): id is string => !!id && !associated.has(id) && !seen.has(id));
    }
    const relevant = records.filter(({ result }) => result.status !== 'NOT_SUBMITTED' &&
      (result.status !== 'CONFIRMED' || result.postIds?.some(id => associated.has(id) &&
        (!result.recurring || Date.parse(result.occurrenceKey ?? '') === new Date(associated.get(id)!.publishDate).getTime()))));
    if (!posts.length && !relevant.length) return false;
    const target: { id: string | null; providerIdentifier: string; identityNamespace: string | null; internalId: string | null } | null = integrationId ? await tx.integration.findFirst({ where: { id: integrationId, organizationId } })
      : browserPlatform ? { id: null, providerIdentifier: browserPlatform, identityNamespace: null, internalId: null } : null;
    if (!target) return true;
    const platform = canonicalControlledPlatform(target.providerIdentifier);
    const affected = async (id: string | null, family?: string | null, browser = false) => {
      const account = id && !browser ? await tx.integration.findFirst({ where: { id, organizationId } }) : null;
      const sourcePlatform = family || (account ? canonicalControlledPlatform(account.providerIdentifier) : null);
      if (sourcePlatform && canonicalControlledPlatform(sourcePlatform) !== platform) return false;
      if (browser || !account || !account.identityNamespace || account.identityNamespace === 'legacy' || !account.internalId)
        return true;
      if (account.id === target.id) return true;
      if (!target.identityNamespace || !target.internalId) return true;
      return canonicalSendAccount(organizationId, account.providerIdentifier, account.identityNamespace, account.internalId) ===
        canonicalSendAccount(organizationId, target.providerIdentifier, target.identityNamespace, target.internalId);
    };
    for (const { result } of relevant) {
      if (await affected(result.integrationId, result.platform, result.source === 'BROWSER')) return true;
    }
    // CONTROLLED denies fresh legacy browser grants; terminal non-submission
    // receipts leave only task quarantine, not a live platform writer. Keep
    // pendingPostsIn unchanged so this same historical content cannot be resent.
    const settledWriters = config.mode === 'CONTROLLED'
      ? await this.settledLegacyReplyWritersIn(tx, organizationId, posts, records) : new Set<string>();
    for (const post of posts) {
      if (settledWriters.has(post.id)) continue;
      const account = post.integrationId ? await tx.integration.findFirst({ where: { id: post.integrationId, organizationId } }) : null;
      const family = post.providerIdentifier || account?.providerIdentifier;
      if (await affected(post.integrationId, family, post.publishMethod !== 'API')) return true;
    }
    return false;
  }

  async isTransitionPending(organizationId: string) {
    return sendTransaction(
      this.db,
      async (tx) => !!(await this.stateIn(tx, organizationId)).transition
    );
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
    body:
      | SaveSendModeDto
      | CancelSendModeTransitionDto
      | SaveSystemSendModeDto
      | ResolveAutonomousEffectDto
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
    console.log('[sending-mode] request', { organizationId, userId, requestId: body.requestId, mode: body.mode, expectedRevision: body.expectedRevision });
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
      if (current.transition && body.mode !== 'CONTROLLED')
        throw new ConflictException('SEND_MODE_TRANSITION_PENDING');
      let transition: PendingSendModeTransition | null = null;
      if (
        body.mode === 'CONTROLLED' &&
        current.configuredMode !== 'CONTROLLED'
      ) {
        const posts = await this.pendingPostsIn(tx, organizationId);
        const effects = await this.pendingAutonomousIn(tx, organizationId);
        const initialPendingCount = this.pendingCount(
          posts.map((post) => post.id),
          effects
        );
        if (initialPendingCount > 0) {
          if (current.mode !== 'AUTONOMOUS' || !current.autonomousAllowed)
            throw new ConflictException('SEND_MODE_SWITCH_UNSAFE');
          transition = {
            version: 2,
            targetMode: 'CONTROLLED',
            requestedAt: new Date().toISOString(),
            requestedByUserId: userId,
            eligiblePostIds: posts.map((post) => post.id),
            eligiblePostOccurrences: Object.fromEntries(
              posts.map((post) => [
                post.id,
                post.publishDate &&
                Number.isFinite(new Date(post.publishDate).getTime())
                  ? new Date(post.publishDate).toISOString()
                  : null,
              ])
            ),
            initialPendingCount,
            effectReceiptIds: effects.map(({ row }) => row.id),
          };
        }
      }
      const currentSetting = await tx.settings.findUnique({ where: { key: organizationSendModeKey(organizationId) } });
      const existingConfig = this.parseOrganization(currentSetting?.value);
      const controlledDrain = body.mode === 'CONTROLLED' ? null
        : current.configuredMode !== 'AUTONOMOUS' ? await handoverControlledIn(tx, organizationId, userId)
        : parseControlledDrain(currentSetting?.value);
      const legacyDrain = existingConfig.legacyDrain ?? (body.mode === 'CONTROLLED'
        ? (existingConfig.transition ? await this.normalizeTransitionIn(tx, organizationId, existingConfig.transition) : transition) : null);
      const reallocation = body.mode === 'CONTROLLED'
        ? this.parseReallocation(currentSetting?.value) ?? await this.newReallocationIn(tx, organizationId, userId) : null;
      await tx.settings.updateMany({
        where: { key: organizationSendModeKey(organizationId) },
        data: {
          value: sendJson({
            mode: body.mode,
            revision: current.revision + 1,
            ...(legacyDrain ? { legacyDrain } : {}),
            ...(controlledDrain ? { controlledDrain } : {}),
            ...(reallocation ? { reallocation } : {}),
          }),
        },
      });
      const result = {
        ...(await this.stateIn(tx, organizationId)),
        userId,
        canManage: true,
      };
      await tx.sendMutationReceipt.create({
        data: { ...key, requestHash, result: sendJson(result) },
      });
      console.log('[sending-mode] parsed result', { requestId: body.requestId, result });
      return result;
    });
  }

  async cancelTransition(
    organizationId: string,
    userId: string,
    body: CancelSendModeTransitionDto
  ) {
    this.validateMutation(body);
    if (
      body.expectedOrganizationId !== organizationId ||
      body.expectedUserId !== userId
    )
      throw new ForbiddenException('SEND_OWNER_CHANGED');
    const requestHash = sendHash({ expectedRevision: body.expectedRevision });
    return sendTransaction(this.db, async (tx) => {
      const member = await this.memberIn(tx, organizationId, userId);
      if (!['ADMIN', 'SUPERADMIN'].includes(member.role))
        throw new ForbiddenException('ORGANIZATION_ADMIN_REQUIRED');
      const key = {
        organizationId,
        userId,
        operation: 'cancel-send-mode-transition',
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
      if (!current.transition)
        throw new ConflictException('SEND_MODE_TRANSITION_NOT_PENDING');
      await tx.settings.updateMany({
        where: { key: organizationSendModeKey(organizationId) },
        data: { value: { mode: 'AUTONOMOUS', revision: current.revision + 1 } },
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
      select: { id: true, userId: true, createdAt: true, result: true },
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
      value.source !== 'BROWSER' &&
      ['POST', 'COMMENT'].includes(value.action) &&
      (!value.postIds?.length ||
        typeof value.occurrenceKey !== 'string' ||
        !value.occurrenceKey ||
        value.occurrenceKey.length > 2048 ||
        typeof value.recurring !== 'boolean')
    )
      throw new ServiceUnavailableException('AUTONOMOUS_EFFECT_RECORD_INVALID');
    if (
      value.source !== undefined &&
      (value.source !== 'BROWSER' ||
        !['POST', 'COMMENT'].includes(value.action) ||
        typeof value.platform !== 'string' ||
        !/^[a-z][a-z0-9-]{0,63}$/.test(value.platform) ||
        typeof value.browserUserId !== 'string' ||
        !value.browserUserId ||
        value.browserUserId.length > 128 ||
        value.integrationId !==
          `browser:${value.browserUserId}:${value.platform}` ||
        (value.postIds !== undefined &&
          (!value.postIds.length ||
            typeof value.occurrenceKey !== 'string' ||
            typeof value.recurring !== 'boolean')))
    )
      throw new ServiceUnavailableException('AUTONOMOUS_EFFECT_RECORD_INVALID');
    if (value.legacyClaim !== undefined && (value.source !== 'BROWSER' || value.action !== 'COMMENT' ||
      value.postIds?.length !== 1 || typeof value.legacyClaim?.releaseId !== 'string' ||
      !value.legacyClaim.releaseId || value.legacyClaim.releaseId.length > 2048 ||
      typeof value.legacyClaim.claimedAt !== 'string' || !Number.isFinite(Date.parse(value.legacyClaim.claimedAt))))
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
      ((request.quotaWriteKind !== undefined ||
        request.quotaUnits !== undefined) &&
        (!['WRITE', 'REPLY'].includes(request.quotaWriteKind!) ||
          !validRevision(request.quotaUnits) ||
          request.quotaUnits === 0))
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
      const captured = state.legacyDrain ? await this.capturedWorkIn(tx, organizationId) : null;
      const pending = captured ? new Set((await this.pendingPostsIn(tx, organizationId)).map(post => post.id)) : null;
      const legacyContinuation = Boolean(captured && ['POST', 'COMMENT'].includes(request.action) &&
        Array.isArray(request.postIds) && request.postIds.length > 0 &&
        request.postIds.every(id => captured.eligiblePostIds.includes(id) && pending!.has(id)));
      const draining = Boolean(state.transition || (state.configuredMode === 'CONTROLLED' && state.legacyDrain) || legacyContinuation);
      if (!draining && (state.mode !== 'AUTONOMOUS' || !state.autonomousAllowed))
        throw new ConflictException('SEND_MODE_AUTONOMOUS_REQUIRED');
      if (draining) {
        if (
          !['POST', 'COMMENT'].includes(request.action) ||
          !Array.isArray(request.postIds)
        )
          throw new ConflictException('SEND_MODE_TRANSITION_PENDING');
        await this.assertAutonomousIn(
          tx,
          organizationId,
          request.postIds as string[]
        );
      }
      await assertAutonomousAccountIn(tx, organizationId, { integrationId: request.integrationId });
      if (state.configuredMode === 'AUTONOMOUS' && state.legacyDrain && !legacyContinuation && await this.legacyAccountBlockedIn(tx, organizationId, request.integrationId))
        throw new ConflictException('LEGACY_ACCOUNT_DRAIN_REQUIRED');
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
        if (draining) {
          const captured = (await this.capturedWorkIn(tx, organizationId))!;
          if (
            posts.some(
              (post) =>
                captured.eligiblePostOccurrences[post.id] !==
                (post.publishDate &&
                Number.isFinite(new Date(post.publishDate).getTime())
                  ? new Date(post.publishDate).toISOString()
                  : null)
            )
          )
            throw new ConflictException('SEND_MODE_TRANSITION_PENDING');
        }
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
          ? {
              quotaWriteKind: request.quotaWriteKind,
              quotaUnits: request.quotaUnits,
            }
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
      if (state.legacyDrain) {
        const setting = await tx.settings.findUnique({ where: { key: organizationSendModeKey(organizationId) } });
        const captured = this.parseOrganization(setting?.value).legacyDrain!;
        const ids = [...new Set([...(captured.effectReceiptIds ?? []), receipt.id])];
        if (ids.length > 5000) throw new ConflictException('SEND_MODE_TRANSITION_TOO_LARGE');
        await tx.settings.updateMany({ where: { key: setting!.key }, data: { value: sendJson({
          ...(setting!.value as Prisma.JsonObject), legacyDrain: { ...captured, effectReceiptIds: ids },
        }) } });
      }
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
              ...(current.action === 'PLUG' &&
              returned === false &&
              current.quotaWriteKind !== undefined &&
              current.quotaUnits !== undefined
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

  private browserOwner(
    organizationId: string,
    userId: string,
    body: { expectedOrganizationId: string; expectedUserId: string }
  ) {
    if (
      !body ||
      body.expectedOrganizationId !== organizationId ||
      body.expectedUserId !== userId
    )
      throw new ForbiddenException('SEND_OWNER_CHANGED');
  }

  private browserPlatform(value: string) {
    return (
      (
        {
          twitter: 'x',
          'dev.to': 'devto',
          'hacker-news': 'hackernews',
          'linkedin-page': 'linkedin',
        } as Record<string, string>
      )[value] ?? value
    );
  }

  async beginBrowserWrite(
    organizationId: string,
    userId: string,
    body: BeginBrowserWriteDto
  ) {
    this.browserOwner(organizationId, userId, body);
    if (
      typeof body.requestId !== 'string' ||
      !body.requestId.trim() ||
      body.requestId.length > 128 ||
      typeof body.platform !== 'string' ||
      !/^[a-z][a-z0-9.-]{0,63}$/.test(body.platform) ||
      typeof body.contentHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(body.contentHash) ||
      (body.postId !== undefined &&
        (typeof body.postId !== 'string' ||
          !body.postId.trim() ||
          body.postId.length > 128)) ||
      (body.sentReplyId !== undefined &&
        (typeof body.sentReplyId !== 'string' ||
          !body.sentReplyId.trim() ||
          body.sentReplyId.length > 128)) ||
      (body.postId && body.sentReplyId)
    )
      throw new BadRequestException('INVALID_BROWSER_WRITE');
    const platform = this.browserPlatform(body.platform);
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(platform))
      throw new BadRequestException('INVALID_BROWSER_WRITE');
    const integrationId = `browser:${userId}:${platform}`;
    const requestId = sendHash(['browser-write-v1', userId, body.requestId]);
    const requestHash = sendHash({
      platform,
      postId: body.postId,
      sentReplyId: body.sentReplyId,
      contentHash: body.contentHash,
    });
    return sendTransaction(this.db, async (tx) => {
      await this.memberIn(tx, organizationId, userId);
      const state = await this.lockIn(tx, organizationId);
      const prior = await tx.sendMutationReceipt.findUnique({
        where: {
          organizationId_userId_operation_requestId: {
            organizationId,
            userId,
            operation: AUTONOMOUS_EFFECT_OPERATION,
            requestId,
          },
        },
      });
      if (prior) {
        if (prior.requestHash !== requestHash)
          throw new ConflictException('AUTONOMOUS_EFFECT_REQUEST_CONFLICT');
        const result = this.effectResult(prior.result);
        if (result.source !== 'BROWSER' || result.browserUserId !== userId)
          throw new ForbiddenException('BROWSER_WRITE_OWNER_REQUIRED');
        return {
          id: prior.id,
          admitted: false,
          status: result.status,
          organizationId,
          userId,
        };
      }
      // Legacy leases do not identify their original browser owner. Only an
      // already admitted receipt may finish after cutover; never grant a new one.
      if (state.configuredMode === 'CONTROLLED')
        throw new ConflictException('SEND_MODE_AUTONOMOUS_REQUIRED');
      await assertAutonomousAccountIn(tx, organizationId, { platform });
      if (state.legacyDrain && await this.legacyAccountBlockedIn(tx, organizationId, null, platform))
        throw new ConflictException('LEGACY_ACCOUNT_DRAIN_REQUIRED');
      let storedPostId = body.postId;
      let storedPlatform: string | null | undefined;
      if (body.sentReplyId) {
        const reply = await tx.engageSentReply.findFirst({
          where: { id: body.sentReplyId, organizationId },
          select: { postId: true, opportunityId: true },
        });
        if (!reply)
          throw new ForbiddenException('BROWSER_WRITE_CONTENT_REQUIRED');
        storedPostId = reply.postId;
        storedPlatform = (
          await tx.engageOpportunity.findUnique({
            where: { id: reply.opportunityId },
            select: { platform: true },
          })
        )?.platform;
      }
      const post = storedPostId
        ? await tx.post.findFirst({
            where: { id: storedPostId, organizationId, deletedAt: null },
            select: {
              id: true,
              providerIdentifier: true,
              integrationId: true,
              state: true,
              sendIntentId: true,
              executionProtocol: true,
              publishDate: true,
              intervalInDays: true,
              releaseURL: true,
              releaseId: true,
              claimedAt: true,
              sendTarget: true,
              contentUnitId: true,
            },
          })
        : null;
      let retryableError = false;
      if (post?.state === 'ERROR' && !post.releaseURL &&
          state.mode === 'AUTONOMOUS' && state.autonomousAllowed && !state.transition) {
        // A queue failure callback records ERROR even when the browser proved
        // nothing was submitted. A fresh explicit attempt needs that same proof;
        // it is new work and never receives a pending-transition drain exception.
        const receipts = await tx.sendMutationReceipt.findMany({
          where: { organizationId, userId, operation: AUTONOMOUS_EFFECT_OPERATION, requestHash },
          select: { result: true },
        });
        retryableError = receipts.some(receipt => {
          const result = this.effectResult(receipt.result);
          return result.source === 'BROWSER' && result.browserUserId === userId &&
            result.status === 'NOT_SUBMITTED' && result.postIds?.includes(post.id);
        });
      }
      if (
        storedPostId &&
        (!post ||
          (!['DRAFT', 'QUEUE'].includes(post.state) && !retryableError) ||
          post.sendIntentId ||
          !isLegacyExecution(post.executionProtocol))
      )
        throw new ForbiddenException('BROWSER_WRITE_CONTENT_REQUIRED');
      if (post) {
        storedPlatform ??= post.providerIdentifier;
        if (!storedPlatform && post.integrationId)
          storedPlatform = (
            await tx.integration.findFirst({
              where: { id: post.integrationId, organizationId },
              select: { providerIdentifier: true },
            })
          )?.providerIdentifier;
        if (!storedPlatform)
          throw new ForbiddenException('BROWSER_WRITE_PLATFORM_CHANGED');
        if (this.browserPlatform(storedPlatform) !== platform)
          throw new ConflictException('BROWSER_WRITE_PLATFORM_CHANGED');
      }
      if (!state.transition && (state.mode !== 'AUTONOMOUS' || !state.autonomousAllowed))
        throw new ConflictException('SEND_MODE_AUTONOMOUS_REQUIRED');
      if (state.transition) {
        if (!post) throw new ConflictException('SEND_MODE_TRANSITION_PENDING');
        await this.assertAutonomousIn(tx, organizationId, [post.id]);
        const pending = (await this.capturedWorkIn(tx, organizationId))!;
        const occurrence =
          post.publishDate &&
          Number.isFinite(new Date(post.publishDate).getTime())
            ? new Date(post.publishDate).toISOString()
            : null;
        if (pending.eligiblePostOccurrences[post.id] !== occurrence)
          throw new ConflictException('SEND_MODE_TRANSITION_PENDING');
      }
      const handedOverIntent = post ? await tx.sendIntent.findFirst({ where: { organizationId,
        ...(post.contentUnitId ? { contentUnitId: post.contentUnitId } : { rootPostId: post.id }), status: 'HANDED_OVER' } }) : null;
      const handoverTarget = (post?.sendTarget as Prisma.JsonObject | null)?.handoverMode === 'AUTONOMOUS' ? post?.sendTarget : undefined;
      if (handedOverIntent && post?.integrationId !== handedOverIntent.integrationId)
        throw new ConflictException('HANDOVER_ACCOUNT_CHANGED');
      if (handoverTarget && body.handoverAccountVerification !== true)
        throw new ConflictException('HANDOVER_EXTENSION_UPGRADE_REQUIRED');
      const records = await this.autonomousRecordsIn(tx, organizationId);
      if (
        records.some(
          ({ result }) =>
            !['CONFIRMED', 'NOT_SUBMITTED'].includes(result.status) &&
            (result.integrationId === integrationId ||
              (post && result.postIds?.includes(post.id)))
        )
      )
        throw new ConflictException(
          'AUTONOMOUS_EFFECT_RECONCILIATION_REQUIRED'
        );
      const recurring = !!post?.intervalInDays;
      const occurrenceKey =
        recurring && post ? new Date(post.publishDate).toISOString() : 'single';
      if (
        post &&
        records.some(
          ({ result }) =>
            result.status !== 'NOT_SUBMITTED' &&
            result.postIds?.includes(post.id) &&
            !(
              result.recurring === true &&
              recurring &&
              result.status === 'CONFIRMED' &&
              result.occurrenceKey !== occurrenceKey
            )
        )
      )
        throw new ConflictException(
          'AUTONOMOUS_EFFECT_CONTENT_ALREADY_ADMITTED'
        );
      const result: AutonomousEffectResult = {
        source: 'BROWSER',
        platform,
        browserUserId: userId,
        status: 'AUTHORIZED',
        revision: 1,
        action: body.sentReplyId ? 'COMMENT' : 'POST',
        integrationId,
        ...(post ? { postIds: [post.id], occurrenceKey, recurring } : {}),
        ...(body.sentReplyId && post?.releaseId && post.claimedAt ? { legacyClaim: {
          releaseId: post.releaseId, claimedAt: new Date(post.claimedAt).toISOString(),
        } } : {}),
      };
      const row = await tx.sendMutationReceipt.create({
        data: {
          organizationId,
          userId,
          operation: AUTONOMOUS_EFFECT_OPERATION,
          requestId,
          requestHash,
          result: sendJson(result),
        },
      });
      return {
        id: row.id,
        ...(handoverTarget ? { targetAccount: handoverTarget } : {}),
        admitted: true,
        status: result.status,
        organizationId,
        userId,
      };
    });
  }

  private async releaseUnsentReplyClaimIn(
    tx: Prisma.TransactionClient, organizationId: string, result: AutonomousEffectResult
  ) {
    if (result.status !== 'NOT_SUBMITTED' || result.source !== 'BROWSER' ||
      result.action !== 'COMMENT' || !result.legacyClaim || result.postIds?.length !== 1) return;
    const postId = result.postIds[0];
    const receipts = await this.autonomousRecordsIn(tx, organizationId);
    if (receipts.some(({ result: other }) => other.status !== 'NOT_SUBMITTED' && other.postIds?.includes(postId))) return;
    // Only the exact claim observed at admission can be released. Keep its time for pacing.
    await tx.post.updateMany({
      where: { organizationId, id: postId, sendIntentId: null, deletedAt: null,
        state: { in: ['DRAFT', 'QUEUE', 'ERROR'] }, releaseURL: null,
        releaseId: result.legacyClaim.releaseId, claimedAt: new Date(result.legacyClaim.claimedAt),
        OR: [{ executionProtocol: null }, { executionProtocol: 'LEGACY' }],
      },
      data: { releaseId: null },
    });
  }

  async settleBrowserWrite(
    organizationId: string,
    userId: string,
    id: string,
    body: BrowserWriteOutcomeDto
  ) {
    this.browserOwner(organizationId, userId, body);
    if (
      typeof id !== 'string' ||
      !id ||
      id.length > 128 ||
      !['CONFIRMED', 'UNKNOWN', 'NOT_SUBMITTED'].includes(body.status) ||
      (body.platformPostId !== undefined &&
        (typeof body.platformPostId !== 'string' ||
          !body.platformPostId.trim() ||
          body.platformPostId.length > 2048)) ||
      (body.url !== undefined &&
        (typeof body.url !== 'string' ||
          !/^https?:\/\//.test(body.url) ||
          body.url.length > 4096))
    )
      throw new BadRequestException('INVALID_BROWSER_WRITE_OUTCOME');
    return sendTransaction(this.db, async (tx) => {
      await this.memberIn(tx, organizationId, userId);
      await this.lockIn(tx, organizationId);
      const row = await tx.sendMutationReceipt.findFirst({
        where: { id, organizationId, operation: AUTONOMOUS_EFFECT_OPERATION },
      });
      if (!row || row.userId !== userId)
        throw new ForbiddenException('BROWSER_WRITE_OWNER_REQUIRED');
      const current = this.effectResult(row.result);
      if (current.source !== 'BROWSER' || current.browserUserId !== userId)
        throw new ForbiddenException('BROWSER_WRITE_OWNER_REQUIRED');
      const result = {
        ...(body.platformPostId ? { postId: body.platformPostId } : {}),
        ...(body.url ? { url: body.url } : {}),
      };
      if (['CONFIRMED', 'NOT_SUBMITTED'].includes(current.status)) {
        if (current.status !== body.status)
          throw new ConflictException('BROWSER_WRITE_OUTCOME_CONFLICT');
        if (body.status === 'CONFIRMED') {
          if (current.hasResult === true) {
            if (sendHash(current.result) !== sendHash(result))
              throw new ConflictException('BROWSER_WRITE_OUTCOME_CONFLICT');
          } else if (Object.keys(result).length > 0) {
            const saved = await tx.sendMutationReceipt.updateMany({
              where: {
                id,
                organizationId,
                result: { equals: row.result as Prisma.InputJsonValue },
              },
              data: {
                result: sendJson({
                  ...current,
                  revision: current.revision + 1,
                  hasResult: true,
                  result,
                }),
              },
            });
            if (saved.count !== 1) throw retryConflict();
          }
        }
        await this.releaseUnsentReplyClaimIn(tx, organizationId, current);
        return { id, status: current.status, organizationId, userId };
      }
      if (current.status === 'UNKNOWN' && body.status === 'NOT_SUBMITTED')
        throw new ConflictException('BROWSER_WRITE_OUTCOME_CONFLICT');
      const next = {
        ...current,
        status: body.status,
        revision: current.revision + 1,
        ...(body.status === 'CONFIRMED'
          ? { confirmedAt: new Date().toISOString(), hasResult: true, result }
          : {}),
      };
      const saved = await tx.sendMutationReceipt.updateMany({
        where: {
          id,
          organizationId,
          result: { equals: row.result as Prisma.InputJsonValue },
        },
        data: { result: sendJson(next) },
      });
      if (saved.count !== 1) throw retryConflict();
      await this.releaseUnsentReplyClaimIn(tx, organizationId, next);
      return { id, status: next.status, organizationId, userId };
    });
  }

  private async legacyReplyRecoveryIn(tx: Prisma.TransactionClient, organizationId: string, sentReplyId: string) {
    const reply = await tx.engageSentReply.findFirst({ where: { id: sentReplyId, organizationId } });
    const post = reply ? await tx.post.findFirst({ where: { id: reply.postId, organizationId } }) : null;
    if (!reply || !post) throw new BadRequestException('LEGACY_REPLY_NOT_FOUND');
    const [setting, opportunity, opportunityState, children, records, active] = await Promise.all([
      tx.settings.findUnique({ where: { key: organizationSendModeKey(organizationId) } }),
      tx.engageOpportunity.findUnique({ where: { id: reply.opportunityId } }),
      tx.engageOpportunityState.findFirst({ where: { organizationId, projectId: post.projectId, opportunityId: reply.opportunityId } }),
      tx.post.findMany({ where: { organizationId, parentPostId: post.id }, orderBy: { id: 'asc' } }),
      this.autonomousRecordsIn(tx, organizationId),
      this.activeLegacyPostIdsIn(tx, organizationId),
    ]);
    const config = this.parseOrganization(setting?.value);
    const capturedWork = config.legacyDrain ?? config.transition;
    const captured = !!capturedWork?.eligiblePostIds.includes(post.id);
    const relatedIds = new Set([post.id, ...children.map(child => child.id)]);
    const receipts = records.filter(({ result }) => result.postIds?.some(id => relatedIds.has(id)))
      .sort((a, b) => a.row.id.localeCompare(b.row.id));
    const blockingPostIds = active.filter(id => relatedIds.has(id)).sort();
    const platform = opportunity?.platform ? this.browserPlatform(opportunity.platform) : null;
    const occurrence = post.publishDate ? new Date(post.publishDate).toISOString() : null;
    const reasons: string[] = [];
    if (config.mode !== 'CONTROLLED') reasons.push('CONTROLLED_MODE_REQUIRED');
    if (!['DRAFT', 'QUEUE'].includes(post.state) || !isLegacyExecution(post.executionProtocol) || post.sendIntentId ||
      post.deletedAt || post.removedAt || reply.removedAt || post.releaseURL || post.source !== 'engage' ||
      !post.projectId || post.projectId !== reply.projectId || post.intervalInDays || post.publishMethod === 'API' ||
      !platform || this.browserPlatform(post.providerIdentifier ?? '') !== platform)
      reasons.push('CONTENT_NOT_RECOVERABLE');
    if (post.parentPostId || children.length) reasons.push('THREAD_NOT_SUPPORTED');
    if (!opportunity || opportunity.deletedAt || opportunity.repliesDisabledAt ||
      !opportunityState || !['NEW', 'AUTO_QUEUED'].includes(opportunityState.status))
      reasons.push('OPPORTUNITY_NOT_ACTIONABLE');
    if (captured && capturedWork!.eligiblePostOccurrences[post.id] !== occurrence)
      reasons.push('CAPTURED_OCCURRENCE_CHANGED');
    if (receipts.some(({ result }) => result.status === 'CONFIRMED')) reasons.push('CONFIRMED_RECEIPT');
    if (receipts.some(({ result }) => ['AUTHORIZED', 'UNKNOWN'].includes(result.status))) reasons.push('UNRESOLVED_RECEIPT');
    if (!receipts.length || receipts.some(({ result }) => result.source !== 'BROWSER' || result.action !== 'COMMENT' ||
      result.postIds?.length !== 1 || result.postIds[0] !== post.id || result.platform !== platform ||
      result.recurring !== false || result.occurrenceKey !== 'single')) reasons.push('RECEIPT_PROOF_REQUIRED');
    if (!blockingPostIds.includes(post.id)) reasons.push('NO_LEGACY_OWNERSHIP');
    // Hash the private claim and all relevant durable facts; never expose a lease token.
    const recoveryRevision = sendHash({ reply, post, opportunity, opportunityState, children,
      setting: setting?.value, receipts, blockingPostIds });
    const view = {
      organizationId, sentReplyId, postId: post.id, recoveryRevision, canResolve: reasons.length === 0, reasons,
      state: post.state, opportunityStatus: opportunityState?.status ?? null,
      claimPresent: !!post.releaseId, claimedAt: post.claimedAt?.toISOString() ?? null,
      captured, blockingPostIds,
      receipts: receipts.map(({ row, result }) => ({
        id: row.id, status: result.status, revision: result.revision,
        source: result.source ?? 'SERVER', platform: result.platform ?? null,
        claimBinding: !result.legacyClaim ? 'MISSING' : result.legacyClaim.releaseId === post.releaseId &&
          Date.parse(result.legacyClaim.claimedAt) === post.claimedAt?.getTime() ? 'MATCH' : 'CHANGED',
      })),
    };
    return { view, post, setting, capturedWork, receipts };
  }

  private browserReplyRecoveryView(recovery: Awaited<ReturnType<SendModeService['legacyReplyRecoveryIn']>>, userId: string) {
    const { view, post, receipts } = recovery;
    const reasons = [...view.reasons];
    if (receipts.some(({ row, result }) => row.userId !== userId || result.browserUserId !== userId))
      reasons.push('ORIGINAL_BROWSER_USER_REQUIRED');
    const matchesClaim = (result: AutonomousEffectResult) => !!result.legacyClaim &&
      (!post.releaseId || result.legacyClaim.releaseId === post.releaseId) &&
      Date.parse(result.legacyClaim.claimedAt) === post.claimedAt?.getTime();
    // Missing historical binding requires owner review; a contradictory binding still blocks it.
    if (receipts.some(({ result }) => result.legacyClaim && !matchesClaim(result)))
      reasons.push('CURRENT_CLAIM_PROOF_REQUIRED');
    const canReview = reasons.length === 0;
    if (!receipts.some(({ result }) => matchesClaim(result))) reasons.push('EXPLICIT_OWNER_REVIEW_REQUIRED');
    return { ...view, canResolve: reasons.length === 0, canReview, reasons };
  }

  async getBrowserReplyRecovery(organizationId: string, userId: string, sentReplyId: string) {
    return sendTransaction(this.db, async tx => {
      await this.memberIn(tx, organizationId, userId);
      const view = this.browserReplyRecoveryView(await this.legacyReplyRecoveryIn(tx, organizationId, sentReplyId), userId);
      return { organizationId, userId, sentReplyId, postId: view.postId, recoveryRevision: view.recoveryRevision,
        canResolve: view.canResolve, canReview: view.canReview, reasons: view.reasons };
    });
  }

  resolveBrowserReplyRecovery(organizationId: string, userId: string, sentReplyId: string, body: BrowserReplyRecoveryDto) {
    return this.resolveReplyRecovery(organizationId, userId, sentReplyId, body, true);
  }

  async getLegacyReplyRecovery(organizationId: string, userId: string, sentReplyId: string) {
    return sendTransaction(this.db, async tx => {
      const member = await this.memberIn(tx, organizationId, userId);
      if (!['ADMIN', 'SUPERADMIN'].includes(member.role)) throw new ForbiddenException('ORGANIZATION_ADMIN_REQUIRED');
      return { ...(await this.legacyReplyRecoveryIn(tx, organizationId, sentReplyId)).view, userId };
    });
  }

  async resolveLegacyReplyRecovery(organizationId: string, userId: string, sentReplyId: string, body: ResolveLegacyReplyRecoveryDto) {
    return this.resolveReplyRecovery(organizationId, userId, sentReplyId, body, false);
  }

  private async resolveReplyRecovery(organizationId: string, userId: string, sentReplyId: string,
    body: BrowserReplyRecoveryDto | ResolveLegacyReplyRecoveryDto, browser: boolean) {
    this.browserOwner(organizationId, userId, body);
    const attestation = body as ResolveLegacyReplyRecoveryDto;
    if (typeof body.requestId !== 'string' || !body.requestId.trim() || body.requestId.length > 128 ||
      typeof body.expectedRecoveryRevision !== 'string' || !/^[a-f0-9]{64}$/.test(body.expectedRecoveryRevision) ||
      (!browser && (attestation.executorStopped !== true || attestation.noPendingSubmit !== true || attestation.replyAbsent !== true ||
      typeof attestation.evidence !== 'string' || !attestation.evidence.trim() || attestation.evidence.length > 2000)))
      throw new BadRequestException('INVALID_LEGACY_REPLY_RECOVERY');
    return sendTransaction(this.db, async tx => {
      const member = await this.memberIn(tx, organizationId, userId);
      if (!browser && !['ADMIN', 'SUPERADMIN'].includes(member.role)) throw new ForbiddenException('ORGANIZATION_ADMIN_REQUIRED');
      await this.lockIn(tx, organizationId);
      const key = { organizationId, userId, operation: browser ? 'browser-reply-recovery' : 'legacy-reply-recovery', requestId: body.requestId };
      const requestHash = sendHash({ sentReplyId, expectedRecoveryRevision: body.expectedRecoveryRevision,
        ...(browser ? { reviewConfirmed: (body as BrowserReplyRecoveryDto).reviewConfirmed === true } : { executorStopped: attestation.executorStopped, noPendingSubmit: attestation.noPendingSubmit,
          replyAbsent: attestation.replyAbsent, evidence: attestation.evidence }) });
      const previous = await tx.sendMutationReceipt.findUnique({ where: { organizationId_userId_operation_requestId: key } });
      if (previous) {
        if (previous.requestHash !== requestHash) throw new ConflictException('REQUEST_ID_CONFLICT');
        return previous.result;
      }
      const recovery = await this.legacyReplyRecoveryIn(tx, organizationId, sentReplyId);
      const { post, setting, capturedWork } = recovery;
      const view = browser ? this.browserReplyRecoveryView(recovery, userId) : recovery.view;
      if (view.recoveryRevision !== body.expectedRecoveryRevision) throw new ConflictException('LEGACY_REPLY_RECOVERY_CHANGED');
      const ownerReviewed = browser && (body as BrowserReplyRecoveryDto).reviewConfirmed === true &&
        (view as ReturnType<SendModeService['browserReplyRecoveryView']>).canReview;
      if (!view.canResolve && !ownerReviewed) throw new ConflictException({ message: 'LEGACY_REPLY_RECOVERY_UNSAFE', reasons: view.reasons });
      const saved = await tx.post.updateMany({
        where: { id: post.id, organizationId, deletedAt: null, sendIntentId: null,
          executionProtocol: post.executionProtocol ?? null, state: post.state,
          releaseId: post.releaseId ?? null, claimedAt: post.claimedAt ?? null,
          routeRevision: post.routeRevision, contentRevision: post.contentRevision, releaseURL: null },
        data: { releaseId: null },
      });
      if (saved.count !== 1) throw new ConflictException('LEGACY_REPLY_RECOVERY_CHANGED');
      if (view.captured) {
        const value = setting!.value as Prisma.JsonObject;
        const occurrences = { ...capturedWork!.eligiblePostOccurrences };
        delete occurrences[post.id];
        const field = value.legacyDrain ? 'legacyDrain' : 'transition';
        const updated = await tx.settings.updateMany({
          where: { key: organizationSendModeKey(organizationId), value: { equals: setting!.value as Prisma.InputJsonValue } },
          data: { value: sendJson({ ...value, [field]: { ...capturedWork,
            eligiblePostIds: capturedWork!.eligiblePostIds.filter(id => id !== post.id), eligiblePostOccurrences: occurrences } }) },
        });
        if (updated.count !== 1) throw new ConflictException('LEGACY_REPLY_RECOVERY_CHANGED');
      }
      const result = { resolved: true, organizationId, userId, sentReplyId, postId: post.id,
        recoveryRevision: view.recoveryRevision, receiptIds: view.receipts.map(receipt => receipt.id),
        claimFingerprint: sendHash({ releaseId: post.releaseId, claimedAt: post.claimedAt }),
        claimedAt: view.claimedAt, capturedOwnershipReleased: view.captured,
        ...(browser ? { proofKind: ownerReviewed ? 'OWNER_REVIEWED_HISTORICAL_RECEIPTS' : 'EXACT_CLAIM',
          evidence: ownerReviewed ? 'Original user confirmed all old executors stopped, no pending submission, and reply absent.' :
            'Original user non-submission receipts verified against the current claim.' } : {
          executorStopped: true, noPendingSubmit: true, replyAbsent: true, evidence: attestation.evidence }),
        nextAction: 'CHECK_REPLY_STATUS' };
      await tx.sendMutationReceipt.create({ data: { ...key, requestHash, result: sendJson(result) } });
      return result;
    });
  }

  private effectView(
    row: { id: string; createdAt: Date },
    result: AutonomousEffectResult
  ) {
    return {
      id: row.id,
      action: result.action,
      integrationId: result.integrationId,
      ...(result.source
        ? { source: result.source, platform: result.platform }
        : {}),
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
