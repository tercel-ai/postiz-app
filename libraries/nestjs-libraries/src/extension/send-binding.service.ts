import { canonicalSendAccount } from './send-coordination.utils';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Integration, Prisma } from '@prisma/client';
import { EXTENSION_PUBLISHABLE_PLATFORMS } from '@gitroom/helpers/extension/post-publish';
import { createHash } from 'node:crypto';
import { PrismaService } from '../database/prisma/prisma.service';
import { ProjectValidationService } from '../projects/project-validation.service';
import {
  readEngageConfigMetadata,
  type EngageConfigMetadata,
} from '../engage/engage-config-metadata';
import {
  AccountBindingInput,
  AccountBindingMap,
  SaveSendingAccountsDto,
  SendingAccountMap,
  isSendingAccountMap,
  isAccountBindingMap,
  SendAction,
} from './send-binding.dto';

export interface BindingSaveResult {
  saved: true;
  bindings: Array<{
    platform: string;
    integrationId: string | null;
    revision: number;
  }>;
  settings: EngageConfigMetadata;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .filter((k) => (value as any)[k] !== undefined)
        .map((k) => JSON.stringify(k) + ':' + canonical((value as any)[k]))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
const digest = (value: unknown) =>
  createHash('sha256').update(canonical(value)).digest('hex');
const canonicalPlatform = (provider: string) =>
  provider === 'linkedin-page' ? 'linkedin' : provider.toLowerCase();

@Injectable()
export class SendBindingService {
  constructor(
    private readonly db: PrismaService,
    private readonly projects: ProjectValidationService
  ) {}

  private async transaction<T>(
    work: (tx: Prisma.TransactionClient) => Promise<T>
  ) {
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

  async list(org: string, project: string) {
    await this.projects.assertProjectAccess(org, project);
    const rows = await this.db.projectSendBinding.findMany({
      where: { organizationId: org, projectId: project },
      select: {
        platform: true,
        action: true,
        integrationId: true,
        revision: true,
        integration: {
          select: {
            disabled: true,
            deletedAt: true,
            inBetweenSteps: true,
            integrationProjects: {
              where: { organizationId: org, projectId: project },
              select: { disabled: true, engageEnabled: true },
            },
          },
        },
      },
    });
    return rows.map(({ integration, ...binding }) => {
      const relation = integration?.integrationProjects[0];
      return {
        ...binding,
        accountDisabled:
          !integration ||
          integration.disabled ||
          !!integration.deletedAt ||
          integration.inBetweenSteps ||
          !relation ||
          relation.disabled ||
          (binding.action === 'REPLY' && relation.engageEnabled !== true),
      };
    });
  }

  private async member(
    tx: Prisma.TransactionClient,
    org: string,
    user: string
  ) {
    if (!user) throw new ForbiddenException('AUTHENTICATED_USER_REQUIRED');
    const member = await tx.userOrganization.findUnique({
      where: { userId_organizationId: { userId: user, organizationId: org } },
    });
    if (!member || member.disabled)
      throw new ForbiddenException('ORGANIZATION_MEMBERSHIP_REQUIRED');
  }

  private accountError(
    account:
      | Pick<
          Integration,
          | 'organizationId'
          | 'disabled'
          | 'deletedAt'
          | 'inBetweenSteps'
          | 'providerIdentifier'
          | 'identityNamespace'
          | 'internalId'
        >
      | undefined,
    relation: { disabled: boolean; engageEnabled: boolean } | undefined,
    org: string,
    project: string | undefined,
    platform: string,
    action: SendAction
  ): string | null {
    if (project !== undefined && (!relation || relation.disabled))
      return 'ACCOUNT_NOT_ASSIGNED';
    if (
      !account ||
      account.organizationId !== org ||
      account.disabled ||
      account.deletedAt ||
      account.inBetweenSteps
    )
      return 'ACCOUNT_DISABLED';
    if (
      project !== undefined &&
      action === 'REPLY' &&
      relation!.engageEnabled !== true
    )
      return 'REPLY_ACCOUNT_DISABLED';
    if (canonicalPlatform(account.providerIdentifier) !== platform)
      return 'ACCOUNT_PLATFORM_MISMATCH';
    if (
      !account.internalId ||
      !account.identityNamespace ||
      account.identityNamespace === 'legacy'
    )
      return 'ACCOUNT_IDENTITY_UNRESOLVED';
    return null;
  }

  private async account(
    tx: Prisma.TransactionClient,
    org: string,
    project: string | undefined,
    platform: string,
    action: SendAction,
    id: string
  ) {
    const relation =
      project !== undefined
        ? await tx.integrationProject.findFirst({
            where: {
              organizationId: org,
              projectId: project,
              integrationId: id,
              disabled: false,
            },
            include: { integration: true },
          })
        : undefined;
    const account =
      project !== undefined
        ? relation?.integration
        : await tx.integration.findFirst({
            where: { id, organizationId: org },
          });
    const code = this.accountError(
      account,
      relation,
      org,
      project,
      platform,
      action
    );
    if (code) {
      if (
        ['ACCOUNT_PLATFORM_MISMATCH', 'ACCOUNT_IDENTITY_UNRESOLVED'].includes(
          code
        )
      )
        throw new BadRequestException(code);
      throw new ForbiddenException(code);
    }
    return account!;
  }

  async resolve(
    org: string,
    project: string,
    platform: string,
    action: SendAction,
    explicitId?: string
  ) {
    await this.projects.assertProjectActive(org, project);
    return this.transaction((tx) =>
      this.resolveInTransaction(tx, org, project, platform, action, explicitId)
    );
  }

  async resolveInTransaction(
    tx: Prisma.TransactionClient,
    org: string,
    project: string,
    platform: string,
    action: SendAction,
    explicitId?: string
  ) {
    const local =
      explicitId !== undefined
        ? null
        : await tx.projectSendBinding.findUnique({
            where: {
              organizationId_projectId_platform_action: {
                organizationId: org,
                projectId: project,
                platform,
                action,
              },
            },
          });
    const global =
      explicitId === undefined && !local?.integrationId
        ? await tx.organizationSendBinding.findUnique({
            where: {
              organizationId_platform_action: {
                organizationId: org,
                platform,
                action,
              },
            },
          })
        : null;
    const binding = local?.integrationId ? local : global;
    const id = explicitId ?? binding?.integrationId;
    if (!id) throw new BadRequestException('SEND_BINDING_REQUIRED');
    const account = await this.account(tx, org, project, platform, action, id);
    return {
      integrationId: account.id,
      providerIdentifier: account.providerIdentifier,
      bindingRevision: binding?.revision ?? null,
      bindingSource:
        explicitId !== undefined
          ? ('EXPLICIT' as const)
          : local?.integrationId
          ? ('PROJECT' as const)
          : ('ORGANIZATION' as const),
      // Identity audit must complete before coordinated sending can be enabled.
      canonicalAccountKey: canonicalSendAccount(
        org,
        account.providerIdentifier,
        account.identityNamespace!,
        account.internalId
      ),
      targetAccount: {
        id:
          account.identityNamespace === 'reddit.user_id'
            ? account.internalId.replace(/^t2_/i, '').toLowerCase()
            : account.internalId,
        idNamespace: account.identityNamespace,
        handle: account.profile ?? null,
      },
    };
  }

  async resolveForEnqueueInTransaction(
    tx: Prisma.TransactionClient,
    org: string,
    project: string,
    platform: string,
    action: SendAction,
    explicitId: string | undefined,
    allowCurrentSession: boolean
  ) {
    try {
      return await this.resolveInTransaction(
        tx,
        org,
        project,
        platform,
        action,
        explicitId
      );
    } catch (error) {
      // Only a genuinely absent binding qualifies; an invalid configured account never falls back.
      if (
        allowCurrentSession &&
        explicitId === undefined &&
        error instanceof BadRequestException &&
        error.message === 'SEND_BINDING_REQUIRED'
      )
        return null;
      throw error;
    }
  }

  async resolveCurrentActorInTransaction(
    tx: Prisma.TransactionClient,
    org: string,
    project: string,
    platform: string,
    action: SendAction,
    integrationId: string
  ) {
    return this.resolveInTransaction(
      tx,
      org,
      project,
      platform,
      action,
      integrationId
    );
  }

  async getDefaults(org: string, user: string, project?: string) {
    if (project !== undefined)
      await this.projects.assertProjectAccess(org, project);
    return this.transaction(async (tx) => {
      await this.member(tx, org, user);
      const global = await tx.organizationSendBinding.findMany({
        where: { organizationId: org },
      });
      const local =
        project !== undefined
          ? await tx.projectSendBinding.findMany({
              where: { organizationId: org, projectId: project },
            })
          : [];
      const ids = [
        ...new Set(
          [...global, ...local].flatMap((row) =>
            row.integrationId ? [row.integrationId] : []
          )
        ),
      ];
      const actors = ids.length
        ? await tx.integration.findMany({
            where: { organizationId: org, id: { in: ids } },
            select: {
              id: true,
              organizationId: true,
              providerIdentifier: true,
              identityNamespace: true,
              internalId: true,
              disabled: true,
              deletedAt: true,
              inBetweenSteps: true,
            },
          })
        : [];
      const relations =
        project !== undefined && ids.length
          ? await tx.integrationProject.findMany({
              where: {
                organizationId: org,
                projectId: project,
                integrationId: { in: ids },
              },
              select: {
                integrationId: true,
                disabled: true,
                engageEnabled: true,
              },
            })
          : [];
      const byActor = new Map(actors.map((row) => [row.id, row]));
      const byRelation = new Map(
        relations.map((row) => [row.integrationId, row])
      );
      const configured = (
        row: { integrationId: string | null; revision: number } | undefined
      ) => ({
        integrationId: row?.integrationId ?? null,
        revision: row?.revision ?? 0,
      });
      const accounts: Record<
        string,
        Partial<
          Record<
            SendAction,
            {
              configured: { integrationId: string | null; revision: number };
              organization: { integrationId: string | null; revision: number };
              effectiveIntegrationId: string | null;
              source: string;
              sourceRevision: number | null;
              blockCode: string | null;
            }
          >
        >
      > = {};
      for (const platform of EXTENSION_PUBLISHABLE_PLATFORMS) {
        accounts[platform] = {};
        for (const action of ['POST', 'REPLY'] as const) {
          const parent = global.find(
            (row) => row.platform === platform && row.action === action
          );
          const child = local.find(
            (row) => row.platform === platform && row.action === action
          );
          const effective = child?.integrationId ? child : parent;
          const id = effective?.integrationId ?? null;
          accounts[platform][action] = {
            configured: configured(project !== undefined ? child : parent),
            organization: configured(parent),
            effectiveIntegrationId: id,
            source: id
              ? child?.integrationId
                ? 'PROJECT'
                : 'ORGANIZATION'
              : 'UNBOUND',
            sourceRevision: id ? effective!.revision : null,
            blockCode: id
              ? this.accountError(
                  byActor.get(id),
                  byRelation.get(id),
                  org,
                  project,
                  platform,
                  action
                )
              : 'SEND_BINDING_REQUIRED',
          };
        }
      }
      return { accounts };
    });
  }

  async saveDefaults(
    org: string,
    user: string,
    body: SaveSendingAccountsDto,
    project?: string
  ) {
    if (!body || !isSendingAccountMap(body.accounts))
      throw new BadRequestException('INVALID_ACCOUNT_BINDINGS');
    this.requestId(body.requestId, true);
    if (project !== undefined)
      await this.projects.assertProjectActive(org, project);
    const result = await this.mutate(
      org,
      user,
      project,
      body.accounts,
      project !== undefined
        ? `sending-accounts:project:${project}`
        : 'sending-accounts:organization',
      body.requestId,
      body.accounts
    );
    return { saved: result.saved, bindings: result.bindings };
  }

  private requestId(id: string | undefined, required = false) {
    if (
      (required || id !== undefined) &&
      (typeof id !== 'string' || !id.trim() || id.length > 128)
    )
      throw new BadRequestException('INVALID_REQUEST_ID');
  }

  // Compatibility adapter: Automation owns its settings, never a second account store.
  async save(
    org: string,
    user: string,
    project: string,
    action: SendAction,
    accounts: AccountBindingMap,
    updateSettings?: (
      settings: EngageConfigMetadata
    ) => EngageConfigMetadata & { scanEnabled?: boolean },
    requestId?: string,
    requestPayload?: unknown
  ): Promise<BindingSaveResult> {
    if (!user) throw new ForbiddenException('AUTHENTICATED_USER_REQUIRED');
    if (!isAccountBindingMap(accounts))
      throw new BadRequestException('INVALID_ACCOUNT_BINDINGS');
    this.requestId(requestId);
    if (requestId && updateSettings && requestPayload === undefined)
      throw new BadRequestException('MUTATION_PAYLOAD_REQUIRED');
    await this.projects.assertProjectActive(org, project);
    const nested = Object.fromEntries(
      Object.entries(accounts).map(([platform, change]) => [
        platform,
        { [action]: change },
      ])
    );
    const result = await this.mutate(
      org,
      user,
      project,
      nested,
      `automation:${project}:${action}`,
      requestId,
      { accounts, requestPayload },
      updateSettings
    );
    return {
      saved: true,
      bindings: result.bindings.map(
        ({ action: _action, ...binding }) => binding
      ),
      settings: result.settings,
    };
  }

  private mutate(
    org: string,
    user: string,
    project: string | undefined,
    accounts: SendingAccountMap,
    operation: string,
    requestId: string | undefined,
    payload: unknown,
    updateSettings?: (
      settings: EngageConfigMetadata
    ) => EngageConfigMetadata & { scanEnabled?: boolean }
  ) {
    const fingerprint = digest(payload);
    return this.transaction(async (tx) => {
      await this.member(tx, org, user);
      const key = {
        organizationId: org,
        userId: user,
        operation,
        requestId: requestId ?? '',
      };
      if (requestId) {
        const receipt = await tx.sendMutationReceipt.findUnique({
          where: { organizationId_userId_operation_requestId: key },
        });
        if (receipt) {
          if (receipt.requestHash !== fingerprint)
            throw new ConflictException('REQUEST_ID_CONFLICT');
          return receipt.result as unknown as {
            saved: true;
            bindings: Array<{
              platform: string;
              action: SendAction;
              integrationId: string | null;
              revision: number;
            }>;
            settings: EngageConfigMetadata;
          };
        }
      }
      const config = operation.startsWith('automation:')
        ? await tx.engageConfig.findFirst({
            where: { organizationId: org, projectId: project },
          })
        : null;
      const before = readEngageConfigMetadata(config);
      const settings: EngageConfigMetadata & { scanEnabled?: boolean } =
        updateSettings ? updateSettings(before) : before;
      const validated: Array<{
        platform: string;
        action: SendAction;
        change: AccountBindingInput;
        prior: { id: string; revision: number } | null;
      }> = [];
      for (const [platform, actions] of Object.entries(accounts).sort(
        ([a], [b]) => a.localeCompare(b)
      )) {
        for (const action of ['POST', 'REPLY'] as const) {
          const change = actions[action];
          if (!change) continue;
          const tuple = { organizationId: org, platform, action };
          const prior =
            project !== undefined
              ? await tx.projectSendBinding.findUnique({
                  where: {
                    organizationId_projectId_platform_action: {
                      ...tuple,
                      projectId: project,
                    },
                  },
                })
              : await tx.organizationSendBinding.findUnique({
                  where: { organizationId_platform_action: tuple },
                });
          if ((prior?.revision ?? 0) !== change.expectedRevision)
            throw new ConflictException('BINDING_REVISION_CONFLICT');
          if (change.integrationId !== null)
            await this.account(
              tx,
              org,
              project,
              platform,
              action,
              change.integrationId
            );
          validated.push({ platform, action, change, prior });
        }
      }
      const bindings: Array<{
        platform: string;
        action: SendAction;
        integrationId: string | null;
        revision: number;
      }> = [];
      for (const { platform, action, change, prior } of validated) {
        const data = {
          integrationId: change.integrationId,
          revision: { increment: 1 },
          updatedByUserId: user,
        };
        if (prior) {
          const where = {
            id: prior.id,
            organizationId: org,
            revision: change.expectedRevision,
          };
          const result =
            project !== undefined
              ? await tx.projectSendBinding.updateMany({ where, data })
              : await tx.organizationSendBinding.updateMany({ where, data });
          if (result.count !== 1)
            throw new ConflictException('BINDING_REVISION_CONFLICT');
        } else {
          const data = {
            organizationId: org,
            platform,
            action,
            integrationId: change.integrationId,
            revision: 1,
            updatedByUserId: user,
          };
          if (project !== undefined)
            await tx.projectSendBinding.create({
              data: { ...data, projectId: project },
            });
          else await tx.organizationSendBinding.create({ data });
        }
        bindings.push({
          platform,
          action,
          integrationId: change.integrationId,
          revision: change.expectedRevision + 1,
        });
      }
      if (updateSettings) {
        const { scanEnabled, ...metadata } = settings;
        const data = {
          metadata: metadata as unknown as Prisma.InputJsonObject,
          ...(scanEnabled !== undefined ? { enabled: scanEnabled } : {}),
        };
        await tx.engageConfig.upsert({
          where: {
            organizationId_projectId: {
              organizationId: org,
              projectId: project!,
            },
          },
          create: { organizationId: org, projectId: project!, ...data },
          update: data,
        });
      }
      const result = { saved: true as const, bindings, settings };
      if (requestId)
        await tx.sendMutationReceipt.create({
          data: {
            ...key,
            requestHash: fingerprint,
            result: result as unknown as Prisma.InputJsonObject,
          },
        });
      return result;
    });
  }
}
