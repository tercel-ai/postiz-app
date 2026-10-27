import { ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { ProjectValidationService } from '@gitroom/nestjs-libraries/projects/project-validation.service';
import { SendPolicyService } from '@gitroom/nestjs-libraries/extension/send-policy.service';
import { SendModeService } from '@gitroom/nestjs-libraries/extension/send-mode.service';
import { accountBindingError } from '@gitroom/nestjs-libraries/extension/account-binding-error';
import { canonicalControlledPlatform, CONTROLLED_SEND_PLATFORMS } from '@gitroom/nestjs-libraries/extension/controlled-platforms';
import { matchesAccountSession, projectAccountTerminal, terminalAvailability } from '@gitroom/nestjs-libraries/extension/extension-node.projection';
import { sendTransaction } from '@gitroom/nestjs-libraries/extension/send-coordination.utils';

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

@Injectable()
export class SendingContextService {
  constructor(private readonly db: PrismaService, private readonly projects: ProjectValidationService,
    private readonly policies: SendPolicyService, private readonly modes: SendModeService) {}

  async get(org: string, user: string, project: string) {
    if (!user) throw new ForbiddenException('AUTHENTICATED_USER_REQUIRED');
    await this.projects.assertProjectAccess(org, project);
    const projectStatus = await this.projects.getActivationVerdict(org, project);
    return sendTransaction(this.db, async tx => {
      const member = await tx.userOrganization.findUnique({ where: { userId_organizationId: { userId: user, organizationId: org } } });
      if (!member || member.disabled) throw new ForbiddenException('ORGANIZATION_MEMBERSHIP_REQUIRED');
      const state = await this.modes.stateIn(tx, org);
      const mode = state.mode;
      const now = new Date();
      const base = { organizationId: org, userId: user, projectId: project, mode, modeRevision: state.revision, systemEnabled: state.systemEnabled, autonomousAllowed: state.autonomousAllowed, projectStatus, serverNow: now.toISOString() };
      if (mode === 'AUTONOMOUS') return { ...base, requireAccountSelection: null, accounts: [], defaults: {} };
      const policy = mode === 'CONTROLLED' ? await this.policies.snapshotInTransaction(tx, user) : null;
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
      ).map(session => ({ node, session })));
      const block = mode === 'PAUSED' ? 'ACCOUNT_BINDINGS_NOT_ENABLED'
        : projectStatus === 'inactive' ? 'PROJECT_INACTIVE'
        : projectStatus === 'unknown' ? 'PROJECT_VALIDATION_UNAVAILABLE' : null;
      const choices = accounts.map(account => {
        const platform = canonicalControlledPlatform(account.providerIdentifier);
        const relation = byRelation.get(account.id);
        const terminals = sessions.filter(({ session }) => matchesAccountSession(account, session))
          .map(({ node, session }) => projectAccountTerminal(node, session, now));
        return {
          key: account.id, integrationId: account.id, platform, providerIdentifier: account.providerIdentifier,
          name: account.name, handle: account.profile, picture: account.picture,
          projectAssigned: !!relation && !relation.disabled, detectedByExtension: terminals.length > 0,
          actions: Object.fromEntries(actions.map(action => {
            const reason = block ?? accountBindingError(account, relation, org, project, platform, action);
            return [action, { canSelect: !reason, reason, availability: terminalAvailability(terminals, action) }];
          })), terminals,
        };
      });
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
