import { describe, it, expect, vi } from 'vitest';
import { nextPageDelayMs, applyPageDelay } from '../scan-pacing';

describe('nextPageDelayMs', () => {
  it('returns 0 when neither delay nor jitter is set', () => {
    expect(nextPageDelayMs({})).toBe(0);
    expect(nextPageDelayMs({ pageDelayMs: 0, jitterMs: 0 })).toBe(0);
  });

  it('returns the base delay when jitter is absent', () => {
    expect(nextPageDelayMs({ pageDelayMs: 5000 })).toBe(5000);
  });

  it('adds floor(rand * jitter) on top of the base', () => {
    // rand=0.5, jitter=60000 → +30000
    expect(nextPageDelayMs({ pageDelayMs: 5000, jitterMs: 60000 }, () => 0.5)).toBe(35000);
    // rand≈1 → near-max
    expect(nextPageDelayMs({ pageDelayMs: 8000, jitterMs: 60000 }, () => 0.999)).toBe(8000 + 59940);
  });

  it('ignores negative / non-finite values', () => {
    expect(nextPageDelayMs({ pageDelayMs: -1, jitterMs: -5 }, () => 0.5)).toBe(0);
  });
});

describe('applyPageDelay', () => {
  it('does not sleep when the computed delay is 0', async () => {
    const sleep = vi.fn(async () => undefined);
    await applyPageDelay({}, sleep);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('sleeps the base delay when set', async () => {
    const sleep = vi.fn(async () => undefined);
    await applyPageDelay({ pageDelayMs: 5000 }, sleep);
    expect(sleep).toHaveBeenCalledWith(5000);
  });
});
