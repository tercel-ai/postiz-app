import { beforeEach, describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_PUBLISH_TIME_WINDOW_SETTING,
  DEFAULT_SEGMENT_GAP_SETTING,
  EXTENSION_PUBLISH_SEGMENT_GAP_KEY,
  EXTENSION_PUBLISH_TIME_WINDOW_KEY,
  ExtensionPublishConfigService,
  DEFAULT_MIN_GAP_MINUTES,
  MAX_MIN_GAP_MINUTES,
  redistributePublishTimeIfOutsideWindow,
  redistributePublishTimesWithinWindow,
  resolveMinGaps,
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

describe('resolveMinGaps', () => {
  it('falls back to the built-in default for every platform when nothing is stored', () => {
    for (const stored of [null, undefined, {}] as const) {
      const resolved = resolveMinGaps(stored);
      for (const platform of EXTENSION_PUBLISHABLE_PLATFORMS) {
        expect(resolved[platform]).toBe(DEFAULT_MIN_GAP_MINUTES);
      }
    }
  });

  it('lets a platform override beat the stored global default', () => {
    const resolved = resolveMinGaps({ default: 20, platforms: { reddit: 90 } });
    expect(resolved.reddit).toBe(90);
    expect(resolved.x).toBe(20);
  });

  it('accepts 0 as a real value (spacing deliberately disabled)', () => {
    expect(resolveMinGaps({ default: 0 }).x).toBe(0);
    expect(resolveMinGaps({ default: 20, platforms: { x: 0 } }).x).toBe(0);
  });

  it('drops a malformed tier to the next one instead of disabling spacing', () => {
    const resolved = resolveMinGaps({
      default: 45,
      platforms: { x: -5, reddit: 'soon' } as never,
    });
    expect(resolved.x).toBe(45);
    expect(resolved.reddit).toBe(45);
    // A malformed global default falls all the way to the built-in.
    expect(resolveMinGaps({ default: Number.NaN }).x).toBe(DEFAULT_MIN_GAP_MINUTES);
  });

  it('caps every tier at MAX_MIN_GAP_MINUTES', () => {
    const resolved = resolveMinGaps({ default: 99_999, platforms: { x: 50_000 } });
    expect(resolved.x).toBe(MAX_MIN_GAP_MINUTES);
    expect(resolved.reddit).toBe(MAX_MIN_GAP_MINUTES);
  });
});

describe('redistributePublishTimesWithinWindow', () => {
  const WINDOW = { windowStart: '09:00', windowEnd: '18:00', timezone: 'UTC' };
  const at = (iso: string) => new Date(iso);
  const minutesOfDay = (date: Date) => date.getUTCHours() * 60 + date.getUTCMinutes();

  it('leaves every in-window post exactly where it is', () => {
    const posts = [
      { id: 'a', publishDate: at('2026-08-20T09:30:00.000Z') },
      { id: 'b', publishDate: at('2026-08-20T09:31:00.000Z') },
      { id: 'c', publishDate: at('2026-08-20T17:59:00.000Z') },
    ];
    const { moved, degraded } = redistributePublishTimesWithinWindow(posts, WINDOW, 30);
    // Including 'a' and 'b', which are one minute apart: the gap is enforced
    // against posts being PLACED, never retrofitted onto compliant ones.
    expect(moved.size).toBe(0);
    expect(degraded).toEqual([]);
  });

  it('moves out-of-window posts inside the window, on their own local day', () => {
    const posts = [
      { id: 'early', publishDate: at('2026-08-20T03:00:00.000Z') },
      { id: 'late', publishDate: at('2026-08-20T22:00:00.000Z') },
    ];
    const { moved } = redistributePublishTimesWithinWindow(posts, WINDOW, 30);
    expect(moved.size).toBe(2);
    for (const date of moved.values()) {
      expect(date.toISOString().slice(0, 10)).toBe('2026-08-20');
      expect(minutesOfDay(date)).toBeGreaterThanOrEqual(9 * 60);
      expect(minutesOfDay(date)).toBeLessThan(18 * 60);
    }
  });

  it('keeps placed posts at least minGapMinutes apart', () => {
    const posts = Array.from({ length: 6 }, (_, index) => ({
      id: `p${index}`,
      publishDate: at('2026-08-20T03:00:00.000Z'),
    }));
    const { moved, degraded } = redistributePublishTimesWithinWindow(posts, WINDOW, 60);
    expect(degraded).toEqual([]);
    const offsets = [...moved.values()].map(minutesOfDay).sort((a, b) => a - b);
    for (let i = 1; i < offsets.length; i++) {
      expect(offsets[i] - offsets[i - 1]).toBeGreaterThanOrEqual(60);
    }
  });

  it('respects the gap against posts already sitting in the window', () => {
    const posts = [
      { id: 'fixed', publishDate: at('2026-08-20T12:00:00.000Z') },
      { id: 'moved', publishDate: at('2026-08-20T02:00:00.000Z') },
    ];
    const { moved } = redistributePublishTimesWithinWindow(posts, WINDOW, 60);
    expect(moved.has('fixed')).toBe(false);
    const placed = minutesOfDay(moved.get('moved')!);
    expect(Math.abs(placed - 12 * 60)).toBeGreaterThanOrEqual(60);
  });

  it('degrades the gap rather than pushing a post outside a too-narrow window', () => {
    const narrow = { windowStart: '09:00', windowEnd: '10:00', timezone: 'UTC' };
    const posts = Array.from({ length: 5 }, (_, index) => ({
      id: `p${index}`,
      publishDate: at('2026-08-20T03:00:00.000Z'),
    }));
    const { moved, degraded } = redistributePublishTimesWithinWindow(posts, narrow, 30);
    expect(moved.size).toBe(5);
    // Every post is still inside the window — that is never traded for spacing.
    for (const date of moved.values()) {
      expect(minutesOfDay(date)).toBeGreaterThanOrEqual(9 * 60);
      expect(minutesOfDay(date)).toBeLessThan(10 * 60);
    }
    // ...and the shortfall is reported rather than swallowed.
    expect(degraded).toHaveLength(1);
    expect(degraded[0].requestedGapMinutes).toBe(30);
    expect(degraded[0].appliedGapMinutes).toBeLessThan(30);
  });

  it('treats each local day as its own window instance', () => {
    const posts = [
      { id: 'd1', publishDate: at('2026-08-20T03:00:00.000Z') },
      { id: 'd2', publishDate: at('2026-08-21T03:00:00.000Z') },
    ];
    const { moved, degraded } = redistributePublishTimesWithinWindow(posts, WINDOW, 600);
    // A 10h gap cannot fit twice in one 9h window, but these are different days
    // so neither constrains the other and no degradation is needed.
    expect(degraded).toEqual([]);
    expect(moved.get('d1')!.toISOString().slice(0, 10)).toBe('2026-08-20');
    expect(moved.get('d2')!.toISOString().slice(0, 10)).toBe('2026-08-21');
  });

  it('groups a wrapping window\'s two halves into one instance', () => {
    const night = { windowStart: '22:00', windowEnd: '02:00', timezone: 'UTC' };
    const posts = [
      // 00:30 on the 21st belongs to the occurrence that STARTED 22:00 on the 20th.
      { id: 'tail', publishDate: at('2026-08-21T00:30:00.000Z') },
      { id: 'move', publishDate: at('2026-08-20T12:00:00.000Z') },
    ];
    const { moved } = redistributePublishTimesWithinWindow(posts, night, 90);
    expect(moved.has('tail')).toBe(false);
    const placed = moved.get('move')!;
    // Placed inside 2026-08-20 22:00 → 2026-08-21 02:00, and ≥90min from 00:30.
    expect(placed.getTime()).toBeGreaterThanOrEqual(at('2026-08-20T22:00:00.000Z').getTime());
    expect(placed.getTime()).toBeLessThan(at('2026-08-21T02:00:00.000Z').getTime());
    expect(
      Math.abs(placed.getTime() - at('2026-08-21T00:30:00.000Z').getTime()) / 60_000
    ).toBeGreaterThanOrEqual(90);
  });

  it('honours the window timezone rather than UTC', () => {
    const tokyo = { windowStart: '09:00', windowEnd: '18:00', timezone: 'Asia/Tokyo' };
    // 03:00 UTC is 12:00 in Tokyo — inside the window, so nothing moves.
    const { moved } = redistributePublishTimesWithinWindow(
      [{ id: 'a', publishDate: at('2026-08-20T03:00:00.000Z') }],
      tokyo,
      30
    );
    expect(moved.size).toBe(0);
  });

  it('does nothing for an empty batch or a zero-width window', () => {
    expect(redistributePublishTimesWithinWindow([], WINDOW, 30).moved.size).toBe(0);
    const zero = { windowStart: '09:00', windowEnd: '09:00', timezone: 'UTC' };
    const { moved } = redistributePublishTimesWithinWindow(
      [{ id: 'a', publishDate: at('2026-08-20T03:00:00.000Z') }],
      zero,
      30
    );
    expect(moved.size).toBe(0);
  });
});

// A window is expressed in LOCAL time, so "09:00 to 18:00" must mean those
// hours on every day of the year — including the two days a DST zone is 23 or
// 25 hours long. Anchoring on midnight-plus-N-minutes silently breaks that:
// midnight + 9h is 10:00 on a spring-forward day.
describe('publish windows across a DST transition', () => {
  const NY = 'America/New_York';
  // US DST 2026: forward Sun 8 Mar (02:00 -> 03:00), back Sun 1 Nov (02:00 -> 01:00).
  const SPRING_FORWARD = '2026-03-08';
  const FALL_BACK = '2026-11-01';
  const DAY_WINDOW = { windowStart: '09:00', windowEnd: '18:00', timezone: NY };

  const localHHMM = (date: Date, zone = NY) =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date);

  const inHours = (hhmm: string, from: string, to: string) =>
    hhmm >= from && hhmm < to;

  it('keeps a re-picked time inside local hours on the spring-forward day', () => {
    // 03:00 New York — outside the window, so it gets re-picked.
    const outside = new Date(`${SPRING_FORWARD}T08:00:00.000Z`);
    for (let i = 0; i < 200; i++) {
      const picked = redistributePublishTimeIfOutsideWindow(outside, DAY_WINDOW);
      expect(inHours(localHHMM(picked), '09:00', '18:00')).toBe(true);
    }
  });

  it('keeps a re-picked time inside local hours on the fall-back day', () => {
    const outside = new Date(`${FALL_BACK}T08:00:00.000Z`);
    for (let i = 0; i < 200; i++) {
      const picked = redistributePublishTimeIfOutsideWindow(outside, DAY_WINDOW);
      expect(inHours(localHHMM(picked), '09:00', '18:00')).toBe(true);
    }
  });

  it('places a whole batch inside local hours on a DST day', () => {
    for (const day of [SPRING_FORWARD, FALL_BACK]) {
      const posts = Array.from({ length: 6 }, (_, index) => ({
        id: `${day}-${index}`,
        publishDate: new Date(`${day}T08:00:00.000Z`),
      }));
      const { moved } = redistributePublishTimesWithinWindow(posts, DAY_WINDOW, 30);
      expect(moved.size).toBe(6);
      for (const date of moved.values()) {
        expect(inHours(localHHMM(date), '09:00', '18:00')).toBe(true);
      }
    }
  });

  it('uses the REAL length of a window the transition falls INSIDE', () => {
    // 01:00-05:00 straddles the 02:00 jump: four hours on the clock, but only
    // THREE real hours on the spring-forward day and FIVE on the fall-back day.
    // Three posts 100 minutes apart need 200 minutes — comfortable on a normal
    // day, impossible on the short one.
    const window = { windowStart: '01:00', windowEnd: '05:00', timezone: NY };
    const batch = (day: string) =>
      Array.from({ length: 3 }, (_, index) => ({
        id: `${day}-${index}`,
        // 12:00 New York — outside the window, so all three are placed.
        publishDate: new Date(`${day}T16:00:00.000Z`),
      }));

    const normal = redistributePublishTimesWithinWindow(
      batch('2026-03-15'),
      window,
      100
    );
    expect(normal.degraded).toEqual([]);

    const short = redistributePublishTimesWithinWindow(
      batch(SPRING_FORWARD),
      window,
      100
    );
    // The clock says there is room; the real day says there is not.
    expect(short.degraded).toHaveLength(1);
    for (const date of short.moved.values()) {
      const hhmm = localHHMM(date);
      expect(hhmm >= '01:00' && hhmm < '05:00').toBe(true);
    }
  });

  it('keeps a wrapping window inside local hours across the transition', () => {
    const night = { windowStart: '22:00', windowEnd: '02:00', timezone: NY };
    // Midday New York on the day the clocks go forward overnight.
    const outside = new Date(`${SPRING_FORWARD}T16:00:00.000Z`);
    for (let i = 0; i < 200; i++) {
      const picked = redistributePublishTimeIfOutsideWindow(outside, night);
      const hhmm = localHHMM(picked);
      expect(hhmm >= '22:00' || hhmm < '02:00').toBe(true);
    }
  });
});
