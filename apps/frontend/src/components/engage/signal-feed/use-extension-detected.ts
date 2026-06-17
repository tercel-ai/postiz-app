import { useCallback, useEffect, useRef, useState } from 'react';
import { EXTENSION_MESSAGE } from '@gitroom/helpers/extension/brand';

const PING_TIMEOUT_MS = 800;

/**
 * Probes whether the aisee browser extension is installed and active on this
 * origin. Returns:
 *   null  — probe in-flight (haven't heard back yet)
 *   true  — extension replied; it's present
 *   false — probe timed out; extension not detected
 *
 * The detection is one-shot per mount. If the user installs the extension while
 * the page is open, a full reload (which the browser triggers anyway when a new
 * content script injects) will re-run the probe.
 */
export function useExtensionDetected(): boolean | null {
  const [detected, setDetected] = useState<boolean | null>(null);
  const resolvedRef = useRef(false);

  const probe = useCallback(() => {
    resolvedRef.current = false;

    function onMessage(e: MessageEvent) {
      if (e.source !== window || e.origin !== window.location.origin) return;
      const data = e.data as { source?: string; action?: string } | undefined;
      if (data?.source !== EXTENSION_MESSAGE.resultSource) return;
      if (data?.action !== EXTENSION_MESSAGE.pong) return;
      if (resolvedRef.current) return;
      resolvedRef.current = true;
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      setDetected(true);
    }

    const timer = setTimeout(() => {
      if (resolvedRef.current) return;
      resolvedRef.current = true;
      window.removeEventListener('message', onMessage);
      setDetected(false);
    }, PING_TIMEOUT_MS);

    window.addEventListener('message', onMessage);
    window.postMessage(
      { source: EXTENSION_MESSAGE.source, action: EXTENSION_MESSAGE.ping },
      window.location.origin
    );

    return () => {
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
    };
  }, []);

  useEffect(() => probe(), [probe]);

  return detected;
}
