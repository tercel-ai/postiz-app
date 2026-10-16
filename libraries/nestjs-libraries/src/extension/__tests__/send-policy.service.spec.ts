import { describe, expect, it, vi } from 'vitest';
import {
  SendPolicyService,
  SEND_ACCOUNT_POLICY_KEY,
} from '../send-policy.service';
import { SettingsService } from '../../database/prisma/settings/settings.service';

function setup() {
  const db = {
    settings: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    user: { findUnique: vi.fn().mockResolvedValue({ isSuperAdmin: true }) },
    userOrganization: {
      findUnique: vi.fn().mockResolvedValue({ disabled: false }),
    },
    systemSendPolicyMutationReceipt: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
    },
    userSendPreference: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    sendMutationReceipt: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
    },
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation((work) => work(db));
  return { db, service: new SendPolicyService(db as any) };
}
const change = (
  mode: 'REQUIRED' | 'OPTIONAL',
  expectedRevision = 0,
  requestId = 'change'
) => ({ value: { mode }, expectedRevision, requestId });

describe('system account preselection policy', () => {
  it('defaults only absent settings to REQUIRED and fails closed on corrupt or unavailable policy', async () => {
    const { service, db } = setup();
    expect(await service.getSystem()).toEqual({
      mode: 'REQUIRED',
      revision: 0,
      lastRequiredRevision: 0,
    });
    for (const value of [
      null,
      'OPTIONAL',
      { mode: 'OPTIONAL' },
      { mode: 'OTHER', revision: 1, lastRequiredRevision: 0 },
      { mode: 'OPTIONAL', revision: 1, lastRequiredRevision: 2 },
    ]) {
      db.settings.findUnique.mockResolvedValue({ value });
      await expect(service.getSystem()).rejects.toThrow('SEND_POLICY_INVALID');
    }
    db.settings.findUnique.mockRejectedValue(new Error('offline'));
    await expect(service.getSystem()).rejects.toThrow('offline');
  });
  it('allows only the platform superadmin to save the global policy', async () => {
    const { service, db } = setup();
    db.user.findUnique.mockResolvedValue({ isSuperAdmin: false });
    await expect(
      service.saveSystem('user', change('OPTIONAL'))
    ).rejects.toMatchObject({ status: 403 });
    expect(db.settings.create).not.toHaveBeenCalled();
  });
  it('retains a durable tightening barrier after REQUIRED then OPTIONAL', async () => {
    const { service, db } = setup();
    const initial = await service.saveSystem('admin', change('OPTIONAL'));
    expect(initial.value).toEqual({
      mode: 'OPTIONAL',
      revision: 1,
      lastRequiredRevision: 0,
    });
    db.settings.findUnique.mockResolvedValue({ value: initial.value });
    const tightened = await service.saveSystem(
      'admin',
      change('REQUIRED', 1, 'tighten')
    );
    expect(tightened.value.lastRequiredRevision).toBe(2);
    db.settings.findUnique.mockResolvedValue({ value: tightened.value });
    const relaxed = await service.saveSystem(
      'admin',
      change('OPTIONAL', 2, 'relax')
    );
    expect(relaxed.value).toEqual({
      mode: 'OPTIONAL',
      revision: 3,
      lastRequiredRevision: 2,
    });
    expect(
      service.requiresPreselection(
        { policyRevision: 1, requirePreselectedAccount: false },
        relaxed.value
      )
    ).toBe(true);
    expect(
      service.requiresPreselection(
        { policyRevision: 3, requirePreselectedAccount: false },
        relaxed.value
      )
    ).toBe(false);
    expect(
      service.requiresPreselection(
        { policyRevision: 3, requirePreselectedAccount: true },
        relaxed.value
      )
    ).toBe(true);
  });
  it('replays the same mutation before stale revision checks and rejects altered payloads', async () => {
    const { service, db } = setup();
    const result = await service.saveSystem('admin', change('OPTIONAL'));
    const receipt =
      db.systemSendPolicyMutationReceipt.create.mock.calls[0][0].data;
    db.systemSendPolicyMutationReceipt.findUnique.mockResolvedValue(receipt);
    db.settings.findUnique.mockResolvedValue({
      value: { ...result.value, revision: 9 },
    });
    expect(await service.saveSystem('admin', change('OPTIONAL'))).toEqual(
      result
    );
    await expect(
      service.saveSystem('admin', change('REQUIRED'))
    ).rejects.toMatchObject({ status: 409 });
    expect(db.settings.create).toHaveBeenCalledTimes(1);
  });
  it('rejects invalid mutations, stale versions and lost CAS without a receipt', async () => {
    const { service, db } = setup();
    for (const body of [
      change('OPTIONAL', -1),
      change('OPTIONAL', 0, ''),
      { ...change('OPTIONAL'), value: { mode: 'OPTIONAL', revision: 99 } },
    ])
      await expect(
        service.saveSystem('admin', body as any)
      ).rejects.toMatchObject({ status: 400 });
    db.settings.findUnique.mockResolvedValue({
      value: { mode: 'OPTIONAL', revision: 1, lastRequiredRevision: 0 },
    });
    await expect(
      service.saveSystem('admin', change('REQUIRED'))
    ).rejects.toMatchObject({ status: 409 });
    db.settings.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      service.saveSystem('admin', change('REQUIRED', 1))
    ).rejects.toMatchObject({ status: 409 });
    expect(db.systemSendPolicyMutationReceipt.create).not.toHaveBeenCalled();
  });
  it('blocks the reserved key through the generic Settings write and delete services', async () => {
    const repo = { set: vi.fn(), delete: vi.fn() };
    const service = new SettingsService(repo as any);
    await expect(
      service.set(SEND_ACCOUNT_POLICY_KEY, { mode: 'OPTIONAL' })
    ).rejects.toThrow('SEND_POLICY_MANAGED_SEPARATELY');
    await expect(service.delete(SEND_ACCOUNT_POLICY_KEY)).rejects.toThrow(
      'SEND_POLICY_MANAGED_SEPARATELY'
    );
    await service.set('unrelated', true);
    await service.delete('unrelated');
    expect(repo.set).toHaveBeenCalledTimes(1);
    expect(repo.delete).toHaveBeenCalledTimes(1);
  });
  it('takes a policy coordination write lock without changing policy versions or audit timestamps', async () => {
    const { service, db } = setup();
    const updatedAt = new Date('2026-10-15T00:00:00Z');
    const value = { mode: 'OPTIONAL', revision: 3, lastRequiredRevision: 2 };
    db.settings.findUnique.mockResolvedValue({ value, updatedAt });
    expect(await service.lockSystemInTransaction(db as any)).toEqual(value);
    expect(db.settings.updateMany).toHaveBeenCalledWith({
      where: { key: SEND_ACCOUNT_POLICY_KEY, value: { equals: value } },
      data: { value, updatedAt },
    });
    db.settings.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.lockSystemInTransaction(db as any)).rejects.toThrow(
      'SEND_POLICY_CHANGED'
    );
    db.settings.findUnique.mockResolvedValue(null);
    expect(await service.lockSystemInTransaction(db as any)).toMatchObject({
      mode: 'REQUIRED',
    });
  });
  it('rejects corrupt tightening history and does not accept a task from an unseen future policy', async () => {
    const { service, db } = setup();
    for (const value of [
      { mode: 'REQUIRED', revision: 0, lastRequiredRevision: 0 },
      { mode: 'REQUIRED', revision: 3, lastRequiredRevision: 1 },
    ]) {
      db.settings.findUnique.mockResolvedValue({ value });
      await expect(service.getSystem()).rejects.toThrow('SEND_POLICY_INVALID');
    }
    const current = {
      mode: 'OPTIONAL' as const,
      revision: 3,
      lastRequiredRevision: 2,
    };
    expect(
      service.requiresPreselection(
        { policyRevision: 4, requirePreselectedAccount: false },
        current
      )
    ).toBe(true);
    expect(
      service.requiresPreselection(
        { policyRevision: -1, requirePreselectedAccount: false },
        current
      )
    ).toBe(true);
    expect(
      service.requiresPreselection(
        { policyRevision: 3, requirePreselectedAccount: false },
        { ...current, mode: 'REQUIRED' }
      )
    ).toBe(true);
  });
  it('keeps the maximum stored revision readable and rejects overflow on the next mutation', async () => {
    const { service, db } = setup();
    const previous = {
      mode: 'OPTIONAL',
      revision: 2147483646,
      lastRequiredRevision: 2,
    };
    db.settings.findUnique.mockResolvedValue({ value: previous });
    const result = await service.saveSystem(
      'admin',
      change('OPTIONAL', 2147483646)
    );
    db.settings.findUnique.mockResolvedValue({ value: result.value });
    expect((await service.getSystem()).revision).toBe(2147483647);
    await expect(
      service.saveSystem('admin', change('OPTIONAL', 2147483647))
    ).rejects.toMatchObject({ status: 400 });
  });
  it('retries serialization conflicts while preserving infrastructure failures', async () => {
    const { service, db } = setup();
    const work = db.$transaction.getMockImplementation()!;
    db.$transaction
      .mockRejectedValueOnce({ code: 'P2034' })
      .mockImplementation(work);
    await service.saveSystem('admin', change('OPTIONAL'));
    expect(db.$transaction).toHaveBeenCalledTimes(2);
    db.$transaction.mockRejectedValueOnce(new Error('offline'));
    await expect(
      service.saveSystem('admin', change('OPTIONAL'))
    ).rejects.toThrow('offline');
  });
});

describe('personal sending preference', () => {
  it('inherits system requirements and can only increase OPTIONAL', async () => {
    const { service, db } = setup();
    expect(await service.getPreferences('user')).toMatchObject({
      requirePreselectedAccount: null,
      revision: 0,
      effectiveRequirePreselectedAccount: true,
    });
    db.settings.findUnique.mockResolvedValue({
      value: { mode: 'OPTIONAL', revision: 1, lastRequiredRevision: 0 },
    });
    db.userSendPreference.findUnique.mockResolvedValue({
      requirePreselectedAccount: true,
      revision: 2,
    });
    expect(await service.getPreferences('user')).toMatchObject({
      effectiveRequirePreselectedAccount: true,
      policyRevision: 1,
    });
    db.userSendPreference.findUnique.mockResolvedValue({
      requirePreselectedAccount: false,
      revision: 2,
    });
    expect(await service.getPreferences('user')).toMatchObject({
      effectiveRequirePreselectedAccount: false,
    });
    db.settings.findUnique.mockResolvedValue(null);
    expect(await service.getPreferences('user')).toMatchObject({
      effectiveRequirePreselectedAccount: true,
    });
  });
  it('saves only the authenticated user preference and keeps a clear tombstone', async () => {
    const { service, db } = setup();
    const body = {
      requirePreselectedAccount: true,
      expectedRevision: 0,
      requestId: 'save',
    };
    expect(await service.savePreferences('org', 'user', body)).toEqual({
      requirePreselectedAccount: true,
      revision: 1,
    });
    expect(db.userSendPreference.create).toHaveBeenCalledWith({
      data: { userId: 'user', requirePreselectedAccount: true, revision: 1 },
    });
    db.userSendPreference.findUnique.mockResolvedValue({
      requirePreselectedAccount: true,
      revision: 1,
    });
    await service.savePreferences('org', 'user', {
      requirePreselectedAccount: null,
      expectedRevision: 1,
      requestId: 'clear',
    });
    expect(db.userSendPreference.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user', revision: 1 },
      data: { requirePreselectedAccount: null, revision: { increment: 1 } },
    });
    expect(db.user.findUnique).not.toHaveBeenCalled();
  });
  it('replays preference changes and refuses invalid values, nonmembers and conflicting revisions', async () => {
    const { service, db } = setup();
    const body = {
      requirePreselectedAccount: true,
      expectedRevision: 0,
      requestId: 'save',
    };
    const result = await service.savePreferences('org', 'user', body);
    db.sendMutationReceipt.findUnique.mockResolvedValue(
      db.sendMutationReceipt.create.mock.calls[0][0].data
    );
    expect(await service.savePreferences('org', 'user', body)).toEqual(result);
    await expect(
      service.savePreferences('org', 'user', {
        ...body,
        requirePreselectedAccount: false,
      })
    ).rejects.toMatchObject({ status: 409 });
    db.sendMutationReceipt.findUnique.mockResolvedValue(null);
    await expect(
      service.savePreferences('org', 'user', {
        ...body,
        requirePreselectedAccount: undefined,
      } as any)
    ).rejects.toMatchObject({ status: 400 });
    db.userOrganization.findUnique.mockResolvedValue(null);
    await expect(
      service.savePreferences('org', 'user', body)
    ).rejects.toMatchObject({ status: 403 });
    db.userOrganization.findUnique.mockResolvedValue({ disabled: false });
    db.userSendPreference.findUnique.mockResolvedValue({ revision: 2 });
    await expect(
      service.savePreferences('org', 'user', body)
    ).rejects.toMatchObject({ status: 409 });
  });
  it('builds snapshots only from the trusted owner and retains the stronger requirement', async () => {
    const { service, db } = setup();
    db.settings.findUnique.mockResolvedValue({
      value: { mode: 'OPTIONAL', revision: 3, lastRequiredRevision: 2 },
    });
    db.userSendPreference.findUnique.mockResolvedValue({
      requirePreselectedAccount: true,
      revision: 4,
    });
    expect(await service.snapshotInTransaction(db as any, 'owner')).toEqual({
      policyRevision: 3,
      requirePreselectedAccount: true,
      preferenceRevision: 4,
      policyOwnerUserId: 'owner',
    });
    expect(db.userSendPreference.findUnique).toHaveBeenCalledWith({
      where: { userId: 'owner' },
    });
    db.userSendPreference.findUnique.mockClear();
    expect(await service.snapshotInTransaction(db as any)).toEqual({
      policyRevision: 3,
      requirePreselectedAccount: false,
      preferenceRevision: 0,
      policyOwnerUserId: null,
    });
    expect(db.userSendPreference.findUnique).not.toHaveBeenCalled();
    db.settings.findUnique.mockResolvedValue(null);
    db.userSendPreference.findUnique.mockResolvedValue({
      requirePreselectedAccount: false,
      revision: 4,
    });
    expect(
      await service.snapshotInTransaction(db as any, 'owner')
    ).toMatchObject({ requirePreselectedAccount: true });
  });
  it('rejects anonymous preferences and a lost update CAS without saving a receipt', async () => {
    const { service, db } = setup();
    const body = {
      requirePreselectedAccount: false,
      expectedRevision: 1,
      requestId: 'save',
    };
    await expect(service.getPreferences('')).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      service.savePreferences('org', '', body)
    ).rejects.toMatchObject({ status: 403 });
    db.userSendPreference.findUnique.mockResolvedValue({ revision: 1 });
    db.userSendPreference.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.savePreferences('org', 'user', body)).rejects.toThrow(
      'SEND_PREFERENCE_REVISION_CONFLICT'
    );
    expect(db.sendMutationReceipt.create).not.toHaveBeenCalled();
  });
});
