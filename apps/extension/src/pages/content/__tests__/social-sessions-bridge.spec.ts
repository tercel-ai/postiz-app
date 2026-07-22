// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EXTENSION_MESSAGE } from '@gitroom/helpers/extension/brand';
import { installSocialSessionsBridge } from '../social-sessions-bridge';

describe('Social-sessions extension protocol', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('forwards a same-origin probe and echoes the session snapshot back', () => {
    const sessions = {
      x: { loggedIn: true, userId: '1234567890' },
      reddit: { loggedIn: true, id: 't2_abc' },
    };
    const sendMessage = vi.fn((_message, callback) => {
      callback({ ok: true, sessions });
    });
    vi.stubGlobal('chrome', { runtime: { sendMessage, lastError: undefined } });
    const postMessage = vi.spyOn(window, 'postMessage');
    installSocialSessionsBridge();

    window.dispatchEvent(new MessageEvent('message', {
      source: window,
      origin: window.location.origin,
      data: {
        source: EXTENSION_MESSAGE.source,
        action: EXTENSION_MESSAGE.socialSessions,
        requestId: 'req-1',
      },
    }));

    expect(sendMessage).toHaveBeenCalledWith(
      { action: 'social:sessions' },
      expect.any(Function)
    );
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        source: EXTENSION_MESSAGE.resultSource,
        action: EXTENSION_MESSAGE.socialSessionsResult,
        requestId: 'req-1',
        ok: true,
        sessions,
      }),
      window.location.origin
    );
  });

  it('ignores probes without a requestId', () => {
    const sendMessage = vi.fn();
    vi.stubGlobal('chrome', { runtime: { sendMessage, lastError: undefined } });
    installSocialSessionsBridge();

    window.dispatchEvent(new MessageEvent('message', {
      source: window,
      origin: window.location.origin,
      data: {
        source: EXTENSION_MESSAGE.source,
        action: EXTENSION_MESSAGE.socialSessions,
      },
    }));

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('reports a runtime error when the extension does not answer', () => {
    const sendMessage = vi.fn((_message, callback) => {
      callback(undefined);
    });
    vi.stubGlobal('chrome', {
      runtime: { sendMessage, lastError: { message: 'no receiver' } },
    });
    const postMessage = vi.spyOn(window, 'postMessage');
    installSocialSessionsBridge();

    window.dispatchEvent(new MessageEvent('message', {
      source: window,
      origin: window.location.origin,
      data: {
        source: EXTENSION_MESSAGE.source,
        action: EXTENSION_MESSAGE.socialSessions,
        requestId: 'req-err',
      },
    }));

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        source: EXTENSION_MESSAGE.resultSource,
        action: EXTENSION_MESSAGE.socialSessionsResult,
        requestId: 'req-err',
        ok: false,
        error: 'no receiver',
      }),
      window.location.origin
    );
  });
});
