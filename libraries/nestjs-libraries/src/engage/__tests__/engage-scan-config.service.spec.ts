import { describe, it, expect, vi } from 'vitest';
import {
  EngageScanConfigService,
  ENGAGE_SCAN_PACING_KEY,
  DEFAULT_SCAN_PACING,
  mergePacing,
} from '../engage-scan-config.service';

function settingsMock(values: Record<string, unknown> = {}) {
  return {
    get: vi.fn(async (key: string) => values[key] ?? null),
    set: vi.fn(async () => undefined),
  } as any;
}

describe('EngageScanConfigService.onModuleInit', () => {
  it('seeds the default pacing when the key is missing', async () => {
    const settings = settingsMock();
    const svc = new EngageScanConfigService(settings);
    await svc.onModuleInit();
    expect(settings.set).toHaveBeenCalledWith(
      ENGAGE_SCAN_PACING_KEY,
      DEFAULT_SCAN_PACING,
      expect.objectContaining({ type: 'object' })
    );
  });

  it('does not overwrite an existing value', async () => {
    const settings = settingsMock({ [ENGAGE_SCAN_PACING_KEY]: { workflow: {} } });
    const svc = new EngageScanConfigService(settings);
    await svc.onModuleInit();
    expect(settings.set).not.toHaveBeenCalled();
  });
});

describe('EngageScanConfigService.getPagePacing', () => {
  it('returns the seeded defaults: extension X initial = 3 pages / 8s / 60s jitter', async () => {
    const svc = new EngageScanConfigService(settingsMock());
    expect(await svc.getPagePacing('extension', 'x', 'initial')).toEqual({
      maxPages: 3,
      pageDelayMs: 8000,
      jitterMs: 60000,
    });
  });

  it('returns workflow X initial = 5 pages / 300ms', async () => {
    const svc = new EngageScanConfigService(settingsMock());
    expect(await svc.getPagePacing('workflow', 'x', 'initial')).toEqual({
      maxPages: 5,
      pageDelayMs: 300,
      jitterMs: 300,
    });
  });

  it('deep-merges a partial admin override without dropping other leaves', async () => {
    const svc = new EngageScanConfigService(
      settingsMock({
        [ENGAGE_SCAN_PACING_KEY]: {
          extension: { x: { initial: { maxPages: 2 } } },
        },
      })
    );
    const x = await svc.getPagePacing('extension', 'x', 'initial');
    expect(x.maxPages).toBe(2); // overridden
    expect(x.pageDelayMs).toBe(8000); // default preserved
    expect(x.jitterMs).toBe(60000); // default preserved
    // a sibling platform stays at its default
    const reddit = await svc.getPagePacing('extension', 'reddit', 'initial');
    expect(reddit).toEqual({ maxPages: 3, pageDelayMs: 5000, jitterMs: 60000 });
  });
});

describe('mergePacing (leaf guards)', () => {
  it('falls back when a delay override is non-numeric, but allows an explicit 0', () => {
    const merged = mergePacing(DEFAULT_SCAN_PACING, {
      workflow: { x: { initial: { pageDelayMs: 0, jitterMs: 'oops' as any } } } as any,
    });
    expect(merged.workflow.x.initial.pageDelayMs).toBe(0); // delays may be 0
    expect(merged.workflow.x.initial.jitterMs).toBe(300); // garbage → default
  });

  it('rejects a zero / negative maxPages (a cap of 0 would disable scanning)', () => {
    const merged = mergePacing(DEFAULT_SCAN_PACING, {
      extension: { reddit: { initial: { maxPages: 0 } } } as any,
    });
    expect(merged.extension.reddit.initial.maxPages).toBe(3); // 0 rejected → default
  });

  it('keeps extension safety knobs and allows overriding them', () => {
    const merged = mergePacing(DEFAULT_SCAN_PACING, {
      extension: { interUnit: { delayMs: 90000 }, session: { hourlyRequestCap: 30 } } as any,
    });
    expect(merged.extension.interUnit.delayMs).toBe(90000);
    expect(merged.extension.interUnit.jitterMs).toBe(60000); // default preserved
    expect(merged.extension.session.hourlyRequestCap).toBe(30);
  });
});
