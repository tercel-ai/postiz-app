import { EXTENSION_MESSAGE } from '@gitroom/helpers/extension/brand';
import { ENGAGE_EXTENSION_ACTION } from '@gitroom/extension/utils/executor/actions';

export function installPostMetricsBridge(): void {
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const data = event.data as {
      source?: string;
      action?: string;
      requestId?: string;
      platform?: string;
      releaseURL?: string;
    };
    if (data?.source !== EXTENSION_MESSAGE.source) return;
    if (data.action !== EXTENSION_MESSAGE.postMetrics || !data.requestId) return;

    chrome.runtime.sendMessage(
      {
        action: ENGAGE_EXTENSION_ACTION.fetchPostMetrics,
        platform: data.platform,
        releaseURL: data.releaseURL,
      },
      (response) => {
        const runtimeError = chrome.runtime.lastError?.message;
        window.postMessage(
          {
            source: EXTENSION_MESSAGE.resultSource,
            action: EXTENSION_MESSAGE.postMetricsResult,
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
