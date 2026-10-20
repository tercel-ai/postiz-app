import { ForbiddenException, Injectable } from '@nestjs/common';
import { ExtensionNodeSession, Prisma } from '@prisma/client';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { ProjectValidationService } from '@gitroom/nestjs-libraries/projects/project-validation.service';
import { SendPolicyService } from '@gitroom/nestjs-libraries/extension/send-policy.service';
import { isAccountBoundSendingEnabled } from '@gitroom/nestjs-libraries/extension/account-bound-sending.config';
import { accountBindingError } from '@gitroom/nestjs-libraries/extension/account-binding-error';
import { canonicalControlledPlatform, CONTROLLED_SEND_PLATFORMS } from '@gitroom/nestjs-libraries/extension/controlled-platforms';
import { channelAvailability, NODE_ONLINE_MS } from '@gitroom/nestjs-libraries/extension/extension-node.protocol';
import { matchesSendActor, sendTransaction } from '@gitroom/nestjs-libraries/extension/send-coordination.utils';

const actions = ['POST', 'REPLY'] as const;
const providers = [...CONTROLLED_SEND_PLATFORMS, 'linkedin-page'];
const nodeSelect = {
  id: true, nodeId: true, registeredByUserId: true, name: true, browser: true,
  status: true, lastSeenAt: true, capabilities: true,
  sessions: { select: {
    id: true, platform: true, integrationId: true, accountIdentity: true,
    verificationStatus: true, verifiedAt: true, verificationExpiresAt: true,
    observedAt: true, receivedAt: true,
  } },
} satisfies Prisma.ExtensionNodeSelect;
type NodeRow = Prisma.ExtensionNodeGetPayload<{ select: typeof nodeSelect }>;
type SessionRow = NodeRow['sessions'][number];

function identity(value: ExtensionNodeSession['accountIdentity']) {
  const row = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    id: typeof row.id === 'string' ? row.id : null,
    namespace: typeof row.namespace === 'string' ? row.namespace : null,
    handle: typeof row.handle === 'string' ? row.handle : null,
  };
}

function terminal(node: NodeRow, session: SessionRow, now: Date) {
  const connectionStatus = node.status === 'REVOKED' ? 'REVOKED'
    : node.lastSeenAt && now.getTime() - node.lastSeenAt.getTime() < NODE_ONLINE_MS ? 'ONLINE' : 'OFFLINE';
  const sessionStatus = session.verificationStatus === 'VERIFIED' &&
    (!session.verificationExpiresAt || session.verificationExpiresAt <= now) ? 'STALE' : session.verificationStatus;
  const capabilities = node.capabilities as Record<string, { post?: boolean; reply?: boolean; strictAccountVerification?: boolean }> | null;
  const capability = capabilities?.[session.platform];
  return {
    id: node.id, nodeId: node.nodeId, registeredByUserId: node.registeredByUserId,
    name: node.name, browser: node.browser, connectionStatus, sessionStatus,
    lastSeenAt: node.lastSeenAt,
    observedAt: session.observedAt, receivedAt: session.receivedAt,
    verifiedAt: session.verifiedAt, verificationExpiresAt: session.verificationExpiresAt,
    capabilities: { post: capability?.post === true && capability?.strictAccountVerification === true,
      reply: capability?.reply === true && capability?.strictAccountVerification === true },
  };
}
type Terminal = ReturnType<typeof terminal>;
function availability(terminals: Terminal[], action: 'POST' | 'REPLY') {
  return channelAvailability(false, terminals.map(node => ({
    online: node.connectionStatus === 'ONLINE', verified: node.sessionStatus === 'VERIFIED',
    capable: node.capabilities[action === 'POST' ? 'post' : 'reply'],
  })));
}

@Injectable()
export class SendingContextService {
  constructor(private readonly db: PrismaService, private readonly projects: ProjectValidationService,
    private readonly policies: SendPolicyService) {}

  async get(org: string, user: string, project: string) {
    if (!user) throw new ForbiddenException('AUTHENTICATED_USER_REQUIRED');
    await this.projects.assertProjectAccess(org, project);
    const projectStatus = await this.projects.getActivationVerdict(org, project);
    const enabled = isAccountBoundSendingEnabled();
    return sendTransaction(this.db, async tx => {
      const member = await tx.userOrganization.findUnique({ where: { userId_organizationId: { userId: user, organizationId: org } } });
      if (!member || member.disabled) throw new ForbiddenException('ORGANIZATION_MEMBERSHIP_REQUIRED');
      const enrolled = !enabled && await tx.accountWriteState.count({ where: { organizationId: org } });
      const mode = enabled ? 'CONTROLLED' : enrolled ? 'PAUSED' : 'LEGACY';
      const now = new Date();
      const base = { organizationId: org, userId: user, projectId: project, mode, projectStatus, serverNow: now.toISOString() };
      if (mode === 'LEGACY') return { ...base, requireAccountSelection: null, accounts: [], defaults: {} };
      const policy = enabled ? await this.policies.snapshotInTransaction(tx, user) : null;
      const accounts = await tx.integration.findMany({
        where: { organizationId: org, deletedAt: null, providerIdentifier: { in: providers } },
        select: { id: true, organizationId: true, providerIdentifier: true, internalId: true,
          identityNamespace: true, name: true, profile: true, picture: true, disabled: true,
          deletedAt: true, inBetweenSteps: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      const relations = await tx.integrationProject.findMany({
        where: { organizationId: org, projectId: project },
        select: { integrationId: true, disabled: true, engageEnabled: true },
      });
      const local = await tx.projectSendBinding.findMany({ where: { organizationId: org, projectId: project } });
      const global = await tx.organizationSendBinding.findMany({ where: { organizationId: org } });
      const nodes = await tx.extensionNode.findMany({
        where: { organizationId: org, registeredBy: { activated: true,
          organizations: { some: { organizationId: org, disabled: false } } } },
        select: nodeSelect, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      const byId = new Map(accounts.map(account => [account.id, account]));
      const byRelation = new Map(relations.map(row => [row.integrationId, row]));
      const sessions = nodes.flatMap(node => node.sessions.filter(session =>
        (CONTROLLED_SEND_PLATFORMS as readonly string[]).includes(session.platform)
      ).map(session => ({ node, session, actor: identity(session.accountIdentity) })));
      const matched = new Set<string>();
      const block = mode === 'PAUSED' ? 'ACCOUNT_BINDINGS_NOT_ENABLED'
        : projectStatus === 'inactive' ? 'PROJECT_INACTIVE'
        : projectStatus === 'unknown' ? 'PROJECT_VALIDATION_UNAVAILABLE' : null;
      const choices = accounts.map(account => {
        const platform = canonicalControlledPlatform(account.providerIdentifier);
        const relation = byRelation.get(account.id);
        const terminals = sessions.filter(({ session, actor }) =>
          session.integrationId === account.id && session.platform === platform &&
          !!account.identityNamespace && !!actor.id && !!actor.namespace &&
          matchesSendActor({ id: account.internalId, idNamespace: account.identityNamespace },
            { id: actor.id, idNamespace: actor.namespace })
        ).map(({ node, session }) => { matched.add(session.id); return terminal(node, session, now); });
        return {
          key: account.id, integrationId: account.id, platform, providerIdentifier: account.providerIdentifier,
          name: account.name, handle: account.profile, picture: account.picture,
          projectAssigned: !!relation && !relation.disabled, detectedByExtension: terminals.length > 0,
          actions: Object.fromEntries(actions.map(action => {
            const reason = block ?? accountBindingError(account, relation, org, project, platform, action);
            return [action, { canSelect: !reason, reason, availability: availability(terminals, action) }];
          })), terminals,
        };
      });
      // Unresolved reported identities are visible, but can never become synthetic selectable IDs.
      for (const { node, session, actor } of sessions.filter(row => !matched.has(row.session.id))) {
        const terminals = [terminal(node, session, now)];
        choices.push({ key: `session:${session.id}`, integrationId: null, platform: session.platform,
          providerIdentifier: session.platform, name: actor.handle ?? actor.id, handle: actor.handle, picture: null,
          projectAssigned: false, detectedByExtension: true,
          actions: Object.fromEntries(actions.map(action => [action, { canSelect: false,
            reason: block ?? 'ACCOUNT_IDENTITY_UNRESOLVED', availability: availability(terminals, action) }])), terminals });
      }
      const defaults = Object.fromEntries(CONTROLLED_SEND_PLATFORMS.map(platform => [platform,
        Object.fromEntries(actions.map(action => {
          const configured = local.find(row => row.platform === platform && row.action === action);
          const parent = global.find(row => row.platform === platform && row.action === action);
          const effective = configured?.integrationId ? configured : parent;
          const id = effective?.integrationId ?? null;
          return [action, { integrationId: configured?.integrationId ?? null, effectiveIntegrationId: id,
            source: !id ? 'UNBOUND' : configured?.integrationId ? 'PROJECT' : 'ORGANIZATION',
            blockCode: id ? accountBindingError(byId.get(id), byRelation.get(id), org, project, platform, action) : 'SEND_BINDING_REQUIRED' }];
        })),
      ]));
      return { ...base, requireAccountSelection: policy?.requirePreselectedAccount ?? null, accounts: choices, defaults };
    });
  }
}
