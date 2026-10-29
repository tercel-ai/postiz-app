import { createHash, createHmac } from 'node:crypto';
import { stableSocialIdentity } from './social-account-identity.service';

export const SESSION_TTL_MS = 300_000;
export const NODE_ONLINE_MS = 180_000;
export const ACCOUNT_BOUND_PROTOCOL = 'ACCOUNT_BOUND_V1';
export const NODE_ID_PATTERN = /^[0-9a-f]{64}$/;
export const LIVE_EVIDENCE = ['LIVE_COOKIE_ID', 'LIVE_PAGE_ACTOR'] as const;

export interface AccountObservation {
  platform: string;
  actorContext?: string;
  controllerId?: string;
  sessionBinding?: string;
  preflightChallenge?: string;
  loggedIn: boolean;
  id?: string;
  handle?: string;
  identityNamespace?: string;
  evidenceKind?: string;
  verificationStatus?: string;
  probeId?: string;
  identityObservedAt?: string;
}
export interface ObservedAccount {
  id: string;
  internalId: string;
  providerIdentifier: string;
  identityNamespace?: string | null;
  profile?: string | null;
  metadata?: unknown;
}
export interface SessionReading {
  integrationId: string | null;
  verificationStatus: string;
  sessionRevision: number;
  probeId: string | null;
  verifiedAt: Date | null;
  verificationExpiresAt: Date | null;
}

export const hashSecret = (value: string) =>
  createHash('sha256').update(value).digest('hex');
export const nodeSecret = (
  key: string,
  org: string,
  user: string,
  node: string,
  salt: string
) =>
  createHmac('sha256', key)
    .update(JSON.stringify(['extension-node-v1', org, user, node, salt]))
    .digest('base64url');

function normalizeIdentity(namespace: string, value: string): string {
  const raw = value.trim();
  if (namespace === 'reddit.user_id')
    return raw.replace(/^t2_/i, '').toLowerCase();
  if (namespace === 'x.handle' || namespace === 'reddit.handle')
    return raw.replace(/^@|^u\//, '').toLowerCase();
  return raw;
}

// Company actors share LinkedIn transport, but never share a member identity/session.
export function observationProvider(entry: { platform: string; identityNamespace?: string }) {
  return entry.platform === 'linkedin' && entry.identityNamespace === 'linkedin.organization_id'
    ? 'linkedin-page' : entry.platform;
}
export function sessionActorKey(identity?: { id?: string; namespace?: string } | null) {
  return identity?.namespace === 'linkedin.organization_id' && /^[1-9][0-9]*$/.test(identity.id ?? '')
    ? `linkedin.organization_id:${identity!.id}` : '';
}

export function resolveObservedAccount(
  entry: AccountObservation,
  accounts: ObservedAccount[]
): string | null {
  if (!entry.loggedIn || !entry.identityNamespace) return null;
  const namespace = entry.identityNamespace;
  const raw =
    namespace.endsWith('.handle') || namespace.endsWith('.profile_slug')
      ? entry.id || entry.handle
      : entry.id;
  if (!raw?.trim()) return null;
  const identity = normalizeIdentity(namespace, raw);
  const matches = accounts.filter((account) => {
    if (account.providerIdentifier !== observationProvider(entry)) return false;
    if (
      account.identityNamespace === namespace &&
      normalizeIdentity(namespace, account.internalId) === identity
    )
      return true;
    const aliases = (account.metadata as { identityAliases?: unknown } | null)
      ?.identityAliases;
    return (
      Array.isArray(aliases) &&
      aliases.some(
        (alias) =>
          alias &&
          alias.namespace === namespace &&
          typeof alias.id === 'string' &&
          normalizeIdentity(namespace, alias.id) === identity
      )
    );
  });
  return matches.length === 1 ? matches[0].id : null;
}

export function sessionDecision(
  entry: AccountObservation,
  previous:
    | (SessionReading & {
        accountIdentity?: unknown;
        lastVerifiedIdentity?: unknown;
      })
    | null,
  now: Date,
  matchedId: string | null
): SessionReading {
  const at = entry.identityObservedAt
    ? Date.parse(entry.identityObservedAt)
    : NaN;
  const live = LIVE_EVIDENCE.includes(
    entry.evidenceKind as (typeof LIVE_EVIDENCE)[number]
  ) && (entry.identityNamespace !== 'linkedin.organization_id' || entry.evidenceKind === 'LIVE_PAGE_ACTOR');
  const fresh =
    Number.isFinite(at) &&
    at <= now.getTime() &&
    now.getTime() - at < SESSION_TTL_MS;
  const duplicate = !!entry.probeId && entry.probeId === previous?.probeId;
  const sameAccount =
    matchedId != null && matchedId === previous?.integrationId;
  const priorIdentity = (previous?.lastVerifiedIdentity ?? previous?.accountIdentity) as {
    id?: string; handle?: string; namespace?: string; sessionBinding?: string; controllerId?: string; actorContext?: string;
  } | null;
  // Cookie continuity can renew an existing identity, never establish a new actor or authorize a send.
  const sessionContinuous = entry.evidenceKind === 'SESSION_BOUND_ACTOR' &&
    !entry.preflightChallenge && sameAccount && previous?.verificationStatus === 'VERIFIED' && !!previous.verifiedAt &&
    /^[a-f0-9]{64}$/.test(entry.sessionBinding ?? '') && entry.sessionBinding === priorIdentity?.sessionBinding &&
    entry.identityNamespace === priorIdentity?.namespace && !!entry.id && entry.id === priorIdentity.id &&
    ((entry.identityNamespace !== 'linkedin.organization_id' &&
        !!stableSocialIdentity(entry.platform, entry.identityNamespace, entry.id)) ||
      (entry.platform === 'linkedin' && entry.identityNamespace === 'linkedin.organization_id' &&
        entry.actorContext === 'COMPANY_ADMIN' && ['COMPANY_ADMIN', 'COMPOSER'].includes(priorIdentity.actorContext ?? '') &&
        !!entry.controllerId && entry.controllerId === priorIdentity.controllerId));
  const replay =
    entry.evidenceKind !== 'SESSION_BOUND_ACTOR' &&
    (duplicate || entry.evidenceKind === 'CACHED') &&
    sameAccount &&
    previous?.verificationStatus === 'VERIFIED' &&
    (previous.verificationExpiresAt?.getTime() ?? 0) > now.getTime();
  const verified =
    entry.loggedIn &&
    entry.verificationStatus === 'VERIFIED' &&
    !!matchedId &&
    !!entry.probeId &&
    (((live || sessionContinuous) && fresh && !duplicate) || replay);
  const status = !entry.loggedIn
    ? 'LOGGED_OUT'
    : entry.verificationStatus === 'UNSUPPORTED'
    ? 'UNSUPPORTED'
    : verified
    ? 'VERIFIED'
    : 'UNKNOWN';
  const namespace = entry.identityNamespace;
  const observedId =
    namespace?.endsWith('.handle') || namespace?.endsWith('.profile_slug')
      ? entry.id || entry.handle
      : entry.id;
  const priorId = priorIdentity?.id || priorIdentity?.handle;
  const changedLiveActor =
    live &&
    fresh &&
    !duplicate &&
    !!namespace &&
    priorIdentity?.namespace === namespace &&
    !!observedId &&
    !!priorId &&
    normalizeIdentity(namespace, observedId) !==
      normalizeIdentity(namespace, priorId);
  const switched =
    changedLiveActor ||
    (!!matchedId &&
      !!previous?.integrationId &&
      matchedId !== previous.integrationId);
  const integrationId =
    !entry.loggedIn || (switched && !verified)
      ? null
      : verified
      ? matchedId
      : previous?.integrationId ?? null;
  const changed =
    !previous ||
    integrationId !== previous.integrationId ||
    status !== previous.verificationStatus;
  const newEvidence = verified && live && fresh && !duplicate;
  return {
    integrationId,
    verificationStatus: status,
    sessionRevision: (previous?.sessionRevision ?? 0) + (changed ? 1 : 0),
    probeId: newEvidence ? entry.probeId! : previous?.probeId ?? null,
    verifiedAt:
      !entry.loggedIn || (switched && !verified)
        ? null
        : newEvidence
        ? now
        : previous?.verifiedAt ?? null,
    verificationExpiresAt:
      !entry.loggedIn || (switched && !verified)
        ? null
        : newEvidence || (verified && sessionContinuous && fresh && !duplicate)
        ? new Date(at + SESSION_TTL_MS)
        : previous?.verificationExpiresAt ?? null,
  };
}

export function channelAvailability(
  disabled: boolean,
  terminals: Array<{ online: boolean; verified: boolean; capable: boolean }>
): string {
  if (disabled) return 'ACCOUNT_DISABLED';
  if (terminals.some((t) => t.online && t.verified && t.capable))
    return 'AVAILABLE';
  if (!terminals.some((t) => t.online)) return 'WAITING_FOR_TERMINAL';
  if (!terminals.some((t) => t.online && t.verified))
    return 'SESSION_UNVERIFIED';
  return 'CAPABILITY_UNSUPPORTED';
}
