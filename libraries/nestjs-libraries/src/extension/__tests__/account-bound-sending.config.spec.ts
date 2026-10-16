import { afterEach, describe, expect, it, vi } from 'vitest';
import { isAccountBoundSendingEnabled } from '../account-bound-sending.config';
import { ExtensionNodesController } from '../../../../../apps/backend/src/api/routes/extension-nodes.controller';
import { SendPreferencesController } from '../../../../../apps/backend/src/api/routes/send-preferences.controller';
import { SendCoordinatorService } from '../send-coordinator.service';
afterEach(() => vi.unstubAllEnvs());
describe('single account-bound sending rollout switch', () => {
  it('defaults to legacy even when retired flags remain in the server environment', () => {
    vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', undefined);
    for (const key of [
      'SEND_COORDINATION_ENABLED',
      'EXTENSION_NODES_ENABLED',
      'PROJECT_ACCOUNT_BINDINGS_ENABLED',
    ])
      vi.stubEnv(key, 'true');
    expect(isAccountBoundSendingEnabled()).toBe(false);
    expect(() =>
      new ExtensionNodesController({ register: vi.fn() } as any).register(
        { id: 'org' } as any,
        { id: 'user' } as any,
        {} as any
      )
    ).toThrow('EXTENSION_NODES_NOT_ENABLED');
  });
  it.each(['false', 'TRUE', '1', 'yes', ''])(
    'does not enable the new mechanism for %j',
    (value) => {
      vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', value);
      expect(isAccountBoundSendingEnabled()).toBe(false);
    }
  );
  it('enables configuration, nodes and coordinated sends together without the old flags', () => {
    vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'true');
    for (const key of [
      'SEND_COORDINATION_ENABLED',
      'EXTENSION_NODES_ENABLED',
      'PROJECT_ACCOUNT_BINDINGS_ENABLED',
    ])
      vi.stubEnv(key, 'false');
    const register = vi.fn().mockReturnValue('registered');
    expect(
      new ExtensionNodesController({ register } as any).register(
        { id: 'org' } as any,
        { id: 'user' } as any,
        {} as any
      )
    ).toBe('registered');
    const getPreferences = vi.fn().mockReturnValue('preferences');
    expect(
      new SendPreferencesController({ getPreferences } as any).get({
        id: 'user',
      } as any)
    ).toBe('preferences');
    const coordinator = new SendCoordinatorService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any
    );
    expect(() => coordinator.enabled()).not.toThrow();
  });
});

import { SendProtocolController } from '../../../../../apps/backend/src/api/routes/send-executions.controller';
it('negotiates legacy by default, all V1 capabilities when enabled, and settlement protection after disabling', async () => {
  const count = vi.fn().mockResolvedValue(0);
  const controller = new SendProtocolController({
    accountWriteState: { count },
  } as any);
  const read = () =>
    controller.get({ id: 'org' } as any, { id: 'user' } as any);
  vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', undefined);
  expect(await read()).toMatchObject({
    protocol: 'LEGACY',
    nodesEnabled: false,
    coordinationRequired: false,
  });
  vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'true');
  expect(await read()).toMatchObject({
    protocol: 'ACCOUNT_BOUND_V1',
    nodesEnabled: true,
    coordinationRequired: true,
  });
  vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'false');
  count.mockResolvedValue(1);
  expect(await read()).toMatchObject({
    protocol: 'LEGACY',
    nodesEnabled: false,
    coordinationRequired: true,
  });
});
