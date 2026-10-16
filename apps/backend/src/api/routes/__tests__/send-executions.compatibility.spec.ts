import { afterEach, describe, expect, it, vi } from 'vitest';
import { PostsController } from '../posts.controller';
import { EngageController } from '../engage.controller';
import { ExtensionExecutionReadyGuard } from '@gitroom/nestjs-libraries/extension/extension-execution.guard';
const org = { id: 'org' } as any;
const user = { id: 'user' } as any;
const headers = {
  'x-extension-node-id': 'node',
  'x-extension-node-token': 'node-token',
  'x-extension-protocol-version': 'ACCOUNT_BOUND_V1',
};
afterEach(() => vi.unstubAllEnvs());
describe('compatible due endpoint routing', () => {
  it('keeps old post due responses on the existing legacy service', async () => {
    const controller = Object.create(
      PostsController.prototype
    ) as PostsController;
    const posts = {
      getDuePublishPosts: vi.fn().mockResolvedValue({ due: ['legacy'] }),
    };
    Object.assign(controller, {
      _postsService: posts,
      _platformPacing: { getPlatformPacing: vi.fn().mockResolvedValue({}) },
    });
    expect(await controller.getDuePublish(org, { limit: 2 })).toEqual({
      due: ['legacy'],
      pacing: {},
    });
    expect(posts.getDuePublishPosts).toHaveBeenCalledWith('org', 2);
  });
  it.each(['POST', 'REPLY'] as const)(
    'routes authenticated V1 %s polling through the shared claim service',
    async (action) => {
      const claim = vi.fn().mockResolvedValue({ items: ['controlled'] });
      const legacy = vi.fn();
      const controller: any = Object.create(
        action === 'POST'
          ? PostsController.prototype
          : EngageController.prototype
      );
      Object.assign(controller, {
        _sendExecutions: { claim },
        _postsService: { getDuePublishPosts: legacy },
        _engageAutoReplyService: { getDueReplies: legacy },
        _platformPacing: { getPlatformPacing: vi.fn().mockResolvedValue({}) },
      });
      const result =
        action === 'POST'
          ? await controller.getDuePublish(
              org,
              { requestId: 'request' },
              user,
              headers
            )
          : await controller.getDueReplies(
              org,
              { requestId: 'request' },
              user,
              headers
            );
      expect(result).toMatchObject({
        due: ['controlled'],
        executionProtocol: 'ACCOUNT_BOUND_V1',
      });
      expect(claim).toHaveBeenCalledWith(
        { org: 'org', user: 'user', nodeId: 'node', token: 'node-token' },
        { requestId: 'request', action }
      );
      expect(legacy).not.toHaveBeenCalled();
    }
  );
  it('only admits complete V1 headers into the new branch when coordinated sending is enabled', () => {
    vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'true');
    const guard = new ExtensionExecutionReadyGuard();
    const context = (h: any) =>
      ({ switchToHttp: () => ({ getRequest: () => ({ headers: h }) }) } as any);
    expect(guard.canActivate(context(headers))).toBe(true);
    expect(() =>
      guard.canActivate(context({ 'x-extension-node-id': 'node' }))
    ).toThrow('ACCOUNT_BOUND_SEND_NOT_ENABLED');
    vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'false');
    expect(() => guard.canActivate(context(headers))).toThrow(
      'ACCOUNT_BOUND_SEND_NOT_ENABLED'
    );
  });
});
