import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { HttpException, HttpStatus } from '@nestjs/common';
import {
  EngageIngestQuotaService,
  ENGAGE_INGEST_QUOTA_KEY,
  DEFAULT_INGEST_QUOTA,
} from '../engage-ingest-quota.service';
import { ioRedis } from '../../redis/redis.service';

function settingsMock(values: Record<string, unknown> = {}) {
  return {
    get: vi.fn(async (key: string) => values[key] ?? null),
    set: vi.fn(async () => undefined),
  } as any;
}

// Mirrors the shape of the production engage_scan_pacing.extension block: the
// derived ceiling is hourlyRequestCap x the LARGEST pageSize x sessionsAllowance,
// so reddit's 25 is what should win here, not x's 20.
function scanConfigMock(hourlyRequestCap = 120) {
  return {
    getSupportedScanPlatforms: vi.fn(async () => PLATFORMS),
    getPacing: vi.fn(async () => ({
      workflow: {},
      extension: {
        x: {
          initial: { maxPages: 3, pageSize: 20 },
          incremental: { maxPages: 1, pageSize: 20 },
        },
        reddit: {
          initial: { maxPages: 3, pageSize: 25 },
          incremental: { maxPages: 1, pageSize: 25 },
        },
        devto: {
          initial: { maxPages: 2, pageSize: 15 },
          incremental: { maxPages: 1, pageSize: 15 },
        },
        interUnit: { delayMs: 60_000, jitterMs: 60_000 },
        session: { hourlyRequestCap },
      },
    })),
  } as any;
}

// Seven scannable platforms, matching the production allowlist.
const PLATFORMS = ['x', 'reddit', 'linkedin', 'devto', 'hackernews', 'medium', 'quora'];

// growth-loop as sold. `null` on either cap means unlimited, which makes the
// plan term incomputable and leaves the burst term standing alone.
function entitlementMock(
  limits: Partial<{
    keywordsMax: number | null;
    priorityAccountsMax: number | null;
    scanIntervalHours: number;
  }> = {}
) {
  return {
    getEntitlement: vi.fn(async () => ({
      keywordsMax: 300,
      priorityAccountsMax: 200,
      scanIntervalHours: 24,
      ...limits,
    })),
  } as any;
}

function build(
  stored?: unknown,
  hourlyRequestCap = 120,
  entitlement = entitlementMock()
) {
  const settings = settingsMock(
    stored === undefined ? {} : { [ENGAGE_INGEST_QUOTA_KEY]: stored }
  );
  const scanConfig = scanConfigMock(hourlyRequestCap);
  return {
    service: new EngageIngestQuotaService(settings, scanConfig, entitlement),
    settings,
    scanConfig,
    entitlement,
  };
}

// Burst term: 120 fetches/hour x 25 records/fetch x 2 sessions.
const BURST_DEFAULT = 6_000;
// Plan term for growth-loop: (300 + 200) x 7 platforms x 25 records x 2 burst
// factor / 24h cadence.
const PLAN_DEFAULT = Math.floor((500 * 7 * 25 * 2) / 24);
// resolveLimit takes the larger of the two.
const DERIVED_DEFAULT = Math.max(BURST_DEFAULT, PLAN_DEFAULT);

// The suite shares a live Redis with every other spec (REDIS_URL is set by the
// dotenv setup file), so each test gets its own org id — a fixed one would make
// counters bleed between runs.
const org = () => `org_${randomUUID()}`;

describe('EngageIngestQuotaService.assertWithinQuota', () => {
  it('admits a batch that fits inside the hourly ceiling', async () => {
    const { service } = build();
    await expect(
      service.assertWithinQuota(org(), DERIVED_DEFAULT - 1)
    ).resolves.toBeUndefined();
  });

  it('rejects the batch that would cross the ceiling, with a typed 429', async () => {
    const { service } = build();
    const id = org();
    await service.assertWithinQuota(id, DERIVED_DEFAULT - 100);

    let thrown: HttpException | undefined;
    try {
      await service.assertWithinQuota(id, 200);
    } catch (err) {
      thrown = err as HttpException;
    }

    expect(thrown).toBeInstanceOf(HttpException);
    expect(thrown!.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    const body = thrown!.getResponse() as Record<string, unknown>;
    expect(body.code).toBe('engage_ingest_quota_exceeded');
    expect(body.limit).toBe(DERIVED_DEFAULT);
    expect(body.requested).toBe(200);
    expect(body.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('rejects the WHOLE batch rather than admitting part of it', async () => {
    const { service } = build();
    const id = org();
    await service.assertWithinQuota(id, DERIVED_DEFAULT - 10);
    // 20 does not fit in the remaining 10 — none of it may be counted, or the
    // extension would advance its cursor past records that were never stored.
    await expect(service.assertWithinQuota(id, 20)).rejects.toThrow(
      HttpException
    );
    // The refused batch left the tally untouched, so a batch that DOES fit
    // still passes.
    await expect(service.assertWithinQuota(id, 10)).resolves.toBeUndefined();
  });

  it('meters each organization separately', async () => {
    const { service } = build();
    const a = org();
    await service.assertWithinQuota(a, DERIVED_DEFAULT);
    await expect(service.assertWithinQuota(a, 1)).rejects.toThrow(HttpException);
    await expect(
      service.assertWithinQuota(org(), DERIVED_DEFAULT)
    ).resolves.toBeUndefined();
  });

  it('consumes nothing for an empty or non-positive batch', async () => {
    const { service, settings } = build();
    const id = org();
    await service.assertWithinQuota(id, 0);
    await service.assertWithinQuota(id, -5);
    // Short-circuits before it even reads the setting.
    expect(settings.get).not.toHaveBeenCalled();
    await expect(
      service.assertWithinQuota(id, DERIVED_DEFAULT)
    ).resolves.toBeUndefined();
  });

  it('honours an explicitly pinned ceiling over the derived one', async () => {
    const { service } = build({ enabled: true, recordsPerHour: 9_000 });
    const id = org();
    await expect(service.assertWithinQuota(id, 9_000)).resolves.toBeUndefined();
    await expect(service.assertWithinQuota(id, 1)).rejects.toThrow(HttpException);
  });

  it('rejects nothing while the master switch is off', async () => {
    const { service } = build({ enabled: false, recordsPerHour: 10 });
    const id = org();
    await expect(service.assertWithinQuota(id, 500_000)).resolves.toBeUndefined();
    await expect(service.assertWithinQuota(id, 500_000)).resolves.toBeUndefined();
  });

  it('derives the ceiling from scan pacing when recordsPerHour is unset', async () => {
    const { service } = build();
    expect(await service.resolveLimit(org())).toEqual({
      enabled: true,
      recordsPerHour: DERIVED_DEFAULT,
      source: 'plan',
    });
  });

  it('tracks an admin who widens the client pacing', async () => {
    // Raising hourlyRequestCap must raise the server ceiling with it, or the
    // wider client contract would just be throttled here instead. 240 x 25 x 2
    // clears the plan term, so the burst term is the one that shows.
    const { service } = build(undefined, 240);
    const limit = await service.resolveLimit(org());
    expect(limit.recordsPerHour).toBe(240 * 25 * 2);
    expect(limit.source).toBe('burst');
  });

  it('scales with sessionsAllowance', async () => {
    // One session halves the burst term to 3000, below the plan term.
    const { service } = build({ sessionsAllowance: 1 });
    expect((await service.resolveLimit(org())).recordsPerHour).toBe(PLAN_DEFAULT);
  });

  it('follows the org plan: more keywords, or a faster cadence, raises the ceiling', async () => {
    const wider = build(undefined, 120, entitlementMock({ keywordsMax: 600 }));
    expect((await wider.service.resolveLimit(org())).recordsPerHour).toBe(
      Math.floor((800 * 7 * 25 * 2) / 24)
    );

    const faster = build(undefined, 120, entitlementMock({ scanIntervalHours: 6 }));
    expect((await faster.service.resolveLimit(org())).recordsPerHour).toBe(
      Math.floor((500 * 7 * 25 * 2) / 6)
    );
  });

  it('falls back to the burst term alone when the plan is unlimited', async () => {
    // An unlimited cap cannot yield a finite rate — the plan term must drop out
    // rather than make the ceiling infinite.
    const { service } = build(
      undefined,
      120,
      entitlementMock({ priorityAccountsMax: null })
    );
    const limit = await service.resolveLimit(org());
    expect(limit.recordsPerHour).toBe(BURST_DEFAULT);
    expect(limit.source).toBe('burst');
  });

  it('applies the scale coefficient to the computed ceiling', async () => {
    const half = build({ scale: 0.5 });
    expect((await half.service.resolveLimit(org())).recordsPerHour).toBe(
      Math.floor(PLAN_DEFAULT * 0.5)
    );
    const triple = build({ scale: 3 });
    expect((await triple.service.resolveLimit(org())).recordsPerHour).toBe(
      Math.floor(PLAN_DEFAULT * 3)
    );
  });

  it('leaves a pinned ceiling unscaled — it is already an exact number', async () => {
    const { service } = build({ recordsPerHour: 500, scale: 0.5 });
    expect((await service.resolveLimit(org())).recordsPerHour).toBe(500);
  });

  it('never lets a tiny scale collapse the ceiling to zero', async () => {
    const { service } = build({ scale: 0.0000001 });
    const limit = await service.resolveLimit(org());
    expect(limit.recordsPerHour).toBe(1);
    // Still admits something, rather than refusing every ingest outright.
    await expect(service.assertWithinQuota(org(), 1)).resolves.toBeUndefined();
  });

  it('scales with burstFactor', async () => {
    const { service } = build({ burstFactor: 4 });
    expect((await service.resolveLimit(org())).recordsPerHour).toBe(
      Math.floor((500 * 7 * 25 * 4) / 24)
    );
  });

  it('falls back rather than to unlimited on a junk stored value', async () => {
    for (const junk of [0, -1, 'lots', Number.NaN]) {
      const { service } = build({ enabled: true, recordsPerHour: junk });
      // Junk is discarded, so the ceiling comes from the derivation.
      expect((await service.resolveLimit(org())).recordsPerHour).toBe(DERIVED_DEFAULT);
    }
    for (const junk of [0, -1, 'many', Number.NaN]) {
      const { service } = build({ sessionsAllowance: junk });
      expect((await service.resolveLimit(org())).recordsPerHour).toBe(DERIVED_DEFAULT);
    }
  });

  it('falls back to a fixed ceiling only when BOTH terms are incomputable', async () => {
    const { service, scanConfig } = build();
    scanConfig.getPacing.mockRejectedValue(new Error('settings down'));
    const limit = await service.resolveLimit(org());
    expect(limit.recordsPerHour).toBe(3000);
    expect(limit.source).toBe('fallback');
  });

  it('fails OPEN when Redis is unreachable', async () => {
    const { service } = build();
    const spy = vi
      .spyOn(ioRedis, 'get')
      .mockRejectedValue(new Error('ECONNREFUSED'));
    try {
      await expect(
        service.assertWithinQuota(org(), 1_000_000)
      ).resolves.toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('EngageIngestQuotaService.onModuleInit', () => {
  it('seeds the default when the key is absent', async () => {
    const { service, settings } = build();
    await service.onModuleInit();
    expect(settings.set).toHaveBeenCalledWith(
      ENGAGE_INGEST_QUOTA_KEY,
      DEFAULT_INGEST_QUOTA,
      expect.objectContaining({ type: 'object' })
    );
  });

  it('leaves an existing admin-tuned value alone', async () => {
    const { service, settings } = build({ enabled: true, recordsPerHour: 42 });
    await service.onModuleInit();
    expect(settings.set).not.toHaveBeenCalled();
  });
});
