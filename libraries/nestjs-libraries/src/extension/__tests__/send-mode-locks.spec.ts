import { afterEach, expect, it, vi } from 'vitest';
import { SendModeService, SEND_MODE_SYSTEM_KEY, organizationSendModeKey } from '../send-mode.service';
import { memorySendDatabase } from './support/memory-send-database';
import { sendTransaction } from '../send-coordination.utils';

afterEach(() => vi.unstubAllEnvs());

it('uses shared mode locks without rewriting Settings for independent send guards', async () => {
  vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'true');
  const db = memorySendDatabase();
  const modes = new SendModeService(db);
  db.seed('settings', { key: SEND_MODE_SYSTEM_KEY, value: { enabled: true, revision: 1 } });
  for (const org of ['a', 'b'])
    db.seed('settings', { key: organizationSendModeKey(org), value: { mode: 'CONTROLLED', revision: 1 } });
  const before = structuredClone(db.rows('settings'));
  const query = vi.spyOn(db, '$queryRaw');
  const summary = vi.spyOn(modes, 'stateIn');
  await Promise.all(Array.from({ length: 16 }, (_, i) => modes.assertControlledIn(db, i % 2 ? 'a' : 'b')));
  expect(db.rows('settings')).toEqual(before);
  expect(query).toHaveBeenCalledTimes(32);
  expect(summary).not.toHaveBeenCalled();
  expect(query.mock.calls.every(([parts]) => parts.join('?').endsWith('FOR SHARE'))).toBe(true);
});

it('takes shared system and exclusive organization locks before changing a mode', async () => {
  vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'true');
  const db = memorySendDatabase();
  db.seed('userOrganization', { organizationId: 'org', userId: 'admin', role: 'ADMIN', disabled: false });
  const modes = new SendModeService(db);
  const query = vi.spyOn(db, '$queryRaw');
  await modes.save('org', 'admin', { mode: 'CONTROLLED', expectedRevision: 0,
    expectedOrganizationId: 'org', expectedUserId: 'admin', requestId: 'switch' });
  expect(query.mock.calls.slice(0, 2).map(([parts, key]) => [key, parts.join('?').split(' FOR ')[1]]))
    .toEqual([[SEND_MODE_SYSTEM_KEY, 'SHARE'], [organizationSendModeKey('org'), 'UPDATE']]);
});

it('takes the exclusive system lock before disabling controlled sends', async () => {
  const db = memorySendDatabase();
  db.seed('user', { id: 'super', isSuperAdmin: true });
  const query = vi.spyOn(db, '$queryRaw');
  await new SendModeService(db).saveSystem('super', { enabled: false, expectedRevision: 0, requestId: 'disable' });
  expect(query.mock.calls[0][0].join('?')).toMatch(/FOR UPDATE$/);
  expect(query.mock.calls[0][1]).toBe(SEND_MODE_SYSTEM_KEY);
});

it('creates missing sentinels only once and preserves unconfigured mode semantics', async () => {
  const db = memorySendDatabase();
  const modes = new SendModeService(db);
  const first = await modes.lockIn(db, 'org');
  const before = structuredClone(db.rows('settings'));
  await modes.lockIn(db, 'org');
  expect(first).toMatchObject({ configuredMode: null, revision: 0, mode: 'AUTONOMOUS' });
  expect(db.rows('settings')).toEqual(before);
  expect(before).toHaveLength(2);
  expect(before.every(row => row.value === null)).toBe(true);
});

it('uses locked mode metadata for controlled drafts without organization-wide statistics', async () => {
  vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'true');
  const db = memorySendDatabase();
  db.seed('settings', { key: organizationSendModeKey('org'), value: { mode: 'CONTROLLED', revision: 2 } });
  const modes = new SendModeService(db);
  const summary = vi.spyOn(modes, 'stateIn');
  expect(await modes.lockModeIn(db, 'org')).toMatchObject({ mode: 'CONTROLLED', configuredMode: 'CONTROLLED',
    revision: 2, autonomousAllowed: false, transition: null, legacyDrain: null });
  vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'false');
  expect(await modes.lockModeIn(db, 'org')).toMatchObject({ mode: 'PAUSED', autonomousAllowed: false });
  expect(summary).not.toHaveBeenCalled();
  await expect(modes.assertControlledIn(db, 'org')).rejects.toThrow('SEND_MODE_CONTROLLED_REQUIRED');
});

it('retains actual controlled obligations when checking autonomous eligibility', async () => {
  const db = memorySendDatabase();
  db.seed('settings', { key: organizationSendModeKey('org'), value: { mode: 'AUTONOMOUS', revision: 2 } });
  db.seed('sendIntent', { organizationId: 'org', status: 'RECONCILING' });
  const modes = new SendModeService(db);
  const summary = vi.spyOn(modes, 'stateIn');
  expect(await modes.lockModeIn(db, 'org')).toMatchObject({ mode: 'PAUSED', autonomousAllowed: false });
  expect(summary).toHaveBeenCalledOnce();
  await expect(modes.assertAutonomousIn(db, 'org')).rejects.toThrow('SEND_MODE_AUTONOMOUS_REQUIRED');
});

it('still validates reallocation metadata without reading dashboard counts', async () => {
  const db: any = memorySendDatabase();
  db.seed('settings', { key: organizationSendModeKey('org'), value: {
    mode: 'CONTROLLED', revision: 2, reallocation: { version: 99 },
  } });
  const modes = new SendModeService(db);
  const summary = vi.spyOn(modes, 'stateIn');
  await expect(modes.lockModeIn(db, 'org')).rejects.toThrow('SEND_MODE_REALLOCATION_INVALID');
  expect(summary).not.toHaveBeenCalled();
});

it.each(['40001', '40P01'])('retries a raw-query lock conflict with SQLSTATE %s', async code => {
  vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'true');
  const db = memorySendDatabase();
  db.seed('settings', { key: organizationSendModeKey('org'), value: { mode: 'CONTROLLED', revision: 1 } });
  const query = vi.spyOn(db, '$queryRaw').mockRejectedValueOnce({ code: 'P2010', meta: { code } });
  await expect(sendTransaction(db, tx => new SendModeService(db).assertControlledIn(tx, 'org'),
    { backoffOnConflict: true })).resolves.toMatchObject({ mode: 'CONTROLLED' });
  expect(query).toHaveBeenCalledTimes(3);
});

it('does not turn unrelated raw database failures into retryable lock conflicts', async () => {
  const db = memorySendDatabase();
  const error = { code: 'P2010', meta: { code: '42P01' } };
  const query = vi.spyOn(db, '$queryRaw').mockRejectedValue(error);
  await expect(sendTransaction(db, tx => new SendModeService(db).assertControlledIn(tx, 'org'))).rejects.toBe(error);
  expect(query).toHaveBeenCalledOnce();
});
