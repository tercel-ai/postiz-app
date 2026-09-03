import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';

/**
 * Which control acted. Free-form by design — a control added later needs a call
 * site, not a migration — but the ones in use are named here so a reader sees
 * the whole set without grepping, and so diagnostics can enumerate them.
 */
export const RISK_GATES = {
  engageIngestQuota: 'engage_ingest_quota',
  postDraftLimit: 'post_draft_limit',
  routeThrottle: 'route_throttle',
} as const;
/**
 * What the control did. Everything records 'rejected' today; the column exists
 * so a control that also counts what it let through can report a RATE, which is
 * far more meaningful than a bare count — "50 refusals" says nothing without
 * "out of how many".
 */
export type RiskOutcome = 'rejected' | 'allowed' | 'degraded';

export interface RecordArgs {
  gate: string;
  outcome?: RiskOutcome;
  /** '' for system-level work with no owning org. */
  organizationId?: string | null;
  /** Sub-dimension: which cap scope, which route bucket. '' when there is none. */
  detail?: string | null;
  quantity?: number;
  /** Injectable clock for tests. */
  now?: Date;
}

export interface QueryArgs {
  from: Date;
  to?: Date;
  gate?: string;
  organizationId?: string;
  outcome?: RiskOutcome;
}

export interface RiskControlRow {
  organizationId: string;
  gate: string;
  outcome: string;
  detail: string;
  quantity: number;
}

interface TickKey {
  date: Date;
  organizationId: string;
  gate: string;
  outcome: string;
  detail: string;
}

/** UTC midnight of `d` — the bucket every row is keyed on. */
function dayBucket(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * Write AND read side of the risk-control counters.
 *
 * The read half is not speculative future-proofing: a counter nothing queries is
 * a counter nobody looks at, and the whole reason to record refusals is that two
 * of the three write-path controls (the ingest quota and the route throttles)
 * count in Redis under short TTLs and are therefore invisible the next day.
 * See docs/engage/write-path-limits.md §3b.
 */
@Injectable()
export class RiskControlTickService implements OnApplicationShutdown {
  private readonly logger = new Logger(RiskControlTickService.name);

  /**
   * Counts waiting to be written, keyed by the full row identity (the day bucket
   * included, so a flush that straddles midnight still lands each count in the
   * day it happened).
   *
   * Coalescing is not an optimisation, it is what makes the throttle call site
   * safe. `@nestjs/throttler` sets `blockDuration` to the throttler's `ttl` when
   * a route does not override it — one hour here — and the storage reports
   * `isBlocked` for EVERY request until that block expires. So a caller that
   * crosses its limit does not produce one refusal, it produces one per request
   * for the rest of the hour, and every one of them keys to the SAME row
   * (same org, same route, same day). Writing per refusal would put a serialised
   * single-row upsert storm on the path whose entire job is to shed that load.
   */
  private readonly _pending = new Map<string, { key: TickKey; quantity: number }>();
  private _timer?: ReturnType<typeof setInterval>;

  /**
   * Flush cadence. Short enough that a crash loses a trivial amount of
   * telemetry, long enough that an hour-long block collapses from ~360k writes
   * at 100 req/s into ~360.
   */
  static readonly FLUSH_MS = 10_000;

  constructor(private readonly _tick: PrismaRepository<'riskControlTick'>) {}

  /**
   * Add to today's counter for one (org, gate, outcome, detail).
   *
   * NEVER throws. It is called from inside the refusal path of a control that
   * has already decided the request is over its limit; failing to write
   * telemetry must not turn a clean 4xx into a 500, nor mask the real reason the
   * caller was refused.
   */
  async record(args: RecordArgs): Promise<void> {
    const quantity = Math.floor(args.quantity ?? 1);
    if (!args.gate || quantity <= 0) return;
    const key: TickKey = {
      date: dayBucket(args.now ?? new Date()),
      // Non-null so upserts merge: Prisma treats NULLs as distinct in a unique
      // key, which would scatter system-level rows one per write.
      organizationId: args.organizationId ?? '',
      gate: args.gate,
      outcome: args.outcome ?? 'rejected',
      detail: args.detail ?? '',
    };
    const id = [
      key.date.toISOString(),
      key.organizationId,
      key.gate,
      key.outcome,
      key.detail,
    ].join('\u0000');
    const existing = this._pending.get(id);
    if (existing) existing.quantity += quantity;
    else this._pending.set(id, { key, quantity });
    this._ensureTimer();
  }

  private _ensureTimer(): void {
    if (this._timer) return;
    this._timer = setInterval(
      () => void this.flush(),
      RiskControlTickService.FLUSH_MS
    );
    // Never hold the process open for a telemetry flush.
    this._timer.unref?.();
  }

  /**
   * Write every buffered count, then clear it.
   *
   * NEVER throws. It runs behind controls that have already decided to refuse a
   * request; failing telemetry must not turn a clean 4xx into a 500, nor mask
   * the real reason the caller was refused. A failed row is put BACK in the
   * buffer so a transient database blip costs latency rather than data.
   */
  async flush(): Promise<void> {
    if (!this._pending.size) return;
    const batch = [...this._pending.entries()];
    this._pending.clear();
    for (const [id, { key, quantity }] of batch) {
      try {
        await this._tick.model.riskControlTick.upsert({
          where: { date_organizationId_gate_outcome_detail: key },
          create: { ...key, quantity },
          update: { quantity: { increment: quantity } },
        });
      } catch (err) {
        // Merge back rather than overwrite: more may have accumulated while the
        // write was in flight.
        const current = this._pending.get(id);
        if (current) current.quantity += quantity;
        else this._pending.set(id, { key, quantity });
        this.logger.error(
          `Failed to flush risk-control tick ${key.gate}/${key.outcome}; will retry`,
          err as Error
        );
      }
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (this._timer) clearInterval(this._timer);
    this._timer = undefined;
    await this.flush();
  }

  /** Raw rows in a window, newest bucket first. */
  async query(args: QueryArgs): Promise<RiskControlRow[]> {
    // Flush first: the buffer is at most FLUSH_MS old, but a diagnostics call
    // made DURING an incident is exactly when the newest counts matter most.
    await this.flush();
    const rows = await this._tick.model.riskControlTick.findMany({
      where: {
        date: {
          gte: dayBucket(args.from),
          ...(args.to ? { lte: dayBucket(args.to) } : {}),
        },
        ...(args.gate ? { gate: args.gate } : {}),
        ...(args.organizationId ? { organizationId: args.organizationId } : {}),
        ...(args.outcome ? { outcome: args.outcome } : {}),
      },
      orderBy: [{ date: 'desc' }, { quantity: 'desc' }],
    });
    return rows.map((r: any) => ({
      organizationId: r.organizationId,
      gate: r.gate,
      outcome: r.outcome,
      detail: r.detail,
      // BigInt does not survive JSON.stringify, and every caller here is an API
      // response or a log line.
      quantity: Number(r.quantity),
    }));
  }

  /** Per-gate totals over the window — the "is anyone hitting this" answer. */
  async totalsByGate(args: QueryArgs): Promise<Record<string, number>> {
    const rows = await this.query(args);
    return rows.reduce<Record<string, number>>((acc, r) => {
      acc[r.gate] = (acc[r.gate] ?? 0) + r.quantity;
      return acc;
    }, {});
  }

  /** Busiest orgs over the window — the "who" answer. */
  async topOrgs(
    args: QueryArgs & { limit?: number }
  ): Promise<{ organizationId: string; quantity: number }[]> {
    const rows = await this.query(args);
    const byOrg = rows.reduce<Record<string, number>>((acc, r) => {
      acc[r.organizationId] = (acc[r.organizationId] ?? 0) + r.quantity;
      return acc;
    }, {});
    return Object.entries(byOrg)
      .map(([organizationId, quantity]) => ({ organizationId, quantity }))
      .sort((a, b) => b.quantity - a.quantity)
      .slice(0, args.limit ?? 10);
  }
}
