import { describe, it, expect, vi } from 'vitest';
import {
  RISK_GATES,
  RiskControlTickService,
} from '../risk-control-tick.service';

function build(rows: any[] = []) {
  const riskControlTick = {
    upsert: vi.fn(async () => ({})),
    findMany: vi.fn(async () => rows),
  };
  return {
    service: new RiskControlTickService({ model: { riskControlTick } } as any),
    riskControlTick,
  };
}

const row = (over: Partial<Record<string, unknown>> = {}) => ({
  organizationId: 'org1',
  gate: RISK_GATES.postDraftLimit,
  outcome: 'rejected',
  detail: 'project',
  quantity: BigInt(3),
  ...over,
});

describe('RiskControlTickService.record', () => {
  it('upserts into the UTC day bucket and increments', async () => {
    const { service, riskControlTick } = build();
    await service.record({
      gate: RISK_GATES.engageIngestQuota,
      organizationId: 'org1',
      detail: 'plan',
      now: new Date('2026-09-03T21:30:00.000Z'),
    });
    await service.flush();
    const call = (riskControlTick.upsert.mock.calls[0] as any[])[0];
    expect(call.where.date_organizationId_gate_outcome_detail).toEqual({
      date: new Date('2026-09-03T00:00:00.000Z'),
      organizationId: 'org1',
      gate: 'engage_ingest_quota',
      outcome: 'rejected',
      detail: 'plan',
    });
    expect(call.update).toEqual({ quantity: { increment: 1 } });
  });

  it("stores '' rather than null for system-level work", async () => {
    // Prisma treats NULLs as distinct in a unique key, so a null org would
    // scatter system rows one per write instead of merging into one counter.
    const { service, riskControlTick } = build();
    await service.record({ gate: RISK_GATES.routeThrottle });
    await service.flush();
    const call = (riskControlTick.upsert.mock.calls[0] as any[])[0];
    expect(call.where.date_organizationId_gate_outcome_detail.organizationId).toBe('');
    expect(call.where.date_organizationId_gate_outcome_detail.detail).toBe('');
  });

  it('NEVER throws — telemetry must not turn a 4xx into a 500', async () => {
    const { service, riskControlTick } = build();
    riskControlTick.upsert.mockRejectedValue(new Error('db down'));
    await service.record({ gate: RISK_GATES.postDraftLimit });
    await expect(service.flush()).resolves.toBeUndefined();
  });

  it('keeps a failed count buffered so a database blip costs latency, not data', async () => {
    const { service, riskControlTick } = build();
    riskControlTick.upsert.mockRejectedValueOnce(new Error('db down'));
    await service.record({ gate: RISK_GATES.postDraftLimit, quantity: 4 });
    await service.flush(); // fails, count goes back into the buffer
    await service.flush(); // succeeds
    const call = (riskControlTick.upsert.mock.calls[1] as any[])[0];
    expect(call.create.quantity).toBe(4);
  });

  it('ignores a missing gate or a non-positive quantity', async () => {
    const { service, riskControlTick } = build();
    await service.record({ gate: '' });
    await service.record({ gate: RISK_GATES.postDraftLimit, quantity: 0 });
    await service.flush();
    expect(riskControlTick.upsert).not.toHaveBeenCalled();
  });
});

describe('RiskControlTickService reads', () => {
  it('converts BigInt quantities, which do not survive JSON', async () => {
    const { service } = build([row()]);
    expect((await service.query({ from: new Date() }))[0].quantity).toBe(3);
  });

  it('totals by gate over the window', async () => {
    const { service } = build([
      row({ quantity: BigInt(3) }),
      row({ quantity: BigInt(2), gate: RISK_GATES.engageIngestQuota }),
      row({ quantity: BigInt(1), organizationId: 'org2' }),
    ]);
    expect(await service.totalsByGate({ from: new Date() })).toEqual({
      post_draft_limit: 4,
      engage_ingest_quota: 2,
    });
  });

  it('ranks orgs by refusals, busiest first', async () => {
    const { service } = build([
      row({ quantity: BigInt(1), organizationId: 'quiet' }),
      row({ quantity: BigInt(9), organizationId: 'noisy' }),
      row({ quantity: BigInt(5), organizationId: 'noisy', detail: 'organization' }),
    ]);
    expect(await service.topOrgs({ from: new Date(), limit: 2 })).toEqual([
      { organizationId: 'noisy', quantity: 14 },
      { organizationId: 'quiet', quantity: 1 },
    ]);
  });

  it('passes the filters through to the query', async () => {
    const { service, riskControlTick } = build();
    await service.query({
      from: new Date('2026-09-01T10:00:00.000Z'),
      to: new Date('2026-09-03T10:00:00.000Z'),
      gate: RISK_GATES.routeThrottle,
      organizationId: 'org1',
      outcome: 'rejected',
    });
    expect((riskControlTick.findMany.mock.calls[0] as any[])[0].where).toEqual({
      date: {
        gte: new Date('2026-09-01T00:00:00.000Z'),
        lte: new Date('2026-09-03T00:00:00.000Z'),
      },
      gate: 'route_throttle',
      organizationId: 'org1',
      outcome: 'rejected',
    });
  });
});

describe('RiskControlTickService coalescing', () => {
  it('collapses a burst on ONE key into a single upsert', async () => {
    // The reason this buffer exists: throttler blockDuration defaults to the
    // throttler ttl (an hour here), and the storage reports isBlocked for EVERY
    // request until it expires — so one caller crossing its limit produces a
    // refusal per request for the rest of the hour, all keyed to the same row.
    const { service, riskControlTick } = build();
    for (let i = 0; i < 500; i++) {
      await service.record({
        gate: RISK_GATES.routeThrottle,
        organizationId: 'org1',
        detail: 'POST /posts',
      });
    }
    expect(riskControlTick.upsert).not.toHaveBeenCalled(); // nothing yet

    await service.flush();
    expect(riskControlTick.upsert).toHaveBeenCalledTimes(1);
    expect((riskControlTick.upsert.mock.calls[0] as any[])[0].create.quantity).toBe(500);
  });

  it('keeps distinct keys apart', async () => {
    const { service, riskControlTick } = build();
    await service.record({ gate: RISK_GATES.routeThrottle, organizationId: 'a' });
    await service.record({ gate: RISK_GATES.routeThrottle, organizationId: 'b' });
    await service.record({ gate: RISK_GATES.postDraftLimit, organizationId: 'a' });
    await service.flush();
    expect(riskControlTick.upsert).toHaveBeenCalledTimes(3);
  });

  it('buckets by the day the refusal happened, not the day it is flushed', async () => {
    // A flush that straddles midnight must not move yesterday's count into today.
    const { service, riskControlTick } = build();
    await service.record({
      gate: RISK_GATES.routeThrottle,
      now: new Date('2026-09-02T23:59:59.000Z'),
    });
    await service.record({
      gate: RISK_GATES.routeThrottle,
      now: new Date('2026-09-03T00:00:01.000Z'),
    });
    await service.flush();
    expect(riskControlTick.upsert).toHaveBeenCalledTimes(2);
  });

  it('flushes what is buffered on shutdown', async () => {
    const { service, riskControlTick } = build();
    await service.record({ gate: RISK_GATES.postDraftLimit });
    await service.onApplicationShutdown();
    expect(riskControlTick.upsert).toHaveBeenCalledTimes(1);
  });

  it('flushes before a read, so an in-flight incident is not under-reported', async () => {
    const { service, riskControlTick } = build();
    await service.record({ gate: RISK_GATES.routeThrottle });
    await service.query({ from: new Date() });
    expect(riskControlTick.upsert).toHaveBeenCalledTimes(1);
  });
});
