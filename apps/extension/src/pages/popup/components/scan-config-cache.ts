export interface AutoSyncScanConfig {
  entitlement?: { limits?: { scanIntervalHours?: number | null } | null } | null;
  scanIntervals?: {
    scanIntervalHours?: number | null;
    keywordHours?: number | null;
    channelHours?: number | null;
    trackedHours?: number | null;
  } | null;
}

export interface AutoSyncConfigCache {
  data?: AutoSyncScanConfig | null;
  syncedAt?: number | null;
}

const HOUR_MS = 3_600_000;
const DEFAULT_SCAN_INTERVAL_HOURS = 24;

function positiveHours(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : null;
}

export function getConfigAutoSyncIntervalMs(
  config: AutoSyncScanConfig | null | undefined
): number {
  const intervals = config?.scanIntervals;
  const candidates = [
    intervals?.keywordHours,
    intervals?.channelHours,
    intervals?.trackedHours,
    intervals?.scanIntervalHours,
    config?.entitlement?.limits?.scanIntervalHours,
  ]
    .map(positiveHours)
    .filter((value): value is number => value != null);

  return (candidates.length ? Math.min(...candidates) : DEFAULT_SCAN_INTERVAL_HOURS) * HOUR_MS;
}

export function shouldAutoSyncConfigCache(
  cache: AutoSyncConfigCache | null | undefined,
  nowMs = Date.now()
): boolean {
  if (!cache?.data || !positiveHours(cache.syncedAt)) return true;
  return nowMs - cache.syncedAt >= getConfigAutoSyncIntervalMs(cache.data);
}
