import { beforeEach, describe, expect, it, vi } from 'vitest';

const { backendCall, enqueuePublishBatch, initPublishQueue, NotAuthenticatedError } =
  vi.hoisted(() => ({
    backendCall: vi.fn(),
    enqueuePublishBatch: vi.fn(() => ({ accepted: [], rejected: [] })),
    initPublishQueue: vi.fn(async () => {}),
    NotAuthenticatedError: class NotAuthenticatedError extends Error {},
  }));

vi.mock('../api', () => ({ backendCall, NotAuthenticatedError }));
vi.mock('@gitroom/extension/utils/post-publish/queue', () => ({
  enqueuePublishBatch,
  initPublishQueue,
}));

import { runPublishLoop } from '../publish.runner';

describe('runPublishLoop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enqueuePublishBatch.mockReturnValue({ accepted: [], rejected: [] });
  });

  it('maps due posts into publish items and enqueues them', async () => {
    backendCall.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        due: [
          {
            id: 'post1',
            platform: 'hackernews',
            title: 'Show HN: thing',
            segments: [{ text: 'body' }],
          },
          {
            id: 'post2',
            platform: 'quora',
            segments: [{ text: 'answer' }],
          },
        ],
      },
    });
    enqueuePublishBatch.mockReturnValue({
      accepted: [{ taskId: 'post1' }, { taskId: 'post2' }],
      rejected: [],
    });

    const summary = await runPublishLoop();

    expect(initPublishQueue).toHaveBeenCalled();
    const [, items] = enqueuePublishBatch.mock.calls[0] as unknown as [string, any[]];
    expect(items).toEqual([
      { taskId: 'post1', platform: 'hackernews', segments: [{ text: 'body' }], title: 'Show HN: thing' },
      { taskId: 'post2', platform: 'quora', segments: [{ text: 'answer' }] },
    ]);
    expect(summary).toMatchObject({ due: 2, enqueued: 2, rejected: 0, stoppedReason: 'ok' });
  });

  it('is idle when nothing is due', async () => {
    backendCall.mockResolvedValue({ ok: true, status: 200, data: { due: [] } });
    const summary = await runPublishLoop();
    expect(enqueuePublishBatch).not.toHaveBeenCalled();
    expect(summary.stoppedReason).toBe('idle');
  });

  it('reports not-authenticated without noise', async () => {
    backendCall.mockRejectedValue(new NotAuthenticatedError('no token'));
    const summary = await runPublishLoop();
    expect(summary.stoppedReason).toBe('not-authenticated');
    expect(enqueuePublishBatch).not.toHaveBeenCalled();
  });

  it('surfaces an HTTP error', async () => {
    backendCall.mockResolvedValue({ ok: false, status: 500, data: null });
    const summary = await runPublishLoop();
    expect(summary.stoppedReason).toBe('error');
  });
});
