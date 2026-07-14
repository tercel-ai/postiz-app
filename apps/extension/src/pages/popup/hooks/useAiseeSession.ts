import { useCallback, useEffect, useState } from 'react';
import { checkPlatformLogin } from '@gitroom/extension/pages/popup/components/ScanPanel';
import { AuthUser, ACCESS_KEY } from '@gitroom/extension/utils/auth.service';
import { ENGAGE_EXTENSION_ACTION } from '@gitroom/extension/utils/executor/actions';

// Normalised Engage plan codes (see EngageEntitlementService) mapped to a
// display label — used as the fallback source for org members who aren't
// SUPERADMIN/ADMIN and so can't call the ADMIN-gated /user/subscription.
const PLAN_LABELS: Record<string, string> = {
  starter: 'Starter',
  developer: 'Developer',
  pro: 'Pro',
};

/** Shared auth/plan/platform-login state — used by both Popup and Panel so
 *  the two surfaces show identical account info without duplicating this
 *  effect wiring in each. */
export function useAiseeSession() {
  // undefined = checking, null = logged out, object = logged in
  const [user, setUser] = useState<AuthUser | null | undefined>(undefined);
  // null = still checking, true/false = result
  const [platformLogin, setPlatformLogin] = useState<{ x: boolean | null; reddit: boolean | null }>({ x: null, reddit: null });
  // undefined = loading, null = no active paid package (shown as "Free")
  const [planName, setPlanName] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    chrome.runtime
      .sendMessage({ action: 'auth:state' })
      .then((r) => setUser(r?.user ?? null))
      .catch(() => setUser(null));

    // Stay live while open: if the background clears or sets the bridged session
    // after our initial snapshot (e.g. the content-script bridge pushes an empty
    // token once a logging-out tab finishes navigating), reflect it immediately
    // instead of waiting for another click.
    const onSession = (
      changes: { [k: string]: chrome.storage.StorageChange },
      area: string
    ) => {
      if (area !== 'session' || !changes[ACCESS_KEY]) return;
      const next = changes[ACCESS_KEY].newValue as
        | { user?: AuthUser }
        | undefined;
      setUser(next?.user ?? null);
    };
    chrome.storage.onChanged.addListener(onSession);
    return () => chrome.storage.onChanged.removeListener(onSession);
  }, []);

  // Only check platform login after Aisee auth is confirmed — keeps the
  // cookies IPC calls off the critical path for initial render.
  useEffect(() => {
    if (!user) return;
    Promise.all([checkPlatformLogin('x'), checkPlatformLogin('reddit')])
      .then(([x, reddit]) => setPlatformLogin({ x, reddit }));
  }, [user]);

  // Subscription plan name. Primary source: GET /user/subscription, the real
  // Aisee package display name (e.g. "Starter Plan (Monthly)") — but that
  // route is ADMIN-gated, so a non-owner org member gets a 403. Fall back to
  // GET /engage/config's entitlement.plan, which every org member can read
  // (normalised to starter/developer/pro; null only means genuinely no plan
  // or self-hosted, never a failed lookup — see EngageEntitlementService's
  // `degraded` flag). Both exhausted → "Free".
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await chrome.runtime.sendMessage({ action: ENGAGE_EXTENSION_ACTION.loadSubscription });
        if (r?.ok && r.data?.subscription?.name) {
          if (!cancelled) setPlanName(r.data.subscription.name);
          return;
        }
      } catch {
        // fall through to the /engage/config fallback below
      }
      try {
        const r2 = await chrome.runtime.sendMessage({ action: ENGAGE_EXTENSION_ACTION.loadConfig });
        const code: string | undefined = r2?.data?.entitlement?.plan;
        if (!cancelled) setPlanName((code && PLAN_LABELS[code]) || null);
      } catch {
        if (!cancelled) setPlanName(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  const handleLogout = useCallback(async () => {
    await chrome.runtime.sendMessage({ action: 'auth:logout' });
    setUser(null);
  }, []);

  return { user, platformLogin, planName, handleLogout };
}
