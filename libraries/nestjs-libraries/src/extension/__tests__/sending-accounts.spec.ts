import { describe, expect, it, vi } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SendBindingService } from '../send-binding.service';
import { SaveSendingAccountsDto } from '../send-binding.dto';

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
    await expect(
      service.saveDefaults(
        'org',
        'user',
        {
          accounts: { x: { POST: choice(), REPLY: choice() } },
          requestId: 'save',
        },
        'project'
      )
    ).rejects.toMatchObject({ status: 409 });
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

  it('replays before revision checks and isolates receipts by resource', async () => {
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

  it('refuses missing membership, foreign actors, invalid platforms, and lost CAS', async () => {
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
    await expect(
      service.saveDefaults('org', 'user', body)
    ).rejects.toMatchObject({ status: 409 });
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
