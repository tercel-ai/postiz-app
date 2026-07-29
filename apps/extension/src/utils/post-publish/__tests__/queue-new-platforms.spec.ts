import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublishPostItem } from '@gitroom/helpers/extension/post-publish';
import {
  enqueuePublishBatch,
  publishQueueSnapshot,
  resetPublishQueueForTest,
  setBackfillForTest,
  setSegmentPublisherForTest,
  setSleepForTest,
  waitForPublishIdle,
} from '../queue';

const item = (extra: Partial<PublishPostItem>): PublishPostItem => ({
  taskId: extra.taskId || 't1',
  platform: 'medium',
  title: 'T',
  segments: [{ text: 'body' }],
  ...extra,
});

// Enqueue then return the single accept/reject reason for the item.
function reasonFor(it: PublishPostItem): string | null {
  const ack = enqueuePublishBatch('req', [it], undefined);
  if (ack.accepted.length) return null;
  return ack.rejected[0]?.reason ?? 'rejected';
}

describe('publish queue — new platforms validation', () => {
  beforeEach(() => {
    resetPublishQueueForTest();
    setSleepForTest(() => Promise.resolve());
    setBackfillForTest(() => Promise.resolve());
    // Accepted items drain immediately; stub the publisher so no real tab opens.
    setSegmentPublisherForTest(async () => ({ ok: true, permalink: 'https://x/1' }));
    vi.stubGlobal('chrome', {
      tabs: { sendMessage: vi.fn() },
      runtime: { lastError: undefined },
    });
  });
  afterEach(async () => {
    setSegmentPublisherForTest(null);
    setSleepForTest(null);
    setBackfillForTest(null);
    await waitForPublishIdle();
    vi.unstubAllGlobals();
  });

  it('rejects an unknown platform', () => {
    expect(reasonFor(item({ platform: 'facebook' as any }))).toMatch(/unsupported platform/);
  });

  it('rejects dev.to — it publishes through the backend provider, not the extension', () => {
    // Dev.to has a working REST API, so it is NOT an extension publish platform.
    expect(reasonFor(item({ platform: 'devto' as any }))).toMatch(/unsupported platform/);
  });

  it('medium requires a title and rejects multi-segment threads', () => {
    expect(reasonFor(item({ taskId: 'm0', title: '' }))).toMatch(/needs a title/);
    expect(
      reasonFor(
        item({
          taskId: 'm1',
          platform: 'medium',
          title: 'T',
          segments: [{ text: 'a' }, { text: 'b' }],
        })
      )
    ).toMatch(/single-segment/);
    expect(reasonFor(item({ taskId: 'm2', title: 'T' }))).toBeNull();
  });

  it('quora needs no title and accepts a single text segment', () => {
    expect(reasonFor(item({ taskId: 'q1', platform: 'quora' }))).toBeNull();
    expect(
      reasonFor(
        item({
          taskId: 'q2',
          platform: 'quora',
          segments: [{ text: 'a' }, { text: 'b' }],
        })
      )
    ).toMatch(/single-segment/);
  });

  it('hackernews requires a title but allows a comment-chain thread', () => {
    expect(reasonFor(item({ taskId: 'h1', platform: 'hackernews', title: '' }))).toMatch(
      /needs a title/
    );
    expect(
      reasonFor(
        item({
          taskId: 'h2',
          platform: 'hackernews',
          title: 'Show HN',
          segments: [{ text: 'story' }, { text: 'follow-up comment' }],
        })
      )
    ).toBeNull();
  });

  it('strips images on the article/forum platforms instead of rejecting', () => {
    // Their posters are text-only, but rejecting the item would be worse than
    // dropping the attachment: a rejected item never leaves Post.state=QUEUE,
    // so the backend re-leases it every cycle and the post never publishes.
    expect(
      reasonFor(
        item({ taskId: 'i1', title: 'T', segments: [{ text: 'a', images: ['https://img/1'] }] })
      )
    ).toBeNull();
  });

  it('rejects only when stripping the images leaves nothing to publish', () => {
    expect(
      reasonFor(
        item({ taskId: 'i2', title: 'T', segments: [{ text: '', images: ['https://img/1'] }] })
      )
    ).toMatch(/non-empty list with text or images/);
  });

  it('completes (published) even when the poster captures no permalink (F1)', async () => {
    // Quora often confirms the send but can't recover the URL. The post must
    // still flip to published so the unattended publish-due loop terminates.
    const backfill = vi.fn(async () => {});
    setBackfillForTest(backfill);
    setSegmentPublisherForTest(async () => ({ ok: true })); // no permalink
    const ack = enqueuePublishBatch('r', [item({ taskId: 'noperm', platform: 'quora' })], undefined);
    expect(ack.accepted).toHaveLength(1);
    await waitForPublishIdle();
    const state = publishQueueSnapshot().find((s) => s.taskId === 'noperm');
    expect(state?.status).toBe('published');
    expect(backfill).toHaveBeenCalledWith('noperm', '', undefined);
  });
});
