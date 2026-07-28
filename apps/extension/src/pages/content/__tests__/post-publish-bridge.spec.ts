// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EXTENSION_MESSAGE } from '@gitroom/helpers/extension/brand';
import { installPostPublishBridge } from '../post-publish-bridge';

function stubChrome(sendMessage: any) {
  const listeners: Array<(msg: any) => void> = [];
  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage,
      lastError: undefined,
      onMessage: { addListener: (fn: any) => listeners.push(fn) },
    },
  });
  return listeners;
}

const pageMessage = (data: object) =>
  new MessageEvent('message', {
    source: window,
    origin: window.location.origin,
    data,
  });

describe('Post-publish extension protocol', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('demotes post-publish to a pure sync trigger (runs publish-due, ignores items)', () => {
    // The message is now just a trigger: it forwards runPublishDue with NO items
    // (the extension pulls its work from the backend), and echoes the pull summary.
    const ack = { ok: true, summary: { due: 2, enqueued: 2, rejected: 0, stoppedReason: 'ok' } };
    const sendMessage = vi.fn((_m, cb) => cb(ack));
    stubChrome(sendMessage);
    const postMessage = vi.spyOn(window, 'postMessage');
    installPostPublishBridge();

    const items = [{ taskId: 'a', platform: 'reddit', segments: [{ text: 'hi' }] }];
    window.dispatchEvent(
      pageMessage({
        source: EXTENSION_MESSAGE.source,
        action: EXTENSION_MESSAGE.postPublish,
        requestId: 'req-1',
        items, // still accepted on the wire, but must be ignored
      })
    );

    // Routed to the publish-due trigger, and the ignored `items` are NOT forwarded.
    expect(sendMessage).toHaveBeenCalledWith(
      { action: 'posts:run-publish-due', requestId: 'req-1' },
      expect.any(Function)
    );
    expect(sendMessage.mock.calls[0][0]).not.toHaveProperty('items');
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        source: EXTENSION_MESSAGE.resultSource,
        action: EXTENSION_MESSAGE.postPublishResult,
        requestId: 'req-1',
        ok: true,
        summary: ack.summary,
      }),
      window.location.origin
    );
  });

  it('routes cancel and status requests to their own actions', () => {
    const sendMessage = vi.fn((_m, cb) => cb({ ok: true, canceled: [], notCancelable: [], states: [] }));
    stubChrome(sendMessage);
    installPostPublishBridge();

    window.dispatchEvent(
      pageMessage({
        source: EXTENSION_MESSAGE.source,
        action: EXTENSION_MESSAGE.postPublishCancel,
        requestId: 'req-2',
        taskIds: ['a', 'b'],
      })
    );
    window.dispatchEvent(
      pageMessage({
        source: EXTENSION_MESSAGE.source,
        action: EXTENSION_MESSAGE.postPublishStatus,
        requestId: 'req-3',
      })
    );

    expect(sendMessage).toHaveBeenCalledWith(
      { action: 'publish:cancel', taskIds: ['a', 'b'] },
      expect.any(Function)
    );
    expect(sendMessage).toHaveBeenCalledWith(
      { action: 'publish:status' },
      expect.any(Function)
    );
  });

  it('forwards SW progress pushes to the page', () => {
    const listeners = stubChrome(vi.fn());
    const postMessage = vi.spyOn(window, 'postMessage');
    installPostPublishBridge();

    const state = { taskId: 'a', status: 'publishing', segmentsPublished: 0, segmentsTotal: 2 };
    listeners.forEach((fn) =>
      fn({ action: 'publish:progress-push', requestId: 'req-1', state })
    );

    expect(postMessage).toHaveBeenCalledWith(
      {
        source: EXTENSION_MESSAGE.resultSource,
        action: EXTENSION_MESSAGE.postPublishProgress,
        requestId: 'req-1',
        state,
      },
      window.location.origin
    );
  });

  it('replies with an actionable error when sendMessage throws synchronously (orphaned context)', () => {
    // The classic dev pitfall: the extension was reloaded while this page stayed
    // open, so chrome.runtime is invalidated and sendMessage THROWS synchronously
    // (the callback never fires). Without the guard the page would just time out.
    const sendMessage = vi.fn(() => {
      throw new Error('Extension context invalidated.');
    });
    stubChrome(sendMessage);
    const postMessage = vi.spyOn(window, 'postMessage');
    installPostPublishBridge();

    window.dispatchEvent(
      pageMessage({
        source: EXTENSION_MESSAGE.source,
        action: EXTENSION_MESSAGE.postPublish,
        requestId: 'req-dead',
        items: [],
      })
    );

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        source: EXTENSION_MESSAGE.resultSource,
        action: EXTENSION_MESSAGE.postPublishResult,
        requestId: 'req-dead',
        ok: false,
        error: 'The extension was reloaded. Refresh this page and try again.',
      }),
      window.location.origin
    );
  });

  it('reports a runtime error when the extension does not answer', () => {
    const sendMessage = vi.fn((_m, cb) => cb(undefined));
    stubChrome(sendMessage);
    (globalThis as any).chrome.runtime.lastError = { message: 'no receiver' };
    const postMessage = vi.spyOn(window, 'postMessage');
    installPostPublishBridge();

    window.dispatchEvent(
      pageMessage({
        source: EXTENSION_MESSAGE.source,
        action: EXTENSION_MESSAGE.postPublish,
        requestId: 'req-err',
        items: [],
      })
    );

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        action: EXTENSION_MESSAGE.postPublishResult,
        requestId: 'req-err',
        ok: false,
        error: 'no receiver',
      }),
      window.location.origin
    );
  });
});
