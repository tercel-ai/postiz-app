import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ExtensionSessionPlatformDto } from '@gitroom/nestjs-libraries/dtos/integrations/extension-session-report.dto';
import { sessionDecision } from '../extension-node.protocol';
import { ExtensionNodeService } from '../extension-node.service';
import { confirmSendPreflight } from '../send-preflight';
import { memorySendDatabase } from './support/memory-send-database';

const now = new Date('2026-10-22T08:00:00Z');
const binding = 'a'.repeat(64);
const identity = { id: 'ACoAlice', namespace: 'linkedin.fs_miniProfile', sessionBinding: binding };
const live = { platform: 'linkedin', loggedIn: true, id: identity.id, identityNamespace: identity.namespace,
  evidenceKind: 'LIVE_PAGE_ACTOR', verificationStatus: 'VERIFIED', probeId: 'page', sessionBinding: binding,
  identityObservedAt: now.toISOString() };
const renewal = { ...live, evidenceKind: 'SESSION_BOUND_ACTOR', probeId: 'cookie',
  identityObservedAt: new Date(now.getTime() + 600_000).toISOString() };
const later = new Date(renewal.identityObservedAt);
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
afterEach(() => vi.useRealTimers());

describe('cookie-bound actor continuity', () => {
  const previous = () => ({ ...sessionDecision(live, null, now, 'account'), accountIdentity: identity, lastVerifiedIdentity: identity });
  it('renews an established identity after availability expires without changing the live proof or revision', () => {
    const prior = previous();
    const next = sessionDecision(renewal, prior, later, 'account');
    expect(next).toMatchObject({ verificationStatus: 'VERIFIED', probeId: prior.probeId,
      verifiedAt: prior.verifiedAt, sessionRevision: prior.sessionRevision });
    expect(next.verificationExpiresAt).toEqual(new Date(later.getTime() + 300_000));
  });
  it.each([
    ['first identity', null, renewal, 'account'],
    ['different cookie', previous(), { ...renewal, sessionBinding: 'b'.repeat(64) }, 'account'],
    ['missing cookie binding', previous(), { ...renewal, sessionBinding: undefined }, 'account'],
    ['different actor', previous(), { ...renewal, id: 'ACoBob' }, 'account'],
    ['different namespace', previous(), { ...renewal, identityNamespace: 'linkedin.oauth_sub' }, 'account'],
    ['different integration', previous(), renewal, 'other'],
    ['unknown identity', { ...previous(), verificationStatus: 'UNKNOWN' }, renewal, 'account'],
    ['signed out', { ...previous(), verificationStatus: 'LOGGED_OUT' }, renewal, 'account'],
    ['missing live proof', { ...previous(), verifiedAt: null }, renewal, 'account'],
    ['unsupported platform', previous(), { ...renewal, platform: 'medium' }, 'account'],
    ['challenge', previous(), { ...renewal, preflightChallenge: 'challenge' }, 'account'],
    ['stale reading', previous(), { ...renewal, identityObservedAt: now.toISOString() }, 'account'],
    ['future reading', previous(), { ...renewal, identityObservedAt: new Date(later.getTime() + 1).toISOString() }, 'account'],
  ])('refuses %s', (_label, prior, entry, matched) => {
    expect(sessionDecision(entry as any, prior as any, later, matched as string).verificationStatus).toBe('UNKNOWN');
  });
  it('requires the same company controller and an established admin context', () => {
    const companyIdentity = { id: '123', namespace: 'linkedin.organization_id', controllerId: 'ACoAlice', actorContext: 'COMPANY_ADMIN', sessionBinding: binding };
    const company = { ...live, id: '123', identityNamespace: companyIdentity.namespace, controllerId: 'ACoAlice', actorContext: 'COMPANY_ADMIN' };
    const prior = { ...sessionDecision(company, null, now, 'company'), accountIdentity: companyIdentity, lastVerifiedIdentity: companyIdentity };
    const reading = { ...company, ...renewal, id: '123', identityNamespace: companyIdentity.namespace, controllerId: 'ACoAlice', actorContext: 'COMPANY_ADMIN' };
    expect(sessionDecision(reading, prior, later, 'company').verificationStatus).toBe('VERIFIED');
    expect(sessionDecision({ ...reading, controllerId: 'ACoBob' }, prior, later, 'company').verificationStatus).toBe('UNKNOWN');
    expect(sessionDecision({ ...reading, actorContext: 'COMPOSER' }, prior, later, 'company').verificationStatus).toBe('UNKNOWN');
  });
  it('accepts only valid binding digests in the HTTP DTO', async () => {
    expect(await validate(plainToInstance(ExtensionSessionPlatformDto, renewal))).toEqual([]);
    const invalid = await validate(plainToInstance(ExtensionSessionPlatformDto, { ...renewal, sessionBinding: 'raw-cookie' }));
    expect(invalid.some(error => error.property === 'sessionBinding')).toBe(true);
  });
  it('cannot satisfy a real send challenge', async () => {
    const update = vi.fn();
    const tx = { sendSegment: { findFirst: async () => ({ executionId: 'execution' }), update },
      sendExecution: { findUniqueOrThrow: async () => ({ extensionNodeId: 'node', nodeCredentialVersion: 1, platform: 'linkedin', integrationId: 'account' }) } };
    await expect(confirmSendPreflight(tx as any, { id: 'node', credentialVersion: 1 } as any,
      { ...renewal, preflightChallenge: 'challenge' }, { ...previous(), verificationStatus: 'VERIFIED' }, 'page', later))
      .rejects.toThrow('SEND_PREFLIGHT_EVIDENCE_INVALID');
    expect(update).not.toHaveBeenCalled();
  });
  it.each(['linkedin', 'devto', 'linkedin-page'])('renews %s through the real report service without creating another account', async platform => {
    const db = memorySendDatabase();
    db.seed('extensionNode', { id: 'node', nodeId: 'node', organizationId: 'org', status: 'ACTIVE', lastReportSequence: 0 });
    const service = new ExtensionNodeService(db as any);
    vi.spyOn(service, 'authenticateIn').mockImplementation(async () => db.rows('extensionNode')[0]);
    vi.spyOn(service as any, 'member').mockResolvedValue({ role: 'ADMIN' });
    const actor = platform === 'linkedin' ? live : platform === 'devto'
      ? { ...live, platform, id: '123', identityNamespace: 'devto.user_id' }
      : { ...live, id: '123', identityNamespace: 'linkedin.organization_id', controllerId: 'ACoAlice', actorContext: 'COMPANY_ADMIN' };
    const report = (row: any, sequence: number) => service.report('org', 'user', 'node', 'token',
      { checkedAt: row.identityObservedAt, reportSequence: sequence, platforms: [row] }, { canCreateChannels: true, maxChannels: 2 });
    const initial: any = await report(actor, 1);
    const prior = structuredClone(db.rows('extensionNodeSession')[0]);
    vi.setSystemTime(later);
    const result: any = await report({ ...actor, evidenceKind: 'SESSION_BOUND_ACTOR', probeId: 'cookie', identityObservedAt: later.toISOString() }, 2);
    expect(result.results[0]).toMatchObject({ integrationId: initial.results[0].integrationId, verificationStatus: 'VERIFIED' });
    expect(db.rows('integration')).toHaveLength(1);
    expect(db.rows('extensionNodeSession')[0]).toMatchObject({ probeId: prior.probeId, verifiedAt: prior.verifiedAt,
      verificationExpiresAt: new Date(later.getTime() + 300_000), accountIdentity: { sessionBinding: binding } });
    await report({ ...actor, sessionBinding: undefined, probeId: 'fresh-page', identityObservedAt: later.toISOString() }, 3);
    expect(db.rows('extensionNodeSession')[0].lastVerifiedIdentity.sessionBinding).toBe(binding);
    const repeated: any = await report({ ...actor, evidenceKind: 'SESSION_BOUND_ACTOR', probeId: 'cookie-again', identityObservedAt: later.toISOString() }, 4);
    expect(repeated.results[0].verificationStatus).toBe('VERIFIED');
    await expect(report({ ...actor, evidenceKind: 'SESSION_BOUND_ACTOR', probeId: 'recovery', identityObservedAt: later.toISOString(),
      accountRecovery: { integrationId: initial.results[0].integrationId, confirmed: true } }, 5)).rejects.toThrow('ACCOUNT_RECOVERY_EVIDENCE_REQUIRED');
  });
});

describe('seven-platform availability continuity', () => {
  const actors = [
    ['x', '123', 'x.rest_id'], ['reddit', 'abc', 'reddit.user_id'],
    ['linkedin', 'ACoAlice', 'linkedin.fs_miniProfile'], ['medium', 'alice', 'medium.handle'],
    ['quora', '123', 'quora.user_id'], ['hackernews', 'alice', 'hackernews.handle'],
    ['devto', '123', 'devto.user_id'],
  ] as const;
  it.each(actors)('renews %s through the persisted report and projects it as available without due work', async (platform, id, namespace) => {
    const db = memorySendDatabase();
    db.seed('extensionNode', { id: 'node', nodeId: 'node', organizationId: 'org', status: 'ACTIVE', lastReportSequence: 0,
      capabilities: { [platform]: { post: true, reply: true, strictAccountVerification: true } } });
    const service = new ExtensionNodeService(db as any);
    vi.spyOn(service, 'authenticateIn').mockImplementation(async () => db.rows('extensionNode')[0]);
    vi.spyOn(service as any, 'member').mockResolvedValue({ role: 'ADMIN' });
    const actor = { ...live, platform, id, identityNamespace: namespace,
      evidenceKind: platform === 'x' || platform === 'reddit' ? 'LIVE_COOKIE_ID' : 'LIVE_PAGE_ACTOR' };
    const report = (row: any, sequence: number) => service.report('org', 'user', 'node', 'token',
      { checkedAt: row.identityObservedAt, reportSequence: sequence, platforms: [row] }, { canCreateChannels: true, maxChannels: 2 });
    const initial: any = await report(actor, 1);
    const prior = structuredClone(db.rows('extensionNodeSession')[0]);
    vi.setSystemTime(later);
    const result: any = await report({ ...actor, evidenceKind: 'SESSION_BOUND_ACTOR', probeId: 'continuity', identityObservedAt: later.toISOString() }, 2);
    expect(result.results[0]).toMatchObject({ integrationId: initial.results[0].integrationId, verificationStatus: 'VERIFIED' });
    expect(db.rows('integration')).toHaveLength(1);
    const current = db.rows('extensionNodeSession')[0];
    expect(current).toMatchObject({ verifiedAt: prior.verifiedAt, probeId: prior.probeId, sessionRevision: prior.sessionRevision,
      verificationExpiresAt: new Date(later.getTime() + 300_000) });
    const { projectAccountTerminal, terminalAvailability } = await import('../extension-node.projection');
    const terminal = projectAccountTerminal(db.rows('extensionNode')[0] as any, current as any, later);
    expect(terminal).toMatchObject({ connectionStatus: 'ONLINE', sessionStatus: 'VERIFIED' });
    expect(terminalAvailability([terminal], 'POST')).toBe('AVAILABLE');
    expect(terminalAvailability([terminal], 'REPLY')).toBe('AVAILABLE');
    const identity = { id, namespace, sessionBinding: binding };
    const reading = { ...actor, evidenceKind: 'SESSION_BOUND_ACTOR', probeId: 'new', identityObservedAt: later.toISOString() };
    const previous = { ...prior, accountIdentity: identity, lastVerifiedIdentity: identity };
    expect(sessionDecision({ ...reading, sessionBinding: 'b'.repeat(64) }, previous, later, initial.results[0].integrationId).verificationStatus).toBe('UNKNOWN');
    expect(sessionDecision(reading, previous, later, 'different-account').verificationStatus).toBe('UNKNOWN');
    expect(sessionDecision({ ...reading, preflightChallenge: 'challenge' }, previous, later, initial.results[0].integrationId).verificationStatus).toBe('UNKNOWN');
  });
});
