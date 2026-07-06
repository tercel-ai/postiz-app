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

  it('prefers the real scanCursor over the legacy field for channels and tracked accounts', () => {
    const rows = buildScanUnitRows(
      {
        keywords: [],
        monitoredChannels: [
          {
            id: 'ch-1',
            platform: 'reddit',
            channelId: 'foo',
            channelName: 'foo',
            enabled: true,
            // Stale per-row bookkeeping field (only the workflow writes it).
            lastScannedAt: '2026-06-01T00:00:00.000Z',
            // Fresh source-of-truth cursor — must win.
            scanCursor: {
              lastScannedAt: '2026-06-28T00:00:00.000Z',
              nextScanAt: '2026-06-29T00:00:00.000Z',
            },
          },
        ],
        trackedAccounts: [
          {
            id: 'acc-1',
            platform: 'x',
            username: 'bar',
            enabled: true,
            lastCheckedAt: '2026-06-01T00:00:00.000Z',
            scanCursor: {
              lastScannedAt: '2026-06-28T00:00:00.000Z',
              nextScanAt: '2026-06-29T00:00:00.000Z',
            },
          },
        ],
        scanIntervals: { scanIntervalHours: 24 },
      },
      new Date('2026-06-28T12:00:00.000Z')
    );

    expect(rows).toEqual([
      expect.objectContaining({
        id: 'ch-1',
        type: 'channel',
        // Cursor value, NOT the stale legacy 2026-06-01 field.
        lastScannedAt: '2026-06-28T00:00:00.000Z',
        nextScanAt: '2026-06-29T00:00:00.000Z',
        due: false,
      }),
      expect.objectContaining({
        id: 'acc-1',
        type: 'tracked',
        lastScannedAt: '2026-06-28T00:00:00.000Z',
        nextScanAt: '2026-06-29T00:00:00.000Z',
        due: false,
      }),
    ]);
  });

  it('marks a never-scanned unit (cursor present, lastScannedAt null) as due', () => {
    const rows = buildScanUnitRows(
      {
        keywords: [],
        monitoredChannels: [
          {
            id: 'ch-2',
            platform: 'reddit',
            channelId: 'baz',
            channelName: 'baz',
            enabled: true,
            // Cursor exists but has never completed a scan.
            scanCursor: {
              lastScannedAt: null,
              // nextScanAt in the future: without the `!lastScannedAt` rule the
              // unit would wrongly read as cooling here.
              nextScanAt: '2026-06-29T00:00:00.000Z',
            },
          },
        ],
        trackedAccounts: [
          {
            id: 'acc-2',
            platform: 'x',
            username: 'qux',
            enabled: true,
            scanCursor: {
              lastScannedAt: null,
              nextScanAt: '2026-06-29T00:00:00.000Z',
            },
          },
        ],
        scanIntervals: { scanIntervalHours: 24 },
      },
      new Date('2026-06-28T12:00:00.000Z')
    );

    expect(rows).toEqual([
      expect.objectContaining({
        id: 'ch-2',
        type: 'channel',
        lastScannedAt: null,
        due: true,
      }),
      expect.objectContaining({
        id: 'acc-2',
        type: 'tracked',
        lastScannedAt: null,
        due: true,
      }),
    ]);
  });
});
