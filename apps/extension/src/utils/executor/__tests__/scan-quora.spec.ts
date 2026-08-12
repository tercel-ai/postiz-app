import { describe, expect, it } from 'vitest';
import { buildQuoraScanUrl, quoraTimeToMs } from '../scan.quora';
import type { EngageScanTask } from '../executor.types';

function task(partial: Partial<EngageScanTask>): EngageScanTask {
  return {
    taskId: 't',
    platform: 'quora',
    scanType: 'keyword',
    scanKey: 'ai search',
    cursor: { lastSeenExternalId: null, lastSeenAt: null },
    pacing: {
      maxPages: 1,
      pageSize: 25,
      pageDelayMs: 0,
      pageJitterMs: 0,
      interUnitDelayMs: 0,
      interUnitJitterMs: 0,
      hourlyRequestCap: 60,
    },
    ...partial,
  };
}

describe('buildQuoraScanUrl', () => {
  it('builds an answer-type search for keyword scans', () => {
    const url = buildQuoraScanUrl(task({ scanType: 'keyword', scanKey: 'ai search' }));
    expect(url).toBe('https://www.quora.com/search?q=ai%20search&type=answer');
  });

  it('builds a profile URL for tracked accounts', () => {
    const url = buildQuoraScanUrl(task({ scanType: 'tracked', scanKey: 'profile/John-Doe' }));
    expect(url).toBe('https://www.quora.com/profile/John-Doe');
  });
});

describe('quoraTimeToMs', () => {
  const now = Date.parse('2026-08-12T12:00:00.000Z'); // Wednesday

  it('reads relative units', () => {
    expect(quoraTimeToMs('10y', now)).toBe(now - 10 * 365 * 24 * 3600e3);
    expect(quoraTimeToMs('3d', now)).toBe(now - 3 * 24 * 3600e3);
  });

  it('resolves a bare weekday to its most recent past occurrence', () => {
    // now is a Wednesday (local); "Sat" should resolve to the previous Saturday.
    // quoraTimeToMs works in local time (it mirrors what the page renders for
    // the user's own clock), so assert with local getters, not UTC ones.
    const result = quoraTimeToMs('Sat', now);
    expect(result).not.toBeNull();
    const d = new Date(result as number);
    expect(d.getDay()).toBe(6);
    expect(result as number).toBeLessThanOrEqual(now);
    expect(now - (result as number)).toBeLessThan(7 * 24 * 3600e3);
  });

  it('resolves today\'s weekday to today (not 7 days back)', () => {
    const result = quoraTimeToMs('Wed', now);
    const d = new Date(result as number);
    expect(d.getDate()).toBe(new Date(now).getDate());
  });

  it('resolves a bare "Mon D" (no year) against the current year', () => {
    const result = quoraTimeToMs('Jun 16', now);
    expect(result).not.toBeNull();
    const d = new Date(result as number);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(5); // June
  });

  it('rolls "Mon D" back a year when the same-year guess is in the future', () => {
    // "now" is August 2026; "Dec 25" without a year would land after "now" this
    // year, so it must resolve to Dec 2025, not a fabricated future date.
    const result = quoraTimeToMs('Dec 25', now);
    expect(result).not.toBeNull();
    const d = new Date(result as number);
    expect(d.getFullYear()).toBe(2025);
    expect(result as number).toBeLessThan(now);
  });

  it('still parses an explicit "Mon D, YYYY" date', () => {
    const result = quoraTimeToMs('March 5, 2023', now);
    expect(result).toBe(Date.parse('March 5, 2023'));
  });

  it('returns null for empty/unrecognisable input', () => {
    expect(quoraTimeToMs('', now)).toBeNull();
    expect(quoraTimeToMs(null, now)).toBeNull();
    expect(quoraTimeToMs(undefined, now)).toBeNull();
  });
});
