import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EngageDataTicksActivity } from '../engage-data-ticks.activity';
import { ENGAGE_PERIODIC_METRICS_ENABLED_KEY } from '@gitroom/nestjs-libraries/engage/engage-entitlement.service';

/**
 * The daily engageDataTicksWorkflow gates its whole body (resync + aggregate)
 * on this activity. The load-bearing safety property is FAIL-CLOSED: an unset or
 * unreadable setting must default to disabled so a settings outage can never
 * silently re-enable the background X/Reddit fetch the event-driven model turned
 * off. The activity owns that try/catch (the workflow can't be unit-tested
 * without @temporalio/testing), so it's verified here.
 */
describe('EngageDataTicksActivity.isPeriodicMetricsEnabled', () => {
  let get: ReturnType<typeof vi.fn>;

  function build() {
    const settings = { get } as any;
    // Only _settings is exercised; the rest are unused holes for this method.
    return new EngageDataTicksActivity(
      {} as any, // _engageRepository
      {} as any, // _post
      {} as any, // _engageDataTicks
      {} as any, // _tx
      {} as any, // _postsService
      settings
    );
  }

  beforeEach(() => {
    get = vi.fn();
  });

  it('returns true when the setting is stored true', async () => {
    get.mockResolvedValue(true);
    await expect(build().isPeriodicMetricsEnabled()).resolves.toBe(true);
    expect(get).toHaveBeenCalledWith(ENGAGE_PERIODIC_METRICS_ENABLED_KEY);
  });

  it('returns false when the setting is stored false (not coerced to default)', async () => {
    get.mockResolvedValue(false);
    await expect(build().isPeriodicMetricsEnabled()).resolves.toBe(false);
  });

  it('defaults to false (disabled) when the setting is unset/null', async () => {
    get.mockResolvedValue(null);
    await expect(build().isPeriodicMetricsEnabled()).resolves.toBe(false);
  });

  it('fails closed to false when the settings read throws (no re-throw)', async () => {
    get.mockRejectedValue(new Error('settings store down'));
    await expect(build().isPeriodicMetricsEnabled()).resolves.toBe(false);
  });
});
