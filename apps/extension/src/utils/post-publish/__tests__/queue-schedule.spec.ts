import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublishPostItem } from '@gitroom/helpers/extension/post-publish';
import {
  PUBLISH_ALARM,
  cancelPublishTasks,
  enqueuePublishBatch,
  handlePublishAlarm,
  initPublishQueue,
  publishQueueSnapshot,
  publishTaskNow,
  syncPublishTask,
  retryPublishTask,
  removePublishTask,
  resetPublishQueueForTest,
  setBackfillForTest,
  setNowForTest,
  setSegmentPublisherForTest,
  setSleepForTest,
  waitForPublishIdle,
} from '../queue';

const T0 = Date.parse('2026-07-22T10:00:00.000Z');

const redditItem = (
  taskId: string,
  extra: Partial<PublishPostItem> = {}
): PublishPostItem => ({
  taskId,
  platform: 'reddit',
  segments: [{ text: 'body' }],
  subreddit: 'r/test',
  title: 'A title',
  ...extra,
});

function stubChrome() {
  const store: Record<string, any> = {};
  const alarms = { create: vi.fn(), clear: vi.fn() };
  vi.stubGlobal('chrome', {
    tabs: { sendMessage: vi.fn() },
    runtime: { lastError: undefined },
    alarms,
    storage: {
      local: {
        set: vi.fn((obj: Record<string, any>) => Object.assign(store, obj)),
        get: vi.fn((keys: string[], cb: (d: any) => void) =>
          cb(Object.fromEntries(keys.map((k) => [k, store[k]])))
        ),
      },
    },
  });
  return { store, alarms };
}

describe('publish queue scheduling + persistence', () => {
  beforeEach(() => {
    resetPublishQueueForTest();
    setNowForTest(() => T0);
    setSleepForTest(() => Promise.resolve()); // skip inter-segment gaps
    setBackfillForTest(() => Promise.resolve()); // no real backend call in tests
  });

  afterEach(async () => {
    setSegmentPublisherForTest(null);
    setNowForTest(null);
    setSleepForTest(null);
    setBackfillForTest(null);
    await waitForPublishIdle();
    vi.unstubAllGlobals();
  });

  it('holds a future publishDate task and arms the alarm at its due time', async () => {
    const { alarms } = stubChrome();
    const publish = vi.fn(async () => ({ ok: true, permalink: 'p' }));
    setSegmentPublisherForTest(publish);

    const dueIso = new Date(T0 + 60 * 60 * 1000).toISOString();
    const ack = enqueuePublishBatch(
      'req-1',
      [redditItem('later', { publishDate: dueIso })],
      1
    );
    await waitForPublishIdle();

    expect(ack.accepted[0].publishAt).toBe(dueIso);
    expect(publish).not.toHaveBeenCalled();
    expect(publishQueueSnapshot()[0].status).toBe('queued');
    expect(alarms.create).toHaveBeenCalledWith(PUBLISH_ALARM, {
      when: T0 + 60 * 60 * 1000,
    });

    // Time passes → the alarm fires → the task publishes.
    setNowForTest(() => T0 + 61 * 60 * 1000);
    expect(handlePublishAlarm(PUBLISH_ALARM)).toBe(true);
    expect(handlePublishAlarm('some-other-alarm')).toBe(false);
    await waitForPublishIdle();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publishQueueSnapshot()[0].status).toBe('published');
  });

  it('publishes past/absent publishDate immediately and can cancel scheduled tasks', async () => {
    stubChrome();
    setSegmentPublisherForTest(async () => ({ ok: true, permalink: 'p' }));

    const futureIso = new Date(T0 + 3_600_000).toISOString();
    enqueuePublishBatch(
      'req-1',
      [
        redditItem('now', { publishDate: new Date(T0 - 1000).toISOString() }),
        redditItem('later', { publishDate: futureIso }),
      ],
      1
    );
    await waitForPublishIdle();

    const byId = Object.fromEntries(
      publishQueueSnapshot().map((s) => [s.taskId, s.status])
    );
    expect(byId).toEqual({ now: 'published', later: 'queued' });

    // Scheduled-but-not-due is exactly the cancel window.
    expect(cancelPublishTasks(['later']).canceled).toEqual(['later']);
  });

  it('backfills the DB (taskId, permalink, postId) after a task publishes, and skips it on failure', async () => {
    stubChrome();
    const backfill = vi.fn(async () => {});
    setBackfillForTest(backfill);

    // Success → backfill once with the first segment's permalink + postId.
    setSegmentPublisherForTest(async () => ({ ok: true, permalink: 'https://x.com/p/1', postId: 't3_1' }));
    enqueuePublishBatch('req-ok', [redditItem('ok')], 1);
    await waitForPublishIdle();
    expect(backfill).toHaveBeenCalledTimes(1);
    expect(backfill).toHaveBeenCalledWith('ok', 'https://x.com/p/1', 't3_1');

    // Failure → no backfill (nothing went live, so nothing to record).
    backfill.mockClear();
    setSegmentPublisherForTest(async () => ({ ok: false, error: 'boom' }));
    enqueuePublishBatch('req-err', [redditItem('bad')], 1);
    await waitForPublishIdle();
    expect(backfill).not.toHaveBeenCalled();
    expect(publishQueueSnapshot().find((s) => s.taskId === 'bad')?.status).toBe('error');
  });

  it('stays SENT (not error) when the DB backfill fails, then Sync recovers it to PUBLISHED', async () => {
    stubChrome();
    let backend: 'down' | 'up' = 'down';
    setBackfillForTest(async () => {
      if (backend === 'down') throw new Error('network down');
    });
    setSegmentPublisherForTest(async () => ({ ok: true, permalink: 'p', postId: 't3_1' }));

    enqueuePublishBatch('req-1', [redditItem('live')], 1);
    await waitForPublishIdle();

    // Backfill failed → live on-platform but NOT flipped to error (that would
    // risk a duplicate re-publish). Stays 'sent' with a backfillError.
    const sent = publishQueueSnapshot()[0];
    expect(sent.status).toBe('sent');
    expect(sent.backfillError).toMatch(/network down/);

    // Manual Sync retries the backfill; backend is up now → PUBLISHED.
    backend = 'up';
    const result = await syncPublishTask('live');
    expect(result).toEqual({ ok: true });
    const published = publishQueueSnapshot()[0];
    expect(published.status).toBe('published');
    expect(published.backfillError).toBeUndefined();
  });

  it('Sync is a no-op with a reason for a task that is not sent', async () => {
    stubChrome();
    setSegmentPublisherForTest(async () => ({ ok: true, permalink: 'p' }));
    enqueuePublishBatch('req-1', [redditItem('done')], 1);
    await waitForPublishIdle();
    // Backfill defaulted to no-op resolve → already published.
    expect(publishQueueSnapshot()[0].status).toBe('published');
    expect(await syncPublishTask('done')).toEqual({
      ok: false,
      reason: 'not sent (published)',
    });
    expect(await syncPublishTask('nope')).toEqual({ ok: false, reason: 'not found' });
  });

  it('Retry re-queues a failed task and refuses a partially-posted thread', async () => {
    stubChrome();
    // Single-segment failure → nothing went out (segmentsPublished 0) → retryable.
    setSegmentPublisherForTest(async () => ({ ok: false, error: 'boom' }));
    enqueuePublishBatch('req-1', [redditItem('single')], 1);
    await waitForPublishIdle();
    expect(publishQueueSnapshot()[0].status).toBe('error');

    // Retry: now the publisher succeeds → back through the queue to published.
    setSegmentPublisherForTest(async () => ({ ok: true, permalink: 'p' }));
    expect(retryPublishTask('single')).toEqual({ ok: true });
    await waitForPublishIdle();
    expect(publishQueueSnapshot().find((s) => s.taskId === 'single')?.status).toBe('published');

    // A thread whose first segment posted but a later one failed is NOT safely
    // retryable (would duplicate the live segment).
    let call = 0;
    setSegmentPublisherForTest(async () =>
      call++ === 0 ? { ok: true, permalink: 'p1' } : { ok: false, error: 'seg2 down' }
    );
    enqueuePublishBatch('req-2', [redditItem('thread', { segments: [{ text: 'a' }, { text: 'b' }] })], 1);
    await waitForPublishIdle();
    const thread = publishQueueSnapshot().find((s) => s.taskId === 'thread');
    expect(thread?.status).toBe('error');
    expect(thread?.segmentsPublished).toBe(1);
    expect(retryPublishTask('thread')).toEqual({
      ok: false,
      reason: 'partial thread already posted — cannot safely retry',
    });
  });

  it('Remove drops a settled row but refuses queued/publishing/sent', async () => {
    stubChrome();
    // A failed (error) task can be removed.
    setSegmentPublisherForTest(async () => ({ ok: false, error: 'boom' }));
    enqueuePublishBatch('req-1', [redditItem('bad')], 1);
    await waitForPublishIdle();
    expect(publishQueueSnapshot().some((s) => s.taskId === 'bad')).toBe(true);
    expect(removePublishTask('bad')).toEqual({ ok: true });
    expect(publishQueueSnapshot().some((s) => s.taskId === 'bad')).toBe(false);

    // A queued task cannot be removed (cancel it instead).
    const futureIso = new Date(T0 + 3_600_000).toISOString();
    enqueuePublishBatch('req-2', [redditItem('later', { publishDate: futureIso })], 1);
    await waitForPublishIdle();
    expect(removePublishTask('later')).toEqual({ ok: false, reason: 'cancel it first' });
  });

  it('records the real send time (publishedAt) when an overdue task publishes — not its stale scheduled time', async () => {
    stubChrome();
    setSegmentPublisherForTest(async () => ({ ok: true, permalink: 'p' }));

    // Scheduled an hour in the PAST → overdue → publishes immediately at "now".
    const pastIso = new Date(T0 - 3_600_000).toISOString();
    enqueuePublishBatch('req-1', [redditItem('overdue', { publishDate: pastIso })], 1);
    await waitForPublishIdle();

    const state = publishQueueSnapshot()[0];
    expect(state.status).toBe('published');
    expect(state.publishAt).toBe(pastIso); // scheduled time is preserved…
    expect(state.publishedAt).toBe(new Date(T0).toISOString()); // …but the real send time is now
  });

  it('publishes a scheduled task immediately via publishTaskNow', async () => {
    stubChrome();
    const publish = vi.fn(async () => ({ ok: true, permalink: 'p' }));
    setSegmentPublisherForTest(publish);

    const futureIso = new Date(T0 + 3_600_000).toISOString();
    enqueuePublishBatch('req-1', [redditItem('later', { publishDate: futureIso })], 1);
    await waitForPublishIdle();
    // Not due yet: still queued, scheduled, not published.
    expect(publishQueueSnapshot()[0].status).toBe('queued');
    expect(publishQueueSnapshot()[0].publishAt).toBe(futureIso);
    expect(publish).not.toHaveBeenCalled();

    // "Publish now" makes it due immediately and clears the schedule marker.
    expect(publishTaskNow('later')).toEqual({ ok: true });
    await waitForPublishIdle();
    expect(publish).toHaveBeenCalledTimes(1);
    const state = publishQueueSnapshot()[0];
    expect(state.status).toBe('published');
    expect(state.publishAt).toBeUndefined();
    // publishedAt is the REAL send time (now), NOT the original future schedule —
    // publishing "now" a task scheduled for later records when it actually went out.
    expect(state.publishedAt).toBe(new Date(T0).toISOString());
  });

  it('publishTaskNow is a no-op with a reason for unknown or settled tasks', async () => {
    stubChrome();
    setSegmentPublisherForTest(async () => ({ ok: true, permalink: 'p' }));

    expect(publishTaskNow('nope')).toEqual({ ok: false, reason: 'not found' });

    enqueuePublishBatch('req-1', [redditItem('done')], 1);
    await waitForPublishIdle();
    expect(publishQueueSnapshot()[0].status).toBe('published');
    // Already settled → cannot re-fire.
    expect(publishTaskNow('done')).toEqual({
      ok: false,
      reason: 'not queued (published)',
    });
  });

  it('rejects an unparseable publishDate at enqueue', () => {
    stubChrome();
    const ack = enqueuePublishBatch(
      'req-1',
      [redditItem('bad', { publishDate: 'not-a-date' })],
      1
    );
    expect(ack.rejected).toEqual([
      { taskId: 'bad', reason: 'invalid publishDate (must be an ISO datetime)' },
    ]);
  });

  it('restores persisted tasks after a worker restart and settles interrupted ones', async () => {
    const { store } = stubChrome();
    let release!: () => void;
    setSegmentPublisherForTest(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true, permalink: 'p' });
        })
    );
    enqueuePublishBatch(
      'req-1',
      [
        redditItem('mid-flight'),
        redditItem('scheduled', {
          publishDate: new Date(T0 + 3_600_000).toISOString(),
        }),
      ],
      1
    );
    // 'mid-flight' is now publishing and persisted as such — simulate the SW
    // dying here: reset in-memory state but keep the storage stub's contents.
    expect(store['aisee_publish_queue'].map((r: any) => r.state.status)).toEqual([
      'publishing',
      'queued',
    ]);
    const orphanRelease = release; // settle the orphaned promise after reset
    resetPublishQueueForTest();
    setSegmentPublisherForTest(async () => ({ ok: true, permalink: 'p' }));

    await initPublishQueue();
    await waitForPublishIdle();
    orphanRelease();

    const byId = Object.fromEntries(
      publishQueueSnapshot().map((s) => [s.taskId, s])
    );
    expect(byId['mid-flight'].status).toBe('error');
    expect(byId['mid-flight'].error).toMatch(/interrupted/);
    expect(byId['scheduled'].status).toBe('queued'); // still waiting, not lost
  });

  it('merges persisted tasks with entries enqueued while the restore read was in flight', async () => {
    // Storage already holds a scheduled task from a previous worker life.
    const { store } = stubChrome();
    const scheduledRow = {
      item: redditItem('stored-scheduled', {
        publishDate: new Date(T0 + 3_600_000).toISOString(),
      }),
      state: {
        taskId: 'stored-scheduled',
        platform: 'reddit',
        status: 'queued',
        segmentsTotal: 1,
        segmentsPublished: 0,
        publishAt: new Date(T0 + 3_600_000).toISOString(),
      },
      requestId: 'old-req',
      dueAt: T0 + 3_600_000,
    };
    store['aisee_publish_queue'] = [scheduledRow];
    // Make the restore read ASYNC so an enqueue can slip in between. Like real
    // chrome.storage (ops serialized in call order), the value is snapshotted
    // when get() is CALLED, before any later set() lands.
    (globalThis as any).chrome.storage.local.get = vi.fn(
      (keys: string[], cb: (d: any) => void) => {
        const snapshot = Object.fromEntries(keys.map((k) => [k, store[k]]));
        queueMicrotask(() => cb(snapshot));
      }
    );
    setSegmentPublisherForTest(async () => ({ ok: true, permalink: 'p' }));

    const init = initPublishQueue(); // read in flight…
    enqueuePublishBatch('req-new', [redditItem('fresh')], 1); // …enqueue lands first
    await init;
    await waitForPublishIdle();

    const byId = Object.fromEntries(
      publishQueueSnapshot().map((s) => [s.taskId, s.status])
    );
    // Both survive: the fresh one published, the stored scheduled one intact.
    expect(byId).toEqual({ fresh: 'published', 'stored-scheduled': 'queued' });
    // And the persisted snapshot contains both (no clobbering).
    const persistedIds = store['aisee_publish_queue'].map(
      (r: any) => r.state.taskId
    );
    expect(persistedIds).toContain('stored-scheduled');
    expect(persistedIds).toContain('fresh');
  });

  it('rejects images on non-first segments', () => {
    stubChrome();
    const ack = enqueuePublishBatch(
      'req-1',
      [
        redditItem('img-thread', {
          segments: [
            { text: 'main', images: ['https://api/img1.png'] },
            { text: 'follow-up', images: ['https://api/img2.png'] },
          ],
        }),
      ],
      1
    );
    expect(ack.rejected[0].reason).toMatch(/first segment/);
  });

  it('accepts an image-only first segment (no text)', async () => {
    stubChrome();
    const publish = vi.fn(async () => ({ ok: true, permalink: 'p' }));
    setSegmentPublisherForTest(publish);
    const ack = enqueuePublishBatch(
      'req-1',
      [
        redditItem('img-only', {
          segments: [{ text: '', images: ['https://api/img1.png'] }],
        }),
      ],
      1
    );
    expect(ack.accepted).toHaveLength(1);
    await waitForPublishIdle();
    expect(publish).toHaveBeenCalledTimes(1);
  });
});
