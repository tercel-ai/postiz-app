import { describe, expect, it } from 'vitest';
import { parseCompactNumber } from '../metrics.medium';

describe('parseCompactNumber', () => {
  it('parses plain integers', () => {
    expect(parseCompactNumber('857')).toBe(857);
    expect(parseCompactNumber('1,234')).toBe(1234);
  });
  it('expands K / M suffixes', () => {
    expect(parseCompactNumber('1.2K')).toBe(1200);
    expect(parseCompactNumber('3.4M')).toBe(3_400_000);
    expect(parseCompactNumber('2k')).toBe(2000);
  });
  it('returns null for non-numeric / empty input', () => {
    expect(parseCompactNumber('')).toBeNull();
    expect(parseCompactNumber(null)).toBeNull();
    expect(parseCompactNumber('claps')).toBeNull();
    expect(parseCompactNumber('12 responses')).toBeNull();
  });
});
