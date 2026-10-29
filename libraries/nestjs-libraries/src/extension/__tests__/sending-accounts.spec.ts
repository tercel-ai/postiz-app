import { describe, expect, it, vi } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SendBindingService } from '../send-binding.service';
import { SaveSendingAccountsDto } from '../send-binding.dto';
import { memorySendDatabase } from './support/memory-send-database';

const actor = {
  id: 'x1',
  organizationId: 'org',
  providerIdentifier: 'x',
  internalId: '123',
  identityNamespace: 'x.rest_id',
  profile: 'alice',
  disabled: false,
  deletedAt: null,
  inBetweenSteps: false,
};
const choice = (integrationId: string | null = 'x1', expectedRevision = 0) => ({
  integrationId,
  expectedRevision,
});
function setup() {
  const table = () => ({
    findUnique: vi.fn().mockResolvedValue(null),
    findMany: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue({}),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
  });
  const db = {
    userOrganization: {
      findUnique: vi.fn().mockResolvedValue({ disabled: false }),
    },
    organizationSendBinding: table(),
    projectSendBinding: table(),
    integration: {
      findFirst: vi.fn().mockResolvedValue(actor),
      findMany: vi.fn().mockResolvedValue([actor]),
    },
    integrationProject: {
      findFirst: vi
        .fn()
        .mockResolvedValue({
          disabled: false,
          engageEnabled: true,
          integration: actor,
        }),
      findMany: vi
        .fn()
        .mockResolvedValue([
          { integrationId: 'x1', disabled: false, engageEnabled: true },
        ]),
    },
    sendMutationReceipt: table(),
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation((work) => work(db));
  const projects = {
    assertProjectActive: vi.fn(),
    assertProjectAccess: vi.fn(),
  };
  const service = new SendBindingService(db as any, projects as any);
  return { db, projects, service };
}

describe('independent sending account resources', () => {
  it('accepts account choices without client revisions', async () => {
    expect(await validate(plainToInstance(SaveSendingAccountsDto, {
      accounts: { x: { POST: { integrationId: 'x1' }, REPLY: { integrationId: null } } }, requestId: 'save',
    }))).toEqual([]);
  });
  it('uses the current internal revision even when a legacy client supplies an old hint', async () => {
    const { service, db } = setup();
    db.projectSendBinding.findUnique.mockResolvedValue({ id: 'binding', revision: 8 });
    const result = await service.saveDefaults('org', 'user', {
      accounts: { x: { POST: choice('x1', 0) } }, requestId: 'save',
    }, 'project');
    expect(result.bindings[0].revision).toBe(9);
    expect(db.projectSendBinding.updateMany).toHaveBeenCalledWith({
      where: { id: 'binding', organizationId: 'org', revision: 8 },
      data: { integrationId: 'x1', updatedByUserId: 'user', revision: { increment: 1 } },
    });
  });
  it('retries internal contention without requiring a client revision refresh', async () => {
    const { service, db } = setup();
    db.projectSendBinding.findUnique.mockResolvedValueOnce({ id: 'binding', revision: 8 })
      .mockResolvedValueOnce({ id: 'binding', revision: 9 });
    db.projectSendBinding.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });
    const result = await service.saveDefaults('org', 'user', {
      accounts: { x: { POST: { integrationId: 'x1' } } }, requestId: 'save',
    }, 'project');
    expect(result.bindings[0].revision).toBe(10);
    expect(db.$transaction).toHaveBeenCalledTimes(2);
    expect(db.sendMutationReceipt.create).toHaveBeenCalledOnce();
  });
  it('validates nested actions and requires a stable request ID', async () => {
    expect(
      await validate(
        plainToInstance(SaveSendingAccountsDto, {
          accounts: { x: { POST: choice(), REPLY: choice(null, 3) } },
          requestId: 'save',
        })
      )
    ).toEqual([]);
    for (const accounts of [
      [],
      {},
      { x: {} },
      { bogus: { POST: choice() } },
      { x: { OTHER: choice() } },
      { x: { POST: { ...choice(), nodeId: 'n' } } },
      { x: { POST: choice('  ') } },
      { x: { POST: choice('x1', -1) } },
    ]) {
      expect(
        (
          await validate(
            plainToInstance(SaveSendingAccountsDto, {
              accounts,
              requestId: 'save',
            })
          )
        ).length
      ).toBeGreaterThan(0);
    }
    for (const requestId of [undefined, null, '', '  '])
      expect(
        (
          await validate(
            plainToInstance(SaveSendingAccountsDto, {
              accounts: { x: { POST: choice() } },
              requestId,
            })
          )
        ).length
      ).toBeGreaterThan(0);
  });

  it('saves both actions atomically without touching Automation or assigning a project', async () => {
    const { service, db } = setup();
    const result = await service.saveDefaults(
      'org',
      'user',
      {
        accounts: { x: { POST: choice(), REPLY: choice() } },
        requestId: 'save',
      },
      'project'
    );
    expect(result.bindings).toEqual([
      { platform: 'x', action: 'POST', integrationId: 'x1', revision: 1 },
      { platform: 'x', action: 'REPLY', integrationId: 'x1', revision: 1 },
    ]);
    expect(db.projectSendBinding.create).toHaveBeenCalledTimes(2);
    expect(db.organizationSendBinding.create).not.toHaveBeenCalled();
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'Serializable',
    });
  });

  it('validates every item before writing any binding', async () => {
    const { service, db } = setup();
    db.projectSendBinding.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'b', revision: 3 });
    db.integrationProject.findFirst
      .mockResolvedValueOnce({ integration: actor, disabled: false, engageEnabled: true })
      .mockResolvedValueOnce({ integration: { ...actor, id: 'reddit-account', providerIdentifier: 'reddit' }, disabled: false, engageEnabled: true });
    await expect(
      service.saveDefaults(
        'org',
        'user',
        {
          accounts: { x: { POST: choice(), REPLY: choice('reddit-account') } },
          requestId: 'save',
        },
        'project'
      )
    ).rejects.toMatchObject({ status: 400 });
    expect(db.projectSendBinding.create).not.toHaveBeenCalled();
    expect(db.sendMutationReceipt.create).not.toHaveBeenCalled();
  });

  it('stores organization defaults without implicitly assigning them to projects', async () => {
    const { service, db, projects } = setup();
    await service.saveDefaults('org', 'user', {
      accounts: { x: { POST: choice() } },
      requestId: 'save',
    });
    expect(db.organizationSendBinding.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: 'org',
        integrationId: 'x1',
        action: 'POST',
      }),
    });
    expect(db.integrationProject.findFirst).not.toHaveBeenCalled();
    expect(projects.assertProjectActive).not.toHaveBeenCalled();
  });

  it('replays the original result and isolates receipts by resource', async () => {
    const { service, db } = setup();
    const body = { accounts: { x: { POST: choice() } }, requestId: 'save' };
    const result = await service.saveDefaults('org', 'user', body, 'project');
    const receipt = db.sendMutationReceipt.create.mock.calls[0][0].data;
    db.sendMutationReceipt.findUnique.mockResolvedValue(receipt);
    db.projectSendBinding.findUnique.mockResolvedValue({ revision: 9 });
    expect(await service.saveDefaults('org', 'user', body, 'project')).toEqual(
      result
    );
    expect(db.projectSendBinding.create).toHaveBeenCalledTimes(1);
    await expect(
      service.saveDefaults(
        'org',
        'user',
        { ...body, accounts: { x: { POST: choice(null) } } },
        'project'
      )
    ).rejects.toMatchObject({ status: 409 });
    expect(receipt.operation).toBe('sending-accounts:project:project');
  });

  it('keeps clearing tombstones and allows inheritance while Automation remains enabled', async () => {
    const { service, db } = setup();
    db.projectSendBinding.findUnique.mockResolvedValue({
      id: 'b',
      revision: 3,
      integrationId: 'x1',
    });
    await service.saveDefaults(
      'org',
      'user',
      { accounts: { x: { POST: choice(null, 3) } }, requestId: 'clear' },
      'project'
    );
    expect(db.projectSendBinding.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: 'b',
        revision: 3,
        organizationId: 'org',
      }),
      data: expect.objectContaining({
        integrationId: null,
        revision: { increment: 1 },
      }),
    });
  });

  it('refuses missing membership, foreign actors, invalid platforms, and repeated internal contention', async () => {
    const { service, db } = setup();
    const body = { accounts: { x: { POST: choice() } }, requestId: 'save' };
    db.userOrganization.findUnique.mockResolvedValue(null);
    await expect(
      service.saveDefaults('org', 'user', body)
    ).rejects.toMatchObject({ status: 403 });
    db.userOrganization.findUnique.mockResolvedValue({ disabled: false });
    db.integration.findFirst.mockResolvedValue({
      ...actor,
      organizationId: 'other',
    });
    await expect(
      service.saveDefaults('org', 'user', body)
    ).rejects.toMatchObject({ status: 403 });
    db.integration.findFirst.mockResolvedValue({
      ...actor,
      providerIdentifier: 'reddit',
    });
    await expect(
      service.saveDefaults('org', 'user', body)
    ).rejects.toMatchObject({ status: 400 });
    db.integration.findFirst.mockResolvedValue(actor);
    db.organizationSendBinding.findUnique.mockResolvedValue({
      id: 'b',
      revision: 0,
    });
    db.organizationSendBinding.updateMany.mockResolvedValue({ count: 0 });
    db.$transaction.mockClear();
    await expect(
      service.saveDefaults('org', 'user', body)
    ).rejects.toMatchObject({ code: 'P2034' });
    expect(db.$transaction).toHaveBeenCalledTimes(4);
    expect(db.sendMutationReceipt.create).not.toHaveBeenCalled();
  });

  it('resolves explicit then project then organization, only inheriting when unset', async () => {
    const { service, db } = setup();
    db.organizationSendBinding.findUnique.mockResolvedValue({
      integrationId: 'x1',
      revision: 4,
    });
    const inherited = await service.resolve('org', 'project', 'x', 'POST');
    expect(inherited).toMatchObject({
      integrationId: 'x1',
      bindingSource: 'ORGANIZATION',
      bindingRevision: 4,
    });
    db.projectSendBinding.findUnique.mockResolvedValue({
      integrationId: null,
      revision: 2,
    });
    expect(await service.resolve('org', 'project', 'x', 'POST')).toMatchObject({
      bindingSource: 'ORGANIZATION',
    });
    db.projectSendBinding.findUnique.mockResolvedValue({
      integrationId: 'x1',
      revision: 3,
    });
    expect(await service.resolve('org', 'project', 'x', 'POST')).toMatchObject({
      bindingSource: 'PROJECT',
      bindingRevision: 3,
    });
    expect(
      await service.resolve('org', 'project', 'x', 'POST', 'x1')
    ).toMatchObject({ bindingSource: 'EXPLICIT', bindingRevision: null });
    db.integrationProject.findFirst.mockResolvedValue(null);
    await expect(
      service.resolve('org', 'project', 'x', 'POST')
    ).rejects.toThrow('ACCOUNT_NOT_ASSIGNED');
  });

  it.each(['POST', 'REPLY'] as const)(
    'supports explicit then project %s selection without configuring any organization default',
    async (action) => {
      const { service, db } = setup();
      const project = { platform: 'x', action, integrationId: 'x1', revision: 3 };
      db.projectSendBinding.findUnique.mockResolvedValue(project);
      db.projectSendBinding.findMany.mockResolvedValue([project]);
      db.integrationProject.findFirst.mockImplementation(async ({ where }) => ({
        disabled: false,
        engageEnabled: true,
        integration: {
          ...actor,
          id: where.integrationId,
          internalId: where.integrationId === 'explicit-account' ? '456' : '123',
        },
      }));

      expect(await service.resolve('org', 'project', 'x', action, 'explicit-account')).toMatchObject({
        integrationId: 'explicit-account', bindingSource: 'EXPLICIT',
        targetAccount: { id: '456' },
      });
      expect(await service.resolve('org', 'project', 'x', action)).toMatchObject({
        integrationId: 'x1', bindingSource: 'PROJECT', bindingRevision: 3,
        targetAccount: { id: '123' },
      });
      const defaults = await service.getDefaults('org', 'user', 'project');
      expect(defaults.accounts.x[action]).toMatchObject({
        configured: { integrationId: 'x1', revision: 3 },
        organization: { integrationId: null, revision: 0 },
        effectiveIntegrationId: 'x1', source: 'PROJECT', blockCode: null,
      });
      expect(db.organizationSendBinding.findUnique).not.toHaveBeenCalled();
      expect(db.organizationSendBinding.create).not.toHaveBeenCalled();
      expect(db.organizationSendBinding.updateMany).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['POST', null],
    ['REPLY', null],
    ['POST', { integrationId: null, revision: 4 }],
    ['REPLY', { integrationId: null, revision: 4 }],
  ] as const)(
    'keeps organization defaults optional for %s with an absent or cleared global binding: %j',
    async (action, global) => {
      const { service, db } = setup();
      db.organizationSendBinding.findUnique.mockResolvedValue(global);
      db.organizationSendBinding.findMany.mockResolvedValue(
        global ? [{ platform: 'x', action, ...global }] : []
      );
      db.projectSendBinding.findUnique.mockResolvedValue({ integrationId: 'x1', revision: 2 });
      expect(await service.resolveForEnqueueInTransaction(
        db as any, 'org', 'project', 'x', action, undefined, false
      )).toMatchObject({ integrationId: 'x1', bindingSource: 'PROJECT' });

      db.projectSendBinding.findUnique.mockResolvedValue(null);
      await expect(service.resolveForEnqueueInTransaction(
        db as any, 'org', 'project', 'x', action, undefined, false
      )).rejects.toThrow('SEND_BINDING_REQUIRED');
      expect(await service.resolveForEnqueueInTransaction(
        db as any, 'org', 'project', 'x', action, undefined, true
      )).toBeNull();
      const defaults = await service.getDefaults('org', 'user', 'project');
      expect(defaults.accounts.x[action]).toMatchObject({
        organization: { integrationId: null, revision: global?.revision ?? 0 },
        effectiveIntegrationId: null, source: 'UNBOUND', blockCode: 'SEND_BINDING_REQUIRED',
      });
      expect(db.integration.findFirst).not.toHaveBeenCalled();
      expect(db.organizationSendBinding.create).not.toHaveBeenCalled();
      expect(db.organizationSendBinding.updateMany).not.toHaveBeenCalled();
    }
  );

  it('reports configured and effective values consistently without N+1 actor queries', async () => {
    const { service, db, projects } = setup();
    db.organizationSendBinding.findMany.mockResolvedValue([
      { platform: 'x', action: 'POST', integrationId: 'x1', revision: 4 },
      { platform: 'x', action: 'REPLY', integrationId: 'x1', revision: 5 },
    ]);
    db.projectSendBinding.findMany.mockResolvedValue([
      { platform: 'x', action: 'POST', integrationId: null, revision: 2 },
    ]);
    const result = await service.getDefaults('org', 'user', 'project');
    expect(result.accounts.x.POST).toMatchObject({
      configured: { integrationId: null, revision: 2 },
      effectiveIntegrationId: 'x1',
      source: 'ORGANIZATION',
      sourceRevision: 4,
      blockCode: null,
    });
    expect(result.accounts.x.REPLY).toMatchObject({
      configured: { integrationId: null, revision: 0 },
      effectiveIntegrationId: 'x1',
      source: 'ORGANIZATION',
    });
    expect(result.accounts.reddit.POST).toMatchObject({
      effectiveIntegrationId: null,
      source: 'UNBOUND',
    });
    expect(db.integration.findMany).toHaveBeenCalledTimes(1);
    expect(db.integrationProject.findMany).toHaveBeenCalledTimes(1);
    expect(projects.assertProjectAccess).toHaveBeenCalledWith('org', 'project');
  });

  it('shows invalid selected defaults without falling back and never returns credentials', async () => {
    const { service, db } = setup();
    db.projectSendBinding.findMany.mockResolvedValue([
      { platform: 'x', action: 'REPLY', integrationId: 'x1', revision: 2 },
    ]);
    db.integrationProject.findMany.mockResolvedValue([
      { integrationId: 'x1', disabled: false, engageEnabled: false },
    ]);
    db.integration.findMany.mockResolvedValue([{ ...actor, token: 'secret' }]);
    const result = await service.getDefaults('org', 'user', 'project');
    expect(result.accounts.x.REPLY).toMatchObject({
      effectiveIntegrationId: 'x1',
      source: 'PROJECT',
      blockCode: 'REPLY_ACCOUNT_DISABLED',
    });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(db.integrationProject.findFirst).not.toHaveBeenCalled();
  });
});

function persistedDefaults() {
  const db = memorySendDatabase();
  db.seed('userOrganization', { userId: 'user', organizationId: 'org', disabled: false });
  for (const account of [actor, { ...actor, id: 'x2', internalId: '456' }]) {
    db.seed('integration', account);
    db.seed('integrationProject', {
      id: `relation-${account.id}`, organizationId: 'org', projectId: 'project', integrationId: account.id,
      disabled: false, engageEnabled: true, integration: account,
    });
  }
  const projects = { assertProjectActive: vi.fn(), assertProjectAccess: vi.fn() };
  return { db, service: new SendBindingService(db as any, projects as any) };
}

describe.each([undefined, 'project'])('last-write-wins defaults at scope %s', project => {
  const body = (requestId: string, integrationId: string | null) => ({
    accounts: { x: { POST: { integrationId } } }, requestId,
  });
  const table = project === undefined ? 'organizationSendBinding' : 'projectSendBinding';
  it('retains the newest save when an older request is replayed after a lost response', async () => {
    const { db, service } = persistedDefaults();
    const first = await service.saveDefaults('org', 'user', body('a', 'x1'), project);
    await service.saveDefaults('org', 'user', body('b', 'x2'), project);
    expect(await service.saveDefaults('org', 'user', body('a', 'x1'), project)).toEqual(first);
    expect(db.rows(table)).toHaveLength(1);
    expect(db.rows(table)[0]).toMatchObject({ integrationId: 'x2', revision: 2 });
    expect(db.rows('sendMutationReceipt')).toHaveLength(2);
  });
  it('rejects a changed body under an existing request id without changing the current account', async () => {
    const { db, service } = persistedDefaults();
    await service.saveDefaults('org', 'user', body('a', 'x1'), project);
    await expect(service.saveDefaults('org', 'user', body('a', 'x2'), project)).rejects.toThrow('REQUEST_ID_CONFLICT');
    expect(db.rows(table)[0]).toMatchObject({ integrationId: 'x1', revision: 1 });
  });
  it('deduplicates concurrent identical saves and accepts later distinct changes', async () => {
    const { db, service } = persistedDefaults();
    const results = await Promise.all(Array.from({ length: 5 }, () => service.saveDefaults('org', 'user', body('a', 'x1'), project)));
    expect(results.every(result => result.bindings[0].revision === 1)).toBe(true);
    await service.saveDefaults('org', 'user', body('b', 'x2'), project);
    expect(db.rows(table)[0]).toMatchObject({ integrationId: 'x2', revision: 2 });
    expect(db.rows('sendMutationReceipt')).toHaveLength(2);
  });
  it('keeps clearing tombstones and submitted action updates incremental without frontend versions', async () => {
    const { db, service } = persistedDefaults();
    await service.saveDefaults('org', 'user', { accounts: { x: { POST: { integrationId: 'x1' }, REPLY: { integrationId: 'x2' } } }, requestId: 'a' }, project);
    await service.saveDefaults('org', 'user', body('b', null), project);
    expect(db.rows(table).find((row: any) => row.action === 'POST')).toMatchObject({ integrationId: null, revision: 2 });
    expect(db.rows(table).find((row: any) => row.action === 'REPLY')).toMatchObject({ integrationId: 'x2', revision: 1 });
    await service.saveDefaults('org', 'user', body('c', 'x2'), project);
    expect(db.rows(table).find((row: any) => row.action === 'POST').revision).toBe(3);
  });
  it('does not change frozen intents, execution ownership or quota settlement', async () => {
    const { db, service } = persistedDefaults();
    db.seed('sendIntent', { id: 'intent', organizationId: 'org', integrationId: 'x1', routeRevision: 3, contentRevision: 4, activeExecutionId: 'execution' });
    db.seed('sendExecution', { id: 'execution', organizationId: 'org', status: 'SENDING', integrationId: 'x1' });
    db.seed('sendQuotaReservation', { id: 'quota', organizationId: 'org', executionId: 'execution', heldUnits: 1, confirmedUnits: 0 });
    const snapshot = ['sendIntent', 'sendExecution', 'sendQuotaReservation'].map(name => structuredClone(db.rows(name)));
    await service.saveDefaults('org', 'user', body('a', 'x1'), project);
    await service.saveDefaults('org', 'user', body('b', 'x2'), project);
    expect(['sendIntent', 'sendExecution', 'sendQuotaReservation'].map(name => db.rows(name))).toEqual(snapshot);
  });
});

describe('account preferences before execution verification', () => {
  const platforms = ['x', 'reddit', 'linkedin', 'medium', 'quora', 'hackernews', 'devto'] as const;
  function pendingIdentity(platform: string) {
    const db = memorySendDatabase();
    db.seed('userOrganization', { userId: 'user', organizationId: 'org', disabled: false });
    const account = { ...actor, id: 'legacy-account', providerIdentifier: platform, identityNamespace: 'legacy', internalId: 'old-key' };
    db.seed('integration', account);
    db.seed('integrationProject', { integrationId: account.id, organizationId: 'org', projectId: 'project',
      disabled: false, engageEnabled: true, integration: account });
    const projects = { assertProjectActive: vi.fn(), assertProjectAccess: vi.fn() };
    return { db, account, service: new SendBindingService(db as any, projects as any) };
  }
  for (const project of [undefined, 'project']) it.each(platforms)('saves pending %s identity preferences without authorizing execution at scope '+String(project), async platform => {
    const { db, service, account } = pendingIdentity(platform);
    const result = await service.saveDefaults('org', 'user', { requestId: 'preference', accounts: {
      [platform]: { POST: { integrationId: account.id }, REPLY: { integrationId: account.id } },
    } }, project);
    expect(result.saved).toBe(true);
    expect(db.rows(project === undefined ? 'organizationSendBinding' : 'projectSendBinding')).toHaveLength(2);
    expect(db.rows('integration')[0]).toMatchObject({ identityNamespace: 'legacy', internalId: 'old-key' });
    const defaults = await service.getDefaults('org', 'user', project);
    expect(defaults.accounts[platform].POST).toMatchObject({ effectiveIntegrationId: account.id, blockCode: 'ACCOUNT_IDENTITY_UNRESOLVED' });
    for (const action of ['POST', 'REPLY'] as const) {
      await expect(service.resolve('org', 'project', platform, action)).rejects.toThrow('ACCOUNT_IDENTITY_UNRESOLVED');
      await expect(service.resolveForEnqueueInTransaction(db as any, 'org', 'project', platform, action, undefined, true)).rejects.toThrow('ACCOUNT_IDENTITY_UNRESOLVED');
    }
    expect(db.rows('sendIntent')).toHaveLength(0);
    expect(db.rows('sendExecution')).toHaveLength(0);
  });
  it.each([
    [{ disabled: true }, {}, 'ACCOUNT_DISABLED'],
    [{ inBetweenSteps: true }, {}, 'ACCOUNT_DISABLED'],
    [{}, { engageEnabled: false }, 'REPLY_ACCOUNT_DISABLED'],
  ])('stores preferences while preserving existing execution restrictions: %s %s', async (accountPatch, relationPatch, error) => {
    const { db, service, account } = pendingIdentity('x');
    Object.assign(db.rows('integration')[0], { identityNamespace: 'x.rest_id', internalId: '123' }, accountPatch);
    Object.assign(db.rows('integrationProject')[0], relationPatch, { integration: db.rows('integration')[0] });
    await expect(service.saveDefaults('org', 'user', { requestId: 'preference', accounts: { x: { REPLY: { integrationId: account.id } } } }, 'project')).resolves.toMatchObject({ saved: true });
    await expect(service.resolve('org', 'project', 'x', 'REPLY')).rejects.toThrow(error);
  });
  it.each([
    [{ organizationId: 'other' }, {}, 'ACCOUNT_DISABLED'],
    [{ deletedAt: new Date('2026-10-29T00:00:00Z') }, {}, 'ACCOUNT_DISABLED'],
    [{ providerIdentifier: 'reddit' }, {}, 'ACCOUNT_PLATFORM_MISMATCH'],
    [{}, { disabled: true }, 'ACCOUNT_NOT_ASSIGNED'],
  ])('refuses an invalid configuration target before persisting any preferences: %s %s', async (accountPatch, relationPatch, error) => {
    const { db, service, account } = pendingIdentity('x');
    Object.assign(db.rows('integration')[0], accountPatch);
    Object.assign(db.rows('integrationProject')[0], relationPatch, { integration: db.rows('integration')[0] });
    await expect(service.saveDefaults('org', 'user', { requestId: 'preference', accounts: { x: { POST: { integrationId: account.id } } } }, 'project')).rejects.toThrow(error);
    expect(db.rows('projectSendBinding')).toHaveLength(0);
  });
  it('keeps automation binding changes strict while a default preference is pending verification', async () => {
    const { db, service, account } = pendingIdentity('x');
    await expect(service.save('org', 'user', 'project', 'POST', { x: { integrationId: account.id, expectedRevision: 0 } })).rejects.toThrow('ACCOUNT_IDENTITY_UNRESOLVED');
    expect(db.rows('projectSendBinding')).toHaveLength(0);
  });
});
