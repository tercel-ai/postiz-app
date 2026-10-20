import { describe, expect, it, vi } from 'vitest';
import { ExtensionNodesController } from '../extension-nodes.controller';
import { SendingAccountsController } from '../sending-accounts.controller';
import { SendPreferencesController } from '../send-preferences.controller';

const org = { id: 'org' } as any;
const user = { id: 'user' } as any;
function modes(mode = 'AUTONOMOUS', enabled = true) {
  return {
    getSystem: vi.fn().mockResolvedValue({ effectiveEnabled: enabled }),
    get: vi.fn().mockResolvedValue({ mode, configuredMode: mode === 'PAUSED' ? 'CONTROLLED' : mode, systemEnabled: enabled }),
  };
}
describe('Settings capability and organization mode at configuration endpoints', () => {
  it('allows configuration before enabling an organization, using typed Settings capability', async () => {
    const binding = { getDefaults: vi.fn().mockResolvedValue('defaults') };
    const policy = { getPreferences: vi.fn().mockResolvedValue('preferences') };
    expect(await new SendingAccountsController(binding as any, modes() as any).project(org, user, 'project')).toBe('defaults');
    expect(await new SendPreferencesController(policy as any, modes() as any).get(user)).toBe('preferences');
  });
  it('refuses registration in autonomous mode even if system capability is enabled', async () => {
    const nodes = { register: vi.fn() };
    await expect(new ExtensionNodesController(nodes as any, modes() as any).register(org, user, {} as any)).rejects.toThrow('EXTENSION_NODES_NOT_ENABLED');
    expect(nodes.register).not.toHaveBeenCalled();
  });
  it('permits controlled registration and paused management without permitting new paused registration', async () => {
    const nodes = { register: vi.fn().mockResolvedValue('node'), list: vi.fn().mockResolvedValue([]), save: vi.fn().mockResolvedValue('saved') };
    expect(await new ExtensionNodesController(nodes as any, modes('CONTROLLED') as any).register(org, user, {} as any)).toBe('node');
    const paused = new ExtensionNodesController(nodes as any, modes('PAUSED', false) as any);
    expect(await paused.list(org, user)).toEqual([]);
    expect(await paused.save(org, user, {} as any)).toBe('saved');
    await expect(paused.register(org, user, {} as any)).rejects.toThrow('EXTENSION_NODES_NOT_ENABLED');
    expect(nodes.register).toHaveBeenCalledTimes(1);
  });
  it('does not treat a failed Settings read as permission to access controlled configuration', async () => {
    const service = { getDefaults: vi.fn() };
    const mode = modes();
    mode.getSystem.mockRejectedValue(new Error('SETTINGS_UNAVAILABLE'));
    await expect(new SendingAccountsController(service as any, mode as any).project(org, user, 'project')).rejects.toThrow('SETTINGS_UNAVAILABLE');
    expect(service.getDefaults).not.toHaveBeenCalled();
  });
});
