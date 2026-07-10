import { describe, expect, it } from 'vitest';
import {
  getConfigAutoSyncIntervalMs,
  shouldAutoSyncConfigCache,
} from '../scan-config-cache';

describe('scan config auto-sync cadence', () => {
  it('auto-syncs when there is no cached config', () => {
    expect(shouldAutoSyncConfigCache(null, 1_000)).toBe(true);
    expect(shouldAutoSyncConfigCache({ data: null, syncedAt: 1 }, 1_000)).toBe(true);
  });

  it('uses the shortest configured scan interval for stale-cache decisions', () => {
    const syncedAt = Date.UTC(2026, 0, 1, 0, 0, 0);
    const data = {
      entitlement: { limits: { scanIntervalHours: 24 } },
      scanIntervals: {
        scanIntervalHours: 12,
        keywordHours: 6,
        channelHours: 4,
        trackedHours: 8,
      },
    };

    expect(getConfigAutoSyncIntervalMs(data)).toBe(4 * 3_600_000);
    expect(shouldAutoSyncConfigCache({ data, syncedAt }, syncedAt + 4 * 3_600_000 - 1)).toBe(false);
    expect(shouldAutoSyncConfigCache({ data, syncedAt }, syncedAt + 4 * 3_600_000)).toBe(true);
  });

  it('falls back to the default daily cadence when the cached config has no valid interval', () => {
    const syncedAt = Date.UTC(2026, 0, 1, 0, 0, 0);
    const data = {
      entitlement: { limits: { scanIntervalHours: 0 } },
      scanIntervals: {
        scanIntervalHours: -1,
      },
    };

    expect(getConfigAutoSyncIntervalMs(data)).toBe(24 * 3_600_000);
    expect(shouldAutoSyncConfigCache({ data, syncedAt }, syncedAt + 23 * 3_600_000)).toBe(false);
    expect(shouldAutoSyncConfigCache({ data, syncedAt }, syncedAt + 24 * 3_600_000)).toBe(true);
  });
});
