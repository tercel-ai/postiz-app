// "There is probably scan work for this org" hint — the cheap fast-lane signal
// that closes the gap between a keyword landing in the DB and the extension
// actually scanning it.
//
// Why this exists. The extension is the scan executor and the backend has no
// push channel to it, so the ONLY way work gets picked up is the extension
// polling `/engage/scan-tasks/ingest`. That poll runs on a 15-min alarm, so a
// keyword created by (say) operation-plan generation could sit idle for a full
// period before its first scan — even though a brand-new keyword has no
// EngageScanCursor row and is therefore *immediately* due
// (see EngageScanLeaseService.claim: the cadence gate only bites once
// `lastScanStartedAt` is set). Nothing was due-blocked; nobody was knocking.
//
// The ingest endpoint is far too expensive to poll every minute — with no work
// to hand out it still walks every unit and issues ~2 queries each. So the
// extension polls THIS instead: one Redis GET. When it returns true the
// extension immediately drives the real (expensive) scan loop.
//
// Semantics, deliberately loose:
//   - This is a FAST LANE, never the source of truth. The 15-min alarm still
//     calls ingest unconditionally, so a dropped/missed hint costs latency, not
//     coverage. That is what lets everything below fail quiet.
//   - Every operation FAILS CLOSED (no hint) and is bounded by an explicit
//     timeout. See the note on REDIS_TIMEOUT_MS — this is the one property that
//     matters most here, and the reasoning is not obvious.
//   - Without REDIS_URL, ioRedis is a per-process in-memory mock; on a
//     multi-instance backend a hint set on one instance won't be seen by
//     another. Acceptable for the same reason — the backstop still fires.
//   - The TTL bounds a hint that is never consumed (e.g. the user's extension
//     is offline), so a stale flag can't pin an org to the fast lane forever.

import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';

const KEY_PREFIX = 'postiz:engage-scan-hint:';

// Slightly longer than the extension's 15-min backstop alarm: if the hint is
// still unconsumed by then, the unconditional tick has already covered the org
// and the flag has no further use.
const HINT_TTL_SECONDS = 20 * 60;

// Redis here is polled by every signed-in extension once a minute, so it must
// never be able to hang a request handler.
//
// This is not belt-and-braces. `ioRedis` is built with
// `maxRetriesPerRequest: null` and ioredis' default `enableOfflineQueue: true`
// (see redis.service.ts), which means a command issued while Redis is
// unreachable does NOT reject — it sits in the offline queue indefinitely. So
// a plain try/catch around an await would never fire; the probe would simply
// hang, one stuck handler per extension per minute. The timeout is what turns
// an outage into a fast, quiet "no hint".
const REDIS_TIMEOUT_MS = 250;

const key = (organizationId: string) => `${KEY_PREFIX}${organizationId}`;

// Distinguishes one marking from another so a clear can only retract the hint
// it actually observed (see clearEngageScanWork).
let tokenSeq = 0;
const nextToken = () => `${Date.now().toString(36)}.${(tokenSeq = (tokenSeq + 1) % 1e6)}`;

/**
 * Await `op`, giving up after REDIS_TIMEOUT_MS. Returns `fallback` on timeout OR
 * error — callers here have no recovery to do beyond falling back to the
 * unconditional backstop poll.
 */
async function bounded<T>(
  what: string,
  organizationId: string,
  op: () => Promise<T>,
  fallback: T
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    // The losing promise is never cancelled (ioredis has no cancel), so attach a
    // catch to keep a late rejection from surfacing as an unhandled rejection.
    const running = op();
    running.catch(() => undefined);
    return await Promise.race([
      running,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`redis timeout after ${REDIS_TIMEOUT_MS}ms`)),
          REDIS_TIMEOUT_MS
        );
      }),
    ]);
  } catch (err: any) {
    console.warn(
      `[engage-scan-hint] ${what} failed for org=${organizationId}: ${
        err?.message || err
      }`
    );
    return fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Flag that this org has (probably) scannable work pending — call right after
 * writing rows that create a new scan unit, i.e. a new keyword / monitored
 * channel / tracked account.
 *
 * Call AFTER the rows are committed. A hint raised inside an open transaction
 * can be consumed by a claim that cannot see the uncommitted rows yet, which
 * would find nothing and retract the hint (see clearEngageScanWork).
 *
 * Never throws: a failed hint only costs latency (the backstop poll still
 * covers the org), so it must not be able to fail the write that triggered it.
 */
export async function markEngageScanWork(
  organizationId: string
): Promise<void> {
  if (!organizationId) return;
  await bounded(
    'mark',
    organizationId,
    () => ioRedis.set(key(organizationId), nextToken(), 'EX', HINT_TTL_SECONDS),
    null as any
  );
}

/**
 * The current hint token, or null when there is none.
 *
 * FAILS CLOSED. Reporting "work" on a Redis failure looks tempting — it
 * degrades to asking the real endpoint — but it would have every extension
 * drive a FULL scan loop every 60s instead of every 15 min, i.e. ~15x the
 * engage scan load at exactly the moment the backend is already degraded.
 * Losing the fast lane costs latency and nothing else, so that is the safe
 * direction to fail in.
 */
export async function readEngageScanWork(
  organizationId: string
): Promise<string | null> {
  if (!organizationId) return null;
  // MockRedis returns undefined for a miss where ioredis returns null — treat
  // any nullish value as "no hint" rather than comparing against one of them.
  const hit = await bounded(
    'read',
    organizationId,
    () => ioRedis.get(key(organizationId)),
    null
  );
  return hit == null ? null : String(hit);
}

/** Boolean form of readEngageScanWork, for the extension's probe endpoint. */
export async function hasEngageScanWork(
  organizationId: string
): Promise<boolean> {
  return (await readEngageScanWork(organizationId)) !== null;
}

/**
 * Retract the hint — call once a claim attempt comes back with nothing to do,
 * so the org leaves the fast lane until new work is written.
 *
 * Pass the token read BEFORE the claim ran. A claim only proves "nothing was
 * due as of when I looked", so it must not retract a hint raised while it was
 * running — that hint is about rows it never saw, and dropping it would push
 * exactly the keyword this feature exists for back onto the 15-min backstop.
 * Comparing tokens narrows that window from the whole claim (~100ms of unit
 * walking) to the gap between the read and the delete below.
 *
 * Passing no token retracts unconditionally.
 */
export async function clearEngageScanWork(
  organizationId: string,
  expectedToken?: string | null
): Promise<void> {
  if (!organizationId) return;
  if (expectedToken !== undefined) {
    if (expectedToken === null) return; // nothing was set when we looked
    const current = await readEngageScanWork(organizationId);
    if (current !== expectedToken) return; // re-marked while we were claiming
  }
  await bounded(
    'clear',
    organizationId,
    () => ioRedis.del(key(organizationId)),
    null as any
  );
}
