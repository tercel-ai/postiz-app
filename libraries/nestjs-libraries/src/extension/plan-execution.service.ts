import { isAccountBoundSendingEnabled } from '@gitroom/nestjs-libraries/extension/account-bound-sending.config';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { PrismaService } from '../database/prisma/prisma.service';
import { ProjectValidationService } from '../projects/project-validation.service';
import { SendBindingService } from './send-binding.service';
import {
  PlanRouteMap,
  SavePlanExecutionDto,
  isPlanRouteMap,
} from './plan-execution.dto';
import { SendAction } from './send-binding.dto';
import { ACCOUNT_BOUND_PROTOCOL } from './extension-node.protocol';

export type PlanAccountRoute = Awaited<
  ReturnType<SendBindingService['resolve']>
> & { origin: 'EXPLICIT' };
export interface PlanExecutionRoutes {
  version: 1;
  platforms: Record<
    string,
    Partial<Record<SendAction, PlanAccountRoute | null>>
  >;
}
const platformOf = (provider: string | null | undefined) =>
  provider === 'linkedin-page' ? 'linkedin' : provider ?? '';
function fingerprint(value: unknown): string {
  const canonical = (item: any): any =>
    Array.isArray(item)
      ? item.map(canonical)
      : item && typeof item === 'object'
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .filter((key) => item[key] !== undefined)
            .map((key) => [key, canonical(item[key])])
        )
      : item;
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}

@Injectable()
export class PlanExecutionService {
  constructor(
    private readonly db: PrismaService,
    private readonly bindings: SendBindingService,
    private readonly projects: ProjectValidationService
  ) {}

  private async transaction<T>(
    work: (tx: Prisma.TransactionClient) => Promise<T>
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.db.$transaction(work, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        if (
          attempt < 3 &&
          ['P2002', 'P2034'].includes((error as { code?: string }).code ?? '')
        )
          continue;
        throw error;
      }
    }
  }

  private async resolveWith(
    tx: Prisma.TransactionClient,
    org: string,
    project: string,
    platforms: string[],
    input: PlanRouteMap
  ): Promise<PlanExecutionRoutes> {
    if (!isPlanRouteMap(input))
      throw new BadRequestException('INVALID_PLAN_EXECUTION_ROUTES');
    const resolved: PlanExecutionRoutes = { version: 1, platforms: {} };
    for (const [platform, actions] of Object.entries(input)) {
      if (!platforms.includes(platform))
        throw new BadRequestException('PLAN_ROUTE_PLATFORM_MISMATCH');
      resolved.platforms[platform] = {};
      for (const [action, choice] of Object.entries(actions)) {
        resolved.platforms[platform][action as SendAction] =
          choice.integrationId === null
            ? null
            : {
                ...(await this.bindings.resolveInTransaction(
                  tx,
                  org,
                  project,
                  platform,
                  action as SendAction,
                  choice.integrationId
                )),
                origin: 'EXPLICIT',
              };
      }
    }
    return resolved;
  }

  async resolve(
    org: string,
    project: string,
    platforms: string[],
    input: PlanRouteMap
  ) {
    await this.projects.assertProjectActive(org, project);
    return this.transaction((tx) =>
      this.resolveWith(tx, org, project, platforms, input)
    );
  }

  compare(snapshot: unknown, input: PlanRouteMap) {
    const routes = snapshot as PlanExecutionRoutes | null;
    return Object.entries(input).every(([platform, actions]) =>
      Object.entries(actions).every(([action, choice]) => {
        const saved = routes?.platforms?.[platform]?.[action as SendAction];
        return choice.integrationId === null
          ? saved === null
          : saved?.integrationId === choice.integrationId;
      })
    );
  }

  private postRoute(
    route: PlanAccountRoute | null | undefined,
    platform: string
  ) {
    return {
      integrationId: route?.integrationId ?? null,
      accountSelectionMode: route ? 'EXPLICIT' : 'INHERIT',
      bindingSource: route ? 'EXPLICIT' : null,
      bindingSourceRevision: null,
      accountResolution: route ? 'BOUND' : 'DRAFT',
      providerIdentifier: route?.providerIdentifier ?? platform,
      sendTarget: route
        ? {
            version: 1,
            platform,
            integrationId: route.integrationId,
            canonicalAccountKey: route.canonicalAccountKey,
            ...route.targetAccount,
          }
        : Prisma.DbNull,
      executionProtocol: ACCOUNT_BOUND_PROTOCOL,
      sendBlockCode: route
        ? 'ACCOUNT_BOUND_SEND_NOT_ENABLED'
        : 'SEND_BINDING_REQUIRED',
    };
  }

  async save(
    org: string,
    user: string,
    project: string,
    planId: string,
    body: SavePlanExecutionDto
  ) {
    if (!user) throw new ForbiddenException('AUTHENTICATED_USER_REQUIRED');
    if (
      !isPlanRouteMap(body.executionRoutes) ||
      !Array.isArray(body.drafts) ||
      body.drafts.length > 500 ||
      new Set(body.drafts.map((draft) => draft.id)).size !==
        body.drafts.length ||
      !Number.isInteger(body.expectedRevision) ||
      body.expectedRevision < 0 ||
      body.expectedRevision >= 2147483647 ||
      body.drafts.some(
        (draft) =>
          !draft.id ||
          !Number.isInteger(draft.expectedRouteRevision) ||
          draft.expectedRouteRevision < 0 ||
          draft.expectedRouteRevision >= 2147483647
      ) ||
      (body.requestId !== undefined &&
        (!body.requestId.trim() || body.requestId.length > 128))
    )
      throw new BadRequestException('INVALID_PLAN_EXECUTION_MUTATION');
    await this.projects.assertProjectActive(org, project);
    const operation = `plan-routes:${planId}`;
    const hash = fingerprint(body);
    return this.transaction(async (tx) => {
      const member = await tx.userOrganization.findUnique({
        where: { userId_organizationId: { userId: user, organizationId: org } },
      });
      if (!member || member.disabled)
        throw new ForbiddenException('ORGANIZATION_MEMBERSHIP_REQUIRED');
      const plan = await tx.operationPlan.findFirst({
        where: { id: planId, organizationId: org, projectId: project },
      });
      if (!plan || plan.projectId !== project || plan.organizationId !== org)
        throw new NotFoundException('Operation plan not found');
      const key = {
        organizationId: org,
        userId: user,
        operation,
        requestId: body.requestId!,
      };
      if (body.requestId) {
        const receipt = await tx.sendMutationReceipt.findUnique({
          where: { organizationId_userId_operation_requestId: key },
        });
        if (receipt) {
          if (receipt.requestHash !== hash)
            throw new ConflictException('REQUEST_ID_REUSED');
          return receipt.result as unknown as {
            executionRevision: number;
            executionRoutes: PlanExecutionRoutes;
            updatedDraftIds: string[];
          };
        }
      }
      if (
        Object.values(body.executionRoutes).some((actions) =>
          Object.prototype.hasOwnProperty.call(actions, 'REPLY')
        )
      )
        throw new BadRequestException({
          code: 'PLAN_ACCOUNT_SELECTION_MOVED',
          message: 'Configure reply sending accounts in project defaults',
          sendingAccountsPath: `/projects/${project}/sending-accounts`,
        });
      if (!body.drafts.length)
        throw new BadRequestException('PLAN_DRAFT_SELECTION_REQUIRED');
      if (plan.executionRevision !== body.expectedRevision)
        throw new ConflictException('PLAN_EXECUTION_REVISION_CONFLICT');
      const delta = await this.resolveWith(
        tx,
        org,
        project,
        plan.platforms,
        body.executionRoutes
      );
      const roots = body.drafts.length
        ? await tx.post.findMany({
            where: {
              id: { in: body.drafts.map((draft) => draft.id) },
              organizationId: org,
              projectId: project,
              operationPlanId: planId,
              deletedAt: null,
            },
          })
        : [];
      if (roots.length !== body.drafts.length)
        throw new ConflictException('PLAN_DRAFT_NOT_EDITABLE');
      for (const root of roots) {
        const expected = body.drafts.find((draft) => draft.id === root.id)!;
        const platform = platformOf(root.providerIdentifier);
        if (
          root.parentPostId ||
          root.state !== 'DRAFT' ||
          root.claimedAt ||
          root.releaseId ||
          root.routeRevision !== expected.expectedRouteRevision
        )
          throw new ConflictException('PLAN_DRAFT_NOT_EDITABLE');
        if (
          !Object.prototype.hasOwnProperty.call(
            delta.platforms[platform] ?? {},
            'POST'
          )
        )
          throw new BadRequestException('DRAFT_ROUTE_NOT_SELECTED');
        // All chain nodes must be unclaimed drafts. A root check alone cannot protect a partially sent thread.
        const chain = await tx.post.findMany({
          where: {
            organizationId: org,
            operationPlanId: planId,
            group: root.group,
            deletedAt: null,
          },
        });
        if (
          !chain.length ||
          chain.some(
            (node) =>
              node.state !== 'DRAFT' ||
              node.claimedAt ||
              node.releaseId ||
              node.routeRevision !== root.routeRevision
          )
        )
          throw new ConflictException('PLAN_DRAFT_NOT_EDITABLE');
      }
      const saved = await tx.operationPlan.updateMany({
        where: {
          id: planId,
          organizationId: org,
          projectId: project,
          executionRevision: body.expectedRevision,
        },
        data: {
          executionRevision: { increment: 1 },
        },
      });
      if (saved.count !== 1)
        throw new ConflictException('PLAN_EXECUTION_REVISION_CONFLICT');
      for (const root of roots) {
        const platform = platformOf(root.providerIdentifier);
        const route = delta.platforms[platform].POST;
        const chain = await tx.post.findMany({
          where: {
            organizationId: org,
            operationPlanId: planId,
            group: root.group,
            deletedAt: null,
          },
        });
        for (const node of chain) {
          const settings = node.settings ? JSON.parse(node.settings) : {};
          const written = await tx.post.updateMany({
            where: {
              id: node.id,
              organizationId: org,
              operationPlanId: planId,
              group: root.group,
              state: 'DRAFT',
              routeRevision: root.routeRevision,
              claimedAt: null,
              releaseId: null,
              deletedAt: null,
            },
            data: {
              ...this.postRoute(route, platform),
              settings: JSON.stringify({
                ...settings,
                __type: route?.providerIdentifier ?? platform,
              }),
              routeRevision: { increment: 1 },
            },
          });
          if (written.count !== 1)
            throw new ConflictException('PLAN_DRAFT_NOT_EDITABLE');
        }
      }
      const result = {
        executionRevision: body.expectedRevision + 1,
        executionRoutes:
          plan.executionRoutes as unknown as PlanExecutionRoutes | null,
        updatedDraftIds: roots.map((root) => root.id),
      };
      if (body.requestId)
        await tx.sendMutationReceipt.create({
          data: {
            ...key,
            requestHash: hash,
            result: result as unknown as Prisma.InputJsonValue,
          },
        });
      return result;
    });
  }

  async assertAccess(org: string, project: string) {
    await this.projects.assertProjectAccess(org, project);
  }

  async materialize(
    org: string,
    planId: string,
    posts: Prisma.PostCreateManyInput[]
  ) {
    return this.transaction(async (tx) => {
      const plan = await tx.operationPlan.findFirst({
        where: { id: planId, organizationId: org },
      });
      if (!plan) throw new NotFoundException('Operation plan not found');
      // Historical plan snapshots are audit data, never defaults for new drafts.
      const data = posts.map((post) => ({
        ...post,
        integrationId: null,
        accountSelectionMode: 'INHERIT',
        bindingSource: null,
        bindingSourceRevision: null,
        accountResolution: 'DRAFT',
        sendTarget: Prisma.DbNull,
        routeRevision: 0,
        contentRevision: 1,
        sendBlockCode: null,
        ...(isAccountBoundSendingEnabled()
          ? { executionProtocol: ACCOUNT_BOUND_PROTOCOL }
          : {}),
      }));
      return data.length
        ? tx.post.createMany({ data, skipDuplicates: true })
        : { count: 0 };
    });
  }
}
