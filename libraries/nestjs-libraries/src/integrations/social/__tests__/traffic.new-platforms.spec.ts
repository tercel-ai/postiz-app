import { describe, it, expect } from 'vitest';
import { computeTrafficScore } from '../traffic.calculator';

const series = (label: string, total: number) => ({
  label,
  data: [{ total, date: '2026-07-27T00:00:00Z' }],
});

describe('computeTrafficScore — article/forum platforms', () => {
  it('weights dev.to reactions + comments + impressions', () => {
    // reactions 10×1 + comments 4×3 + impressions 200×0.05 = 10 + 12 + 10 = 32
    const score = computeTrafficScore('devto', [
      series('reactions', 10),
      series('comments', 4),
      series('impressions', 200),
    ]);
    expect(score).toBe(32);
  });

  it('weights hacker news score + comments like reddit', () => {
    // score 100×0.5 + comments 8×3 = 50 + 24 = 74
    expect(
      computeTrafficScore('hackernews', [series('score', 100), series('comments', 8)])
    ).toBe(74);
  });

  it('weights medium claps + comments', () => {
    // claps 30×1 + comments 5×3 = 45
    expect(
      computeTrafficScore('medium', [series('claps', 30), series('comments', 5)])
    ).toBe(45);
  });

  it('weights quora upvotes + impressions', () => {
    // upvotes 12×1 + impressions 500×0.05 = 12 + 25 = 37
    expect(
      computeTrafficScore('quora', [series('upvotes', 12), series('impressions', 500)])
    ).toBe(37);
  });

  it('ignores labels a platform has no weight for, and returns null when none match', () => {
    // devto has no 'shares' weight → skipped; nothing matches → null.
    expect(computeTrafficScore('devto', [series('shares', 99)])).toBeNull();
  });
});
