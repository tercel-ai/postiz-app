import { useEffect, useRef, useState } from 'react';
import { EXTENSION_MESSAGE } from '@gitroom/helpers/extension/brand';

// The extension's content-script bridge (which answers pings) and this page's
// React app both start around document_idle with NO ordering guarantee. A single
// ping can fire before the bridge has attached its message listener and be lost
// for good — that's the "sometimes detected, sometimes not" race. So we:
//   1. retry the ping a few times over a short window, and
//   2. keep the listener mounted for the whole lifetime, so a pong that arrives
//      late (bridge finished loading, or the user just installed/enabled it)
//      still flips us to "detected".
const PING_RETRY_INTERVAL_MS = 250;
const PING_MAX_ATTEMPTS = 16; // ~4s of retries before concluding "not found"

/**
 * Probes whether the aisee browser extension is installed and active on this
 * origin. Returns:
 *   null  — probe in-flight (haven't concluded yet)
 *   true  — extension replied; it's present
 *   false — no reply within the retry window (but we keep listening, so this can
 *           still flip to true if a pong arrives later)
 */
export function useExtensionDetected(): boolean | null {
  const [detected, setDetected] = useState<boolean | null>(null);
  const detectedRef = useRef(false);

  useEffect(() => {
    if (typeof window === 'undefined') {
      setDetected(false);
      return;
    }

    let attempts = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const sendPing = () => {
      window.postMessage(
        { source: EXTENSION_MESSAGE.source, action: EXTENSION_MESSAGE.ping },
        window.location.origin
      );
    };

    function onMessage(e: MessageEvent) {
      if (e.source !== window || e.origin !== window.location.origin) return;
      const data = e.data as { source?: string; action?: string } | undefined;
      if (data?.source !== EXTENSION_MESSAGE.resultSource) return;
      if (data?.action !== EXTENSION_MESSAGE.pong) return;
      if (detectedRef.current) return;
      detectedRef.current = true;
      if (retryTimer) clearTimeout(retryTimer);
      setDetected(true);
    }

    window.addEventListener('message', onMessage);

    // Retry pings over the initial window to win the startup race.
    const tick = () => {
      if (detectedRef.current) return;
      attempts += 1;
      sendPing();
      if (attempts >= PING_MAX_ATTEMPTS) {
        // Stop pinging, but the listener stays attached — a later pong (or a
        // focus re-probe below) can still flip detection to true.
        setDetected((prev) => (prev === true ? prev : false));
        return;
      }
      retryTimer = setTimeout(tick, PING_RETRY_INTERVAL_MS);
    };
    tick();

    // Re-probe when the tab regains focus/visibility — covers the user
    // installing or enabling the extension while this page stays open.
    const reprobe = () => {
      if (detectedRef.current) return;
      if (document.visibilityState === 'hidden') return;
      sendPing();
    };
    window.addEventListener('focus', reprobe);
    document.addEventListener('visibilitychange', reprobe);

    return () => {
      if (retryTimer) clearTimeout(retryTimer);
      window.removeEventListener('message', onMessage);
      window.removeEventListener('focus', reprobe);
      document.removeEventListener('visibilitychange', reprobe);
    };
  }, []);

  return detected;
}
