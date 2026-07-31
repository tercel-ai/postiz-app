// Quora's composer can attach images via its own file input (see
// quora.poster's quoraComposeInPage). Verifies the queue forwards segment
// images to the poster instead of silently stripping them — the same
// regression `queue-platform-routing.spec.ts` guards for LinkedIn.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@gitroom/extension/pages/background/quora.poster', () => ({
  postQuoraPost: vi.fn(),
}));

import { postQuoraPost } from '@gitroom/extension/pages/background/quora.poster';
import {
  enqueuePublishBatch,
  publishQueueSnapshot,
  resetPublishQueueForTest,
  setBackfillForTest,
  setSleepForTest,
  waitForPublishIdle,
} from '../queue';

const quoraPost = vi.mocked(postQuoraPost);

describe('quora publish routing — images', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetPublishQueueForTest();
    setSleepForTest(() => Promise.resolve());
    setBackfillForTest(() => Promise.resolve());
    vi.stubGlobal('chrome', {
      tabs: { sendMessage: vi.fn() },
      runtime: { lastError: undefined },
      alarms: { create: vi.fn(), clear: vi.fn() },
      storage: { local: { set: vi.fn(), get: vi.fn((_k, cb) => cb({})) } },
    });
  });

  afterEach(async () => {
    setSleepForTest(null);
    setBackfillForTest(null);
    await waitForPublishIdle();
    vi.unstubAllGlobals();
  });

  it('forwards segment images to postQuoraPost instead of dropping them', async () => {
    quoraPost.mockResolvedValue({
      ok: true,
      permalink: 'https://www.quora.com/profile/Tercel-Yi/post-1',
    } as any);

    const ack = enqueuePublishBatch(
      'req-1',
      [
        {
          taskId: 'q-image',
          platform: 'quora',
          segments: [{ text: 'hi', images: ['https://api/img.png'] }],
        },
      ],
      1
    );
    await waitForPublishIdle();

    expect(ack.rejected).toEqual([]);
    expect(quoraPost).toHaveBeenCalledWith({
      text: 'hi',
      images: ['https://api/img.png'],
    });
    expect(publishQueueSnapshot().find((s) => s.taskId === 'q-image')?.status).toBe(
      'published'
    );
  });
});
