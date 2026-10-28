import { afterEach, describe, expect, it, vi } from 'vitest';
import { IntegrationRepository } from '../integration.repository';
afterEach(() => vi.unstubAllEnvs());
function fixture() {
  const integration = {
    findFirst: vi.fn().mockResolvedValue(null),
    findMany: vi.fn().mockResolvedValue([]),
    upsert: vi.fn().mockResolvedValue({ id: 'legacy' }),
  };
  const repository = new IntegrationRepository(
    { model: { integration, $transaction: vi.fn(async work => work({ integration })) } } as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any
  );
  return { integration, repository };
}
describe('default-off legacy integration compatibility', () => {
  it('keeps the legacy OAuth upsert without requiring identity enrollment or new entitlements', async () => {
    vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', undefined);
    const { integration, repository } = fixture();
    expect(
      await repository.createOrUpdateIntegration(
        undefined,
        false,
        'org',
        'Alice',
        undefined,
        'social',
        '123',
        'x',
        'oauth',
        'refresh',
        0
      )
    ).toEqual({ id: 'legacy' });
    expect(integration.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          identityNamespace: 'legacy',
          internalId: '123',
          token: 'oauth',
        }),
      })
    );
  });
  it('keeps the old plugin handle-based channel creation path when the new mode is off', async () => {
    vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'false');
    const { integration, repository } = fixture();
    await repository.createOrUpdateIntegration(
      undefined,
      false,
      'org',
      'Alice',
      undefined,
      'social',
      'alice',
      'x',
      'alice',
      '',
      0
    );
    expect(integration.upsert.mock.calls[0][0].create.identityNamespace).toBe(
      'legacy'
    );
  });
});

import { memorySendDatabase } from '../../../../extension/__tests__/support/memory-send-database';
it('does not create a legacy alias for a previously normalized account when switched off', async () => {
  vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'false');
  const db = memorySendDatabase();
  db.seed('integration', {
    id: 'known',
    organizationId: 'org',
    providerIdentifier: 'x',
    identityNamespace: 'x.rest_id',
    internalId: '123',
    token: 'original',
  });
  db.seed('accountWriteState', {
    organizationId: 'org',
    integrationId: 'known',
    canonicalAccountKey: 'key',
    rolloutReady: true,
  });
  const repository = new IntegrationRepository(
    { model: db } as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any
  );
  const result = await repository.createOrUpdateIntegration(
    undefined,
    false,
    'org',
    'Alice',
    undefined,
    'social',
    '123',
    'x',
    'renewed',
    'refresh',
    3600
  );
  expect(result.id).toBe('known');
  expect(result.identityNamespace).toBe('x.rest_id');
  expect(db.rows('integration')).toHaveLength(1);
  expect(db.rows('accountWriteState')[0].integrationId).toBe('known');
});
