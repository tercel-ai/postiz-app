import { afterEach, describe, expect, it, vi } from 'vitest';
import { SendModeTransitionReconciliationService } from '../send-mode-transition-reconciliation.service';

afterEach(() => vi.useRealTimers());
describe('sending mode transition reconciliation lifecycle', () => {
  it('runs on boot and every fifteen seconds without an open UI and stops on shutdown', async () => {
    vi.useFakeTimers();
    const modes = {
      reconcilePendingTransitions: vi.fn().mockResolvedValue([]),
      pendingReallocations: vi.fn().mockResolvedValue([]),
    };
    const identities = {
      reconcilePendingControlledOrganizations: vi.fn().mockResolvedValue([]),
    };
    const service = new SendModeTransitionReconciliationService(
      modes as any,
      {} as any,
      identities as any
    );
    service.onApplicationBootstrap();
    expect(modes.reconcilePendingTransitions).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(modes.reconcilePendingTransitions).toHaveBeenCalledTimes(3);
    expect(
      identities.reconcilePendingControlledOrganizations
    ).toHaveBeenCalledTimes(3);
    service.onApplicationShutdown();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(modes.reconcilePendingTransitions).toHaveBeenCalledTimes(3);
    expect(
      identities.reconcilePendingControlledOrganizations
    ).toHaveBeenCalledTimes(3);
  });
  it('does not overlap an unfinished reconciliation', async () => {
    vi.useFakeTimers();
    let complete!: () => void;
    const modes = {
      pendingReallocations: vi.fn().mockResolvedValue([]),
      reconcilePendingTransitions: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            complete = resolve;
          })
      ),
    };
    const service = new SendModeTransitionReconciliationService(
      modes as any,
      {} as any
    );
    service.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(modes.reconcilePendingTransitions).toHaveBeenCalledTimes(1);
    complete();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(modes.reconcilePendingTransitions).toHaveBeenCalledTimes(2);
    service.onApplicationShutdown();
  });

  it('continues mode settlement and reallocation while identity verification is stalled', async () => {
    vi.useFakeTimers();
    const modes = {
      reconcilePendingTransitions: vi.fn().mockResolvedValue([]),
      pendingReallocations: vi
        .fn()
        .mockResolvedValue([{ organizationId: 'org', userId: 'admin' }]),
      recordReallocationIssues: vi.fn(),
    };
    const coordinator = {
      reallocateUnsentLegacy: vi.fn().mockResolvedValue([]),
    };
    const identities = {
      reconcilePendingControlledOrganizations: vi.fn(
        () => new Promise(() => {})
      ),
    };
    const service = new SendModeTransitionReconciliationService(
      modes as any,
      coordinator as any,
      identities as any
    );

    service.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(45_000);

    expect(modes.reconcilePendingTransitions).toHaveBeenCalledTimes(4);
    expect(coordinator.reallocateUnsentLegacy).toHaveBeenCalledTimes(4);
    expect(
      identities.reconcilePendingControlledOrganizations
    ).toHaveBeenCalledTimes(1);
    service.onApplicationShutdown();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(modes.reconcilePendingTransitions).toHaveBeenCalledTimes(4);
  });

  it('runs identity repair independently when mode reconciliation fails', async () => {
    vi.useFakeTimers();
    const modes = {
      reconcilePendingTransitions: vi
        .fn()
        .mockRejectedValue(new Error('settlement unavailable')),
    };
    const identities = {
      reconcilePendingControlledOrganizations: vi.fn().mockResolvedValue([]),
    };
    const service = new SendModeTransitionReconciliationService(
      modes as any,
      {} as any,
      identities as any
    );

    service.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(15_000);

    expect(
      identities.reconcilePendingControlledOrganizations
    ).toHaveBeenCalledTimes(2);
    service.onApplicationShutdown();
  });
});

it('reallocates pending organizations after mode reconciliation and persists their actionable issues', async () => {
  vi.useFakeTimers();
  const issues = [{ postId: 'root', code: 'SEND_PROJECT_REQUIRED' }];
  const modes = {
    reconcilePendingTransitions: vi.fn().mockResolvedValue([]),
    pendingReallocations: vi
      .fn()
      .mockResolvedValue([{ organizationId: 'org', userId: 'admin' }]),
    recordReallocationIssues: vi.fn(),
  };
  const coordinator = {
    reallocateUnsentLegacy: vi.fn().mockResolvedValue(issues),
  };
  const service = new SendModeTransitionReconciliationService(
    modes as any,
    coordinator as any
  );
  service.onApplicationBootstrap();
  await vi.advanceTimersByTimeAsync(0);
  expect(coordinator.reallocateUnsentLegacy).toHaveBeenCalledWith(
    'org',
    'admin'
  );
  expect(modes.recordReallocationIssues).toHaveBeenCalledWith('org', issues);
  expect(
    modes.reconcilePendingTransitions.mock.invocationCallOrder[0]
  ).toBeLessThan(modes.pendingReallocations.mock.invocationCallOrder[0]);
  service.onApplicationShutdown();
});
it('keeps processing other organizations when one reallocation fails', async () => {
  vi.useFakeTimers();
  const modes = {
    reconcilePendingTransitions: vi.fn().mockResolvedValue([]),
    pendingReallocations: vi.fn().mockResolvedValue([
      { organizationId: 'broken', userId: 'admin' },
      { organizationId: 'healthy', userId: 'admin' },
    ]),
    recordReallocationIssues: vi.fn(),
  };
  const coordinator = {
    reallocateUnsentLegacy: vi.fn(async (org: string) => {
      if (org === 'broken') throw new Error('temporarily unavailable');
      return [];
    }),
  };
  const service = new SendModeTransitionReconciliationService(
    modes as any,
    coordinator as any
  );
  service.onApplicationBootstrap();
  await vi.advanceTimersByTimeAsync(0);
  expect(coordinator.reallocateUnsentLegacy).toHaveBeenCalledTimes(2);
  expect(modes.recordReallocationIssues).toHaveBeenCalledWith('healthy', []);
  service.onApplicationShutdown();
});
