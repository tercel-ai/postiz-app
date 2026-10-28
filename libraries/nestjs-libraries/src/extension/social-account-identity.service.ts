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
export function stableSocialIdentity(
  platform: string,
  namespace: string,
  raw: string
): StableSocialIdentity | null {
  const id = typeof raw === 'string' ? raw.trim() : '';
  if (!id) return null;
  if (platform === 'x' && namespace === 'x.rest_id' && /^[1-9][0-9]*$/.test(id))
    return { platform, namespace, id };
  if (platform === 'reddit' && namespace === 'reddit.user_id') {
    const normalized = id?.replace(/^t2_/i, '').toLowerCase();
    if (/^[a-z0-9]+$/.test(normalized))
      return { platform, namespace, id: normalized };
  }
  if (
    platform === 'linkedin-page' &&
    namespace === 'linkedin.organization_id' &&
    /^[1-9][0-9]*$/.test(id)
  )
    return { platform, namespace, id };
  const rules: Record<string, [string, RegExp]> = {
    linkedin: ['linkedin.fs_miniProfile', /^[A-Za-z0-9_-]+$/],
    medium: ['medium.handle', /^[A-Za-z0-9_.-]+$/],
    quora: ['quora.user_id', /^[1-9][0-9]*$/],
    hackernews: ['hackernews.handle', /^[A-Za-z0-9_-]{2,15}$/],
    devto: ['devto.user_id', /^[1-9][0-9]*$/],
  };
  const rule = rules[platform];
  if (rule?.[0] === namespace && rule[1].test(id))
    return { platform, namespace, id };
  return null;
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
    const account = matches[0];
    const profile = options.handle?.trim() || account?.profile;
    if (isNewIntegrationProfileClaim(account, {
      organizationId: org, providerIdentifier: platform, type: account?.type ?? 'social',
      profile, deletedAt: null,
    }) && await hasIntegrationProfileConflict(
      tx, org, platform, profile, account?.id
    )) return { blockCode: 'ACCOUNT_PROFILE_CONFLICT' };
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
    if (account?.deletedAt && !confirmed)
      return { blockCode: 'ACCOUNT_DELETED', recovery };
    if (account?.deletedAt && confirmed) {
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
          ...(confirmed && account.deletedAt ? { deletedAt: null } : {}),
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
