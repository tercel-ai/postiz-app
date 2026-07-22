import { describe, expect, it } from 'vitest';
import { buildLinkedinScanUrl } from '../scan.linkedin';
import type { EngageScanTask } from '../executor.types';

function task(partial: Partial<EngageScanTask>): EngageScanTask {
  return {
    taskId: 't',
    platform: 'linkedin',
    scanType: 'keyword',
    scanKey: 'ai agents',
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

describe('buildLinkedinScanUrl', () => {
  it('builds a date-sorted content search for keyword scans', () => {
    const url = buildLinkedinScanUrl(task({ scanType: 'keyword', scanKey: 'ai agents' }));
    expect(url).toContain('/search/results/content/');
    expect(url).toContain('keywords=ai%20agents');
    expect(url).toContain('sortBy=%22date_posted%22');
  });

  it('prefers a backend-built rawQuery over scanKey', () => {
    const url = buildLinkedinScanUrl(
      task({ scanType: 'keyword', scanKey: 'kw', rawQuery: 'a OR b' })
    );
    expect(url).toContain('keywords=a%20OR%20b');
  });

  it('builds a recent-activity URL for tracked accounts', () => {
    const url = buildLinkedinScanUrl(
      task({ scanType: 'tracked', scanKey: '@john-doe' })
    );
    expect(url).toBe(
      'https://www.linkedin.com/in/john-doe/recent-activity/all/'
    );
  });
});
