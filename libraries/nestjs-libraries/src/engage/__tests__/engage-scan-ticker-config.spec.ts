import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EngageService } from '../engage.service';

describe('EngageService scan ticker config', () => {
  const OLD_ENV = process.env.ENGAGE_SCAN_TICK_MINUTES;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.ENGAGE_SCAN_TICK_MINUTES;
  });

  afterEach(() => {
    if (OLD_ENV === undefined) {
      delete process.env.ENGAGE_SCAN_TICK_MINUTES;
    } else {
      process.env.ENGAGE_SCAN_TICK_MINUTES = OLD_ENV;
    }
  });

  function build(start = vi.fn().mockResolvedValue(undefined)) {
    const terminate = vi.fn().mockResolvedValue(undefined);
    const signal = vi.fn().mockResolvedValue(undefined);
    const client = {
      workflow: {
        start,
        getHandle: vi.fn().mockReturnValue({ terminate, signal }),
      },
    };
    const service = new EngageService(
      {} as any,
      { client: { getRawClient: () => client } } as any,
      {} as any,
      {} as any
    );
    return { service, start, signal };
  }

  it('starts engage-scan-ticker with ENGAGE_SCAN_TICK_MINUTES', async () => {
    process.env.ENGAGE_SCAN_TICK_MINUTES = '2';
    const { service, start } = build();

    await service.onApplicationBootstrap();

    expect(start).toHaveBeenCalledWith(
      'engageScanTickerWorkflow',
      expect.objectContaining({
        workflowId: 'engage-scan-ticker',
        args: [2],
      })
    );
  });

  it('falls back to the 5 minute ticker interval when env is invalid', async () => {
    process.env.ENGAGE_SCAN_TICK_MINUTES = 'not-a-number';
    const { service, start } = build();

    await service.onApplicationBootstrap();

    expect(start).toHaveBeenCalledWith(
      'engageScanTickerWorkflow',
      expect.objectContaining({ args: [5] })
    );
  });

  it('uses ENGAGE_SCAN_TICK_MINUTES when triggerImmediateScan has to start the ticker', async () => {
    process.env.ENGAGE_SCAN_TICK_MINUTES = '1';
    const start = vi.fn().mockResolvedValue(undefined);
    const { service, signal } = build(start);
    signal
      .mockRejectedValueOnce(new Error('not running'))
      .mockResolvedValueOnce(undefined);

    await expect(service.triggerImmediateScan({ id: 'org1' } as any)).resolves.toEqual({
      status: 'started',
    });
    expect(start).toHaveBeenCalledWith(
      'engageScanTickerWorkflow',
      expect.objectContaining({ args: [1] })
    );
  });
});
