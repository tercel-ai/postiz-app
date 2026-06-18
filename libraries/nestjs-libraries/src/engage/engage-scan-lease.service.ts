import { Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';

/**
 * Default lease TTL for a claimed scan unit. The extension path is ASYNC — a
 * browser claims a unit, fetches over several jittered pages, then posts back —
 * so the lease must outlive a realistic in-browser scan (and self-heal if the
 * tab closes mid-scan). Generous on purpose; callers may override per path.
 */
export const SCAN_LEASE_TTL_MS = 5 * 60 * 1000;

/**
 * Canonical form of a keyword used as the GLOBAL scan-unit key
 * (`EngageScanCursor.scanKey` for scanType='keyword'). Normalising is what makes
 * cross-org dedup work: org1's "AI", org2's " ai " and "Ai" all collapse to one
 * global unit, so the keyword is fetched once for everyone.
 */
export function normalizeKeyword(keyword: string): string {
  return keyword.trim().toLowerCase().replace(/\s+/g, ' ');
}

export interface ScanCursorSnapshot {
  id: string;
  platform: string;
  scanType: string;
  scanKey: string;
  lastSeenExternalId: string | null;
  lastSeenAt: Date | null;
  // The per-claim handle the caller hands to the client AS the taskId. The
  // client never sees the cursor id; it echoes this token back, and only the
  // session holding the current token can complete the lease.
  leaseToken: string;
}

export interface ClaimArgs {
  platform: string;
  scanType: string; // 'keyword' | 'tracked' | 'channel'
  scanKey: string; // normalized keyword | username | subreddit id
  /** Min spacing between two scans of this unit; the cadence gate. */
  cadenceMs: number;
  /** Bypass the cadence gate (manual / forced refresh). */
  force?: boolean;
  /** Override the lease TTL (stale-reclaim window). */
  leaseTtlMs?: number;
  /** Injectable clock for tests. */
  now?: Date;
}

/**
 * Atomic, lease-aware claim/complete/release for a GLOBAL scan unit
 * (`EngageScanCursor`), shared by the workflow and the extension scan path.
 *
 * The cursor row is org-independent — keyed by (platform, scanType, scanKey) —
 * so whichever caller claims a unit first scans it once for every org that
 * subscribes to it; the others skip on the cadence gate. The claim is a single
 * compare-and-swap (only one winner under concurrency) and ALSO reclaims a unit
 * stuck in SCANNING past the lease TTL — essential for the async extension path,
 * where the browser holding the lease may simply vanish.
 */
@Injectable()
export class EngageScanLeaseService {
  constructor(
    private readonly _scanCursor: PrismaRepository<'engageScanCursor'>
  ) {}

  /**
   * Try to claim the unit. Returns the cursor snapshot (with the incremental
   * cursor to resume from) on success, or null when it is not due, cooling down,
   * actively leased by someone else, or lost to a concurrent claim.
   */
  async claim(args: ClaimArgs): Promise<ScanCursorSnapshot | null> {
    const now = args.now ?? new Date();
    const leaseTtlMs = args.leaseTtlMs ?? SCAN_LEASE_TTL_MS;
    const staleCutoff = new Date(now.getTime() - leaseTtlMs);

    const row = await this._scanCursor.model.engageScanCursor.upsert({
      where: {
        platform_scanType_scanKey: {
          platform: args.platform,
          scanType: args.scanType,
          scanKey: args.scanKey,
        },
      },
      create: {
        platform: args.platform,
        scanType: args.scanType,
        scanKey: args.scanKey,
        status: 'IDLE',
      },
      update: {},
    });

    const isScanning = row.status === 'SCANNING';
    const isStale =
      isScanning &&
      (!row.lastScanStartedAt || row.lastScanStartedAt <= staleCutoff);

    // Actively leased (fresh) by another worker/browser → skip.
    if (isScanning && !isStale) return null;
    // Backing off after a rate-limit.
    if (row.cooldownUntil && row.cooldownUntil > now) return null;
    // Cadence gate — but a stale-SCANNING reclaim retries immediately (its prior
    // attempt never completed), so the gate does not apply to it.
    if (
      !isStale &&
      !args.force &&
      row.lastScanStartedAt &&
      row.lastScanStartedAt.getTime() + args.cadenceMs > now.getTime()
    ) {
      return null;
    }

    // Fresh per-claim secret — rotates the lease so any prior token is dead.
    const leaseToken = randomBytes(24).toString('hex');

    // Atomic CAS: claim only if STILL idle, or still a stale SCANNING. Any racing
    // claimant flips status first; the loser's updateMany matches 0 rows.
    const claimed = await this._scanCursor.model.engageScanCursor.updateMany({
      where: {
        id: row.id,
        OR: [
          { status: 'IDLE' },
          { status: 'SCANNING', lastScanStartedAt: { lte: staleCutoff } },
          { status: 'SCANNING', lastScanStartedAt: null },
        ],
      },
      data: { status: 'SCANNING', lastScanStartedAt: now, leaseToken },
    });
    if (claimed.count !== 1) return null; // lost the race

    return {
      id: row.id,
      platform: row.platform,
      scanType: row.scanType,
      scanKey: row.scanKey,
      lastSeenExternalId: row.lastSeenExternalId,
      lastSeenAt: row.lastSeenAt,
      leaseToken,
    };
  }

  /**
   * Complete a lease the EXTENSION holds, identified by its `leaseToken` (the
   * client never learns the cursor id). Atomically requires the token to match
   * the CURRENT lease AND the unit to still be SCANNING — a stale/forged/rotated
   * token matches 0 rows. Returns true on success, false when the token is
   * invalid/expired (caller should ignore the submission).
   */
  async completeByToken(
    leaseToken: string,
    next: { lastSeenExternalId?: string | null; lastSeenAt?: Date | null },
    now: Date = new Date()
  ): Promise<boolean> {
    const res = await this._scanCursor.model.engageScanCursor.updateMany({
      where: { leaseToken, status: 'SCANNING' },
      data: {
        status: 'IDLE',
        lastScannedAt: now,
        lastSeenExternalId: next.lastSeenExternalId ?? null,
        lastSeenAt: next.lastSeenAt ?? null,
        cooldownUntil: null,
        leaseToken: null,
      },
    });
    return res.count === 1;
  }

  /** Release a token-held lease without advancing (skipped/aborted by client). */
  async releaseByToken(leaseToken: string): Promise<boolean> {
    const res = await this._scanCursor.model.engageScanCursor.updateMany({
      where: { leaseToken, status: 'SCANNING' },
      data: { status: 'IDLE', leaseToken: null },
    });
    return res.count === 1;
  }

  // ─── Id-based lifecycle (synchronous WORKFLOW path) ────────────────────────
  // The workflow holds the cursor row for the duration of one activity, so it
  // completes/cools/releases by id (no rotating token needed). It shares this
  // service's `claim` — and thus its stale-SCANNING reclaim — so a crashed
  // worker's lease self-heals instead of stranding the unit forever.

  /** Finish a scan: advance the incremental cursor and release the lease. */
  async complete(
    id: string,
    next: { lastSeenExternalId?: string | null; lastSeenAt?: Date | null },
    now: Date = new Date()
  ): Promise<void> {
    await this._scanCursor.model.engageScanCursor.update({
      where: { id },
      data: {
        status: 'IDLE',
        lastScannedAt: now,
        lastSeenExternalId: next.lastSeenExternalId ?? null,
        lastSeenAt: next.lastSeenAt ?? null,
        cooldownUntil: null,
        leaseToken: null,
      },
    });
  }

  /** Back off this unit until `until` after a rate-limit, releasing the lease. */
  async cooldown(id: string, until: Date): Promise<void> {
    await this._scanCursor.model.engageScanCursor.update({
      where: { id },
      data: { status: 'IDLE', cooldownUntil: until, leaseToken: null },
    });
  }

  /**
   * Release the lease without advancing the cursor (skipped/aborted). With
   * `resetStartedAt`, also clear lastScanStartedAt so the cadence gate does not
   * count this as a completed scan — the unit becomes due again immediately.
   */
  async release(
    id: string,
    opts: { resetStartedAt?: boolean } = {}
  ): Promise<void> {
    await this._scanCursor.model.engageScanCursor.update({
      where: { id },
      data: {
        status: 'IDLE',
        leaseToken: null,
        ...(opts.resetStartedAt && { lastScanStartedAt: null }),
      },
    });
  }
}
