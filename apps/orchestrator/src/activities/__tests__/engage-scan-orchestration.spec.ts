import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EngageScanActivity } from '../engage-scan.activity';
import { TokenPool } from '@gitroom/nestjs-libraries/engage/scan/token-pool';
import type { ScanResult } from '@gitroom/nestjs-libraries/engage/scan/platform-scan-adapter';

// Builds an activity wired to a fake EngageScanCursor repo. `row` is what the
// claim upsert returns; `claimCount` is what the IDLE→SCANNING updateMany
// reports (1 = won the single-flight, 0 = lost it).
function build(row: any, claimCount = 1) {
  const upsert = vi.fn().mockResolvedValue(row);
  const updateMany = vi.fn().mockResolvedValue({ count: claimCount });
  const update = vi.fn().mockResolvedValue({});
  const cursorRepo = {
    model: { engageScanCursor: { upsert, updateMany, update } },
  };
  const activity = new EngageScanActivity(
    {} as any, {} as any, {} as any, {} as any, {} as any,
    {} as any, {} as any, {} as any, {} as any,
    cursorRepo as any
  );
  return { activity, upsert, updateMany, update };
}

const IDLE_ROW = {
  id: 'cur1',
  status: 'IDLE',
  cooldownUntil: null,
  lastSeenExternalId: '100',
  lastSeenAt: new Date('2026-01-01T00:00:00Z'),
};

function fakeAdapter(result: ScanResult) {
  return { platform: 'x', caps: {} as any, searchScoped: vi.fn().mockResolvedValue(result) };
}

function scanArgs(over: Record<string, unknown> = {}) {
  return {
    platform: 'x',
    scanType: 'keyword',
    scanKey: '__global__',
    scope: { type: 'keyword' },
    keywords: ['AI'],
    xPool: new TokenPool(['tkn']),
    ...over,
  };
}

describe('EngageScanActivity._scanUnit (cursor lifecycle)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('claims IDLE→SCANNING, passes the stored cursor to the adapter, then completes', async () => {
    const { activity, upsert, updateMany, update } = build(IDLE_ROW);
    const result: ScanResult = {
      posts: [{ externalPostId: 'x1' } as any],
      nextCursor: { lastSeenExternalId: '200', lastSeenAt: new Date('2026-02-02T00:00:00Z') },
      rate: { limited: false },
    };
    const adapter = fakeAdapter(result);
    (activity as any)._xAdapter = adapter;

    const out = await (activity as any)._scanUnit(scanArgs());

    expect(upsert).toHaveBeenCalledTimes(1);
    // Claim: IDLE→SCANNING + lastScanStartedAt.
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'cur1', status: 'IDLE' },
        data: expect.objectContaining({ status: 'SCANNING' }),
      })
    );
    // Adapter received the persisted incremental cursor.
    expect(adapter.searchScoped).toHaveBeenCalledWith(
      expect.objectContaining({
        cursor: { lastSeenExternalId: '100', lastSeenAt: IDLE_ROW.lastSeenAt },
      })
    );
    // Complete: advance cursor, IDLE, clear cooldown.
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'cur1' },
        data: expect.objectContaining({
          status: 'IDLE',
          lastSeenExternalId: '200',
          cooldownUntil: null,
        }),
      })
    );
    expect(out.posts).toHaveLength(1);
  });

  it('skips a cooling-down unit without calling the adapter', async () => {
    const future = new Date(Date.now() + 60_000);
    const { activity, updateMany } = build({ ...IDLE_ROW, cooldownUntil: future });
    const adapter = fakeAdapter({ posts: [], nextCursor: {}, rate: { limited: false } });
    (activity as any)._xAdapter = adapter;

    const out = await (activity as any)._scanUnit(scanArgs());

    expect(out.posts).toEqual([]);
    expect(updateMany).not.toHaveBeenCalled(); // never claimed
    expect(adapter.searchScoped).not.toHaveBeenCalled();
  });

  it('skips a unit already SCANNING (single-flight)', async () => {
    const { activity, updateMany } = build({ ...IDLE_ROW, status: 'SCANNING' });
    const adapter = fakeAdapter({ posts: [], nextCursor: {}, rate: { limited: false } });
    (activity as any)._xAdapter = adapter;

    const out = await (activity as any)._scanUnit(scanArgs());
    expect(out.posts).toEqual([]);
    expect(updateMany).not.toHaveBeenCalled();
    expect(adapter.searchScoped).not.toHaveBeenCalled();
  });

  it('returns empty when it loses the claim race (updateMany count 0)', async () => {
    const { activity, update } = build(IDLE_ROW, 0);
    const adapter = fakeAdapter({ posts: [], nextCursor: {}, rate: { limited: false } });
    (activity as any)._xAdapter = adapter;

    const out = await (activity as any)._scanUnit(scanArgs());
    expect(out.posts).toEqual([]);
    expect(adapter.searchScoped).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('cools down (does NOT advance cursor) when the adapter reports a rate limit', async () => {
    const { activity, update } = build(IDLE_ROW);
    const adapter = fakeAdapter({
      posts: [],
      nextCursor: { lastSeenExternalId: '999' },
      rate: { limited: true, retryAfterMs: 30_000 },
    });
    (activity as any)._xAdapter = adapter;

    await (activity as any)._scanUnit(scanArgs());

    const call = update.mock.calls[0][0];
    expect(call.data.cooldownUntil).toBeInstanceOf(Date);
    // Cursor must NOT be advanced on a rate-limit (retry from the same point).
    expect(call.data).not.toHaveProperty('lastSeenExternalId');
  });

  it('releases the SCANNING lock when the adapter throws', async () => {
    const { activity, update } = build(IDLE_ROW);
    const adapter = { platform: 'x', caps: {} as any, searchScoped: vi.fn().mockRejectedValue(new Error('boom')) };
    (activity as any)._xAdapter = adapter;

    const out = await (activity as any)._scanUnit(scanArgs());
    expect(out.posts).toEqual([]);
    // Released to IDLE, cursor untouched.
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'cur1' }, data: { status: 'IDLE' } })
    );
  });

  it('skips an X unit (releasing the lock) when the token pool is exhausted', async () => {
    const { activity, update } = build(IDLE_ROW);
    const adapter = fakeAdapter({ posts: [], nextCursor: {}, rate: { limited: false } });
    (activity as any)._xAdapter = adapter;

    const out = await (activity as any)._scanUnit(scanArgs({ xPool: new TokenPool([]) }));
    expect(out.posts).toEqual([]);
    expect(adapter.searchScoped).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'cur1' }, data: { status: 'IDLE' } })
    );
  });

  it('skips a unit scanned within its cadence (not due)', async () => {
    // keyword cadence defaults to 24h; lastScanStartedAt 1h ago → not due.
    const recent = new Date(Date.now() - 60 * 60 * 1000);
    const { activity, updateMany } = build({ ...IDLE_ROW, lastScanStartedAt: recent });
    const adapter = fakeAdapter({ posts: [], nextCursor: {}, rate: { limited: false } });
    (activity as any)._xAdapter = adapter;

    const out = await (activity as any)._scanUnit(scanArgs());
    expect(out.ran).toBe(false);
    expect(updateMany).not.toHaveBeenCalled(); // cadence gate → never claimed
    expect(adapter.searchScoped).not.toHaveBeenCalled();
  });

  it('force bypasses the cadence gate', async () => {
    const recent = new Date(Date.now() - 60 * 60 * 1000); // well within 24h cadence
    const { activity, updateMany } = build({ ...IDLE_ROW, lastScanStartedAt: recent });
    const adapter = fakeAdapter({
      posts: [],
      nextCursor: { lastSeenExternalId: '5' },
      rate: { limited: false },
    });
    (activity as any)._xAdapter = adapter;

    const out = await (activity as any)._scanUnit(scanArgs({ force: true }));
    expect(out.ran).toBe(true);
    expect(updateMany).toHaveBeenCalled(); // claimed despite the recent scan
    expect(adapter.searchScoped).toHaveBeenCalled();
  });
});
