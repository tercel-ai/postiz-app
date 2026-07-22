import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublishPostItem } from '@gitroom/helpers/extension/post-publish';
import {
  cancelPublishTasks,
  enqueuePublishBatch,
  publishQueueSnapshot,
  resetPublishQueueForTest,
  setSegmentPublisherForTest,
  waitForPublishIdle,
} from '../queue';

const redditItem = (
  taskId: string,
  segments = ['post body'],
  extra: Partial<PublishPostItem> = {}
): PublishPostItem => ({
  taskId,
  platform: 'reddit',
  segments: segments.map((text) => ({ text })),
  subreddit: 'r/test',
  title: 'A title',
  ...extra,
});

describe('publish queue', () => {
  beforeEach(() => {
    resetPublishQueueForTest();
    vi.stubGlobal('chrome', {
      tabs: { sendMessage: vi.fn() },
      runtime: { lastError: undefined },
    });
  });

  afterEach(async () => {
    setSegmentPublisherForTest(null);
    await waitForPublishIdle();
    vi.unstubAllGlobals();
  });

  it('rejects invalid items at enqueue with per-item reasons', async () => {
    setSegmentPublisherForTest(async () => ({ ok: true, permalink: 'p' }));
    const ack = enqueuePublishBatch(
      'req-1',
      [
        redditItem('ok-1'),
        // x needs no subreddit/title — accepted as-is (tab automation path).
        { ...redditItem('x-1'), platform: 'x', subreddit: undefined, title: undefined },
        redditItem('no-sr', ['t'], { subreddit: '' }),
        redditItem('no-title', ['t'], { title: '  ' }),
        redditItem('no-seg', []),
        { ...redditItem('bad-platform'), platform: 'tiktok' as any },
      ],
      1
    );
    expect(ack.accepted.map((s) => s.taskId)).toEqual(['ok-1', 'x-1']);
    expect(ack.rejected.map((r) => r.taskId)).toEqual([
      'no-sr',
      'no-title',
      'no-seg',
      'bad-platform',
    ]);
    expect(ack.rejected[0].reason).toMatch(/subreddit/);
    await waitForPublishIdle();
  });

  it('rejects a duplicate taskId while the original is still active', async () => {
    let release!: () => void;
    setSegmentPublisherForTest(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true, permalink: 'p' });
        })
    );
    enqueuePublishBatch('req-1', [redditItem('dup')], 1);
    const ack = enqueuePublishBatch('req-2', [redditItem('dup')], 1);
    expect(ack.rejected).toEqual([
      { taskId: 'dup', reason: 'duplicate taskId (already queued or publishing)' },
    ]);
    release();
    await waitForPublishIdle();
  });

  it('publishes a thread as a chain and reports segment progress', async () => {
    const calls: Array<{ i: number; prev?: string }> = [];
    setSegmentPublisherForTest(async (_item, i, prev) => {
      calls.push({ i, prev });
      return { ok: true, permalink: `link-${i}`, postId: `t3_${i}` };
    });

    enqueuePublishBatch('req-1', [redditItem('thread-1', ['a', 'b', 'c'])], 7);
    await waitForPublishIdle();

    expect(calls).toEqual([
      { i: 0, prev: undefined },
      { i: 1, prev: 'link-0' },
      { i: 2, prev: 'link-1' },
    ]);
    const [state] = publishQueueSnapshot();
    expect(state).toMatchObject({
      taskId: 'thread-1',
      status: 'published',
      segmentsPublished: 3,
      segmentsTotal: 3,
      permalink: 'link-0',
      postId: 't3_0',
      segmentPermalinks: ['link-0', 'link-1', 'link-2'],
    });

    // Progress was pushed to the originating tab on every transition.
    const sendMessage = (globalThis as any).chrome.tabs.sendMessage;
    const statuses = sendMessage.mock.calls.map((c: any[]) => c[1].state.status);
    expect(statuses[0]).toBe('publishing');
    expect(statuses[statuses.length - 1]).toBe('published');
    expect(sendMessage.mock.calls.every((c: any[]) => c[0] === 7)).toBe(true);
  });

  it('stops a thread on the first failing segment and records the error', async () => {
    setSegmentPublisherForTest(async (_item, i) =>
      i === 1
        ? { ok: false, error: 'THREAD_BROKE' }
        : { ok: true, permalink: `link-${i}` }
    );
    enqueuePublishBatch('req-1', [redditItem('t', ['a', 'b', 'c'])], 1);
    await waitForPublishIdle();

    const [state] = publishQueueSnapshot();
    expect(state).toMatchObject({
      status: 'error',
      error: 'THREAD_BROKE',
      segmentsPublished: 1,
      segmentPermalinks: ['link-0'],
    });
  });

  it('cancels only queued tasks; publishing and settled ones are reported', async () => {
    let release!: () => void;
    setSegmentPublisherForTest(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true, permalink: 'p' });
        })
    );
    enqueuePublishBatch('req-1', [redditItem('running'), redditItem('waiting')], 1);

    const ack = cancelPublishTasks(['running', 'waiting', 'ghost']);
    expect(ack.canceled).toEqual(['waiting']);
    expect(ack.notCancelable).toEqual([
      { taskId: 'running', reason: 'already publishing' },
      { taskId: 'ghost', reason: 'not found' },
    ]);

    release();
    await waitForPublishIdle();

    const byId = Object.fromEntries(
      publishQueueSnapshot().map((s) => [s.taskId, s.status])
    );
    expect(byId).toEqual({ running: 'published', waiting: 'canceled' });

    // Settled now — canceling again is rejected with the settled reason.
    const again = cancelPublishTasks(['waiting']);
    expect(again.notCancelable).toEqual([
      { taskId: 'waiting', reason: 'already settled (canceled)' },
    ]);
  });

  it('drains serially: the second post starts only after the first settles', async () => {
    const order: string[] = [];
    const releases: Array<() => void> = [];
    setSegmentPublisherForTest((item) => {
      order.push(`start:${item.taskId}`);
      return new Promise((resolve) => {
        releases.push(() => {
          order.push(`end:${item.taskId}`);
          resolve({ ok: true, permalink: 'p' });
        });
      });
    });
    enqueuePublishBatch('req-1', [redditItem('one'), redditItem('two')], 1);
    await Promise.resolve();
    expect(order).toEqual(['start:one']);
    releases[0]();
    await vi.waitFor(() => expect(order).toContain('start:two'));
    expect(order).toEqual(['start:one', 'end:one', 'start:two']);
    releases[1]();
    await waitForPublishIdle();
  });
});
