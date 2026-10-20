import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SendingContextService } from '../sending-context.service';
import { SendingContextController } from '../../api/routes/sending-context.controller';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';

const now = new Date('2026-10-19T12:00:00Z');
const account = {
  id: 'x1', organizationId: 'org', providerIdentifier: 'x', internalId: '123', identityNamespace: 'x.rest_id',
  name: 'Alice', profile: 'alice', picture: 'https://example.com/alice.png', disabled: false, deletedAt: null,
  inBetweenSteps: false, token: 'secret-oauth-token', refreshToken: 'secret-refresh',
};
const session = {
  id: 'session', platform: 'x', integrationId: 'x1', accountIdentity: { id: '123', namespace: 'x.rest_id', handle: 'alice', secret: 'secret-identity' },
  verificationStatus: 'VERIFIED', verifiedAt: now, verificationExpiresAt: new Date(now.getTime() + 300_000),
  observedAt: now, receivedAt: now, probeId: 'secret-probe', lastVerifiedIdentity: { secret: 'secret-identity-history' },
};
const node = {
  id: 'terminal', nodeId: 'a'.repeat(64), registeredByUserId: 'user', organizationId: 'org', name: 'Office', browser: 'chrome',
  status: 'ACTIVE', lastSeenAt: now, capabilities: { x: { post: true, reply: false, strictAccountVerification: true } },
  sessions: [session], credentialHash: 'secret-credential', credentialSalt: 'secret-salt',
};
function setup() {
  const db = {
    userOrganization: { findUnique: vi.fn().mockResolvedValue({ disabled: false }) },
    accountWriteState: { count: vi.fn().mockResolvedValue(0) },
    integration: { findMany: vi.fn().mockResolvedValue([{ ...account }]) },
    integrationProject: { findMany: vi.fn().mockResolvedValue([{ integrationId: 'x1', disabled: false, engageEnabled: true }]) },
    projectSendBinding: { findMany: vi.fn().mockResolvedValue([{ platform: 'x', action: 'POST', integrationId: 'x1', revision: 7 }]) },
    organizationSendBinding: { findMany: vi.fn().mockResolvedValue([]) },
    extensionNode: { findMany: vi.fn().mockResolvedValue([structuredClone(node)]) },
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation(work => work(db));
  const projects = { assertProjectAccess: vi.fn(), getActivationVerdict: vi.fn().mockResolvedValue('active') };
  const policies = { snapshotInTransaction: vi.fn().mockResolvedValue({ requirePreselectedAccount: true }) };
  const modes = { stateIn: vi.fn().mockResolvedValue({ mode: 'CONTROLLED', revision: 4, systemEnabled: true, autonomousAllowed: false }) };
  return { db, projects, policies, modes, service: new SendingContextService(db as any, projects as any, policies as any, modes as any) };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'true'); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe('shared Project, Post and Reply sending context', () => {
  it('aggregates actual project authorization, defaults and reported terminals with consistent account IDs', async () => {
    const { service, db, policies } = setup();
    const result = await service.get('org', 'user', 'project');
    expect(result).toMatchObject({ mode: 'CONTROLLED', projectId: 'project', requireAccountSelection: true });
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0]).toMatchObject({ integrationId: 'x1', platform: 'x', projectAssigned: true, detectedByExtension: true,
      actions: { POST: { canSelect: true, reason: null, availability: 'AVAILABLE' }, REPLY: { canSelect: true, availability: 'CAPABILITY_UNSUPPORTED' } },
      terminals: [{ id: 'terminal', sessionStatus: 'VERIFIED', connectionStatus: 'ONLINE' }] });
    expect(result.defaults.x.POST).toEqual({ integrationId: 'x1', effectiveIntegrationId: 'x1', source: 'PROJECT', blockCode: null });
    expect(result.defaults.x.REPLY).toEqual({ integrationId: null, effectiveIntegrationId: null, source: 'UNBOUND', blockCode: 'SEND_BINDING_REQUIRED' });
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'Serializable' });
    expect(policies.snapshotInTransaction).toHaveBeenCalledWith(db, 'user');
    expect(result).toMatchObject({ modeRevision: 4, autonomousAllowed: false });
    expect(result.defaults.x.POST).not.toHaveProperty('revision');
  });
  it('keeps a single account row across multiple nodes and does not require the current browser to match', async () => {
    const { service, db } = setup();
    const other = structuredClone(node);
    Object.assign(other, { id: 'remote-terminal', nodeId: 'b'.repeat(64), registeredByUserId: 'remote-user', name: 'Remote' });
    other.sessions[0].id = 'remote-session';
    db.extensionNode.findMany.mockResolvedValue([node, other]);
    const result = await service.get('org', 'user', 'project');
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0].terminals).toHaveLength(2);
  });
  it.each(['OFFLINE', 'STALE', 'LOGGED_OUT'])('keeps authorized accounts selectable while exposing %s node/session state', async status => {
    const { service, db } = setup();
    const reported = structuredClone(node);
    if (status === 'OFFLINE') reported.lastSeenAt = new Date(now.getTime() - 600_000);
    if (status === 'STALE') reported.sessions[0].verificationExpiresAt = new Date(now.getTime() - 1);
    if (status === 'LOGGED_OUT') reported.sessions[0].verificationStatus = status;
    db.extensionNode.findMany.mockResolvedValue([reported]);
    const result = await service.get('org', 'user', 'project');
    expect(result.accounts[0].actions.POST.canSelect).toBe(true);
    expect(result.accounts[0].actions.POST.availability).toBe(status === 'OFFLINE' ? 'WAITING_FOR_TERMINAL' : 'SESSION_UNVERIFIED');
  });
  it('exposes unidentified plugin sessions without making synthetic IDs selectable', async () => {
    const { service, db } = setup();
    const reported = structuredClone(node);
    Object.assign(reported.sessions[0], { integrationId: null, verificationStatus: 'UNKNOWN', accountIdentity: { handle: 'new-login' } });
    db.extensionNode.findMany.mockResolvedValue([reported]);
    const result = await service.get('org', 'user', 'project');
    expect(result.accounts).toHaveLength(2);
    expect(result.accounts[1]).toMatchObject({ key: 'session:session', integrationId: null, detectedByExtension: true,
      actions: { POST: { canSelect: false, reason: 'ACCOUNT_IDENTITY_UNRESOLVED' }, REPLY: { canSelect: false } } });
    expect(result.accounts[0].actions.POST.availability).toBe('WAITING_FOR_TERMINAL');
  });
  it('does not associate a session by matching handle when stable identity differs', async () => {
    const { service, db } = setup();
    const reported = structuredClone(node);
    reported.sessions[0].accountIdentity.id = 'another-id';
    db.extensionNode.findMany.mockResolvedValue([reported]);
    const result = await service.get('org', 'user', 'project');
    expect(result.accounts[0].terminals).toEqual([]);
    expect(result.accounts[1].integrationId).toBeNull();
  });
  it.each(['reddit', 'linkedin', 'medium', 'quora', 'hackernews', 'devto'])('includes %s platform actors in the same selection shape', async platform => {
    const { service, db } = setup();
    db.integration.findMany.mockResolvedValue([{ ...account, providerIdentifier: platform, identityNamespace: `${platform}.user_id` }]);
    const reported = structuredClone(node);
    reported.capabilities = { [platform]: { post: true, reply: true, strictAccountVerification: true } } as any;
    Object.assign(reported.sessions[0], { platform, accountIdentity: { id: '123', namespace: `${platform}.user_id` } });
    db.extensionNode.findMany.mockResolvedValue([reported]);
    const result = await service.get('org', 'user', 'project');
    expect(result.accounts[0]).toMatchObject({ platform, integrationId: 'x1', actions: { REPLY: { canSelect: true, availability: 'AVAILABLE' } } });
  });
  it('keeps LinkedIn company actors separate from personal accounts', async () => {
    const { service, db } = setup();
    db.integration.findMany.mockResolvedValue([
      { ...account, providerIdentifier: 'linkedin', identityNamespace: 'linkedin.member_id' },
      { ...account, id: 'company', providerIdentifier: 'linkedin-page', internalId: 'org-id', identityNamespace: 'linkedin.organization_id' },
    ]);
    const reported = structuredClone(node);
    reported.capabilities = { linkedin: { post: true, reply: true, strictAccountVerification: true } } as any;
    reported.sessions = [
      { ...session, platform: 'linkedin', accountIdentity: { id: '123', namespace: 'linkedin.member_id' } } as any,
      { ...session, id: 'company-session', platform: 'linkedin', integrationId: 'company', accountIdentity: { id: 'org-id', namespace: 'linkedin.organization_id' } } as any,
    ];
    db.extensionNode.findMany.mockResolvedValue([reported]);
    const result = await service.get('org', 'user', 'project');
    expect(result.accounts).toHaveLength(2);
    expect(result.accounts[1]).toMatchObject({ integrationId: 'company', platform: 'linkedin', providerIdentifier: 'linkedin-page' });
    expect(result.accounts[0].terminals).toHaveLength(1);
  });
  it.each([
    [[], 'ACCOUNT_NOT_ASSIGNED'],
    [[{ integrationId: 'x1', disabled: true, engageEnabled: true }], 'ACCOUNT_NOT_ASSIGNED'],
    [[{ integrationId: 'x1', disabled: false, engageEnabled: false }], 'REPLY_ACCOUNT_DISABLED'],
  ])('reports real REPLY permission when project relations are %j', async (relations, reason) => {
    const { service, db } = setup();
    db.integrationProject.findMany.mockResolvedValue(relations as any);
    const result = await service.get('org', 'user', 'project');
    expect(result.accounts[0].actions.REPLY).toMatchObject({ canSelect: false, reason });
  });
  it('inherits independently optional organization defaults, and never falls back from an invalid project selection', async () => {
    const { service, db } = setup();
    db.organizationSendBinding.findMany.mockResolvedValue([{ platform: 'x', action: 'POST', integrationId: 'x1', revision: 4 }] as any);
    db.projectSendBinding.findMany.mockResolvedValue([{ platform: 'x', action: 'POST', integrationId: null, revision: 9 }] as any);
    expect((await service.get('org', 'user', 'project')).defaults.x.POST).toMatchObject({ effectiveIntegrationId: 'x1', source: 'ORGANIZATION' });
    db.projectSendBinding.findMany.mockResolvedValue([{ platform: 'x', action: 'POST', integrationId: 'deleted', revision: 10 }] as any);
    expect((await service.get('org', 'user', 'project')).defaults.x.POST).toMatchObject({ effectiveIntegrationId: 'deleted', source: 'PROJECT', blockCode: 'ACCOUNT_NOT_ASSIGNED' });
  });
  it('whitelists account/session/node fields and scopes every read to the authenticated organization and project', async () => {
    const { service, db, projects } = setup();
    const result = await service.get('org', 'user', 'project');
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(projects.assertProjectAccess).toHaveBeenCalledWith('org', 'project');
    expect(db.integration.findMany.mock.calls[0][0].where.organizationId).toBe('org');
    expect(db.integrationProject.findMany.mock.calls[0][0].where).toEqual({ organizationId: 'org', projectId: 'project' });
    expect(db.extensionNode.findMany.mock.calls[0][0].where).toMatchObject({ organizationId: 'org', registeredBy: { activated: true, organizations: { some: { organizationId: 'org', disabled: false } } } });
  });
  it('fails closed for removed membership, foreign projects and unavailable policy', async () => {
    const { service, db, projects, policies } = setup();
    db.userOrganization.findUnique.mockResolvedValue(null);
    await expect(service.get('org', 'user', 'project')).rejects.toThrow('ORGANIZATION_MEMBERSHIP_REQUIRED');
    expect(db.integration.findMany).not.toHaveBeenCalled();
    db.userOrganization.findUnique.mockResolvedValue({ disabled: false });
    projects.assertProjectAccess.mockRejectedValueOnce(new Error('PROJECT_NOT_FOUND'));
    await expect(service.get('org', 'user', 'foreign')).rejects.toThrow('PROJECT_NOT_FOUND');
    policies.snapshotInTransaction.mockRejectedValueOnce(new Error('POLICY_UNAVAILABLE'));
    await expect(service.get('org', 'user', 'project')).rejects.toThrow('POLICY_UNAVAILABLE');
  });
  it('returns legacy mode without interpreting empty accounts as a controlled send capability', async () => {
    const { service, db, policies, modes } = setup();
    modes.stateIn.mockResolvedValue({ mode: 'AUTONOMOUS', revision: 0, systemEnabled: true, autonomousAllowed: true });
    expect(await service.get('org', 'user', 'project')).toMatchObject({ mode: 'AUTONOMOUS', accounts: [], defaults: {}, requireAccountSelection: null, autonomousAllowed: true });
    expect(db.integration.findMany).not.toHaveBeenCalled();
    expect(db.extensionNode.findMany).not.toHaveBeenCalled();
    expect(policies.snapshotInTransaction).not.toHaveBeenCalled();
  });
  it('keeps existing protected organizations paused rather than falling back to legacy', async () => {
    const { service, modes } = setup();
    modes.stateIn.mockResolvedValue({ mode: 'PAUSED', revision: 2, systemEnabled: false, autonomousAllowed: false });
    const result = await service.get('org', 'user', 'project');
    expect(result.mode).toBe('PAUSED');
    expect(result.accounts[0].actions.POST).toMatchObject({ canSelect: false, reason: 'ACCOUNT_BINDINGS_NOT_ENABLED' });
  });
  it('leaves inactive projects readable with account choices disabled', async () => {
    const { service, projects } = setup();
    projects.getActivationVerdict.mockResolvedValue('inactive');
    const result = await service.get('org', 'user', 'project');
    expect(result.accounts[0].actions.POST).toMatchObject({ canSelect: false, reason: 'PROJECT_INACTIVE' });
  });
  it('honors OPTIONAL without requiring any organization default', async () => {
    const { service, policies } = setup();
    policies.snapshotInTransaction.mockResolvedValue({ requirePreselectedAccount: false });
    expect((await service.get('org', 'user', 'project')).requireAccountSelection).toBe(false);
  });
});

describe('sending context route', () => {
  it('is authenticated read-only GET and forwards only the authenticated scope', () => {
    const service = { get: vi.fn().mockReturnValue('context') };
    const controller = new SendingContextController(service as any);
    expect(Reflect.getMetadata(PATH_METADATA, SendingContextController)).toBe('/projects/:projectId/sending-context');
    expect(Reflect.getMetadata(METHOD_METADATA, SendingContextController.prototype.get)).toBe(RequestMethod.GET);
    expect(controller.get({ id: 'org' } as any, { id: 'user' } as any, 'project')).toBe('context');
    expect(service.get).toHaveBeenCalledWith('org', 'user', 'project');
  });
});
