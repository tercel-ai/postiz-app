import { describe, it, expect } from 'vitest';
import { computeTrafficScore } from '../traffic.calculator';
import { extractMetrics } from '../analytics.utils';

// Regression for C1: a non-numeric metric `total` (e.g. DOM-scraped "N/A" /
// "1,234" forwarded by the extension) must NOT produce a NaN score/impressions.
// NaN would survive the `trafficScore !== null` gate and `?? undefined`, reach a
// Prisma Float? column, be rejected, and 500 the whole backfill batch.
describe('metric coercion is NaN-safe (C1)', () => {
  it('computeTrafficScore returns a finite number for non-numeric totals', () => {
    const score = computeTrafficScore('x', [
      { label: 'likes', data: [{ total: 'N/A', date: 'd' }], percentageChange: 0 },
      { label: 'replies', data: [{ total: '1,234', date: 'd' }], percentageChange: 0 },
    ] as any);
    expect(score).not.toBeNull();
    expect(Number.isFinite(score as number)).toBe(true);
    expect(score).toBe(0); // both points coerce to 0, not NaN
  });

  it('computeTrafficScore still sums valid numeric/string totals', () => {
    const score = computeTrafficScore('x', [
      { label: 'likes', data: [{ total: '10', date: 'd' }], percentageChange: 0 },
      { label: 'replies', data: [{ total: 5, date: 'd' }], percentageChange: 0 },
    ] as any);
    expect(score).toBe(20); // likes 10*1 + replies 5*2
  });

  it('extractMetrics yields finite impressions + trafficScore for non-numeric input', () => {
    const { impressions, trafficScore } = extractMetrics('x', [
      { label: 'impressions', data: [{ total: 'oops', date: 'd' }], percentageChange: 0 },
      { label: 'likes', data: [{ total: 'NaN', date: 'd' }], percentageChange: 0 },
    ] as any);
    expect(Number.isFinite(impressions)).toBe(true);
    expect(impressions).toBe(0);
    expect(trafficScore === null || Number.isFinite(trafficScore)).toBe(true);
  });
});
