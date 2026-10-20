import { afterEach, describe, expect, it, vi } from 'vitest';
import { isAccountBoundSendingEnabled } from '../account-bound-sending.config';
import { ExtensionNodesController } from '../../../../../apps/backend/src/api/routes/extension-nodes.controller';
import { SendPreferencesController } from '../../../../../apps/backend/src/api/routes/send-preferences.controller';
import { SendCoordinatorService } from '../send-coordinator.service';
afterEach(() => vi.unstubAllEnvs());
describe('system capability and organization modes', () => {
  it.each([undefined, 'false', 'TRUE', '1', 'yes', ''])('keeps environment fallback disabled for %j', value => {
    vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', value);
    expect(isAccountBoundSendingEnabled()).toBe(false);
  });
  it('does not register nodes for autonomous organizations even when the capability is enabled', async () => {
    vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'true');
    const register = vi.fn();
    const modes = { get: vi.fn().mockResolvedValue({ mode: 'AUTONOMOUS', systemEnabled: true }) };
    await expect(new ExtensionNodesController({ register } as any, modes as any).register(
      { id: 'org' } as any, { id: 'user' } as any, {} as any)).rejects.toThrow('EXTENSION_NODES_NOT_ENABLED');
    expect(register).not.toHaveBeenCalled();
  });
  it('allows controlled node registration and capability-enabled preferences', async () => {
    const modes = { get: vi.fn().mockResolvedValue({ mode: 'CONTROLLED', systemEnabled: true }),
      getSystem: vi.fn().mockResolvedValue({ effectiveEnabled: true }) };
    const register = vi.fn().mockResolvedValue('registered');
    await expect(new ExtensionNodesController({ register } as any, modes as any).register(
      { id: 'org' } as any, { id: 'user' } as any, {} as any)).resolves.toBe('registered');
    const getPreferences = vi.fn().mockResolvedValue('preferences');
    await expect(new SendPreferencesController({ getPreferences } as any, modes as any).get({ id: 'user' } as any)).resolves.toBe('preferences');
  });
});

import { SendProtocolController } from '../../../../../apps/backend/src/api/routes/send-executions.controller';
it.each([
  ['AUTONOMOUS', 'LEGACY', false, false, true],
  ['CONTROLLED', 'ACCOUNT_BOUND_V1', true, true, false],
  ['PAUSED', 'LEGACY', false, true, false],
])('negotiates authoritative %s mode independently from plugin version', async (mode, protocol, nodesEnabled, coordinationRequired, autonomousAllowed) => {
  const modes = { get: vi.fn().mockResolvedValue({ mode, revision: 3, autonomousAllowed }) };
  const result = await new SendProtocolController(modes as any).get({ id: 'org' } as any, { id: 'user' } as any);
  expect(result).toMatchObject({ sendingMode: mode, modeRevision: 3, protocol, nodesEnabled, coordinationRequired, autonomousAllowed });
  expect(modes.get).toHaveBeenCalledWith('org', 'user');
});
