import { EXTENSION_MESSAGE } from '@gitroom/helpers/extension/brand';
import { ENGAGE_EXTENSION_ACTION } from '@gitroom/extension/utils/executor/actions';

/**
 * Bridge for the batch post-publish flow. Three page → extension requests
 * (enqueue / cancel / queue-status, each answered with its *-result message)
 * plus a service-worker → page push channel for per-task progress. See
 * @gitroom/helpers/extension/post-publish for the payload shapes and the
 * page-side helpers.
 */
export function installPostPublishBridge(): void {
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== window.location.origin)
      return;
    const data = event.data as {
      source?: string;
      action?: string;
      requestId?: string;
      items?: unknown;
      taskIds?: unknown;
    };
    if (data?.source !== EXTENSION_MESSAGE.source || !data.requestId) return;

    const route =
      data.action === EXTENSION_MESSAGE.postPublish
        ? {
            swMessage: {
              action: ENGAGE_EXTENSION_ACTION.publishEnqueue,
              requestId: data.requestId,
              items: Array.isArray(data.items) ? data.items : [],
            },
            resultAction: EXTENSION_MESSAGE.postPublishResult,
          }
        : data.action === EXTENSION_MESSAGE.postPublishCancel
        ? {
            swMessage: {
              action: ENGAGE_EXTENSION_ACTION.publishCancel,
              taskIds: Array.isArray(data.taskIds) ? data.taskIds : [],
            },
            resultAction: EXTENSION_MESSAGE.postPublishCancelResult,
          }
        : data.action === EXTENSION_MESSAGE.postPublishStatus
        ? {
            swMessage: { action: ENGAGE_EXTENSION_ACTION.publishStatus },
            resultAction: EXTENSION_MESSAGE.postPublishStatusResult,
          }
        : null;
    if (!route) return;

    chrome.runtime.sendMessage(route.swMessage, (response) => {
      const runtimeError = chrome.runtime.lastError?.message;
      window.postMessage(
        {
          source: EXTENSION_MESSAGE.resultSource,
          action: route.resultAction,
          requestId: data.requestId,
          ...(runtimeError
            ? { ok: false, error: runtimeError }
            : response ?? { ok: false, error: 'No extension response' }),
        },
        event.origin
      );
    });
  });

  // SW → page: per-task progress pushed while the queue drains.
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.action !== ENGAGE_EXTENSION_ACTION.publishProgressPush) return;
    window.postMessage(
      {
        source: EXTENSION_MESSAGE.resultSource,
        action: EXTENSION_MESSAGE.postPublishProgress,
        requestId: message.requestId,
        state: message.state,
      },
      window.location.origin
    );
  });
}
