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
        stale: false,
      },
      window.location.origin
    );
  });

  // Regression: reading the manifest throws once this content script has been
  // orphaned (extension reloaded/rebuilt while the page stayed open). That throw
  // used to escape the listener, so no pong was ever sent and the web app
  // concluded the extension was not installed — showing "Install the AIsee
  // extension" to users who already had it. Answer with stale:true instead.
  it('still answers with stale:true when the extension context is invalidated', () => {
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage: vi.fn(),
        lastError: undefined,
        getManifest: () => {
          throw new Error('Extension context invalidated.');
        },
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

    expect(postMessage).toHaveBeenCalledWith(
      {
        source: EXTENSION_MESSAGE.resultSource,
        action: EXTENSION_MESSAGE.pong,
        version: undefined,
        stale: true,
      },
      window.location.origin
    );
  });
});
