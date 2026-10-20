import { describe, it, expect, vi } from 'vitest';
import { PlanExecutionService } from '../plan-execution.service';
import { isPlanRouteMap } from '../plan-execution.dto';

const resolved = {
  integrationId: 'account',
  providerIdentifier: 'x',
  bindingRevision: null,
  canonicalAccountKey: 'key',
  targetAccount: { id: '123', idNamespace: 'x.rest_id', handle: 'alice' },
};
const routes = {
  version: 1,
  platforms: { x: { POST: { ...resolved, origin: 'EXPLICIT' } } },
};
const draft = {
  id: 'root',
  parentPostId: null,
  organizationId: 'org',
  projectId: 'project',
  operationPlanId: 'plan',
  group: 'group',
  state: 'DRAFT',
  routeRevision: 0,
  releaseId: null,
  claimedAt: null,
  settings: '{"__type":"x","custom":true}',
  providerIdentifier: 'x',
};
const plan = {
  id: 'plan',
  organizationId: 'org',
  projectId: 'project',
  platforms: ['x'],
  executionRevision: 0,
  executionRoutes: null,
};
function setup() {
  const db = {
    operationPlan: {
      findFirst: vi.fn().mockResolvedValue(plan),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    post: {
      findMany: vi.fn().mockResolvedValue([draft]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    userOrganization: {
      findUnique: vi.fn().mockResolvedValue({ disabled: false }),
    },
    sendMutationReceipt: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
    },
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation((fn) => fn(db));
  const bindings = {
    resolveInTransaction: vi.fn().mockResolvedValue(resolved),
  };
  const projects = {
    assertProjectAccess: vi.fn(),
    assertProjectActive: vi.fn(),
  };
  const service = new PlanExecutionService(
    db as any,
    bindings as any,
    projects as any,
    { lockIn: vi.fn(async () => ({ mode: process.env.ACCOUNT_BOUND_SENDING_ENABLED === 'true' ? 'CONTROLLED' : 'AUTONOMOUS' })) } as any
  );
  return { db, bindings, projects, service };
}
const body = {
  expectedRevision: 0,
  executionRoutes: { x: { POST: { integrationId: 'account' } } },
  drafts: [{ id: 'root', expectedRouteRevision: 0 }],
  requestId: 'save-1',
};
describe('plan account route snapshots', () => {
  it('accepts account IDs and explicit clearing while rejecting node IDs and untrusted snapshots', () => {
    expect(isPlanRouteMap(body.executionRoutes)).toBe(true);
    expect(isPlanRouteMap({ x: { REPLY: { integrationId: null } } })).toBe(
      true
    );
    for (const value of [
      null,
      [],
      { bogus: {} },
      { x: {} },
      { x: { POST: { integrationId: 'a', nodeId: 'node' } } },
      { x: { POST: { integrationId: 'a', targetAccount: {} } } },
      { x: { POST: { integrationId: '' } } },
    ])
      expect(isPlanRouteMap(value)).toBe(false);
  });
  it('builds server-owned identities, verifies platform coverage, and leaves reply defaults alone', async () => {
    const { service, db, bindings } = setup();
    const snapshot = await service.resolve(
      'org',
      'project',
      ['x'],
      body.executionRoutes
    );
    expect(snapshot).toEqual(routes);
    expect(bindings.resolveInTransaction).toHaveBeenCalledWith(
      db,
      'org',
      'project',
      'x',
      'POST',
      'account'
    );
    await expect(
      service.resolve('org', 'project', ['reddit'], body.executionRoutes)
    ).rejects.toMatchObject({ status: 400 });
    expect(db.post.updateMany).not.toHaveBeenCalled();
  });
  it('edits only selected draft chains and keeps historical plan routes unchanged', async () => {
    const { service, db } = setup();
    const result = await service.save('org', 'user', 'project', 'plan', body);
    expect(result.executionRevision).toBe(1);
    expect(result.executionRoutes).toBeNull();
    expect(
      db.operationPlan.updateMany.mock.calls[0][0].data
    ).not.toHaveProperty('executionRoutes');
    expect(
      db.operationPlan.updateMany.mock.calls[0][0].where.executionRevision
    ).toBe(0);
    const update = db.post.updateMany.mock.calls[0][0];
    expect(update.where).toMatchObject({
      organizationId: 'org',
      operationPlanId: 'plan',
      group: 'group',
      state: 'DRAFT',
      routeRevision: 0,
      claimedAt: null,
      releaseId: null,
    });
    expect(update.data).toMatchObject({
      integrationId: 'account',
      accountSelectionMode: 'EXPLICIT',
      bindingSource: 'EXPLICIT',
      executionProtocol: 'ACCOUNT_BOUND_V1',
      routeRevision: { increment: 1 },
    });
    expect(JSON.parse(update.data.settings)).toEqual({
      __type: 'x',
      custom: true,
    });
    expect(db.sendMutationReceipt.create).toHaveBeenCalled();
  });
  it('replays a lost response before stale revision checks and rejects key reuse', async () => {
    const { service, db } = setup();
    const saved = await service.save('org', 'user', 'project', 'plan', body);
    const receipt = db.sendMutationReceipt.create.mock.calls[0][0].data;
    db.sendMutationReceipt.findUnique.mockResolvedValue(receipt);
    db.operationPlan.findFirst.mockResolvedValue({
      ...plan,
      executionRevision: 8,
    });
    await expect(
      service.save('org', 'user', 'project', 'plan', body)
    ).resolves.toEqual(saved);
    await expect(
      service.save('org', 'user', 'project', 'plan', {
        ...body,
        expectedRevision: 8,
      })
    ).rejects.toMatchObject({ status: 409 });
    expect(db.operationPlan.updateMany).toHaveBeenCalledTimes(1);
  });
  it('rejects tenant/project mismatch, missing member, stale plan or draft, and claimed/non-draft edits', async () => {
    for (const patch of [
      { operationPlan: { ...plan, projectId: 'other' } },
      { operationPlan: { ...plan, executionRevision: 1 } },
      { post: { ...draft, state: 'QUEUE' } },
      { post: { ...draft, claimedAt: new Date() } },
      { post: { ...draft, routeRevision: 1 } },
      { post: { ...draft, parentPostId: 'other' } },
      { post: { ...draft, releaseId: 'lease' } },
    ]) {
      const { service, db } = setup();
      if (patch.operationPlan)
        db.operationPlan.findFirst.mockResolvedValue(patch.operationPlan);
      if (patch.post) db.post.findMany.mockResolvedValue([patch.post]);
      await expect(
        service.save('org', 'user', 'project', 'plan', body)
      ).rejects.toBeDefined();
      expect(db.operationPlan.updateMany).not.toHaveBeenCalled();
      expect(db.post.updateMany).not.toHaveBeenCalled();
    }
    const { service, db } = setup();
    db.userOrganization.findUnique.mockResolvedValue(null);
    await expect(
      service.save('org', 'user', 'project', 'plan', body)
    ).rejects.toMatchObject({ status: 403 });
  });
  it('clear restores inheritance and preserves the controlled protocol', async () => {
    const { service, db } = setup();
    await service.save('org', 'user', 'project', 'plan', {
      ...body,
      executionRoutes: { x: { POST: { integrationId: null } } },
    });
    expect(db.post.updateMany.mock.calls[0][0].data).toMatchObject({
      integrationId: null,
      accountSelectionMode: 'INHERIT',
      executionProtocol: 'ACCOUNT_BOUND_V1',
      sendBlockCode: 'SEND_BINDING_REQUIRED',
    });
  });
  it('refuses missing roots and protects unselected drafts and their prior route snapshots', async () => {
    const { service, db } = setup();
    db.post.findMany.mockResolvedValue([]);
    await expect(
      service.save('org', 'user', 'project', 'plan', body)
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      service.save('org', 'user', 'project', 'plan', {
        ...body,
        drafts: [],
        executionRoutes: { x: { REPLY: { integrationId: 'account' } } },
      })
    ).rejects.toMatchObject({ status: 400 });
    expect(db.post.updateMany).not.toHaveBeenCalled();
  });
  it('validates callers and optimistic versions before entering a transaction', async () => {
    const { service, db } = setup();
    await expect(
      service.save('org', '', 'project', 'plan', body)
    ).rejects.toMatchObject({ status: 403 });
    for (const invalid of [
      { expectedRevision: -1 },
      { drafts: [{ id: 'root', expectedRouteRevision: -1 }] },
      { drafts: [body.drafts[0], body.drafts[0]] },
      { requestId: '' },
      { executionRoutes: null },
    ])
      await expect(
        service.save('org', 'user', 'project', 'plan', {
          ...body,
          ...invalid,
        } as any)
      ).rejects.toMatchObject({ status: 400 });
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it('rejects missing plans, unselected draft actions, and non-editable thread children', async () => {
    const { service, db } = setup();
    db.operationPlan.findFirst.mockResolvedValue(null);
    await expect(
      service.save('org', 'user', 'project', 'plan', body)
    ).rejects.toMatchObject({ status: 404 });
    db.operationPlan.findFirst.mockResolvedValue(plan);
    await expect(
      service.save('org', 'user', 'project', 'plan', {
        ...body,
        executionRoutes: { x: { REPLY: { integrationId: 'account' } } },
      })
    ).rejects.toMatchObject({ status: 400 });
    db.post.findMany
      .mockResolvedValueOnce([draft])
      .mockResolvedValueOnce([
        draft,
        { ...draft, id: 'child', parentPostId: 'root', state: 'PUBLISHED' },
      ]);
    await expect(
      service.save('org', 'user', 'project', 'plan', body)
    ).rejects.toMatchObject({ status: 409 });
    expect(db.operationPlan.updateMany).not.toHaveBeenCalled();
  });
  it('rejects lost plan and draft CAS writes rather than pretending the routes were applied', async () => {
    const { service, db } = setup();
    db.operationPlan.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      service.save('org', 'user', 'project', 'plan', body)
    ).rejects.toMatchObject({ status: 409 });
    db.operationPlan.updateMany.mockResolvedValue({ count: 1 });
    db.post.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      service.save('org', 'user', 'project', 'plan', body)
    ).rejects.toMatchObject({ status: 409 });
    expect(db.sendMutationReceipt.create).not.toHaveBeenCalled();
  });
  it('rejects plan-level reply changes even without selected drafts', async () => {
    const { service, db } = setup();
    db.operationPlan.findFirst.mockResolvedValue({
      ...plan,
      executionRoutes: routes,
    });
    await expect(
      service.save('org', 'user', 'project', 'plan', {
        ...body,
        requestId: undefined,
        drafts: [],
        executionRoutes: { x: { REPLY: { integrationId: null } } },
      })
    ).rejects.toMatchObject({
      status: 400,
      response: { code: 'PLAN_ACCOUNT_SELECTION_MOVED' },
    });
    expect(db.sendMutationReceipt.create).not.toHaveBeenCalled();
  });
  it('retries serializable conflicts, propagates infrastructure errors, and checks persisted project access', async () => {
    const { service, db, projects } = setup();
    const work = db.$transaction.getMockImplementation()!;
    db.$transaction
      .mockRejectedValueOnce({ code: 'P2034' })
      .mockImplementation(work);
    await service.resolve('org', 'project', ['x'], body.executionRoutes);
    expect(db.$transaction).toHaveBeenCalledTimes(2);
    db.$transaction.mockRejectedValueOnce(new Error('offline'));
    await expect(
      service.resolve('org', 'project', ['x'], body.executionRoutes)
    ).rejects.toThrow('offline');
    await service.assertAccess('org', 'project');
    expect(projects.assertProjectAccess).toHaveBeenCalledWith('org', 'project');
  });
  it('returns zero for an empty materialization and refuses missing persisted plans', async () => {
    const { service, db } = setup();
    await expect(service.materialize('org', 'plan', [])).resolves.toEqual({
      count: 0,
    });
    db.operationPlan.findFirst.mockResolvedValue(null);
    await expect(
      service.materialize('org', 'plan', [draft])
    ).rejects.toMatchObject({ status: 404 });
  });
  it('materializes inherited drafts without applying historical plan routes', async () => {
    const { service, db } = setup();
    db.operationPlan.findFirst.mockResolvedValue({
      ...plan,
      executionRevision: 2,
      executionRoutes: routes,
    });
    await service.materialize('org', 'plan', [
      { ...draft, providerIdentifier: 'x', integrationId: null },
    ]);
    expect(db.post.createMany.mock.calls[0][0]).toMatchObject({
      skipDuplicates: true,
      data: [
        {
          integrationId: null,
          accountSelectionMode: 'INHERIT',
          routeRevision: 0,
        },
      ],
    });
  });
  it('does not treat an omitted historical route as a missing required draft account', async () => {
    const { service, db } = setup();
    db.operationPlan.findFirst.mockResolvedValue({
      ...plan,
      executionRoutes: routes,
    });
    await service.materialize('org', 'plan', [
      { ...draft, providerIdentifier: 'reddit' },
    ]);
    expect(db.post.createMany.mock.calls[0][0].data[0]).toMatchObject({
      integrationId: null,
      accountSelectionMode: 'INHERIT',
      sendBlockCode: null,
    });
  });
  it('preserves legacy materialization when no execution routes were selected', async () => {
    const { service, db } = setup();
    await service.materialize('org', 'plan', [draft]);
    expect(db.post.createMany.mock.calls[0][0].data[0]).toMatchObject({
      ...draft,
      integrationId: null,
      accountSelectionMode: 'INHERIT',
    });
  });
  it('reports mismatched create retry routes without rebilling or mutating a previous plan', () => {
    const { service } = setup();
    expect(service.compare(routes, body.executionRoutes)).toBe(true);
    expect(
      service.compare(routes, { x: { POST: { integrationId: 'other' } } })
    ).toBe(false);
    expect(service.compare(null, body.executionRoutes)).toBe(false);
  });
});
