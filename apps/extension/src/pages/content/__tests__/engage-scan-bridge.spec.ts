// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EXTENSION_MESSAGE } from '@gitroom/helpers/extension/brand';
import { installEngageScanBridge } from '../engage-scan-bridge';

describe('Engage scan extension protocol', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('defines one request/response pair shared by the web app and extension', () => {
    expect(EXTENSION_MESSAGE.engageScan).toBe('aisee:engage-scan');
    expect(EXTENSION_MESSAGE.engageScanResult).toBe('aisee:engage-scan-result');
  });

  it('forwards a same-origin page request to the formal background scan action', () => {
    const sendMessage = vi.fn((_message, callback) => {
      callback({ ok: true, summary: { units: 2, posts: 5, accepted: 3 } });
    });
    vi.stubGlobal('chrome', {
      runtime: { sendMessage, lastError: undefined },
    });
    const postMessage = vi.spyOn(window, 'postMessage');
    installEngageScanBridge();

    window.dispatchEvent(
      new MessageEvent('message', {
        source: window,
        origin: window.location.origin,
        data: {
          source: EXTENSION_MESSAGE.source,
          action: EXTENSION_MESSAGE.engageScan,
          requestId: 'req-1',
        },
      })
    );

    expect(sendMessage).toHaveBeenCalledWith(
      { action: 'engage:scan' },
      expect.any(Function)
    );
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        source: EXTENSION_MESSAGE.resultSource,
        action: EXTENSION_MESSAGE.engageScanResult,
        requestId: 'req-1',
        ok: true,
      }),
      window.location.origin
    );
  });
});
