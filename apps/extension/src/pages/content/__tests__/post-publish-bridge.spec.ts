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

  it('routes enqueue requests and echoes the ack with the requestId', () => {
    const ack = { ok: true, accepted: [{ taskId: 'a', status: 'queued' }], rejected: [] };
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
        items,
      })
    );

    expect(sendMessage).toHaveBeenCalledWith(
      { action: 'publish:enqueue', requestId: 'req-1', items },
      expect.any(Function)
    );
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        source: EXTENSION_MESSAGE.resultSource,
        action: EXTENSION_MESSAGE.postPublishResult,
        requestId: 'req-1',
        ok: true,
        accepted: ack.accepted,
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
