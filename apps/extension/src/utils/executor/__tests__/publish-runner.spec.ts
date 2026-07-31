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

  it('passes through per-segment images', async () => {
    backendCall.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        due: [
          {
            id: 'post3',
            platform: 'x',
            segments: [
              { text: 'body', images: ['https://cdn.example.com/a.png'] },
            ],
          },
        ],
      },
    });
    enqueuePublishBatch.mockReturnValue({
      accepted: [{ taskId: 'post3' }],
      rejected: [],
    });

    await runPublishLoop();

    const [, items] = enqueuePublishBatch.mock.calls[0] as unknown as [string, any[]];
    expect(items).toEqual([
      {
        taskId: 'post3',
        platform: 'x',
        segments: [
          { text: 'body', images: ['https://cdn.example.com/a.png'] },
        ],
      },
    ]);
  });

  it('drops images for platforms whose poster cannot upload them', async () => {
    // The backend resolves media for EVERY extension-routed post, but only
    // Reddit, X, LinkedIn, Dev.to and Quora posters can upload one. Forwarding
    // the image to a genuinely text-only platform (e.g. Medium) gets the item
    // rejected at enqueue, and a rejected item never leaves Post.state=QUEUE —
    // so the post would be re-offered and re-rejected forever instead of
    // publishing its text.
    backendCall.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        due: [
          {
            id: 'm-1',
            platform: 'medium',
            title: 'T',
            segments: [{ text: 'body', images: ['https://cdn.example.com/a.png'] }],
          },
        ],
      },
    });
    enqueuePublishBatch.mockReturnValue({ accepted: [{ taskId: 'm-1' }], rejected: [] });

    await runPublishLoop();

    const [, items] = enqueuePublishBatch.mock.calls[0] as unknown as [string, any[]];
    expect(items).toEqual([
      { taskId: 'm-1', platform: 'medium', title: 'T', segments: [{ text: 'body' }] },
    ]);
  });

  it('keeps images for LinkedIn (its poster can upload them)', async () => {
    backendCall.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        due: [
          {
            id: 'li-1',
            platform: 'linkedin',
            segments: [{ text: 'body', images: ['https://cdn.example.com/a.png'] }],
          },
        ],
      },
    });
    enqueuePublishBatch.mockReturnValue({ accepted: [{ taskId: 'li-1' }], rejected: [] });

    await runPublishLoop();

    const [, items] = enqueuePublishBatch.mock.calls[0] as unknown as [string, any[]];
    expect(items).toEqual([
      {
        taskId: 'li-1',
        platform: 'linkedin',
        segments: [{ text: 'body', images: ['https://cdn.example.com/a.png'] }],
      },
    ]);
  });

  it('carries targetAccount through to the queue', async () => {
    // The wrong-account guard reads item.targetAccount. Dropping it in this
    // mapper would silently disable the guard for the PULL path — the
    // unattended one, with no human to notice the post went out as the wrong
    // account — while every guard unit test kept passing.
    backendCall.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        due: [
          {
            id: 'bound',
            platform: 'reddit',
            title: 'T',
            subreddit: 'test',
            segments: [{ text: 'body' }],
            targetAccount: { id: 'abc123', handle: 'alice' },
          },
          {
            id: 'unbound',
            platform: 'reddit',
            title: 'T',
            subreddit: 'test',
            segments: [{ text: 'body' }],
          },
        ],
      },
    });
    enqueuePublishBatch.mockReturnValue({
      accepted: [{ taskId: 'bound' }, { taskId: 'unbound' }],
      rejected: [],
    });

    await runPublishLoop();

    const [, items] = enqueuePublishBatch.mock.calls[0] as unknown as [string, any[]];
    expect(items[0].targetAccount).toEqual({ id: 'abc123', handle: 'alice' });
    // A post with no bound account must NOT gain an empty targetAccount key —
    // the queue gates the whole guard on its presence.
    expect(items[1]).not.toHaveProperty('targetAccount');
  });

  it('surfaces why items were rejected, not just how many', async () => {
    // A rejected post stays QUEUE and comes back every cycle. Logging only the
    // count makes that loop indistinguishable from normal operation and leaves
    // the failing taskId unrecoverable from the log.
    backendCall.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        due: [{ id: 'bad', platform: 'hackernews', segments: [{ text: 'x' }] }],
      },
    });
    enqueuePublishBatch.mockReturnValue({
      accepted: [],
      rejected: [{ taskId: 'bad', reason: 'hackernews post needs a title' }],
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const summary = await runPublishLoop();

    expect(summary.rejections).toEqual([
      { taskId: 'bad', reason: 'hackernews post needs a title' },
    ]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('rejected from publish-due'),
      [{ taskId: 'bad', reason: 'hackernews post needs a title' }]
    );
    warn.mockRestore();
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
