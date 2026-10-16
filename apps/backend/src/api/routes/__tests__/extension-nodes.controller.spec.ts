import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { ExtensionNodesController } from '../extension-nodes.controller';
import { IntegrationsController } from '../integrations.controller';

const org = { id: 'org' } as any,
  user = { id: 'user' } as any;
beforeEach(() => vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'true'));
afterEach(() => vi.unstubAllEnvs());

describe('terminal API registration', () => {
  it('keeps new writes on POST and list on GET', () => {
    expect(Reflect.getMetadata(PATH_METADATA, ExtensionNodesController)).toBe(
      '/extension/nodes'
    );
    expect(
      Reflect.getMetadata(
        METHOD_METADATA,
        ExtensionNodesController.prototype.register
      )
    ).toBe(RequestMethod.POST);
    expect(
      Reflect.getMetadata(
        METHOD_METADATA,
        ExtensionNodesController.prototype.save
      )
    ).toBe(RequestMethod.POST);
    expect(
      Reflect.getMetadata(
        METHOD_METADATA,
        ExtensionNodesController.prototype.list
      )
    ).toBe(RequestMethod.GET);
  });
  it('uses authenticated tenant and user rather than body identifiers', () => {
    const service = {
      register: vi.fn().mockReturnValue('registered'),
      list: vi.fn().mockReturnValue([]),
      save: vi.fn().mockReturnValue('saved'),
    };
    const controller = new ExtensionNodesController(service as any);
    const input: any = { organizationId: 'other', userId: 'other' };
    expect(controller.register(org, user, input)).toBe('registered');
    expect(service.register).toHaveBeenCalledWith('org', 'user', input);
    expect(controller.list(org, user)).toEqual([]);
    expect(controller.save(org, user, input)).toBe('saved');
  });
  it('stays disabled by default without accessing new database tables', () => {
    vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'false');
    const service = { register: vi.fn() };
    expect(() =>
      new ExtensionNodesController(service as any).register(
        org,
        user,
        {} as any
      )
    ).toThrow('EXTENSION_NODES_NOT_ENABLED');
    expect(service.register).not.toHaveBeenCalled();
  });
});

describe('session report API compatibility', () => {
  function setup() {
    const integrations = {
      reportExtensionSession: vi.fn().mockResolvedValue({ legacy: true }),
      verifyStableIdentity: vi.fn().mockResolvedValue({integrationId:'actor'}),
    };
    const nodes = { report: vi.fn().mockResolvedValue({ results: [] }) };
    const permissions = {
      check: vi.fn().mockResolvedValue({ can: () => true }),
    };
    const controller = new IntegrationsController(
      {} as any,
      integrations as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      permissions as any,
      nodes as any
    );
    return { integrations, nodes, controller };
  }
  it('adds a POST identity verification route scoped to the authenticated organization and user',async()=>{
    const {controller,integrations}=setup();
    expect(Reflect.getMetadata(METHOD_METADATA,IntegrationsController.prototype.verifyStableIdentity)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata(PATH_METADATA,IntegrationsController.prototype.verifyStableIdentity)).toBe('/:id/identity/verify');
    expect(await controller.verifyStableIdentity(org,user,'actor')).toEqual({integrationId:'actor'});
    expect(integrations.verifyStableIdentity).toHaveBeenCalledWith('org','user','actor');
  });
  const payload = { checkedAt: '2026-10-14T03:00:00Z', platforms: [] };
  it('keeps PATCH while adding a POST alias for the same business service', async () => {
    const { controller, integrations } = setup();
    const actorOrg = {
      ...org,
      createdAt: new Date(),
      users: [{ role: 'USER' }],
    };
    expect(
      Reflect.getMetadata(
        METHOD_METADATA,
        IntegrationsController.prototype.reportExtensionSession
      )
    ).toBe(RequestMethod.PATCH);
    expect(
      Reflect.getMetadata(
        METHOD_METADATA,
        IntegrationsController.prototype.reportExtensionSessionPost
      )
    ).toBe(RequestMethod.POST);
    expect(
      await controller.reportExtensionSessionPost(actorOrg, user, payload)
    ).toEqual({ legacy: true });
    expect(integrations.reportExtensionSession).toHaveBeenCalledWith(
      'org',
      payload,
      { canCreateChannels: true }
    );
  });
  it('uses node authentication for both verbs without touching legacy global sessions', async () => {
    const { controller, nodes, integrations } = setup();
    const strict = { ...payload, reportSequence: 1 };
    await controller.reportExtensionSession(org, user, strict, 'node', 'token');
    await controller.reportExtensionSessionPost(
      org,
      user,
      strict,
      'node',
      'token'
    );
    expect(nodes.report).toHaveBeenCalledTimes(2);
    expect(integrations.reportExtensionSession).not.toHaveBeenCalled();
  });
  it('does not downgrade requests that advertise strict protocol without a node', async () => {
    const { controller, nodes, integrations } = setup();
    nodes.report.mockRejectedValue(new Error('NODE_AUTHENTICATION_REQUIRED'));
    await expect(
      controller.reportExtensionSession(
        org,
        user,
        payload,
        undefined,
        undefined,
        'ACCOUNT_BOUND_V1'
      )
    ).rejects.toThrow('NODE_AUTHENTICATION_REQUIRED');
    expect(integrations.reportExtensionSession).not.toHaveBeenCalled();
  });
  it('rejects strict reports when the feature is disabled', async () => {
    vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'false');
    const { controller, nodes, integrations } = setup();
    await expect(
      controller.reportExtensionSession(org, user, payload, 'node', 'token')
    ).rejects.toThrow('EXTENSION_NODES_NOT_ENABLED');
    expect(nodes.report).not.toHaveBeenCalled();
    expect(integrations.reportExtensionSession).not.toHaveBeenCalled();
  });
});
