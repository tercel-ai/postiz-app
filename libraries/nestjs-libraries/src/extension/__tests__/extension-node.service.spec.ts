import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExtensionNodeService } from '../extension-node.service';

const node = {
  id: 'node',
  nodeId: 'a'.repeat(64),
  organizationId: 'org',
  registeredByUserId: 'user',
  status: 'ACTIVE',
  credentialHash: '',
  credentialSalt: 'salt',
  credentialVersion: 1,
  registrationRequestId: 'request',
  registrationRequestHash: '',
  registrationExpiresAt: new Date(Date.now() + 60_000),
  revision: 1,
  lastReportSequence: 0,
  capabilities: {},
};
const body = {
  nodeId: node.nodeId,
  requestId: 'request',
  browser: 'chrome',
  protocolVersion: 'ACCOUNT_BOUND_V1',
  capabilities: {},
};
function setup() {
  const db = {
    userOrganization: {
      findUnique: vi.fn().mockResolvedValue({ role: 'USER', disabled: false }),
    },
    extensionNode: {
      findUnique: vi.fn(),
      findFirst: vi.fn().mockResolvedValue(node),
      create: vi.fn().mockImplementation(({ data }) => ({ ...node, ...data })),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    extensionNodeSession: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
    },
    extensionNodeReportReceipt: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
    },
    integration: { findMany: vi.fn().mockResolvedValue([]), update: vi.fn(async ({where,data}) => ({id:where.id,...data})) },
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation((fn) => fn(db));
  return { db, service: new ExtensionNodeService(db as any) };
}
beforeEach(() => {
  vi.stubEnv('EXTENSION_NODE_CREDENTIAL_KEY', 'k'.repeat(32));
});

describe('extension node registration', () => {
  it('creates one tenant-owned node and returns credentials only at registration', async () => {
    const { db, service } = setup();
    const result = await service.register('org', 'user', body as any);
    expect(result.nodeId).toBeTruthy();
    expect(result.nodeToken).toBeTruthy();
    expect(
      db.extensionNode.create.mock.calls[0][0].data.credentialHash
    ).not.toBe(result.nodeToken);
    expect(db.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ isolationLevel: 'Serializable' })
    );
  });
  it('replays registration without creating or rotating a node', async () => {
    const { db, service } = setup();
    const first = await service.register('org', 'user', body as any);
    db.extensionNode.findUnique.mockResolvedValue({
      ...node,
      ...db.extensionNode.create.mock.calls[0][0].data,
    });
    expect(await service.register('org', 'user', body as any)).toEqual(first);
    expect(db.extensionNode.create).toHaveBeenCalledTimes(1);
  });
  it('rejects reusing an installation with changed registration content', async () => {
    const { db, service } = setup();
    await service.register('org', 'user', body as any);
    db.extensionNode.findUnique.mockResolvedValue(
      db.extensionNode.create.mock.calls[0][0].data
    );
    await expect(
      service.register('org', 'user', { ...body, name: 'different' } as any)
    ).rejects.toMatchObject({ status: 409 });
  });
  it('rejects missing and disabled organization memberships', async () => {
    const { db, service } = setup();
    db.userOrganization.findUnique.mockResolvedValue(null);
    await expect(
      service.register('org', 'user', body as any)
    ).rejects.toMatchObject({ status: 403 });
    db.userOrganization.findUnique.mockResolvedValue({ disabled: true });
    await expect(
      service.register('org', 'user', body as any)
    ).rejects.toMatchObject({ status: 403 });
    expect(db.extensionNode.create).not.toHaveBeenCalled();
  });
  it('refuses expired registration recovery and revoked nodes', async () => {
    const { db, service } = setup();
    await service.register('org', 'user', body as any);
    const saved = { ...node, ...db.extensionNode.create.mock.calls[0][0].data };
    db.extensionNode.findUnique.mockResolvedValue({
      ...saved,
      registrationExpiresAt: new Date(0),
    });
    await expect(
      service.register('org', 'user', body as any)
    ).rejects.toMatchObject({ status: 409 });
    db.extensionNode.findUnique.mockResolvedValue({
      ...saved,
      status: 'REVOKED',
    });
    await expect(
      service.register('org', 'user', body as any)
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe('node execution authentication and management', () => {
  it('requires matching tenant, registering user, token, and active status', async () => {
    const { db, service } = setup();
    const creds = await service.register('org', 'user', body as any);
    const saved = { ...node, ...db.extensionNode.create.mock.calls[0][0].data };
    db.extensionNode.findFirst.mockResolvedValue(saved);
    expect(
      (await service.authenticate('org', 'user', creds.nodeId, creds.nodeToken))
        .nodeId
    ).toBe(creds.nodeId);
    for (const token of ['', 'wrong'])
      await expect(
        service.authenticate('org', 'user', creds.nodeId, token)
      ).rejects.toMatchObject({ status: 401 });
    await expect(
      service.authenticate('org', 'other', creds.nodeId, creds.nodeToken)
    ).rejects.toMatchObject({ status: 401 });
    db.extensionNode.findFirst.mockResolvedValue({
      ...saved,
      status: 'REVOKED',
    });
    await expect(
      service.authenticate('org', 'user', creds.nodeId, creds.nodeToken)
    ).rejects.toMatchObject({ status: 401 });
  });
  it('does not let ordinary members manage another user terminal', async () => {
    const { db, service } = setup();
    db.extensionNode.findFirst.mockResolvedValue({
      ...node,
      registeredByUserId: 'other',
    });
    await expect(
      service.save('org', 'user', {
        nodeId: node.nodeId,
        expectedRevision: 1,
        name: 'new',
      })
    ).rejects.toMatchObject({ status: 403 });
    expect(db.extensionNode.updateMany).not.toHaveBeenCalled();
  });
  it('permits administrators to revoke but never reactivate', async () => {
    const { db, service } = setup();
    db.userOrganization.findUnique.mockResolvedValue({
      role: 'ADMIN',
      disabled: false,
    });
    db.extensionNode.findFirst.mockResolvedValue({
      ...node,
      registeredByUserId: 'other',
    });
    await service.save('org', 'user', {
      nodeId: node.nodeId,
      registeredByUserId: 'other',
      expectedRevision: 1,
      status: 'REVOKED',
    });
    await expect(
      service.save('org', 'user', {
        nodeId: node.nodeId,
        expectedRevision: 1,
        status: 'ACTIVE',
      } as any)
    ).rejects.toMatchObject({ status: 400 });
  });
  it('reports revision conflicts without changing credentials', async () => {
    const { db, service } = setup();
    db.extensionNode.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      service.save('org', 'user', {
        nodeId: node.nodeId,
        expectedRevision: 1,
        name: 'new',
      })
    ).rejects.toMatchObject({ status: 409 });
    expect(
      db.extensionNode.updateMany.mock.calls[0][0].data
    ).not.toHaveProperty('credentialHash');
  });
  it('never exposes hashes, salts, or registration receipts in node lists', async () => {
    const { db, service } = setup();
    db.extensionNode.findMany.mockResolvedValue([
      { ...node, name: 'Office', browser: 'chrome', sessions: [] },
    ]);
    const result = await service.list('org', 'user');
    expect(result[0]).not.toHaveProperty('credentialHash');
    expect(result[0]).not.toHaveProperty('credentialSalt');
    expect(result[0]).not.toHaveProperty('registrationRequestHash');
  });
});

describe('node-scoped session reports', () => {
  async function registered() {
    const state = setup();
    const creds = await state.service.register('org', 'user', body as any);
    const saved = {
      ...node,
      ...state.db.extensionNode.create.mock.calls[0][0].data,
    };
    state.db.extensionNode.findFirst.mockResolvedValue(saved);
    return { ...state, creds, saved };
  }
  const entry = {
    platform: 'x',
    loggedIn: true,
    id: '123',
    identityNamespace: 'x.rest_id',
    evidenceKind: 'LIVE_COOKIE_ID',
    verificationStatus: 'VERIFIED',
    probeId: 'probe',
    identityObservedAt: new Date().toISOString(),
  };
  const report = () => ({
    reportSequence: 1,
    checkedAt: new Date().toISOString(),
    platforms: [entry],
  });

  it('saves only the authenticated terminal session and does not overwrite global channel credentials', async () => {
    const { db, service, creds } = await registered();
    db.integration.findMany.mockResolvedValue([
      {
        id: 'account',
        internalId: '123',
        identityNamespace: 'x.rest_id',
        providerIdentifier: 'x',
      },
    ]);
    const result: any = await service.report(
      'org',
      'user',
      creds.nodeId,
      creds.nodeToken,
      report() as any
    );
    expect(result.results[0].integrationId).toBe('account');
    expect(result.results[0].verificationStatus).toBe('VERIFIED');
    expect(
      db.extensionNodeSession.upsert.mock.calls[0][0].create.extensionNodeId
    ).toBe(db.extensionNode.create.mock.calls[0][0].data.id);
    expect(
      db.extensionNodeSession.upsert.mock.calls[0][0].create.organizationId
    ).toBe('org');
    expect(db.extensionNodeReportReceipt.create).toHaveBeenCalledTimes(1);
  });
  it('replays a receipt without extending identity verification', async () => {
    const { db, service, creds } = await registered();
    const input = report();
    const result = await service.report(
      'org',
      'user',
      creds.nodeId,
      creds.nodeToken,
      input as any
    );
    const data = db.extensionNodeReportReceipt.create.mock.calls[0][0].data;
    db.extensionNodeReportReceipt.findUnique.mockResolvedValue(data);
    expect(
      await service.report(
        'org',
        'user',
        creds.nodeId,
        creds.nodeToken,
        input as any
      )
    ).toEqual(result);
    expect(db.extensionNodeSession.upsert).toHaveBeenCalledTimes(1);
    await expect(
      service.report('org', 'user', creds.nodeId, creds.nodeToken, {
        ...input,
        checkedAt: '2026-01-01T00:00:00Z',
      } as any)
    ).rejects.toMatchObject({ status: 409 });
  });
  it('does not refresh identity or clear sessions on heartbeat', async () => {
    const { db, service, creds } = await registered();
    await service.report('org', 'user', creds.nodeId, creds.nodeToken, {
      ...report(),
      platforms: [],
    } as any);
    expect(db.extensionNodeSession.upsert).not.toHaveBeenCalled();
    expect(db.extensionNodeReportReceipt.create).toHaveBeenCalledTimes(1);
    expect(
      db.extensionNode.updateMany.mock.calls[0][0].data
    ).toHaveProperty('lastReportSequence', 1);
  });

  it('updates upgraded plugin capabilities without rotating credentials or extending identity verification', async () => {
    const { db, service, creds } = await registered();
    await service.report('org', 'user', creds.nodeId, creds.nodeToken, {
      ...report(),
      platforms: [],
      extensionVersion: '2.0.0',
      capabilities: { x: { post: true, strictAccountVerification: true } },
    } as any);
    const data = db.extensionNode.updateMany.mock.calls[0][0].data;
    expect(data.extensionVersion).toBe('2.0.0');
    expect(data.capabilities.x.post).toBe(true);
    expect(data).not.toHaveProperty('credentialHash');
    expect(db.extensionNodeSession.upsert).not.toHaveBeenCalled();
  });
  it('rejects sequence regression, missing sequence, and duplicate platforms before saving', async () => {
    const { db, service, creds, saved } = await registered();
    db.extensionNode.findFirst.mockResolvedValue({
      ...saved,
      lastReportSequence: 5,
    });
    await expect(
      service.report(
        'org',
        'user',
        creds.nodeId,
        creds.nodeToken,
        report() as any
      )
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      service.report('org', 'user', creds.nodeId, creds.nodeToken, {
        ...report(),
        reportSequence: undefined,
      } as any)
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.report('org', 'user', creds.nodeId, creds.nodeToken, {
        ...report(),
        platforms: [entry, entry],
      } as any)
    ).rejects.toMatchObject({ status: 400 });
    expect(db.extensionNodeSession.upsert).not.toHaveBeenCalled();
  });
  it('retries serializable conflicts but never swallows an unrelated database failure', async () => {
    const { db, service } = setup();
    const original = db.$transaction.getMockImplementation()!;
    db.$transaction
      .mockRejectedValueOnce({ code: 'P2034' })
      .mockImplementation(original);
    await service.register('org', 'user', body as any);
    expect(db.$transaction).toHaveBeenCalledTimes(2);
    db.$transaction.mockRejectedValueOnce(new Error('offline'));
    await expect(service.register('org', 'user', body as any)).rejects.toThrow(
      'offline'
    );
  });
  it('filters terminal eligibility and batches account associations', async () => {
    const { db, service, saved } = await registered();
    const active = {
      ...saved,
      lastSeenAt: new Date(),
      capabilities: { x: { post: true, strictAccountVerification: true } },
    };
    db.extensionNodeSession.findMany.mockResolvedValue([
      {
        integrationId: 'account',
        platform: 'x',
        verificationStatus: 'VERIFIED',
        verificationExpiresAt: new Date(Date.now() + 30_000),
        verifiedAt: new Date(),
        extensionNode: active,
      },
    ]);
    const result = await service.accountViews('org', 'user', [
      { id: 'account' },
      { id: 'other', disabled: true },
    ]);
    expect(result.get('account')?.sendAvailability).toBe('AVAILABLE');
    expect(result.get('other')?.sendAvailability).toBe('ACCOUNT_DISABLED');
    expect(result.get('account')?.terminals[0]).not.toHaveProperty(
      'credentialHash'
    );
    expect(db.extensionNodeSession.findMany).toHaveBeenCalledTimes(1);
  });
});
