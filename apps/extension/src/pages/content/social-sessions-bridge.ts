import { EXTENSION_MESSAGE } from '@gitroom/helpers/extension/brand';
import { ENGAGE_EXTENSION_ACTION } from '@gitroom/extension/utils/executor/actions';

/**
 * Let the web app ask which social platforms the browser is logged into.
 * The page sends { source, action: 'aisee:social-sessions', requestId } and
 * gets back { sessions: { x, reddit } } — see
 * @gitroom/helpers/extension/social-sessions for the payload shape and the
 * page-side helper (requestSocialSessions). The actual probing runs in the
 * service worker (cookies + reddit /api/me.json need host permissions).
 */
export function installSocialSessionsBridge(): void {
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== window.location.origin)
      return;
    const data = event.data as {
      source?: string;
      action?: string;
      requestId?: string;
    };
    if (data?.source !== EXTENSION_MESSAGE.source) return;
    if (data.action !== EXTENSION_MESSAGE.socialSessions || !data.requestId)
      return;

    chrome.runtime.sendMessage(
      { action: ENGAGE_EXTENSION_ACTION.socialSessions },
      (response) => {
        const runtimeError = chrome.runtime.lastError?.message;
        window.postMessage(
          {
            source: EXTENSION_MESSAGE.resultSource,
            action: EXTENSION_MESSAGE.socialSessionsResult,
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
