# Frontend-Triggered Workflow Scan & Metrics (TODO / next step)

> **⚠️ NOTE (2026-06-22): Extension X (Twitter) path SUSPENDED.**
> The extension's X executor is paused due to account rate-limiting / temp-restriction
> (see `extension-demand-driven-fetch.md`). This frontend→workflow channel is a
> **server-side** fallback (OAuth `checkPostAnalytics` / loid-proxy / TokenPool), so
> it never relied on the extension's X session anyway — but it also cannot bypass the
> X free-tier limit. Scope this work to **Reddit + OAuth-reachable metrics** for now.

> **⚠️ UPDATE (2026-06-23): scan and metrics are now SPLIT into two endpoints.**
> `POST /engage/refresh-on-visit` is **scan-only**. Metrics moved to a dedicated
> event-driven endpoint `POST /engage/sent/metrics/refresh` to which the client
> sends the **exact post ids it is showing** (any sort/filter/page) — the server
> no longer guesses "page 1". The daily background resync is now **opt-in** behind
> the `engage_periodic_metrics_enabled` setting (default OFF — "no views → no
> update"). The removed symbols below (`getRecentSentForRefresh`,
> `engageMetricsSyncWorkflow`) no longer exist. See the rewritten "Implementation"
> section. Canonical: [[engage-event-driven-metrics]].

**Status:** Implemented — backend `POST /engage/refresh-on-visit` (scan) + `POST /engage/sent/metrics/refresh` (metrics) + both frontends (apps/frontend per-page hook + sent-list metrics hook, aisee-agent site-wide handler).
**Scope:** opportunity scanning *and* own-post metrics fetching (now via separate endpoints).
**Depends on:** the demand-driven "due gate" (`lastMetricsFetchAt` for metrics; `EngageScanCursor` cadence for scan).

## Idea

Add a third trigger channel for data refresh: **the frontend page navigation
triggers the existing Temporal workflow to run on-demand for that org**, instead
of waiting for the scheduled tick.

When a user opens a relevant page (opportunities list, posts/dashboard), the
frontend fires a lightweight "refresh my due units now" signal; the backend
enqueues / kicks the **existing workflow** to process that org's *due* units
immediately. Nothing about the scan/metrics rules, scoring, or persistence
changes — only *when* the workflow runs.

This is primarily a **fallback for users without the browser extension**, and is
fine to run **simultaneously** with the extension and the scheduled workflow
because all three share the same due gate (see below).

## Concrete requirement — page-visit trigger (the primary case)

**On every visit to the Engage site the frontend fires one lightweight,
fire-and-forget trigger. The backend's existing due gate decides whether anything
actually runs.** The frontend never decides "is this due / is this the first
time" — it *always* fires; the gate is the single source of truth for cadence.

### What the trigger covers (one org, server-side executor)
1. **Scan** — the org's active scan units: **keywords, tracked accounts,
   monitored channels**. Resolve the *due* subset via `EngageScanCursor` cadence
   (bucketed by the org's subscription-plan refresh frequency) and kick the
   existing scan workflow for those units only.
2. **Metrics** — the posts on **page 1 of `/engage/sent`**. The backend resolves
   that first page itself (it owns the query), takes the `Post.id`s, filters to
   the *due* subset via `getDueMetricsPosts` (`lastMetricsFetchAt` + per-plan
   `metricsFetchIntervalHours`), and fetches those via `checkPostAnalytics`.

### Trigger ≠ execute: timing stays with the existing workflow
The visit only *requests* "process my due units now". *When* a unit actually runs
is unchanged — still governed by bucketing + per-plan update frequency. The
trigger just collapses the wait from "next cron tick" to "now, if due".

### Why this satisfies both visitor patterns automatically
This falls straight out of the due gate — no special-casing per user:

| Visitor | What happens |
| --- | --- |
| **First-ever visit** (cold org, never scanned) | every unit's last-run is `null` → all due → **initial scan + metrics fire immediately**. The "首次扫描" case and the main value: empty feed → populated on first visit. |
| **Once-a-week visitor** | everything is far past its interval → **all due → runs immediately** on entry. |
| **Several-times-a-day visitor** | first visit runs due units and stamps last-run; later visits within the interval find **nothing due → no-op**. So *not every visit triggers real work*, even though every visit fires the trigger. |

The frequent-visitor throttle and the infrequent-visitor "always fresh on entry"
are the *same* mechanism (the interval gate), not two code paths.

### Cold-start (first scan) — the one special case worth flagging
A cold org's feed is empty, so the first run should feel instant:
- The trigger response returns `{ coldStart: true }` so the UI can show
  "building your feed…" and auto-refresh when results land.
- The first run **skips pacing jitter / long inter-request delays** (still bounded
  by the rolling-hour cap) so the user sees opportunities fast.
- After the first run stamps the cursors, the org rejoins the normal cadence.

### Endpoint shape
`POST /engage/refresh-on-visit` (org from session, fire-and-forget):
1. **Per-org debounce / rate-limit** — if a trigger landed < `N` min ago, skip the
   work but still return the cached `nextRefreshAt` (see below). Cheap backstop on
   top of the gate; stops multi-tab / refresh spam before it reaches the workflow.
2. Else enqueue a **detached background task**:
   - scan: due units (keywords / tracked / channels) → existing scan workflow (CAS lease).
   - metrics: page-1 `/engage/sent` post ids → `getDueMetricsPosts` → `checkPostAnalytics`.
3. Return immediately — **never block page load** — with:
   ```jsonc
   202 {
     "status": "accepted" | "throttled", // throttled = nothing due / within debounce
     "coldStart": false,
     "nextRefreshAt": "2026-06-22T09:30:00Z" // earliest visit that could do real work
   }
   ```

Internally it reuses existing server primitives (no new fetch path): the scan
ticker signal and the per-reply metrics-sync workflow — see below.

## Implementation (backend, landed)

**Two endpoints** (scan and metrics split, see the 2026-06-23 update banner above).

### Scan — `POST /engage/refresh-on-visit` → `EngageService.refreshOnVisit(org)`
Trigger-only; reuses existing primitives rather than a new server fetch path:

- Reads the per-unit due gate via `EngageRepository.getOrgScanStatus` (derives
  `nextScanAt` = min next-due across keyword / channel / tracked cursors, bucketed
  by plan cadence). If anything is due it signals the existing `engage-scan-ticker`
  (`triggerImmediateScan`), debounced per org in-memory by the floor window so
  rapid multi-tab visits don't spam the ticker.
- **`coldStart`** = `getOrgScanStatus().lastScanAt == null` (no cursors → empty feed).
- **`nextRefreshAt`** = `max( scanNextDue, now + floor )`. Floor =
  `ENGAGE_REFRESH_FLOOR_SECONDS` (default 60s).
- **`status`** = `accepted` when scan was due, else `throttled`.

### Metrics — `POST /engage/sent/metrics/refresh` → `EngageService.refreshMetricsForPosts(org, postIds)`
Event-driven: the client sends the exact post ids it is showing (`RefreshMetricsDto`,
1–100). The server fetches those replies via `EngageRepository.findEngageRepliesByPostIds`
(org-scoped, PUBLISHED, releaseURL non-null), gates each by the monitoring window +
`metricsFetchIntervalHours` (`Post.lastMetricsFetchAt`), **optimistically stamps**
`markMetricsFetched` **before** a fire-and-forget in-process fetch
(`_runMetricsSyncForReplies` → `dispatchReplyMetricsSync` → `syncRedditMetrics`/`syncXMetrics`).
Returns `{ accepted, throttled, nextRefreshAt }`; the client polls `GET /sent/:id/status`
for the accepted ids (or re-reads the list). This is the ONLY metrics path when
periodic refresh is disabled (the default).

### Optional periodic background refresh
The daily `engageDataTicksWorkflow` is gated on the `engage_periodic_metrics_enabled`
setting (admin-configurable, default OFF), read each cycle via the fail-closed
`EngageDataTicksActivity.isPeriodicMetricsEnabled()` activity. When disabled the whole
resync+aggregate body is skipped (the workflow just `continueAsNew`s).

Tests: `engage-refresh-on-visit.spec.ts` (scan-only refreshOnVisit + refreshMetricsForPosts
gating), `dispatch-reply-metrics-sync.spec.ts` (platform routing), and
`engage-periodic-metrics-toggle.spec.ts` (fail-closed toggle).
Cold-start pacing expedite (skip jitter on the first run) is NOT yet wired — the
trigger makes the first scan run *now*, but it runs at normal pacing.

### Frontend (apps/frontend, landed)

- **Hook** `useEngageVisitRefresh(orgId, { onAccepted })` —
  `components/engage/signal-feed/use-engage-visit-refresh.ts`. On mount + tab
  `focus`/`visibilitychange`, POSTs `/engage/refresh-on-visit` ONLY when the cached
  `nextRefreshAt` (localStorage `engage:nextRefreshAt:<orgId>`) has passed; updates
  the cache from the response; `inFlight` guard + `onAccepted` in a ref so it never
  blocks render or re-arms listeners. Mirrors the `use-extension-detected.ts` shape.
- **Wiring** — `SignalFeed` calls it with `config.organizationId`; `onAccepted`
  revalidates the feed (immediate `mutate()` + a few delayed re-reads so a cold/
  first feed fills in). Empty state shows "Building your feed…" when `coldStart`.
- **Cache invalidation** — `invalidateEngageRefresh(orgId?)` (clears one org, or
  ALL engage gate keys when called with no arg) is invoked from the keyword /
  tracked-account / monitored-channel managers' add + enable/disable handlers, so
  a newly-added unit re-triggers on the next `/engage` visit instead of being
  suppressed by a stale timestamp.
- Tests: `use-engage-visit-refresh.spec.ts` (keyed vs clear-all invalidation).

### Frontend (aisee-agent, landed — site-wide, NOT a per-page hook)

aisee-agent surfaces Engage data across the **post dashboard**, not only a single
`/engage` feed, so the trigger is wired app-wide rather than into one component:

- **Shared lib** `lib/engage-visit-refresh.ts` — `maybeTriggerEngageVisitRefresh(userId)`
  (gate-checks the cached `nextRefreshAt`, then `http.post('/engage/refresh-on-visit',
  …, { apiType: 'post-agent' })`; module-level `inFlight` guard) +
  `invalidateEngageVisitRefresh(userId?)`. Cache keyed by `userInfo.id`.
- **Global handler** `app/_providers/engage-visit-refresh.tsx` —
  `EngageVisitRefreshHandler` (renders null), mounted once in `MainProvider`
  (root `app/layout.tsx`, wraps the whole app). Re-checks on every route change
  (`usePathname`) + tab focus/visibility. Logged-out (`!userInfo.id`) → no-op.
- **Cache invalidation** — folded into `engageApi` create/patch for keyword /
  channel / tracked (`withInvalidate` in `(engage)/_lib/api.ts`), so a new unit
  re-triggers on the next navigation. (No SWR here, so no auto feed revalidate —
  the dashboard refetches on its own navigation.)

**Remaining:** cold-start pacing expedite (skip jitter on the first scan).

### `nextRefreshAt` — server tells the client when to bother again
The point: **the client caches `nextRefreshAt` per org and does NOT call the
endpoint again until that time passes.** No fixed client-side guess — the server,
which owns the cadence, hands back the next meaningful moment, so a frequent
visitor's later visits short-circuit *without even a round-trip*.

- **Value** = the soonest a future visit could find *anything* due =
  `min(` next-due across the org's scan cursors (keyword / tracked / channel
  cadence) `,` `min(lastMetricsFetchAt) + metricsFetchIntervalHours` over the
  page-1 `/engage/sent` posts `)`. After a run this collapses to roughly
  `now + shortest applicable interval`.
- **Floor it** to the per-org debounce window `N` so a misconfigured 0-interval
  plan can't invite hammering.
- **Cache invalidation** — `nextRefreshAt` governs only the *automatic* visit
  trigger. When the user **mutates scan units** (adds a keyword / tracked account /
  monitored channel) or explicitly hits "refresh", the client **drops the cached
  value and fires immediately**; those new units are due now and must not be
  suppressed by a stale timestamp.
- **Cold start** returns a near-future `nextRefreshAt` (the run is happening now);
  the UI polls / refreshes until results land rather than waiting for it.

### Frontend wiring
- Fire on **mount of an Engage surface** and on **tab focus / visibility regain**
  (mirror `use-extension-detected.ts`), but **only if `now >= cached nextRefreshAt`**
  for the org (cached in local/session storage). Otherwise skip the call entirely —
  the server already told us nothing will be due. Update the cache from every response.
- Show cached data immediately; re-read the feed after a short delay or poll a
  lightweight status / count until new rows appear (cold start especially).
- **Extension precedence**: if `useExtensionDetected()` is true, the frontend
  trigger can stand down — the extension (browser session) has strictly better
  coverage and the due gate already prevents double-fetch.

### Concurrency & cost
- Multiple tabs / devices for one org: the scan **CAS lease** + metrics
  `lastMetricsFetchAt` stamping make the first writer win; the rest no-op.
- Server tokens / proxy usage scale with *active distinct orgs*, not with visit
  count, because the gate caps per-unit frequency. Cold-start expedite is the only
  per-org spike and runs once.

## Hard constraint (why the frontend only *triggers*)

A web page **cannot** fetch X/Reddit cross-origin with the user's session
cookies — browser same-origin policy + CSP block it. That is the entire reason
the browser extension exists. Therefore, in this channel:

- **Frontend = trigger only** (a page-navigation signal).
- **Workflow (server-side) = the actual fetch** — OAuth metrics via
  `checkPostAnalytics`; Reddit via the loid + proxy path; X via TokenPool.

Consequence: this fallback only retrieves what the **server** can retrieve. It
does **not** bypass the X free-tier metrics limit or the X/Reddit anti-bot WAF
the way the extension (personal session) does. It is a **degraded fallback**, not
a full replacement for the extension. The UI should hint that installing the
extension yields fuller / fresher data.

## Channel model (decoupled trigger vs executor)

| Channel | Trigger | Fetch executor | Coverage |
| --- | --- | --- | --- |
| Extension (best) | extension poll / page nav | user's browser session | bypasses WAF/tier |
| **Frontend → workflow (this TODO)** | frontend page nav | **server-side workflow** | only OAuth/loid-reachable |
| Scheduled workflow (baseline) | cron tick | server-side workflow | same as above, but timed |

All three feed the **same server-authoritative due gate** (window + interval +
`Post.lastMetricsFetchAt` for metrics; `EngageScanCursor` cadence + CAS lease for
scan). Whoever fetches first stamps the gate; the others skip. So the channels
**coexist without double-fetching**, and "fallback when no extension" is just
"extension absent → frontend trigger picks up the slack".

## Implementation sketch (when picked up)

### Metrics (own posts)
- New endpoint, e.g. `POST /posts/metrics/refresh-due` (or fold into a flag on
  the existing `/posts/metrics/due`).
- Resolve due posts via the existing gate (`getDueMetricsPosts`, window +
  interval), then for each run the existing server-side `checkPostAnalytics`
  (OAuth) and stamp `lastMetricsFetchAt`.
- **Async / fire-and-forget**: return immediately; do the fetch in the
  background (workflow activity or a detached task). The frontend shows
  cached values, then re-reads. Never block page load on a platform fetch.

### Scan (opportunities)
- New endpoint, e.g. `POST /engage/scan/refresh-due`.
- Kick the existing scan workflow for that org's **due** units only (reuse the
  scan/score/persist path; loid-proxy / TokenPool).
- Same async + interval-throttled behaviour.

### Shared concerns
- **Async, never block the page** — trigger returns fast; result arrives via a
  later poll / SSE.
- **Throttle is the interval gate** — many users browsing must not spike
  server-side platform calls; already-fetched units are skipped, plus a
  server-side rate limit.
- **Extension precedence (optional)** — when the extension announces itself for
  an org, the frontend trigger can stand down (the due gate already prevents
  double-fetch; detection only avoids a wasted server call).
- **Cost** — server tokens / proxy usage scale with active browsing; bound it.

## Open questions
- ~~Trigger granularity~~ → **resolved**: fire on Engage-surface mount + tab-focus
  regain, but gated client-side by the cached `nextRefreshAt` the endpoint returns;
  the server-side interval gate is the real throttle (see the concrete-requirement section).
- Where the "extension present?" signal lives (so the frontend trigger can defer).
- Whether to expose refresh status/staleness in the UI ("last updated …").

## Related
- `docs/engage/tech-design.md` — scan architecture, `EngageScanCursor`.
- Demand-driven metrics gate: `POST /posts/metrics/due` + `/posts/metrics/backfill`
  (`PostsService.getDueMetricsPosts` / `backfillMetrics`).
- Per-plan window/interval: `EngageEntitlementService` (`metricsWindowDaysMax`,
  `metricsFetchIntervalHours`); pacing: `engage_scan_pacing`
  (`EngageScanConfigService`).
