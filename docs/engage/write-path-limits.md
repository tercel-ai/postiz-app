# Write-Path Limits — what bounds how much a subscriber can push in

**Status**: ingest ceiling, shared throttler storage and the reference-post
credit gate implemented; two gaps open (see §5).

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
| `POST /engage/scan-tasks/ingest` | yes (intent) | yes | no | no | **`engage_ingest_quota`** |
| `POST /engage/scan-posts/ingest` | yes (intent) | yes | no | no | **`engage_ingest_quota`** |
| `POST /engage/opportunities/:id/draft` | yes | no (streamed) | **yes, up front** | 20/h/user | credit balance |
| engage reply send | no | yes | reply credits | — | monthly cap, per-poll cap, min gap, account daily cap, platform pacing |
| `POST /engage/opportunities/:id/save-draft` | no | upsert, 1/opportunity | no | no | opportunity count (natural) |
| `POST /engage/opportunities/:id/generate-post` | yes | yes | yes, **post-hoc on actual tokens** + pre-flight balance gate | 20/h/user | credit balance |
| `POST /posts/` type `schedule`/`now` | no | yes | overage, **post-hoc** | no | ⚠️ subscription check only |
| `POST /posts/` type `draft` | no | yes | **no** | no | ⚠️ **none** |
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
  customer's collection, and the DTO array caps still bound one request.
- Weighted two-bucket sliding window (GET/INCRBY only). Check and increment are
  not atomic, so concurrent submissions can overshoot by up to
  `concurrency × batch size` — acceptable for a backstop.

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

### 5.1 `POST /posts/` type `draft` — unbounded and free

`PostsRepository.countPostsFromDay` counts only `QUEUE` and `PUBLISHED`, so a
DRAFT never moves the number `PostOverageService.deductIfOverage` tests against.
Combined with no `@Throttle` on the posts controller and no `@ArrayMaxSize` on
`CreatePostDto.posts`, draft creation is free, unrated and batchable.

Billing is the wrong fix — free drafts are the intended product semantics.
The bounds it needs are a **row cap** (per org and per project, mirroring
`keywordsMax` / `keywordsPerProjectMax`), a route throttle, and an array cap.
*Open decision: what the draft row cap should be.*

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

### 5.4 Ingest lease is not bound to its claimer

`ingestCompleted` takes no `orgId` and `EngageScanCursor` has no
`claimedByOrgId`, while `getOrgContextsForUnit` fans the submitted posts out to
**every** subscribing org. One client's batch therefore writes rows and runs
intent classification for other tenants. The quota above charges the submitter,
which bounds the blast radius but does not close the cross-tenant path.
