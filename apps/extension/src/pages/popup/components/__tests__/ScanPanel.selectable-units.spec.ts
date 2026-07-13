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
    ],
  };

  it('builds one selectable keyword unit per visible platform plus channel and tracked units', () => {
    const units = buildSelectableScanUnits(config, 'both', new Date('2020-01-03T00:00:00.000Z').getTime());

    expect(units.map((u) => ({
      id: u.id,
      platform: u.platform,
      scanType: u.scanType,
      scanKey: u.scanKey,
      label: u.label,
      due: u.due,
    }))).toEqual([
      {
        id: 'x:keyword:ai agent',
        platform: 'x',
        scanType: 'keyword',
        scanKey: 'ai agent',
        label: 'AI  Agent',
        due: true,
      },
      {
        id: 'reddit:keyword:ai agent',
        platform: 'reddit',
        scanType: 'keyword',
        scanKey: 'ai agent',
        label: 'AI  Agent',
        due: true,
      },
      {
        id: 'x:tracked:alice',
        platform: 'x',
        scanType: 'tracked',
        scanKey: 'alice',
        label: '@Alice',
        due: true,
      },
      {
        id: 'reddit:channel:LocalLLM',
        platform: 'reddit',
        scanType: 'channel',
        scanKey: 'LocalLLM',
        label: 'Local LLM',
        due: true,
      },
    ]);
  });

  it('respects the popup platform filter', () => {
    expect(buildSelectableScanUnits(config, 'reddit').map((u) => u.id)).toEqual([
      'reddit:keyword:ai agent',
      'reddit:channel:LocalLLM',
    ]);
  });

  it('uses the backend selector tuple as the stable checkbox key', () => {
    expect(scanUnitSelectorKey({ platform: 'x', scanType: 'tracked', scanKey: 'alice' })).toBe(
      'x:tracked:alice'
    );
  });
});
