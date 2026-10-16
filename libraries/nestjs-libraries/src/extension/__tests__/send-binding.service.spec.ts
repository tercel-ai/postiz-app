import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SendBindingService } from '../send-binding.service';

const account = {
  id: 'account',
  organizationId: 'org',
  providerIdentifier: 'x',
  internalId: '123',
  identityNamespace: 'x.rest_id',
  profile: 'alice',
  disabled: false,
  deletedAt: null,
  inBetweenSteps: false,
};
const row = {
  id: 'binding',
  organizationId: 'org',
  projectId: 'project',
  platform: 'x',
  action: 'POST',
  integrationId: 'old',
  revision: 3,
};

function setup() {
  const db = {
    userOrganization: {
      findUnique: vi.fn().mockResolvedValue({ disabled: false }),
    },
    organizationSendBinding: { findUnique: vi.fn().mockResolvedValue(null) },
    projectSendBinding: {
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi
        .fn()
        .mockImplementation(({ data }) => ({ ...data, id: 'binding' })),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    integrationProject: {
      findFirst: vi.fn().mockResolvedValue({
        engageEnabled: true,
        disabled: false,
        integration: account,
      }),
    },
    engageConfig: {
      findFirst: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({}),
    },
    sendMutationReceipt: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
    },
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation((fn) => fn(db));
  const projects = {
    assertProjectActive: vi.fn().mockResolvedValue(undefined),
    assertProjectAccess: vi.fn().mockResolvedValue(undefined),
  };
  return {
    db,
    projects,
    service: new SendBindingService(db as any, projects as any),
  };
}

beforeEach(() => vi.restoreAllMocks());
describe('versioned project account defaults', () => {
  it('projects disabled and revoked project assignments without returning raw integrations', async () => {
    const { db, service, projects } = setup();
    db.projectSendBinding.findMany.mockResolvedValue([
      {
        ...row,
        integration: {
          disabled: false,
          deletedAt: null,
          inBetweenSteps: false,
          integrationProjects: [{ disabled: false, engageEnabled: true }],
        },
      },
      {
        ...row,
        action: 'REPLY',
        platform: 'reddit',
        integration: {
          disabled: false,
          deletedAt: null,
          inBetweenSteps: false,
          integrationProjects: [{ disabled: false, engageEnabled: false }],
        },
      },
      {
        ...row,
        platform: 'quora',
        integration: {
          disabled: false,
          deletedAt: null,
          inBetweenSteps: false,
          integrationProjects: [],
        },
      },
      { ...row, platform: 'medium', integration: null, integrationId: null },
    ]);
    const result = await service.list('org', 'project');
    expect(result.map((binding) => binding.accountDisabled)).toEqual([
      false,
      true,
      true,
      true,
    ]);
    expect(result[0]).not.toHaveProperty('integration');
    expect(projects.assertProjectAccess).toHaveBeenCalledWith('org', 'project');
  });
  it('refuses invalid maps, missing callers, and inconsistent idempotency payloads', async () => {
    const { service } = setup();
    await expect(
      service.save('org', '', 'project', 'POST', {})
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      service.save('org', 'user', 'project', 'POST', {
        x: { expectedRevision: 0 },
      } as any)
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.save('org', 'user', 'project', 'POST', {}, undefined, ' ')
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.save(
        'org',
        'user',
        'project',
        'POST',
        {},
        (next) => next,
        'request'
      )
    ).rejects.toMatchObject({ status: 400 });
  });
  it('rejects disabled, deleted, and incomplete integrations', async () => {
    const { db, service } = setup();
    for (const change of [
      { disabled: true },
      { deletedAt: new Date() },
      { inBetweenSteps: true },
      { organizationId: 'other' },
    ]) {
      db.integrationProject.findFirst.mockResolvedValue({
        engageEnabled: true,
        disabled: false,
        integration: { ...account, ...change },
      });
      await expect(
        service.save('org', 'user', 'project', 'POST', {
          x: { integrationId: 'account', expectedRevision: 0 },
        })
      ).rejects.toMatchObject({ status: 403 });
    }
  });
  it('clears an active reply default without changing its Automation switch', async () => {
    const { db, service } = setup();
    db.projectSendBinding.findUnique.mockResolvedValue(row);
    db.engageConfig.findFirst.mockResolvedValue({
      metadata: {
        autoReplyEnabled: true,
        replyPolicies: { x: { autoReplyEnabled: true } },
      },
    });
    await expect(
      service.save('org', 'user', 'project', 'REPLY', {
        x: { integrationId: null, expectedRevision: 3 },
      })
    ).resolves.toHaveProperty('saved', true);
    expect(db.engageConfig.upsert).not.toHaveBeenCalled();
  });
  it('uses explicit account selection without reading a default and normalizes Reddit identities', async () => {
    const { db, service } = setup();
    db.integrationProject.findFirst.mockResolvedValue({
      engageEnabled: true,
      disabled: false,
      integration: {
        ...account,
        providerIdentifier: 'reddit',
        internalId: 't2_abc',
        identityNamespace: 'reddit.user_id',
        profile: null,
      },
    });
    const route = await service.resolve(
      'org',
      'project',
      'reddit',
      'POST',
      'account'
    );
    expect(route.targetAccount.id).toBe('abc');
    expect(route.targetAccount.handle).toBeNull();
    expect(db.projectSendBinding.findUnique).not.toHaveBeenCalled();
  });
  it('retries serialization collisions without swallowing other database errors', async () => {
    const { db, service } = setup();
    const work = db.$transaction.getMockImplementation()!;
    db.$transaction
      .mockRejectedValueOnce({ code: 'P2034' })
      .mockImplementation(work);
    await service.save('org', 'user', 'project', 'POST', {});
    expect(db.$transaction).toHaveBeenCalledTimes(2);
    db.$transaction.mockRejectedValueOnce(new Error('offline'));
    await expect(
      service.save('org', 'user', 'project', 'POST', {})
    ).rejects.toThrow('offline');
  });
  it('creates only the requested account binding and checks project activation', async () => {
    const { db, projects, service } = setup();
    const result = await service.save('org', 'user', 'project', 'POST', {
      x: { integrationId: 'account', expectedRevision: 0 },
    });
    expect(result.bindings).toEqual([
      { platform: 'x', integrationId: 'account', revision: 1 },
    ]);
    expect(projects.assertProjectActive).toHaveBeenCalledWith('org', 'project');
    expect(
      db.projectSendBinding.create.mock.calls[0][0].data
    ).not.toHaveProperty('extensionNodeId');
    expect(db.engageConfig.upsert).not.toHaveBeenCalled();
  });
  it('uses CAS when changing an existing binding', async () => {
    const { db, service } = setup();
    db.projectSendBinding.findUnique.mockResolvedValue(row);
    await service.save('org', 'user', 'project', 'POST', {
      x: { integrationId: 'account', expectedRevision: 3 },
    });
    expect(
      db.projectSendBinding.updateMany.mock.calls[0][0].where.revision
    ).toBe(3);
    expect(
      db.projectSendBinding.updateMany.mock.calls[0][0].data.revision
    ).toEqual({ increment: 1 });
  });
  it('rejects missing memberships and revision conflicts before settings are saved', async () => {
    const { db, service } = setup();
    db.userOrganization.findUnique.mockResolvedValue(null);
    await expect(
      service.save('org', 'user', 'project', 'POST', {
        x: { integrationId: 'account', expectedRevision: 0 },
      })
    ).rejects.toMatchObject({ status: 403 });
    db.userOrganization.findUnique.mockResolvedValue({ disabled: false });
    db.projectSendBinding.findUnique.mockResolvedValue(row);
    await expect(
      service.save('org', 'user', 'project', 'POST', {
        x: { integrationId: 'account', expectedRevision: 0 },
      })
    ).rejects.toMatchObject({ status: 409 });
    expect(db.engageConfig.upsert).not.toHaveBeenCalled();
  });
  it('rejects a lost CAS and does not save the config', async () => {
    const { db, service } = setup();
    db.projectSendBinding.findUnique.mockResolvedValue(row);
    db.projectSendBinding.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      service.save(
        'org',
        'user',
        'project',
        'POST',
        { x: { integrationId: 'account', expectedRevision: 3 } },
        (settings) => settings
      )
    ).rejects.toMatchObject({ status: 409 });
    expect(db.engageConfig.upsert).not.toHaveBeenCalled();
  });
  it('persists account selection and strategy changes in the same serializable transaction', async () => {
    const { db, service } = setup();
    await service.save(
      'org',
      'user',
      'project',
      'REPLY',
      { x: { integrationId: 'account', expectedRevision: 0 } },
      (settings) => ({
        ...settings,
        autoReplyEnabled: true,
        replyPolicies: { x: { autoReplyEnabled: true } },
      })
    );
    expect(db.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ isolationLevel: 'Serializable' })
    );
    expect(
      db.engageConfig.upsert.mock.calls[0][0].update.metadata.autoReplyEnabled
    ).toBe(true);
  });
  it('keeps a revision tombstone when clearing so stale create requests cannot pass', async () => {
    const { db, service } = setup();
    db.projectSendBinding.findUnique.mockResolvedValue(row);
    const result = await service.save('org', 'user', 'project', 'POST', {
      x: { integrationId: null, expectedRevision: 3 },
    });
    expect(result.bindings[0]).toEqual({
      platform: 'x',
      integrationId: null,
      revision: 4,
    });
    expect(
      db.projectSendBinding.updateMany.mock.calls[0][0].data.integrationId
    ).toBeNull();
    db.projectSendBinding.findUnique.mockResolvedValue({
      ...row,
      integrationId: null,
      revision: 4,
    });
    await expect(
      service.save('org', 'user', 'project', 'POST', {
        x: { integrationId: 'account', expectedRevision: 0 },
      })
    ).rejects.toMatchObject({ status: 409 });
  });
  it('allows clearing an enabled publishing default and can independently disable the operation', async () => {
    const { db, service } = setup();
    db.projectSendBinding.findUnique.mockResolvedValue(row);
    db.engageConfig.findFirst.mockResolvedValue({
      metadata: {
        publishingEnabled: true,
        replyPolicies: { x: { publishingEnabled: true } },
      },
    });
    await expect(
      service.save('org', 'user', 'project', 'POST', {
        x: { integrationId: null, expectedRevision: 3 },
      })
    ).resolves.toHaveProperty('saved', true);
    await expect(
      service.save(
        'org',
        'user',
        'project',
        'POST',
        { x: { integrationId: null, expectedRevision: 3 } },
        (settings) => ({ ...settings, publishingEnabled: false })
      )
    ).resolves.toHaveProperty('saved', true);
  });
  it('requires an actual project relationship, correct platform, and reply participation', async () => {
    const { db, service } = setup();
    const save = () =>
      service.save('org', 'user', 'project', 'REPLY', {
        x: { integrationId: 'account', expectedRevision: 0 },
      });
    db.integrationProject.findFirst.mockResolvedValue(null);
    await expect(save()).rejects.toMatchObject({ status: 403 });
    db.integrationProject.findFirst.mockResolvedValue({
      engageEnabled: false,
      disabled: false,
      integration: account,
    });
    await expect(save()).rejects.toMatchObject({ status: 403 });
    db.integrationProject.findFirst.mockResolvedValue({
      engageEnabled: true,
      disabled: false,
      integration: { ...account, providerIdentifier: 'reddit' },
    });
    await expect(save()).rejects.toMatchObject({ status: 400 });
  });
  it('does not mutate omitted platform bindings or implicitly assign accounts', async () => {
    const { db, service } = setup();
    await service.save('org', 'user', 'project', 'POST', {});
    expect(db.projectSendBinding.create).not.toHaveBeenCalled();
    expect(db.integrationProject.findFirst).not.toHaveBeenCalled();
  });
  it('replays the same mutation request before checking an old revision', async () => {
    const { db, service } = setup();
    const accounts = { x: { integrationId: 'account', expectedRevision: 0 } };
    const result = await service.save(
      'org',
      'user',
      'project',
      'POST',
      accounts,
      undefined,
      'request-1'
    );
    const stored = db.sendMutationReceipt.create.mock.calls[0][0].data;
    db.sendMutationReceipt.findUnique.mockResolvedValue(stored);
    db.projectSendBinding.findUnique.mockResolvedValue(row);
    expect(
      await service.save(
        'org',
        'user',
        'project',
        'POST',
        accounts,
        undefined,
        'request-1'
      )
    ).toEqual(result);
    expect(db.projectSendBinding.create).toHaveBeenCalledTimes(1);
    await expect(
      service.save(
        'org',
        'user',
        'project',
        'POST',
        { x: { integrationId: 'other', expectedRevision: 0 } },
        undefined,
        'request-1'
      )
    ).rejects.toMatchObject({ status: 409 });
  });
  it('resolves a persisted account snapshot and refuses unresolved identity', async () => {
    const { db, service } = setup();
    db.projectSendBinding.findUnique.mockResolvedValue({
      ...row,
      integrationId: 'account',
    });
    const route = await service.resolve('org', 'project', 'x', 'POST');
    expect(route.integrationId).toBe('account');
    expect(route.targetAccount).toMatchObject({
      id: '123',
      idNamespace: 'x.rest_id',
      handle: 'alice',
    });
    expect(route).not.toHaveProperty('nodeId');
    db.integrationProject.findFirst.mockResolvedValue({
      engageEnabled: true,
      disabled: false,
      integration: { ...account, identityNamespace: null },
    });
    await expect(
      service.resolve('org', 'project', 'x', 'POST')
    ).rejects.toMatchObject({ status: 400 });
  });
  it('does not resolve absent or cleared defaults to an arbitrary account', async () => {
    const { db, service } = setup();
    await expect(
      service.resolve('org', 'project', 'x', 'POST')
    ).rejects.toMatchObject({ status: 400 });
    db.projectSendBinding.findUnique.mockResolvedValue({
      ...row,
      integrationId: null,
    });
    await expect(
      service.resolve('org', 'project', 'x', 'POST')
    ).rejects.toMatchObject({ status: 400 });
  });
});
