import { describe, expect, it, vi } from 'vitest';
import {
  LEGACY_IDENTITY_RECONCILIATION_PREFIX,
  LegacyIdentityReconciliationService,
  planLegacyIdentity,
} from '../legacy-identity-reconciliation.service';
import { organizationSendModeKey } from '../send-mode.service';
import { memorySendDatabase } from './support/memory-send-database';

function fixture() {
  const db = memorySendDatabase();
  db.seed('userOrganization', {
    organizationId: 'org',
    userId: 'admin',
    role: 'ADMIN',
    disabled: false,
  });
  const integrations = { verifyStableIdentity: vi.fn() };
  return {
    db,
    integrations,
    service: new LegacyIdentityReconciliationService(
      db as any,
      integrations as any
    ),
  };
}

describe('legacy identity reconciliation planning', () => {
  it('uses OAuth verification only when both provider support and credentials exist', () => {
    expect(
      planLegacyIdentity({ providerIdentifier: 'x', token: 'token' })
    ).toEqual({
      action: 'VERIFY_OAUTH',
      reason: null,
    });
    expect(
      planLegacyIdentity({ providerIdentifier: 'medium', token: 'token' })
    ).toEqual({
      action: 'WAIT_FOR_SESSION',
      reason: 'OAUTH_VERIFICATION_UNAVAILABLE',
    });
    expect(
      planLegacyIdentity({ providerIdentifier: 'reddit', token: '' })
    ).toEqual({
      action: 'WAIT_FOR_SESSION',
      reason: 'OAUTH_CREDENTIAL_MISSING',
    });
  });
});

describe('legacy identity reconciliation execution', () => {
  it('routes eligible rows through the protected verifier and isolates per-account failures', async () => {
    const f = fixture();
    for (const row of [
      { id: 'x', providerIdentifier: 'x', token: 'token' },
      { id: 'reddit', providerIdentifier: 'reddit', token: 'token' },
      { id: 'medium', providerIdentifier: 'medium', token: '' },
    ]) {
      f.db.seed('integration', {
        ...row,
        organizationId: 'org',
        identityNamespace: 'legacy',
        internalId: row.id,
      });
    }
    f.integrations.verifyStableIdentity.mockImplementation(
      async (_org: string, _user: string, id: string) => {
        if (id === 'reddit') throw new Error('ACCOUNT_IDENTITY_MISMATCH');
      }
    );

    const result = await f.service.reconcileOrganization('org', 'admin');

    expect(result).toMatchObject({
      inspected: 3,
      fixed: 1,
      waitingForSession: 1,
      failed: 1,
    });
    expect(f.integrations.verifyStableIdentity).toHaveBeenCalledTimes(2);
    expect(result.results).toContainEqual({
      integrationId: 'reddit',
      provider: 'reddit',
      status: 'FAILED',
      code: 'ACCOUNT_IDENTITY_MISMATCH',
    });
  });

  it('never invokes remote verification in preview mode', async () => {
    const f = fixture();
    f.db.seed('integration', {
      id: 'x',
      organizationId: 'org',
      providerIdentifier: 'x',
      identityNamespace: 'legacy',
      internalId: '123',
      token: 'token',
    });

    const result = await f.service.reconcileOrganization('org', 'admin', false);

    expect(f.integrations.verifyStableIdentity).not.toHaveBeenCalled();
    expect(result.results[0]).toMatchObject({
      status: 'WAIT_FOR_SESSION',
      code: 'DRY_RUN_OAUTH_VERIFICATION_REQUIRED',
    });
  });

  it('processes each controlled-mode revision once and stores a durable receipt', async () => {
    const f = fixture();
    f.db.seed('settings', {
      key: organizationSendModeKey('org'),
      value: { mode: 'CONTROLLED', revision: 4 },
    });
    f.db.seed('integration', {
      id: 'x',
      organizationId: 'org',
      providerIdentifier: 'x',
      identityNamespace: 'legacy',
      internalId: '123',
      token: 'token',
    });

    expect(
      await f.service.reconcilePendingControlledOrganizations()
    ).toHaveLength(1);
    expect(await f.service.reconcilePendingControlledOrganizations()).toEqual(
      []
    );
    expect(f.integrations.verifyStableIdentity).toHaveBeenCalledTimes(1);
    expect(
      f.db
        .rows('settings')
        .find(
          (row) => row.key === `${LEGACY_IDENTITY_RECONCILIATION_PREFIX}org`
        )?.value
    ).toMatchObject({ modeRevision: 4 });
  });

  it('backs off failed OAuth probes and retries only after the durable deadline', async () => {
    const f = fixture();
    f.db.seed('settings', {
      key: organizationSendModeKey('org'),
      value: { mode: 'CONTROLLED', revision: 5 },
    });
    f.db.seed('integration', {
      id: 'x',
      organizationId: 'org',
      providerIdentifier: 'x',
      identityNamespace: 'legacy',
      internalId: '123',
      token: 'token',
    });
    f.integrations.verifyStableIdentity.mockRejectedValue(
      new Error('ACCOUNT_IDENTITY_VERIFICATION_FAILED')
    );

    expect(
      await f.service.reconcilePendingControlledOrganizations()
    ).toHaveLength(1);
    expect(await f.service.reconcilePendingControlledOrganizations()).toEqual(
      []
    );
    const receipt = f.db
      .rows('settings')
      .find((row) => row.key === `${LEGACY_IDENTITY_RECONCILIATION_PREFIX}org`);
    expect(receipt.value).toMatchObject({
      modeRevision: 5,
      status: 'RETRY_PENDING',
      attempts: 1,
    });
    receipt.value.nextAttemptAt = new Date(Date.now() - 1).toISOString();

    expect(
      await f.service.reconcilePendingControlledOrganizations()
    ).toHaveLength(1);
    expect(f.integrations.verifyStableIdentity).toHaveBeenCalledTimes(2);
    expect(receipt.value.attempts).toBe(2);
  });
});
