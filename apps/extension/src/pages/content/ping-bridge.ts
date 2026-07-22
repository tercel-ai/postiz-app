import { EXTENSION_MESSAGE } from '@gitroom/helpers/extension/brand';

/**
 * Responds to presence probes sent by the web app.
 * The page sends { source: 'aisee', action: 'aisee:ping' } and waits for
 * { source: 'aisee-extension', action: 'aisee:pong' } to confirm the extension
 * is installed and the content script is active on this origin. Answered
 * synchronously from the content script (no service worker involved) so
 * presence detection stays instant. Login state is a separate concern — use
 * the aisee:social-sessions bridge for that.
 */
export function installPingBridge(): void {
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    if (e.origin !== window.location.origin) return;
    const data = e.data as { source?: string; action?: string } | undefined;
    if (!data || data.source !== EXTENSION_MESSAGE.source) return;
    if (data.action !== EXTENSION_MESSAGE.ping) return;
    window.postMessage(
      {
        source: EXTENSION_MESSAGE.resultSource,
        action: EXTENSION_MESSAGE.pong,
        version: chrome.runtime.getManifest().version,
      },
      e.origin
    );
  });
}
