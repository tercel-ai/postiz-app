import { EXTENSION_MESSAGE } from '@gitroom/helpers/extension/brand';

/**
 * Responds to presence probes sent by the web app.
 * The page sends { source: 'aisee', action: 'aisee:ping' } and waits for
 * { source: 'aisee-extension', action: 'aisee:pong' } to confirm the extension
 * is installed and the content script is active on this origin. Answered
 * synchronously from the content script (no service worker involved) so
 * presence detection stays instant. Login state is a separate concern — use
 * the aisee:social-sessions bridge for that.
 *
 * The pong carries `stale: true` when this content script has been orphaned
 * (extension reloaded / rebuilt in place while the page stayed open). The
 * extension IS installed in that case, but every chrome.* call from here throws,
 * so nothing else on this page will work until it is reloaded. Reporting it as
 * "not installed" is what made the app show "Install the AIsee extension" to
 * users who already had it — the page needs to tell them to refresh instead.
 */
export function installPingBridge(): void {
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    if (e.origin !== window.location.origin) return;
    const data = e.data as { source?: string; action?: string } | undefined;
    if (!data || data.source !== EXTENSION_MESSAGE.source) return;
    if (data.action !== EXTENSION_MESSAGE.ping) return;

    // Reading the manifest is the cheapest liveness check on chrome.runtime:
    // it throws on an invalidated context. Never let that throw escape — the
    // pong is the only signal the page has, so a silent failure here reads as
    // "extension not installed" for the entire page lifetime.
    let version: string | undefined;
    let stale = false;
    try {
      version = chrome.runtime.getManifest().version;
    } catch {
      stale = true;
    }

    window.postMessage(
      {
        source: EXTENSION_MESSAGE.resultSource,
        action: EXTENSION_MESSAGE.pong,
        version,
        stale,
      },
      e.origin
    );
  });
}
