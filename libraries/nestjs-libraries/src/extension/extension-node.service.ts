import {
  SocialAccountIdentityService,
  stableSocialIdentity,
} from './social-account-identity.service';
import { confirmSendPreflight } from './send-preflight';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma, ExtensionNode } from '@prisma/client';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../database/prisma/prisma.service';
import { ExtensionSessionReportDto } from '../dtos/integrations/extension-session-report.dto';
import {
  RegisterExtensionNodeDto,
  SaveExtensionNodeDto,
} from './extension-node.dto';
import {
  ACCOUNT_BOUND_PROTOCOL,
  channelAvailability,
  hashSecret,
  NODE_ONLINE_MS,
  NODE_ID_PATTERN,
  nodeSecret,
  resolveObservedAccount,
  sessionDecision,
  sessionActorKey,
  observationProvider,
} from './extension-node.protocol';
import { CONTROLLED_SEND_PLATFORMS } from './controlled-platforms';
import { organizationSendModeKey } from './send-mode.service';

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

@Injectable()
export class ExtensionNodeService {
  constructor(private readonly db: PrismaService) {}

  private async transact<T>(
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
          ['P2034', 'P2002'].includes((error as { code?: string }).code ?? '')
        )
          continue;
        throw error;
      }
    }
  }

  private async member(
    tx: Pick<Prisma.TransactionClient, 'userOrganization'>,
    org: string,
    user: string
  ) {
    const member = await tx.userOrganization.findUnique({
      where: { userId_organizationId: { userId: user, organizationId: org } },
    });
    if (!member || member.disabled)
      throw new ForbiddenException('ORGANIZATION_MEMBERSHIP_REQUIRED');
    return member;
  }

  private async automaticLegacyRecoveryAllowedIn(
    tx: Pick<Prisma.TransactionClient, 'settings' | 'userOrganization'>,
    org: string,
    user: string
  ) {
    const [member, setting] = await Promise.all([
      tx.userOrganization.findUnique({
        where: { userId_organizationId: { userId: user, organizationId: org } },
      }),
      tx.settings.findUnique({ where: { key: organizationSendModeKey(org) } }),
    ]);
    const mode = setting?.value as { mode?: unknown } | null;
    return (
      mode?.mode === 'CONTROLLED' &&
      !!member &&
      !member.disabled &&
      ['ADMIN', 'SUPERADMIN'].includes(member.role)
    );
  }

  async register(org: string, user: string, body: RegisterExtensionNodeDto) {
    const key = process.env.EXTENSION_NODE_CREDENTIAL_KEY;
    if (!key || key.length < 32)
      throw new ServiceUnavailableException(
        'EXTENSION_NODE_CREDENTIAL_KEY_REQUIRED'
      );
    if (
      body.protocolVersion !== ACCOUNT_BOUND_PROTOCOL ||
      !body.requestId?.trim()
    )
      throw new BadRequestException('EXTENSION_PROTOCOL_REQUIRED');
    this.validateCapabilities(body.capabilities);
    if (typeof body.nodeId !== 'string' || !NODE_ID_PATTERN.test(body.nodeId))
      throw new BadRequestException('INVALID_NODE_IDENTITY');
    const nodeId = body.nodeId.toLowerCase();
    const fingerprint = hashSecret(canonical(body));
    return this.transact(async (tx) => {
      await this.member(tx, org, user);
      let node = await tx.extensionNode.findUnique({
        where: {
          organizationId_registeredByUserId_nodeId: {
            organizationId: org,
            registeredByUserId: user,
            nodeId,
          },
        },
      });
      const now = new Date();
      if (node) {
        if (
          node.status !== 'ACTIVE' ||
          node.registeredByUserId !== user ||
          node.registrationRequestId !== body.requestId ||
          node.registrationRequestHash !== fingerprint ||
          node.registrationExpiresAt <= now
        )
          throw new ConflictException('NODE_REGISTRATION_RECOVERY_REQUIRED');
        if (
          hashSecret(
            nodeSecret(key, org, user, node.id, node.credentialSalt)
          ) !== node.credentialHash
        )
          throw new ConflictException('NODE_REGISTRATION_RECOVERY_REQUIRED');
      } else {
        const id = randomUUID(),
          salt = randomUUID();
        node = await tx.extensionNode.create({
          data: {
            id,
            organizationId: org,
            registeredByUserId: user,
            nodeId,
            name: body.name?.trim() || `${body.browser} · ${id.slice(0, 8)}`,
            browser: body.browser,
            credentialSalt: salt,
            credentialHash: hashSecret(nodeSecret(key, org, user, id, salt)),
            registrationRequestId: body.requestId,
            registrationRequestHash: fingerprint,
            registrationExpiresAt: new Date(now.getTime() + 600_000),
            protocolVersion: body.protocolVersion,
            extensionVersion: body.extensionVersion,
            capabilities: body.capabilities as Prisma.InputJsonObject,
          },
        });
      }
      return {
        organizationId: org,
        registeredByUserId: user,
        nodeId: node.nodeId,
        nodeToken: nodeSecret(key, org, user, node.id, node.credentialSalt),
        credentialVersion: node.credentialVersion,
        protocolVersion: node.protocolVersion,
      };
    });
  }

  private validateCapabilities(
    capabilities: RegisterExtensionNodeDto['capabilities']
  ) {
    if (
      !capabilities ||
      Array.isArray(capabilities) ||
      typeof capabilities !== 'object' ||
      Object.keys(capabilities).length > 16
    )
      throw new BadRequestException('INVALID_NODE_CAPABILITIES');
    for (const value of Object.values(capabilities)) {
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.entries(value).some(
          ([k, v]) =>
            !['post', 'reply', 'strictAccountVerification'].includes(k) ||
            typeof v !== 'boolean'
        )
      )
        throw new BadRequestException('INVALID_NODE_CAPABILITIES');
    }
  }

  async authenticate(
    org: string,
    user: string,
    nodeId?: string,
    token?: string
  ): Promise<ExtensionNode> {
    return this.authenticateIn(this.db, org, user, nodeId, token);
  }

  async authenticateIn(
    tx: Pick<Prisma.TransactionClient, 'extensionNode' | 'userOrganization'>,
    org: string,
    user: string,
    nodeId?: string,
    token?: string,
    allowRevoked = false
  ) {
    await this.member(tx, org, user);
    const node =
      nodeId && token
        ? await tx.extensionNode.findFirst({
            where: { nodeId, organizationId: org, registeredByUserId: user },
          })
        : null;
    const provided = Buffer.from(hashSecret(token ?? ''), 'hex');
    const expected = Buffer.from(node?.credentialHash ?? '', 'hex');
    if (
      !node ||
      node.registeredByUserId !== user ||
      node.organizationId !== org ||
      (node.status !== 'ACTIVE' &&
        !(allowRevoked && node.status === 'REVOKED')) ||
      node.protocolVersion !== ACCOUNT_BOUND_PROTOCOL ||
      expected.length !== provided.length ||
      !timingSafeEqual(expected, provided)
    )
      throw new UnauthorizedException('NODE_AUTHENTICATION_REQUIRED');
    return node;
  }

  async save(org: string, user: string, body: SaveExtensionNodeDto) {
    if (body.status !== undefined && body.status !== 'REVOKED')
      throw new BadRequestException('NODE_CANNOT_BE_REACTIVATED');
    if (body.name !== undefined && !body.name.trim())
      throw new BadRequestException('NODE_NAME_REQUIRED');
    return this.transact(async (tx) => {
      const member = await this.member(tx, org, user);
      const owner = body.registeredByUserId ?? user;
      if (owner !== user && !['ADMIN', 'SUPERADMIN'].includes(member.role))
        throw new ForbiddenException('NODE_MANAGEMENT_FORBIDDEN');
      const node = await tx.extensionNode.findFirst({
        where: {
          nodeId: body.nodeId,
          organizationId: org,
          registeredByUserId: owner,
        },
      });
      if (!node) throw new ForbiddenException('NODE_NOT_ACCESSIBLE');
      if (
        node.registeredByUserId !== user &&
        !['ADMIN', 'SUPERADMIN'].includes(member.role)
      )
        throw new ForbiddenException('NODE_MANAGEMENT_FORBIDDEN');
      const update = await tx.extensionNode.updateMany({
        where: {
          id: node.id,
          organizationId: org,
          revision: body.expectedRevision,
        },
        data: {
          ...(body.name !== undefined ? { name: body.name.trim() } : {}),
          ...(body.status ? { status: body.status } : {}),
          revision: { increment: 1 },
        },
      });
      if (update.count !== 1)
        throw new ConflictException('NODE_REVISION_CONFLICT');
      return {
        nodeId: node.nodeId,
        registeredByUserId: node.registeredByUserId,
        revision: body.expectedRevision + 1,
        name: body.name?.trim() ?? node.name,
        status: body.status ?? node.status,
      };
    });
  }

  async identityProbePlatforms(
    org: string,
    user: string,
    id: string | undefined,
    token: string | undefined,
    rootPostId?: string
  ) {
    if (rootPostId !== undefined && (!rootPostId || rootPostId.length > 128))
      throw new BadRequestException('SEND_ROOT_INVALID');
    return this.transact(async (tx) => {
      const node = await this.authenticateIn(tx, org, user, id, token);
      const now = new Date();
      const sessions = await tx.extensionNodeSession.findMany({
        where: {
          organizationId: org,
          extensionNodeId: node.id,
          verificationStatus: 'VERIFIED',
          integrationId: { not: null },
          verificationExpiresAt: { gt: new Date(now.getTime() + 60000) },
        },
      });
      const platforms: string[] = [];
      for (const platform of CONTROLLED_SEND_PLATFORMS) {
        const capability = (node.capabilities as any)?.[platform];
        if (!capability?.strictAccountVerification) continue;
        const fresh = sessions.filter(
          (session) => session.platform === platform
        );
        const actions = [
          capability.post && 'POST',
          capability.reply && 'REPLY',
        ].filter(Boolean) as ('POST' | 'REPLY')[];
        if (!actions.length) continue;
        const pending = await tx.post.findFirst({
          where: {
            organizationId: org,
            state: 'QUEUE',
            parentPostId: null,
            deletedAt: null,
            ...(rootPostId ? { id: rootPostId } : {}),
            executionProtocol: 'ACCOUNT_BOUND_V1',
            publishMethod: 'EXTENSION',
            publishDate: { lte: now },
            providerIdentifier: {
              in:
                platform === 'linkedin'
                  ? ['linkedin', 'linkedin-page']
                  : [platform],
            },
            sendIntent: {
              status: { in: ['QUEUED', 'RESERVED'] },
              action: { in: actions },
            },
            OR: [
              {
                integrationId: {
                  not: null,
                  notIn: fresh.map((session) => session.integrationId!),
                },
              },
              ...(!fresh.some((session) => !session.actorKey)
                ? [
                    {
                      integrationId: null,
                      accountSelectionMode: 'CURRENT_SESSION',
                      accountResolution: { not: 'PRESELECTION_REQUIRED' },
                    },
                  ]
                : []),
            ],
          },
          select: { id: true },
        });
        if (pending) platforms.push(platform);
      }
      return { platforms };
    });
  }

  async list(org: string, user: string) {
    await this.member(this.db, org, user);
    const rows = await this.db.extensionNode.findMany({
      where: { organizationId: org },
      include: { sessions: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((node) => ({
      nodeId: node.nodeId,
      name: node.name,
      browser: node.browser,
      status: node.status,
      revision: node.revision,
      lastSeenAt: node.lastSeenAt,
      registeredByUserId: node.registeredByUserId,
      connectionStatus: this.connection(node),
      protocolVersion: node.protocolVersion,
      extensionVersion: node.extensionVersion,
      sessions: node.sessions.map((s) => ({
        platform: s.platform,
        integrationId: s.integrationId,
        accountIdentity: s.accountIdentity,
        verificationStatus: s.verificationStatus,
        sessionRevision: s.sessionRevision,
        verifiedAt: s.verifiedAt,
        verificationExpiresAt: s.verificationExpiresAt,
      })),
    }));
  }

  private connection(node: Pick<ExtensionNode, 'status' | 'lastSeenAt'>) {
    return node.status === 'REVOKED'
      ? 'REVOKED'
      : node.lastSeenAt &&
        Date.now() - node.lastSeenAt.getTime() < NODE_ONLINE_MS
      ? 'ONLINE'
      : 'OFFLINE';
  }

  async report(
    org: string,
    user: string,
    id: string | undefined,
    token: string | undefined,
    body: ExtensionSessionReportDto,
    creation: { canCreateChannels?: boolean; maxChannels?: number | null } = {}
  ) {
    if (!Number.isSafeInteger(body.reportSequence) || body.reportSequence! < 1)
      throw new BadRequestException('REPORT_SEQUENCE_REQUIRED');
    const platforms = body.platforms.map(
      (e) =>
        `${e.platform}:${sessionActorKey({
          id: e.id,
          namespace: e.identityNamespace,
        })}`
    );
    if (new Set(platforms).size !== platforms.length)
      throw new BadRequestException('DUPLICATE_REPORT_PLATFORM');
    if (body.capabilities !== undefined)
      this.validateCapabilities(body.capabilities);
    const fingerprint = hashSecret(canonical(body));
    return this.transact(async (tx) => {
      const node = await this.authenticateIn(tx, org, user, id, token);
      if (body.platforms.some((entry) => entry.accountRecovery !== undefined)) {
        const member = await this.member(tx, org, user);
        if (!['ADMIN', 'SUPERADMIN'].includes(member.role))
          throw new ForbiddenException('ACCOUNT_IDENTITY_ADMIN_REQUIRED');
      }
      const now = new Date();
      const metadata =
        body.reportSequence! > node.lastReportSequence
          ? {
              ...(body.extensionVersion !== undefined
                ? { extensionVersion: body.extensionVersion }
                : {}),
              ...(body.capabilities !== undefined
                ? { capabilities: body.capabilities as Prisma.InputJsonObject }
                : {}),
            }
          : {};
      const sequence = body.reportSequence!;
      const receipt = await tx.extensionNodeReportReceipt.findUnique({
        where: {
          extensionNodeId_sequence: { extensionNodeId: node.id, sequence },
        },
      });
      if (receipt) {
        if (receipt.requestHash !== fingerprint)
          throw new ConflictException('REPORT_SEQUENCE_CONFLICT');
        return receipt.result;
      }
      if (sequence <= node.lastReportSequence)
        throw new ConflictException('REPORT_OUT_OF_ORDER');
      const accounts = body.platforms.length
        ? await tx.integration.findMany({
            where: {
              organizationId: org,
              providerIdentifier: {
                in: [...new Set(body.platforms.map(observationProvider))],
              },
              deletedAt: null,
            },
          })
        : [];
      const results = [];
      for (const entry of body.platforms) {
        const actorKey = sessionActorKey({
          id: entry.id,
          namespace: entry.identityNamespace,
        });
        if (
          entry.identityNamespace === 'linkedin.organization_id' &&
          (entry.platform !== 'linkedin' ||
            !actorKey ||
            (entry.loggedIn &&
              (!/^[A-Za-z0-9_-]+$/.test(entry.controllerId ?? '') ||
                !['COMPANY_ADMIN', 'COMPOSER'].includes(
                  entry.actorContext ?? ''
                ))))
        )
          throw new BadRequestException('COMPANY_ACTOR_EVIDENCE_REQUIRED');
        const prior = await tx.extensionNodeSession.findUnique({
          where: {
            extensionNodeId_platform: {
              extensionNodeId: node.id,
              platform: entry.platform,
              actorKey,
            },
          },
        });
        if (
          entry.platform === 'linkedin' &&
          !actorKey &&
          (!entry.loggedIn || (prior?.accountIdentity as any)?.id !== entry.id)
        ) {
          await tx.extensionNodeSession.updateMany({
            where: {
              extensionNodeId: node.id,
              platform: 'linkedin',
              actorKey: { not: '' },
            },
            data: {
              verificationStatus: 'UNKNOWN',
              verificationExpiresAt: null,
              sessionRevision: { increment: 1 },
            },
          });
        }
        let matched = resolveObservedAccount(entry, accounts);
        let registration: {
          registrationStatus?: string;
          blockCode?: string;
          recovery?: {
            integrationId: string;
            action: 'RESTORE' | 'VERIFY_LEGACY';
            name: string;
          };
        } = {};
        const probe = sessionDecision(entry, prior, now, 'identity-candidate');
        if (
          entry.accountRecovery !== undefined &&
          (!entry.accountRecovery ||
            typeof entry.accountRecovery !== 'object' ||
            entry.accountRecovery.confirmed !== true ||
            typeof entry.accountRecovery.integrationId !== 'string' ||
            !entry.accountRecovery.integrationId ||
            entry.accountRecovery.integrationId.length > 128 ||
            probe.verificationStatus !== 'VERIFIED' ||
            entry.probeId === prior?.probeId ||
            !['LIVE_COOKIE_ID', 'LIVE_PAGE_ACTOR'].includes(
              entry.evidenceKind ?? ''
            ) ||
            !stableSocialIdentity(
              observationProvider(entry),
              entry.identityNamespace ?? '',
              entry.id ?? ''
            ))
        )
          throw new BadRequestException('ACCOUNT_RECOVERY_EVIDENCE_REQUIRED');
        if (
          probe.verificationStatus === 'VERIFIED' &&
          entry.probeId !== prior?.probeId &&
          ['LIVE_COOKIE_ID', 'LIVE_PAGE_ACTOR'].includes(
            entry.evidenceKind ?? ''
          ) &&
          stableSocialIdentity(
            observationProvider(entry),
            entry.identityNamespace ?? '',
            entry.id ?? ''
          )
        ) {
          const identityService = new SocialAccountIdentityService(this.db);
          const options = {
            source: 'EXTENSION' as const,
            canCreate: creation.canCreateChannels === true,
            maxChannels: creation.maxChannels,
            handle: entry.handle,
            name: entry.name,
            ...(entry.accountRecovery
              ? {
                  extensionRecovery: {
                    integrationId: entry.accountRecovery.integrationId,
                    verifiedByUserId: user,
                    probeId: entry.probeId!,
                  },
                }
              : {}),
          };
          let resolved = await identityService.resolveIn(
            tx,
            org,
            observationProvider(entry),
            entry.identityNamespace!,
            entry.id!,
            options
          );
          // Entering controlled mode is an administrator-authorized migration.
          // A registered node's fresh live actor proof can therefore complete
          // VERIFY_LEGACY without making the administrator click each account.
          // Deleted accounts still require an explicit RESTORE confirmation.
          if (
            !entry.accountRecovery &&
            resolved.recovery?.action === 'VERIFY_LEGACY' &&
            (await this.automaticLegacyRecoveryAllowedIn(tx, org, user))
          ) {
            resolved = await identityService.resolveIn(
              tx,
              org,
              observationProvider(entry),
              entry.identityNamespace!,
              entry.id!,
              {
                ...options,
                extensionRecovery: {
                  integrationId: resolved.recovery.integrationId,
                  verifiedByUserId: user,
                  probeId: entry.probeId!,
                  method: 'CONTROLLED_AUTO_RECOVERY',
                },
              }
            );
          }
          registration = resolved;
          matched = resolved.account?.id ?? null;
        }
        const decision = sessionDecision(entry, prior, now, matched);
        const previousIdentity = (prior?.lastVerifiedIdentity ??
          prior?.accountIdentity) as {
          id?: string;
          namespace?: string;
          controllerId?: string;
          sessionBinding?: string;
        } | null;
        const sameIdentity =
          previousIdentity?.id === entry.id &&
          previousIdentity?.namespace === entry.identityNamespace &&
          (entry.identityNamespace !== 'linkedin.organization_id' ||
            previousIdentity?.controllerId === entry.controllerId);
        const sessionBinding =
          entry.sessionBinding ??
          (decision.verificationStatus === 'VERIFIED' && sameIdentity
            ? previousIdentity?.sessionBinding
            : undefined);
        const data = {
          ...decision,
          actorKey,
          reportSequence: sequence,
          receivedAt: now,
          evidenceKind: entry.evidenceKind ?? 'UNKNOWN',
          observedAt: new Date(body.checkedAt),
          identityObservedAt: entry.identityObservedAt
            ? new Date(entry.identityObservedAt)
            : null,
          accountIdentity: {
            id: entry.id ?? null,
            handle: entry.handle ?? null,
            namespace: entry.identityNamespace ?? null,
            ...(sessionBinding ? { sessionBinding } : {}),
            ...(entry.actorContext ? { actorContext: entry.actorContext } : {}),
            ...(entry.controllerId ? { controllerId: entry.controllerId } : {}),
          },
          ...(!entry.loggedIn
            ? { lastVerifiedIdentity: Prisma.DbNull }
            : decision.verificationStatus === 'VERIFIED' &&
              decision.probeId !== prior?.probeId
            ? {
                lastVerifiedIdentity: {
                  id: entry.id ?? null,
                  handle: entry.handle ?? null,
                  namespace: entry.identityNamespace ?? null,
                  ...(sessionBinding ? { sessionBinding } : {}),
                  ...(entry.actorContext
                    ? { actorContext: entry.actorContext }
                    : {}),
                  ...(entry.controllerId
                    ? { controllerId: entry.controllerId }
                    : {}),
                },
              }
            : {}),
        };
        await tx.extensionNodeSession.upsert({
          where: {
            extensionNodeId_platform: {
              extensionNodeId: node.id,
              platform: entry.platform,
              actorKey,
            },
          },
          create: {
            ...data,
            organizationId: org,
            extensionNodeId: node.id,
            platform: entry.platform,
          },
          update: data,
        });
        await confirmSendPreflight(
          tx,
          node,
          entry,
          decision,
          prior?.probeId,
          now
        );
        results.push({
          platform: entry.platform,
          actorKey,
          integrationId: decision.integrationId,
          registrationStatus: !entry.loggedIn
            ? 'NOT_APPLICABLE'
            : registration.registrationStatus ??
              (matched ? 'EXISTING' : 'IDENTITY_UNRESOLVED'),
          ...(registration.blockCode
            ? { blockCode: registration.blockCode }
            : {}),
          ...(registration.recovery ? { recovery: registration.recovery } : {}),
          sessionRevision: decision.sessionRevision,
          verificationStatus: decision.verificationStatus,
          verificationExpiresAt:
            decision.verificationExpiresAt?.toISOString() ?? null,
        });
      }
      const updated = await tx.extensionNode.updateMany({
        where: {
          id: node.id,
          status: 'ACTIVE',
          lastReportSequence: node.lastReportSequence,
        },
        data: { lastSeenAt: now, lastReportSequence: sequence, ...metadata },
      });
      if (updated.count !== 1)
        throw new ConflictException('NODE_STATE_CHANGED');
      const result = { results };
      await tx.extensionNodeReportReceipt.create({
        data: {
          extensionNodeId: node.id,
          sequence,
          requestHash: fingerprint,
          result,
        },
      });
      return result;
    });
  }

  async accountViews(
    org: string,
    user: string,
    accounts: Array<{ id: string; disabled?: boolean }>,
    action: 'post' | 'reply' = 'post'
  ) {
    await this.member(this.db, org, user);
    const rows = accounts.length
      ? await this.db.extensionNodeSession.findMany({
          where: {
            organizationId: org,
            integrationId: { in: accounts.map((a) => a.id) },
            extensionNode: {
              registeredBy: {
                activated: true,
                organizations: {
                  some: { organizationId: org, disabled: false },
                },
              },
            },
          },
          include: { extensionNode: true },
        })
      : [];
    return new Map(
      accounts.map((account) => {
        const matched = rows.filter((row) => row.integrationId === account.id);
        const terminals = matched.map((row) => {
          const connectionStatus = this.connection(row.extensionNode);
          const verified =
            row.verificationStatus === 'VERIFIED' &&
            !!row.verificationExpiresAt &&
            row.verificationExpiresAt.getTime() > Date.now();
          const capabilities = row.extensionNode
            .capabilities as RegisterExtensionNodeDto['capabilities'];
          const capable =
            capabilities?.[row.platform]?.[action] === true &&
            capabilities?.[row.platform]?.strictAccountVerification === true;
          return {
            nodeId: row.extensionNode.nodeId,
            registeredByUserId: row.extensionNode.registeredByUserId,
            name: row.extensionNode.name,
            browser: row.extensionNode.browser,
            connectionStatus,
            sessionStatus: verified
              ? 'VERIFIED'
              : row.verificationStatus === 'VERIFIED'
              ? 'STALE'
              : 'UNKNOWN',
            lastSeenAt: row.extensionNode.lastSeenAt,
            verifiedAt: row.verifiedAt,
            verificationExpiresAt: row.verificationExpiresAt,
            online: connectionStatus === 'ONLINE',
            verified,
            capable,
          };
        });
        return [
          account.id,
          {
            sendAvailability: channelAvailability(
              !!account.disabled,
              terminals
            ),
            terminals: terminals.map(
              ({ online, verified, capable, ...terminal }) => terminal
            ),
          },
        ];
      })
    );
  }
}
