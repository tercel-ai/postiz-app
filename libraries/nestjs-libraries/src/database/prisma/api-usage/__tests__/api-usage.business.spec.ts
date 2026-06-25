import { describe, it, expect } from 'vitest';
import {
  BIZ_USAGE,
  ENGAGE_SCORE_BUCKETS,
  engageScoreBucket,
  getBizUsageContext,
  recordApiUsage,
  runWithBizUsage,
} from '../api-usage.service';

describe('engageScoreBucket', () => {
  it('maps the documented non-overlapping bands', () => {
    // Lower-exclusive / upper-inclusive (first band 0-inclusive). Every boundary
    // belongs to exactly one band.
    expect(engageScoreBucket(0)).toBe('0-50');
    expect(engageScoreBucket(50)).toBe('0-50'); // 50 ∈ [0,50]
    expect(engageScoreBucket(50.0001)).toBe('50-60');
    expect(engageScoreBucket(60)).toBe('50-60'); // 60 ∈ (50,60]
    expect(engageScoreBucket(61)).toBe('60-70');
    expect(engageScoreBucket(70)).toBe('60-70'); // 70 ∈ (60,70]
    expect(engageScoreBucket(71)).toBe('70-85');
    expect(engageScoreBucket(85)).toBe('70-85'); // 85 ∈ (70,85]
    expect(engageScoreBucket(86)).toBe('85-100');
  });

  it('top band is a catch-all that also covers the scorer max of 105 (>100)', () => {
    expect(engageScoreBucket(100)).toBe('85-100');
    expect(engageScoreBucket(105)).toBe('85-100'); // would otherwise be lost
  });

  it('only ever returns one of the fixed bucket labels', () => {
    for (let s = 0; s <= 110; s++) {
      expect(ENGAGE_SCORE_BUCKETS).toContain(engageScoreBucket(s));
    }
  });
});

describe('runWithBizUsage / getBizUsageContext', () => {
  it('exposes the context only inside the scope', () => {
    expect(getBizUsageContext()).toBeUndefined();
    const seen = runWithBizUsage(
      { organizationId: 'org_1', bizCategory: BIZ_USAGE.ENGAGE_REPLY },
      () => getBizUsageContext()
    );
    expect(seen).toEqual({
      organizationId: 'org_1',
      bizCategory: BIZ_USAGE.ENGAGE_REPLY,
    });
    expect(getBizUsageContext()).toBeUndefined();
  });

  it('survives awaits within the scope', async () => {
    const after = await runWithBizUsage(
      { organizationId: 'org_2', bizCategory: BIZ_USAGE.ENGAGE_SCAN },
      async () => {
        await Promise.resolve();
        await new Promise((r) => setTimeout(r, 1));
        return getBizUsageContext();
      }
    );
    expect(after?.bizCategory).toBe(BIZ_USAGE.ENGAGE_SCAN);
  });

  it('nested scopes shadow then restore the parent', () => {
    runWithBizUsage(
      { organizationId: 'org_a', bizCategory: BIZ_USAGE.POST_PUBLISH },
      () => {
        expect(getBizUsageContext()?.bizCategory).toBe(BIZ_USAGE.POST_PUBLISH);
        runWithBizUsage(
          { organizationId: 'org_a', bizCategory: BIZ_USAGE.AUTO_PLUG },
          () => {
            expect(getBizUsageContext()?.bizCategory).toBe(BIZ_USAGE.AUTO_PLUG);
          }
        );
        // back to the outer scope
        expect(getBizUsageContext()?.bizCategory).toBe(BIZ_USAGE.POST_PUBLISH);
      }
    );
  });

  it('recordApiUsage is a safe no-op before any recorder is registered', () => {
    // No recorder is wired in this pure unit test; recording must never throw,
    // with or without an active business context.
    expect(() => recordApiUsage('x', 'posts_read', 3)).not.toThrow();
    expect(() =>
      runWithBizUsage(
        { organizationId: 'org_x', bizCategory: BIZ_USAGE.ENGAGE_SCAN },
        () => recordApiUsage('x', 'posts_read', 3)
      )
    ).not.toThrow();
  });
});
