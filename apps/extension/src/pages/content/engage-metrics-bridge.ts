import { EXTENSION_MESSAGE } from '@gitroom/helpers/extension/brand';
import { ENGAGE_EXTENSION_ACTION } from '@gitroom/extension/utils/executor/actions';

/**
 * Let the authenticated web app ask the extension to scrape ONE published
 * reply's own metrics (the "Engagements" affordance on the Replies page). The
 * page sends { platform, releaseURL } with a requestId; we forward it to the
 * service worker and echo the raw counters (or an error) back, tagged with the
 * same requestId so concurrent cards can't cross their responses.
 *
 * Same hardening as the scan bridge: same-window, same-origin protocol messages
 * only.
 */
export function installEngageMetricsBridge(): void {
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== window.location.origin)
      return;
    const data = event.data as {
      source?: string;
      action?: string;
      requestId?: string;
      platform?: string;
      releaseURL?: string;
    };
    if (data?.source !== EXTENSION_MESSAGE.source) return;
    if (data.action !== EXTENSION_MESSAGE.engageMetrics || !data.requestId)
      return;

    chrome.runtime.sendMessage(
      {
        action: ENGAGE_EXTENSION_ACTION.fetchReplyMetrics,
        platform: data.platform,
        releaseURL: data.releaseURL,
      },
      (response) => {
        const runtimeError = chrome.runtime.lastError?.message;
        window.postMessage(
          {
            source: EXTENSION_MESSAGE.resultSource,
            action: EXTENSION_MESSAGE.engageMetricsResult,
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
