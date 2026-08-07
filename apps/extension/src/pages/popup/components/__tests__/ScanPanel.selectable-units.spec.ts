import { describe, expect, it } from 'vitest';
import {
  buildSelectableScanUnits,
  scanUnitSelectorKey,
  type EngageConfig,
} from '../ScanPanel';

describe('buildSelectableScanUnits', () => {
  const config: EngageConfig = {
    keywords: [
      {
        id: 'kw1',
        keyword: ' AI  Agent ',
        enabled: true,
        scanCursors: [
          {
            platform: 'reddit',
            lastScannedAt: '2020-01-01T00:00:00.000Z',
            nextScanAt: '2020-01-02T00:00:00.000Z',
          },
        ],
      },
      { id: 'kw2', keyword: 'disabled', enabled: false },
    ],
    monitoredChannels: [
      {
        id: 'ch1',
        platform: 'reddit',
        channelId: 'LocalLLM',
        channelName: 'Local LLM',
        enabled: true,
      },
    ],
    trackedAccounts: [
      {
        id: 'acct1',
        username: '@Alice',
        enabled: true,
        platform: 'x',
      },
      {
        id: 'acct2',
        username: 'JohnDoe',
        enabled: true,
        platform: 'devto',
      },
      {
        id: 'acct3',
        username: 'John-Doe',
        enabled: true,
        platform: 'quora',
      },
    ],
  };

  it('builds one selectable keyword unit per visible platform (all 7) plus channel and tracked units', () => {
    const units = buildSelectableScanUnits(config, 'all', new Date('2020-01-03T00:00:00.000Z').getTime());

    expect(units.map((u) => u.id)).toEqual([
      'x:keyword:ai agent',
      'reddit:keyword:ai agent',
      'linkedin:keyword:ai agent',
      'devto:keyword:ai agent',
      'hackernews:keyword:ai agent',
      'medium:keyword:ai agent',
      'quora:keyword:ai agent',
      'x:tracked:alice',
      'devto:tracked:johndoe',
      'quora:tracked:John-Doe',
      'reddit:channel:LocalLLM',
    ]);

    const kwUnit = units.find((u) => u.id === 'reddit:keyword:ai agent')!;
    expect(kwUnit).toMatchObject({
      platform: 'reddit', scanType: 'keyword', scanKey: 'ai agent', label: 'AI  Agent', due: true,
    });
    const trackedUnit = units.find((u) => u.id === 'x:tracked:alice')!;
    expect(trackedUnit).toMatchObject({
      platform: 'x', scanType: 'tracked', scanKey: 'alice', label: '@Alice', due: true,
    });
    const channelUnit = units.find((u) => u.id === 'reddit:channel:LocalLLM')!;
    expect(channelUnit).toMatchObject({
      platform: 'reddit', scanType: 'channel', scanKey: 'LocalLLM', label: 'Local LLM', due: true,
    });
  });

  it('normalizes tracked usernames per-platform to match the backend canonical key (normalizeUsername in engage-scan-lease.service.ts)', () => {
    const units = buildSelectableScanUnits(config, 'devto');
    // devto is case-insensitive on the backend — must lowercase here too, or
    // this popup's scanKey never matches the real EngageScanCursor row.
    expect(units.map((u) => u.id)).toEqual(['devto:keyword:ai agent', 'devto:tracked:johndoe']);

    const quoraUnits = buildSelectableScanUnits(config, 'quora');
    // Quora profile slugs are case-SENSITIVE on the backend — must be preserved.
    expect(quoraUnits.map((u) => u.id)).toEqual(['quora:keyword:ai agent', 'quora:tracked:John-Doe']);
  });

  it('respects the popup platform filter', () => {
    expect(buildSelectableScanUnits(config, 'reddit').map((u) => u.id)).toEqual([
      'reddit:keyword:ai agent',
      'reddit:channel:LocalLLM',
    ]);
  });

  it('excludes an x-only tracked account and channel when filtering to a platform neither is on', () => {
    expect(buildSelectableScanUnits(config, 'linkedin').map((u) => u.id)).toEqual([
      'linkedin:keyword:ai agent',
    ]);
  });

  it('uses the backend selector tuple as the stable checkbox key', () => {
    expect(scanUnitSelectorKey({ platform: 'x', scanType: 'tracked', scanKey: 'alice' })).toBe(
      'x:tracked:alice'
    );
  });
});
