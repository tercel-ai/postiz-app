import { normalizeHandle } from '../database/prisma/integrations/extension-session.utils';
import { requiresLegacyIdentityKey } from './integration-identity-schema';
import { Injectable } from '@nestjs/common';
import { Integration, Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma/prisma.service';
import { sendHash, sendTransaction } from './send-coordination.utils';
import { hasIntegrationProfileConflict, isNewIntegrationProfileClaim } from '../database/prisma/integrations/integration-profile.utils';

export interface StableSocialIdentity {
  platform: string;
  namespace: string;
  id: string;
}
interface SocialIdentityContract {
  namespace: string;
  pattern: RegExp;
  normalize?: (id: string) => string;
  // Historical reports omitted namespaces and may contain either OAuth or browser IDs.
  mixedLegacyNamespaces?: boolean;
}
const SOCIAL_IDENTITIES: Record<string, SocialIdentityContract> = {
  x: { namespace: 'x.rest_id', pattern: /^[1-9][0-9]*$/ },
  reddit: { namespace: 'reddit.user_id', pattern: /^[a-z0-9]+$/,
    normalize: id => id.replace(/^t2_/i, '').toLowerCase() },
  linkedin: { namespace: 'linkedin.fs_miniProfile', pattern: /^[A-Za-z0-9_-]+$/,
    mixedLegacyNamespaces: true },
  'linkedin-page': { namespace: 'linkedin.organization_id', pattern: /^[1-9][0-9]*$/ },
  medium: { namespace: 'medium.handle', pattern: /^[A-Za-z0-9_.-]+$/ },
  quora: { namespace: 'quora.user_id', pattern: /^[1-9][0-9]*$/ },
  hackernews: { namespace: 'hackernews.handle', pattern: /^[A-Za-z0-9_-]{2,15}$/ },
  devto: { namespace: 'devto.user_id', pattern: /^[1-9][0-9]*$/ },
};
export function stableSocialIdentity(
  platform: string,
  namespace: string,
  raw: string
): StableSocialIdentity | null {
  const contract = SOCIAL_IDENTITIES[platform];
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed || !contract || contract.namespace !== namespace) return null;
  const id = contract.normalize?.(trimmed) ?? trimmed;
  return contract.pattern.test(id) ? { platform, namespace, id } : null;
}

/** A recovery candidate is not proof; known conflicting browser identities stay protected. */
function legacyProfileCanBeRecovered(account: Integration, identity: StableSocialIdentity, handle: string): boolean {
  const metadata = account.metadata && typeof account.metadata === 'object' && !Array.isArray(account.metadata)
    ? account.metadata : {};
  const recorded = metadata.stableIdentity;
  if (recorded && typeof recorded === 'object' && !Array.isArray(recorded) &&
      recorded.namespace === identity.namespace && typeof recorded.id === 'string') {
    const known = stableSocialIdentity(identity.platform, identity.namespace, recorded.id);
    if (known && known.id !== identity.id) return false;
  }
  const previous = stableSocialIdentity(identity.platform, identity.namespace, account.internalId);
  if (metadata.credentialSource === 'SESSION_ONLY' && previous && previous.id !== identity.id) return false;
  return normalizeHandle(account.internalId) === handle || !previous ||
    SOCIAL_IDENTITIES[identity.platform].mixedLegacyNamespaces === true;
}
export function oauthSocialIdentity(
  platform: string,
  namespace: string,
  id: string
) {
  return stableSocialIdentity(
    platform,
    namespace === 'legacy'
      ? platform === 'x'
        ? 'x.rest_id'
        : platform === 'reddit'
        ? 'reddit.user_id'
        : platform === 'linkedin-page'
        ? 'linkedin.organization_id'
        : namespace
      : namespace,
    id
  );
}
export interface IdentityOptions {
  source: 'OAUTH' | 'EXTENSION';
  canCreate: boolean;
  maxChannels?: number | null;
  handle?: string;
  name?: string;
  legacyProof?: {
    integrationId: string;
    credentialHash: string;
    verifiedByUserId?: string;
  };
  extensionRecovery?: {
    integrationId: string;
    verifiedByUserId: string;
    probeId: string;
    method?: 'EXPLICIT_EXTENSION_RECOVERY' | 'CONTROLLED_AUTO_RECOVERY';
  };
}
export interface IdentityResolution {
  account?: Integration;
  registrationStatus?: 'EXISTING' | 'CREATED';
  blockCode?: string;
  recovery?: {
    integrationId: string;
    action: 'RESTORE' | 'VERIFY_LEGACY';
    name: string;
  };
}
@Injectable()
export class SocialAccountIdentityService {
  constructor(private readonly db: PrismaService) {}

  resolve(
    org: string,
    platform: string,
    namespace: string,
    rawId: string,
    options: IdentityOptions
  ) {
    return sendTransaction(this.db, (tx) =>
      this.resolveIn(tx, org, platform, namespace, rawId, options)
    );
  }

  async resolveIn(
    tx: Prisma.TransactionClient,
    org: string,
    platform: string,
    namespace: string,
    rawId: string,
    options: IdentityOptions
  ): Promise<IdentityResolution> {
    const identity = stableSocialIdentity(platform, namespace, rawId);
    if (!identity) return { blockCode: 'ACCOUNT_IDENTITY_UNRESOLVED' };
    // Include tombstones and legacy rows: neither may be silently bypassed by a new actor row.
    const rows = await tx.integration.findMany({
      where: { organizationId: org, providerIdentifier: platform },
    });
    const matches = rows.filter(
      (row) =>
        (row.identityNamespace === namespace ||
          row.identityNamespace === 'legacy') &&
        stableSocialIdentity(platform, namespace, row.internalId)?.id ===
          identity.id
    );
    if (matches.length > 1) return { blockCode: 'ACCOUNT_IDENTITY_CONFLICT' };
    if (
      rows.some(
        (row) =>
          ![namespace, 'legacy'].includes(row.identityNamespace) &&
          stableSocialIdentity(platform, namespace, row.internalId)?.id ===
            identity.id
      )
    )
      return { blockCode: 'ACCOUNT_IDENTITY_UNRESOLVED' };
    let account = matches[0];
    // A matching legacy profile is only a recovery suggestion. It is not stable
    // identity proof and must never silently create, merge or verify an account.
    const reportedHandle = normalizeHandle(options.handle ?? '');
    const legacyProfiles = !account && options.source === 'EXTENSION' && reportedHandle
      ? rows.filter(row => row.identityNamespace === 'legacy' && !row.deletedAt &&
        row.type === 'social' && normalizeHandle(row.profile ?? '') === reportedHandle &&
        legacyProfileCanBeRecovered(row, identity, reportedHandle))
      : [];
    const legacyProfile = legacyProfiles.length === 1 ? legacyProfiles[0] : undefined;
    if (!account && options.extensionRecovery) {
      if (legacyProfile?.id !== options.extensionRecovery.integrationId)
        return { blockCode: 'ACCOUNT_RECOVERY_CHANGED' };
      account = legacyProfile;
    }
    const suggestedRecovery = !account && legacyProfile ? {
      integrationId: legacyProfile.id, action: 'VERIFY_LEGACY' as const,
      name: legacyProfile.name || legacyProfile.profile || legacyProfile.internalId,
    } : undefined;
    const profile = options.handle?.trim() || account?.profile;
    if ((account?.identityNamespace === 'legacy' || isNewIntegrationProfileClaim(account, {
      organizationId: org, providerIdentifier: platform, type: account?.type ?? 'social',
      profile, deletedAt: null,
    })) && await hasIntegrationProfileConflict(
      tx, org, platform, profile, account?.id
    )) return { blockCode: 'ACCOUNT_PROFILE_CONFLICT', ...(suggestedRecovery ? { recovery: suggestedRecovery } : {}) };
    const recovery =
      account && (account.deletedAt || account.identityNamespace === 'legacy')
        ? {
            integrationId: account.id,
            action: account.deletedAt
              ? ('RESTORE' as const)
              : ('VERIFY_LEGACY' as const),
            name: account.name,
          }
        : undefined;
    const confirmed =
      options.source === 'EXTENSION' &&
      options.extensionRecovery?.integrationId === account?.id &&
      !!options.extensionRecovery?.verifiedByUserId &&
      !!options.extensionRecovery?.probeId;
    if (
      options.extensionRecovery &&
      (!account || options.extensionRecovery.integrationId !== account.id)
    )
      return { blockCode: 'ACCOUNT_RECOVERY_CHANGED' };
    const canRestore = confirmed || (options.source === 'EXTENSION' &&
      account?.identityNamespace === identity.namespace && account?.internalId === identity.id);
    if (account?.deletedAt && !canRestore)
      return { blockCode: 'ACCOUNT_DELETED', recovery };
    if (account?.deletedAt && canRestore) {
      if (!options.canCreate || options.maxChannels === undefined)
        return { blockCode: 'ACCOUNT_CREATION_NOT_ALLOWED', recovery };
      if (
        options.maxChannels !== null &&
        (!Number.isInteger(options.maxChannels) || options.maxChannels < 0)
      )
        return { blockCode: 'ACCOUNT_CHANNEL_LIMIT_INVALID' };
      const count = await tx.integration.count({
        where: { organizationId: org, deletedAt: null },
      });
      if (options.maxChannels !== null && count >= options.maxChannels)
        return { blockCode: 'ACCOUNT_CHANNEL_LIMIT', recovery };
    }
    if (account) {
      if (
        account.identityNamespace === 'legacy' &&
        !confirmed &&
        (options.source !== 'OAUTH' ||
          options.legacyProof?.integrationId !== account.id ||
          options.legacyProof.credentialHash !==
            sendHash([account.token, account.refreshToken]))
      )
        return { blockCode: 'ACCOUNT_IDENTITY_UNRESOLVED', recovery };
      const changed =
        account.identityNamespace !== identity.namespace ||
        account.internalId !== identity.id;
      if (changed) {
        const used = await tx.sendIntent.findFirst({
          where: { organizationId: org, integrationId: account.id },
        });
        const state = await tx.accountWriteState.findFirst({
          where: {
            organizationId: org,
            OR: [
              { integrationId: account.id },
              { identityIntegrationIds: { has: account.id } },
            ],
          },
        });
        if (used || state) return { blockCode: 'ACCOUNT_IDENTITY_IN_USE' };
      }
      if (
        changed &&
        (await requiresLegacyIdentityKey(tx)) &&
        (await tx.integration.findFirst({
          where: {
            organizationId: org,
            internalId: identity.id,
            id: { not: account.id },
          },
        }))
      )
        return { blockCode: 'ACCOUNT_LEGACY_KEY_CONFLICT' };
      const metadata =
        account.metadata &&
        typeof account.metadata === 'object' &&
        !Array.isArray(account.metadata)
          ? account.metadata
          : {};
      const updated = await tx.integration.update({
        where: { id: account.id, organizationId: org },
        data: {
          identityNamespace: identity.namespace,
          internalId: identity.id,
          ...(canRestore && account.deletedAt ? { deletedAt: null } : {}),
          ...(options.handle?.trim() ? { profile: options.handle.trim() } : {}),
          metadata: {
            ...metadata,
            ...(confirmed
              ? {
                  identityAudit: {
                    version: 1,
                    method:
                      options.extensionRecovery!.method ??
                      'EXPLICIT_EXTENSION_RECOVERY',
                    verifiedAt: new Date().toISOString(),
                    verifiedByUserId:
                      options.extensionRecovery!.verifiedByUserId,
                    probeId: options.extensionRecovery!.probeId,
                    namespace,
                    id: identity.id,
                    previousNamespace: account.identityNamespace,
                    restored: !!account.deletedAt,
                  },
                }
              : {}),
            ...(options.legacyProof
              ? {
                  identityAudit: {
                    version: 1,
                    method: 'OAUTH_CREDENTIAL_PROBE',
                    verifiedAt: new Date().toISOString(),
                    verifiedByUserId:
                      options.legacyProof.verifiedByUserId ?? null,
                    namespace,
                    id: identity.id,
                  },
                }
              : {}),
            stableIdentity: {
              version: 1,
              namespace,
              id: identity.id,
              source: options.source,
            },
          },
        },
      });
      return { account: updated, registrationStatus: 'EXISTING' };
    }
    if (!options.canCreate || options.maxChannels === undefined)
      return { blockCode: 'ACCOUNT_CREATION_NOT_ALLOWED' };
    if (
      options.maxChannels !== null &&
      (!Number.isInteger(options.maxChannels) || options.maxChannels < 0)
    )
      return { blockCode: 'ACCOUNT_CHANNEL_LIMIT_INVALID' };
    // Count and create run in the caller's Serializable transaction. Concurrent
    // inserts retry the complete report/connect, including this predicate read.
    const count = await tx.integration.count({
      where: { organizationId: org, deletedAt: null },
    });
    if (options.maxChannels !== null && count >= options.maxChannels)
      return { blockCode: 'ACCOUNT_CHANNEL_LIMIT' };
    // During expand, the legacy organization/internalId index is still installed.
    const collision = await tx.integration.findFirst({
      where: { organizationId: org, internalId: identity.id },
    });
    if (collision && (await requiresLegacyIdentityKey(tx)))
      return { blockCode: 'ACCOUNT_LEGACY_KEY_CONFLICT' };
    const created = await tx.integration.create({
      data: {
        organizationId: org,
        providerIdentifier: platform,
        identityNamespace: namespace,
        internalId: identity.id,
        rootInternalId: identity.id,
        name: options.name?.trim() || options.handle?.trim() || identity.id,
        profile: options.handle?.trim() || null,
        type: 'social',
        token: '',
        refreshToken: '',
        tokenExpiration: null,
        metadata: {
          credentialSource: 'SESSION_ONLY',
          stableIdentity: {
            version: 1,
            namespace,
            id: identity.id,
            source: options.source,
          },
        },
      },
    });
    return { account: created, registrationStatus: 'CREATED' };
  }
}
