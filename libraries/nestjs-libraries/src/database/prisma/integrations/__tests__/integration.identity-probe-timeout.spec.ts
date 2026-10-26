import { afterEach, describe, expect, it, vi } from 'vitest';
import { IntegrationService } from '../integration.service';

afterEach(() => vi.useRealTimers());

function fixture(getSendActor: ReturnType<typeof vi.fn>) {
  const committed = vi.fn();
  const repository = {
    verifyStableIdentity: vi.fn(async (_org, _user, _id, probe) => {
      const actor = await probe({ providerIdentifier: 'x', token: 'secret' });
      committed(actor);
      return actor;
    }),
  };
  const manager = { getSocialIntegration: vi.fn(() => ({ getSendActor })) };
  const service = new IntegrationService(
    repository as any,
    {} as any,
    manager as any,
    {} as any,
    {} as any,
    {} as any
  );
  return { service, committed };
}

describe('protected identity probe deadline', () => {
  it('aborts a stalled probe and prevents a late result from reaching identity writes', async () => {
    vi.useFakeTimers();
    let signal!: AbortSignal;
    let finish!: (actor: { id: string; idNamespace: string }) => void;
    const getSendActor = vi.fn((_account, probeSignal) => {
      signal = probeSignal;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const f = fixture(getSendActor);
    const result = f.service.verifyStableIdentity('org', 'admin', 'account');
    const rejected = expect(result).rejects.toThrow(
      'ACCOUNT_IDENTITY_PROBE_TIMEOUT'
    );

    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(signal.aborted).toBe(true);
    finish({ id: '123', idNamespace: 'x.rest_id' });
    await Promise.resolve();
    expect(f.committed).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears its deadline after a successful probe', async () => {
    vi.useFakeTimers();
    const actor = { id: '123', idNamespace: 'x.rest_id' };
    const getSendActor = vi.fn().mockResolvedValue(actor);
    const f = fixture(getSendActor);

    expect(
      await f.service.verifyStableIdentity('org', 'admin', 'account')
    ).toEqual(actor);
    expect(getSendActor.mock.calls[0][1]).toBeInstanceOf(AbortSignal);
    expect(vi.getTimerCount()).toBe(0);
  });
});
