import { useCallback, useEffect, useRef, useState } from 'react';
import type { PlatformLoginEntry } from '@gitroom/extension/utils/social-sessions';
import { ENGAGE_EXTENSION_ACTION } from '@gitroom/extension/utils/executor/actions';

/**
 * Browser login state per social platform, for the popup/panel status bar.
 *
 * Two tiers on purpose. The collapsed counter renders from a COOKIE-ONLY
 * snapshot, which costs nothing and is what every popup open pays for. Naming
 * the accounts is the expensive half — Reddit reads me.json, X opens a
 * background tab — so `load(true)` runs only when the user expands the list,
 * and only once per popup (the SW caches the identities beyond that).
 */
export function usePlatformSessions(enabled: boolean) {
  // null = not loaded yet
  const [entries, setEntries] = useState<PlatformLoginEntry[] | null>(null);
  const [detailed, setDetailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const load = useCallback(async (wantDetailed: boolean) => {
    setBusy(true);
    try {
      const r = await chrome.runtime.sendMessage({
        action: ENGAGE_EXTENSION_ACTION.platformSessions,
        detailed: wantDetailed,
      });
      if (!aliveRef.current) return;
      if (r?.ok && Array.isArray(r.platforms)) {
        setEntries(r.platforms as PlatformLoginEntry[]);
        if (wantDetailed) setDetailed(true);
      }
    } catch {
      // SW asleep or the probe blew up — keep whatever snapshot is on screen
      // rather than flipping every platform to "not signed in".
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (enabled) load(false);
  }, [enabled, load]);

  return { entries, detailed, busy, load };
}
