// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EXTENSION_MESSAGE } from '@gitroom/helpers/extension/brand';
import { installPingBridge } from '../ping-bridge';

describe('Ping/pong presence protocol', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('answers a ping synchronously without touching the service worker', () => {
    const sendMessage = vi.fn();
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage,
        lastError: undefined,
        getManifest: () => ({ version: '1.3.0' }),
      },
    });
    const postMessage = vi.spyOn(window, 'postMessage');
    installPingBridge();

    window.dispatchEvent(
      new MessageEvent('message', {
        source: window,
        origin: window.location.origin,
        data: { source: EXTENSION_MESSAGE.source, action: EXTENSION_MESSAGE.ping },
      })
    );

    expect(sendMessage).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith(
      {
        source: EXTENSION_MESSAGE.resultSource,
        action: EXTENSION_MESSAGE.pong,
        version: '1.3.0',
      },
      window.location.origin
    );
  });
});
