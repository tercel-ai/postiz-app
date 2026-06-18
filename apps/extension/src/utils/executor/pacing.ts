// Pacing primitives for the extension executor. The extension fetches with the
// user's PERSONAL session, so a machine-timed cadence is dangerous (a flagged
// account is catastrophic). All delays carry jitter so the rhythm never looks
// automated, and an hourly request cap bounds total volume per browser.

export const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** `base + random(0..jitter)`, floored at 0. */
export function jitteredDelayMs(baseMs: number, jitterMs: number): number {
  const base = Number.isFinite(baseMs) && baseMs > 0 ? baseMs : 0;
  const jitter =
    Number.isFinite(jitterMs) && jitterMs > 0
      ? Math.floor(Math.random() * jitterMs)
      : 0;
  return base + jitter;
}

export async function applyDelay(baseMs: number, jitterMs: number): Promise<void> {
  const ms = jitteredDelayMs(baseMs, jitterMs);
  if (ms > 0) await sleep(ms);
}

// ─── Hourly request cap (rolling 60-min window, persisted) ────────────────────
//
// Persisted in chrome.storage.session so it survives SW suspend/resume within a
// browser session (and resets when the browser closes — a fresh session can
// fetch again). A sliding window of fetch timestamps; `tryConsume` records a
// fetch iff doing so stays within the cap.

const CAP_KEY = 'aisee_engage_fetch_window';
const HOUR_MS = 60 * 60 * 1000;

async function readWindow(): Promise<number[]> {
  const cutoff = Date.now() - HOUR_MS;
  const stored = await chrome.storage.session.get([CAP_KEY]);
  const arr: number[] = Array.isArray(stored?.[CAP_KEY]) ? stored[CAP_KEY] : [];
  return arr.filter((t) => typeof t === 'number' && t > cutoff);
}

async function writeWindow(times: number[]): Promise<void> {
  await chrome.storage.session.set({ [CAP_KEY]: times });
}

/** How many fetches are still allowed in the current rolling hour given `cap`. */
export async function remainingHourlyBudget(cap: number): Promise<number> {
  if (!Number.isFinite(cap) || cap <= 0) return Number.POSITIVE_INFINITY;
  const win = await readWindow();
  return Math.max(0, cap - win.length);
}

/**
 * Record one fetch if it keeps us within `cap` for the rolling hour. Returns
 * true when the fetch is allowed (and was recorded), false when the cap is hit.
 */
export async function tryConsumeHourly(cap: number): Promise<boolean> {
  if (!Number.isFinite(cap) || cap <= 0) return true; // unbounded
  const win = await readWindow();
  if (win.length >= cap) {
    await writeWindow(win); // persist the pruned window
    return false;
  }
  win.push(Date.now());
  await writeWindow(win);
  return true;
}
