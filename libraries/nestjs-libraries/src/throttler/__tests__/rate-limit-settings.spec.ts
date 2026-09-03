import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  ApiRateLimitService,
  API_RATE_LIMITS_KEY,
  DEFAULT_API_RATE_LIMITS,
  DEFAULT_API_RATE_LIMIT_SETTINGS,
  getApiRateLimits,
  limitFor,
  resetApiRateLimits,
  setApiRateLimits,
} from '../rate-limit-settings';

function settingsMock(values: Record<string, unknown> = {}) {
  return {
    get: vi.fn(async (key: string) => values[key] ?? null),
    set: vi.fn(async () => undefined),
  } as any;
}

afterEach(() => resetApiRateLimits());

describe('limitFor', () => {
  it('resolves at call time, so a settings change lands without a deploy', async () => {
    const limit = limitFor('createPost');
    expect(limit()).toBe(DEFAULT_API_RATE_LIMITS.createPost);
    setApiRateLimits({ createPost: 42 });
    expect(limit()).toBe(42);
  });

  it('leaves the other buckets on their defaults', () => {
    setApiRateLimits({ createPost: 42 });
    expect(getApiRateLimits().engageDraft).toBe(
      DEFAULT_API_RATE_LIMITS.engageDraft
    );
  });

  it('discards junk and non-positive values rather than removing a limit', () => {
    // 0 would lock every caller out of the route; a string or NaN would make the
    // guard compare against nonsense. Both fall back to the default.
    for (const junk of [0, -5, 'lots', Number.NaN, null, undefined]) {
      resetApiRateLimits();
      setApiRateLimits({ createPost: junk as any });
      expect(getApiRateLimits().createPost).toBe(
        DEFAULT_API_RATE_LIMITS.createPost
      );
    }
  });
});

describe('ApiRateLimitService', () => {
  it('seeds the defaults when the key is absent', async () => {
    const settings = settingsMock();
    await new ApiRateLimitService(settings).onModuleInit();
    // The STORED shape, which carries engageIngest: null (derive) rather than a
    // resolved number — pinning one would freeze it against the client pacing.
    expect(settings.set).toHaveBeenCalledWith(
      API_RATE_LIMITS_KEY,
      DEFAULT_API_RATE_LIMIT_SETTINGS,
      expect.objectContaining({ type: 'object' })
    );
  });

  it('leaves an admin-tuned row alone and publishes it to the cache', async () => {
    const settings = settingsMock({
      [API_RATE_LIMITS_KEY]: { createPost: 25, engageScan: 2 },
    });
    await new ApiRateLimitService(settings).onModuleInit();
    expect(settings.set).not.toHaveBeenCalled();
    expect(getApiRateLimits().createPost).toBe(25);
    expect(getApiRateLimits().engageScan).toBe(2);
  });

  it('keeps the last known values when a refresh fails', async () => {
    // Snapping back to defaults on a transient settings failure would quietly
    // widen a limit an admin had tuned DOWN — the wrong direction to fail.
    const settings = settingsMock({ [API_RATE_LIMITS_KEY]: { createPost: 7 } });
    const service = new ApiRateLimitService(settings);
    await service.onModuleInit();
    expect(getApiRateLimits().createPost).toBe(7);

    settings.get.mockRejectedValue(new Error('db down'));
    await service.refresh();
    expect(getApiRateLimits().createPost).toBe(7);
    service.onApplicationShutdown();
  });
});

describe('engageIngest derivation', () => {
  const PACING = (delayMs: number) => ({
    extension: { interUnit: { delayMs } },
  });

  it('derives from engage_scan_pacing interUnit x allowance', async () => {
    // 3600s / 60s = 60 requests per session per hour, x the default allowance.
    const settings = settingsMock({
      [API_RATE_LIMITS_KEY]: {},
      engage_scan_pacing: PACING(60_000),
    });
    await new ApiRateLimitService(settings).onModuleInit();
    expect(getApiRateLimits().engageIngest).toBe(
      60 * DEFAULT_API_RATE_LIMIT_SETTINGS.engageIngestAllowance
    );
  });

  it('follows a retuned client pacing instead of drifting from it', async () => {
    // Halving interUnit doubles what one session legitimately sends; the server
    // ceiling has to move with it or it silently throttles the change.
    const settings = settingsMock({
      [API_RATE_LIMITS_KEY]: {},
      engage_scan_pacing: PACING(30_000),
    });
    await new ApiRateLimitService(settings).onModuleInit();
    expect(getApiRateLimits().engageIngest).toBe(
      120 * DEFAULT_API_RATE_LIMIT_SETTINGS.engageIngestAllowance
    );
  });

  it('scales with the session allowance', async () => {
    const settings = settingsMock({
      [API_RATE_LIMITS_KEY]: { engageIngestAllowance: 2 },
      engage_scan_pacing: PACING(60_000),
    });
    await new ApiRateLimitService(settings).onModuleInit();
    expect(getApiRateLimits().engageIngest).toBe(120);
  });

  it('honours an explicitly pinned value over the derivation', async () => {
    const settings = settingsMock({
      [API_RATE_LIMITS_KEY]: { engageIngest: 42 },
      engage_scan_pacing: PACING(60_000),
    });
    await new ApiRateLimitService(settings).onModuleInit();
    expect(getApiRateLimits().engageIngest).toBe(42);
  });

  it('falls back to a per-session default when the pacing is unreadable', async () => {
    const settings = settingsMock({ [API_RATE_LIMITS_KEY]: {} });
    settings.get = vi.fn(async (key: string) =>
      key === 'engage_scan_pacing' ? Promise.reject(new Error('down')) : {}
    ) as any;
    await new ApiRateLimitService(settings).onModuleInit();
    expect(getApiRateLimits().engageIngest).toBe(
      60 * DEFAULT_API_RATE_LIMIT_SETTINGS.engageIngestAllowance
    );
  });
});

describe('rate-limit buckets cover every throttled route', () => {
  it('has a bucket for the engage ingest path', () => {
    // The two ingest routes had NO throttle at all until this bucket existed —
    // and they are the only entry point engage data has now that the Temporal
    // scan is off, so an unbounded request rate there is the whole write path.
    expect(DEFAULT_API_RATE_LIMITS.engageIngest).toBeGreaterThan(0);
  });
});
