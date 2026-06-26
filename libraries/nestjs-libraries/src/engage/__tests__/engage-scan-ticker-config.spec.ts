import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EngageService } from '../engage.service';

// The engage scan executor is purely EVENT-DRIVEN: it is started with no
// interval arg and only scans when signaled. triggerImmediateScan force-scans
// (triggerScanNow); triggerDueScan respects the per-unit cadence (triggerDueScan).
describe('EngageService scan executor (event-driven, no periodic interval)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      {} as any,
      {} as any
    );
    return { service, start, signal };
  }

  it('starts engage-scan-ticker with NO interval arg (no periodic tick)', async () => {
    const { service, start } = build();

    await service.onApplicationBootstrap();

    expect(start).toHaveBeenCalledWith(
      'engageScanTickerWorkflow',
      expect.objectContaining({ workflowId: 'engage-scan-ticker-v2', args: [] })
    );
  });

  it('triggerImmediateScan force-signals triggerScanNow (starts with no interval on miss)', async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    const { service, signal } = build(start);
    signal
      .mockRejectedValueOnce(new Error('not running'))
      .mockResolvedValueOnce(undefined);

    await expect(
      service.triggerImmediateScan({ id: 'org1' } as any)
    ).resolves.toEqual({ status: 'started' });

    expect(start).toHaveBeenCalledWith(
      'engageScanTickerWorkflow',
      expect.objectContaining({ args: [] })
    );
    expect(signal).toHaveBeenCalledWith('triggerScanNow');
  });

  it('triggerDueScan non-force-signals triggerDueScan', async () => {
    const { service, signal } = build();

    await expect(
      service.triggerDueScan({ id: 'org1' } as any)
    ).resolves.toEqual({ status: 'signaled' });

    expect(signal).toHaveBeenCalledWith('triggerDueScan');
  });
});
