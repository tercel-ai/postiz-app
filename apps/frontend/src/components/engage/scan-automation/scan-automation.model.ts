export interface ScanUnitRow {
  id: string;
  platform: string;
  type: 'keyword' | 'channel' | 'tracked';
  label: string;
  lastScannedAt: string | null;
  nextScanAt: string | null;
  due: boolean;
}

export interface EngageScanAutomationConfig {
  enabled?: boolean;
  keywords?: Array<{
    id: string;
    keyword: string;
    enabled: boolean;
    scanCursors?: Array<{
      platform: string;
      lastScannedAt: string | null;
      nextScanAt: string | null;
    }>;
  }>;
  monitoredChannels?: Array<{
    id: string;
    platform: string;
    channelId: string;
    channelName?: string;
    enabled: boolean;
    lastScannedAt?: string | null;
  }>;
  trackedAccounts?: Array<{
    id: string;
    platform?: string;
    username: string;
    enabled: boolean;
    lastCheckedAt?: string | null;
  }>;
  scanIntervals?: { scanIntervalHours?: number };
  scanStatus?: {
    lastScanAt: string | null;
    nextScanAt: string | null;
    keyword?: { lastScanAt: string | null; nextScanAt: string | null };
    channel?: { lastScanAt: string | null; nextScanAt: string | null };
    tracked?: { lastScanAt: string | null; nextScanAt: string | null };
  };
  entitlement?: {
    plan?: string;
    limits?: { scanIntervalHours?: number };
  };
}

function nextFrom(
  last: string | null | undefined,
  hours: number
): string | null {
  if (!last) return null;
  return new Date(new Date(last).getTime() + hours * 3_600_000).toISOString();
}

function isDue(next: string | null, now: Date): boolean {
  return !next || new Date(next).getTime() <= now.getTime();
}

export function buildScanUnitRows(
  config: EngageScanAutomationConfig,
  now: Date = new Date()
): ScanUnitRow[] {
  const interval =
    config.scanIntervals?.scanIntervalHours ??
    config.entitlement?.limits?.scanIntervalHours ??
    24;
  const rows: ScanUnitRow[] = [];

  for (const keyword of config.keywords ?? []) {
    if (!keyword.enabled) continue;
    const cursors = keyword.scanCursors ?? [];
    if (!cursors.length) {
      rows.push({
        id: `${keyword.id}:unscanned`,
        platform: 'pending',
        type: 'keyword',
        label: keyword.keyword,
        lastScannedAt: null,
        nextScanAt: null,
        due: true,
      });
      continue;
    }
    for (const cursor of cursors) {
      rows.push({
        id: `${keyword.id}:${cursor.platform}`,
        platform: cursor.platform,
        type: 'keyword',
        label: keyword.keyword,
        lastScannedAt: cursor.lastScannedAt,
        nextScanAt: cursor.nextScanAt,
        due: !cursor.lastScannedAt || isDue(cursor.nextScanAt, now),
      });
    }
  }

  for (const channel of config.monitoredChannels ?? []) {
    if (!channel.enabled) continue;
    const lastScannedAt = channel.lastScannedAt ?? null;
    const nextScanAt = nextFrom(lastScannedAt, interval);
    rows.push({
      id: channel.id,
      platform: channel.platform,
      type: 'channel',
      label: channel.channelName || channel.channelId,
      lastScannedAt,
      nextScanAt,
      due: isDue(nextScanAt, now),
    });
  }

  for (const account of config.trackedAccounts ?? []) {
    if (!account.enabled) continue;
    const lastScannedAt = account.lastCheckedAt ?? null;
    const nextScanAt = nextFrom(lastScannedAt, interval);
    rows.push({
      id: account.id,
      platform: account.platform ?? 'x',
      type: 'tracked',
      label: `@${account.username}`,
      lastScannedAt,
      nextScanAt,
      due: isDue(nextScanAt, now),
    });
  }

  return rows;
}
