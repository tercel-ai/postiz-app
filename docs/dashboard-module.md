# Dashboard Module — Feature Documentation

## 1. Module Overview

### What does this module do?

The Dashboard provides a **one-stop summary of social media operations data** for each organization. On the dashboard page, users can quickly see:

- How many posts have been published and how many social accounts are connected
- Impressions and traffic trends across platforms
- How many likes, comments, and saves each post has received on each platform

**Important: All analytics data (impressions, traffic, engagement) is scoped to posts published through Postiz only.** Data from posts created directly on social platforms (outside Postiz) is not included. This ensures consistent and accurate measurement of content managed through the system.

Data is sourced from official post-level APIs of each social platform (such as X/Twitter API, Instagram Graph API, YouTube Data API, LinkedIn API, etc.). The system fetches the latest data in real time when a user views the dashboard, and caches it for 1 hour to avoid excessive API requests.

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

All dashboard analytics endpoints use a **unified post-level data pipeline** (`_fetchAllPostAnalytics`):

```
┌─────────────────────────────────────────────────────────────────────┐
│                    _fetchAllPostAnalytics()                         │
│                                                                     │
│  1. Query DB for published posts (state=PUBLISHED, releaseId!=null) │
│  2. Group posts by integration (account)                            │
│  3. For each integration group:                                     │
│     ├─ Batch path: provider.batchPostAnalytics() if available       │
│     └─ Fallback: per-post provider.postAnalytics() with circuit     │
│        breaker (5 concurrent, fail threshold = 2)                   │
│  4. Return Map<postId, { metrics, platform }>                       │
└─────────────────────────────────────────────────────────────────────┘
         │
         ▼  Consumed by:
   ┌─────────────┬──────────────┬──────────────┬──────────────────┐
   │ getSummary() │ getTraffics()│getImpressions│getPostEngagement │
   │ impressions  │ traffic by   │ impressions  │ views/likes/     │
   │ + traffic    │ platform     │ by date      │ comments/saves   │
   │ totals       │ + delta      │              │ by platform      │
   └─────────────┴──────────────┴──────────────┴──────────────────┘
```

### Metrics Data Source Summary

| Endpoint | Metric | Data source | Scope |
|----------|--------|-------------|-------|
| **Summary** `impressions_total` | Impressions | Post-level `postAnalytics()` | Postiz posts only, last 30 days |
| **Summary** `traffics_total` | Traffic/Clicks | Post-level `postAnalytics()` | Postiz posts only, last 30 days |
| **Summary** `posts_stats` | Post counts | Database query | All Postiz posts (no limit) |
| **Summary** `channel_count` | Channel count | Database query | All active integrations |
| **Impressions Trend** | Impressions by date | Post-level `postAnalytics()` | Postiz posts only, last 30 days |
| **Traffic Analysis** | Traffic by platform | Post-level `postAnalytics()` | Postiz posts only, last 30 days |
| **Post Engagement** | Views/Likes/Comments/Saves | Post-level `postAnalytics()` | Postiz posts only, configurable 1–90 days |
| **Posts Trend** | Post count by date | Database query | All Postiz posts (no limit) |

### Known Factors That May Cause Inaccuracy

| Factor | Impact | Severity |
|--------|--------|----------|
| **High post volume** | `getPublishedPostsWithRelease` fetches all posts (no limit). For users with very high post volumes, the first uncached request may be slow. Circuit breaker and per-post caching mitigate this. | Low |
| **Platforms without `postAnalytics`** | ~19 platforms (Reddit, Bluesky, Mastodon, TikTok, etc.) return empty analytics. Posts from these platforms have 0 impressions/traffic/engagement. | High (if user primarily uses these platforms) |
| **API failures / rate limiting** | Posts that fail to fetch are skipped. Circuit breaker stops trying after 2 consecutive failures per platform. `postsFailed` tracks the count but is only visible in the Post Engagement endpoint's `meta`. | Low |
| **Cache staleness** | Each endpoint has its own Redis cache (1hr prod / 1s dev). Per-post analytics also cached independently. Different endpoints may reflect data from different points in time. | Low |
| **Post deleted on platform** | If a post was published via Postiz but later deleted on the platform, `postAnalytics()` returns empty — that post's metrics are lost. | Low |
| **Traffic metrics rarely available at post level** | Most platforms' `postAnalytics()` do not return click/engagement/traffic metrics (X returns Impressions, Likes, Retweets, Replies, Quotes, Bookmarks — none match `TRAFFICS_RE`). `traffics_total` will likely be 0 for most platforms. | Medium |
| **Regex classification overlap** | `IMPRESSIONS_RE` and `VIEWS_RE` have slightly different patterns. Summary uses `IMPRESSIONS_RE` (includes `page.views`); Post Engagement uses `VIEWS_RE` (includes `unique.impression`). In practice the difference is minimal. | Low |

---

## 3. Detailed Feature Descriptions

### 3.1 Summary

**Endpoint**: `GET /dashboard/summary`

**Business scenario**: The first screen users see when entering the dashboard. Provides an at-a-glance view of overall operational performance, with optional date range filtering for post statistics.

**Optional parameters**:

| Parameter | Type | Default | Validation | Meaning |
|-----------|------|---------|------------|---------|
| `startDate` | ISO 8601 date string | — (no filter) | `@IsDateString()` | Start of the date range for post statistics (inclusive, normalized to start of day) |
| `endDate` | ISO 8601 date string | — (no filter) | `@IsDateString()` | End of the date range for post statistics (inclusive, normalized to end of day) |

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
│  30-day Total Traffic        12,000 clicks            │
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
  }
}
```

**Field descriptions**:

| Field | Meaning | How to interpret |
|-------|---------|-----------------|
| `channel_count` | Total number of channels | Number of connected and enabled social accounts |
| `channels_by_platform` | Channels by platform | Grouped by platform, e.g., 2 Twitter accounts connected |
| `impressions_total` | Total impressions | Sum of impressions from all Postiz-managed published posts in the last 30 days |
| `traffics_total` | Total traffic | Sum of click/engagement/traffic metrics from all Postiz-managed published posts in the last 30 days. Note: most platforms do not return traffic metrics at post level, so this value may be 0. |
| **posts_stats** | | |
| `posts_stats.total` | Total posts | All posts matching the date filter (or all posts if no filter). Sum of all states below. |
| `posts_stats.scheduled` | Scheduled posts | Posts in `QUEUE` state (waiting to be published) |
| `posts_stats.published` | Published posts | Posts in `PUBLISHED` state |
| `posts_stats.drafts` | Draft posts | Posts in `DRAFT` state |
| `posts_stats.errors` | Error posts | Posts in `ERROR` state (publishing failed) |

**How does date filtering work?**

- When `startDate` and/or `endDate` are provided, only posts whose `publishDate` falls within the range are counted in `posts_stats`.
- Dates are normalized: `startDate` → start of day (00:00:00), `endDate` → end of day (23:59:59.999). This means `?startDate=2026-03-01&endDate=2026-03-01` includes all posts on March 1st.
- When no date parameters are provided, all posts (excluding deleted) are counted — same behavior as before.
- Impressions and traffic totals are always based on the last 30 days and are **not** affected by the date filter.

**Impressions vs. Traffic — What's the difference?**

- **Impressions**: The number of times content appeared on a user's screen. For example, if your tweet appeared in someone's timeline 1,000 times, that counts as 1,000 impressions. The user doesn't need to click — just "seeing" it counts.
- **Traffic**: The number of times users actually clicked or interacted. For example, clicking a link, clicking an image, or other deliberate actions.

The system automatically categorizes metrics returned by each platform by matching their names:
- Names containing `impression`, `views`, `reach` → classified as Impressions
- Names containing `click`, `engagement`, `traffic` → classified as Traffic

<details>
<summary>Technical implementation details (for developers)</summary>

**Algorithm**:
1. Normalize `startDate` / `endDate` to day boundaries (`startOf('day')` / `endOf('day')`)
2. Check Redis cache (key includes normalized date timestamps) → return immediately if cache hit
3. Query in parallel: total channels + active integrations list + post stats grouped by state (with date filter)
4. Map `groupBy` results to `posts_stats` object (QUEUE→scheduled, PUBLISHED→published, DRAFT→drafts, ERROR→errors)
5. Group channels by platform
6. Call `_fetchAllPostAnalytics(org, 30)` to get post-level analytics for all published posts
7. Classify and accumulate using regex: `IMPRESSIONS_RE` / `TRAFFICS_RE`
8. Write result to Redis cache (TTL 1 hour), return

**Date validation**: The controller throws `BadRequestException` if `startDate > endDate`.

**Error handling**: If a single post's API call fails, it is silently skipped without affecting the overall response.

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

**Algorithm**: Queries post `publishDate` from the database, then groups into time buckets using a `dateKey|platform` composite key in a Map. Weekly aggregation uses the ISO 8601 standard, mapping dates to the Monday of their respective week.

**Caching**: This endpoint does not use Redis caching — it queries the database in real time (internal data only, so it's fast enough).

</details>

---

### 3.3 Traffic Analysis

**Endpoint**: `GET /dashboard/traffics`

**Business scenario**: Marketing staff want to know "which platform performs best" and "is traffic trending up or down" to inform resource allocation decisions.

> **Important**: Traffic data comes from **post-level analytics only** (posts published through Postiz). Most social platforms do not return click/engagement/traffic metrics in their post-level APIs, so traffic values may be 0 for many platforms. This is a platform API limitation, not a system bug.

**What the user sees (example)**:

```
Traffic Analysis by Platform (last 30 days)

  Twitter      ████████████████████  8,000 (66.67%)  ↑ 25.5%
  Instagram    ██████████            4,000 (33.33%)  ↓ -10.2%
  YouTube                                0 (0.00%)     0.0%
                                                     ──────
                                           Total     12,000
```

- **↑ 25.5%** means Twitter's traffic in the last 15 days grew by 25.5% compared to the prior 15 days (positive trend, shown in green)
- **↓ -10.2%** means Instagram's traffic declined by 10.2% (negative trend, shown in red)
- **YouTube** is connected but has no traffic data yet — it still appears in the list with all values at 0

**Response structure**:
```json
[
  {
    "platform": "twitter",
    "value": 8000,
    "percentage": 66.67,
    "delta": 25.5
  },
  {
    "platform": "instagram",
    "value": 4000,
    "percentage": 33.33,
    "delta": -10.2
  },
  {
    "platform": "youtube",
    "value": 0,
    "percentage": 0,
    "delta": 0
  }
]
```

> **Note**: All connected platforms always appear in the results, even if they have no traffic data. This ensures the frontend can display a complete view of all platforms the user has set up.

**Field descriptions**:

| Field | Meaning | How to interpret |
|-------|---------|-----------------|
| `platform` | Platform name | e.g., twitter, instagram, linkedin |
| `value` | 30-day total traffic | Total clicks/interactions from Postiz-managed posts on this platform in the last 30 days |
| `percentage` | Share (%) | This platform's traffic as a percentage of total traffic across all platforms |
| `delta` | Period-over-period change (%) | Percentage change comparing the last 15 days vs. the prior 15 days. Positive = growth, negative = decline |

**How is the period-over-period change calculated?**

The system splits the last 30 days into two halves for comparison:
```
        First half (days 16–30 ago)       Second half (last 0–15 days)
      ┌──────────────────┐          ┌──────────────────┐
      │   older = 3200   │          │  recent = 4000   │
      └──────────────────┘          └──────────────────┘

      delta = (4000 - 3200) / 3200 × 100 = 25%  → Traffic grew by 25%
```

Special cases:
- First half is 0 but second half has data → shows +100% (represents "new traffic")
- Both halves are 0 → shows 0%

<details>
<summary>Technical implementation details (for developers)</summary>

**Algorithm**: Pre-populates `platformValues` with all connected platforms (value 0) to ensure they always appear in results. Calls `_fetchAllPostAnalytics(org, 30)` to get post-level analytics, then filters for metrics matching `TRAFFICS_RE`. Splits data points into `platformRecent` / `platformOlder` Maps based on `midDate = 15 days ago`. Delta precision is kept to two decimal places (`Math.round(x * 10000) / 100`). Results are sorted by value in descending order.

**Caching**: Redis cache, TTL 1 hour.

</details>

---

### 3.4 Impressions Trend

**Endpoint**: `GET /dashboard/impressions?period=daily`

**Business scenario**: Product or marketing staff want to see "how content reach changes over time" to evaluate whether the content strategy is working.

**Optional parameters**: Same as Posts Trend (`daily` / `weekly` / `monthly`).

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
  { "date": "2026-02-01", "impressions": 1500 },
  { "date": "2026-02-02", "impressions": 2300 }
]
```

**Field descriptions**:

| Field | Meaning |
|-------|---------|
| `date` | Time point |
| `impressions` | Total impressions for that time period (aggregated across all platforms, Postiz posts only) |

> **How this differs from Posts Trend**: Impressions Trend data is **merged across all platforms** (all platform impressions are added together), not broken down by platform. This is because users care about "how many times was my content seen overall."

<details>
<summary>Technical implementation details (for developers)</summary>

**Algorithm**: Calls `_fetchAllPostAnalytics(org, 30)` to get post-level analytics, filters for metrics matching `IMPRESSIONS_RE`, and accumulates into time buckets by granularity.

**Caching**: Redis cache; cache key includes the period parameter, TTL 1 hour.

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
    },
    {
      "platform": "instagram",
      "views": 32000,
      "likes": 1000,
      "comments": 350,
      "saves": 40,
      "post_count": 15
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

**How is the data fetched?**

```
User opens the dashboard
    │
    ▼
① Check cache: has this been queried within the last hour?
    │
    ├── Yes → Return cached data immediately (millisecond response)
    │
    └── No → Start real-time fetch ▼

② Query the database for all posts published in the last N days
    │
    ▼
③ Fetch engagement data from each platform's API in batches
   (5 posts concurrently per batch to avoid rate limiting)
    │
    ├── Each post also has its own independent cache (1 hour); repeat posts use the cache
    │
    ├── If a platform token has expired → automatically refresh the token and retry
    │
    └── If a specific post request fails → skip it, does not affect other posts
    │
    ▼
④ Aggregate all successfully fetched data grouped by platform
    │
    ▼
⑤ Write result to cache, return to frontend
```

**Frequently asked questions**:

| Question | Answer |
|----------|--------|
| Is the data real-time? | The first request fetches data from platform APIs in real time. Subsequent requests within 1 hour return cached data. So data can be up to 1 hour old. |
| Is there a post limit? | No hard limit. All published posts in the time range are analyzed. Per-post results are cached (1 hour), so subsequent requests are fast. A circuit breaker stops API calls to a platform after 2 consecutive failures. |
| Why do some posts fail to fetch? | Possible reasons: temporary platform API outage, the post was deleted on the platform, or the platform doesn't support post-level analytics. The failure count is shown in `meta.posts_failed`. |
| Will the second visit to the dashboard be faster? | Yes. The second request hits the Redis cache, with response times typically in milliseconds. |
| What happens when a new social account is connected? | Posts published from the new account are automatically included in the statistics — no additional configuration needed. |

<details>
<summary>Technical implementation details (for developers)</summary>

**Algorithm**:
1. Check Redis cache (key: `dashboard:post-engagement:{orgId}:{days}`)
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
- Individual post analytics are independently cached (key: `integration:{orgId}:{postId}:{date}`, TTL 1 hour)

</details>

---

## 4. Data Refresh & Caching

### How often is data updated?

All Dashboard data uses an **on-demand fetch + cache** strategy:

```
First request:        User opens page → Real-time API calls to each platform → Return data → Store in cache
                                         (may take 3–15 seconds)

Within 1 hour:        User opens page → Return cached data immediately
                                         (millisecond response)

After cache expires:  Back to the first-request flow
```

### Caching strategy overview

| Feature | Cache duration | Notes |
|---------|---------------|-------|
| Summary | 1 hour | Includes channel count, impressions/traffic totals, posts stats by state. Cache key varies by date range. |
| Traffic Analysis | 1 hour | Per-platform traffic and period-over-period changes |
| Impressions Trend | 1 hour | Separate cache for each time granularity |
| Post Engagement | 1 hour | Both aggregate result cache + individual post analysis cache |
| Posts Trend | No cache | Data comes from internal database — fast enough without caching |

> **Development environment**: Cache duration is reduced to 1 second for quick iteration during debugging.

### Doesn't the system sync data automatically in the background?

Currently, no. Dashboard data is **fetched on demand when the user opens the page** — there are no background sync jobs. However, the system does automatically refresh each social platform's access tokens via background tasks, ensuring tokens are always valid when users need data.

---

## 5. Error Handling & Fault Tolerance

The Dashboard connects to multiple external social platforms, any of which could experience API issues. The design principle is **partial failure does not affect the whole**:

| Scenario | System behavior | Impact on user |
|----------|----------------|----------------|
| A platform API is temporarily unavailable | Skip that platform; data from other platforms returns normally | That platform's data may be missing or show as 0 |
| Platform access token has expired | Automatically refresh the token and retry once | User doesn't notice — may only be slightly slower |
| Token refresh fails | Disconnect that channel, return empty data | User needs to re-authorize that channel |
| A post has been deleted on the platform | That post returns empty data, not counted in statistics | Does not affect other posts |
| Some posts fail during analytics fetch | Circuit breaker skips remaining posts for that platform after 2 failures | Affected platform's numbers may be lower than actual |
| Platform rate-limits API requests (429) | Automatically wait 5 seconds and retry (up to 3 retries) | User may experience slightly slower response |
| A connected platform has no data yet | Platform still appears in results with all values at 0 | User sees a complete list of all connected platforms — no confusion about missing platforms |
| Platform doesn't implement `postAnalytics` | Posts from that platform return empty metrics | Analytics show 0 for that platform, but post counts are still accurate |

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

### DTO parameter validation

```
DashboardSummaryQueryDto
├── startDate?: string   (ISO 8601 date string, optional)
├── endDate?: string     (ISO 8601 date string, optional)
├── Validation: @IsOptional, @IsDateString
├── Controller-level: BadRequestException if startDate > endDate

PostsTrendQueryDto / ImpressionsQueryDto
├── period?: 'daily' | 'weekly' | 'monthly'   (default: 'daily')
├── Validation: @IsOptional, @IsString, @IsIn(['daily', 'weekly', 'monthly'])

PostEngagementQueryDto
├── days?: number   (default: 30, range: 1–90)
├── Validation: @IsOptional, @Type(() => Number), @IsInt, @Min(1), @Max(90)
```

### Database query layer (Repository)

| Method | Purpose | Filter conditions |
|--------|---------|------------------|
| `getChannelCount(orgId)` | Count total channels | `organizationId = orgId AND deletedAt IS NULL AND disabled = false` |
| `getActiveIntegrations(orgId)` | Get active integrations | `organizationId = orgId AND deletedAt IS NULL AND disabled = false AND type = 'social'` |
| `getPostsStats(orgId, startDate?, endDate?)` | Count posts grouped by state | `organizationId = orgId AND deletedAt IS NULL [AND publishDate >= startDate] [AND publishDate <= endDate]`, `GROUP BY state` |
| `getPostsForTrend(orgId, sinceDays)` | Query post publishing trend | `organizationId = orgId AND deletedAt IS NULL AND publishDate >= (NOW - sinceDays)` |
| `getPublishedPostsWithRelease(orgId, sinceDays)` | Query published posts (with platform association) | `state = 'PUBLISHED' AND releaseId IS NOT NULL AND publishDate >= (NOW - sinceDays) no limit` |

### Redis cache keys

| Cache key pattern | TTL | Used by |
|-------------------|-----|---------|
| `dashboard:summary:{orgId}:{startTimestamp\|'all'}:{endTimestamp\|'all'}` | Dev 1s / Prod 3600s | `/summary` |
| `dashboard:traffics:{orgId}` | Same | `/traffics` |
| `dashboard:impressions:{orgId}:{period}` | Same | `/impressions` |
| `dashboard:post-engagement:{orgId}:{days}` | Same | `/post-engagement` |
| `integration:{orgId}:{postId}:{date}` | Same | Individual post analytics cache |

### Architecture diagram

```
Controller                    Service                          Repository / External deps
┌──────────────────┐   ┌──────────────────────┐   ┌──────────────────────┐
│ GET /summary     │──→│ getSummary()         │──→│ getChannelCount()    │
│  ?startDate=     │   │  ├ Redis cache check  │   │ getActiveIntegrations│
│  &endDate=       │   │  ├ Normalize dates    │   │ getPostsStats()      │
│                  │   │  ├ Parallel queries   │   └──────────────────────┘
│                  │   │  ├ Map state→stats    │
│                  │   │  ├ _fetchAllPost      │
│                  │   │  │  Analytics()       │──→ PostsService / Providers
│                  │   │  └ Regex classify &   │
│                  │   │    accumulate         │
│ GET /posts-trend │──→│ getPostsTrend()       │──→│ getPostsForTrend()   │
│                  │   │  └ Bucket & sort      │   └──────────────────────┘
│ GET /traffics    │──→│ getTraffics()         │──→│ _fetchAllPost        │
│                  │   │  ├ Redis cache        │   │  Analytics()         │
│                  │   │  ├ Split 30 days in   │   └──────────────────────┘
│                  │   │  │ half                │
│                  │   │  └ Calculate delta     │
│ GET /impressions │──→│ getImpressions()      │──→│ _fetchAllPost        │
│                  │   │  ├ Redis cache        │   │  Analytics()         │
│                  │   │  └ Aggregate by time  │   └──────────────────────┘
│                  │   │    granularity        │
│GET /post-engage- │──→│ getPostEngagement()   │──→│ _fetchAllPost        │
│  ment            │   │  ├ Redis cache        │   │  Analytics()         │
│                  │   │  ├ Regex normalize    │   └──────────────────────┘
│                  │   │  │ metrics            │
│                  │   │  └ Group by platform  │
└──────────────────┘   └──────────────────────┘
```

### Shared analytics pipeline: `_fetchAllPostAnalytics()`

All analytics endpoints share a single private method that handles the complete post-level analytics fetch:

1. Query `getPublishedPostsWithRelease(orgId, days)` — all published posts in time range
2. Query `getActiveIntegrations(orgId)` — for token management
3. Group posts by `integrationId`
4. For each integration group:
   - **Batch path**: If the provider implements `batchPostAnalytics()`, fetch all posts in one API call
   - **Fallback path**: Call `checkPostAnalytics()` per post, 5 concurrent, with circuit breaker (stops after 2 consecutive failures per platform)
5. Returns `{ analyticsMap, postsFailed, postsTotal }`

### Metric classification regex

**Used by Summary / Traffics / Impressions Trend** (classify raw post-level metrics):
- `IMPRESSIONS_RE = /impression|views|page.views|reach/i`
- `TRAFFICS_RE = /click|engagement|traffic/i`

**Used by Post Engagement** (classify into 4 unified metrics):
- `VIEWS_RE = /^(impression|views|reach|unique.impression)/i`
- `LIKES_RE = /^(like|reaction)/i`
- `COMMENTS_RE = /^(comment|repl)/i`
- `SAVES_RE = /^(save|bookmark|favorite)/i`

### Design principles

1. **Post-level only**: All analytics data comes from post-level APIs (`postAnalytics`), never from account-level APIs. This ensures only Postiz-managed content is measured.
2. **Multi-tenant isolation**: All queries are scoped by `orgId`
3. **Soft delete**: All database queries filter `deletedAt IS NULL`
4. **Graceful degradation**: Single platform/post failure does not cause overall failure
5. **Flexible time granularity**: Daily/weekly/monthly aggregation; weekly uses ISO 8601 standard
6. **Two-level caching**: Redis cache reduces third-party API call volume
7. **Regex-driven metric classification**: Automatically normalizes metric names across platforms
8. **Batched concurrency control**: 5 posts per concurrent batch to avoid platform API rate limits
9. **No artificial post limit**: All published posts in the time range are analyzed; circuit breaker and caching prevent runaway API calls
10. **Shared pipeline**: `_fetchAllPostAnalytics()` is the single source of truth for all analytics endpoints, ensuring consistent data across the dashboard

</details>
