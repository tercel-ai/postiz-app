# Dashboard Module — Feature Documentation

## 1. Module Overview

### What does this module do?

The Dashboard provides a **one-stop summary of social media operations data** for each organization. On the dashboard page, users can quickly see:

- How many posts have been published and how many social accounts are connected
- Impressions and traffic trends across platforms
- How many likes, comments, and saves each post has received on each platform

**Important: All analytics data (impressions, traffic, engagement) is scoped to posts published through Postiz only.** Data from posts created directly on social platforms (outside Postiz) is not included. This ensures consistent and accurate measurement of content managed through the system.

### Data pipeline overview

The dashboard uses **two complementary data pipelines**:

1. **DataTicks (pre-aggregated)** — A background Temporal workflow syncs post-level analytics daily at UTC 00:05, storing cumulative impressions and weighted traffic scores in the `DataTicks` table. Used by: Summary, Traffics, Impressions Trend.
2. **Real-time fetch** — On-demand post-level API calls when the user opens the page. Used by: Post Engagement.

Both pipelines source data exclusively from post-level APIs (`batchPostAnalytics` / `postAnalytics`), never from account-level APIs.

### Which social platforms are supported?

| Platform | Post-level analytics (`postAnalytics`) | Data source |
|----------|:---:|------|
| X (Twitter) | Yes | Twitter API v2 |
| Instagram | Yes | Facebook Graph API |
| Facebook | Yes | Facebook Graph API |
| LinkedIn Page | Yes | LinkedIn API v2 |
| YouTube | Yes | YouTube Data API v3 |
| Pinterest | Yes | Pinterest API |
| Threads | Yes | Meta Threads API |
| Dribbble | Yes | Dribbble API |
| GMB (Google My Business) | Yes | Google Business API |
| Reddit, Bluesky, Mastodon, TikTok, Discord, Slack, Medium, Dev.to, Telegram, etc. | No | — |

> **Note**: Platforms that have not implemented `postAnalytics` will not contribute impressions, traffic, or engagement data to the dashboard. Their posts are still tracked in post counts, but analytics metrics will be 0 for those platforms.

---

## 2. Data Source Architecture

```
┌───────────────────────────────────────────────────────────────────────┐
│  Temporal Workflow: dataTicksSyncWorkflow (daily @ UTC 00:05)         │
│                                                                       │
│  For each org → for each integration with Postiz posts:               │
│    1. Fetch post-level analytics (batchPostAnalytics / postAnalytics) │
│    2. Extract impressions (cumulative snapshot)                        │
│    3. Compute traffic score (weighted engagement formula)              │
│    4. Upsert DataTicks records (type=impressions, type=traffic)       │
│    5. Invalidate Redis cache                                          │
└───────────────────────────────────────────────────────────────────────┘
         │
         ▼  Pre-aggregated data consumed by:
   ┌─────────────┬──────────────┬──────────────┐
   │ getSummary() │ getTraffics()│getImpressions│
   │ impressions  │ traffic by   │ impressions  │
   │ + traffic    │ platform     │ by date +    │
   │ totals       │ + percentage │ platform     │
   └─────────────┴──────────────┴──────────────┘

┌───────────────────────────────────────────────────────────────────────┐
│  Real-time pipeline: _fetchAllPostAnalytics()                         │
│                                                                       │
│  1. Query DB for published posts (state=PUBLISHED, releaseId!=null)   │
│  2. Group posts by integration (account)                              │
│  3. For each integration group:                                       │
│     ├─ Batch path: provider.batchPostAnalytics() if available         │
│     └─ Fallback: per-post provider.postAnalytics() with circuit       │
│        breaker (5 concurrent, fail threshold = 2)                     │
│  4. Return Map<postId, { metrics, platform }>                         │
└───────────────────────────────────────────────────────────────────────┘
         │
         ▼  Consumed by:
   ┌──────────────────┐
   │getPostEngagement │
   │ views/likes/     │
   │ comments/saves   │
   │ by platform      │
   └──────────────────┘
```

### Metrics Data Source Summary

| Endpoint | Metric | Data source | Scope |
|----------|--------|-------------|-------|
| **Summary** `impressions_total` | Impressions | DataTicks (`getImpressionsSummaryByPlatform`) | Postiz posts only, latest snapshot per integration |
| **Summary** `traffics_total` | Traffic | DataTicks (`getTrafficSummaryByPlatform`) | Postiz posts only, latest snapshot per integration |
| **Summary** `posts_stats` | Post counts | Database query | All Postiz posts including recurring clones (each send = 1 count) |
| **Summary** `channel_count` | Channel count | Database query | All active integrations |
| **Impressions Trend** | Impressions by date + platform | DataTicks (`getImpressionsByPlatform`) | Postiz posts only, time series |
| **Traffic Analysis** | Traffic by platform | DataTicks (`getTrafficSummaryByPlatform`) | Postiz posts only, latest snapshot |
| **Post Engagement** | Views/Likes/Comments/Saves | Real-time `_fetchAllPostAnalytics()` | Postiz posts only, configurable 1–90 days |
| **Posts Trend** | Post count by date | Database query | All Postiz posts (no limit) |

### Known Factors That May Cause Inaccuracy

| Factor | Impact | Severity |
|--------|--------|----------|
| **DataTicks sync delay** | DataTicks sync runs daily at UTC 00:05. Data may be up to ~24 hours stale for Summary/Traffics/Impressions. Post Engagement uses real-time fetch. | Low |
| **Platforms without `postAnalytics`** | ~19 platforms (Reddit, Bluesky, Mastodon, TikTok, etc.) return empty analytics. Posts from these platforms have 0 impressions/traffic/engagement. | High (if user primarily uses these platforms) |
| **API failures / rate limiting** | Posts that fail to fetch during DataTicks sync are skipped. `postsAnalyzed` tracks how many posts contributed to each tick. | Low |
| **Cache staleness** | Each endpoint has its own Redis cache (1hr prod / 1s dev). DataTicks sync invalidates relevant cache keys. | Low |
| **Post deleted on platform** | If a post was published via Postiz but later deleted on the platform, its analytics return empty and are not counted. | Low |
| **Recurring post clones** | Each recurring send creates a cloned Post. All clones are included in post counts, analytics, and trends. This accurately reflects the actual number of publications to social platforms. | Info |

---

## 3. Detailed Feature Descriptions

### 3.1 Summary

**Endpoint**: `GET /dashboard/summary`

**Business scenario**: The first screen users see when entering the dashboard. Provides an at-a-glance view of overall operational performance, with optional date range and integration filtering.

**Optional parameters**:

| Parameter | Type | Default | Validation | Meaning |
|-----------|------|---------|------------|---------|
| `startDate` | ISO 8601 date string | — (no filter) | `@IsDateString()` | Start of the date range for post statistics (inclusive, normalized to start of day) |
| `endDate` | ISO 8601 date string | — (no filter) | `@IsDateString()` | End of the date range for post statistics (inclusive, normalized to end of day) |
| `integrationId[]` | string array | — (all) | `@IsArray, @ArrayMaxSize(50)` | Filter by specific integration IDs |
| `channel[]` | string array | — (all) | `@IsIn(VALID_CHANNELS)` | Filter by platform channel names |

> **Note**: If both `startDate` and `endDate` are provided, `startDate` must be before `endDate` — otherwise the API returns a `400 Bad Request`. Either parameter can be used independently.

**What the user sees (example)**:

```
┌─────────────────────────────────────────────────────┐
│  Connected Channels    5                             │
│                                                     │
│  Channels by Platform:                               │
│    Twitter    2 accounts                             │
│    Instagram  3 accounts                             │
│                                                     │
│  30-day Total Impressions    50,000                   │
│  30-day Total Traffic        12,000                   │
│                                                     │
│  Posts Stats:                                        │
│    Total        128                                  │
│    Scheduled     15                                  │
│    Published    100                                  │
│    Drafts        10                                  │
│    Errors         3                                  │
└─────────────────────────────────────────────────────┘
```

**Response structure**:
```json
{
  "channel_count": 5,
  "channels_by_platform": [
    { "platform": "twitter", "count": 2 },
    { "platform": "instagram", "count": 3 }
  ],
  "impressions_total": 50000,
  "traffics_total": 12000,
  "posts_stats": {
    "total": 128,
    "scheduled": 15,
    "published": 100,
    "drafts": 10,
    "errors": 3
  },
  "published_this_period": 5,
  "post_send_limit": 20,
  "period_end": "2026-04-23T06:21:39.000Z"
}
```

**Field descriptions**:

| Field | Meaning | How to interpret |
|-------|---------|-----------------|
| `channel_count` | Total number of channels | Number of connected and enabled social accounts |
| `channels_by_platform` | Channels by platform | Grouped by platform, e.g., 2 Twitter accounts connected |
| `impressions_total` | Total impressions | Sum of latest DataTicks impressions snapshots across all integrations (default last 30 days) |
| `traffics_total` | Total traffic | Sum of latest DataTicks traffic snapshots across all integrations (weighted engagement score, default last 30 days) |
| **posts_stats** | | |
| `posts_stats.total` | Total posts | All posts matching the date filter (or all posts if no filter). Sum of all states below. |
| `posts_stats.scheduled` | Scheduled posts | Posts in `QUEUE` state (waiting to be published) |
| `posts_stats.published` | Published posts | Posts in `PUBLISHED` state (includes cloned records from recurring sends — each send counts as 1) |
| `posts_stats.drafts` | Draft posts | Posts in `DRAFT` state |
| `posts_stats.errors` | Error posts | Posts in `ERROR` state (publishing failed) |
| `published_this_period` | Posts used this billing period | Count of `QUEUE` + `PUBLISHED` (top-level) posts since the Aisee billing period start (`periodStart`). Falls back to calendar month start if no Aisee subscription. Uses the same `countPostsFromDay` query as overage billing — ensuring dashboard and billing always show the same number. |
| `post_send_limit` | Billing period post limit | Max posts allowed per billing period (from Aisee `postSendLimit`). Only present when Aisee subscription is active. |
| `period_end` | Billing period end | ISO 8601 UTC timestamp of billing period end. Only present when Aisee subscription is active. |

**How does date filtering work?**

- When `startDate` and/or `endDate` are provided, only posts whose `publishDate` falls within the range are counted in `posts_stats`.
- Dates are normalized: `startDate` → start of day (00:00:00), `endDate` → end of day (23:59:59.999). This means `?startDate=2026-03-01&endDate=2026-03-01` includes all posts on March 1st.
- When no date parameters are provided, all posts (excluding deleted) are counted — same behavior as before.
- Impressions and traffic totals come from DataTicks and use the same date range (or default last 30 days if no date filter).

**Date & timezone parsing rules:**

All date-accepting endpoints use `parseDate()` (`@gitroom/helpers/utils/date.utils`) for consistent timezone handling:

| Client sends | `x-timezone` header | Interpretation |
|-------------|-------------------|----------------|
| `2026-03-20T00:00:00+08:00` | `Asia/Shanghai` | Local time — offset determines UTC instant |
| `2026-03-20T00:00:00+08:00` | (none) | Local time — offset determines UTC instant |
| `2026-03-20T00:00:00` | `Asia/Shanghai` | Local time in Shanghai timezone |
| `2026-03-20T00:00:00` | (none) | UTC time |

Cases 1–3 all represent "the client means this local time". Case 4 means UTC. The `x-timezone` header is used for `startOf(day)`/`endOf(day)` snapping when a display period is specified.

**Impressions vs. Traffic — What's the difference?**

- **Impressions**: Cumulative exposure count — the number of times content appeared on users' screens. Extracted from platform metrics labeled as `impressions`, `views`, or `reach`.
- **Traffic**: Weighted engagement score — a composite metric computed from likes, comments, shares, bookmarks, etc. Each engagement type has a platform-specific weight (see `data-ticks-module.md` for the formula).

<details>
<summary>Technical implementation details (for developers)</summary>

**Algorithm**:
1. Parse dates with `parseDateToUTC(input, tz)` — respects offset and timezone header
2. Normalize `startDate` / `endDate` to day boundaries in the user's timezone
3. Fetch Aisee billing period (`getUserLimits(userId)`) for `published_this_period`; fall back to calendar month if unavailable
4. Check Redis cache (key: `dashboard:summary:${orgId}:${userId}:${start}:${end}:${intKey}:${chKey}:${tz}`) → return immediately if cache hit
5. Query in parallel: total channels + active integrations list + post stats grouped by state + impressions/traffic from DataTicks + post count via `countPostsFromDay(orgId, periodStart)`
6. Map `groupBy` results to `posts_stats` object (QUEUE→scheduled, PUBLISHED→published, DRAFT→drafts, ERROR→errors)
7. Group channels by platform, sum impressions/traffic totals
8. Write result to Redis cache (TTL 1 hour), return

**Date validation**: The controller throws `BadRequestException` if `startDate > endDate`.

</details>

---

### 3.2 Posts Trend

**Endpoint**: `GET /dashboard/posts-trend?period=daily`

**Business scenario**: Operations staff want to see "recent posting cadence" to determine whether content output needs to increase.

**Optional parameters**:

| Parameter | Options | Meaning | Lookback range |
|-----------|---------|---------|---------------|
| `period` | `daily` (default) | Aggregate by day | Last 30 days |
| | `weekly` | Aggregate by week | Last 90 days |
| | `monthly` | Aggregate by month | Last 365 days |

**What the user sees (example)**:

```
Posts Trend (daily, last 30 days)

    8 ┤                        ■ Twitter
    6 ┤  ■                     □ Instagram
    5 ┤  ■ □
    3 ┤  ■ □           □
    1 ┤  ■ □   ■       □ ■
      └──────────────────────→ Date
       2/01  2/05  2/10  2/15
```

**Response structure**:
```json
[
  { "date": "2026-02-01", "platform": "twitter", "count": 5 },
  { "date": "2026-02-01", "platform": "instagram", "count": 3 },
  { "date": "2026-02-02", "platform": "twitter", "count": 8 }
]
```

**Field descriptions**:

| Field | Meaning |
|-------|---------|
| `date` | Time point (specific date for daily, Monday of that week for weekly, "year-month" for monthly) |
| `platform` | Social platform identifier |
| `count` | Number of posts published on that platform during that time period |

> **Note**: This endpoint tracks the **volume trend of published posts**. Data comes from the internal database, so no external platform APIs are called and response times are very fast.

<details>
<summary>Technical implementation details (for developers)</summary>

**Algorithm**: Queries post `publishDate` from the database, then groups into time buckets using a `dateKey|platform` composite key in a Map. Weekly aggregation uses the ISO 8601 standard, mapping dates to the Monday of their respective week. Supports `x-timezone` header for timezone-aware bucketing.

**Caching**: This endpoint does not use Redis caching — it queries the database in real time (internal data only, so it's fast enough).

</details>

---

### 3.3 Traffic Analysis

**Endpoint**: `GET /dashboard/traffics`

**Business scenario**: Marketing staff want to know "which platform performs best" to inform resource allocation decisions.

> **Important**: Traffic is a **weighted engagement score** computed from post-level metrics (likes, comments, shares, bookmarks, etc.), not raw clicks. The score is pre-computed daily by the DataTicks background sync.

**Optional parameters**:

| Parameter | Type | Default | Meaning |
|-----------|------|---------|---------|
| `startDate` | ISO 8601 date string | — (last 30 days) | Start of date range |
| `endDate` | ISO 8601 date string | — (today) | End of date range |
| `integrationId[]` | string array | — (all) | Filter by integration IDs |
| `channel[]` | string array | — (all) | Filter by platform channels |

**What the user sees (example)**:

```
Traffic Analysis by Platform (last 30 days)

  Twitter      ████████████████████  8,000 (66.67%)
  Instagram    ██████████            4,000 (33.33%)
                                              ──────
                                    Total     12,000
```

**Response structure**:
```json
[
  {
    "platform": "twitter",
    "value": 8000,
    "percentage": 66.67
  },
  {
    "platform": "instagram",
    "value": 4000,
    "percentage": 33.33
  }
]
```

> **Note**: Only platforms with DataTicks data appear in the results. Platforms with no analyzed posts will not be listed.

**Field descriptions**:

| Field | Meaning | How to interpret |
|-------|---------|-----------------|
| `platform` | Platform name | e.g., x, instagram, linkedin |
| `value` | Total traffic score | Weighted engagement score from Postiz-managed posts on this platform |
| `percentage` | Share (%) | This platform's traffic as a percentage of total traffic across all platforms |

<details>
<summary>Technical implementation details (for developers)</summary>

**Algorithm**: Reads pre-aggregated DataTicks records (`type='traffic'`). For each integration, takes the latest snapshot within the date range. Sums across integrations by platform. Computes percentages. Returns sorted by value descending.

**Caching**: Redis cache (key: `dashboard:traffics:${orgId}:${intKey}:${chKey}:${sdKey}:${edKey}`), TTL 1 hour. Cache is invalidated when DataTicks sync runs.

</details>

---

### 3.4 Impressions Trend

**Endpoint**: `GET /dashboard/impressions?period=daily`

**Business scenario**: Product or marketing staff want to see "how content reach changes over time" to evaluate whether the content strategy is working.

**Optional parameters**:

| Parameter | Type | Default | Meaning |
|-----------|------|---------|---------|
| `period` | `daily` / `weekly` / `monthly` | `daily` | Time aggregation granularity |
| `startDate` | ISO 8601 date string | — (default lookback) | Start of date range |
| `endDate` | ISO 8601 date string | — (today) | End of date range |
| `integrationId[]` | string array | — (all) | Filter by integration IDs |
| `channel[]` | string array | — (all) | Filter by platform channels |

Default lookback: 30 days (daily), 90 days (weekly), 365 days (monthly).

**What the user sees (example)**:

```
Impressions Trend (daily, last 30 days)

 2500 ┤              ╭─╮
 2000 ┤         ╭────╯ ╰──╮
 1500 ┤    ╭────╯         ╰──╮
 1000 ┤────╯                  ╰──
      └──────────────────────────→ Date
       2/01    2/08    2/15    2/22
```

**Response structure**:
```json
[
  { "date": "2026-02-01", "value": 1500, "platform": "x" },
  { "date": "2026-02-01", "value": 800, "platform": "instagram" },
  { "date": "2026-02-02", "value": 2300, "platform": "x" }
]
```

**Field descriptions**:

| Field | Meaning |
|-------|---------|
| `date` | Time point (format depends on period: `YYYY-MM-DD` daily, `YYYY-MM-DD` weekly (Monday), `YYYY-MM` monthly) |
| `value` | Impressions for that time bucket (latest snapshot per integration, summed across integrations) |
| `platform` | Social platform identifier |

<details>
<summary>Technical implementation details (for developers)</summary>

**Algorithm**: Reads pre-aggregated DataTicks records (`type='impressions'`). Groups by (integration, time bucket), keeping only the latest snapshot per integration per bucket. Sums across integrations by (platform, bucket). Returns sorted by date then platform.

**Caching**: Redis cache (key includes period, integrationId, channel, date range), TTL 1 hour.

</details>

---

### 3.5 Post Engagement Aggregation

**Endpoint**: `GET /dashboard/post-engagement?days=30`

**Business scenario**: Operations staff want to understand content engagement from a **per-post perspective** — "How many total likes have my posts received? How many comments? Which platform's audience is most engaged?" This data helps evaluate content quality and compare audience activity across platforms.

**Optional parameters**:

| Parameter | Type | Default | Range | Meaning |
|-----------|------|---------|-------|---------|
| `days` | Integer | 30 | 1–90 | Analyze posts published within the last N days |

**What the user sees (example)**:

```
Post Engagement Overview (last 30 days, 55 posts analyzed)

  ┌──────────┬──────────┬──────────┬──────────┐
  │  Views    │  Likes    │ Comments  │  Saves    │
  │ 125,430  │  3,421   │   892    │   234    │
  └──────────┴──────────┴──────────┴──────────┘

  Breakdown by Platform:
  ┌───────────┬────────┬─────────┬───────┬──────────┬───────┐
  │ Platform   │ Posts   │ Views   │ Likes │ Comments │ Saves │
  ├───────────┼────────┼─────────┼───────┼──────────┼───────┤
  │ X          │  35    │ 85,000  │ 2,100 │   450    │  180  │
  │ Instagram  │  15    │ 32,000  │ 1,000 │   350    │   40  │
  │ LinkedIn   │   5    │  8,430  │   321 │    92    │   14  │
  └───────────┴────────┴─────────┴───────┴──────────┴───────┘

  ⚠ 2 posts failed to fetch data (platform API may be temporarily unavailable)
```

**Response structure**:
```json
{
  "totals": {
    "views": 125430,
    "likes": 3421,
    "comments": 892,
    "saves": 234
  },
  "by_platform": [
    {
      "platform": "x",
      "views": 85000,
      "likes": 2100,
      "comments": 450,
      "saves": 180,
      "post_count": 35
    }
  ],
  "meta": {
    "posts_analyzed": 55,
    "posts_failed": 2,
    "posts_total": 57,
    "days": 30
  }
}
```

**Field descriptions**:

| Field | Meaning | How to interpret |
|-------|---------|-----------------|
| **totals** | | |
| `totals.views` | Total views | Total number of times all posts were displayed/viewed |
| `totals.likes` | Total likes | Total number of likes/reactions received across all posts |
| `totals.comments` | Total comments | Total number of comments/replies received across all posts |
| `totals.saves` | Total saves | Total number of times posts were saved/bookmarked |
| **by_platform** | | |
| `platform` | Platform identifier | e.g., x, instagram, linkedin, youtube, facebook |
| `post_count` | Post count | Number of posts successfully analyzed on this platform |
| `views` / `likes` / `comments` / `saves` | Metrics | Totals for all posts on this platform |
| **meta** | | |
| `posts_analyzed` | Successfully analyzed | Number of posts for which data was successfully retrieved |
| `posts_failed` | Failed to fetch | Number of posts that failed due to platform API errors, etc. |
| `posts_total` | Total posts | Total number of posts included in the analysis (= analyzed + failed) |
| `days` | Lookback period | Time range for this query |

**Why do different platforms use different metric names?**

Different social platforms use different terminology for the same concepts. The system automatically maps them to 4 unified metrics:

| Unified metric | X (Twitter) | Instagram | YouTube | LinkedIn | Facebook |
|----------------|-------------|-----------|---------|----------|----------|
| **Views** | Impressions | Impressions, Reach | Views | Impressions, Unique Impressions | Impressions |
| **Likes** | Likes | Likes | Likes | Likes | Reactions |
| **Comments** | Replies | Comments | Comments | Comments | — |
| **Saves** | Bookmarks | Saves | Favorites | — | — |

> **Note**: If a platform does not provide a certain metric (marked with "—" in the table), that metric's value will be 0 for that platform, but this does not affect the overall statistics.

<details>
<summary>Technical implementation details (for developers)</summary>

**Algorithm**:
1. Check Redis cache (key: `dashboard:post-engagement:${orgId}:${days}`)
2. Call `_fetchAllPostAnalytics(org, days)` which queries published posts and fetches analytics via batch or per-post APIs
3. Cross-platform metric normalization (regex classification):
   - `VIEWS_RE = /^(impression|views|reach|unique.impression)/i`
   - `LIKES_RE = /^(like|reaction)/i`
   - `COMMENTS_RE = /^(comment|repl)/i`
   - `SAVES_RE = /^(save|bookmark|favorite)/i`
4. Accumulate into totals + group by platform in platformMap
5. Write result to Redis (TTL 1 hour), return

**Data fetch pipeline** (inside `_fetchAllPostAnalytics`):
- Groups posts by integration, uses `batchPostAnalytics()` when available, falls back to `checkPostAnalytics()` per-post
- Circuit breaker: after 2 consecutive failures for a platform, remaining posts for that platform are skipped
- Automatic token expiration handling: check `tokenExpiration` → call `RefreshIntegrationService.refresh()` → retry
- Individual post analytics are independently cached (key: `integration:${orgId}:${postId}:${date}`, TTL 1 hour)

</details>

---

## 4. Data Refresh & Caching

### How often is data updated?

The dashboard uses **two data refresh strategies**:

**Pre-aggregated data (Summary, Traffics, Impressions):**
```
Background sync:      Temporal workflow runs daily @ UTC 00:05
                      → Fetches post-level analytics for all orgs
                      → Upserts DataTicks records
                      → Invalidates Redis cache

User request:         Check Redis cache → return if hit (TTL 1hr)
                      → Cache miss: query DataTicks table → cache result → return
```

**Real-time data (Post Engagement):**
```
First request:        User opens page → Real-time API calls to each platform → Return data → Store in cache
                                         (may take 3–15 seconds)

Within 1 hour:        User opens page → Return cached data immediately
                                         (millisecond response)

After cache expires:  Back to the first-request flow
```

### Caching strategy overview

| Feature | Cache duration | Cache key pattern | Notes |
|---------|---------------|-------------------|-------|
| Summary | 1 hour | `dashboard:summary:${orgId}:${start}:${end}:${intKey}:${chKey}:${tz}` | Invalidated by DataTicks sync |
| Traffic Analysis | 1 hour | `dashboard:traffics:${orgId}:${intKey}:${chKey}:${sdKey}:${edKey}` | Invalidated by DataTicks sync |
| Impressions Trend | 1 hour | `dashboard:impressions:${orgId}:${period}:${intKey}:${chKey}:${sdKey}:${edKey}` | Invalidated by DataTicks sync |
| Post Engagement | 1 hour | `dashboard:post-engagement:${orgId}:${days}` | On-demand fetch + cache |
| Posts Trend | No cache | — | Database query only, fast enough |

> **Development environment**: Cache duration is reduced to 1 second for quick iteration during debugging.

### Background sync details

The `dataTicksSyncWorkflow` Temporal workflow runs continuously, scheduling daily syncs at UTC 00:05:

1. Fetches all active integrations grouped by organization
2. For each org, queries published posts from the last 30+ days
3. Calls `batchPostAnalytics()` or `postAnalytics()` per post to get metrics
4. Extracts impressions and computes traffic scores
5. Upserts DataTicks records (only for integrations with `postsAnalyzed > 0`)
6. Invalidates all dashboard cache keys for the org
7. Admin backfill available via `POST /admin/dashboard/data-ticks/backfill?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD`

See `docs/data-ticks-module.md` for the complete DataTicks design documentation.

---

## 5. Error Handling & Fault Tolerance

The Dashboard connects to multiple external social platforms, any of which could experience API issues. The design principle is **partial failure does not affect the whole**:

| Scenario | System behavior | Impact on user |
|----------|----------------|----------------|
| A platform API is temporarily unavailable | Skip that platform; data from other platforms returns normally | That platform's data may be missing or show as 0 |
| Platform access token has expired | Automatically refresh the token and retry once | User doesn't notice — may only be slightly slower |
| Token refresh fails | Skip that integration, return empty data | User needs to re-authorize that channel |
| A post has been deleted on the platform | That post returns empty data, not counted in statistics | Does not affect other posts |
| Some posts fail during analytics fetch | Circuit breaker skips remaining posts for that platform after 2 failures | Affected platform's numbers may be lower than actual |
| Platform doesn't implement `postAnalytics` | Posts from that platform return empty metrics | Analytics show 0 for that platform, but post counts are still accurate |
| DataTicks sync fails for an org | Previous day's ticks are retained | Data may be 1 day stale; retries on next sync |

---

## 6. Data Security & Isolation

- **Multi-tenant isolation**: Each organization can only see its own data. All queries use the organization ID as a filter, which is automatically extracted from the login session. Cross-organization access is not possible.
- **Soft delete**: Deleted posts and channels do not appear in any statistics.
- **Token security**: Access tokens for each social platform are managed on the backend and are never exposed to the frontend.

---

## 7. Technical Architecture Reference (for Developers)

<details>
<summary>Click to expand technical architecture details</summary>

### Files involved

| Layer | File path |
|-------|-----------|
| Controller | `apps/backend/src/api/routes/dashboard.controller.ts` |
| Service | `libraries/nestjs-libraries/src/database/prisma/dashboard/dashboard.service.ts` |
| Repository | `libraries/nestjs-libraries/src/database/prisma/dashboard/dashboard.repository.ts` |
| DTO | `libraries/nestjs-libraries/src/dtos/dashboard/dashboard.dto.ts` |
| Date Utils | `libraries/helpers/src/utils/date.utils.ts` — `parseDate()` / `parseDateToUTC()` |
| DataTicks Service | `libraries/nestjs-libraries/src/database/prisma/data-ticks/data-ticks.service.ts` |
| DataTicks Repository | `libraries/nestjs-libraries/src/database/prisma/data-ticks/data-ticks.repository.ts` |
| Traffic Calculator | `libraries/nestjs-libraries/src/integrations/social/traffic.calculator.ts` |

### DTO parameter validation

```
DashboardSummaryQueryDto
├── startDate?: string   (ISO 8601 date string, optional)
├── endDate?: string     (ISO 8601 date string, optional)
├── integrationId?: string[]  (array, max 50, supports comma-separated)
├── channel?: string[]   (array, max 30, must be in VALID_CHANNELS)
├── Validation: @IsOptional, @IsDateString, @IsArray
├── Controller-level: BadRequestException if startDate > endDate

ImpressionsQueryDto
├── period?: 'daily' | 'weekly' | 'monthly'   (default: 'daily')
├── startDate?, endDate?, integrationId?, channel?  (same as above)

TrafficsQueryDto
├── startDate?, endDate?, integrationId?, channel?  (same as above)

PostsTrendQueryDto
├── period?: 'daily' | 'weekly' | 'monthly'   (default: 'daily')

PostEngagementQueryDto
├── days?: number   (default: 30, range: 1–90)
├── Validation: @IsOptional, @Type(() => Number), @IsInt, @Min(1), @Max(90)
```

### Architecture diagram

```
Controller                    Service                          Data Source
┌──────────────────┐   ┌──────────────────────┐   ┌──────────────────────┐
│ GET /summary     │──→│ getSummary()         │──→│ DataTicksService     │
│  ?startDate=     │   │  ├ Redis cache check  │   │  .getImpressions     │
│  &endDate=       │   │  ├ Normalize dates    │   │   SummaryByPlatform()│
│  &integrationId= │   │  ├ Parallel queries   │   │  .getTraffic         │
│  &channel=       │   │  ├ DataTicks summary  │   │   SummaryByPlatform()│
│                  │   │  └ Sum totals         │   ├──────────────────────┤
│                  │   │                       │   │ DashboardRepository  │
│                  │   │                       │   │  .getChannelCount()  │
│                  │   │                       │   │  .getPostsStats()    │
│                  │   │                       │   │  .getActiveIntegr()  │
│                  │   │                       │   └──────────────────────┘
│ GET /posts-trend │──→│ getPostsTrend()       │──→│ DashboardRepository  │
│                  │   │  └ Bucket & sort      │   │  .getPostsForTrend() │
│                  │   │                       │   └──────────────────────┘
│ GET /traffics    │──→│ getTraffics()         │──→│ DataTicksService     │
│                  │   │  └ Redis cache        │   │  .getTraffic         │
│                  │   │                       │   │   SummaryByPlatform()│
│                  │   │                       │   └──────────────────────┘
│ GET /impressions │──→│ getImpressions()      │──→│ DataTicksService     │
│                  │   │  └ Redis cache        │   │  .getImpressions     │
│                  │   │                       │   │   ByPlatform()       │
│                  │   │                       │   └──────────────────────┘
│GET /post-engage- │──→│ getPostEngagement()   │──→│ _fetchAllPost        │
│  ment            │   │  ├ Redis cache        │   │  Analytics()         │
│                  │   │  ├ Regex normalize    │   │  → platform APIs     │
│                  │   │  └ Group by platform  │   └──────────────────────┘
└──────────────────┘   └──────────────────────┘
```

### Design principles

1. **Post-level only**: All analytics data comes from post-level APIs (`batchPostAnalytics` / `postAnalytics`), never from account-level APIs. This ensures only Postiz-managed content is measured.
2. **Two-pipeline architecture**: Pre-aggregated DataTicks for summary/trend endpoints (fast reads), real-time fetch for detailed engagement (fresh data).
3. **Multi-tenant isolation**: All queries are scoped by `orgId`
4. **Soft delete**: All database queries filter `deletedAt IS NULL`
5. **Graceful degradation**: Single platform/post failure does not cause overall failure
6. **Background sync with cache invalidation**: DataTicks sync runs daily and invalidates relevant dashboard caches
7. **Flexible time granularity**: Daily/weekly/monthly aggregation; weekly uses ISO 8601 standard
8. **Batched concurrency control**: 5 posts per concurrent batch to avoid platform API rate limits
9. **Circuit breaker**: Stops API calls to a platform after 2 consecutive failures

</details>
