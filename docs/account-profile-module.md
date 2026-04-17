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
| `postsCount` | **Postiz-published posts only** | `Post` table filter by `integrationId` | Count of rows in the Postiz database for this integration — it will never equal the account's total post count shown on the platform profile. |

Concrete example: for an X account with 10,000 lifetime tweets of which 3 were
posted through Postiz in the last 30 days, the response will report:

- `additionalSettings.account:posts` → `10000` (lifetime, from `v2/users/me`)
- `postsCount` → `3` (Postiz database)
- `stats.impressions` → sum of impressions across **those 3 Postiz tweets only**
  for the last 30 days — not the account's 30-day total reach.

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

## 6. `stats` Availability At A Glance

The table below shows which `stats.*` fields are populated per provider. **All
checkmarks refer to Postiz-published posts in the last 30 days**, never to the
account's native activity on the platform. For account-wide totals, read the
corresponding `account:*` key in `additionalSettings`.

| Platform | followers | impressions | likes | replies | retweets | quotes | bookmarks |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **x**             | – | YES | YES | YES | YES | YES | YES |
| **linkedin**      | – | YES | YES | –   | –   | –   | –   |
| **linkedin-page** | – | YES\* | YES | –   | –   | –   | –   |
| **facebook**      | – | YES | –   | –   | –   | –   | –   |
| **instagram**     | – | YES | YES | –   | –   | –   | –   |
| **threads**       | – | –   | YES | YES | –   | YES | –   |
| **youtube**       | – | –   | YES | –   | –   | –   | –   |
| **tiktok**        | – | –   | YES | –   | –   | –   | –   |
| **pinterest**     | – | YES | –   | –   | –   | –   | –   |
| **reddit**        | – | –   | –   | –   | –   | –   | –   |
| **mastodon**      | – | –   | –   | YES | –   | –   | –   |
| **bluesky**       | – | –   | YES | YES | –   | YES | –   |

\* `Unique Impressions` label overrides `Impressions` (see §5.3).

## 7. Known Gaps & Improvement Notes

1. **`stats.followers` is always `null`** across all providers. The controller
   is designed to pull `followers` from `postAnalytics` labels, but no provider
   emits a post-level `followers` / `subscriber` / `karma` label. Clients that
   need the account follower count should read
   `integration.additionalSettings` → `account:followers` instead.
2. **Many platform-native metrics are dropped.** YouTube Views, TikTok
   Views/Shares/Comments, Instagram Reach/Saves, Pinterest Saves/Clicks, all
   Reddit metrics, Threads/Bluesky Reposts, and Mastodon Favourites/Boosts are
   all fetched but never surfaced in `stats`. Expanding the label-to-field
   mapping in `IntegrationsController.getIntegrationProfile` (or switching to
   a richer pass-through response shape) is required to expose them.
3. **Label-matching is fragile.** `String.includes()` causes accidental
   collisions such as `Unique Impressions` overriding `Impressions`, and
   locale-sensitive misses such as `Favourites` vs `like`. Consider an
   explicit label-to-field lookup table per provider.

## 8. How to Access
1. Go to the **Launches** (Calendar) page.
2. Locate the connected channel in the left sidebar.
3. Click the **three dots (⋮)** menu next to the channel name.
4. Select **Account Profile** from the dropdown menu.
