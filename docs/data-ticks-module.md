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
                 │   (only if postsAnalyzed > 0)
                 ├─ Invalidate Redis cache (dashboard:impressions/traffics/summary)
                 └─ Sync individual PostRelease analytics
```

**Key behaviors:**
- Only creates ticks when `postsAnalyzed > 0` — avoids zero-value rows
- Strips synthetic metrics before aggregation to prevent double-counting
- Platform APIs return lifetime cumulative totals per post
- Refreshes expired tokens before API calls
- For recurring posts (`intervalInDays > 0`), each send creates a cloned Post with its own `releaseId`. The original stays `QUEUE` without a `releaseId`, so `getPublishedPostsWithRelease` naturally picks up only the clones — no duplicates

### Admin Backfill

`POST /admin/dashboard/data-ticks/backfill?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD`

Iterates day-by-day and calls `syncDailyTicks(date)` for each day. Useful for populating historical data.

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
