// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EXTENSION_MESSAGE } from '@gitroom/helpers/extension/brand';
import { installPostsMetricsRefreshBridge } from '../posts-metrics-refresh-bridge';

describe('Posts metrics-refresh extension protocol', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('forwards a same-origin batch request to the background due-metrics runner', () => {
    const summary = { due: 2, fetched: 2, ingested: 2, stoppedReason: 'ok' };
    const sendMessage = vi.fn((_message, callback) => {
      callback({ ok: true, summary });
    });
    vi.stubGlobal('chrome', { runtime: { sendMessage, lastError: undefined } });
    const postMessage = vi.spyOn(window, 'postMessage');
    installPostsMetricsRefreshBridge();

    window.dispatchEvent(new MessageEvent('message', {
      source: window,
      origin: window.location.origin,
      data: {
        source: EXTENSION_MESSAGE.source,
        action: EXTENSION_MESSAGE.postsMetricsRefresh,
        requestId: 'req-1',
        ids: ['post-1', 'post-2'],
      },
    }));

    expect(sendMessage).toHaveBeenCalledWith(
      { action: 'engage:metrics', ids: ['post-1', 'post-2'] },
      expect.any(Function)
    );
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        source: EXTENSION_MESSAGE.resultSource,
        action: EXTENSION_MESSAGE.postsMetricsRefreshResult,
        requestId: 'req-1',
        ok: true,
        summary,
      }),
      window.location.origin
    );
  });

  it('ignores messages missing ids by forwarding an empty array', () => {
    const sendMessage = vi.fn((_message, callback) => {
      callback({ ok: true, summary: { due: 0, fetched: 0, ingested: 0, stoppedReason: 'no-ids' } });
    });
    vi.stubGlobal('chrome', { runtime: { sendMessage, lastError: undefined } });
    installPostsMetricsRefreshBridge();

    window.dispatchEvent(new MessageEvent('message', {
      source: window,
      origin: window.location.origin,
      data: {
        source: EXTENSION_MESSAGE.source,
        action: EXTENSION_MESSAGE.postsMetricsRefresh,
        requestId: 'req-2',
      },
    }));

    expect(sendMessage).toHaveBeenCalledWith(
      { action: 'engage:metrics', ids: [] },
      expect.any(Function)
    );
  });
});
