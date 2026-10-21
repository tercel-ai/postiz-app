import { PostsRepository } from '../../database/prisma/posts/posts.repository';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SendModeService } from '../send-mode.service';
import { setupSend } from './support/send-fixture';

describe('organization sending mode authorization', () => {
  beforeEach(() => vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'true'));
  afterEach(() => vi.unstubAllEnvs());
  it('rejects enqueue for an autonomous organization even with the global capability enabled', async () => {
    const { db, create } = setupSend();
    await db.settings.updateMany({ where: { key: 'sending.organization_mode:org' }, data: { value: { mode: 'AUTONOMOUS', revision: 1 } } });
    await expect(create()).rejects.toThrow('SEND_MODE_CONTROLLED_REQUIRED');
    expect(db.rows('sendIntent')).toHaveLength(0);
  });
  it('rejects a reserve after a safe downgrade and leaves quota unchanged', async () => {
    const { db, service, create } = setupSend();
    await create();
    const modes = new SendModeService(db as any);
    vi.spyOn(modes, 'assertControlledIn').mockRejectedValue(new Error('SEND_MODE_CONTROLLED_REQUIRED'));
    (service as any).modes = modes;
    await expect(service.reserveApi('org', 'root', 'worker')).rejects.toThrow('SEND_MODE_CONTROLLED_REQUIRED');
    expect(db.rows('sendQuotaReservation')).toHaveLength(0);
    expect(db.rows('sendExecution')).toHaveLength(0);
  });
  it('allows fresh autonomous content after explicit safe downgrade while retaining controlled root protection', async () => {
    const { db, service } = setupSend();
    await db.settings.updateMany({ where: { key: 'sending.organization_mode:org' }, data: { value: { mode: 'AUTONOMOUS', revision: 2 } } });
    await expect(service.assertLegacyAccount('org', 'account')).resolves.toBeUndefined();
    expect(await service.legacyBlockedPlatforms('org')).toEqual([]);
    await expect(service.assertLegacyPosts('org', [{ id: 'old', sendIntentId: 'intent' }])).rejects.toThrow('SEND_COORDINATOR_REQUIRED');
    await expect(service.assertLegacyPosts('org', [{ id: 'old-v1', executionProtocol: 'ACCOUNT_BOUND_V1' }])).rejects.toThrow('SEND_COORDINATOR_REQUIRED');
  });
  it('denies autonomous due claims inside the transaction before a controlled organization can receive a legacy lease', async () => {
    const { db } = setupSend();
    const repository = new PostsRepository({ model: db } as any, {} as any, {} as any,
      {} as any, {} as any, {} as any, { model: db } as any, new SendModeService(db as any));
    db.seed('post', { id: 'legacy', organizationId: 'org', state: 'QUEUE', executionProtocol: 'LEGACY',
      parentPostId: null, source: 'calendar', intervalInDays: null, settings: '{}',
      publishMethod: 'EXTENSION', providerIdentifier: 'x', publishDate: new Date('2026-01-01') });
    await expect(repository.claimDueExtensionPublishPosts('org', ['x'], new Date(), 1, 'lease', new Date(0)))
      .resolves.toEqual([]);
    expect(db.rows('post')[0].releaseId).toBeNull();
  });
  it('keeps controlled failures outside autonomous retry even after explicit downgrade', async () => {
    const { db } = setupSend();
    await db.settings.updateMany({ where: { key: 'sending.organization_mode:org' }, data: { value: { mode: 'AUTONOMOUS', revision: 2 } } });
    const repository = new PostsRepository({ model: db } as any, {} as any, {} as any,
      {} as any, {} as any, {} as any, { model: db } as any, new SendModeService(db as any));
    db.seed('post', { id: 'controlled-failure', organizationId: 'org', state: 'ERROR', executionProtocol: 'ACCOUNT_BOUND_V1' });
    expect(await repository.resetPostForRetry('controlled-failure', 'org')).toBe(false);
    expect(db.rows('post')[0].state).toBe('ERROR');
  });

});
