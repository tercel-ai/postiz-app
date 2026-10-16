import { afterEach, describe, expect, it, vi } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SendPreferencesController } from '../send-preferences.controller';
import {
  SaveSendPreferencesDto,
  SaveSystemSendPolicyDto,
} from '@gitroom/nestjs-libraries/extension/send-policy.dto';
import { AdminSettingsController } from '../../../admin-api/routes/admin-settings.controller';

afterEach(() => vi.unstubAllEnvs());
const policyBody = {
  value: { mode: 'OPTIONAL' as const },
  expectedRevision: 0,
  requestId: 'save',
};
describe('sending policy APIs', () => {
  it('validates system modes, versions, payload presence and explicit personal nullable booleans', async () => {
    expect(
      await validate(plainToInstance(SaveSystemSendPolicyDto, policyBody))
    ).toEqual([]);
    for (const patch of [
      { value: undefined },
      { value: { mode: 'OTHER' } },
      { expectedRevision: -1 },
      { expectedRevision: 2147483647 },
      { requestId: ' ' },
    ])
      expect(
        (
          await validate(
            plainToInstance(SaveSystemSendPolicyDto, {
              ...policyBody,
              ...patch,
            })
          )
        ).length
      ).toBeGreaterThan(0);
    for (const requirePreselectedAccount of [true, false, null])
      expect(
        await validate(
          plainToInstance(SaveSendPreferencesDto, {
            requirePreselectedAccount,
            expectedRevision: 0,
            requestId: 'save',
          })
        )
      ).toEqual([]);
    for (const requirePreselectedAccount of [undefined, 'false', 0])
      expect(
        (
          await validate(
            plainToInstance(SaveSendPreferencesDto, {
              requirePreselectedAccount,
              expectedRevision: 0,
              requestId: 'save',
            })
          )
        ).length
      ).toBeGreaterThan(0);
  });
  it('takes personal identity only from authenticated request decorators', async () => {
    vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'true');
    const service = { getPreferences: vi.fn(), savePreferences: vi.fn() };
    const controller = new SendPreferencesController(service as any);
    const body = {
      requirePreselectedAccount: true,
      expectedRevision: 0,
      requestId: 'save',
    };
    await controller.get({ id: 'user' } as any);
    await controller.save({ id: 'org' } as any, { id: 'user' } as any, body);
    expect(service.getPreferences).toHaveBeenCalledWith('user');
    expect(service.savePreferences).toHaveBeenCalledWith('org', 'user', body);
  });
  it('keeps the admin key/value response and sends POST and compatible PUT to the same typed service', async () => {
    vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'true');
    const service = {
      getSystem: vi
        .fn()
        .mockResolvedValue({
          mode: 'REQUIRED',
          revision: 0,
          lastRequiredRevision: 0,
        }),
      saveSystem: vi.fn(),
    };
    const controller = new AdminSettingsController(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      service as any
    );
    expect(await controller.getSendPolicy()).toEqual({
      key: 'sending.account_selection_policy',
      value: { mode: 'REQUIRED', revision: 0, lastRequiredRevision: 0 },
    });
    await controller.saveSendPolicy({ id: 'admin' } as any, policyBody);
    await controller.putSendPolicy({ id: 'admin' } as any, policyBody);
    expect(service.saveSystem.mock.calls).toEqual([
      ['admin', policyBody],
      ['admin', policyBody],
    ]);
    await expect(
      controller.deleteSetting('sending.account_selection_policy')
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      controller.upsertSetting('sending.account_selection_policy', {
        value: 'OPTIONAL',
      } as any)
    ).rejects.toMatchObject({ status: 400 });
  });
  it('blocks new setting endpoints before the foundation schema is enabled', () => {
    vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'false');
    const controller = new SendPreferencesController({} as any);
    expect(() => controller.get({ id: 'user' } as any)).toThrow(
      'ACCOUNT_BINDINGS_NOT_ENABLED'
    );
    expect(() =>
      controller.save({ id: 'org' } as any, { id: 'user' } as any, {} as any)
    ).toThrow('ACCOUNT_BINDINGS_NOT_ENABLED');
    const admin = new AdminSettingsController(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any
    );
    expect(() =>
      admin.saveSendPolicy({ id: 'user' } as any, policyBody)
    ).toThrow('ACCOUNT_BINDINGS_NOT_ENABLED');
  });
});
