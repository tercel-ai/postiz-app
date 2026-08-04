import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublishPostItem } from '@gitroom/helpers/extension/post-publish';
import {
  enqueuePublishBatch,
  publishQueueSnapshot,
  resetPublishQueueForTest,
  setBackfillForTest,
  setFailureReporterForTest,
  setSegmentPublisherForTest,
  setSleepForTest,
  waitForPublishIdle,
} from '../queue';

const item = (extra: Partial<PublishPostItem>): PublishPostItem => ({
  taskId: extra.taskId || 't1',
  platform: 'hackernews',
  title: 'T',
  segments: [{ text: 'body' }],
  ...extra,
});

describe('publish queue — no-permalink false-success guard', () => {
  const backfill = vi.fn().mockResolvedValue(undefined);
  const reportFailure = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    resetPublishQueueForTest();
    setSleepForTest(() => Promise.resolve());
    setBackfillForTest(backfill);
    setFailureReporterForTest(reportFailure);
    vi.stubGlobal('chrome', {
      tabs: { sendMessage: vi.fn() },
      runtime: { lastError: undefined },
    });
    backfill.mockClear();
    reportFailure.mockClear();
  });
  afterEach(async () => {
    setSegmentPublisherForTest(null);
    setSleepForTest(null);
    setBackfillForTest(null);
    setFailureReporterForTest(null);
    await waitForPublishIdle();
    vi.unstubAllGlobals();
  });

  it('settles error (never PUBLISHED) when a verifiable platform yields no permalink', async () => {
    // A hackernews "success" with no permalink means the send was never
    // verified — flipping the DB row PUBLISHED here was the false-success bug.
    setSegmentPublisherForTest(async () => ({ ok: true }));

    enqueuePublishBatch('req', [item({ taskId: 'hn1' })], undefined);
    await waitForPublishIdle();

    const state = publishQueueSnapshot().find((s) => s.taskId === 'hn1');
    expect(state?.status).toBe('error');
    expect(state?.error).toMatch(/could not be verified/i);
    expect(backfill).not.toHaveBeenCalled();
    expect(reportFailure).toHaveBeenCalledWith(
      'hn1',
      expect.stringMatching(/could not be verified/i)
    );
  });

  it('still allows a confirmed URL-less publish on quora', async () => {
    // Quora's poster positively confirms the send but genuinely cannot always
    // recover the URL — the one legitimate URL-less PUBLISHED case.
    setSegmentPublisherForTest(async () => ({ ok: true }));

    enqueuePublishBatch(
      'req2',
      [item({ taskId: 'q1', platform: 'quora', title: '' })],
      undefined
    );
    await waitForPublishIdle();

    const state = publishQueueSnapshot().find((s) => s.taskId === 'q1');
    expect(state?.status).toBe('published');
    expect(backfill).toHaveBeenCalledWith('q1', '', undefined);
    expect(reportFailure).not.toHaveBeenCalled();
  });

  it('reports the failure to the backend when the platform send fails outright', async () => {
    setSegmentPublisherForTest(async () => ({
      ok: false,
      error: 'HN rejected the submission',
    }));

    enqueuePublishBatch('req3', [item({ taskId: 'hn2' })], undefined);
    await waitForPublishIdle();

    const state = publishQueueSnapshot().find((s) => s.taskId === 'hn2');
    expect(state?.status).toBe('error');
    expect(reportFailure).toHaveBeenCalledWith(
      'hn2',
      'HN rejected the submission'
    );
  });
});
