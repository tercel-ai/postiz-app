import { EXTENSION_MESSAGE } from '@gitroom/helpers/extension/brand';
import { ENGAGE_EXTENSION_ACTION } from '@gitroom/extension/utils/executor/actions';

/**
 * Let the authenticated web app tell the extension which post ids are
 * currently on screen (calendar table, engage sent list, etc. — own posts and
 * Engage replies are both Post rows) so it can run its demand-driven metrics
 * check for them: `POST /posts/metrics/due` → session-fetch the due ones →
 * `POST /posts/metrics/ingest`. Batched sibling of `installPostMetricsBridge`
 * (which scrapes exactly one post by releaseURL); this one delegates the
 * whole due-gate + fetch + ingest pipeline to `runMetrics` and only echoes
 * back the run summary — the page re-reads its list to see new values.
 */
export function installPostsMetricsRefreshBridge(): void {
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== window.location.origin)
      return;
    const data = event.data as {
      source?: string;
      action?: string;
      requestId?: string;
      ids?: string[];
    };
    if (data?.source !== EXTENSION_MESSAGE.source) return;
    if (data.action !== EXTENSION_MESSAGE.postsMetricsRefresh || !data.requestId)
      return;

    chrome.runtime.sendMessage(
      {
        action: ENGAGE_EXTENSION_ACTION.runMetrics,
        ids: Array.isArray(data.ids) ? data.ids : [],
      },
      (response) => {
        const runtimeError = chrome.runtime.lastError?.message;
        window.postMessage(
          {
            source: EXTENSION_MESSAGE.resultSource,
            action: EXTENSION_MESSAGE.postsMetricsRefreshResult,
            requestId: data.requestId,
            ...(runtimeError
              ? { ok: false, error: runtimeError }
              : response ?? { ok: false, error: 'No extension response' }),
          },
          event.origin
        );
      }
    );
  });
}
