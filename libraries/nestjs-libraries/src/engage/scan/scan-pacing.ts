import { ScanBudget } from './platform-scan-adapter';

/**
 * Resolve the wait (ms) before the next page fetch from a scan budget:
 * `pageDelayMs + random(0..jitterMs)`. Pure (randomness injectable) so it is
 * unit-testable; the jitter de-regularises the cadence so a paced scan does not
 * look machine-timed — critical on the extension path (personal session).
 */
export function nextPageDelayMs(
  budget: Pick<ScanBudget, 'pageDelayMs' | 'jitterMs'>,
  rand: () => number = Math.random
): number {
  const base = Number.isFinite(budget.pageDelayMs) && (budget.pageDelayMs ?? 0) > 0
    ? (budget.pageDelayMs as number)
    : 0;
  const jitter = Number.isFinite(budget.jitterMs) && (budget.jitterMs ?? 0) > 0
    ? Math.floor(rand() * (budget.jitterMs as number))
    : 0;
  return base + jitter;
}

/**
 * Sleep the inter-page delay for this budget. No-op when both delay and jitter
 * are 0/unset, so callers that only set maxCalls pay nothing.
 */
export async function applyPageDelay(
  budget: Pick<ScanBudget, 'pageDelayMs' | 'jitterMs'>,
  sleep: (ms: number) => Promise<void> = defaultSleep
): Promise<void> {
  const ms = nextPageDelayMs(budget);
  if (ms > 0) {
    await sleep(ms);
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
