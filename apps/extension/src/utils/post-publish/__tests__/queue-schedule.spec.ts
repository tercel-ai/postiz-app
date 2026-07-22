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
  resetPublishQueueForTest,
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
  });

  afterEach(async () => {
    setSegmentPublisherForTest(null);
    setNowForTest(null);
    setSleepForTest(null);
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
