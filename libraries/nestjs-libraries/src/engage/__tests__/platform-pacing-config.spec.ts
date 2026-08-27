import { describe, it, expect, vi } from 'vitest';
import {
  PlatformPacingConfigService,
  sanitizePlatformPacing,
} from '../platform-pacing-config.service';
import { DEFAULT_PLATFORM_PACING } from '@gitroom/helpers/extension/platform-pacing';

const svc = () => new PlatformPacingConfigService({} as any);

describe('sanitizePlatformPacing', () => {
  it('falls back to the built-in floor for anything unusable', () => {
    expect(sanitizePlatformPacing(null)).toEqual(DEFAULT_PLATFORM_PACING);
    expect(sanitizePlatformPacing('nope')).toEqual(DEFAULT_PLATFORM_PACING);
    expect(sanitizePlatformPacing(42)).toEqual(DEFAULT_PLATFORM_PACING);
  });

  it('keeps the floor for a range that is malformed, out of order or negative', () => {
    // The failure direction is "keep the floor", never "remove it" — an admin
    // can widen or narrow it, never make it absent.
    for (const bad of [null, [1], ['a', 'b'], [5, 2], [-1, 5], [Number.NaN, 5]]) {
      const out = sanitizePlatformPacing({ default: { write: bad } });
      expect(out.default.write).toEqual(DEFAULT_PLATFORM_PACING.default.write);
    }
  });

  it('preserves a well-formed window on both tiers', () => {
    const w = { windowStart: '09:00', windowEnd: '17:00', timezone: 'Asia/Shanghai' };
    const out = sanitizePlatformPacing({
      default: { window: w },
      platforms: { reddit: { window: w } },
    });
    expect(out.default.window).toEqual(w);
    expect(out.platforms.reddit.window).toEqual(w);
  });

  it('DROPS a window whose field names are wrong', () => {
    // This is the shape that used to reach the publish allocator and throw:
    // `window.windowStart.split(':')` on undefined. Dropping it leaves the
    // platform unconstrained, matching how the reply side fails closed.
    const out = sanitizePlatformPacing({
      default: { window: { start: '09:00', end: '17:00' } },
      platforms: { reddit: { window: { start: '09:00', end: '17:00' } } },
    });
    expect(out.default.window).toBeUndefined();
    expect(out.platforms.reddit.window).toBeUndefined();
  });

  it('DROPS a window with unparseable bounds or an empty span', () => {
    const cases = [
      { windowStart: '9:00', windowEnd: '17:00' }, // not HH:MM
      { windowStart: '25:00', windowEnd: '17:00' }, // hour out of range
      { windowStart: '09:70', windowEnd: '17:00' }, // minute out of range
      { windowStart: '09:00', windowEnd: '09:00' }, // empty span = blocks everything
    ];
    for (const window of cases) {
      expect(sanitizePlatformPacing({ default: { window } }).default.window).toBeUndefined();
    }
  });

  it('DROPS a window whose timezone cannot be resolved', () => {
    // The allocator calls dayjs.tz with it — an unresolvable zone is a RangeError
    // thrown out of plan activation.
    const out = sanitizePlatformPacing({
      default: {
        window: { windowStart: '09:00', windowEnd: '17:00', timezone: 'Europe/Nowhere' },
      },
    });
    expect(out.default.window).toBeUndefined();
  });

  it('keeps a window with no timezone — that means UTC, not "missing"', () => {
    const out = sanitizePlatformPacing({
      default: { window: { windowStart: '09:00', windowEnd: '17:00' } },
    });
    expect(out.default.window).toEqual({ windowStart: '09:00', windowEnd: '17:00' });
  });

  it('drops a non-object platform entry rather than passing it through', () => {
    const out = sanitizePlatformPacing({ platforms: { reddit: 'nope', x: null } });
    expect(out.platforms).toEqual({});
  });
});

describe('PlatformPacingConfigService — pure variants', () => {
  it('reports the write floor as the range LOWER bound, in minutes', () => {
    // The lower bound is the answer to "how close together may two writes ever
    // be"; using the upper one would turn the floor into the cadence.
    const pacing = {
      default: { write: [10, 30] as [number, number], read: [15, 45] as [number, number] },
      platforms: { hackernews: { write: [15, 45] as [number, number] } },
    };
    expect(svc().writeFloorMinutesFor(pacing, 'hackernews')).toBe(15);
    expect(svc().writeFloorMinutesFor(pacing, 'reddit')).toBe(10);
  });

  it('is unconstrained when no window is configured', () => {
    const pacing = { default: DEFAULT_PLATFORM_PACING.default, platforms: {} };
    expect(svc().isWithinWriteWindowFor(pacing, 'x', new Date())).toBe(true);
  });

  it('admits and refuses by the platform window, in its own timezone', () => {
    const pacing = {
      default: DEFAULT_PLATFORM_PACING.default,
      platforms: {
        x: { window: { windowStart: '09:00', windowEnd: '17:00', timezone: 'UTC' } },
      },
    };
    expect(svc().isWithinWriteWindowFor(pacing, 'x', new Date('2026-08-27T12:00:00Z'))).toBe(true);
    expect(svc().isWithinWriteWindowFor(pacing, 'x', new Date('2026-08-27T03:00:00Z'))).toBe(false);
  });

  it('falls back to the global window for a platform without its own', () => {
    const pacing = {
      default: {
        ...DEFAULT_PLATFORM_PACING.default,
        window: { windowStart: '09:00', windowEnd: '17:00', timezone: 'UTC' },
      },
      platforms: {},
    };
    expect(svc().isWithinWriteWindowFor(pacing, 'reddit', new Date('2026-08-27T03:00:00Z'))).toBe(false);
  });
});
