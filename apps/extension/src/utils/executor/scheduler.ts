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
import { runPublishLoop } from './publish.runner';

export const ENGAGE_SCAN_ALARM = 'aisee-engage-scan';
// Chrome clamps periods to ≥1 min; 15 keeps the SCAN cadence organic and cheap
// (scanning too often risks account rate-limits — keep this separate from the
// publish poll below, which must NOT drive a scan).
const SCAN_PERIOD_MINUTES = 15;

// Backend publish-due poll: the extension pulls QUEUE posts the backend has
// marked for in-browser publishing. Because the DB is the source of truth, this
// poll is what bounds how quickly a scheduled post goes out (and is what
// re-syncs after an uninstall/reinstall). 1 min is the chrome.alarms floor —
// the tightest cadence Chrome allows, matching the precision a local publishDate
// alarm could achieve anyway, so a future post fires within ~1 min of its time.
// The poll stays cheap: an idle tick is a single indexed, empty-result query
// (no write); the backend lease keeps a due post from being claimed twice.
// Deliberately its OWN alarm so publish cadence never touches the scan cadence
// (scanning too often risks account rate-limits — that stays at 15 min).
export const PUBLISH_POLL_ALARM = 'aisee-publish-poll';
const PUBLISH_POLL_MINUTES = 1;

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

/** Arm the periodic backend publish-due poll if a session exists (idempotent). */
export async function ensurePublishPollAlarm(): Promise<void> {
  try {
    const token = await getValidAccessToken();
    if (!token) return; // signed out → never poll
    const existing = await chrome.alarms.get(PUBLISH_POLL_ALARM);
    if (existing) return;
    chrome.alarms.create(PUBLISH_POLL_ALARM, {
      delayInMinutes: 1,
      periodInMinutes: PUBLISH_POLL_MINUTES,
    });
    console.log('[aisee][publish] poll alarm armed', PUBLISH_POLL_MINUTES, 'min');
  } catch (e) {
    console.warn('[aisee][publish] ensurePublishPollAlarm failed', e);
  }
}

export async function clearPublishPollAlarm(): Promise<void> {
  try {
    await chrome.alarms.clear(PUBLISH_POLL_ALARM);
  } catch {
    /* ignore */
  }
}

/** Returns true when the alarm was the engage-scan alarm (so the caller can stop). */
export async function handleEngageAlarm(name: string): Promise<boolean> {
  if (name !== ENGAGE_SCAN_ALARM) return false;
  console.log('[aisee][scan] alarm fired — starting scheduled scan', new Date().toISOString());
  const summary = await runScanLoop();
  console.log('[aisee][scan] scheduled scan done', summary);
  return true;
}

/**
 * Returns true when the alarm was the publish-due poll (so the caller can stop).
 * Pulls + publishes any due extension-routed posts the backend has queued. Kept
 * separate from the scan so a scan error never blocks publishing and vice versa.
 */
export async function handlePublishPollAlarm(name: string): Promise<boolean> {
  if (name !== PUBLISH_POLL_ALARM) return false;
  try {
    const publish = await runPublishLoop();
    console.log('[aisee][publish] scheduled publish done', publish);
  } catch (e) {
    console.warn('[aisee][publish] scheduled publish failed', e);
  }
  return true;
}
