import { AutomationService } from '../../automation/automation.service';
import { EngageService } from '../../engage/engage.service';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutomaticSendProducerService } from '../automatic-send-producer.service';
import { memorySendDatabase } from './support/memory-send-database';
beforeEach(() => vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'true'));
afterEach(() => vi.unstubAllEnvs());
function setup() {
 const db = memorySendDatabase(); db.seed('userOrganization', { userId: 'owner', organizationId: 'org', disabled: false });
 const sends = { enqueue: vi.fn().mockResolvedValue({ id: 'root', providerIdentifier: 'x', publishMethod: 'EXTENSION' }), retry: vi.fn(), assertProjectSendActive: vi.fn() };
 const posts = { startWorkflow: vi.fn() };
 return { db, sends, posts, service: new AutomaticSendProducerService(db as any, sends as any, posts as any) };
}
describe('automatic producers use a persisted policy owner', () => {
 it('records only an authenticated organization member and resolves it for generation', async () => {
  const { service } = setup(); await expect(service.saveOwner('org', 'project', 'REPLY', 'intruder')).rejects.toThrow('SEND_POLICY_OWNER_UNAVAILABLE');
  await service.saveOwner('org', 'project', 'REPLY', 'owner'); expect(await service.owner('org', 'project', 'REPLY')).toBe('owner');
 });
 it('queues the saved reply with AUTOMATION origin and the configured owner', async () => {
  const { service, sends } = setup(); await service.saveOwner('org', 'project', 'REPLY', 'owner');
  await service.enqueue('org', 'project', 'root', 'REPLY');
  expect(sends.enqueue).toHaveBeenCalledWith('org', 'root', expect.objectContaining({ userId: 'owner', origin: 'AUTOMATION', action: 'REPLY', publishMethod: 'EXTENSION' }));
 });
 it('does not guess an owner after configuration loss or membership revocation', async () => {
  const { service, db, sends } = setup(); await expect(service.owner('org', 'project', 'POST')).rejects.toThrow('AUTOMATION_POLICY_OWNER_REQUIRED');
  await service.saveOwner('org', 'project', 'POST', 'owner'); db.rows('userOrganization')[0].disabled = true;
  await expect(service.enqueue('org', 'project', 'root', 'POST')).rejects.toThrow('SEND_POLICY_OWNER_UNAVAILABLE'); expect(sends.enqueue).not.toHaveBeenCalled();
 });
});


describe('automatic producer API wiring', () => {
 it('captures the authenticated configuration owner only after a successful save', async () => {
  const automatic = { assertOwnerAvailable: vi.fn(), saveOwner: vi.fn() };
  const saveConfig = vi.fn();
  const service = new AutomationService({} as any, {} as any, { saveConfig } as any, {} as any, {} as any, {} as any, undefined, undefined, automatic as any);
  saveConfig.mockRejectedValueOnce(new Error('configuration failed'));
  await expect(service.saveReplies({ id: 'org' } as any, 'project', { autoReplyEnabled: false }, 'owner')).rejects.toThrow('configuration failed');
  expect(automatic.saveOwner).not.toHaveBeenCalled();
  await service.saveReplies({ id: 'org' } as any, 'project', { autoReplyEnabled: false }, 'owner');
  expect(automatic.saveOwner).toHaveBeenCalledWith('org', 'project', 'REPLY', 'owner');
 });
 it('parks controlled automatic replies outside the legacy pool before creating an intent', async () => {
  const upsertDraft = vi.fn().mockResolvedValue({ id: 'reply', post: { id: 'root', state: 'DRAFT' } });
  const automatic = { owner: vi.fn().mockResolvedValue('owner'), enqueue: vi.fn() };
  const service = Object.assign(Object.create(EngageService.prototype), { _engageRepository: { upsertDraft }, _automaticSends: automatic }) as EngageService;
  await service.queueAutoReply({ id: 'org' } as any, 'opportunity', { platform: 'x', content: 'reply', inputData: {}, projectId: 'project', coordinated: true });
  expect(upsertDraft).toHaveBeenCalledWith('org', 'opportunity', expect.objectContaining({ state: 'DRAFT', coordinatedAutomatic: true }), 'project');
  expect(automatic.enqueue).toHaveBeenCalledWith('org', 'project', 'root', 'REPLY');
 });
 it('does not generate a sendable draft when the policy owner is unavailable', async () => {
  const upsertDraft = vi.fn(); const service = Object.assign(Object.create(EngageService.prototype), { _engageRepository: { upsertDraft }, _automaticSends: { owner: vi.fn().mockRejectedValue(new Error('owner missing')) } }) as EngageService;
  await expect(service.queueAutoReply({ id: 'org' } as any, 'opportunity', { platform: 'x', content: 'reply', inputData: {}, projectId: 'project', coordinated: true })).rejects.toThrow('owner missing');
  expect(upsertDraft).not.toHaveBeenCalled();
 });
});
