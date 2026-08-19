import { beforeEach, describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_PUBLISH_TIME_WINDOW_SETTING,
  DEFAULT_SEGMENT_GAP_SETTING,
  EXTENSION_PUBLISH_SEGMENT_GAP_KEY,
  EXTENSION_PUBLISH_TIME_WINDOW_KEY,
  ExtensionPublishConfigService,
  redistributePublishTimeIfOutsideWindow,
  resolvePublishTimeWindows,
  resolveSegmentGaps,
} from '../extension-publish-config.service';
import {
  DEFAULT_SEGMENT_GAP_RANGE,
  DEFAULT_SEGMENT_GAP_S,
  EXTENSION_PUBLISHABLE_PLATFORMS,
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

  it('seeds the default TIME WINDOW setting once on module init', async () => {
    const settings: any = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
    };
    const svc = new ExtensionPublishConfigService(settings);
    await svc.onModuleInit();
    expect(settings.set).toHaveBeenCalledWith(
      EXTENSION_PUBLISH_TIME_WINDOW_KEY,
      DEFAULT_PUBLISH_TIME_WINDOW_SETTING,
      expect.objectContaining({ type: 'object' })
    );

    settings.get.mockResolvedValue(DEFAULT_PUBLISH_TIME_WINDOW_SETTING);
    settings.set.mockClear();
    await svc.onModuleInit();
    expect(settings.set).not.toHaveBeenCalled();
  });

  it('getPublishTimeWindows resolves from the stored setting', async () => {
    const settings: any = {
      get: vi.fn().mockResolvedValue({
        platforms: { reddit: { windowStart: '08:00', windowEnd: '20:00' } },
      }),
    };
    const svc = new ExtensionPublishConfigService(settings);
    const windows = await svc.getPublishTimeWindows();
    expect(windows).toEqual({
      reddit: { windowStart: '08:00', windowEnd: '20:00' },
    });
  });
});

describe('resolvePublishTimeWindows', () => {
  it('returns an empty map when nothing is stored (no platform is constrained)', () => {
    expect(resolvePublishTimeWindows(null)).toEqual({});
    expect(resolvePublishTimeWindows(undefined)).toEqual({});
    expect(resolvePublishTimeWindows({})).toEqual({});
  });

  it('applies the stored global default to every publishable platform', () => {
    const resolved = resolvePublishTimeWindows({
      default: { windowStart: '09:00', windowEnd: '17:00' },
    });
    expect(Object.keys(resolved).sort()).toEqual(
      [...EXTENSION_PUBLISHABLE_PLATFORMS].sort()
    );
    for (const window of Object.values(resolved)) {
      expect(window).toEqual({ windowStart: '09:00', windowEnd: '17:00' });
    }
  });

  it('lets a platform override beat the global default', () => {
    const resolved = resolvePublishTimeWindows({
      default: { windowStart: '09:00', windowEnd: '17:00' },
      platforms: { reddit: { windowStart: '06:00', windowEnd: '22:00' } },
    });
    expect(resolved.reddit).toEqual({ windowStart: '06:00', windowEnd: '22:00' });
    expect(resolved.x).toEqual({ windowStart: '09:00', windowEnd: '17:00' });
  });

  it('a platform override with no global default constrains ONLY that platform', () => {
    const resolved = resolvePublishTimeWindows({
      platforms: { x: { windowStart: '09:00', windowEnd: '17:00' } },
    });
    expect(resolved).toEqual({ x: { windowStart: '09:00', windowEnd: '17:00' } });
    expect(resolved.reddit).toBeUndefined();
  });

  it('rejects a malformed window (missing or badly-shaped bounds)', () => {
    const resolved = resolvePublishTimeWindows({
      default: { windowStart: '09:00', windowEnd: '17:00' },
      platforms: {
        x: { windowStart: '9:00', windowEnd: '17:00' } as any, // not zero-padded
        reddit: { windowStart: '09:00' } as any, // missing windowEnd
      },
    });
    // Bad overrides fall through to the global default rather than being kept.
    expect(resolved.x).toEqual({ windowStart: '09:00', windowEnd: '17:00' });
    expect(resolved.reddit).toEqual({ windowStart: '09:00', windowEnd: '17:00' });
  });

  it('rejects out-of-range, empty, and invalid-timezone windows', () => {
    const resolved = resolvePublishTimeWindows({
      default: { windowStart: '09:00', windowEnd: '17:00' },
      platforms: {
        x: { windowStart: '24:00', windowEnd: '17:00' } as any,
        reddit: { windowStart: '09:00', windowEnd: '09:00' } as any,
        linkedin: {
          windowStart: '09:00',
          windowEnd: '17:00',
          timezone: 'Not/A_Timezone',
        } as any,
      },
    });

    expect(resolved.x).toEqual({ windowStart: '09:00', windowEnd: '17:00' });
    expect(resolved.reddit).toEqual({ windowStart: '09:00', windowEnd: '17:00' });
    expect(resolved.linkedin).toEqual({ windowStart: '09:00', windowEnd: '17:00' });
  });

  it('carries the timezone through when present', () => {
    const resolved = resolvePublishTimeWindows({
      platforms: {
        x: { windowStart: '09:00', windowEnd: '17:00', timezone: 'Asia/Tokyo' },
      },
    });
    expect(resolved.x?.timezone).toBe('Asia/Tokyo');
  });
});

describe('redistributePublishTimeIfOutsideWindow', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('returns the same Date instance when already inside the window (UTC)', () => {
    const date = new Date('2026-08-01T12:00:00.000Z');
    const result = redistributePublishTimeIfOutsideWindow(date, {
      windowStart: '09:00',
      windowEnd: '17:00',
    });
    expect(result).toBe(date);
  });

  it('treats windowStart as inclusive and windowEnd as exclusive', () => {
    const window = { windowStart: '09:00', windowEnd: '17:00' };
    expect(
      redistributePublishTimeIfOutsideWindow(
        new Date('2026-08-01T09:00:00.000Z'),
        window
      )
    ).toEqual(new Date('2026-08-01T09:00:00.000Z')); // start boundary: in
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(
      redistributePublishTimeIfOutsideWindow(
        new Date('2026-08-01T17:00:00.000Z'),
        window
      )
    ).toEqual(new Date('2026-08-01T09:00:00.000Z')); // end boundary: out, re-picked
  });

  it('re-picks a uniform random instant inside a non-wrapping window', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.25);
    const result = redistributePublishTimeIfOutsideWindow(
      new Date('2026-08-01T03:00:00.000Z'),
      { windowStart: '09:00', windowEnd: '17:00' } // 480min span
    );
    // floor(0.25 * 480) = 120min -> 09:00 + 2:00 = 11:00
    expect(result).toEqual(new Date('2026-08-01T11:00:00.000Z'));
  });

  it('a wrapping window can re-pick to the SAME calendar day (near windowStart)', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const result = redistributePublishTimeIfOutsideWindow(
      new Date('2026-08-01T10:00:00.000Z'),
      { windowStart: '22:00', windowEnd: '02:00' }
    );
    expect(result).toEqual(new Date('2026-08-01T22:00:00.000Z'));
  });

  it('a wrapping window can re-pick into the NEXT calendar day (past midnight)', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.9);
    const result = redistributePublishTimeIfOutsideWindow(
      new Date('2026-08-01T10:00:00.000Z'),
      { windowStart: '22:00', windowEnd: '02:00' } // 240min span
    );
    // floor(0.9 * 240) = 216min -> 22:00 + 3:36 = next-day 01:36
    expect(result).toEqual(new Date('2026-08-02T01:36:00.000Z'));
  });

  it('treats a wrapping window\'s early-morning tail as inside (no re-pick)', () => {
    const result = redistributePublishTimeIfOutsideWindow(
      new Date('2026-08-01T01:00:00.000Z'), // 01:00 UTC, inside ...-02:00 tail
      { windowStart: '22:00', windowEnd: '02:00' }
    );
    expect(result).toEqual(new Date('2026-08-01T01:00:00.000Z'));
  });

  it('evaluates the window in the given IANA timezone, not UTC', () => {
    // 2026-08-01T03:00:00Z is 12:00 local in Asia/Tokyo (UTC+9) -> inside.
    const inside = redistributePublishTimeIfOutsideWindow(
      new Date('2026-08-01T03:00:00.000Z'),
      { windowStart: '09:00', windowEnd: '17:00', timezone: 'Asia/Tokyo' }
    );
    expect(inside).toEqual(new Date('2026-08-01T03:00:00.000Z'));

    // Same instant evaluated in UTC (no timezone) is 03:00 local -> outside.
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const outside = redistributePublishTimeIfOutsideWindow(
      new Date('2026-08-01T03:00:00.000Z'),
      { windowStart: '09:00', windowEnd: '17:00' }
    );
    expect(outside).toEqual(new Date('2026-08-01T09:00:00.000Z'));
  });
});
