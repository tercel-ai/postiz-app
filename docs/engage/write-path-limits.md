# Write-Path Limits — what bounds how much a subscriber can push in

**Status**: all five gaps closed. Two follow-ups are noted inline (§5.4 needs
`prisma db push`; drafts have no TTL, which the row cap bounds but does not
solve).

Every subscriber-facing write path in Postiz is one of three things: *governed*
(a real server-side bound), *metered* (a charge that blocks when the balance runs
out), or *open*. This document says which is which, so the next person to add a
write endpoint knows what it has to sit behind.

The motivating problem: engage scan ingest was **open**. `engage_scan_pacing`
carries numbers that bound a well-behaved client, but every one of them is
shipped *to* the extension as advice (`ScanTaskPacing`) and none was checked on
the way back in. A client that ignored its pacing — or was not the extension at
all — met no limit beyond a per-request array cap. Since
`engage_touch_switch: false` retired the Temporal scan, that path is the *only*
way engage data enters the system.

---

## 1. Coverage today

| Path | LLM cost | Rows | Metered | Rate-limited | Effective bound |
|---|:--:|:--:|---|---|---|
| `POST /engage/scan-tasks/ingest` | yes (intent) | yes | no | 300/h/user | **`engage_ingest_quota`** + array cap (500) |
| `POST /engage/scan-posts/ingest` | yes (intent) | yes | no | 300/h/user | **`engage_ingest_quota`** + array cap (200) |
| `POST /engage/opportunities/:id/draft` | yes | no (streamed) | **yes, up front** | 20/h/user | credit balance |
| engage reply send | no | yes | reply credits | — | monthly cap, per-poll cap, min gap, account daily cap, platform pacing |
| `POST /engage/opportunities/:id/save-draft` | no | upsert, 1/opportunity | no | no | opportunity count (natural) |
| `POST /engage/opportunities/:id/generate-post` | yes | yes | yes, **post-hoc on actual tokens** + pre-flight balance gate | 20/h/user | credit balance |
| `POST /posts/` type `schedule`/`now` | no | yes | overage, **post-hoc** | 300/h/user | ⚠️ subscription check only |
| `POST /posts/` type `draft` | no | yes | no (free by design) | 300/h/user | live-DRAFT row cap |
| `POST /posts/metrics/ingest` | no | updates only | no | no | array cap (100) |

The reply path is the model the others should follow:
`EngageEntitlementService.reserveReplyGeneration` checks the credit balance
*before* generating and writes the reservation *before* the work, so concurrent
requests see it and the cap holds even if the later charge fails.

---

## 2. The ingest ceiling (`engage_ingest_quota`)

`EngageIngestQuotaService.assertWithinQuota(orgId, records)` runs at the top of
both ingest controllers, before any parsing or persistence.

### Formula

```
limit(org) = max(BURST, PLAN) × scale

BURST = hourlyRequestCap × largest extension pageSize × sessionsAllowance
PLAN  = (keywordsMax + priorityAccountsMax) × platforms × largest pageSize
        × burstFactor ÷ scanIntervalHours
```

Every input is an admin-tunable setting; nothing here is a hardcoded number.

| Input | Source |
|---|---|
| `hourlyRequestCap`, largest `pageSize` | `engage_scan_pacing.extension` |
| `keywordsMax`, `priorityAccountsMax`, `scanIntervalHours` | the org's own `engage_entitlements` |
| platform count | `getSupportedScanPlatforms()` |
| `sessionsAllowance`, `burstFactor`, `scale` | `engage_ingest_quota` |

`hourlyRequestCap` counts **fetches (pages)**, not units and not ingest calls
(see `ScanTaskPacing`), so `cap × pageSize` is a true records/hour bound whatever
mix of initial (multi-page) and incremental (single-page) units the client is
working through.

**Why `max`, not `min`.** The two terms model different legitimate regimes and an
org can be in either: a small org bursts far above its own cadence while
backfilling a new project, and a maxed-out org sustains far above what one
browser session can push. Taking the minimum would reject one of those two
ordinary situations, and a refused batch costs real collected data — while taking
the maximum still turns "unbounded" into "bounded", which is the point.

A `null` (unlimited) cap makes PLAN incomputable — an unlimited input cannot
yield a finite rate — so it drops out and BURST stands alone, rather than the
ceiling silently becoming infinite.

### Behaviour

- **Counted on records SUBMITTED, not accepted.** Validation, TTL filtering,
  scoring, the LLM intent call and the per-subscriber fan-out write are all paid
  before anything is discarded, so charging only for survivors would make a batch
  of junk free.
- **The whole batch is refused** (429), never truncated: the extension advances
  its cursor only on a completed unit, so dropping the tail of a page would make
  it re-submit the same records forever instead of backing off.
- **Fails open** on a Redis outage, logged at `error`. Ingest is the only data
  path now that background scanning is off; a Redis incident must not stop every
  customer's collection, and the DTO array caps plus the route throttle still
  bound both a single request and the request rate. (`/scan-posts/ingest` took a
  bare `any[]` until it was given a DTO — until then this rationale was only
  true of the other route.)
- Weighted two-bucket sliding window (GET/INCRBY only). Check and increment are
  not atomic, so concurrent submissions can overshoot by up to
  `concurrency × batch size` — acceptable for a backstop.

### Route throttles

The `@Throttle` numbers are no longer literals in the decorators — they live in
the `api_rate_limits` settings key, one named bucket per route family, read
through `limitFor(bucket)` (a `Resolvable`, so the guard resolves it per request
and a change lands on the next call rather than the next deploy). The service
polls the row once a minute into a module-level cache; a `@Throttle` resolvable
gets only an ExecutionContext, so the value has to be somewhere a plain function
can reach, and a settings round trip per request would put the database on the
hot path of the thing meant to protect it.

Defaults: createPost 300/h, engageDraft 20/h, engageGeneratePost 20/h,
engageScan 5/h, engageTargetGone 30/h, engageAdminSync 5/h — all per user.
A junk or non-positive value falls back to that bucket's default: never to
unlimited, and never to 0, which would lock every caller out of the route. A
failed refresh keeps the last known values rather than snapping back to defaults,
so a transient settings outage cannot quietly widen a limit an admin tuned down.

Editable in aisee-manage under **配置管理 › Engage › 接口限流**.

### Tuning

Reach for **`scale`** first (default 1; below 1 tightens, above 1 loosens). It
moves the ceiling without touching an input the formula shares with something
else: `sessionsAllowance` and `burstFactor` each state a fact about the world,
and `engage_scan_pacing` is a contract shipped to the extension — editing either
to buy head-room makes both lie. `scale` is ignored for a pinned
`recordsPerHour`, which is already an exact number.

Editable in aisee-manage under **配置管理 › Engage › 入库配额**.

---

## 3. Reference numbers

Measured on a real growth-loop project (5 active keywords, 40 days) and
extrapolated to the plan caps:

| | records/hour |
|---|--:|
| observed, 5 keywords | ~8 |
| one browser session, incremental (interUnit 60s) | ~1,000 |
| one browser session, initial backfill (= `hourlyRequestCap`) | 3,000 |
| what growth-loop's own caps sustain on cadence (3,500 units × 25 ÷ 24h) | ~3,650 |
| BURST default (2 sessions) | 6,000 |
| PLAN, growth-loop at cap (= the row above × `burstFactor` 2) | ~7,291 |

PLAN sits above the sustained rate on purpose: that is `burstFactor`, the
head-room for a new project whose units all come due at once and for an org
catching up after being offline.

Real usage sits about two orders of magnitude below the ceiling, which is the
margin a backstop wants: it should never fire for an ordinary account.

---

## 3b. Checking whether these numbers are right

Every ceiling here was derived from a formula. A formula proves a bound is
finite; it does not say whether it sits 10x or 1000x above real usage — and a cap
nobody approaches bounds nothing in practice, while one people graze is an outage
waiting for a busy week.

**`scripts/analyze-write-limits.ts`** measures the gap. Read-only, defaults to the
last 30 days, `--json` for machine output:

```
npx tsx scripts/analyze-write-limits.ts --days=30
```

It prints p50 / p95 / max per org (and per project for drafts) against each
configured cap, with a verdict per path: TIGHT (< 2x — a busy week trips it),
snug, comfortable, or VERY LOOSE (> 1000x — nothing plausible reaches it). Caps
are resolved the way the runtime resolves them, per field, so a settings row
written before a field existed reports the default that is actually enforced
rather than "unlimited".

**`GET /admin/diagnostics/write-limits`** (folded into `/overview`) shows the same
question live: the busiest orgs and projects by live-DRAFT count, and any sitting
at ≥ 80% of their cap.

Both report HEAD-ROOM, not breaches, deliberately. A breach counter reads zero
whether a limit is perfectly tuned or absurdly high, so it cannot tell you a limit
is wrong until it has already refused someone; the distance between the busiest
account and the cap can, while there is still time to move it.

**Refusals actually served** are counted in `RiskControlTick`, a generic
`(day, org, gate, outcome, detail) → quantity` table written by every control:
the ingest quota, the draft cap, and the throttler guard's own 429 path. This is
the counterpart to head-room, not a duplicate of it — head-room says whether a
cap is set sanely, this says whether anyone met it, and for the ingest quota and
the throttles it is the ONLY signal, since both count in Redis under short TTLs
and leave no trace by the next day.

Counts, never events: a row per refusal would put its heaviest write load exactly
when the system is under the pressure these controls exist for, and nobody reads
refusal-by-refusal detail. `gate` / `outcome` / `detail` are free strings, so a
control added later needs a call site rather than a migration; `outcome` is
'rejected' everywhere today and exists so a control that also counts what it let
through can report a RATE, which a bare count cannot be read as.

`RiskControlTickService` owns both halves — `record`, plus `query` /
`totalsByGate` / `topOrgs`. `record` never throws: it runs inside a control that
has already decided to refuse, and failing telemetry must not turn a clean 4xx
into a 500. A failed write goes back in the buffer, so a database blip costs
latency rather than data.

**Writes are coalesced in memory and flushed every 10s**, and that is a
correctness requirement rather than an optimisation. `@nestjs/throttler` defaults
`blockDuration` to the throttler's `ttl` — one hour here — and the storage
reports `isBlocked` for EVERY request until the block expires. A caller that
crosses its limit therefore produces one refusal per request for the rest of the
hour, and every one of them keys to the SAME row (same org, same route, same
day). Writing per refusal would put a serialised single-row upsert storm on the
path whose entire job is to shed that load: at 100 req/s that is ~360k writes on
one row. Buffered, it is ~360. Reads flush first, so a diagnostics call made
during an incident still sees the newest counts, and the day bucket is fixed when
the refusal happens, so a flush across midnight cannot move a count into the
wrong day. `/admin/diagnostics/write-limits` reports yesterday's refusals by
gate and by org, and a refusal counts against `healthy` even when nothing is near
a cap.

**Requires `pnpm run prisma-db-push`** for the `RiskControlTick` table.

---

## 4. Related invariants

An org-wide entitlement cap must be **>=** its per-project counterpart. Both are
enforced on activation and the effective head-room is
`min(org remaining, project remaining)`, so an org cap below the project one makes
the project cap unreachable and the plan grants less than its pricing page
advertises. `EngageEntitlementService.onModuleInit` warns (never throws — a
mistuned cap is over-restrictive, not dangerous, and refusing to boot over a
settings typo turns a bad limit into an outage).

The same `onModuleInit` backfills plan codes a stored settings row predates.
Testing only whether the KEY exists is right for a flat value and wrong for a map
keyed by plan: `engage_entitlements` was written when starter/developer/pro were
the only codes, so `growth-loop` could never reach the table — and since the
admin UI renders the STORED object, it listed three unsellable tiers and hid the
only one being sold. `post_plan_limits` had the identical bug.

---

## 5. Open gaps

### 5.1 `POST /posts/` type `draft` — unbounded and free — **DONE**

`PostsRepository.countPostsFromDay` counts only `QUEUE` and `PUBLISHED`, so a
DRAFT never moves the number `PostOverageService.deductIfOverage` tests against.
With no `@Throttle` on the posts controller and no `@ArrayMaxSize` on
`CreatePostDto.posts`, draft creation was free, unrated and batchable at once.

Billing was the wrong fix — a free scratchpad is the intended product semantics
— so drafts got the bounds they were missing instead:

- **Row cap.** `post_plan_limits` gains `draftsPerPlatformMax` (org) and
  `draftsPerPlatformPerProjectMax` (project), both **per platform** for the same
  reason `priorityAccountsMax` is: a draft budget is spent per surface, and a
  flat total would mean adding a platform silently cut every other platform's
  share. The effective ceiling is the per-platform number × the size of
  `operation_plan.allowed_platforms` — the POST-domain allowlist, because a plan
  generates drafts for exactly those platforms. Default 500/platform/project
  (8 platforms → 4,000) and 5,000/platform org-wide (→ 40,000), the same 10×
  org:project ratio the engage caps use.
- **Route throttle.** `@Throttle({ limit: 300, ttl: 1h })`, generous because
  this is the editor's save path.
- **Array cap.** `@ArrayMaxSize(100)` on `CreatePostDto.posts`.

The count is of LIVE drafts (`deletedAt: null`, roots only). That is the point of
the query, not a detail: re-running an operation plan soft-deletes the previous
run's drafts, so counting deleted rows would let a project that merely refreshes
its plan each month fill its own quota with rows nobody can see. It is also why
500/platform is comfortable — plan drafts do not stack run over run, and an
expired plan's drafts stay committable to the queue rather than stranding.

Checked once per batch before anything is written; a partially-admitted batch
would leave the caller unable to tell which of its posts landed.

### 5.2 `generate-post` — free at a zero balance — **DONE**

This path was always billed — `_billReferencePostUsages` → `billCollectedUsages`
charges actual token usage, and it charges even for a failed generation whose
attempts consumed tokens. What it lacked was a gate BEFORE the work:
`billCollectedUsages` does no balance check by contract (the work is already
done) and its failure is caught and logged, so an org at zero could generate
indefinitely — every call ran the model, persisted a draft, and dropped its
charge into a logged branch.

`EngageService.generateReferencePost` now asserts a positive balance before
generating, mirroring `reserveReplyGeneration`'s first step, and the controller
surfaces the block as its own SSE frame (`engage_insufficient_credits`) rather
than the generic `generation_failed`.

Unlike a reply it asserts only that the balance is **positive**, not that it
covers the bill: the cost is per-token and a similarity retry can multiply it, so
it is not knowable up front. That closes "free forever at zero" without
pretending to price the call. `hasCredits()` returns true when billing is
disabled, so a self-hosted install is unaffected.

### 5.3 Throttling is per-replica — **DONE**

`ThrottlerModule` now takes a Redis-backed `ThrottlerStorage`
(`RedisThrottlerStorage`, `libraries/nestjs-libraries/src/throttler/`), so every
`@Throttle` counts once per org/user rather than once per replica. Before this,
a route documented as "20 per user per hour" allowed 20 × however many pods were
running, and the real number moved whenever the deployment scaled.

- One Lua round trip counts the hit and decides the block, so N replicas cannot
  each read the same under-limit count and all admit.
- **Fails open** on a Redis outage (logged at `error`): the guard throws only on
  `isBlocked`, so an unblocked zero-hit record admits the request. An hour of
  unthrottled traffic is recoverable; 500-ing every throttled route is not.
- `createThrottlerStorage()` returns `undefined` without `REDIS_URL`, which is
  meaningful — the package's provider then falls back to its in-memory default,
  correct for a single-process self-hosted install with nothing to share.

### 5.4 Ingest lease is not bound to its claimer — **DONE**

`EngageScanCursor.claimedByOrgId` now records who holds the lease, and every
token-path operation matches on it: `findScanCursorByToken`, `completeByToken`,
`releaseByToken`, and the `POST /engage/scan-tasks/release` debug endpoint.

The unit itself stays **global and shared** — one fetch still fans out to every
subscribing org, which is the design. What changed is the right to COMPLETE it.
The lease token was previously the sole credential, so any authenticated org
holding one could submit posts that the backend then scored, classified and
persisted for every *other* subscriber of that unit.

- The server-side workflow path claims with no org (`claimedByOrgId: null`) and
  finishes by row id, so it never touches the token path and is unaffected.
- The owner is written on every claim, including that null — a previous
  claimant's org left behind would otherwise decide who may complete the next
  lease — and cleared everywhere the lease is dropped.
- A stale/forged token, a reclaimed lease and someone else's lease are
  deliberately indistinguishable to the caller; saying "that one is not yours"
  would confirm a guessed token names a real unit.
- **Requires `pnpm run prisma-db-push`.** Until it runs, leases claimed before
  the column existed carry null and cannot be completed by token; they expire on
  the 5-minute lease TTL and are reclaimed. That is the whole migration cost.
