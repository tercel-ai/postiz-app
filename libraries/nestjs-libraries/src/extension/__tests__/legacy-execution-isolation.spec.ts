import { describe, it, expect, vi } from 'vitest';
import { PostsService } from '../../database/prisma/posts/posts.service';
import { PostsRepository } from '../../database/prisma/posts/posts.repository';

function setupService(post: any) {
  const service = Object.create(PostsService.prototype) as PostsService;
  const repo = {
    getPostById: vi.fn().mockResolvedValue(post),
    getSchedulablePostsByIds: vi.fn().mockResolvedValue([post]),
    schedulePostGroupToQueue: vi.fn(),
    updatePost: vi.fn(),
  };
  const temporal = {
    client: { workflow: { start: vi.fn(), getHandle: vi.fn() } },
  };
  Object.assign(service, {
    _postRepository: repo,
    _temporalService: temporal,
    logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  return { service, repo, temporal };
}
const strict = {
  id: 'post',
  state: 'DRAFT',
  organizationId: 'org',
  group: 'group',
  executionProtocol: 'ACCOUNT_BOUND_V1',
  providerIdentifier: 'x',
  integrationId: 'account',
};
describe('legacy execution isolation', () => {
  it('refuses legacy scheduling for a strict task before changing QUEUE or starting a workflow', async () => {
    const { service, repo } = setupService(strict);
    const result = await service.schedulePosts('org', [{ id: 'post' }]);
    expect(result.failed).toEqual([
      {
        id: 'post',
        code: 'ACCOUNT_BOUND_SEND_NOT_ENABLED',
        message: expect.any(String),
      },
    ]);
    expect(repo.schedulePostGroupToQueue).not.toHaveBeenCalled();
  });
  it('never starts the legacy Temporal flow for an account-bound task', async () => {
    const { service, temporal } = setupService(strict);
    await expect(
      service.startWorkflow('queue', 'post', 'org')
    ).rejects.toMatchObject({ status: 503 });
    expect(temporal.client.workflow.start).not.toHaveBeenCalled();
  });
  it('fails closed if routing cannot be read rather than guessing the API path', async () => {
    const { service, repo, temporal } = setupService(strict);
    repo.getPostById.mockRejectedValue(new Error('unavailable'));
    await expect(service.startWorkflow('queue', 'post', 'org')).rejects.toThrow(
      'unavailable'
    );
    expect(temporal.client.workflow.start).not.toHaveBeenCalled();
  });
  it('rejects old published callbacks for strict rows even when a client knows the ID', async () => {
    const { service, repo } = setupService(strict);
    await expect(
      service.markPublishedFromExtension(
        'org',
        'post',
        'https://x.com/alice/status/1',
        '1'
      )
    ).resolves.toMatchObject({
      ok: false,
      reason: 'account-bound-protocol-required',
    });
    expect(repo.updatePost).not.toHaveBeenCalled();
  });
  it('rejects legacy failed callbacks for strict rows before changing any segment', async () => {
    const { service } = setupService(strict);
    await expect(service.markPublishFailedFromExtension('org', 'post', 'network timeout')).resolves.toMatchObject({ ok: false, reason: 'account-bound-protocol-required' });
  });
  it('blocks legacy API claims and recurring clones for strict tasks', async () => {
    const repo = Object.create(PostsRepository.prototype) as PostsRepository;
    const post = { updateMany: vi.fn().mockResolvedValue({ count: 0 }), findFirst: vi.fn(), create: vi.fn() };
    Object.assign(repo, { _post: { model: { post } } });
    await expect(repo.claimPostForPublishing('post', 'lease')).resolves.toBe(false);
    expect(post.updateMany.mock.calls[0][0].where.AND).toContainEqual({ OR: [{ executionProtocol: null }, { executionProtocol: 'LEGACY' }] });
    await expect(repo.findOrCreateCycleClone(strict, new Date(), 'lease')).rejects.toMatchObject({ status: 503 });
    expect(post.create).not.toHaveBeenCalled();
    expect(post.findFirst).not.toHaveBeenCalled();
  });
  it('constrains the legacy offer and write-time CAS by the same protocol and tenant predicates', async () => {
    const repo = Object.create(PostsRepository.prototype) as PostsRepository;
    const post = {
      findMany: vi
        .fn()
        .mockResolvedValueOnce([{ id: 'post' }])
        .mockResolvedValueOnce([]),
      updateMany: vi.fn(),
    };
    Object.assign(repo, { _post: { model: { post } } });
    await repo.claimDueExtensionPublishPosts(
      'org',
      ['x'],
      new Date(),
      10,
      'lease',
      new Date()
    );
    const read = post.findMany.mock.calls[0][0].where.AND[0];
    expect(read.AND).toContainEqual({
      OR: [{ executionProtocol: null }, { executionProtocol: 'LEGACY' }],
    });
    const write = post.updateMany.mock.calls[0][0].where;
    expect(write.AND).toContainEqual(read);
  });
  it('guards scheduling at the database write even when route binding races the old read', async () => {
    const repo = Object.create(PostsRepository.prototype) as PostsRepository;
    const post = { updateMany: vi.fn().mockResolvedValue({ count: 0 }) };
    Object.assign(repo, { _post: { model: { post } } });
    await repo.schedulePostGroupToQueue('org', 'group', 'EXTENSION');
    expect(post.updateMany.mock.calls[0][0].where.AND).toContainEqual({
      OR: [{ executionProtocol: null }, { executionProtocol: 'LEGACY' }],
    });
  });
});
