// The wrong-account guard as the DRAIN sees it: a mismatched post must settle
// as an error with NOTHING sent. Unit-testing the guard alone is not enough —
// the property that matters is that the segment publisher is never reached, and
// only the drain can show that.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@gitroom/extension/utils/social-sessions', () => ({
  probeSessionAccount: vi.fn(),
}));

import { probeSessionAccount } from '@gitroom/extension/utils/social-sessions';
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

const probe = vi.mocked(probeSessionAccount);

const redditItem = (
  taskId: string,
  extra: Partial<PublishPostItem> = {}
): PublishPostItem => ({
  taskId,
  platform: 'reddit',
  segments: [{ text: 'post body' }],
  subreddit: 'r/test',
  title: 'A title',
  ...extra,
});

describe('publish queue — wrong-account guard', () => {
  beforeEach(() => {
    probe.mockReset();
    resetPublishQueueForTest();
    setSleepForTest(() => Promise.resolve());
    setBackfillForTest(() => Promise.resolve());
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

  it('does not publish a single segment when the session is another account', async () => {
    probe.mockResolvedValue({ supported: true, loggedIn: true, id: 't2_other' });
    const publisher = vi.fn(async () => ({ ok: true, permalink: 'p' }));
    setSegmentPublisherForTest(publisher);

    enqueuePublishBatch(
      'req-1',
      [redditItem('post-1', { targetAccount: { id: 'mine', handle: 'alice' } })],
      undefined
    );
    await waitForPublishIdle();

    // The whole point: nothing reached the platform.
    expect(publisher).not.toHaveBeenCalled();
    const [state] = publishQueueSnapshot();
    expect(state.status).toBe('error');
    expect(state.error).toContain('Wrong reddit account');
    expect(state.segmentsPublished).toBe(0);
  });

  it('publishes normally when the session is the intended account', async () => {
    // Integration stores the bare id, the session reports the t2_ fullname —
    // the same account, and it must not be mistaken for a mismatch.
    probe.mockResolvedValue({
      supported: true,
      loggedIn: true,
      id: 't2_abc123',
    });
    const publisher = vi.fn(async () => ({ ok: true, permalink: 'p' }));
    setSegmentPublisherForTest(publisher);

    enqueuePublishBatch(
      'req-2',
      [redditItem('post-2', { targetAccount: { id: 'abc123' } })],
      undefined
    );
    await waitForPublishIdle();

    expect(publisher).toHaveBeenCalledTimes(1);
    expect(publishQueueSnapshot()[0].status).toBe('published');
  });

  it('never probes — or blocks — a post with no bound account', async () => {
    const publisher = vi.fn(async () => ({ ok: true, permalink: 'p' }));
    setSegmentPublisherForTest(publisher);

    enqueuePublishBatch('req-3', [redditItem('post-3')], undefined);
    await waitForPublishIdle();

    expect(publisher).toHaveBeenCalledTimes(1);
    expect(probe).not.toHaveBeenCalled();
    expect(publishQueueSnapshot()[0].status).toBe('published');
  });

  it('blocks a mismatched post without stalling the rest of the queue', async () => {
    probe.mockImplementation(async (platform: string) =>
      platform === 'reddit'
        ? { supported: true, loggedIn: true, id: 't2_other' }
        : { supported: true, loggedIn: true, id: '1234567890' }
    );
    const publisher = vi.fn(async () => ({ ok: true, permalink: 'p' }));
    setSegmentPublisherForTest(publisher);

    enqueuePublishBatch(
      'req-4',
      [
        redditItem('bad', { targetAccount: { id: 'mine' } }),
        {
          ...redditItem('good'),
          platform: 'x',
          subreddit: undefined,
          title: undefined,
          targetAccount: { id: '1234567890' },
        },
      ],
      undefined
    );
    await waitForPublishIdle();

    const byId = Object.fromEntries(
      publishQueueSnapshot().map((s) => [s.taskId, s])
    );
    expect(byId['bad'].status).toBe('error');
    expect(byId['good'].status).toBe('published');
    expect(publisher).toHaveBeenCalledTimes(1);
  });

  it('publishes unverified — and says so — when the probe throws', async () => {
    // A probe failure is not evidence of a mismatch, so the post goes out. But
    // it goes out UNVERIFIED, and a wrong-account publish is irreversible and
    // only ever reported after the fact — so the log has to distinguish this
    // from a real match, or the guard's participation is unknowable.
    probe.mockRejectedValue(new Error('cookies API unavailable'));
    const publisher = vi.fn(async () => ({ ok: true, permalink: 'p' }));
    setSegmentPublisherForTest(publisher);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    enqueuePublishBatch(
      'req-5',
      [redditItem('unverified', { targetAccount: { id: 'mine' } })],
      undefined
    );
    await waitForPublishIdle();

    expect(publisher).toHaveBeenCalledTimes(1);
    expect(publishQueueSnapshot()[0].status).toBe('published');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('publishing unverified'),
      expect.objectContaining({ taskId: 'unverified', platform: 'reddit' }),
      expect.any(Error)
    );
    warn.mockRestore();
  });

  it('settles a task whose publish throws unexpectedly and keeps draining', async () => {
    // Anything escaping the per-entry work would leave the task at 'publishing'
    // — a status cancel/remove/retry all refuse to act on, so it could never be
    // cleared — AND abandon every other due task in the same drain.
    probe.mockResolvedValue({ supported: true, loggedIn: true, id: 'mine' });
    setSegmentPublisherForTest(async () => ({ ok: true, permalink: 'p' }));
    // The inter-segment pause is awaited OUTSIDE the segment loop's own
    // try/catch, so a throw there escapes the whole entry — unlike a poster
    // failure or a backfill failure, both of which are already handled.
    setSleepForTest(() => {
      throw new Error('alarm subsystem gone');
    });

    enqueuePublishBatch(
      'req-6',
      [
        redditItem('boom', {
          segments: [{ text: 'one' }, { text: 'two' }],
          segmentGapSeconds: [1, 1],
        }),
        redditItem('after'),
      ],
      undefined
    );
    await waitForPublishIdle();

    const byId = Object.fromEntries(
      publishQueueSnapshot().map((s) => [s.taskId, s])
    );
    // Settled, not wedged: 'publishing' is a status cancel/remove/retry all
    // refuse to act on, so the row could never be cleared.
    expect(byId['boom'].status).toBe('error');
    expect(byId['boom'].error).toMatch(/unexpected publish failure/);
    // And the queue kept going — the second task is unaffected.
    expect(byId['after'].status).toBe('published');
  });
});
