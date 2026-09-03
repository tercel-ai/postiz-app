import { describe, it, expect, vi } from 'vitest';
import { HttpException, HttpStatus } from '@nestjs/common';
import { EngageController } from '../engage.controller';

const ORG = { id: 'org1' } as any;

function build(quotaThrows = false) {
  const scanTasksService = {
    sync: vi.fn(async () => ({ accepted: 0, nextTasks: [] })),
    ingestCollectedPosts: vi.fn(async () => ({ accepted: 0 })),
  };
  const ingestQuota = {
    assertWithinQuota: vi.fn(async () => {
      if (quotaThrows) {
        throw new HttpException(
          { code: 'engage_ingest_quota_exceeded' },
          HttpStatus.TOO_MANY_REQUESTS
        );
      }
    }),
  };
  const controller = new EngageController(
    {} as any,
    {} as any,
    scanTasksService as any,
    {} as any,
    {} as any,
    ingestQuota as any
  );
  return { controller, scanTasksService, ingestQuota };
}

const post = (id: string) => ({
  platform: 'reddit',
  externalPostId: id,
  externalPostUrl: `https://reddit.com/${id}`,
  authorUsername: 'someone',
  postContent: 'body',
  postPublishedAt: new Date().toISOString(),
});

describe('EngageController ingest quota gate', () => {
  it('charges scan-tasks ingest for the submitted post count', async () => {
    const { controller, ingestQuota } = build();
    await controller.scanTasksIngest(ORG, {
      completed: { taskId: 't1', posts: [post('a'), post('b')] },
    } as any);
    expect(ingestQuota.assertWithinQuota).toHaveBeenCalledWith('org1', 2);
  });

  it('charges nothing for a bootstrap claim that carries no completed unit', async () => {
    const { controller, ingestQuota, scanTasksService } = build();
    await controller.scanTasksIngest(ORG, { want: 2 } as any);
    expect(ingestQuota.assertWithinQuota).toHaveBeenCalledWith('org1', 0);
    expect(scanTasksService.sync).toHaveBeenCalled();
  });

  it('does not reach the service when the quota rejects', async () => {
    const { controller, scanTasksService } = build(true);
    await expect(
      controller.scanTasksIngest(ORG, {
        completed: { taskId: 't1', posts: [post('a')] },
      } as any)
    ).rejects.toThrow(HttpException);
    // The whole point of checking first: an over-quota batch costs no parsing,
    // no scoring, no LLM call and no fan-out write.
    expect(scanTasksService.sync).not.toHaveBeenCalled();
  });

  it('charges scan-posts ingest too, and blocks it on rejection', async () => {
    const ok = build();
    await ok.controller.ingestScanPosts(ORG, {
      posts: [post('a'), post('b'), post('c')],
    } as any);
    expect(ok.ingestQuota.assertWithinQuota).toHaveBeenCalledWith('org1', 3);

    const blocked = build(true);
    await expect(
      blocked.controller.ingestScanPosts(ORG, { posts: [post('a')] } as any)
    ).rejects.toThrow(HttpException);
    expect(blocked.scanTasksService.ingestCollectedPosts).not.toHaveBeenCalled();
  });
});
