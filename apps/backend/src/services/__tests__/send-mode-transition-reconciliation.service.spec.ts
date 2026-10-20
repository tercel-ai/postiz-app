import { afterEach, describe, expect, it, vi } from 'vitest';
import { SendModeTransitionReconciliationService } from '../send-mode-transition-reconciliation.service';

afterEach(() => vi.useRealTimers());
describe('sending mode transition reconciliation lifecycle', () => {
  it('runs on boot and every fifteen seconds without an open UI and stops on shutdown', async () => {
    vi.useFakeTimers();
    const modes = {
      reconcilePendingTransitions: vi.fn().mockResolvedValue([]),
    };
    const service = new SendModeTransitionReconciliationService(modes as any);
    service.onApplicationBootstrap();
    expect(modes.reconcilePendingTransitions).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(modes.reconcilePendingTransitions).toHaveBeenCalledTimes(3);
    service.onApplicationShutdown();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(modes.reconcilePendingTransitions).toHaveBeenCalledTimes(3);
  });
  it('does not overlap an unfinished reconciliation', async () => {
    vi.useFakeTimers();
    let complete!: () => void;
    const modes = {
      reconcilePendingTransitions: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            complete = resolve;
          })
      ),
    };
    const service = new SendModeTransitionReconciliationService(modes as any);
    service.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(modes.reconcilePendingTransitions).toHaveBeenCalledTimes(1);
    complete();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(modes.reconcilePendingTransitions).toHaveBeenCalledTimes(2);
    service.onApplicationShutdown();
  });
});
