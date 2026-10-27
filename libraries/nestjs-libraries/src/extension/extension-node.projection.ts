import type { ExtensionNode, ExtensionNodeSession, Integration } from '@prisma/client';
import { canonicalControlledPlatform } from './controlled-platforms';
import { channelAvailability, NODE_ONLINE_MS } from './extension-node.protocol';
import { matchesSendActor } from './send-coordination.utils';

type AccountIdentity = Pick<Integration, 'id' | 'providerIdentifier' | 'internalId' | 'identityNamespace'>;
type SessionIdentity = Pick<ExtensionNodeSession, 'integrationId' | 'platform' | 'accountIdentity'>;
type TerminalNode = Pick<ExtensionNode,
  'id' | 'nodeId' | 'registeredByUserId' | 'name' | 'browser' | 'status' | 'lastSeenAt' | 'capabilities'>;
type TerminalSession = Pick<ExtensionNodeSession,
  'platform' | 'verificationStatus' | 'verifiedAt' | 'verificationExpiresAt' | 'observedAt' | 'receivedAt'>;

export function matchesAccountSession(account: AccountIdentity | null | undefined, session: SessionIdentity): boolean {
  const actor = session.accountIdentity;
  return !!account && session.integrationId === account.id &&
    session.platform === canonicalControlledPlatform(account.providerIdentifier) &&
    !!account.internalId && !!account.identityNamespace && account.identityNamespace !== 'legacy' &&
    !!actor && typeof actor === 'object' && !Array.isArray(actor) &&
    typeof actor.id === 'string' && typeof actor.namespace === 'string' &&
    matchesSendActor({ id: account.internalId, idNamespace: account.identityNamespace },
      { id: actor.id, idNamespace: actor.namespace });
}

export function nodeConnectionStatus(node: Pick<ExtensionNode, 'status' | 'lastSeenAt'>, now: Date) {
  return node.status === 'REVOKED' ? 'REVOKED'
    : node.lastSeenAt && now.getTime() - node.lastSeenAt.getTime() < NODE_ONLINE_MS ? 'ONLINE' : 'OFFLINE';
}

export function projectAccountTerminal(node: TerminalNode, session: TerminalSession, now: Date) {
  const sessionStatus = session.verificationStatus === 'VERIFIED' &&
    (!session.verificationExpiresAt || session.verificationExpiresAt <= now) ? 'STALE' : session.verificationStatus;
  const capabilities = node.capabilities as Record<string, { post?: boolean; reply?: boolean; strictAccountVerification?: boolean }> | null;
  const capability = capabilities?.[session.platform];
  return {
    id: node.id, nodeId: node.nodeId, registeredByUserId: node.registeredByUserId,
    name: node.name, browser: node.browser, connectionStatus: nodeConnectionStatus(node, now), sessionStatus,
    lastSeenAt: node.lastSeenAt, observedAt: session.observedAt, receivedAt: session.receivedAt,
    verifiedAt: session.verifiedAt, verificationExpiresAt: session.verificationExpiresAt,
    capabilities: { post: capability?.post === true && capability?.strictAccountVerification === true,
      reply: capability?.reply === true && capability?.strictAccountVerification === true },
  };
}

export function terminalAvailability(terminals: ReturnType<typeof projectAccountTerminal>[], action: 'POST' | 'REPLY', disabled = false) {
  return channelAvailability(disabled, terminals.map(node => ({
    online: node.connectionStatus === 'ONLINE', verified: node.sessionStatus === 'VERIFIED',
    capable: node.capabilities[action === 'POST' ? 'post' : 'reply'],
  })));
}
