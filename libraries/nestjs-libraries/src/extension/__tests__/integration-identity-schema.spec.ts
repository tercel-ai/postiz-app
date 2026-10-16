import { afterEach, describe, expect, it, vi } from 'vitest';
import { requiresLegacyIdentityKey } from '../integration-identity-schema';
afterEach(() => vi.unstubAllEnvs());
const scoped = [
  'organizationId',
  'providerIdentifier',
  'identityNamespace',
  'internalId',
];
describe('identity schema capability detection', () => {
  it('keeps compatibility when both actual unique indexes exist', async () => {
    vi.stubEnv('INTEGRATION_IDENTITY_CONTRACTED', 'true');
    const tx = {
      $queryRaw: vi
        .fn()
        .mockResolvedValue([
          { columns: scoped },
          { columns: ['organizationId', 'internalId'] },
        ]),
    };
    expect(await requiresLegacyIdentityKey(tx as any)).toBe(true);
  });
  it('uses the actual contracted schema without an environment override', async () => {
    const tx = {
      $queryRaw: vi
        .fn()
        .mockResolvedValue([{ columns: [...scoped].reverse() }]),
    };
    expect(await requiresLegacyIdentityKey(tx as any)).toBe(false);
  });
  it.each([
    [],
    [{ columns: ['organizationId', 'internalId'] }],
    [{ columns: [...scoped, 'extra'] }],
    null,
  ])('refuses unverified schema capabilities: %j', async (rows) => {
    await expect(
      requiresLegacyIdentityKey({
        $queryRaw: vi.fn().mockResolvedValue(rows),
      } as any)
    ).rejects.toThrow('ACCOUNT_IDENTITY_SCHEMA_NOT_READY');
  });
  it('fails closed on a catalog read failure', async () => {
    await expect(
      requiresLegacyIdentityKey({
        $queryRaw: vi.fn().mockRejectedValue(new Error('unavailable')),
      } as any)
    ).rejects.toThrow('ACCOUNT_IDENTITY_SCHEMA_UNVERIFIED');
  });
});
