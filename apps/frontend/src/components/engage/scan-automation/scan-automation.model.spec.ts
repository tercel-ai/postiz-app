import { describe, expect, it } from 'vitest';
import { buildScanUnitRows } from './scan-automation.model';

describe('buildScanUnitRows', () => {
  it('maps keyword cursors and marks overdue units', () => {
    const rows = buildScanUnitRows(
      {
        keywords: [
          {
            id: 'kw-1',
            keyword: 'AI agents',
            enabled: true,
            scanCursors: [
              {
                platform: 'x',
                lastScannedAt: '2026-06-28T00:00:00.000Z',
                nextScanAt: '2026-06-29T00:00:00.000Z',
              },
            ],
          },
        ],
        monitoredChannels: [],
        trackedAccounts: [],
        scanIntervals: { scanIntervalHours: 24 },
      },
      new Date('2026-06-29T01:00:00.000Z')
    );

    expect(rows).toEqual([
      expect.objectContaining({
        id: 'kw-1:x',
        platform: 'x',
        type: 'keyword',
        label: 'AI agents',
        due: true,
      }),
    ]);
  });
});
