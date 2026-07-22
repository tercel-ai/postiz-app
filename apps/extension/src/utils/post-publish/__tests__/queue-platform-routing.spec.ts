// Verifies the DEFAULT segment publisher routes to the real posters: X via
// the browser-tab automation (postXCompose / postXReply — never a direct API
// call from the worker) and Reddit via submit + comment chain.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@gitroom/extension/utils/reddit.poster', () => ({
  submitRedditPost: vi.fn(),
  postRedditComment: vi.fn(),
}));
vi.mock('@gitroom/extension/pages/background/x.poster', () => ({
  postXCompose: vi.fn(),
  postXReply: vi.fn(),
}));

import {
  postRedditComment,
  submitRedditPost,
} from '@gitroom/extension/utils/reddit.poster';
import {
  postXCompose,
  postXReply,
} from '@gitroom/extension/pages/background/x.poster';
import {
  enqueuePublishBatch,
  publishQueueSnapshot,
  resetPublishQueueForTest,
  waitForPublishIdle,
} from '../queue';

const xCompose = vi.mocked(postXCompose);
const xReply = vi.mocked(postXReply);
const rSubmit = vi.mocked(submitRedditPost);
const rComment = vi.mocked(postRedditComment);

describe('default publisher platform routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetPublishQueueForTest();
    vi.stubGlobal('chrome', {
      tabs: { sendMessage: vi.fn() },
      runtime: { lastError: undefined },
      alarms: { create: vi.fn(), clear: vi.fn() },
      storage: { local: { set: vi.fn(), get: vi.fn((_k, cb) => cb({})) } },
    });
  });

  afterEach(async () => {
    await waitForPublishIdle();
    vi.unstubAllGlobals();
  });

  it('publishes an X thread via compose tab then reply-chain tabs', async () => {
    xCompose.mockResolvedValue({
      ok: true,
      permalink: 'https://x.com/u/status/1',
      postId: '1',
    });
    xReply.mockResolvedValue({
      ok: true,
      permalink: 'https://x.com/u/status/2',
      postId: '2',
    });

    enqueuePublishBatch(
      'req-1',
      [
        {
          taskId: 'x-thread',
          platform: 'x',
          segments: [
            { text: 'main', images: ['https://api/img.png'] },
            { text: 'follow-up' },
          ],
        },
      ],
      1
    );
    await waitForPublishIdle();

    expect(xCompose).toHaveBeenCalledWith({
      text: 'main',
      images: ['https://api/img.png'],
    });
    expect(xReply).toHaveBeenCalledWith({
      url: 'https://x.com/u/status/1',
      text: 'follow-up',
    });
    expect(rSubmit).not.toHaveBeenCalled();
    expect(publishQueueSnapshot()[0]).toMatchObject({
      status: 'published',
      permalink: 'https://x.com/u/status/1',
      segmentPermalinks: ['https://x.com/u/status/1', 'https://x.com/u/status/2'],
    });
  });

  it('treats an X pending outcome (manual click needed) as a task error', async () => {
    xCompose.mockResolvedValue({ ok: true, pending: true, message: 'click Post' });
    enqueuePublishBatch(
      'req-1',
      [{ taskId: 'x-pending', platform: 'x', segments: [{ text: 'hi' }] }],
      1
    );
    await waitForPublishIdle();
    expect(publishQueueSnapshot()[0]).toMatchObject({
      status: 'error',
      error: 'click Post',
    });
  });

  it('fails a thread when a mid-thread tweet URL cannot be confirmed, but tolerates it on the last segment', async () => {
    // Mid-thread: sent but no permalink captured → chain must stop.
    xCompose.mockResolvedValue({ ok: true, permalink: undefined });
    enqueuePublishBatch(
      'req-1',
      [
        {
          taskId: 'x-unconfirmed-mid',
          platform: 'x',
          segments: [{ text: 'a' }, { text: 'b' }],
        },
      ],
      1
    );
    await waitForPublishIdle();
    expect(publishQueueSnapshot()[0]).toMatchObject({ status: 'error' });
    expect(publishQueueSnapshot()[0].error).toMatch(/could not be confirmed/);
    expect(xReply).not.toHaveBeenCalled();

    // Last segment: unconfirmed is tolerated — the post itself went out.
    resetPublishQueueForTest();
    enqueuePublishBatch(
      'req-2',
      [{ taskId: 'x-unconfirmed-last', platform: 'x', segments: [{ text: 'a' }] }],
      1
    );
    await waitForPublishIdle();
    expect(publishQueueSnapshot()[0].status).toBe('published');
  });

  it('publishes a Reddit thread via submit then comment chain', async () => {
    rSubmit.mockResolvedValue({
      ok: true,
      permalink: 'https://www.reddit.com/r/t/comments/abc/x/',
      postId: 't3_abc',
    });
    rComment.mockResolvedValue({
      ok: true,
      permalink: 'https://www.reddit.com/r/t/comments/abc/x/c1/',
      postId: 't1_c1',
    });

    enqueuePublishBatch(
      'req-1',
      [
        {
          taskId: 'r-thread',
          platform: 'reddit',
          subreddit: 'r/t',
          title: 'T',
          segments: [
            { text: 'main', images: ['https://api/img.png'] },
            { text: 'follow-up' },
          ],
        },
      ],
      1
    );
    await waitForPublishIdle();

    expect(rSubmit).toHaveBeenCalledWith({
      subreddit: 'r/t',
      title: 'T',
      text: 'main',
      images: ['https://api/img.png'],
    });
    expect(rComment).toHaveBeenCalledWith({
      url: 'https://www.reddit.com/r/t/comments/abc/x/',
      text: 'follow-up',
    });
    expect(xCompose).not.toHaveBeenCalled();
    expect(publishQueueSnapshot()[0].status).toBe('published');
  });
});
