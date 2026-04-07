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

**Key behaviors:**
- Real ticks (`postsAnalyzed > 0`) come from successful platform-API fetches
- **Carry-forward ticks (`postsAnalyzed = 0`)** are written for integrations
  that *had posts to analyze* but whose fetch failed entirely (rate limit,
  expired token, batch error). The service looks up the most recent prior
  row for the (integration, type) pair via `findLatestUpTo` and copies its
  `value` into `dayStart`. This keeps the dashboard time-series monotonic
  and prevents collapse-to-zero on partial outages. If a row already
  exists at `dayStart` (real or prior carry-forward), it is **never**
  overwritten — the carry-forward is a hole filler, not a refresh
- Integrations with **no posts at all** in the lookback window get no row
  (neither real nor carry-forward) — avoids polluting the table
- Strips synthetic metrics before aggregation to prevent double-counting
- Platform APIs return lifetime cumulative totals per post
- Refreshes expired tokens before API calls
- For recurring posts (`intervalInDays > 0`), each send creates a cloned Post with its own `releaseId`. The original stays `QUEUE` without a `releaseId`, so `getPublishedPostsWithRelease` naturally picks up only the clones — no duplicates

### Admin Backfill

`POST /admin/dashboard/data-ticks/backfill?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD`

Iterates day-by-day and calls `syncDailyTicks(date)` for each day. Useful for populating historical data.

### Forward-Fill Repair Script

**File:** `scripts/forward-fill-data-ticks.ts`

Pure-DB repair tool — does **not** call any platform API. Restores the
"impressions/traffic are monotonic non-decreasing per integration" invariant
after the DataTicks table has been corrupted by upstream outages or botched
re-syncs.

#### When to use it

Use this script when the dashboard chart shows any of:

| Symptom | Cause | This script fixes? |
|---|---|---|
| A day in the middle of the range with `value=0` or no bucket | The orchestrator was down that day, or a re-sync silently failed for that day | ✅ fills the gap with the prior day's value |
| A day whose value is **smaller than** an earlier day (cumulative dip) | A re-sync hit rate-limits / partial responses and wrote a too-small number | ✅ with `--repair-regressions` |
| Several consecutive missing or wrong days from a multi-day outage | Combination of the above | ✅ both passes in one run |
| The whole platform's curve is too low compared to reality | Platform API is genuinely returning low values right now | ❌ wait for the next cron, or fix the upstream issue |
| An integration legitimately lost impressions (deleted posts) | Real cumulative drop | ❌ don't run with `--repair-regressions`; the dip is correct |

The structural carry-forward inside `_syncOrgDailyTicks` only protects
**future** runs from this class of bug. Historical holes that already
exist in the DB must be repaired by this script.

#### How it works

For each `(integration, type)` pair walks the requested range one day at
a time, maintaining a rolling **baseline** = the latest real (or already
carried-forward) value seen so far:

- **Missing day:** inserts a synthetic row with `value = baseline` and
  `postsAnalyzed = 0`. Then advances the baseline to that day.
- **Existing day, value ≥ baseline:** healthy. Adopts it as the new baseline.
- **Existing day, value < baseline:**
  - With `--repair-regressions`: overwrites the row with the baseline
    value (still `postsAnalyzed = 0`) and advances the baseline.
  - Without the flag: leaves the row alone, **does not** adopt it as
    baseline (so the regression doesn't poison subsequent missing days),
    and prints a warning.
- **Integration with no prior data anywhere:** skipped — there's nothing
  to carry forward from.

Always idempotent on re-runs: an already-correct row is never touched.

#### CLI

```
Required:
  --start-date <YYYY-MM-DD>  First day to fill (inclusive, UTC)
  --end-date <YYYY-MM-DD>    Last day to fill (inclusive, UTC)

Optional:
  --org <id>                 Limit to a single organization
  --integration <id>         Limit to a single integration
  --type <name>              Limit to one type (impressions | traffic)
  --repair-regressions       Also overwrite existing rows whose value is
                             smaller than the rolling baseline.
  --dry-run                  Show planned writes without touching the DB
                             (default — must pass --execute to write)
  --execute                  Actually perform the writes
  --help                     Show full help
```

#### Recipes

**Recipe 1 — Fix a multi-day outage (e.g. orchestrator down 2026-04-03 → 04-05)**

Just missing days, no known regressions:

```bash
# 1. Preview what will be written
npx ts-node --project scripts/tsconfig.json scripts/forward-fill-data-ticks.ts \
  --start-date 2026-04-03 --end-date 2026-04-05 --dry-run

# 2. Apply
npx ts-node --project scripts/tsconfig.json scripts/forward-fill-data-ticks.ts \
  --start-date 2026-04-03 --end-date 2026-04-05 --execute
```

**Recipe 2 — Fix a botched re-sync (some days missing, others have wrong values)**

The case where `4/4` is missing AND `4/5` has a value smaller than `4/3`:

```bash
# 1. Preview — look for "REPAIR" lines AND "carry" lines in the output
npx ts-node --project scripts/tsconfig.json scripts/forward-fill-data-ticks.ts \
  --start-date 2026-04-04 --end-date 2026-04-05 \
  --repair-regressions --dry-run

# 2. Apply
npx ts-node --project scripts/tsconfig.json scripts/forward-fill-data-ticks.ts \
  --start-date 2026-04-04 --end-date 2026-04-05 \
  --repair-regressions --execute
```

**Recipe 3 — Repair only one integration / one platform**

When you've identified a specific channel that's broken:

```bash
npx ts-node --project scripts/tsconfig.json scripts/forward-fill-data-ticks.ts \
  --start-date 2026-04-04 --end-date 2026-04-05 \
  --integration <integration-id> \
  --repair-regressions --execute
```

To scope to a single org:

```bash
npx ts-node --project scripts/tsconfig.json scripts/forward-fill-data-ticks.ts \
  --start-date 2026-04-04 --end-date 2026-04-05 \
  --org <org-id> --execute
```

To scope to one metric type:

```bash
npx ts-node --project scripts/tsconfig.json scripts/forward-fill-data-ticks.ts \
  --start-date 2026-04-04 --end-date 2026-04-05 \
  --type impressions --execute
```

**Recipe 4 — Detect regressions without fixing them**

Run a dry-run **without** `--repair-regressions` over a wide range. Any
`⚠ regression ... left in place` lines in the output are days where the
DB has a non-monotonic dip:

```bash
npx ts-node --project scripts/tsconfig.json scripts/forward-fill-data-ticks.ts \
  --start-date 2026-03-01 --end-date 2026-04-07 --dry-run
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

- The script **never overwrites** an existing row unless you pass
  `--repair-regressions`. Default mode is hole-filling only.
- Synthetic and repaired rows are marked with `postsAnalyzed = 0`. This is
  the same marker used by the in-service carry-forward (see "Key behaviors"
  above), so the dashboard treats them identically to real data.
- `--repair-regressions` is destructive for any row it touches. If you're
  not sure whether a dip is "wrong" or "really happened" (e.g. user deleted
  many posts), do NOT use the flag — fix that integration manually instead.
- Always run `--dry-run` first. The output enumerates every planned write
  and is safe to capture for audit.

---

## Query Logic

### Summary Query (`_querySummaryByType`)

Used by: `GET /dashboard/summary`, `GET /dashboard/traffics`

1. Query DataTicks for date range (default: last 30 days), `timeUnit='day'`
2. For each integration, keep only the **latest** record (sorted ASC, later overwrites)
3. Sum values by platform
4. Compute percentages: `round(value / grandTotal * 10000) / 100`
5. Return sorted by value DESC: `[{ platform, value, percentage }]`

### Time Series Query (`_queryTimeSeriesByType`)

Used by: `GET /dashboard/impressions`

1. Query DataTicks for date range, grouped by period (daily/weekly/monthly)
2. For each (integration, bucket), keep latest snapshot
3. Sum latest-per-integration values by (platform, bucket)
4. Return sorted: `[{ date, value, platform }]`

Period bucketing:
- **daily**: `YYYY-MM-DD` (default 30 days lookback)
- **weekly**: Monday of week (default 90 days)
- **monthly**: `YYYY-MM` (default 365 days)

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
