# Extension Demand-Driven Data Fetch — design & changelog

Moves data fetching from the backend Temporal workflow toward the **browser
extension**, which uses the user's own logged-in session to bypass the Reddit
WAF and the X API tier limits that block server-side fetching.

**Responsibility split:** the **backend is the scheduler** (decides *what* is due,
scores, persists, enforces limits) and a current/fallback **executor**; the
**extension is the executor** (decides *how* to fetch — it builds the platform
request and normalises the response). The backend never ships URLs and never
parses raw platform JSON.

Two independent tracks share the same "server-authoritative due gate, executor is
pluggable" shape:

- **Track A — Post metrics** (own posts + engage replies).
- **Track B — Engage opportunity scan** (keywords / subreddits / tracked accounts).

All three channels (extension · scheduled workflow · future frontend-triggered
workflow) feed the same gate, so they coexist and dedup automatically.

---

## Track A — Post metrics (demand-driven, view-scoped)

The extension fetches metrics only for posts the user is **viewing**, governed by
a per-post interval so already-fetched data is not re-pulled.

### Window resolution (per-plan, user-overridable)
`effective = min(userOverride ?? planMax, planMax)`, clamped at READ time.
- Plan ceilings live in the `engage_entitlements` Settings key (admin-tunable):
  `metricsWindowDaysMax` = **starter 7 / developer 14 / pro 30** (self-hosted 30).
- User override stored in `Organization.data.metricsWindowDays`.
- Per-plan fetch interval `metricsFetchIntervalHours` = starter 24 / developer 12 / pro 6.

### Flow
```
user opens posts page → extension sends visible post ids
  POST /posts/metrics/due      → { windowDays, intervalHours, due[] }   (within window ∩ past interval)
  extension fetches metrics with the browser session
  POST /posts/metrics/backfill → { updated[], stamped[] }              (same extract/traffic pipeline as checkPostAnalytics)
```
Backfill resolves each post's platform server-side (never trusting the client),
reuses `extractMetrics` + `batchUpdatePostAnalytics`, and stamps
`Post.lastMetricsFetchAt` (the dedup gate; stamped even for zero-metric posts).

---

## Track B — Engage opportunity scan (extension as dumb executor)

The backend hands the extension a **semantic instruction** (what unit to scan);
the extension fetches with the session and returns **normalised `RawPost[]`**; the
backend scores + persists.

### Single endpoint — chained scan loop
```
POST /engage/scan-tasks/ingest  { completed?, want? } → { accepted, nextTasks }

bootstrap (no completed) → claim next batch
continuation (completed) → token-validate + persist + advance cursor, then claim next batch
nextTasks empty           → nothing due; extension idles
```
- **Global scan units** keyed `(platform, scanType, scanKey)` on `EngageScanCursor`
  (org-independent). keyword → normalised keyword; channel → subreddit; tracked → username.
  One fetch fans out to **every subscribing org** (cross-org dedup).
- **Lease (CAS + stale-reclaim)**: claim is one atomic compare-and-swap; a unit
  stuck `SCANNING` past the 5-min TTL is reclaimable (the async browser may vanish).
- **Session-bound `leaseToken` = the client's `taskId`**: backend-generated, rotates
  each claim, cleared on complete. The client never sees the cursor id; a
  stale/forged/rotated token completes nothing.
- **Server-derived cursor**: the resume point is computed from the returned posts'
  newest publish time, never trusting a client-sent cursor (can't skip real data).
- **channel/tracked** are fetched as a keyword-free "scope firehose"; keyword
  matching happens **server-side at ingest** (so other orgs' keywords never reach a
  client).

### Pacing (`engage_scan_pacing` Settings key, admin-tunable)
Split by **path × platform × phase** because the extension uses a personal
session (a flagged account is catastrophic) while the workflow uses tokens/proxy:

| | maxPages | pageDelay + jitter | inter-unit | session cap |
|---|---|---|---|---|
| workflow x / reddit | 5 / 5 | 0.3s / 1.2s (+0.3/0.6s) | — | — |
| **extension** x / reddit | **3 / 3** (incr 1) | **8s / 5s (+~60s)** | 60s (+60s) | 60/hr |

Workflow pacing is wired into the X/Reddit adapter pagination loops
(`applyPageDelay`); extension pacing is delivered to the client in each task.

### Back-attribution (cross-org "initial")
`EngageScanTasksService.backfillFromExisting(orgId)` re-scores recent EXISTING
global opportunities against an org's current keywords/scope and writes only the
per-org state (no fetch, no global re-write) — so a newly-subscribing org sees
opportunities other orgs already populated. The deep historical lookback for a
globally-new keyword is handled by the extension `initial` phase on a fresh
cursor.

---

## New HTTP endpoints

| Method · Path | Purpose |
|---|---|
| `GET /settings/metrics-window` | resolved window: `{ effective, max, override }` |
| `POST /settings/metrics-window` | set the org's window override (ADMIN) |
| `POST /posts/metrics/due` | due posts for the viewed ids |
| `POST /posts/metrics/backfill` | extension writes back metrics |
| `POST /engage/scan-tasks/ingest` | extension scan loop (ingest + claim next) |
| `GET /admin/settings/engage-initial-scan-budget` | now also returns `pacing` |
| `PUT /admin/settings/engage_scan_pacing` | edit pacing (generic settings CRUD) |

## Schema changes (require `prisma db push`)

- `Organization.data Json?` — bucket for org-level user settings (metrics window).
- `Post.lastMetricsFetchAt DateTime?` + indexes `[organizationId, state, publishDate]`, `[lastMetricsFetchAt]`.
- `EngageScanCursor.leaseToken String?` + index `[leaseToken]`.

## Settings keys

- `engage_entitlements` — added `metricsWindowDaysMax`, `metricsFetchIntervalHours` per plan.
- `engage_scan_pacing` — **new**; full pacing config (seeded with defaults).

## New services (all in `DatabaseModule`, `@Global`)

| Service | Role |
|---|---|
| `EngageScanConfigService` | seed + resolve `engage_scan_pacing` |
| `EngageScanLeaseService` | CAS claim + stale-reclaim + `leaseToken` complete/release |
| `EngageScanIngestService` | score → two-table persist → hit counts; `ingestForOrg`; `attributeExisting` (shared by workflow + extension) |
| `EngageScanTasksService` | scan loop orchestration (claim next + ingest completed) + `backfillFromExisting` |

`EngageEntitlementService` gained the metrics window/interval resolution and the
`Organization.data` override.

---

## Files

**New** — services: `engage-scan-config.service.ts`, `engage-scan-lease.service.ts`,
`engage-scan-ingest.service.ts`, `engage-scan-tasks.service.ts`; scan:
`scan/scan-task.types.ts`, `scan/scan-pacing.ts`; DTOs: `dtos/posts/metrics-due.dto.ts`,
`dtos/posts/metrics-backfill.dto.ts`, `dtos/settings/metrics-window.dto.ts`,
`dtos/engage/scan-ingest.dto.ts`; script:
`scripts/backfill-engage-opportunity-states.ts`; docs:
`docs/engage/frontend-triggered-workflow-todo.md`, this file.

**Modified** — `schema.prisma`; `engage-entitlement.service.ts`;
`posts.repository.ts` / `posts.service.ts` (due + backfill + provider lookup);
`engage.repository.ts` (`getEnabledOrgContext`, `findScanCursorByToken`,
`getOrgContextsForUnit`, `getRecentGlobalOpportunities`); `database.module.ts`
(4 services); adapters `platform-scan-adapter.ts` / `x-scan-adapter.ts` /
`reddit-scan-adapter.ts` (pacing); `engage-scan.activity.ts` (pacing + delegate
persist to `EngageScanIngestService`); controllers `settings.controller.ts`,
`posts.controller.ts`, `admin-settings.controller.ts`, `engage.controller.ts`.

## Tests

**94 passed** across 8 specs — entitlement 33 · scan-lease 15 · scan-ingest 14 ·
scan-config 8 · posts.dueMetrics 8 · scan-pacing 6 · scan-ingest.dto 5 ·
scan-tasks 5. The workflow `engage-persist` spec still passes, confirming the
persist extraction preserved behavior.

> A `tsc` run on `nestjs-libraries` reports pre-existing `TS7018` errors on
> untouched files (a Prisma-client regen artifact); 0 errors in the files this
> work touched.

---

## Operational notes & remaining work

1. **`prisma db push`** for the three new columns before deploying / running the script.
2. **Old users**: run `scripts/backfill-engage-opportunity-states.ts` (dry-run then `--execute`).
3. **Endpoint wiring (optional, not done)**: call `backfillFromExisting(orgId)`
   (fire-and-forget) after `setup` / keyword·channel·tracked add for instant
   populate-on-add. Backend-only; **no UI change**.
4. **Frontend-triggered workflow** (fallback when no extension): deferred — see
   `docs/engage/frontend-triggered-workflow-todo.md`.
5. **Extension-side implementation** — ✅ **DONE** (see below). Builds X internal
   GraphQL / Reddit `.json` requests with the user's session, normalises to the
   ingest shape, honors pacing, and drives both loops.

---

## Extension executor (apps/extension)

The executor lives in `apps/extension/src/utils/executor/` and runs in the
service worker. The backend stays the scheduler; this is the "how to fetch" half.

| File | Role |
|---|---|
| `executor.types.ts` | client mirrors of the backend contracts (scan task / ingest / due / backfill) |
| `api.ts` | authed backend call (`getValidAccessToken` + `fetchRequestUtil`) |
| `pacing.ts` | jittered delays + persisted rolling-hour request cap |
| `scan.reddit.ts` | Reddit scan via session `.json` (keyword=`/search.json`, channel=`/r/<sub>/new.json` firehose) |
| `scan.x.ts` + `x.graphql.ts` + `x.parse.ts` | X scan via internal GraphQL `SearchTimeline` (bearer + `ct0`) |
| `scan.runner.ts` | drives the `/engage/scan-tasks/ingest` chained loop (one unit per round-trip, `want:1`) |
| `metrics.reddit.ts` / `metrics.x.ts` | per-post live metrics → `AnalyticsData` (labels match `traffic.calculator`) |
| `metrics.runner.ts` | drives `/posts/metrics/due` → fetch → `/posts/metrics/backfill` |
| `scheduler.ts` | periodic `chrome.alarms` scan (15 min), armed on login / cleared on logout |

**Triggers**
- **Automatic**: the `aisee-engage-scan` alarm (15 min) drives Track B whenever a
  session exists. Armed on popup login, website session bootstrap, and SW startup.
- **Manual** (SW or popup console — for debugging without waiting for the alarm):
  ```js
  chrome.runtime.sendMessage({ action: 'engage:scan' })                       // Track B
  chrome.runtime.sendMessage({ action: 'engage:metrics', ids: ['<postId>'] }) // Track A
  ```
  Both resolve to `{ ok, summary }`.

**X is best-effort**: the internal GraphQL `queryId`s + feature flags in
`x.graphql.ts` are undocumented and X rotates them — a stale value returns
404/400 and the X path logs + yields empty *without breaking* Reddit or the loop.
Update `X_QUERIES` / `X_SEARCH_FEATURES` when X changes them. Reddit is reliable
(session clears the WAF).

**Track A still needs an id source for autonomous runs**: the alarm only drives
the scan; metrics is view-scoped, so it runs from explicit ids (the manual
trigger today; a frontend page push — the deferred option below — would feed it
the visible post ids automatically).

### TODO — frontend-page-driven metrics push (deferred)

Goal: when a user views a posts/engage page, the page tells the extension which
post ids are on screen so Track A runs hands-free (no manual console, no alarm
id-guessing). Mechanism: page → `bridge.ts` content script → `runtime.sendMessage`
`{ action: 'engage:metrics', ids }` (the SW handler already exists).

Not trivial — open questions to settle before building:
- **Which surfaces push?** engage signal-feed, the posts list, the dashboard —
  each has a different id source and lifecycle. Both frontends (apps/frontend +
  aisee-agent) need wiring.
- **Which ids?** Postiz internal `Post.id` (the page already has these), NOT
  platform ids. Cap 100 per `/metrics/due` call.
- **Visible vs loaded?** IntersectionObserver for truly-visible rows vs the whole
  page; how to handle infinite scroll / pagination without re-pushing everything.
- **Throttle/dedup**: debounce scroll, dedup ids, and avoid re-firing for posts
  already fetched this view (backend interval gate is the backstop, but don't
  spam `/due`).
- **Gating**: only push when `useExtensionDetected()` is true AND logged in;
  otherwise fall back to the server workflow (deferred — see
  `frontend-triggered-workflow-todo.md`).
- **Protocol**: reuse the `EXTENSION_MESSAGE` brand/handshake; add a page→ext
  message kind rather than ad-hoc strings, and decide if the page wants a
  result/ack back (e.g. to show "metrics refreshed").
- **Trigger timing**: on mount, on tab focus/visibility regain, on page change —
  mirror the patterns already in `use-extension-detected.ts`.

## Related
- `docs/engage/tech-design.md` — scan architecture, `EngageScanCursor`.
- `docs/engage/scripts.md` — engage operational scripts.
- `docs/engage/reddit-loid-waf-bypass.md` — why the WAF needs a session/loid.
