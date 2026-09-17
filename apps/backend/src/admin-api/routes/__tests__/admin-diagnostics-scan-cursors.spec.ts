import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { AdminDiagnosticsController } from '../admin-diagnostics.controller';
import { SCAN_LEASE_TTL_MS } from '@gitroom/nestjs-libraries/engage/engage-scan-lease.service';

// A cursor sitting in SCANNING is NOT an outage. `EngageScanLeaseService.claim`
// reclaims one whose lease has expired in the same compare-and-swap it uses to
// claim an idle unit — so a row can only sit there because nobody is asking for
// that unit at all. This endpoint's job is to say WHICH of those two it is.

const hoursAgo = (h: number) => new Date(Date.now() - h * 60 * 60 * 1000);

const cursor = (over: Record<string, unknown> = {}) => ({
  id: 'cur-1',
  platform: 'reddit',
  scanType: 'keyword',
  scanKey: 'ai visibility',
  lastScanStartedAt: hoursAgo(50),
  lastScannedAt: hoursAgo(60),
  ...over,
});

const liveKeys = (over: Partial<Record<string, Set<string>>> = {}) => ({
  keywords: new Set<string>(),
  targets: new Set<string>(),
  nullProjectKeywords: new Set<string>(),
  nullProjectTargets: new Set<string>(),
  ...over,
});

function makeController(
  cursors: ReturnType<typeof cursor>[],
  live = liveKeys(),
  supportedPlatforms: string[] = ['x', 'reddit']
) {
  const engageRepository = {
    findStuckScanCursors: vi.fn().mockResolvedValue(cursors),
    getLiveScanUnitKeys: vi.fn().mockResolvedValue(live),
  } as any;
  const engageScanConfig = {
    getSupportedScanPlatforms: vi.fn().mockResolvedValue(supportedPlatforms),
  } as any;
  const controller = new AdminDiagnosticsController(
    {} as any,
    {} as any,
    engageRepository,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    engageScanConfig
  );
  return { controller, engageRepository };
}

describe('AdminDiagnosticsController.checkEngageScanCursors', () => {
  // The threshold used to be a flat 2 hours, unrelated to the mechanism it was
  // describing. Raising the lease must move the line with it, or the endpoint
  // starts reporting rows the claim path would take on sight.
  it('asks for rows past the LEASE, not past a fixed number of hours', async () => {
    const { controller, engageRepository } = makeController([]);

    const before = Date.now();
    await controller.checkEngageScanCursors();

    const cutoff: Date = engageRepository.findStuckScanCursors.mock.calls[0][0];
    const ageMs = before - cutoff.getTime();
    expect(ageMs).toBeGreaterThanOrEqual(SCAN_LEASE_TTL_MS);
    expect(ageMs).toBeLessThan(SCAN_LEASE_TTL_MS + 5_000);
  });

  it('reports a unit the enumerator still produces as STALE', async () => {
    const { controller } = makeController(
      [cursor()],
      liveKeys({ keywords: new Set(['ai visibility']) })
    );

    const res = await controller.checkEngageScanCursors();

    expect(res.stuckCursors).toHaveLength(1);
    expect(res.stuckCursors[0]).toMatchObject({ state: 'stale', reason: null });
    expect(res.summary.healthy).toBe(false);
  });

  // The population that made this endpoint unreadable: `253cce37` excluded the
  // legacy null-project config from scanning, and every one of its cursors
  // froze on the day it shipped with nothing left to claim them.
  it('names a legacy null-project unit rather than calling it stuck', async () => {
    const { controller } = makeController(
      [cursor()],
      liveKeys({ nullProjectKeywords: new Set(['ai visibility']) })
    );

    const res = await controller.checkEngageScanCursors();

    expect(res.stuckCursors).toHaveLength(0);
    expect(res.orphanedCursors[0]).toMatchObject({
      state: 'orphaned',
      reason: 'null-project',
    });
    // Not an incident: nothing is failing, there is cleanup to do.
    expect(res.summary.healthy).toBe(true);
    expect(res.summary.orphanedByReason).toEqual({ 'null-project': 1 });
  });

  it('names a unit whose platform the operator switched off', async () => {
    const { controller } = makeController(
      [cursor({ platform: 'medium', scanKey: 'design community' })],
      liveKeys({ keywords: new Set(['design community']) }),
      ['x', 'reddit']
    );

    const res = await controller.checkEngageScanCursors();

    expect(res.orphanedCursors[0].reason).toBe('platform-disabled');
  });

  // Order matters: a disabled platform explains everything under it, so it is
  // reported before "the keyword is gone" — that is the one an operator acts on.
  it('prefers the platform reason over a missing unit', async () => {
    const { controller } = makeController(
      [cursor({ platform: 'quora', scanKey: 'gone' })],
      liveKeys(),
      ['x', 'reddit']
    );

    const res = await controller.checkEngageScanCursors();

    expect(res.orphanedCursors[0].reason).toBe('platform-disabled');
  });

  it('names a deleted or disabled keyword', async () => {
    const { controller } = makeController([cursor({ scanKey: 'deleted keyword' })]);

    const res = await controller.checkEngageScanCursors();

    expect(res.orphanedCursors[0].reason).toBe('unit-removed');
  });

  // Channel and tracked units are keyed by platform AND scanKey, because the
  // same handle on two platforms is two different units.
  it('matches a channel unit on platform and key together', async () => {
    const { controller } = makeController(
      [cursor({ scanType: 'channel', scanKey: 'ui_design' })],
      liveKeys({ targets: new Set(['reddit:ui_design']) })
    );

    const res = await controller.checkEngageScanCursors();

    expect(res.stuckCursors[0].state).toBe('stale');
  });

  it('does not match a channel key that belongs to another platform', async () => {
    const { controller } = makeController(
      [cursor({ scanType: 'channel', scanKey: 'ui_design' })],
      liveKeys({ targets: new Set(['x:ui_design']) })
    );

    const res = await controller.checkEngageScanCursors();

    expect(res.orphanedCursors[0].reason).toBe('unit-removed');
  });

  it('separates the two populations in one response', async () => {
    const { controller } = makeController(
      [
        cursor({ id: 'live', scanKey: 'ai visibility' }),
        cursor({ id: 'legacy', scanKey: 'old keyword' }),
        cursor({ id: 'off-platform', platform: 'medium', scanKey: 'ai visibility' }),
        cursor({ id: 'gone', scanKey: 'deleted' }),
      ],
      liveKeys({
        keywords: new Set(['ai visibility']),
        nullProjectKeywords: new Set(['old keyword']),
      })
    );

    const res = await controller.checkEngageScanCursors();

    expect(res.stuckCursors.map((r: any) => r.id)).toEqual(['live']);
    expect(res.summary).toMatchObject({
      count: 1,
      orphanedCount: 3,
      healthy: false,
      orphanedByReason: {
        'null-project': 1,
        'platform-disabled': 1,
        'unit-removed': 1,
      },
    });
  });

  it('reports the lease it measured against, so the number is checkable', async () => {
    const { controller } = makeController([]);

    const res = await controller.checkEngageScanCursors();

    expect(res.leaseTtlMinutes).toBe(SCAN_LEASE_TTL_MS / 60_000);
    expect(res.summary).toMatchObject({ count: 0, orphanedCount: 0, healthy: true });
  });
});
