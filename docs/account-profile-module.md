# Account Profile Module

## 1. Overview
The Account Profile module surfaces **how the user's Postiz-published content is
performing** on a connected social media account, plus basic account-wide
totals (followers, lifetime post count, etc.) for context. It is **not** a
mirror of the platform's native analytics dashboard — see §4.1 for the exact
scope split.

## 2. Features
- **Profile Summary**: Displays the account's avatar, name, and internal platform ID.
- **Postiz Post Performance (scope: Postiz posts only, last 30 days)**:
  - **Posts Count (`postsCount`)**: Count of posts published through Postiz
    for this integration. Not the account's lifetime post count on the
    platform.
  - **Performance Metrics (`stats.*`)**: Aggregated Impressions, Likes,
    Replies, Retweets, Quotes, and Bookmarks **across Postiz-published posts
    in the last 30 days**. Cached in Redis for 1 hour.
  - **Platform Indicators**: Visual representation of the social media platform (e.g., X, Reddit, YouTube).
- **Account-Wide Totals (scope: full platform account, not Postiz-scoped)**:
  - Exposed under `integration.additionalSettings` as `account:*` keys,
    written by the periodic `accountMetrics()` sync. Contents vary per
    platform (e.g. `account:followers`, `account:karma` for Reddit,
    `account:posts` = total videos for YouTube). See §5 for the full list.
- **Account Metadata**:
  - **Connection Date**: The date when the account was first integrated into Postiz.
  - **User Context**: Displays the system user email associated with the integration.

## 3. Data Sources & Architecture

### 3.1 Backend API
- **Endpoint**: `GET /integrations/profile/:id`
- **Controller**: `IntegrationsController`
- **Logic**:
  1. Fetch `Integration` details from the database.
  2. Count associated `Post` records for the specific integration ID.
  3. Invoke `IntegrationService.getPostsLevelAnalytics()` to fetch analytics for Postiz-published posts only (using `batchPostAnalytics` or per-post `postAnalytics` APIs). Results are cached in Redis for 1 hour.
  4. Return a consolidated JSON response including profile info, post counts, and analytics.

### 3.2 Frontend Component
- **Path**: `apps/frontend/src/components/integration/account.profile.tsx`
- **Page**: `apps/frontend/src/app/(app)/(site)/integrations/[id]/page.tsx` (Dynamic Route)
- **State Management**: Uses `useSWR` for data fetching and caching.
- **UI Design**: A card-based layout inspired by modern social media dashboards, supporting both Light and Dark modes.

## 4. Response Shape

```jsonc
{
  "integration": {
    "id": "...", "name": "...", "picture": "...",
    "providerIdentifier": "x" | "linkedin" | "linkedin-page" | ...,
    "additionalSettings": "[{\"title\":\"account:followers\",\"value\":123}, ...]"
  },
  "postsCount": 5,
  "stats": {
    "followers":  number | null,
    "impressions": number | null,
    "likes":      number | null,
    "replies":    number | null,
    "retweets":   number | null,
    "quotes":     number | null,
    "bookmarks":  number | null
  },
  "userEmail": "..."
}
```

### 4.1 Data Scope — Two Very Different Things

The response mixes two fundamentally different scopes. **Do not conflate them
in UI labels or client-side aggregations.**

| Field | Scope | Source | Meaning |
| :--- | :--- | :--- | :--- |
| `integration.additionalSettings.account:*` | **Account-wide total on the platform** | Periodic `accountMetrics()` sync via `DataTicksService` | The lifetime/current value as reported by the platform for the entire account (e.g. all followers the account has ever gained, every post the user has ever published on the platform — **not just via Postiz**). |
| `stats.*` | **Postiz-published posts only, last 30 days** | `IntegrationService.getPostsLevelAnalytics()` via `batchPostAnalytics()` / `postAnalytics()` | Aggregate across the set of posts that were **created through Postiz and published in the last 30 days**, using each post's platform ID (`releaseId`). Does not include posts the user authored natively on the platform. |
| `postsCount` | **Postiz post groups, lifetime, any state except soft-deleted** | `Post` table `groupBy({ by: ['group'] })` filtered by `integrationId` and `deletedAt: null` | Count of distinct **post groups** Postiz has ever created for this integration. A group is one scheduling unit (a single tweet, a thread, a multi-attachment post). Includes drafts, scheduled, published, and errored states — not just posts that reached the platform. |

Concrete example: for an X account with 10,000 lifetime tweets of which 3
single-tweet groups (one of which has 2 replies = 1 thread) were scheduled
through Postiz over the account's history, the response will report:

- `additionalSettings.account:posts` → `10000` (lifetime on X, from `v2/users/me`)
- `postsCount` → `3` (distinct Postiz groups, lifetime, including the thread as one group)
- `stats.impressions` → sum of impressions across Postiz-published posts
  **in the last 30 days only** — not the account's 30-day total reach, not
  the lifetime Postiz post count.

This is intentional: the Account Profile view is about **how Postiz-scheduled
content is performing**, not a mirror of the platform's native analytics
dashboard. If you need account-wide 30-day metrics, that is out of scope for
this endpoint.

### 4.2 `stats` Field Assignment Rule

`IntegrationsController.getIntegrationProfile` lowercases each analytics `label`
and matches it by `String.includes()`:

| `stats` field | Label substring match |
| :--- | :--- |
| `followers`   | `follower` &#124; `subscriber` &#124; `karma` |
| `impressions` | `impression` |
| `likes`       | `like` |
| `replies`     | `reply` |
| `retweets`    | `retweet` |
| `quotes`      | `quote` |
| `bookmarks`   | `bookmark` |

Labels that do not match any of the keywords above are silently discarded. This
is why several platform-native metrics (Views, Reach, Saves, Clicks, Upvotes,
Shares, Boosts, Reposts, etc.) never appear in `stats` today.

### 4.3 Data Freshness & Sync Timing

Three sync points drive when values in `additionalSettings.account:*` and
`stats.*` become current.

| Trigger | What runs | Where it lives | Affects |
| :--- | :--- | :--- | :--- |
| **Connect / re-authorize an integration** | `DataTicksService.syncAccountMetricsById(id, skipCooldown=true)` awaited inline after `createOrUpdateIntegration`, capped at 5 s via `Promise.race` | `integrations.controller.ts` — the `POST /integrations/social/:integration/connect` handler | `additionalSettings.account:*` is populated **before the connect response returns**. Bypasses the pre-sync cooldown check, then primes the cooldown key after a successful sync so the immediately following `/integrations/list` does not re-call the provider. |
| **Any call to `GET /integrations/list`** | `syncAccountMetricsById(id)` fire-and-forget for every integration in the org (no `await`) | `integrations.controller.ts:121` | Opportunistic refresh. Each integration is serialized by the `account-metrics:cooldown:{id}` Redis key for 1 hour, so repeated list calls do not hammer provider APIs. |
| **Daily Temporal cron at UTC 00:05** | `DataTicksService.syncDailyTicks()` → `_syncAccountMetrics()` for all active integrations | `data-ticks.service.ts:70` | Backstop that keeps stale accounts fresh even if no user interaction happens. |

**Post-level `stats.*` has a separate cache**: results of
`getPostsLevelAnalytics()` are cached in Redis for 1 hour under
`posts-analytics:{orgId}:{integrationId}:30` and are only computed on demand
when the profile page loads — never pre-warmed.

#### Timing Table — What's In `additionalSettings` At Each Moment

| Moment | X | linkedin-page | linkedin (personal) |
| :--- | :--- | :--- | :--- |
| Immediately after connect / re-auth returns | `Verified`, `account:{followers,following,posts,listed}` | `account:followers` | `[]` (no `accountMetrics` implementation) |
| After first user-facing post goes through Postiz + `GET /integrations/profile/:id` | `stats.*` populated for the 6 matching fields | `stats.{impressions, likes}` | `stats.{impressions, likes}` |
| Next UTC 00:05 | Full refresh | Full refresh | Still `[]` |

#### Why `skipCooldown=true` On Connect

The 1-hour Redis cooldown exists to serialize background syncs triggered by
`/integrations/list`. Without `skipCooldown`, a just-connected integration
whose cooldown key was recently set (e.g. by a prior disable/re-enable cycle,
or by an admin using the `/admin/dashboard/account-metrics/:id` endpoint
earlier) would silently skip the sync and ship stale data. Bypassing the lock
at the explicit connect/re-auth moment is safe because the user is already
waiting on one provider API call (OAuth exchange) — one more is bounded.

After a successful forced sync, `syncAccountMetricsById` primes the cooldown
key regardless of the `skipCooldown` flag. This prevents the
`/integrations/list` fire-and-forget loop from immediately re-calling the
provider for the same integration within the hour.

#### Failure & Timeout Handling

The inline sync is wrapped in `try/catch` and `Promise.race` with a 5-second
timeout. The connect response still succeeds in any of these cases:

- `accountMetrics()` throws or the provider API returns an error
- Provider API stalls past 5 s (timeout rejects with
  `account-metrics-sync-timeout-5s`)
- Provider has no `accountMetrics()` implementation (returns `null` fast)

A `[integrations.connect] immediate account metrics sync failed` warning is
logged in each failure case. The next `/integrations/list` call or the daily
UTC 00:05 cron will backfill.

## 5. Platform Data Inventory

Each table has three rows with different scopes — re-read §4.1 if the
distinction is not crystal clear:

- **`additionalSettings` (account-wide)** — lifetime/current totals for the
  whole platform account, written under the `account:*` prefix.
- **`stats.*` (Postiz posts, last 30d)** — fields populated for this provider
  given the current label-matching rules. Aggregated **only** over posts
  created via Postiz in the last 30 days.
- **Dropped labels (Postiz posts, last 30d)** — metrics the provider fetches
  at the post level but that the controller discards. Same Postiz-30d scope —
  even if we mapped them to new `stats` fields, they would still not reflect
  the account's native activity.

### 5.1 X (`x`)

Official API: `GET /2/users/me?user.fields=public_metrics`,
`GET /2/tweets?tweet.fields=public_metrics`
([X API v2 data dictionary](https://docs.x.com/x-api/fundamentals/data-dictionary)).

| Field | Value |
| :--- | :--- |
| `additionalSettings` (account total) | `Verified` (checkbox), `account:followers`, `account:following`, `account:posts`, `account:listed` |
| `stats.*` populated (Postiz posts, 30d) | `impressions`, `likes`, `replies`, `retweets`, `quotes`, `bookmarks` |
| Dropped labels (Postiz posts, 30d) | — |

`Verified` reflects `verified_type ∈ {blue, business, government}` or the
legacy `verified` flag. `stats.followers` is `null` by design: followers are an
account-wide value, not a per-post metric, so they live under
`additionalSettings.account:followers` and are never populated by `stats`.

### 5.2 LinkedIn Personal (`linkedin`)

Official API: `GET /v2/socialActions/{urn}`
([Social Actions API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/social-actions-api)).

| Field | Value |
| :--- | :--- |
| `additionalSettings` (account total) | **none** — `LinkedinProvider` does not implement `accountMetrics()` because LinkedIn does not expose personal follower/connection counts without restricted scopes (`r_1st_connections_size`, not requested by Postiz). |
| `stats.*` populated (Postiz posts, 30d) | `impressions`, `likes` |
| Dropped labels (Postiz posts, 30d) | `Comments`, `Shares`, `Reach` |

### 5.3 LinkedIn Page (`linkedin-page`)

Official API: `GET /v2/organizationalEntityShareStatistics`,
`GET /v2/networkSizes/{org-urn}?edgeType=CompanyFollowedByMember`
([Share Statistics](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/share-statistics),
[Network Sizes](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/network-sizes)).

| Field | Value |
| :--- | :--- |
| `additionalSettings` (account total) | `account:followers` (from `firstDegreeSize`) |
| `stats.*` populated (Postiz posts, 30d) | `impressions`, `likes` |
| Dropped labels (Postiz posts, 30d) | `Clicks`, `Comments`, `Shares`, `Engagement` |

**Known quirk:** both `Impressions` and `Unique Impressions` labels are emitted
and both match the `impression` rule. The loop assigns in emission order, so
`stats.impressions` ends up holding the **Unique Impressions** value.

### 5.4 Facebook (`facebook`)

Official API: `GET /v21.0/{page-id}?fields=fan_count,followers_count`,
`GET /v21.0/{post}/insights`
([Meta Graph API › Page Insights](https://developers.facebook.com/docs/graph-api/reference/v21.0/insights)).

| Field | Value |
| :--- | :--- |
| `additionalSettings` (account total) | `account:followers` |
| `stats.*` populated (Postiz posts, 30d) | `impressions` |
| Dropped labels (Postiz posts, 30d) | `Clicks`, `Reactions` |

### 5.5 Instagram (`instagram`, `instagram-standalone`)

Official API: `GET /v21.0/{ig-user-id}?fields=followers_count,media_count`,
`GET /v21.0/{media-id}/insights`
([Instagram Graph API › Insights](https://developers.facebook.com/docs/instagram-platform/api-reference/instagram-media/insights)).

| Field | Value |
| :--- | :--- |
| `additionalSettings` (account total) | `account:followers`, `account:posts` |
| `stats.*` populated (Postiz posts, 30d) | `impressions`, `likes` |
| Dropped labels (Postiz posts, 30d) | `Reach`, `Engagement`, `Saves`, `Comments`, `Shares` |

> Meta deprecated the `impressions` metric in 2024 and now returns `views`
> under the same key for many media types. The provider still emits the label
> as `Impressions`, but the underlying value may be `views` for newer media.

### 5.6 Threads (`threads`)

Official API: `GET /v1.0/me?fields=followers_count`,
`GET /v1.0/{media-id}/insights`
([Threads Insights](https://developers.facebook.com/docs/threads/insights)).

| Field | Value |
| :--- | :--- |
| `additionalSettings` (account total) | `account:followers` |
| `stats.*` populated (Postiz posts, 30d) | `likes`, `replies`, `quotes` |
| Dropped labels (Postiz posts, 30d) | `Views` (label does not match `impression`), `Reposts` (does not match `retweet`) |

### 5.7 YouTube (`youtube`)

Official API: `GET youtube/v3/channels?part=statistics`,
`GET youtube/v3/videos?part=statistics`
([YouTube Data API v3 › Videos](https://developers.google.com/youtube/v3/docs/videos#resource-representation)).

| Field | Value |
| :--- | :--- |
| `additionalSettings` (account total) | `account:followers` (subscriberCount), `account:posts` (videoCount), `account:views` (viewCount) |
| `stats.*` populated (Postiz posts, 30d) | `likes` |
| Dropped labels (Postiz posts, 30d) | `Views`, `Comments`, `Favorites` |

### 5.8 TikTok (`tiktok`)

Official API: `GET /v2/user/info/?fields=follower_count,following_count,likes_count,video_count`,
`POST /v2/research/video/query/`
([TikTok for Developers › User Info](https://developers.tiktok.com/doc/tiktok-api-v2-user-info)).

| Field | Value |
| :--- | :--- |
| `additionalSettings` (account total) | `account:followers`, `account:following`, `account:likes`, `account:posts` |
| `stats.*` populated (Postiz posts, 30d) | `likes` |
| Dropped labels (Postiz posts, 30d) | `Views`, `Comments`, `Shares` |

### 5.9 Pinterest (`pinterest`)

Official API: `GET /v5/user_account?fields=follower_count,pin_count`,
`GET /v5/pins/{pin_id}/analytics`
([Pinterest API v5](https://developers.pinterest.com/docs/api/v5/user_account-analytics/)).

| Field | Value |
| :--- | :--- |
| `additionalSettings` (account total) | `account:followers`, `account:posts`, `account:views` |
| `stats.*` populated (Postiz posts, 30d) | `impressions` |
| Dropped labels (Postiz posts, 30d) | `Pin Clicks`, `Outbound Clicks`, `Saves` |

### 5.10 Reddit (`reddit`)

Official API: `GET /api/v1/me`, `GET /comments/{id}`
([Reddit API](https://www.reddit.com/dev/api/)).

| Field | Value |
| :--- | :--- |
| `additionalSettings` (account total) | `account:karma`, `account:linkKarma`, `account:commentKarma` |
| `stats.*` populated (Postiz posts, 30d) | **none** — `postAnalytics` emits `Score`, `Upvotes`, `Comments`, `Upvote Ratio`; none match any keyword |
| Dropped labels (Postiz posts, 30d) | `Score`, `Upvotes`, `Comments`, `Upvote Ratio` |

> The controller maps `karma` → `stats.followers`, but since `postAnalytics`
> never emits a `karma` label, `stats.followers` stays `null`. The karma value
> is only accessible via `additionalSettings.account:karma`.

### 5.11 Mastodon (`mastodon`)

Official API: `GET /api/v1/accounts/verify_credentials`,
`GET /api/v1/statuses/{id}`
([Mastodon API › Statuses](https://docs.joinmastodon.org/methods/statuses/)).

| Field | Value |
| :--- | :--- |
| `additionalSettings` (account total) | `account:followers`, `account:following`, `account:posts` |
| `stats.*` populated (Postiz posts, 30d) | `replies` |
| Dropped labels (Postiz posts, 30d) | `Favourites` (British spelling does not match `like`), `Boosts` |

### 5.12 Bluesky (`bluesky`)

Official API: `app.bsky.actor.getProfile`, `app.bsky.feed.getPosts`
([AT Protocol](https://docs.bsky.app/docs/api/app-bsky-feed-get-posts)).

| Field | Value |
| :--- | :--- |
| `additionalSettings` (account total) | `account:followers`, `account:following`, `account:posts` |
| `stats.*` populated (Postiz posts, 30d) | `likes`, `replies`, `quotes` |
| Dropped labels (Postiz posts, 30d) | `Reposts` |

### 5.13 Platforms With No Analytics

| Provider | `accountMetrics` | `postAnalytics` | Result |
| :--- | :--- | :--- | :--- |
| `discord`, `slack`, `telegram` | — | — | `stats` all `null`, `additionalSettings = []` |
| `dribbble` | — | stub (returns `[]`) | same as above |
| `nostr`, `vk` | — | — | same as above |

## 6. Data Availability At A Glance

The two tables below cover the two data scopes separately. The response
carries **both** for every supported provider; pick the right table based on
what the UI needs to show.

### 6.1 Account-Wide Totals — `additionalSettings.account:*`

Source: `accountMetrics()`. These are lifetime/current totals as reported by
the platform for the entire account (not scoped to Postiz).

| Platform | followers | following | posts | views | Other `account:*` |
| :--- | :---: | :---: | :---: | :---: | :--- |
| **x**             | YES | YES | YES | –   | `Verified` (checkbox), `listed` |
| **linkedin**      | –   | –   | –   | –   | — (no `accountMetrics` implemented) |
| **linkedin-page** | YES | –   | –   | –   | — |
| **facebook**      | YES | –   | –   | –   | — |
| **instagram**     | YES | –   | YES | –   | — |
| **threads**       | YES | –   | –   | –   | — |
| **youtube**       | YES | –   | YES | YES | — (`followers` = subscribers, `posts` = videos) |
| **tiktok**        | YES | YES | YES | –   | `likes` (lifetime likes received) |
| **pinterest**     | YES | –   | YES | YES | — |
| **reddit**        | –   | –   | –   | –   | `karma`, `linkKarma`, `commentKarma` |
| **mastodon**      | YES | YES | YES | –   | — |
| **bluesky**       | YES | YES | YES | –   | — |

Platforms with no analytics integration (`discord`, `slack`, `telegram`,
`dribbble`, `nostr`, `vk`) have an empty `additionalSettings` array.

### 6.2 Postiz-Scoped Post Data

All values below describe **posts Postiz created for this integration** —
never the account's native activity on the platform.

Two different scopes share this table:

- **`posts`** column → `postsCount` at the response root. `groupBy(group)`
  over the `Post` table, **lifetime**, any state except soft-deleted
  (includes drafts, scheduled, published, errored). Populated for every
  integration regardless of platform analytics support.
- Remaining columns → `stats.*`. `batchPostAnalytics()` / `postAnalytics()`
  aggregated over **the last 30 days only**, against posts that actually
  reached the platform (have a `releaseId`).

| Platform | posts | impressions | likes | replies | retweets | quotes | bookmarks |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **x**             | YES | YES | YES | YES | YES | YES | YES |
| **linkedin**      | YES | YES | YES | –   | –   | –   | –   |
| **linkedin-page** | YES | YES\* | YES | –   | –   | –   | –   |
| **facebook**      | YES | YES | –   | –   | –   | –   | –   |
| **instagram**     | YES | YES | YES | –   | –   | –   | –   |
| **threads**       | YES | –   | YES | YES | –   | YES | –   |
| **youtube**       | YES | –   | YES | –   | –   | –   | –   |
| **tiktok**        | YES | –   | YES | –   | –   | –   | –   |
| **pinterest**     | YES | YES | –   | –   | –   | –   | –   |
| **reddit**        | YES | –   | –   | –   | –   | –   | –   |
| **mastodon**      | YES | –   | –   | YES | –   | –   | –   |
| **bluesky**       | YES | –   | YES | YES | –   | YES | –   |
| **discord / slack / telegram / dribbble / nostr / vk** | YES | –   | –   | –   | –   | –   | –   |

`posts` is always populated because it is a straight DB count that does not
depend on any provider API. `stats.followers` is intentionally omitted — it is
defined in the response shape but **is always `null` for every provider**
(see §7.1.1).

\* `Unique Impressions` label overrides `Impressions` (see §5.3).

> **Not in this endpoint: Traffic score.** Every platform in §6.2 also has a
> weighted-engagement "Traffic" score computed by `computeTrafficScore`
> (`traffic.calculator.ts`), but it is only exposed by
> `/analytics/post/:id`, `/dashboard/traffics`, and the daily `DataTick`
> sync — never by `/integrations/profile/:id`. See §7.1.4 for the proposal
> to surface it here.

## 7. Known Gaps & Proposed Enhancements

The current response carries the bare minimum needed by the legacy Account
Profile card. For a richer profile view (state breakdowns, percent-change,
time series) the sections below enumerate everything the backend already
has that is not surfaced, plus additions that would need new code.

### 7.1 Tier 1 — Zero-Design Fixes (Controller-Only)

#### 7.1.1 `stats.followers` is always `null`

The controller is designed to pull `followers` from `postAnalytics` labels,
but no provider emits a post-level `followers` / `subscriber` / `karma`
label. Clients that need the account follower count must read
`integration.additionalSettings` → `account:followers` instead. Either drop
the `followers` field from `stats` to stop the null confusion, or have the
controller populate it from `account:followers` (while documenting that it
is account-scoped, not post-scoped — which would muddle the scope contract).

#### 7.1.2 Many platform-native metrics are fetched but dropped

Providers already call the platform APIs and emit these labels, but the
controller's `String.includes()` matcher does not recognize any of them and
they are silently discarded:

| Dropped label | Emitted by | Suggested `stats.*` field |
| :--- | :--- | :--- |
| `Views` | Threads, YouTube, TikTok | `views` |
| `Reach` | Instagram, LinkedIn personal | `reach` |
| `Saves` | Instagram, Pinterest | `saves` |
| `Comments` | LinkedIn, LinkedIn Page, Instagram, YouTube, TikTok, Reddit | `comments` |
| `Shares` | Instagram, LinkedIn, LinkedIn Page, TikTok | `shares` |
| `Clicks` / `Pin Clicks` / `Outbound Clicks` | LinkedIn Page, Facebook, Pinterest | `clicks` |
| `Engagement` | Instagram, LinkedIn Page | `engagement` |
| `Reactions` | Facebook | `reactions` |
| `Favourites` / `Favorites` | Mastodon (UK), YouTube (US) | `favorites` (normalize spelling) |
| `Boosts` / `Reposts` | Mastodon, Threads, Bluesky | `reposts` (semantically equal to `retweets`; merge) |
| `Score` / `Upvotes` / `Upvote Ratio` | Reddit | `score`, `upvotes`, `upvoteRatio` |
| `Unique Impressions` | LinkedIn Page | `uniqueImpressions` (fixes the Impressions-override bug in §5.3) |

Reddit currently has **every** post-level metric dropped — fixing this
single mapping change is the biggest single-platform win.

#### 7.1.3 Label-matching is fragile

`String.includes()` causes accidental collisions (`Unique Impressions`
overriding `Impressions`) and locale-sensitive misses (`Favourites` vs
`like`). Replace with an explicit label-to-field lookup table per provider.

#### 7.1.4 Traffic score is computed but not surfaced here

`computeTrafficScore` (`traffic.calculator.ts`) already defines weighted
engagement formulas for all 13 supported platforms plus a fallback. It is
consumed by:

- `DataTicksService` daily sync → persisted as `DataTick` rows with
  `type='traffic'`
- `/analytics/post/:id` — appends the per-post traffic score to the
  response
- `/dashboard/traffics` — aggregates stored traffic ticks for the org

But `IntegrationsController.getIntegrationProfile` calls
`getPostsLevelAnalytics` → `_aggregatePostAnalytics`, which never invokes
`computeTrafficScore`. Adding a single line that passes the aggregated
metrics through `computeTrafficScore(integration.providerIdentifier, ...)`
and emits `stats.traffic` would expose this "summary engagement" number
for the profile view at zero new platform-API cost (same data already
fetched for `stats.*`).

Per-platform input labels and weights (from `traffic.calculator.ts`):

| Platform | Traffic inputs |
| :--- | :--- |
| `x` | likes, replies, retweets, quotes, bookmarks |
| `youtube` | views, likes, comments, favorites |
| `instagram` / `instagram-standalone` | likes, comments, saves, shares |
| `linkedin-page` | clicks, likes, comments, shares, engagement |
| `linkedin` | impressions, likes, comments, shares, reach |
| `facebook` | clicks, reactions |
| `threads` | likes, replies, reposts, quotes |
| `pinterest` | pin clicks, outbound clicks, saves |
| `tiktok` | views, likes, comments, shares |
| `reddit` | score, upvotes, comments |
| `bluesky` | likes, reposts, replies, quotes |
| `mastodon` / `mastodon-custom` | favourites, boosts, replies |
| Other / fallback | likes, comments, shares, clicks |

Note: some of these inputs (Views, Reach, Comments, Shares, Saves, Clicks,
Reactions, Boosts, Reposts, Favourites) are the same labels currently
dropped by §7.1.2 — so fixing 7.1.2 first makes 7.1.4 more meaningful
because the raw components and the computed composite score would both
be available to the client.

#### 7.1.5 `additionalSettings` is a stringified JSON blob

Clients currently do:

```ts
const account = JSON.parse(integration.additionalSettings)
  .filter(s => s.title.startsWith('account:'))
  .reduce((acc, s) => ({ ...acc, [s.title.slice(8)]: s.value }), {});
```

This is verbose and the `additional-settings.utils.ts` helper already exists
server-side. Promoting a parsed `account` object to the response root would
eliminate client-side plumbing:

```jsonc
{
  "integration": { ... },
  "account": {
    "followers": 2,
    "following": null,
    "posts": null,
    "verified": false   // X only; other platform-specific booleans slot here
  },
  "postsCount": 5,
  "stats": { ... }
}
```

### 7.2 Tier 2 — Small Additive Enhancements

#### 7.2.1 Post state breakdown

`postsCount: 5` hides the fact that some of those groups may be drafts,
scheduled, errored, etc. A single `groupBy({ by: ['state'] })` covers it:

```jsonc
"posts": {
  "total": 5,
  "published": 3,
  "scheduled": 1,
  "draft": 0,
  "error": 1
}
```

Lets the UI surface "1 post failed on this integration" without extra
round trips.

#### 7.2.2 Timeline markers

Three `findFirst` queries would add operational signal for "is this channel
still active?":

```jsonc
"timeline": {
  "lastPublishedAt": "2026-04-15T08:30:00Z",
  "nextScheduledAt": "2026-04-18T12:00:00Z",
  "firstPostAt":     "2026-04-14T09:15:00Z"
}
```

#### 7.2.3 Real `percentageChange`

`_aggregatePostAnalytics` currently hard-codes `percentageChange: 0` on
every output. The field is meaningless today — either remove it from the
response or compute it against a prior-period window (query 31–60 days,
same aggregation). Leaving `0` makes any UI that trusts the field lie to
the user.

#### 7.2.4 Time range parameter

`GET /integrations/profile/:id?days=30|7|90`

Drop the hard-coded 30-day window to unblock 7/30/90-day switchers in the
UI. `getPostsLevelAnalytics()` already accepts a `days` argument.

#### 7.2.5 Integration health snapshot

Several fields already exist on the `Integration` row but are scattered
across the flat `integration` object. Grouping them as a `health` block
improves discoverability:

```jsonc
"health": {
  "disabled": false,
  "refreshNeeded": false,
  "tokenExpiresAt": "2026-06-13T08:57:03Z",
  "tokenPermanent": false,                          // provider.isTokenPermanent(token)
  "lastAccountMetricsSyncAt": "2026-04-17T02:43:26Z",
  "connectedAt": "2026-04-14T08:57:04Z"
}
```

### 7.3 Tier 3 — New Capabilities (Require Design)

Listed for completeness; none of these exist in any form today.

- **Recent posts list** — last N posts with `{ id, excerpt, state, publishedAt, perPostMetrics }` for a "recent activity" block.
- **Top post** — highest-performing post(s) in the window (by impressions
  / engagement).
- **Daily time series** — `dailyMetrics: [{ date, impressions, engagement, ... }]`
  for trend charts. `DataTick` table already stores daily rollups for the
  dashboard and could be reused.
- **Derived averages** — `avgImpressionsPerPost`, `engagementRate =
  (likes + comments + ...) / impressions`.
- **Error cause aggregation** — top N failure reasons from `Post.error`
  for errored groups, aids debugging recurring posting issues.

### 7.4 Suggested Priority

| Priority | Item | Backend effort | Client benefit |
| :--- | :--- | :--- | :--- |
| **P0** | 7.1.5 parsed `account` block | ~5 LOC | Removes client-side JSON parsing |
| **P0** | 7.1.2 recover dropped labels | ~30 LOC + lookup table | Reddit/YouTube/TikTok/Pinterest profile pages become useful |
| **P0** | 7.1.4 add `stats.traffic` | ~5 LOC (reuse existing calculator) | One composite "engagement" number the UI can show for every platform |
| **P1** | 7.2.1 post state breakdown | ~10 LOC + 1 repo method | Surfaces failures and backlog |
| **P1** | 7.2.5 `health` block | ~15 LOC | Unified token/connection status |
| **P2** | 7.2.3 real `percentageChange` | ~30 LOC (prior-period query) | Enables "↑12%" UI |
| **P2** | 7.2.2 timeline markers | ~20 LOC | Channel-activity signal |
| **P2** | 7.2.4 `?days=` param | ~10 LOC | 7/30/90-day switcher |
| **P3** | 7.3 new capabilities | New endpoints or significant extension | Full analytics product form |

The minimal responsible-closure change is P0 + P0 (~40 LOC, no breaking
change — response only grows). This single pass removes the most painful
client plumbing and unlocks Reddit / YouTube / TikTok / Pinterest profile
pages that are currently blank.

## 8. How to Access
1. Go to the **Launches** (Calendar) page.
2. Locate the connected channel in the left sidebar.
3. Click the **three dots (⋮)** menu next to the channel name.
4. Select **Account Profile** from the dropdown menu.
