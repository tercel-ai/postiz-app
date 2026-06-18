import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  EngageScanLeaseService,
  normalizeKeyword,
  SCAN_LEASE_TTL_MS,
} from '../engage-scan-lease.service';

function build(row: any, mutateCount = 1) {
  const engageScanCursor = {
    upsert: vi.fn(async () => row),
    updateMany: vi.fn(async () => ({ count: mutateCount })),
    update: vi.fn(async () => ({})),
  };
  const repo = { model: { engageScanCursor } } as any;
  return { svc: new EngageScanLeaseService(repo), engageScanCursor };
}

const NOW = new Date('2026-06-17T12:00:00.000Z');
const base = {
  id: 'c1',
  platform: 'reddit',
  scanType: 'keyword',
  scanKey: 'ai',
  status: 'IDLE',
  lastScanStartedAt: null,
  lastSeenExternalId: null,
  lastSeenAt: null,
  cooldownUntil: null,
};
const claimArgs = {
  platform: 'reddit',
  scanType: 'keyword',
  scanKey: 'ai',
  cadenceMs: 6 * 3600_000,
  now: NOW,
};

describe('normalizeKeyword', () => {
  it('lowercases, trims and collapses whitespace', () => {
    expect(normalizeKeyword('  AI ')).toBe('ai');
    expect(normalizeKeyword('Machine   Learning')).toBe('machine learning');
    expect(normalizeKeyword('Ai')).toBe(normalizeKeyword(' ai '));
  });
});

describe('EngageScanLeaseService.claim', () => {
  beforeEach(() => vi.clearAllMocks());

  it('claims an IDLE unit, writes a fresh leaseToken, and returns it', async () => {
    const { svc, engageScanCursor } = build({ ...base });
    const res = await svc.claim(claimArgs);
    expect(res).toMatchObject({ id: 'c1', scanKey: 'ai' });
    expect(res!.leaseToken).toMatch(/^[0-9a-f]{48}$/); // 24 random bytes, hex
    const data = engageScanCursor.updateMany.mock.calls[0][0].data;
    expect(data.status).toBe('SCANNING');
    expect(data.lastScanStartedAt).toBe(NOW);
    expect(data.leaseToken).toBe(res!.leaseToken); // same token persisted + returned
  });

  it('rotates the token each claim (two claims → different tokens)', async () => {
    const a = await build({ ...base }).svc.claim(claimArgs);
    const b = await build({ ...base }).svc.claim(claimArgs);
    expect(a!.leaseToken).not.toBe(b!.leaseToken);
  });

  it('skips a unit freshly leased by someone else (SCANNING, not stale)', async () => {
    const fresh = new Date(NOW.getTime() - 10_000); // 10s ago, well within TTL
    const { svc, engageScanCursor } = build({
      ...base,
      status: 'SCANNING',
      lastScanStartedAt: fresh,
    });
    expect(await svc.claim(claimArgs)).toBeNull();
    expect(engageScanCursor.updateMany).not.toHaveBeenCalled();
  });

  it('reclaims a STALE SCANNING unit (lease expired — browser vanished)', async () => {
    const stale = new Date(NOW.getTime() - SCAN_LEASE_TTL_MS - 1000);
    const { svc, engageScanCursor } = build({
      ...base,
      status: 'SCANNING',
      lastScanStartedAt: stale,
    });
    const res = await svc.claim(claimArgs);
    expect(res).not.toBeNull();
    expect(engageScanCursor.updateMany).toHaveBeenCalledTimes(1);
  });

  it('honours the cadence gate: skips a recently-scanned IDLE unit', async () => {
    const recent = new Date(NOW.getTime() - 60_000); // 1min ago < 6h cadence
    const { svc } = build({ ...base, lastScanStartedAt: recent });
    expect(await svc.claim(claimArgs)).toBeNull();
  });

  it('force bypasses the cadence gate', async () => {
    const recent = new Date(NOW.getTime() - 60_000);
    const { svc, engageScanCursor } = build({ ...base, lastScanStartedAt: recent });
    expect(await svc.claim({ ...claimArgs, force: true })).not.toBeNull();
    expect(engageScanCursor.updateMany).toHaveBeenCalledTimes(1);
  });

  it('skips a unit still in cooldown', async () => {
    const until = new Date(NOW.getTime() + 60_000);
    const { svc } = build({ ...base, cooldownUntil: until });
    expect(await svc.claim(claimArgs)).toBeNull();
  });

  it('returns null when the atomic CAS loses the race (0 rows updated)', async () => {
    const { svc } = build({ ...base }, 0);
    expect(await svc.claim(claimArgs)).toBeNull();
  });
});


describe('EngageScanLeaseService id-based lifecycle (workflow path)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('complete advances the cursor, clears the token, and releases', async () => {
    const { svc, engageScanCursor } = build({ ...base });
    await svc.complete('c1', { lastSeenExternalId: 't3_x', lastSeenAt: NOW }, NOW);
    const data = engageScanCursor.update.mock.calls[0][0].data;
    expect(data).toMatchObject({
      status: 'IDLE',
      lastSeenExternalId: 't3_x',
      lastSeenAt: NOW,
      cooldownUntil: null,
      leaseToken: null,
    });
  });

  it('cooldown releases the lease with a back-off', async () => {
    const until = new Date(NOW.getTime() + 900_000);
    const { svc, engageScanCursor } = build({ ...base });
    await svc.cooldown('c1', until);
    expect(engageScanCursor.update.mock.calls[0][0].data).toEqual({
      status: 'IDLE',
      cooldownUntil: until,
      leaseToken: null,
    });
  });

  it('release with resetStartedAt makes the unit due again immediately', async () => {
    const { svc, engageScanCursor } = build({ ...base });
    await svc.release('c1', { resetStartedAt: true });
    expect(engageScanCursor.update.mock.calls[0][0].data).toEqual({
      status: 'IDLE',
      leaseToken: null,
      lastScanStartedAt: null,
    });
  });
});

describe('EngageScanLeaseService.completeByToken (session binding)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('completes when the token matches the current SCANNING lease', async () => {
    const { svc, engageScanCursor } = build({ ...base }, 1);
    const ok = await svc.completeByToken('tok123', { lastSeenExternalId: 't3_x', lastSeenAt: NOW }, NOW);
    expect(ok).toBe(true);
    const call = engageScanCursor.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ leaseToken: 'tok123', status: 'SCANNING' });
    expect(call.data.leaseToken).toBeNull(); // token cleared on complete
    expect(call.data.status).toBe('IDLE');
  });

  it('returns false for a stale/forged/rotated token (0 rows matched)', async () => {
    const { svc } = build({ ...base }, 0);
    expect(await svc.completeByToken('wrong', {}, NOW)).toBe(false);
  });

  it('releaseByToken returns false when the token no longer owns the lease', async () => {
    const { svc } = build({ ...base }, 0);
    expect(await svc.releaseByToken('wrong')).toBe(false);
  });
});
