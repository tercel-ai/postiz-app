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

  it('computes a LinkedIn traffic score from the extension-emitted labels', () => {
    // The extension's buildLinkedinAnalytics emits impressions/likes/comments/
    // shares — these must line up with the traffic.calculator `linkedin` weights
    // (impressions 0.05, likes 1, comments 4, shares 3) or the scraped numbers
    // would silently not count toward Traffic.
    const score = computeTrafficScore('linkedin', [
      { label: 'impressions', data: [{ total: 1000, date: 'd' }], percentageChange: 0 },
      { label: 'likes', data: [{ total: 10, date: 'd' }], percentageChange: 0 },
      { label: 'comments', data: [{ total: 4, date: 'd' }], percentageChange: 0 },
      { label: 'shares', data: [{ total: 2, date: 'd' }], percentageChange: 0 },
    ] as any);
    // 1000*0.05 + 10*1 + 4*4 + 2*3 = 50 + 10 + 16 + 6 = 82
    expect(score).toBe(82);
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

// The extension's HN fetcher emits `dead` / `deleted` visibility flags alongside
// score + comments. They must ride through extractMetrics UNWEIGHTED and be
// KEPT in rawMetrics — rawMetrics is what lands in Post.analytics, which is the
// only place normalizeReplyMetrics can read them back from.
describe('visibility flags are carried, never scored', () => {
  const hn = (dead: number, deleted: number) =>
    [
      { label: 'score', data: [{ total: 12, date: 'd' }], percentageChange: 0 },
      { label: 'comments', data: [{ total: 4, date: 'd' }], percentageChange: 0 },
      { label: 'dead', data: [{ total: dead, date: 'd' }], percentageChange: 0 },
      { label: 'deleted', data: [{ total: deleted, date: 'd' }], percentageChange: 0 },
    ] as any;

  it('gives dead/deleted no traffic weight', () => {
    // 12*0.5 + 4*3 = 18, whether or not the item is dead.
    expect(computeTrafficScore('hackernews', hn(0, 0))).toBe(18);
    expect(computeTrafficScore('hackernews', hn(1, 1))).toBe(18);
  });

  it('never counts a flag as an impression', () => {
    const { impressions } = extractMetrics('hackernews', hn(1, 0));
    expect(impressions).toBe(0);
  });

  // The persistence gate in ingestMetrics is `impressions > 0 || trafficScore
  // !== null`. HN has no impressions ever, so a non-null trafficScore is the
  // ONLY reason a dead item's analytics get written at all — if this went null
  // the flag would be computed and then silently dropped.
  it('keeps trafficScore non-null for a dead item, so the row is persisted', () => {
    const { trafficScore, rawMetrics } = extractMetrics('hackernews', hn(1, 0));
    expect(trafficScore).not.toBeNull();
    expect(rawMetrics.map((m) => m.label)).toContain('dead');
    expect(rawMetrics.map((m) => m.label)).toContain('deleted');
  });

  // A deleted item reports 0/0 — the gate must still hold on a zero score.
  it('persists a zeroed-out deleted item too', () => {
    const deleted = [
      { label: 'score', data: [{ total: 0, date: 'd' }], percentageChange: 0 },
      { label: 'comments', data: [{ total: 0, date: 'd' }], percentageChange: 0 },
      { label: 'dead', data: [{ total: 0, date: 'd' }], percentageChange: 0 },
      { label: 'deleted', data: [{ total: 1, date: 'd' }], percentageChange: 0 },
    ] as any;
    expect(extractMetrics('hackernews', deleted).trafficScore).toBe(0);
  });
});
