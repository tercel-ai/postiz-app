import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SendModeController } from '../../../../../apps/backend/src/api/routes/send-mode.controller';
import { AdminSettingsController } from '../../../../../apps/backend/src/admin-api/routes/admin-settings.controller';
import { SettingsService } from '../../database/prisma/settings/settings.service';
import {
  BeginBrowserWriteDto,
  BrowserWriteOutcomeDto,
  ResolveAutonomousEffectDto,
  ResolveLegacyReplyRecoveryDto,
  SaveSendModeDto,
  SaveSystemSendModeDto,
} from '../send-mode.dto';
import {
  SEND_MODE_SYSTEM_KEY,
  organizationSendModeKey,
} from '../send-mode.service';

describe('sending mode API and Settings isolation', () => {
  it('requires explicit administrator evidence and a complete recovery snapshot for historical claim repair', async () => {
    const body = { expectedOrganizationId: 'org', expectedUserId: 'admin', requestId: 'repair',
      expectedRecoveryRevision: 'a'.repeat(64), executorStopped: true, noPendingSubmit: true,
      replyAbsent: true, evidence: 'Original workers stopped; target checked.' };
    expect(await validate(plainToInstance(ResolveLegacyReplyRecoveryDto, body))).toEqual([]);
    for (const patch of [{ expectedRecoveryRevision: 'stale' }, { replyAbsent: false },
      { executorStopped: false }, { noPendingSubmit: false }, { evidence: ' ' },
      { evidence: 'x'.repeat(2001) }, { requestId: '' }, { expectedUserId: undefined }])
      expect(await validate(plainToInstance(ResolveLegacyReplyRecoveryDto, { ...body, ...patch }))).not.toEqual([]);
  });
  it('routes historical reply inspection and resolution using authenticated organization and administrator identities', async () => {
    const modes = { getLegacyReplyRecovery: vi.fn(), resolveLegacyReplyRecovery: vi.fn() };
    const controller = new SendModeController(modes as any);
    const body = { expectedOrganizationId: 'org', expectedUserId: 'admin', requestId: 'repair',
      expectedRecoveryRevision: 'a'.repeat(64), executorStopped: true as const, noPendingSubmit: true as const,
      replyAbsent: true as const, evidence: 'Workers stopped and platform inspected.' };
    controller.getLegacyReplyRecovery({ id: 'org' } as any, { id: 'admin' } as any, 'reply');
    controller.resolveLegacyReplyRecovery({ id: 'org' } as any, { id: 'admin' } as any, 'reply', body);
    expect(modes.getLegacyReplyRecovery).toHaveBeenCalledWith('org', 'admin', 'reply');
    expect(modes.resolveLegacyReplyRecovery).toHaveBeenCalledWith('org', 'admin', 'reply', body);
    expect(Reflect.getMetadata('path', controller.getLegacyReplyRecovery)).toBe('/replies/:id/legacy-recovery');
    expect(Reflect.getMetadata('path', controller.resolveLegacyReplyRecovery)).toBe('/replies/:id/legacy-recovery');
  });

  it('validates browser write ownership, stable content identities and safe outcome proof', async () => {
    const owner = { expectedOrganizationId: 'org', expectedUserId: 'user' };
    const begin = {
      ...owner,
      requestId: 'write',
      platform: 'x',
      contentHash: 'a'.repeat(64),
    };
    expect(
      await validate(plainToInstance(BeginBrowserWriteDto, begin))
    ).toEqual([]);
    for (const patch of [
      { contentHash: 'raw body' },
      { expectedOrganizationId: undefined },
      { requestId: '' },
      { platform: '../x' },
    ])
      expect(
        await validate(
          plainToInstance(BeginBrowserWriteDto, { ...begin, ...patch })
        )
      ).not.toEqual([]);
    expect(
      await validate(
        plainToInstance(BrowserWriteOutcomeDto, {
          ...owner,
          status: 'CONFIRMED',
          platformPostId: 'remote',
          url: 'https://x.com/user/status/remote',
        })
      )
    ).toEqual([]);
    expect(
      await validate(
        plainToInstance(BrowserWriteOutcomeDto, { ...owner, status: 'RETRY' })
      )
    ).not.toEqual([]);
    expect(
      await validate(
        plainToInstance(BrowserWriteOutcomeDto, {
          ...owner,
          status: 'CONFIRMED',
          url: 'javascript:alert(1)',
        })
      )
    ).not.toEqual([]);
  });
  it('routes browser admissions and late outcomes through authenticated organization and user', async () => {
    const modes = { beginBrowserWrite: vi.fn(), settleBrowserWrite: vi.fn() };
    const controller = new SendModeController(modes as any);
    const owner = { expectedOrganizationId: 'org', expectedUserId: 'user' };
    const begin = {
      ...owner,
      requestId: 'write',
      platform: 'x',
      contentHash: 'a'.repeat(64),
    };
    const outcome = { ...owner, status: 'UNKNOWN' as const };
    await controller.beginBrowserWrite(
      { id: 'org' } as any,
      { id: 'user' } as any,
      begin
    );
    await controller.settleBrowserWrite(
      { id: 'org' } as any,
      { id: 'user' } as any,
      'effect',
      outcome
    );
    expect(modes.beginBrowserWrite).toHaveBeenCalledWith('org', 'user', begin);
    expect(modes.settleBrowserWrite).toHaveBeenCalledWith(
      'org',
      'user',
      'effect',
      outcome
    );
    expect(Reflect.getMetadata('path', controller.beginBrowserWrite)).toBe(
      '/browser-writes'
    );
    expect(Reflect.getMetadata('path', controller.settleBrowserWrite)).toBe(
      '/browser-writes/:id/outcome'
    );
  });
  it('requires typed operator stop attestations and evidence for autonomous-effect resolution', async () => {
    const body = {
      decision: 'CONFIRMED',
      expectedRevision: 1,
      requestId: 'resolve',
      expectedOrganizationId: 'org',
      expectedUserId: 'user',
      executorStopped: true,
      noPendingSubmit: true,
      evidence: 'Executor stopped; platform verified.',
    };
    expect(
      await validate(plainToInstance(ResolveAutonomousEffectDto, body))
    ).toEqual([]);
    for (const patch of [
      { executorStopped: false },
      { noPendingSubmit: false },
      { evidence: '' },
      { evidence: 'x'.repeat(2001) },
      { decision: 'RETRY' },
      { expectedOrganizationId: undefined },
    ])
      expect(
        await validate(
          plainToInstance(ResolveAutonomousEffectDto, { ...body, ...patch })
        )
      ).not.toEqual([]);
  });
  it('routes operator listing and resolution with authenticated scope and the supplied effect identity', async () => {
    const modes = {
      listAutonomousEffects: vi.fn(),
      resolveAutonomousEffect: vi.fn(),
    };
    const controller = new SendModeController(modes as any);
    const body = {
      decision: 'NOT_SUBMITTED' as const,
      expectedRevision: 1,
      requestId: 'resolve',
      expectedOrganizationId: 'org',
      expectedUserId: 'user',
      executorStopped: true as const,
      noPendingSubmit: true as const,
      evidence: 'Stopped and checked.',
    };
    await controller.listAutonomousEffects(
      { id: 'org' } as any,
      { id: 'user' } as any
    );
    await controller.resolveAutonomousEffect(
      { id: 'org' } as any,
      { id: 'user' } as any,
      'effect',
      body
    );
    expect(modes.listAutonomousEffects).toHaveBeenCalledWith('org', 'user');
    expect(modes.resolveAutonomousEffect).toHaveBeenCalledWith(
      'org',
      'user',
      'effect',
      body
    );
    expect(Reflect.getMetadata('path', controller.listAutonomousEffects)).toBe(
      '/autonomous-effects'
    );
    expect(
      Reflect.getMetadata('path', controller.resolveAutonomousEffect)
    ).toBe('/autonomous-effects/:id/resolve');
    expect(
      Reflect.getMetadata('method', controller.listAutonomousEffects)
    ).toBe(0);
    expect(
      Reflect.getMetadata('method', controller.resolveAutonomousEffect)
    ).toBe(1);
  });
  it('accepts only explicit typed modes, boolean capability and bounded optimistic mutations', async () => {
    expect(
      await validate(
        plainToInstance(SaveSendModeDto, {
          mode: 'AUTONOMOUS',
          expectedOrganizationId: 'org',
          expectedUserId: 'user',
          expectedRevision: 0,
          requestId: 'a',
        })
      )
    ).toEqual([]);
    expect(
      await validate(
        plainToInstance(SaveSystemSendModeDto, {
          enabled: true,
          expectedRevision: 0,
          requestId: 'a',
        })
      )
    ).toEqual([]);
    for (const body of [
      { mode: 'LEGACY', expectedRevision: 0, requestId: 'a' },
      { mode: 'CONTROLLED', expectedRevision: -1, requestId: 'a' },
      { mode: 'CONTROLLED', expectedRevision: 0, requestId: ' ' },
    ])
      expect(
        await validate(plainToInstance(SaveSendModeDto, body))
      ).not.toEqual([]);
    expect(
      await validate(
        plainToInstance(SaveSystemSendModeDto, {
          enabled: 'true',
          expectedRevision: 0,
          requestId: 'a',
        })
      )
    ).not.toEqual([]);
  });
  it('derives organization and actor from authenticated request context', async () => {
    const modes = { get: vi.fn(), save: vi.fn() };
    const controller = new SendModeController(modes as any);
    const body = {
      mode: 'AUTONOMOUS' as const,
      expectedOrganizationId: 'org',
      expectedUserId: 'user',
      expectedRevision: 0,
      requestId: 'a',
    };
    await controller.get({ id: 'org' } as any, { id: 'user' } as any);
    await controller.save({ id: 'org' } as any, { id: 'user' } as any, body);
    expect(modes.get).toHaveBeenCalledWith('org', 'user');
    expect(modes.save).toHaveBeenCalledWith('org', 'user', body);
    expect(Reflect.getMetadata('path', SendModeController)).toBe(
      '/sending/mode'
    );
    expect(Reflect.getMetadata('method', controller.get)).toBe(0);
    expect(Reflect.getMetadata('method', controller.save)).toBe(1);
  });
  it.each([SEND_MODE_SYSTEM_KEY, organizationSendModeKey('org')])(
    'blocks generic Settings service mutations for %s',
    async (key) => {
      const repository = { set: vi.fn(), delete: vi.fn() };
      const service = new SettingsService(repository as any);
      await expect(service.set(key, { enabled: true })).rejects.toThrow(
        'SEND_MODE_MANAGED_SEPARATELY'
      );
      await expect(service.delete(key)).rejects.toThrow(
        'SEND_MODE_MANAGED_SEPARATELY'
      );
      expect(repository.set).not.toHaveBeenCalled();
      expect(repository.delete).not.toHaveBeenCalled();
    }
  );
  it('routes typed administrator capability reads and writes through SendModeService', async () => {
    const modes = {
      getSystem: vi.fn().mockResolvedValue({ effectiveEnabled: true }),
      saveSystem: vi.fn(),
    };
    const controller = new AdminSettingsController(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      undefined,
      modes as any
    );
    expect(await controller.getSendModeCapability()).toEqual({
      effectiveEnabled: true,
    });
    const body = { enabled: true, expectedRevision: 0, requestId: 'a' };
    await controller.saveSendModeCapability({ id: 'super' } as any, body);
    await controller.putSendModeCapability({ id: 'super' } as any, body);
    expect(modes.saveSystem).toHaveBeenCalledWith('super', body);
  });
  it('rejects generic administrator writes and deletion of organization mode settings', async () => {
    const controller = new AdminSettingsController(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any
    );
    await expect(
      controller.upsertSetting(organizationSendModeKey('org'), {
        value: { mode: 'AUTONOMOUS' },
      } as any)
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      controller.deleteSetting(organizationSendModeKey('org'))
    ).rejects.toMatchObject({ status: 400 });
  });
  it('opens account-selection policy administration when capability is enabled by Settings', async () => {
    vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', undefined);
    try {
      const policy = {
        getSystem: vi.fn().mockResolvedValue({ mode: 'OPTIONAL', revision: 1 }),
      };
      const modes = {
        getSystem: vi.fn().mockResolvedValue({ effectiveEnabled: true }),
      };
      const controller = new AdminSettingsController(
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        policy as any,
        modes as any
      );
      expect(await controller.getSendPolicy()).toMatchObject({
        value: { mode: 'OPTIONAL' },
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
