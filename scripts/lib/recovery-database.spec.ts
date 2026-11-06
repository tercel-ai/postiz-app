import { afterEach, expect, it, vi } from 'vitest';
import { recoveryDatabase } from './recovery-database';
afterEach(() => vi.unstubAllEnvs());
it('derives production targets while retaining explicit verification and connection binding', () => {
  vi.stubEnv('DATABASE_URL', 'postgresql://user:secret@production/postiz%20production?schema=tenant');
  expect(recoveryDatabase(true).target).toEqual({
    host: 'production', port: '5432', database: 'postiz production', schema: 'tenant',
  });
});
it('requires explicit database verification before reading configuration', () => {
  expect(() => recoveryDatabase(false)).toThrow('VERIFY_ACTUAL_DATABASE');
});
it('rejects an unnamed database', () => {
  vi.stubEnv('DATABASE_URL', 'postgresql://user:secret@localhost/');
  expect(() => recoveryDatabase(true)).toThrow('DATABASE_URL');
});
it('binds recovery plans to the connection target without retaining credentials in the fingerprint', () => {
  vi.stubEnv('DATABASE_URL', 'postgresql://user:secret@localhost/aisee_postiz_dev');
  const first = recoveryDatabase(true);
  vi.stubEnv('DATABASE_URL', 'postgresql://user:changed@localhost/aisee_postiz_dev');
  expect(recoveryDatabase(true).fingerprint).toBe(first.fingerprint);
  vi.stubEnv('DATABASE_URL', 'postgresql://user:secret@other-host/aisee_postiz_dev');
  expect(recoveryDatabase(true).fingerprint).not.toBe(first.fingerprint);
  expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
});
