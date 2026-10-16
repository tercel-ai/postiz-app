import { describe, expect, it, vi } from 'vitest';
import { PostsService } from '../posts.service';
function fixture() {
  const post = {
    id: 'root',
    organizationId: 'org',
    state: 'QUEUE',
    executionProtocol: 'ACCOUNT_BOUND_V1',
    sendIntentId: 'intent',
    integrationId: 'actor',
    publishMethod: 'API',
    providerIdentifier: 'x',
  };
  const terminate = vi.fn();
  const start = vi.fn();
  const reset = vi.fn();
  const list = vi.fn(async function* () {
    yield { workflowId: 'post_root' };
  });
  const raw = { workflow: { start, list } };
  const service = Object.assign(Object.create(PostsService.prototype), {
    _postRepository: {
      getPostById: vi.fn().mockResolvedValue(post),
      resetClaimForPost: reset,
    },
    _sendCoordinator: { enabled: vi.fn(), enqueue: vi.fn() },
    _integrationManager: { isExtensionPublish: () => false },
    _temporalService: {
      client: {
        getRawClient: () => raw,
        getWorkflowHandle: async () => ({
          describe: async () => ({ status: { name: 'RUNNING' } }),
          terminate,
        }),
      },
    },
    _postOverageService: {
      deductIfOverage: vi.fn().mockResolvedValue(undefined),
    },
    logger: { error: vi.fn(), warn: vi.fn() },
  }) as PostsService;
  return { service, post, start, reset, terminate, list };
}
describe('controlled API dispatch recovery', () => {
  it('blocks unsupported historical OAuth dispatch without terminating or resetting it',async()=>{
    const {service,start,terminate,reset,list}=fixture();
    await expect(service.startWorkflow('x','root','org')).rejects.toThrow('API_PUBLISHING_UNSUPPORTED_USE_EXTENSION');
    expect(start).not.toHaveBeenCalled();expect(terminate).not.toHaveBeenCalled();expect(reset).not.toHaveBeenCalled();expect(list).not.toHaveBeenCalled();
  });
  it('redispatches an already queued intent after the first workflow dispatch failed', async () => {
    const { service } = fixture();
    const start = vi
      .spyOn(service, 'startWorkflow')
      .mockResolvedValue(undefined);
    await service.queueStoredSend('org', 'root', 'user');
    expect(start).toHaveBeenCalledWith('social-activities', 'root', 'org');
  });
  it('does not restart a completed content unit', async () => {
    const { service, post } = fixture();
    post.state = 'PUBLISHED';
    const start = vi
      .spyOn(service, 'startWorkflow')
      .mockResolvedValue(undefined);
    await service.queueStoredSend('org', 'root', 'user');
    expect(start).not.toHaveBeenCalled();
  });
});
