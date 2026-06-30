// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EXTENSION_MESSAGE } from '@gitroom/helpers/extension/brand';
import { installPostMetricsBridge } from '../post-metrics-bridge';

describe('Post metrics extension protocol', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('forwards a same-origin post request to the background fetch action', () => {
    const sendMessage = vi.fn((_message, callback) => {
      callback({ ok: true, analytics: [{ label: 'likes', data: [] }] });
    });
    vi.stubGlobal('chrome', { runtime: { sendMessage, lastError: undefined } });
    const postMessage = vi.spyOn(window, 'postMessage');
    installPostMetricsBridge();

    window.dispatchEvent(new MessageEvent('message', {
      source: window,
      origin: window.location.origin,
      data: {
        source: EXTENSION_MESSAGE.source,
        action: EXTENSION_MESSAGE.postMetrics,
        requestId: 'req-1',
        platform: 'x',
        releaseURL: 'https://x.com/a/status/1',
      },
    }));

    expect(sendMessage).toHaveBeenCalledWith(
      {
        action: 'posts:fetch-metrics',
        platform: 'x',
        releaseURL: 'https://x.com/a/status/1',
      },
      expect.any(Function)
    );
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        source: EXTENSION_MESSAGE.resultSource,
        action: EXTENSION_MESSAGE.postMetricsResult,
        requestId: 'req-1',
        ok: true,
      }),
      window.location.origin
    );
  });
});
