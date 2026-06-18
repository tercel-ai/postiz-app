// Background scheduling for the demand-driven executor. A periodic alarm wakes
// the service worker to drive the engage opportunity scan (Track B) on its own
// cadence; the post-metrics track (Track A) is view-scoped, so it's driven by
// explicit ids (frontend or manual debug), not this alarm.
//
// The alarm is armed only while logged in and cleared on logout, so a signed-out
// browser never fetches. Unknown alarm names are ignored by the auth handler, so
// this name coexists with 'aisee-token-refresh'.

import { getValidAccessToken } from '@gitroom/extension/utils/auth.service';
import { runScanLoop } from './scan.runner';

export const ENGAGE_SCAN_ALARM = 'aisee-engage-scan';
// Chrome clamps periods to ≥1 min; 15 keeps the cadence organic and cheap.
const SCAN_PERIOD_MINUTES = 15;

/** Arm the periodic scan alarm if a session exists (idempotent). */
export async function ensureEngageScanAlarm(): Promise<void> {
  try {
    const token = await getValidAccessToken();
    if (!token) return; // signed out → never schedule background fetches
    const existing = await chrome.alarms.get(ENGAGE_SCAN_ALARM);
    if (existing) return;
    chrome.alarms.create(ENGAGE_SCAN_ALARM, {
      delayInMinutes: 1,
      periodInMinutes: SCAN_PERIOD_MINUTES,
    });
    console.log('[aisee][scan] alarm armed', SCAN_PERIOD_MINUTES, 'min');
  } catch (e) {
    console.warn('[aisee][scan] ensureEngageScanAlarm failed', e);
  }
}

export async function clearEngageScanAlarm(): Promise<void> {
  try {
    await chrome.alarms.clear(ENGAGE_SCAN_ALARM);
  } catch {
    /* ignore */
  }
}

/** Returns true when the alarm was this module's (so the caller can stop). */
export async function handleEngageAlarm(name: string): Promise<boolean> {
  if (name !== ENGAGE_SCAN_ALARM) return false;
  await runScanLoop();
  return true;
}
