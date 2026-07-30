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

  it('accepts dev.to even though it also has a working REST API', () => {
    // The api-key channel and in-browser publishing are two parallel routes,
    // exactly as they already are for medium/quora/hackernews — a user with no
    // dev.to api-key must still be able to publish. `Post.publishMethod` picks
    // the route per post; being publishable here is what makes that a choice.
    expect(
      reasonFor(item({ taskId: 'd0', platform: 'devto' as any, title: 'Hello' }))
    ).toBeNull();
  });

  it('dev.to requires a title and rejects multi-segment threads', () => {
    expect(
      reasonFor(item({ taskId: 'd1', platform: 'devto' as any, title: '' }))
    ).toMatch(/needs a title/);
    expect(
      reasonFor(
        item({
          taskId: 'd2',
          platform: 'devto' as any,
          title: 'Hello',
          segments: [{ text: 'one' }, { text: 'two' }],
        })
      )
    ).toMatch(/single-segment/);
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

  it('backfills the dev.to article URL so the Post flips to PUBLISHED', async () => {
    // Dev.to's poster recovers the permalink by watching the tab navigate from
    // /new to /<username>/<slug> (verified against a real publish). Without the
    // backfill the Post would sit in QUEUE and the publish-due loop would
    // re-offer it every cycle — a duplicate article, not just a missing link.
    const backfill = vi.fn(async () => {});
    setBackfillForTest(backfill);
    const url = 'https://dev.to/tercelyi/hello-from-the-extension-3pe5';
    setSegmentPublisherForTest(async () => ({
      ok: true,
      permalink: url,
      postId: '2451234',
    }));

    const ack = enqueuePublishBatch(
      'r',
      [item({ taskId: 'dv', platform: 'devto' as any, title: 'Hello' })],
      undefined
    );
    expect(ack.accepted).toHaveLength(1);
    await waitForPublishIdle();

    const state = publishQueueSnapshot().find((s) => s.taskId === 'dv');
    expect(state?.status).toBe('published');
    expect(state?.permalink).toBe(url);
    expect(backfill).toHaveBeenCalledWith('dv', url, '2451234');
  });
});
