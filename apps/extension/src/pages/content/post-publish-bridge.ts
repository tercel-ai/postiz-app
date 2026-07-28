import { EXTENSION_MESSAGE } from '@gitroom/helpers/extension/brand';
import { ENGAGE_EXTENSION_ACTION } from '@gitroom/extension/utils/executor/actions';

/**
 * Bridge for the batch post-publish flow. Three page → extension requests
 * (enqueue / cancel / queue-status, each answered with its *-result message)
 * plus a service-worker → page push channel for per-task progress. See
 * @gitroom/helpers/extension/post-publish for the payload shapes and the
 * page-side helpers.
 */
const LOG = '[aisee-publish:bridge]';

export function installPostPublishBridge(): void {
  // eslint-disable-next-line no-console
  console.log(LOG, 'installed on', window.location.origin);
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
            // DEMOTED to a pure SYNC TRIGGER. The DB QUEUE is the single source
            // of truth now: the page schedules via POST /posts/schedule first,
            // then sends this message only to make the extension pull publish-due
            // IMMEDIATELY (instead of waiting for the 1-min poll). Any `items` the
            // page sends are IGNORED — the extension no longer takes its work from
            // the page payload, it pulls the due posts from the backend.
            swMessage: {
              action: ENGAGE_EXTENSION_ACTION.runPublishDue,
              requestId: data.requestId,
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

    // eslint-disable-next-line no-console
    console.log(LOG, 'page → SW', {
      action: data.action,
      requestId: data.requestId,
      items: Array.isArray(data.items) ? data.items.length : undefined,
      taskIds: data.taskIds,
    });

    const replyToPage = (payload: Record<string, unknown>) => {
      window.postMessage(
        {
          source: EXTENSION_MESSAGE.resultSource,
          action: route.resultAction,
          requestId: data.requestId,
          ...payload,
        },
        event.origin
      );
    };

    // chrome.runtime.sendMessage can THROW SYNCHRONOUSLY when this content
    // script has been orphaned — the extension was reloaded/updated while this
    // page stayed open, invalidating chrome.runtime ("Extension context
    // invalidated"). In the callback form the callback never fires on a
    // synchronous throw, so without this guard the page gets NO reply and just
    // waits out its timeout (and the message never reaches the service worker —
    // hence no queue record). The engage-reply bridge avoids this by awaiting in
    // a try/catch; mirror that here so a dead context surfaces instantly and
    // actionably instead of as a mysterious timeout.
    try {
      chrome.runtime.sendMessage(route.swMessage, (response) => {
        const runtimeError = chrome.runtime.lastError?.message;
        // eslint-disable-next-line no-console
        console.log(LOG, 'SW → page', {
          action: route.resultAction,
          requestId: data.requestId,
          runtimeError,
          response,
        });
        replyToPage(
          runtimeError
            ? { ok: false, error: runtimeError }
            : response ?? { ok: false, error: 'No extension response' }
        );
      });
    } catch (e: any) {
      const message = String(e?.message || e);
      // eslint-disable-next-line no-console
      console.log(LOG, 'sendMessage threw (context invalidated?)', message);
      replyToPage({
        ok: false,
        error: /context invalidated/i.test(message)
          ? 'The extension was reloaded. Refresh this page and try again.'
          : message,
      });
    }
  });

  // SW → page: per-task progress pushed while the queue drains.
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.action !== ENGAGE_EXTENSION_ACTION.publishProgressPush) return;
    // eslint-disable-next-line no-console
    console.log(LOG, 'progress push → page', {
      requestId: message.requestId,
      taskId: message.state?.taskId,
      status: message.state?.status,
    });
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
