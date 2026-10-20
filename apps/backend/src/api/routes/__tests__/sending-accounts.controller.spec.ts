import { afterEach, describe, expect, it, vi } from 'vitest';
import { SendingAccountsController } from '../sending-accounts.controller';

afterEach(() => vi.unstubAllEnvs());
describe('sending account endpoints', () => {
  it('uses the authenticated tenant and user for both resource scopes', async () => {
    vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'true');
    const service = { getDefaults: vi.fn(), saveDefaults: vi.fn() };
    const controller = new SendingAccountsController(service as any, { getSystem: vi.fn().mockResolvedValue({ effectiveEnabled: true }) } as any);
    const org = { id: 'org' } as any;
    const user = { id: 'user' } as any;
    const body = {
      accounts: { x: { POST: { integrationId: 'x1' } } },
      requestId: 'save',
    };
    await controller.organization(org, user);
    await controller.project(org, user, 'project');
    await controller.saveOrganization(org, user, body);
    await controller.saveProject(org, user, 'project', body);
    expect(service.getDefaults.mock.calls).toEqual([
      ['org', 'user'],
      ['org', 'user', 'project'],
    ]);
    expect(service.saveDefaults.mock.calls).toEqual([
      ['org', 'user', body],
      ['org', 'user', body, 'project'],
    ]);
  });
  it('does not expose controlled configuration when system capability is disabled', async () => {
    vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'false');
    const controller = new SendingAccountsController({} as any, { getSystem: vi.fn().mockResolvedValue({ effectiveEnabled: false }) } as any);
    for (const call of [
      () => controller.organization({} as any, {} as any),
      () => controller.project({} as any, {} as any, 'project'),
      () => controller.saveOrganization({} as any, {} as any, {} as any),
      () => controller.saveProject({} as any, {} as any, 'project', {} as any),
    ])
      await expect(call()).rejects.toThrow('ACCOUNT_BINDINGS_NOT_ENABLED');
  });
});
