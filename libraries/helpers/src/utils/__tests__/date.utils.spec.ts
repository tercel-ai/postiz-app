import { describe, it, expect } from 'vitest';
import { parseDate, parseDateToUTC } from '../date.utils';

describe('parseDate / parseDateToUTC', () => {
  const SHANGHAI = 'Asia/Shanghai';
  // 2026-03-20 00:00:00 Shanghai = 2026-03-19T16:00:00Z
  const EXPECTED_UTC = '2026-03-19T16:00:00.000Z';

  // -----------------------------------------------------------------------
  // Case 1: offset + tz → local time (offset determines UTC instant)
  // -----------------------------------------------------------------------
  it('Case 1: +08:00 offset + tz header', () => {
    const d = parseDateToUTC('2026-03-20T00:00:00+08:00', SHANGHAI);
    expect(d.toISOString()).toBe(EXPECTED_UTC);
  });

  // -----------------------------------------------------------------------
  // Case 2: offset, no tz → local time (offset determines UTC instant)
  // -----------------------------------------------------------------------
  it('Case 2: +08:00 offset, no tz', () => {
    const d = parseDateToUTC('2026-03-20T00:00:00+08:00');
    expect(d.toISOString()).toBe(EXPECTED_UTC);
  });

  it('Case 2: Z offset, no tz', () => {
    const d = parseDateToUTC('2026-03-20T00:00:00Z');
    expect(d.toISOString()).toBe('2026-03-20T00:00:00.000Z');
  });

  // -----------------------------------------------------------------------
  // Case 3: no offset + tz → local time in that tz
  // -----------------------------------------------------------------------
  it('Case 3: no offset + tz header', () => {
    const d = parseDateToUTC('2026-03-20T00:00:00', SHANGHAI);
    expect(d.toISOString()).toBe(EXPECTED_UTC);
  });

  it('Case 3: no offset + tz, late-day time does not jump day', () => {
    // 20:00 Shanghai time on Mar 20 → should still be Mar 20 in Shanghai
    const d = parseDate('2026-03-20T20:00:00', SHANGHAI);
    expect(d.startOf('day').toDate().toISOString()).toBe(EXPECTED_UTC);
  });

  // -----------------------------------------------------------------------
  // Case 4: no offset, no tz → UTC
  // -----------------------------------------------------------------------
  it('Case 4: no offset, no tz → treated as UTC', () => {
    const d = parseDateToUTC('2026-03-20T00:00:00');
    expect(d.toISOString()).toBe('2026-03-20T00:00:00.000Z');
  });

  // -----------------------------------------------------------------------
  // startOf / endOf with parseDate
  // -----------------------------------------------------------------------
  it('startOf(day) with offset + tz snaps to local day start', () => {
    // 15:30 Shanghai → startOf day → 00:00 Shanghai
    const d = parseDate('2026-03-20T15:30:00+08:00', SHANGHAI)
      .startOf('day')
      .toDate();
    expect(d.toISOString()).toBe(EXPECTED_UTC);
  });

  it('endOf(day) with offset + tz snaps to local day end', () => {
    const d = parseDate('2026-03-20T10:00:00+08:00', SHANGHAI)
      .endOf('day')
      .toDate();
    expect(d.toISOString()).toBe('2026-03-20T15:59:59.999Z');
  });

  it('negative offset: -05:00 (New York EST)', () => {
    // 2026-03-20T00:00:00-05:00 = UTC 05:00
    const d = parseDateToUTC('2026-03-20T00:00:00-05:00');
    expect(d.toISOString()).toBe('2026-03-20T05:00:00.000Z');
  });

  // All 3 local-time cases produce the same result
  it('Cases 1-3 all resolve to the same UTC instant', () => {
    const c1 = parseDateToUTC('2026-03-20T00:00:00+08:00', SHANGHAI);
    const c2 = parseDateToUTC('2026-03-20T00:00:00+08:00');
    const c3 = parseDateToUTC('2026-03-20T00:00:00', SHANGHAI);
    expect(c1.toISOString()).toBe(c2.toISOString());
    expect(c2.toISOString()).toBe(c3.toISOString());
  });
});
