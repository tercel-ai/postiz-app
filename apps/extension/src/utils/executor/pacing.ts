// Pacing primitives for the extension executor. The extension fetches with the
// user's PERSONAL session, so a machine-timed cadence is dangerous (a flagged
// account is catastrophic). All delays carry jitter so the rhythm never looks
// automated, and an hourly request cap bounds total volume per browser.

import type { ScanTaskPacing } from './executor.types';

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

// Inter-post spacing shared by the alarm batch runner and the page-driven path,
// so a flagged-account cadence looks the same regardless of what triggered it.
export const METRICS_INTER_POST_DELAY_MS = 2_000;
export const METRICS_INTER_POST_JITTER_MS = 3_000;

// Records the last fetch time per scope so consecutive page-driven fetches are
// spaced like the batch runner's between-post delay — WITHOUT penalizing an
// isolated request whose gap has already elapsed.
const lastFetchAt = new Map<string, number>();

/**
 * Sleep only for the portion of the inter-post gap that has not yet elapsed
 * since the previous fetch on this scope, then record now. The first fetch (or
 * one after a long idle) returns immediately; a burst gets spaced out.
 */
export async function spaceConsecutiveFetches(scope = 'shared'): Promise<void> {
  const now = Date.now();
  const last = lastFetchAt.get(scope);
  if (last !== undefined) {
    const target = jitteredDelayMs(
      METRICS_INTER_POST_DELAY_MS,
      METRICS_INTER_POST_JITTER_MS
    );
    const elapsed = now - last;
    const remaining = target - elapsed;
    if (remaining > 0) await sleep(remaining);
  }
  lastFetchAt.set(scope, Date.now());
}

// ─── Hourly request cap (rolling 60-min window, persisted) ────────────────────
//
// Persisted in chrome.storage.session so it survives SW suspend/resume within a
// browser session (and resets when the browser closes — a fresh session can
// fetch again). A sliding window of fetch timestamps; `tryConsume` records a
// fetch iff doing so stays within the cap.

const CAP_KEY = 'aisee_engage_fetch_window';
const HOUR_MS = 60 * 60 * 1000;

// Default per-platform hourly fetch cap, shared by ALL demand-driven fetch paths
// (opportunity scan, calendar post metrics, engage reply metrics) so they draw
// from one budget per platform scope instead of separate, accidentally larger
// allowances. Scan tasks may still pass their own configured cap.
export const DEFAULT_HOURLY_FETCH_CAP = 60;

function capKey(scope: string): string {
  const clean = String(scope || 'shared').replace(/[^a-z0-9_-]/gi, '_');
  return `${CAP_KEY}:${clean}`;
}

// Per-scope serialization. chrome.storage is async, so a naive read-check-write
// in tryConsumeHourly races: two concurrent callers can both read a window that
// is one-below-cap, both decide there is room, and both write — overshooting the
// cap. Chaining each scope's reservations onto a single promise makes the
// read→decide→write sequence atomic with respect to other reservations for the
// same scope.
const reservationChains = new Map<string, Promise<unknown>>();

function withScopeLock<T>(scope: string, fn: () => Promise<T>): Promise<T> {
  const prev = reservationChains.get(scope) ?? Promise.resolve();
  // Swallow the previous result/error so one caller's failure can't reject the
  // next; each caller still observes its own fn() outcome below.
  const run = prev.then(fn, fn);
  reservationChains.set(
    scope,
    run.then(
      () => undefined,
      () => undefined
    )
  );
  return run;
}

async function readWindow(scope: string): Promise<number[]> {
  const cutoff = Date.now() - HOUR_MS;
  const key = capKey(scope);
  const stored = await chrome.storage.session.get([key]);
  const arr: number[] = Array.isArray(stored?.[key]) ? stored[key] : [];
  return arr.filter((t) => typeof t === 'number' && t > cutoff);
}

async function writeWindow(scope: string, times: number[]): Promise<void> {
  await chrome.storage.session.set({ [capKey(scope)]: times });
}

/** How many fetches are still allowed in the current rolling hour given `cap`. */
export async function remainingHourlyBudget(
  cap: number,
  scope = 'shared'
): Promise<number> {
  if (!Number.isFinite(cap) || cap <= 0) return Number.POSITIVE_INFINITY;
  const win = await readWindow(scope);
  return Math.max(0, cap - win.length);
}

/**
 * Record one fetch if it keeps us within `cap` for the rolling hour. Returns
 * true when the fetch is allowed (and was recorded), false when the cap is hit.
 */
export function tryConsumeHourly(
  cap: number,
  scope = 'shared'
): Promise<boolean> {
  if (!Number.isFinite(cap) || cap <= 0) return Promise.resolve(true); // unbounded
  return withScopeLock(scope, async () => {
    const win = await readWindow(scope);
    if (win.length >= cap) {
      await writeWindow(scope, win); // persist the pruned window
      return false;
    }
    win.push(Date.now());
    await writeWindow(scope, win);
    return true;
  });
}

// ─── Inter-keyword spacing ────────────────────────────────────────────────────
//
// The gap the runner waits BEFORE scanning the next unit (keyword). X searches
// one keyword per round-trip with no pagination, so it reuses pageDelay/pageJitter
// as the inter-keyword gap; every other platform keeps interUnitDelay/Jitter.
export function selectUnitDelay(
  platform: string,
  pacing: ScanTaskPacing
): { baseMs: number; jitterMs: number } {
  if (platform === 'x') {
    return { baseMs: pacing.pageDelayMs, jitterMs: pacing.pageJitterMs };
  }
  return { baseMs: pacing.interUnitDelayMs, jitterMs: pacing.interUnitJitterMs };
}
