import { describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_SEGMENT_GAP_SETTING,
  EXTENSION_PUBLISH_SEGMENT_GAP_KEY,
  ExtensionPublishConfigService,
  resolveSegmentGaps,
} from '../extension-publish-config.service';
import {
  DEFAULT_SEGMENT_GAP_RANGE,
  DEFAULT_SEGMENT_GAP_S,
  MAX_SEGMENT_GAP_S,
} from '@gitroom/helpers/extension/post-publish';

describe('resolveSegmentGaps', () => {
  it('returns the built-in defaults when nothing is stored', () => {
    expect(resolveSegmentGaps(null)).toEqual(DEFAULT_SEGMENT_GAP_S);
    expect(resolveSegmentGaps(undefined)).toEqual(DEFAULT_SEGMENT_GAP_S);
    expect(resolveSegmentGaps({})).toEqual(DEFAULT_SEGMENT_GAP_S);
  });

  it('applies the stored global default to every platform without an override', () => {
    const resolved = resolveSegmentGaps({ default: [10, 60] });
    for (const range of Object.values(resolved)) {
      expect(range).toEqual([10, 60]);
    }
  });

  it('lets a platform override beat the global default', () => {
    const resolved = resolveSegmentGaps({
      default: [10, 60],
      platforms: { reddit: [45, 180] },
    });
    expect(resolved.reddit).toEqual([45, 180]);
    expect(resolved.x).toEqual([10, 60]);
  });

  it('falls through per tier on malformed ranges', () => {
    // Bad platform override → global default; bad global → built-in.
    const resolved = resolveSegmentGaps({
      default: [10, 60],
      platforms: { x: [120, 30] as any },
    });
    expect(resolved.x).toEqual([10, 60]);

    const badGlobal = resolveSegmentGaps({
      default: [60, 10] as any,
      platforms: { reddit: [45, 180] },
    });
    expect(badGlobal.reddit).toEqual([45, 180]);
    expect(badGlobal.x).toEqual(DEFAULT_SEGMENT_GAP_RANGE);
  });

  it('accepts [0, 0] as a valid disable value at either tier', () => {
    expect(resolveSegmentGaps({ default: [0, 0] }).x).toEqual([0, 0]);
    expect(
      resolveSegmentGaps({ platforms: { medium: [0, 0] } }).medium
    ).toEqual([0, 0]);
  });

  it('clamps both bounds to MAX_SEGMENT_GAP_S', () => {
    const resolved = resolveSegmentGaps({
      default: [700, 900],
      platforms: { reddit: [100, 9000] },
    });
    expect(resolved.x).toEqual([MAX_SEGMENT_GAP_S, MAX_SEGMENT_GAP_S]);
    expect(resolved.reddit).toEqual([100, MAX_SEGMENT_GAP_S]);
  });

  it('treats the legacy flat per-platform shape as platform overrides', () => {
    const resolved = resolveSegmentGaps({ reddit: [45, 180] } as any);
    expect(resolved.reddit).toEqual([45, 180]);
    expect(resolved.x).toEqual(DEFAULT_SEGMENT_GAP_RANGE);
  });

  it('never emits platforms outside the publishable set', () => {
    const resolved = resolveSegmentGaps({
      platforms: { instagram: [10, 20] } as any,
    });
    expect(resolved).not.toHaveProperty('instagram');
  });
});

describe('ExtensionPublishConfigService', () => {
  it('seeds the default setting once on module init', async () => {
    const settings: any = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
    };
    const svc = new ExtensionPublishConfigService(settings);
    await svc.onModuleInit();
    expect(settings.set).toHaveBeenCalledWith(
      EXTENSION_PUBLISH_SEGMENT_GAP_KEY,
      DEFAULT_SEGMENT_GAP_SETTING,
      expect.objectContaining({ type: 'object' })
    );

    settings.get.mockResolvedValue(DEFAULT_SEGMENT_GAP_SETTING);
    settings.set.mockClear();
    await svc.onModuleInit();
    expect(settings.set).not.toHaveBeenCalled();
  });

  it('resolves the effective config from the stored setting', async () => {
    const settings: any = {
      get: vi
        .fn()
        .mockResolvedValue({ default: [15, 45], platforms: { x: [10, 40] } }),
    };
    const svc = new ExtensionPublishConfigService(settings);
    const gaps = await svc.getSegmentGaps();
    expect(gaps.x).toEqual([10, 40]);
    expect(gaps.reddit).toEqual([15, 45]);
  });
});
