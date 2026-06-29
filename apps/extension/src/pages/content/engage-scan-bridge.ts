import { EXTENSION_MESSAGE } from '@gitroom/helpers/extension/brand';
import { ENGAGE_EXTENSION_ACTION } from '@gitroom/extension/utils/executor/actions';

/**
 * Let the authenticated web app run the extension's formal automated scan loop.
 * The content script accepts only same-window, same-origin protocol messages.
 */
export function installEngageScanBridge(): void {
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== window.location.origin)
      return;
    const data = event.data as {
      source?: string;
      action?: string;
      requestId?: string;
    };
    if (data?.source !== EXTENSION_MESSAGE.source) return;
    if (data.action !== EXTENSION_MESSAGE.engageScan || !data.requestId) return;

    chrome.runtime.sendMessage(
      { action: ENGAGE_EXTENSION_ACTION.runScan },
      (response) => {
        const runtimeError = chrome.runtime.lastError?.message;
        window.postMessage(
          {
            source: EXTENSION_MESSAGE.resultSource,
            action: EXTENSION_MESSAGE.engageScanResult,
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
