# Frontend-Triggered Workflow Scan & Metrics (TODO / next step)

**Status:** Deferred — design recorded, not implemented.
**Scope:** opportunity scanning *and* own-post metrics fetching.
**Depends on:** the demand-driven "due gate" (already built for metrics; planned for scan).

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
- Trigger granularity: on every page open, or debounced per org per N minutes?
- Where the "extension present?" signal lives (so the frontend trigger can defer).
- Whether to expose refresh status/staleness in the UI ("last updated …").

## Related
- `docs/engage/tech-design.md` — scan architecture, `EngageScanCursor`.
- Demand-driven metrics gate: `POST /posts/metrics/due` + `/posts/metrics/backfill`
  (`PostsService.getDueMetricsPosts` / `backfillMetrics`).
- Per-plan window/interval: `EngageEntitlementService` (`metricsWindowDaysMax`,
  `metricsFetchIntervalHours`); pacing: `engage_scan_pacing`
  (`EngageScanConfigService`).
