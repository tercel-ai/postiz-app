# DataTicks Module Design

## Overview

DataTicks is the analytics aggregation layer that collects and stores post-level metrics from social platforms. It periodically syncs analytics data for all Postiz-published posts, computes two core metrics (**impressions** and **traffic**), and serves them to dashboard endpoints.

**Key principle:** All data is scoped to Postiz-managed posts only, never account-level platform data.

---

## Data Model

### Prisma Schema (`DataTicks`)

| Field | Type | Description |
|-------|------|-------------|
| `id` | String (UUID) | Primary key |
| `organizationId` | String | FK to Organization |
| `integrationId` | String | FK to Integration (social account) |
| `platform` | String | Provider identifier (e.g., `x`, `instagram`, `youtube`) |
| `userId` | String? | Optional user ID |
| `type` | String | `"impressions"` (cumulative snapshot) or `"traffic"` (weighted engagement score) |
| `timeUnit` | String | Temporal bucket: `hour` / `day` / `week` / `month` |
| `statisticsTime` | DateTime | Bucket start aligned to timeUnit |
| `value` | BigInt | Metric value |
| `postsAnalyzed` | Int | Count of posts included in this tick |

**Composite unique constraint:** `(organizationId, integrationId, type, timeUnit, statisticsTime)` — one tick per integration per type per day.

**Indexes:**
- `(organizationId, platform, type, timeUnit, statisticsTime)`
- `(organizationId, type, timeUnit, statisticsTime)`
- `(userId, type, timeUnit, statisticsTime)`
- `(integrationId)`

---

## Metric Types

### Impressions (`type = "impressions"`)

Cumulative sum of exposure metrics across all Postiz-published posts for an integration on a given day.

Platform-specific label mapping:

| Platform | Metric Label |
|----------|-------------|
| X | `impressions` |
| YouTube | `views` |
| Threads | `views` |
| Pinterest | `impressions` |
| Instagram / Instagram-Standalone | `impressions` |
| LinkedIn / LinkedIn-Page | `impressions` |
| Facebook | `impressions` |
| TikTok | `views` |
| Reddit | `score` |
| Bluesky | `likes` (no native impressions API) |
| Mastodon / Mastodon-Custom | `favourites` (no native impressions API) |

### Traffic (`type = "traffic"`)

Weighted engagement score computed by `traffic.calculator.ts`. Each engagement type has a platform-specific weight:

| Platform | Weights |
|----------|---------|
| **X** | likes: 1, replies: 2, retweets: 1.5, quotes: 2, bookmarks: 1.5 |
| **YouTube** | views: 1, likes: 2, comments: 5, favorites: 2 |
| **Instagram / Instagram-Standalone** | likes: 1, comments: 3, saves: 5, shares: 4 |
| **LinkedIn-Page** | clicks: 5, likes: 1, comments: 4, shares: 3, engagement: 0.5 |
| **LinkedIn** (personal) | impressions: 0.05, likes: 1, comments: 4, shares: 3, reach: 0.1 |
| **Facebook** | clicks: 3, reactions: 1 |
| **Threads** | likes: 1, replies: 2, reposts: 1.5, quotes: 2 |
| **Pinterest** | pin clicks: 3, outbound clicks: 5, saves: 2 |
| **TikTok** | views: 0.1, likes: 1, comments: 3, shares: 4 |
| **Reddit** | score: 0.5, upvotes: 1, comments: 3 |
| **Bluesky** | likes: 1, reposts: 1.5, replies: 2, quotes: 2 |
| **Mastodon / Mastodon-Custom** | favourites: 1, boosts: 1.5, replies: 2 |

Platforms not listed above use fallback weights: likes: 1, comments: 3, shares: 2, clicks: 5.

**Formula:** `Traffic Score = Σ(metric_value × weight)`

Example: X post with 100 likes + 10 replies → `100 × 1 + 10 × 2 = 120`

---

## Data Sync Flow

### Trigger

Temporal workflow (`dataTicksSyncWorkflow`) runs daily at **UTC 00:05**.

- Retry: up to 3 attempts, backoff ×2, initial interval 5 min
- Uses `continueAsNew()` to prevent unbounded event history

### Sync Process (`syncDailyTicks`)

```
Temporal Workflow (daily @ UTC 00:05)
  └─ DataTicksActivity.syncDailyTicks(targetDate?)
       └─ DataTicksService.syncDailyTicks()
            ├─ Get all active integrations grouped by org
            └─ For each org → _syncOrgDailyTicks():
                 ├─ Fetch published posts (last 30+ days) with releaseId
                 ├─ Group posts by integration
                 ├─ For each integration with posts:
                 │    ├─ Call batchPostAnalytics() or per-post postAnalytics()
                 │    ├─ Strip synthetic metrics (e.g., 'Traffic' label)
                 │    ├─ Extract impressions (sum exposure metrics)
                 │    └─ Compute traffic score (weighted formula)
                 ├─ Upsert DataTicks records (impressions + traffic)
                 │   (real rows when postsAnalyzed > 0;
                 │    carry-forward rows for failed integrations — see below)
                 ├─ Invalidate Redis cache (dashboard:impressions/traffics/summary)
                 └─ Sync individual PostRelease analytics
```

**Unified write rules (per integration, per type):**

Before writing, the service loads the latest prior tick for every active
integration via `findLatestUpTo(upTo=dayStart)`. Each integration then
falls into exactly one of four paths:

| Situation | Action | `postsAnalyzed` |
|---|---|---|
| Fetch succeeded, `fetched ≥ prior` (or no prior) | write real tick, value=fetched | `> 0` |
| Fetch succeeded, `fetched < prior` | **clamp**: write value=prior, warn | `> 0` |
| Fetch failed / integration has no posts in lookback, has prior history | **carry-forward**: write value=prior, warn | `0` |
| No prior anywhere | skip (no signal to carry) | n/a |

Rationale for clamp: platform APIs can legitimately shrink the cumulative
total (user deletes a top post, platform recomputes, post goes private).
The cumulative-metric contract requires the series to be monotonic
non-decreasing, so we pin to prior instead of writing the regression.
A paper trail is kept in log lines prefixed with `[DataTicks] clamp`.

**Other invariants:**

- If a row already exists at `dayStart` (real or prior carry-forward), the
  carry-forward path is **never** allowed to overwrite it — the check
  compares `prior.statisticsTime` to `dayStart` and skips on equality.
  The clamp path (real fetch) is allowed to update it, since it carries
  fresh signal.
- Strips synthetic metrics before aggregation to prevent double-counting
- Platform APIs return lifetime cumulative totals per post
- Refreshes expired tokens before API calls
- For recurring posts (`intervalInDays > 0`), each send creates a cloned Post with its own `releaseId`. The original stays `QUEUE` without a `releaseId`, so `getPublishedPostsWithRelease` naturally picks up only the clones — no duplicates

### Admin Backfill

`POST /admin/dashboard/data-ticks/backfill?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD`

Iterates day-by-day and calls `syncDailyTicks(date)` for each day. Useful for populating historical data.

### Forward-Fill + Monotonic Repair Script

**File:** `scripts/forward-fill-data-ticks.ts`

Pure-DB repair tool — does **not** call any platform API. Restores the
"impressions/traffic are monotonic non-decreasing per integration" invariant
after the DataTicks table has been corrupted by upstream outages, botched
re-syncs, or post deletions that the cumulative metric semantics treat as
errors.

#### When to use it

| Symptom | Cause | This script fixes? |
|---|---|---|
| A day in the middle of the range with `value=0` or no bucket | Orchestrator outage / silent re-sync failure | ✅ fills with rolling baseline |
| A day whose value is **smaller than** an earlier day | Re-sync rate-limit, partial response, deleted posts, platform metric revision | ✅ overwrites with rolling baseline |
| Both above mixed across many days | Multi-day outage + later rate-limited recovery | ✅ both passes in one run |
| The whole platform's curve is too low compared to reality | Platform API is genuinely returning low values right now | ❌ wait for the next cron / fix upstream |

The structural carry-forward inside `_syncOrgDailyTicks` only protects
**future** runs. Historical holes and dips already in the DB must be
repaired by this script.

#### How it works

The script always performs **both** passes in a single walk per
`(integration, type)` pair, maintaining a rolling **baseline** = the
latest value adopted so far for this integration:

- **Missing day** → insert a synthetic row with `value = baseline`,
  `postsAnalyzed = 0`. Roll the baseline forward to that day.
- **Existing day, value ≥ baseline** → healthy. Adopt it as the new
  baseline. Leave the row untouched.
- **Existing day, value < baseline** → regression. Overwrite the row
  with `value = baseline`, `postsAnalyzed = 0`. Roll the baseline forward.
- **Integration with no prior data anywhere** → skip (nothing to carry
  forward from).

The result for every (integration, type) is a non-decreasing sequence
across the requested range. Re-runs are idempotent: a previously
repaired row is already at the baseline, so it's adopted as-is.

**Worked example** — one integration with mixed problems in 2026-04-03 → 04-06:

| Day | DB before | Walk decision | DB after |
|---|---|---|---|
| 4/02 (pre-range) | 1796 (real) | seed `lastGood = 1796` | unchanged |
| 4/03 | 1796 (real) | `1796 ≥ 1796` → adopt baseline | unchanged |
| 4/04 | _missing_ | fill with baseline 1796 | new row, value=1796, p=0 |
| 4/05 | 1784 (real) | `1784 < 1796` → REPAIR | overwritten to 1796, p=0 |
| 4/06 | 1652 (real) | `1652 < 1796` → REPAIR | overwritten to 1796, p=0 |

After run: 1796 → 1796 → 1796 → 1796 → 1796. Curve is flat at the prior peak.

#### CLI

```
Required:
  --start-date <YYYY-MM-DD>  First day to repair (inclusive, UTC)
  --end-date <YYYY-MM-DD>    Last day to repair (inclusive, UTC)

Optional:
  --org <id>                 Limit to a single organization
  --integration <id>         Limit to a single integration
  --type <name>              Limit to one type (impressions | traffic)
  --dry-run                  Show planned writes without touching the DB
                             (default — must pass --execute to write)
  --execute                  Actually perform the writes
  --help                     Show full help
```

#### Trade-off you should know about

If an integration's value LEGITIMATELY dropped (e.g. all of its top
posts were deleted and the cumulative impression sum is genuinely
smaller than a week ago), the script will **hide** that drop and pin
the curve at the prior peak. That is the correct behavior for
"monotonic cumulative" semantics, but it does mean you cannot use the
chart to detect a real platform-side decline. If you want to preserve
a specific real decline, exclude that integration via `--integration`
and handle it manually.

#### Recipes

**Recipe 1 — Fix a multi-day outage**

```bash
# 1. Preview — look at REPAIR and ← carry lines
npx ts-node --project scripts/tsconfig.json scripts/forward-fill-data-ticks.ts \
  --start-date 2026-04-03 --end-date 2026-04-06 --dry-run

# 2. Apply
npx ts-node --project scripts/tsconfig.json scripts/forward-fill-data-ticks.ts \
  --start-date 2026-04-03 --end-date 2026-04-06 --execute
```

**Recipe 2 — Repair only one organization**

```bash
npx ts-node --project scripts/tsconfig.json scripts/forward-fill-data-ticks.ts \
  --start-date 2026-04-03 --end-date 2026-04-06 \
  --org <org-id> --execute
```

**Recipe 3 — Repair only one integration**

```bash
npx ts-node --project scripts/tsconfig.json scripts/forward-fill-data-ticks.ts \
  --start-date 2026-04-03 --end-date 2026-04-06 \
  --integration <integration-id> --execute
```

**Recipe 4 — Repair only impressions, leave traffic alone**

```bash
npx ts-node --project scripts/tsconfig.json scripts/forward-fill-data-ticks.ts \
  --start-date 2026-04-03 --end-date 2026-04-06 \
  --type impressions --execute
```

**Recipe 5 — Find org IDs by user email (helper for `--org`)**

```sql
SELECT o.id AS org_id, o.name, u.email
FROM "Organization" o
JOIN "UserOrganization" uo ON uo."organizationId" = o.id
JOIN "User" u ON u.id = uo."userId"
WHERE u.email = 'user@example.com';
```

To list all orgs that have impressions activity in a given date range
(useful when you don't know which orgs were affected by an outage):

```sql
SELECT DISTINCT "organizationId", COUNT(*) AS row_count
FROM "DataTicks"
WHERE "timeUnit" = 'day'
  AND type = 'impressions'
  AND "statisticsTime" >= '2026-04-01'
GROUP BY "organizationId"
ORDER BY row_count DESC;
```

#### After running the script

The script writes directly to the DB but does **not** clear the dashboard
Redis cache. After `--execute`, manually invalidate so users see the fix:

```bash
redis-cli -h <redis-host> --scan --pattern 'dashboard:impressions:*' | xargs -r redis-cli -h <redis-host> DEL
redis-cli -h <redis-host> --scan --pattern 'dashboard:traffics:*'    | xargs -r redis-cli -h <redis-host> DEL
redis-cli -h <redis-host> --scan --pattern 'dashboard:summary:*'     | xargs -r redis-cli -h <redis-host> DEL
```

Then reload the dashboard. Per-integration cumulative curves should now be
monotonic non-decreasing across the repaired range.

#### Safety notes

- Default is `--dry-run`. Nothing is written unless you pass `--execute`.
- The dry-run output enumerates every planned write (one line per row);
  always read it before executing.
- Synthetic / repaired rows are marked with `postsAnalyzed = 0`, the
  same marker used by the in-service carry-forward (see "Key behaviors"
  above). The dashboard treats them identically to real data.
- The `--repair-regressions` flag from earlier versions is now the
  default and is silently accepted (with a deprecation note) if passed.
- The script is idempotent: running it twice on the same range produces
  the same result. Re-runs are safe.

#### Verifying the result after a run

After `--execute` and Redis flush, run these queries to confirm the fix:

```sql
-- 1. No duplicate rows for any (integration, type, day) — sanity check
SELECT "integrationId", type, "statisticsTime"::date, COUNT(*)
FROM "DataTicks"
WHERE "timeUnit" = 'day' AND "statisticsTime" >= '<start-date>'
GROUP BY "integrationId", type, "statisticsTime"::date
HAVING COUNT(*) > 1;
-- expected: 0 rows

-- 2. No remaining regressions for the org you fixed
WITH ranked AS (
  SELECT
    "integrationId", type, "statisticsTime", value,
    LAG(value) OVER (PARTITION BY "integrationId", type ORDER BY "statisticsTime") AS prev
  FROM "DataTicks"
  WHERE "organizationId" = '<your-org-id>'
    AND "timeUnit" = 'day'
    AND "statisticsTime" >= '<start-date>'
)
SELECT * FROM ranked WHERE value < prev;
-- expected: 0 rows

-- 3. Synthetic row count in the repaired range (sanity)
SELECT type, COUNT(*) FROM "DataTicks"
WHERE "timeUnit" = 'day'
  AND "postsAnalyzed" = 0
  AND "statisticsTime" BETWEEN '<start-date>' AND '<end-date>'
GROUP BY type;
```

---

## Query Logic

### Summary Query (`_querySummaryByType`)

Used by: `GET /dashboard/summary`, `GET /dashboard/traffics`

1. Query DataTicks for date range (default: last 30 days), `timeUnit='day'`
2. For each integration, keep the **max** value seen in the window
3. Sum values by platform
4. Compute percentages: `round(value / grandTotal * 10000) / 100`
5. Return sorted by value DESC: `[{ platform, value, percentage }]`

Max-per-integration (not latest) keeps the summary endpoint consistent with
the time-series endpoint's clamp: if historical data contains a regression
(e.g. `1000 → 300` from a pre-clamp write or a genuinely deleted post),
both endpoints report `1000`. Taking "latest" would reintroduce the dip
that the time-series walker just hid.

### Time Series Query (`_queryTimeSeriesByType`)

Used by: `GET /dashboard/impressions`

1. Query DataTicks for date range, grouped by period (daily/weekly/monthly)
2. For each (integration, bucket), keep latest snapshot
3. **Per integration, walk from its first in-window bucket to the global last
   bucket, forward-filling missing buckets with the prior value and clamping
   regressions to the running baseline.** Impressions and traffic are
   cumulative, so the per-integration series must be monotonic non-decreasing.
   This masks gaps caused by:
   - posts falling out of the 30-day analytics lookback (sync writes no row)
   - platform APIs returning a smaller value on a later re-sync
   - post deletions that shrink the cumulative total
4. Sum per-integration filled values by (platform, bucket)
5. Return sorted: `[{ date, value, platform }]`

Period bucketing:
- **daily**: `YYYY-MM-DD` (default 30 days lookback)
- **weekly**: Monday of week (default 90 days)
- **monthly**: `YYYY-MM` (default 365 days)

Query-time forward-fill does **not** write anything back to the DB — it only
shapes the response. The offline `forward-fill-data-ticks.ts` script is still
the way to persist a monotonic history; the query-time layer is a safety net
for operational gaps between syncs.

**Coverage boundary:** the query-time walker operates on ticks returned by
the repository's window filter (`statisticsTime BETWEEN startTime AND endTime`).
An integration whose most recent tick is **older than** `startTime` is not
returned by the query and therefore not included in the walker. It relies
on the write-side carry-forward to keep a fresh row landing in each daily
bucket. If a transient write-side failure then skips that integration for
a day inside the window, the walker has no seed and the integration is
absent from the response for that day. The write-side carry-forward and
the offline repair script are the primary defense; the query-time layer
covers operational gaps once the integration already has at least one tick
inside the requested window.

---

## Dashboard Endpoints

| Endpoint | DataTicks Method | Returns |
|----------|-----------------|---------|
| `GET /dashboard/summary` | `getImpressionsSummaryByPlatform()` + `getTrafficSummaryByPlatform()` | `{ impressions_total, traffics_total, ... }` |
| `GET /dashboard/impressions` | `getImpressionsByPlatform(period)` | Time series: `[{ date, value, platform }]` |
| `GET /dashboard/traffics` | `getTrafficSummaryByPlatform()` | Summary: `[{ platform, value, percentage }]` |

Common query params: `startDate?`, `endDate?`, `integrationId[]?`, `channel[]?`

---

## Caching Strategy

All dashboard queries use Redis cache with TTL:

| Cache Key Pattern | TTL |
|-------------------|-----|
| `dashboard:summary:${orgId}:${start}:${end}:${intKey}:${chKey}` | 3600s (1s in dev) |
| `dashboard:impressions:${orgId}:${period}:${intKey}:${chKey}:${sdKey}:${edKey}` | 3600s |
| `dashboard:traffics:${orgId}:${intKey}:${chKey}:${sdKey}:${edKey}` | 3600s |

**Invalidation:** When `syncDailyTicks` upserts new data, it deletes all `dashboard:impressions:${orgId}:*`, `dashboard:traffics:${orgId}:*`, and `dashboard:summary:${orgId}:*` keys.

---

## File Locations

| Component | Path |
|-----------|------|
| Prisma Schema | `libraries/nestjs-libraries/src/database/prisma/schema.prisma` |
| DataTicksService | `libraries/nestjs-libraries/src/database/prisma/data-ticks/data-ticks.service.ts` |
| DataTicksRepository | `libraries/nestjs-libraries/src/database/prisma/data-ticks/data-ticks.repository.ts` |
| Traffic Calculator | `libraries/nestjs-libraries/src/integrations/social/traffic.calculator.ts` |
| Dashboard Service | `libraries/nestjs-libraries/src/database/prisma/dashboard/dashboard.service.ts` |
| Dashboard Controller | `apps/backend/src/api/routes/dashboard.controller.ts` |
| Dashboard DTOs | `libraries/nestjs-libraries/src/dtos/dashboard/dashboard.dto.ts` |
| Temporal Workflow | `apps/orchestrator/src/workflows/data-ticks.workflow.ts` |
| Temporal Activity | `apps/orchestrator/src/activities/data-ticks.activity.ts` |
| Admin Backfill | `apps/backend/src/admin-api/routes/admin-dashboard.controller.ts` |
