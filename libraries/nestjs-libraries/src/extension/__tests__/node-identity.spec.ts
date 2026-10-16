import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ExtensionNodeService } from '../extension-node.service';
import { RegisterExtensionNodeDto } from '../extension-node.dto';
import { SendExecutionService } from '../send-execution.service';
import { setupSend } from './support/send-fixture';
import { memorySendDatabase } from './support/memory-send-database';

const nodeId = 'a'.repeat(64);
const request = { nodeId, requestId: 'request', browser: 'chrome', protocolVersion: 'ACCOUNT_BOUND_V1', capabilities: {} };
function fixture() {
  const db = memorySendDatabase();
  for (const userId of ['alice', 'bob'])
    db.seed('userOrganization', { organizationId: 'org', userId, disabled: false, role: 'USER' });
  const service = new ExtensionNodeService(db as any);
  const register = (user: string, extra = {}) => service.register('org', user, { ...request, ...extra } as any);
  return { db, service, register };
}
beforeEach(() => {
  vi.stubEnv('EXTENSION_NODE_CREDENTIAL_KEY', 'k'.repeat(32));
  vi.stubEnv('SEND_EXECUTION_CREDENTIAL_KEY', 's'.repeat(32));
  vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'true');
});
afterEach(() => vi.unstubAllEnvs());

describe('one public node identity with account-scoped state', () => {
  it('uses the same nodeId across users with independent internal rows and credentials', async () => {
    const f = fixture();
    const a = await f.register('alice'), b = await f.register('bob');
    expect(a).toMatchObject({ organizationId: 'org', registeredByUserId: 'alice' });
    expect(a.nodeId).toBe(nodeId);
    expect(b.nodeId).toBe(nodeId);
    expect(a.nodeToken).not.toBe(b.nodeToken);
    expect(a).not.toHaveProperty('clientNodeId');
    expect(a).not.toHaveProperty('registrationId');
    const ar = await f.service.authenticate('org', 'alice', nodeId, a.nodeToken);
    const br = await f.service.authenticate('org', 'bob', nodeId, b.nodeToken);
    expect(ar.id).not.toBe(br.id);
    await expect(f.service.authenticate('org', 'bob', nodeId, a.nodeToken)).rejects.toThrow('NODE_AUTHENTICATION_REQUIRED');
    await expect(f.service.authenticate('org', 'alice', ar.id, a.nodeToken)).rejects.toThrow('NODE_AUTHENTICATION_REQUIRED');
  });
  it('replays only the identical registration and never recovers credentials from a public ID', async () => {
    const f = fixture();
    const a = await f.register('alice');
    expect(await f.register('alice')).toEqual(a);
    await expect(f.register('alice', { requestId: 'different' })).rejects.toThrow('NODE_REGISTRATION_RECOVERY_REQUIRED');
    expect(f.db.rows('extensionNode')).toHaveLength(1);
  });
  it('isolates the same nodeId between organizations', async () => {
    const f = fixture();
    f.db.seed('userOrganization', { organizationId: 'other-org', userId: 'alice', disabled: false });
    const a = await f.register('alice');
    const b = await f.service.register('other-org', 'alice', request as any);
    expect(b.nodeId).toBe(nodeId);
    expect(a.nodeToken).not.toBe(b.nodeToken);
    await expect(f.service.authenticate('other-org', 'alice', nodeId, a.nodeToken)).rejects.toThrow('NODE_AUTHENTICATION_REQUIRED');
  });
  it('keeps reports and sequences isolated even for a shared nodeId', async () => {
    const f = fixture();
    const a = await f.register('alice'), b = await f.register('bob');
    for (const [user, credentials] of [['alice', a], ['bob', b]] as const)
      await f.service.report('org', user, nodeId, credentials.nodeToken, {
        reportSequence: 1, checkedAt: new Date().toISOString(), platforms: [], extensionVersion: '2.0.0',
      });
    expect(f.db.rows('extensionNode').map(n => n.lastReportSequence)).toEqual([1, 1]);
    expect(f.db.rows('extensionNodeSession')).toHaveLength(0);
  });
  it('revokes only the current user state and exposes one public nodeId', async () => {
    const f = fixture();
    const a = await f.register('alice'), b = await f.register('bob');
    await f.service.save('org', 'alice', { nodeId, expectedRevision: 1, status: 'REVOKED' } as any);
    await expect(f.service.authenticate('org', 'alice', nodeId, a.nodeToken)).rejects.toThrow('NODE_AUTHENTICATION_REQUIRED');
    expect((await f.service.authenticate('org', 'bob', nodeId, b.nodeToken)).registeredByUserId).toBe('bob');
    f.db.rows('extensionNode').forEach(n => { n.sessions = []; });
    const rows = await f.service.list('org', 'alice');
    expect(rows.map(n => n.nodeId)).toEqual([nodeId, nodeId]);
    for (const row of rows) {
      expect(row).not.toHaveProperty('registrationId');
      expect(row).not.toHaveProperty('clientNodeId');
      expect(row).not.toHaveProperty('id');
    }
  });
  it('requires admin permission to select another owner for management', async () => {
    const f = fixture();
    await f.register('alice'); await f.register('bob');
    await expect(f.service.save('org', 'alice', { nodeId, registeredByUserId: 'bob', expectedRevision: 1, status: 'REVOKED' } as any)).rejects.toThrow('NODE_MANAGEMENT_FORBIDDEN');
    f.db.rows('userOrganization').find(m => m.userId === 'alice').role = 'ADMIN';
    await f.service.save('org', 'alice', { nodeId, registeredByUserId: 'bob', expectedRevision: 1, status: 'REVOKED' } as any);
    expect(f.db.rows('extensionNode').find(n => n.registeredByUserId === 'bob').status).toBe('REVOKED');
    expect(f.db.rows('extensionNode').find(n => n.registeredByUserId === 'alice').status).toBe('ACTIVE');
  });
  it('requires nodeId on registration instead of the abandoned identity aliases', async () => {
    const f = fixture();
    await expect(f.register('alice', { nodeId: undefined })).rejects.toThrow('INVALID_NODE_IDENTITY');
    for (const invalid of [undefined, null, '', 'hardware-hash', crypto.randomUUID(), 'A'.repeat(64)])
      expect(validateSync(plainToInstance(RegisterExtensionNodeDto, { ...request, nodeId: invalid })).some(e => e.property === 'nodeId')).toBe(true);
    expect(validateSync(plainToInstance(RegisterExtensionNodeDto, request))).toHaveLength(0);
  });
  it('rejects another account execution even when nodeId and the leaked lease are identical', async () => {
    const f = setupSend();
    f.db.seed('userOrganization', { organizationId: 'org', userId: 'bob', disabled: false });
    const nodes = new ExtensionNodeService(f.db as any);
    const capabilities = { x: { post: true, reply: true, strictAccountVerification: true } };
    const a = await nodes.register('org', 'user', { ...request, capabilities } as any);
    const b = await nodes.register('org', 'bob', { ...request, capabilities } as any);
    const ar = await nodes.authenticate('org', 'user', nodeId, a.nodeToken);
    f.db.seed('extensionNodeSession', { extensionNodeId: ar.id, organizationId: 'org', platform: 'x', integrationId: 'account', verificationStatus: 'VERIFIED', verificationExpiresAt: new Date(Date.now() + 300000), sessionRevision: 1 });
    await f.create('root', 'EXTENSION');
    const executions = new SendExecutionService(f.db as any, nodes, f.service);
    const auth = { org: 'org', user: 'user', nodeId, token: a.nodeToken };
    const item = (await executions.claim(auth, { requestId: 'claim', action: 'POST' })).items[0];
    expect(item.nodeId).toBe(nodeId);
    expect(f.db.rows('sendExecution')[0].extensionNodeId).toBe(ar.id);
    await expect(executions.status({ ...auth, user: 'bob', token: b.nodeToken }, item.executionId, item.leaseToken)).rejects.toThrow('SEND_LEASE_AUTHENTICATION_FAILED');
    await expect(executions.preflight({ ...auth, user: 'bob', token: b.nodeToken }, item.executionId, 0, item.leaseToken)).rejects.toThrow('SEND_LEASE_AUTHENTICATION_FAILED');
    expect(f.db.rows('sendExecution')).toHaveLength(1);
  });
});
