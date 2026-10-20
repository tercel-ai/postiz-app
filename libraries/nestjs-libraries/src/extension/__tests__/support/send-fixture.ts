import { vi } from 'vitest';
import { SendCoordinatorService } from '../../send-coordinator.service';
import { SendQuotaService } from '../../send-quota.service';
import { memorySendDatabase } from './memory-send-database';
export const sendNow = new Date('2026-10-15T12:00:00Z');
export const actor = {
  id: 'account',
  organizationId: 'org',
  providerIdentifier: 'x',
  internalId: '123',
  identityNamespace: 'x.rest_id',
  profile: 'alice',
  disabled: false,
  deletedAt: null,
  inBetweenSteps: false,
  token: 'oauth',
};
export function setupSend() {
  const now = sendNow;
  const db = memorySendDatabase();
  db.seed('integration', actor);
  db.seed('userOrganization', {
    organizationId: 'org',
    userId: 'user',
    disabled: false,
  });
  db.seed('integrationProject', {
    id: 'rel',
    organizationId: 'org',
    projectId: 'project',
    integrationId: 'account',
    disabled: false,
    engageEnabled: true,
  });
  db.seed('accountWriteState', {
    id: 'account-key',
    organizationId: 'org',
    canonicalAccountKey: 'account-key',
    integrationId: 'account',
    rolloutReady: true,
    revision: 0,
    activeExecutionId: null,
    nextWriteNotBefore: null,
    firstConfirmedAt: null,
  });
  const projects = {
    assertProjectActive: vi.fn(),
    assertProjectAccess: vi.fn(),
    getActivationVerdict: vi.fn().mockResolvedValue('active'),
  };
  const bindings = {
    resolveForEnqueueInTransaction: vi
      .fn()
      .mockResolvedValue({
        integrationId: 'account',
        providerIdentifier: 'x',
        bindingSource: 'EXPLICIT',
        bindingRevision: null,
        canonicalAccountKey: 'account-key',
        targetAccount: { id: '123', idNamespace: 'x.rest_id', handle: 'alice' },
      }),
  };
  const policies = {
    snapshotInTransaction: vi
      .fn()
      .mockResolvedValue({
        policyRevision: 0,
        requirePreselectedAccount: true,
        preferenceRevision: 0,
        policyOwnerUserId: 'user',
      }),
    getSystem: vi
      .fn()
      .mockResolvedValue({
        mode: 'REQUIRED',
        revision: 0,
        lastRequiredRevision: 0,
      }),
    requiresPreselection: vi.fn().mockReturnValue(true),
  };
  const quotas = new SendQuotaService();
  vi.spyOn(quotas, 'resolve').mockResolvedValue({
    gapMs: 60_000,
    budgets: [
      {
        key: 'shared-project',
        scope: 'PROJECT',
        dimension: 'ROOT_SENDS',
        limit: 1,
        units: 1,
        windowStart: new Date('2026-10-15T00:00:00Z'),
        windowEnd: new Date('2026-10-16T00:00:00Z'),
        timezone: 'UTC',
        policyVersion: 'test',
      },
    ],
  });
  const service = new SendCoordinatorService(
    db as any,
    bindings as any,
    policies as any,
    projects as any,
    quotas
  );
  const create = async (
    id = 'root',
    method: 'API' | 'EXTENSION' = 'API',
    contentUnitId?: string
  ) => {
    db.seed('post', {
      id,
      organizationId: 'org',
      projectId: 'project',
      parentPostId: null,
      group: id,
      providerIdentifier: 'x',
      integrationId: 'account',
      accountSelectionMode: 'EXPLICIT',
      routeRevision: 0,
      contentRevision: 1,
      state: 'DRAFT',
      content: 'hello',
      settings: '{}',
      image: '[]',
      publishDate: now,
      releaseId: null,
      releaseURL: null,
      deletedAt: null,
      publishMethod: method,
      source: 'calendar',
      ...(contentUnitId ? { contentUnitId } : {}),
    });
    return service.enqueue('org', id, {
      userId: 'user',
      origin: 'MANUAL',
      now,
    });
  };
  return { db, service, create, bindings, quotas, policies, projects };
}
