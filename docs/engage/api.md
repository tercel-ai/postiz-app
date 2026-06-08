# Engage Module — Frontend API Reference

**Version**: 1.0  
**Date**: 2026-05-22  
**Base Path**: `/api/engage`  
**Auth**: All endpoints require a valid session cookie (same as existing Post Agent APIs).

---

## Table of Contents

- [General Conventions](#general-conventions)
- [Enums and Constants](#enums-and-constants)
- [Data Models](#data-models)
- [Setup — Initial Setup (Atomic)](#setup--initial-setup-atomic)
- [Config — Configuration](#config--configuration)
- [Keywords — Keywords](#keywords--keywords)
- [Monitored Channels — Monitored Channels](#monitored-channels--monitored-channels)
- [Tracked Accounts — Tracked Accounts](#tracked-accounts--tracked-accounts)
- [Reply Accounts — Reply Accounts](#reply-accounts--reply-accounts)
- [Opportunities — Signal Feed](#opportunities--signal-feed)
- [Draft Generation — AI Draft Generation (SSE)](#draft-generation--ai-draft-generation-sse)
- [Reply Actions — Send/Schedule/Manual Reply](#reply-actions--sendschedulemanual-reply)
  - [POST /send-now](#post-apienageopportunitiesidsend-now) — immediate single (cancels scheduled if exists)
  - [POST /schedule](#post-apienageopportunitiesidschedule) — scheduled single
  - [POST /batch-schedule](#post-apienageopportunitiesidatch-schedule) — scheduled multi-integration
  - [POST /batch-send](#post-apienageopportunitiesidatch-send) — immediate multi-integration
  - [POST /manual-reply](#post-apienageopportunitiesidanual-reply) — Reddit manual
- [Sent Replies — Sent Records](#sent-replies--sent-records)
  - [GET /sent](#get-apienagesent) — paginated list
  - [GET /sent/stats](#get-apienagesentstats) — aggregate stats
  - [PATCH /sent/:id](#patch-apienagesentid) — edit scheduled reply
  - [PATCH /sent/:id/reply-url](#patch-apienagesentidreply-url) — Reddit URL submission
- [Dashboard Stats — Dashboard Statistics](#dashboard-stats--dashboard-statistics)
  - [GET /dashboard/summary](#get-apienagedashboardsummary) — Engage Performance panel
  - [GET /dashboard/replies-trend](#get-apienagedashboardreplies-trend) — Your Posts overlay
  - [GET /dashboard/traffics](#get-apienagedashboardtraffics) — Traffic from Engage panel
  - [GET /dashboard/impressions](#get-apienagedashboardimpressions) — Engage Impressions Trend
  - [GET /dashboard/top-sources](#get-apienagedashboardtop-sources) — Top engage sources panel
- [Scan — Manual Scan Trigger](#scan--manual-scan-trigger)
- [Error Handling](#error-handling)

---

## General Conventions

- All requests/responses are `application/json`, except for SSE endpoints.
- Pagination parameters: `page` (default 1), `limit` (default 20, max 100).
- Time fields are ISO 8601 strings (UTC).
- `id` fields are UUID strings.

---

## Enums and Constants

```typescript
// Opportunity Status
type EngageOpportunityStatus =
  | 'NEW'         // New opportunity, actionable
  | 'DISMISSED'   // Dismissed/Ignored
  | 'REPLIED'     // Replied (Directly on X)
  | 'SCHEDULED'   // Scheduled
  | 'AUTO_QUEUED' // In auto-reply queue
  | 'EXPIRED';    // Expired

// AI Draft Strategy
type ReplyStrategy = 'EXPERT_ANSWER' | 'DATA_BACKED' | 'EMPATHY_LED';

// Keyword Type
type KeywordType = 'CORE' | 'BRAND' | 'COMPETITOR';

// Intent Type (Values in intentTags)
type IntentType =
  | 'help_seeking'  // Seeking help
  | 'rant'          // Ranting/Complaining
  | 'discussion'    // Discussion
  | 'opinion'       // Opinionated
  | 'comparison'    // Comparison
  | 'data_share';   // Sharing data
```

Canonical `intentTags` values:

| Value | Meaning | Typical signal |
|---|---|---|
| `help_seeking` | Seeking help | Questions, "how", "help", "anyone" |
| `rant` | Ranting or complaining | Frustration, "hate", "tired of", "annoying" |
| `discussion` | Discussion | Open-ended statement, "thoughts?", "what do you think" |
| `opinion` | Opinionated | "I think", "hot take", "unpopular opinion" |
| `comparison` | Comparison | "vs", "compare", "better than", "alternative" |
| `data_share` | Sharing data | Numbers, percentages, reports, studies |

---

## Data Models

### EngageConfig

```typescript
interface EngageConfig {
  id: string;
  organizationId: string;
  enabled: boolean;       // true = setup complete and scanning active
  lastScanAt: string | null;
  createdAt: string;
  updatedAt: string;
  // Embedded relations (only returned by GET /config)
  keywords: EngageKeyword[];
  monitoredChannels: EngageMonitoredChannel[];
  trackedAccounts: EngageTrackedAccount[];
  xReplyAccounts: EngageXReplyAccount[];
  // Scan scheduling + status (only returned by GET /config)
  scanIntervals: { keywordHours: number; channelHours: number; trackedHours: number };
  // Per-org last/next scan time, derived from EngageScanCursor (next is computed:
  // lastScanStartedAt + cadence, or cooldownUntil — never stored). The keyword
  // firehose is global; channel/tracked reflect this org's subreddits/accounts.
  scanStatus: {
    lastScanAt: string | null;   // overall (max over types)
    nextScanAt: string | null;   // overall (min over types)
    keyword: { lastScanAt: string | null; nextScanAt: string | null };
    channel: { lastScanAt: string | null; nextScanAt: string | null };
    tracked: { lastScanAt: string | null; nextScanAt: string | null };
  };
}
```

### EngageKeyword

```typescript
interface EngageKeyword {
  id: string;
  configId: string;
  organizationId: string;
  keyword: string;
  type: KeywordType | null;   // 'CORE' | 'BRAND' | 'COMPETITOR' | null
  enabled: boolean;
  weeklyHitCount: number;
  totalHitCount: number;
  lastCountedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
```

### EngageMonitoredChannel

```typescript
interface EngageMonitoredChannel {
  id: string;
  configId: string;
  organizationId: string;
  platform: string;      // 'reddit' | 'youtube' | ...
  channelId: string;     // e.g. 'SEO' (subreddit name without r/)
  channelName: string;   // e.g. 'r/SEO'
  audienceSize: number;
  enabled: boolean;
  lastScannedAt: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}
```

### EngageTrackedAccount

```typescript
interface EngageTrackedAccount {
  id: string;
  configId: string;
  organizationId: string;
  platform: string;           // 'x' (v1.0 X only)
  username: string;           // Without @ prefix
  displayName: string | null;
  categoryLabel: string | null; // Custom category, e.g., 'GEO Expert'
  enabled: boolean;
  lastCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
```

### EngageXReplyAccount (Nested in Integration)

```typescript
// GET /reply-accounts returns Integration objects with nested engageXReplyAccount
interface Integration {
  id: string;
  name: string;
  providerIdentifier: 'x';
  picture: string | null;
  // Other Integration fields...
  engageXReplyAccount: EngageXReplyAccountConfig | null;
}

interface EngageXReplyAccountConfig {
  id: string;
  integrationId: string;
  engageEnabled: boolean;
  autoReplyEnabled: boolean;
  autoReplyTimeStart: string | null;   // 'HH:MM' 24h
  autoReplyTimeEnd: string | null;
  autoReplyTimezone: string | null;    // IANA timezone, e.g., 'Asia/Shanghai'
  defaultStrategy: ReplyStrategy;
  createdAt: string;
  updatedAt: string;
}
```

### EngageOpportunity

```typescript
// API response shape (the merged view). Server-side this is a global
// EngageOpportunity row flattened with the caller org's EngageOpportunityState
// (status/bookmarked/score/scoreKeyword/scoreTracked). `id` is the GLOBAL post id.
// Note: there is no `organizationId` field — the post is shared across orgs and
// the request is already org-scoped by auth.
interface EngageOpportunity {
  id: string;
  platform: string;            // 'x' | 'reddit'
  externalPostId: string;
  externalPostUrl: string;
  channelId: string | null;    // Reddit: subreddit name; X: null
  channelName: string | null;
  authorUsername: string | null;
  authorDisplayName: string | null;
  authorAvatarUrl: string | null;
  authorFollowers: number | null;
  postContent: string;
  postPublishedAt: string;
  // Scoring (0-105) — heat/authority/recency are global; keyword/tracked/total per-org
  score: number;
  scoreKeyword: number;     // Keyword score 0-35 (关键词质量)
  scoreHeat: number;        // Heat score 0-45 (平台热度)
  scoreAuthority: number;   // Authority score 0-15 (账号影响力)
  scoreRecency: number;     // Recency score 0-5: within 24h→5, else→0 (时效性)
  scoreTracked: number;     // Tracked account bonus 0 or 5 (重点账户)
  matchedKeywords: string[]; // this org's enabled keywords the post hit (per-org; ⊆ the org's keyword set)
  // Intent
  intentTags: IntentType[];
  primaryIntent: IntentType;
  intentScore: number | null;
  // Status (per-org)
  status: EngageOpportunityStatus;
  bookmarked: boolean;
  // Platform Metrics (captured at discovery)
  metricLikes: number;
  metricReplies: number;
  metricRetweets: number;
  metricQuotes: number;
  metricBookmarks: number;   // X bookmark_count
  metricViews: number;       // YouTube/TikTok views | Threads/LinkedIn/IG impressions
  metricShares: number;      // TikTok/LinkedIn/IG shares
  metricSaves: number;       // Instagram/Pinterest saves
  metricScore: number;       // Reddit: score (upvotes - downvotes)
  metricUpvoteRatio: number | null;
  metricComments: number;
  rawData: Record<string, unknown> | null;  // original platform API response (debug)
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}
```

### EngageSentReply

```typescript
interface EngageSentReply {
  id: string;
  organizationId: string;
  opportunityId: string;
  postId: string;            // Reference to Post table (published post)
  strategy: ReplyStrategy;
  brandStrength: number;     // 0-3
  authorReplied: boolean;    // Whether the original author replied to us
  createdAt: string;
  updatedAt: string;
}

// Extended object returned by listSentReplies (includes nested post + opportunity)
interface EngageSentReplyWithDetails extends EngageSentReply {
  post: {
    id: string;
    content: string;
    state: string;         // 'PUBLISHED' | 'QUEUE' | 'ERROR'
    releaseURL: string | null; // X tweet URL or Reddit comment URL
    publishDate: string;
    impressions: number;
    trafficScore: number;
    analytics: Array<{ label: string; data: number[] }> | null;
    integration: {
      id: string;
      name: string;
      providerIdentifier: string;
      picture: string | null;
    } | null;
  };
  opportunity: {
    id: string;
    platform: string;
    externalPostUrl: string;
    postContent: string;
    authorUsername: string | null;
    authorDisplayName: string | null;
  };
}
```

---

## Setup — Initial Setup (Atomic)

### POST `/api/engage/setup`

**One-shot Setup Wizard submission.** Atomically writes all initial configuration in a single Prisma transaction, then starts the Temporal scanning workflow.

> Use this endpoint instead of the individual CRUD endpoints during the first-time setup flow. For subsequent edits (adding/removing keywords after setup), use the individual endpoints under [Keywords](#keywords--keywords), [Monitored Channels](#monitored-channels--monitored-channels), etc.

**Request Body**

```json
{
  "keywords": [
    { "keyword": "GEO SEO" },
    { "keyword": "AISEE", "type": "BRAND" },
    { "keyword": "SurferSEO", "type": "COMPETITOR", "enabled": false }
  ],
  "monitoredChannels": [
    {
      "platform": "reddit",
      "channelId": "SEO",
      "channelName": "r/SEO",
      "audienceSize": 1200000
    }
  ],
  "trackedAccounts": [
    { "username": "randfish", "platform": "x", "categoryLabel": "GEO Expert" }
  ]
}
```

| Field | Required | Description |
|---|---|---|
| `keywords` | **Yes** (1–100 items) | Keywords to monitor. `type` optional (`CORE`/`BRAND`/`COMPETITOR`). Duplicates skipped. |
| `monitoredChannels` | No | Channels to scan. Duplicates (`platform+channelId`) skipped. |
| `trackedAccounts` | No | External accounts to track. Duplicates (`platform+username`) skipped. |

**Response** `200 OK` — Returns the updated `EngageConfig` (with `enabled: true`)

**Side Effect**: Ensures the global `engage-scan-ticker` Temporal workflow is running and signals it to scan now (idempotent — re-calling is safe). Scanning is global/cursor-driven, not per-org.

**Errors**
- `400` — `keywords` is empty or missing

---

## Config — Configuration

### GET `/api/engage/config`

Retrieve the Engage configuration for the current organization (including all keywords, channels, tracked accounts, and reply accounts).  
The first call will automatically create a default configuration (`enabled: false`).

**Response** `200 OK`

```json
{
  "id": "uuid",
  "organizationId": "uuid",
  "enabled": false,
  "lastScanAt": null,
  "createdAt": "2026-05-22T00:00:00.000Z",
  "updatedAt": "2026-05-22T00:00:00.000Z",
  "keywords": [],
  "monitoredChannels": [],
  "trackedAccounts": [],
  "xReplyAccounts": []
}
```

> **Frontend routing**: If `enabled: false`, redirect to the Setup Wizard. If `enabled: true`, render the Signal Feed.

---

### POST `/api/engage/config`

Update configuration fields. Does not perform bulk writes to related tables — use `POST /setup` for the initial wizard submission.

**Request Body**

```json
{
  "enabled": true   // Optional — setting true also starts Temporal workflows (idempotent)
}
```

**Response** `200 OK` — Returns the updated `EngageConfig` (without embedded relations)

---

### POST `/api/engage/config/reset`

Reset `enabled` to `false` (re-enter Setup Wizard). Does not delete existing keywords or channels.

**Response** `200 OK` — Returns the updated `EngageConfig`

---

## Keywords — Keywords

### POST `/api/engage/keywords`

Add a single keyword.

**Request Body**

```json
{
  "keyword": "GEO SEO",      // Required, 1-100 characters
  "type": "CORE",            // Optional, default 'CORE'. Enums: 'CORE' | 'BRAND' | 'COMPETITOR'
  "enabled": true            // Optional, default true
}
```

**Response** `200 OK` — Returns the created `EngageKeyword` object

---

### POST `/api/engage/keywords/bulk`

Bulk add keywords (atomic operation). Duplicate keywords are automatically skipped without throwing an error.

**Request Body**

```json
{
  "keywords": [
    { "keyword": "AI SEO", "type": "CORE", "enabled": true },
    { "keyword": "AISEE", "type": "BRAND", "enabled": true },
    { "keyword": "SurferSEO", "type": "COMPETITOR", "enabled": false }
  ]
}
```

> `keywords` array: 1-100 items

**Response** `200 OK`

```json
{ "count": 3 }
```

---

### PATCH `/api/engage/keywords/:id`

Update a keyword's type or enabled status.

**Request Body** (All fields optional)

```json
{
  "type": "BRAND",    // 'CORE' | 'BRAND' | 'COMPETITOR'
  "enabled": false
}
```

**Response** `200 OK` — Returns the updated `EngageKeyword`

**Error** `404` — Keyword not found

---

### DELETE `/api/engage/keywords/:id`

Delete a keyword.

**Response** `200 OK` — Returns the deleted `EngageKeyword`

**Error** `404` — Keyword not found

---

### GET `/api/engage/keywords/:id/posts`

Preview recent global posts whose content matches this keyword (ILIKE on
`postContent`, backed by the pg_trgm index). Used by the keyword-manager expand
panel. Returns up to 8 posts, newest first. Not org-state-scoped — these are
global discovered posts that match the keyword text.

**Response** `200 OK`

```json
[
  {
    "id": "uuid",
    "platform": "reddit",
    "externalPostUrl": "https://www.reddit.com/r/SEO/comments/.../",
    "authorUsername": "someuser",
    "postContent": "…",
    "postPublishedAt": "2026-05-27T08:00:00Z",
    "metricScore": 42,
    "metricComments": 7,
    "metricLikes": 0,
    "scoreHeat": 18
  }
]
```

**Error** `404` — Keyword not found

---

## Monitored Channels — Monitored Channels

### GET `/api/engage/monitored-channels`

Retrieve all monitored channels for the current organization.

**Response** `200 OK` — `EngageMonitoredChannel[]`

```json
[
  {
    "id": "uuid",
    "platform": "reddit",
    "channelId": "SEO",
    "channelName": "r/SEO",
    "audienceSize": 1200000,
    "enabled": true,
    "lastScannedAt": null,
    "metadata": { "description": "...", "url": "https://reddit.com/r/SEO" },
    "createdAt": "...",
    "updatedAt": "..."
  }
]
```

---

### POST `/api/engage/monitored-channels/search`

Search for channels to add (v1.0 only supports Reddit subreddits).

**Request Body**

```json
{
  "platform": "reddit",
  "query": "SEO"
}
```

**Response** `200 OK`

```json
[
  {
    "platform": "reddit",
    "channelId": "SEO",
    "channelName": "r/SEO",
    "audienceSize": 1200000,
    "metadata": {
      "description": "Search engine optimization discussion",
      "url": "https://reddit.com/r/SEO"
    }
  }
]
```

> Returns `[]` on search failure or network timeout, does not throw an error.

---

### POST `/api/engage/monitored-channels`

Add a monitored channel. `channelId` + `platform` must be unique; duplicate additions return `409`.

**Request Body**

```json
{
  "platform": "reddit",
  "channelId": "SEO",          // Required, subreddit name (without r/)
  "channelName": "r/SEO",      // Required, display name
  "audienceSize": 1200000,     // Optional
  "metadata": {}               // Optional, any JSON
}
```

**Response** `200 OK` — Returns the created `EngageMonitoredChannel`

---

### PATCH `/api/engage/monitored-channels/:id`

Update channel information.

**Request Body** (All fields optional)

```json
{
  "enabled": false,
  "channelName": "r/SEO",
  "audienceSize": 1250000
}
```

**Response** `200 OK` — Returns the updated `EngageMonitoredChannel`

**Error** `404` — Channel not found

---

### DELETE `/api/engage/monitored-channels/:id`

Delete a monitored channel (historical Feed records are preserved).

**Response** `200 OK` — Returns the deleted `EngageMonitoredChannel`

**Error** `404` — Channel not found

---

## Tracked Accounts — Tracked Accounts

> Tracked accounts are **external third-party X accounts** (not ours), used to monitor their posts and push them into the Feed. They cannot be used to send replies.

### GET `/api/engage/tracked-accounts`

Retrieve all tracked accounts.

**Response** `200 OK` — `EngageTrackedAccount[]`

---

### POST `/api/engage/tracked-accounts`

Add a tracked account.

**Request Body**

```json
{
  "username": "randfish",       // Required, 1-50 characters, without @ prefix
  "platform": "x",             // Optional, default 'x'
  "categoryLabel": "GEO Expert"   // Optional, max 100 characters
}
```

**Response** `200 OK` — Returns the created `EngageTrackedAccount`

---

### PATCH `/api/engage/tracked-accounts/:id`

Update a tracked account.

**Request Body** (All fields optional)

```json
{
  "enabled": false,
  "categoryLabel": "SEO Media"
}
```

**Response** `200 OK` — Returns the updated `EngageTrackedAccount`

**Error** `404` — Tracked account not found

---

### DELETE `/api/engage/tracked-accounts/:id`

Delete a tracked account (historical Feed records are preserved).

**Response** `200 OK` — Returns the deleted `EngageTrackedAccount`

**Error** `404` — Tracked account not found

---

## Reply Accounts — Reply Accounts

> Reply accounts are **our connected X OAuth accounts** (Integration table), used to send replies. They are completely independent from tracked accounts.

### GET `/api/engage/reply-accounts`

Retrieve all available X accounts and their Engage configurations.

**Response** `200 OK` — `Integration[]` (with nested `engageXReplyAccount`)

```json
[
  {
    "id": "integration-uuid",
    "name": "mycompany_x",
    "providerIdentifier": "x",
    "picture": "https://...",
    "engageXReplyAccount": {
      "id": "uuid",
      "integrationId": "integration-uuid",
      "engageEnabled": true,
      "autoReplyEnabled": false,
      "autoReplyTimeStart": "09:00",
      "autoReplyTimeEnd": "18:00",
      "autoReplyTimezone": "Asia/Shanghai",
      "defaultStrategy": "EXPERT_ANSWER",
      "createdAt": "...",
      "updatedAt": "..."
    }
  }
]
```

> `engageXReplyAccount` being `null` means the account has not been configured with Engage settings (uses defaults).

---

### PATCH `/api/engage/reply-accounts/:integrationId`

Update Engage settings for a specific X account (automatically creates if not exists).

**URL Param**: `integrationId` — The `id` of the Integration (from `GET /reply-accounts`)

**Request Body** (All fields optional)

```json
{
  "engageEnabled": true,           // Whether to enable this account in Engage
  "autoReplyEnabled": false,       // Whether to enable auto-reply
  "autoReplyTimeStart": "09:00",   // Auto-reply time window start (HH:MM 24h)
  "autoReplyTimeEnd": "18:00",     // Auto-reply time window end
  "autoReplyTimezone": "Asia/Shanghai", // IANA timezone
  "defaultStrategy": "EXPERT_ANSWER"   // Default draft strategy
}
```

**Response** `200 OK` — Returns `EngageXReplyAccountConfig`

**Error** `404` — Integration not found or does not belong to the current organization

---

## Opportunities — Signal Feed

### GET `/api/engage/opportunities/score-stats`

Retrieve scoring statistics for the Feed (used for the top dashboard).

**Query Params**

| Parameter | Type | Description |
|---|---|---|
| `date` | `all \| day \| today \| week \| month` | Publish-date window, defaults to all (`day`/`today` aliased) |
| `platform` | `string` | Platform filter, e.g., `'x'` / `'reddit'` |

**Response** `200 OK`

```json
{
  "total": 142,
  "avgScore": 74.3,
  "avgScoreKeyword": 22.1,
  "avgScoreHeat": 25.6,
  "avgScoreAuthority": 18.4,
  "avgScoreRecency": 3.2,
  "avgScoreTracked": 0.5,
  "distribution": [
    { "range": "85-100", "count": 28, "pct": 20 },
    { "range": "70-84",  "count": 71, "pct": 50 },
    { "range": "60-69",  "count": 43, "pct": 30 }
  ],
  "topByKeyword": {
    "id": "opp-uuid",
    "score": 35,
    "title": "How does GEO actually work for ranking in AI search..."
  },
  "topByHeat": {
    "id": "opp-uuid",
    "score": 35,
    "title": "Best SEO tools in 2026 vs 2025..."
  },
  "topByAuthority": {
    "id": "opp-uuid",
    "score": 20,
    "title": "My honest review of AISEE after 3 months..."
  },
  "trackedCount": 7
}
```

> When no data: `total: 0`, other fields are 0 / `null`.

---

### GET `/api/engage/opportunities`

Retrieve the list of opportunities (main Signal Feed endpoint).

**Query Params**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `platform` | `string \| string[]` | — | Platform filter. Multi-value (OR): `?platform=x&platform=reddit` or `?platform=x,reddit`. Max 20. |
| `status` | `EngageOpportunityStatus \| EngageOpportunityStatus[]` | — | Status filter. Multi-value (OR): repeated params or comma-separated. Max 20. |
| `intent` | `IntentType \| IntentType[]` | — | Intent filter. Multi-value (OR): repeated params or comma-separated. Max 20. |
| `keyword` | `string` | — | Restrict to opportunities that matched this exact keyword (text as configured; per-org via `matchedKeywords`) |
| `keywords` | `string[]` | — | Multi-keyword variant of `keyword`: keep opportunities that matched **any** of these exact keywords (OR). Same per-org scope (`matchedKeywords`). Accepts repeated params `?keywords=react&keywords=nextjs` **or** comma-separated `?keywords=react,nextjs`. Combinable with `keyword` (the two sets are unioned). Max 50. |
| `date` | `'today' \| 'week'` | — | Time range |
| `minScore` | `number` | — | Minimum total score |
| `minScoreKeyword` | `number` | — | Minimum keyword score |
| `minScoreHeat` | `number` | — | Minimum heat score |
| `minScoreAuthority` | `number` | — | Minimum authority score |
| `channels` | `string \| string[]` | — | Channel id filter. Multi-value (OR): `?channels=SEO&channels=TECH` or `?channels=SEO,TECH`. Omit for no filter. Max 50. |
| `authors` | `string \| string[]` | — | Author username filter (case-insensitive). Multi-value (OR): repeated params or comma-separated. Omit for no filter. Max 50. |
| `bookmarked` | `boolean` | — | Only show bookmarked |
| `sortBy` | `string` | `'score'` | Sort field: `score` / `scoreKeyword` / `scoreHeat` / `scoreAuthority` / `scoreRecency` / `scoreTracked` / `createdAt` |
| `sortOrder` | `'asc' \| 'desc'` | `'desc'` | Sort direction |
| `page` | `number` | `1` | Page number |
| `limit` | `number` | `20` | Items per page, max 100 |

> All multi-value parameters accept two equivalent forms (and a mix):
> - Repeated params: `?platform=x&platform=reddit`
> - Comma-separated: `?platform=x,reddit`
>
> Values are split on commas and trimmed server-side. If a value legitimately
> contains a comma, use the repeated-param form.

**Filter examples**

```text
# Single keyword
GET /api/engage/opportunities?keyword=GEO%20SEO

# Multiple keywords (OR)
GET /api/engage/opportunities?keywords=GEO%20SEO,AISEE,SurferSEO

# Multiple platforms (OR)
GET /api/engage/opportunities?platform=x,reddit

# Multiple statuses (OR)
GET /api/engage/opportunities?status=NEW&status=AUTO_QUEUED

# Multiple channels (OR)
GET /api/engage/opportunities?channels=SEO,TECH

# Multiple authors (OR)
GET /api/engage/opportunities?authors=alice,bob

# Combined — all active conditions are AND-ed together
GET /api/engage/opportunities?keywords=GEO%20SEO,AISEE&platform=x&status=NEW,AUTO_QUEUED&minScore=70
```

> `keyword` and `keywords` are exact matches against the keywords this org
> configured and the post hit at scan time (`EngageOpportunityState.matchedKeywords`),
> **not** a free-text search of the post body. For free-text content preview, use
> `GET /api/engage/keywords/:id/posts`. Passing both `keyword` and `keywords`
> unions the two into a single OR set.

**Response** `200 OK`

```json
{
  "items": [ /* EngageOpportunity[] */ ],
  "total": 142,
  "page": 1,
  "limit": 20
}
```

**UI Reference: Score Level Colors**

Total score max is 105 (scoreKeyword 35 + scoreHeat 45 + scoreAuthority 15 + scoreRecency 5 + scoreTracked 5). Only posts scoring ≥60 are stored.

| Score Range | Level | Recommended Color |
|---|---|---|
| 85–105 | High Priority | Dark Green |
| 70–84 | Medium Priority | Yellow-Green |
| 60–69 | Low Priority | Orange |

**Score field quick reference (for rendering per-dimension breakdowns):**

| Field | Max | Meaning |
|---|---|---|
| `scoreKeyword` | 35 | 关键词质量 — keyword match strength; each hit +15 |
| `scoreHeat` | 45 | 平台热度 — platform engagement (likes/replies/etc.) |
| `scoreAuthority` | 15 | 账号影响力 — author follower count / subreddit size |
| `scoreRecency` | 5 | 时效性 — freshness: 5 if within 24h, else 0 |
| `scoreTracked` | 5 | 重点账户 — 5 if author is a tracked account, else 0 |
| `score` | 105 | 总分 — sum of all dimensions |

---

### PATCH `/api/engage/opportunities/:id/dismiss`

Dismiss an opportunity (only valid for `NEW` / `AUTO_QUEUED` states).

**Response** `200 OK` — Returns the updated `EngageOpportunity`

**Error** `404` — Not found or already in a final state (REPLIED / SCHEDULED / DISMISSED)

---

### PATCH `/api/engage/opportunities/:id/bookmark`

Toggle bookmark status. Does not affect Feed sorting.

**Response** `200 OK` — Returns the updated `EngageOpportunity`

**Error** `404` — Opportunity not found

---

## Draft Generation — AI Draft Generation (SSE)

**Rate Limit**: Max 20 calls per user per hour.

### POST `/api/engage/opportunities/:id/draft`

Stream the generation of an AI reply draft. Response is Server-Sent Events (`text/event-stream`).

> **Note**: This endpoint is only valid for opportunities in `NEW` / `AUTO_QUEUED` status. Replied/Dismissed opportunities will return an error SSE frame.

**Request Body**

```json
{
  "strategy": "EXPERT_ANSWER",  // Required: 'EXPERT_ANSWER' | 'DATA_BACKED' | 'EMPATHY_LED'
  "brandStrength": 1,           // Required: 0-3 integer
  "mentions": ["AISEE"],        // Optional: brand names to weave in (max 20)
  "outputLength": 1000          // Optional: target reply length (chars); omit to use platform default
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `strategy` | `string` | ✓ | `EXPERT_ANSWER` / `DATA_BACKED` / `EMPATHY_LED` |
| `brandStrength` | `number` (0–3) | ✓ | Brand emphasis level (see table below) |
| `mentions` | `string[]` (max 20) | | Brand names the model may mention (used when `brandStrength` ≥ 2) |
| `outputLength` | `integer` (≥ 2) | | Target reply length fed into the prompt. Omitted → platform default (X = 260 weighted chars, Reddit = 1000 chars) |

**Output length & character limits**

`outputLength` is the **target** the model is instructed to aim for — it is not the hard rejection threshold:

| Platform | Default target | Hard cap (draft rejected above this) |
|---|---|---|
| X / Twitter | 260 Twitter-weighted chars | `outputLength` (with one automatic retry if the first draft overshoots) |
| Reddit | 1000 chars | `max(outputLength, 2000)` — drafts of 1000–2000 chars are accepted; only above 2000 fails |

> Reddit's real limit is ~10000 chars, so a 2000-char reply always posts fine. Keeping the target at 1000 favors concise, natural replies while tolerating a slight overshoot instead of failing the whole generation. A Reddit draft over the hard cap fails with `generation_failed` and is **not** retried (unlike X).

**Strategy Descriptions**

| strategy | Use Case | Generation Style |
|---|---|---|
| `EXPERT_ANSWER` | Help-seeking, Discussion | Expert step-by-step advice |
| `DATA_BACKED` | Any type | Conversational reply optionally supported by an observation or metric from the original post |
| `EMPATHY_LED` | Help-seeking, Ranting | Empathize first, then provide insights |

**Brand Strength Descriptions**

| brandStrength | Name | Behavior |
|---|---|---|
| `0` | None | Pure value output, no mention of AISEE |
| `1` | Implicit (Default)| Implicitly establishes authority |
| `2` | Natural | Naturally mentions AISEE when highly relevant |
| `3` | Direct | Proactively introduces AISEE and invites trial |

**SSE Response Format**

```
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
```

Per-line data format:

```
data: {"text": "Here is "}

data: {"text": "my expert answer..."}

data: [DONE]
```

On error:

```
data: {"error": "opportunity_unavailable"}

data: [DONE]
```

| error code | Meaning |
|---|---|
| `opportunity_unavailable` | Opportunity doesn't exist or is already in a final state (404) |
| `generation_failed` | Claude API call failed |

**Frontend Integration Example (TypeScript)**

```typescript
const response = await fetch(`/api/engage/opportunities/${id}/draft`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ strategy: 'EXPERT_ANSWER', brandStrength: 1 }),
  credentials: 'include',
});

const reader = response.body!.getReader();
const decoder = new TextDecoder();
let buffer = '';

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split('\n');
  buffer = lines.pop()!;
  for (const line of lines) {
    if (!line.startsWith('data: ')) continue;
    const data = line.slice(6);
    if (data === '[DONE]') return;
    const parsed = JSON.parse(data);
    if (parsed.error) throw new Error(parsed.error);
    setDraftText(prev => prev + parsed.text);
  }
}
```

---

## Reply Actions — Send/Schedule/Manual Reply

### POST `/api/engage/opportunities/:id/send-now`

**Send Immediately** — X reply (real-time call to X API via OAuth). If the opportunity already has a scheduled reply in `QUEUE` state, it is automatically cancelled first before sending.

> Internally: Check for existing scheduled reply → cancel if found → Atomic lock of opportunity → Call X API to post tweet → Write EngageSentReply → Trigger 24h metrics sync.

**Request Body**

```json
{
  "integrationId": "integration-uuid",  // Required, from Integration.id of GET /reply-accounts
  "draftContent": "Great point! Here's what I...",  // Required, max 4000 chars (Please keep within 280 for X)
  "strategy": "EXPERT_ANSWER",          // Required
  "brandStrength": 1                    // Required, 0-3
}
```

**Response** `200 OK` — Returns `EngageSentReply`

**Errors**
- `400` — Existing scheduled post is no longer pending (already published or failed)
- `404` — Opportunity doesn't exist or already replied (concurrency protection)
- `500` — X API call failed (opportunity status will automatically roll back)

---

### POST `/api/engage/opportunities/:id/schedule`

**Schedule Reply** for X (write to schedule queue, publish in future).

**Request Body** (Adds `scheduledAt` to SendReplyDto)

```json
{
  "integrationId": "integration-uuid",
  "draftContent": "Great point! Here's what I...",
  "strategy": "EXPERT_ANSWER",
  "brandStrength": 1,
  "scheduledAt": "2026-05-23T10:00:00.000Z"  // Required, ISO string, must be in the future
}
```

**Response** `200 OK` — Returns `EngageSentReply`

**Errors**
- `400` — `scheduledAt` is not in the future
- `404` — Opportunity doesn't exist or already replied

---

### POST `/api/engage/opportunities/:id/batch-schedule`

**Batch Schedule Reply** — Schedule replies from multiple integrations at different times in a single request.

> Internally: Single atomic claim → Creates one Post per item (each at its own `scheduledAt`) → Creates one `EngageSentReply` per item. All posts are rolled back if any Post creation fails. SentReply creation is best-effort (logged on failure, does not abort remaining items).

**Request Body**

```json
{
  "items": [
    {
      "integrationId": "integration-uuid-A",
      "draftContent": "Great point! Here's what I...",
      "strategy": "EXPERT_ANSWER",
      "brandStrength": 1,
      "scheduledAt": "2026-05-29T10:00:00.000Z"
    },
    {
      "integrationId": "integration-uuid-B",
      "draftContent": "Based on the data...",
      "strategy": "DATA_BACKED",
      "brandStrength": 2,
      "scheduledAt": "2026-05-29T14:00:00.000Z"
    }
  ]
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `items` | `array` | ✓ | 1–20 items |
| `items[].integrationId` | `string` | ✓ | Integration ID (from GET /reply-accounts) |
| `items[].draftContent` | `string` | ✓ | Reply content, max 4000 chars |
| `items[].strategy` | `string` | ✓ | `EXPERT_ANSWER` / `DATA_BACKED` / `EMPATHY_LED` |
| `items[].brandStrength` | `number` | ✓ | 0–3 |
| `items[].scheduledAt` | `string` | ✓ | ISO date string, must be in the future |

**Response** `200 OK` — Returns `EngageSentReply[]` (one entry per item)

**Errors**
- `400` — Any `scheduledAt` is not in the future, or array is empty / exceeds 20 items
- `404` — Opportunity doesn't exist or already replied

---

### POST `/api/engage/opportunities/:id/batch-send`

**Batch Send Reply** — Send replies from multiple integrations immediately in a single request.

> Internally: Single atomic claim → Calls X API sequentially per item → Creates one `EngageSentReply` + triggers metrics sync per item. Phase 1 (post creation) rolls back fully on failure; Phase 2 (record creation) is best-effort — individual failures are logged and skipped. Returns `500` only if **all** record creations fail.

**Request Body**

```json
{
  "items": [
    {
      "integrationId": "integration-uuid-A",
      "draftContent": "Great point! Here's what I...",
      "strategy": "EXPERT_ANSWER",
      "brandStrength": 1
    },
    {
      "integrationId": "integration-uuid-B",
      "draftContent": "Based on the data...",
      "strategy": "DATA_BACKED",
      "brandStrength": 2
    }
  ]
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `items` | `array` | ✓ | 1–20 items |
| `items[].integrationId` | `string` | ✓ | Integration ID (from GET /reply-accounts) |
| `items[].draftContent` | `string` | ✓ | Reply content, max 4000 chars |
| `items[].strategy` | `string` | ✓ | `EXPERT_ANSWER` / `DATA_BACKED` / `EMPATHY_LED` |
| `items[].brandStrength` | `number` | ✓ | 0–3 |

**Response** `200 OK` — Returns `EngageSentReply[]`. May be shorter than `items` if individual SentReply recording fails (individual failures are logged). Returns `500` only if all recording fails.

**Errors**
- `404` — Opportunity doesn't exist or already replied
- `500` — All X API calls failed (posts rolled back, claim released); or all posts published but zero records could be created

---

### POST `/api/engage/opportunities/:id/manual-reply`

**Reddit Manual Reply Confirmation** (User has manually replied on Reddit, confirming record).

> Due to API ToS restrictions, Reddit does not support automatic sending. Uses a "Copy Draft → Manual Paste → Return to Confirm" 3-step flow.

**Request Body**

```json
{
  "draftContent": "Here is my reply...",  // Required, max 4000 characters
  "strategy": "EXPERT_ANSWER",            // Required
  "brandStrength": 1                      // Required, 0-3
}
```

**Response** `200 OK` — Returns `EngageSentReply`

> After calling this endpoint, the record enters the Sent list with status "⚠ No reply URL submitted" until the URL is provided.

---

## Sent Replies — Sent Records

### GET `/api/engage/sent`

Retrieve the list of sent replies (includes original post summary and metrics data).

**Query Params**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `platform` | `string` | — | Platform filter |
| `status` | `'published' \| 'scheduled' \| 'manual' \| 'error'` | — | Status filter |
| `date` | `all \| day \| today \| week \| month` | `all` | Publish-date window (`day`/`today` aliased) |
| `page` | `number` | `1` | Page number |
| `limit` | `number` | `20` | Items per page, max 100 |

**Response** `200 OK`

```json
{
  "items": [
    {
      "id": "sent-reply-uuid",
      "organizationId": "...",
      "opportunityId": "opp-uuid",
      "postId": "post-uuid",
      "inputData": {
        "strategy": "EXPERT_ANSWER",
        "brandStrength": 1,
        "mentions": ["competitor_brand"]
      },
      "authorReplied": false,
      "createdAt": "...",
      "updatedAt": "...",
      "post": {
        "id": "post-uuid",
        "content": "Great point! Here's what I...",
        "state": "PUBLISHED",
        "releaseURL": "https://x.com/user/status/123456",
        "publishDate": "2026-05-22T10:00:00.000Z",
        "impressions": 1240,
        "trafficScore": 87.5,
        "analytics": [
          { "label": "Likes", "data": [42] },
          { "label": "Retweets", "data": [8] },
          { "label": "Replies", "data": [3] }
        ],
        "integration": {
          "id": "integration-uuid",
          "name": "mycompany_x",
          "providerIdentifier": "x",
          "picture": "https://..."
        }
      },
      "opportunity": {
        "id": "opp-uuid",
        "platform": "x",
        "externalPostUrl": "https://x.com/someuser/status/999",
        "postContent": "What's the best way to use AI for SEO?",
        "authorUsername": "someuser",
        "authorDisplayName": "Some User",
        "authorFollowers": 4747631,
        "authorAvatarUrl": "https://pbs.twimg.com/profile_images/.../avatar_400x400.jpg",
        "matchedKeywords": ["SEO", "AI"]
      }
    }
  ],
  "total": 38,
  "page": 1,
  "limit": 20
}
```

> `inputData` contains the generation metadata saved at reply time. Use it to pre-populate the edit form for scheduled replies. Fields: `strategy` (`EXPERT_ANSWER` | `DATA_BACKED` | `EMPATHY_LED`), `brandStrength` (0–3), `mentions` (optional string array).

**`post.state` Meanings**

| state | Meaning |
|---|---|
| `PUBLISHED` | Published |
| `QUEUE` | Scheduled |
| `ERROR` | Failed to send |

**Special Handling for Reddit Manual Replies**: When `post.releaseURL` is `null`, it means the user has not yet submitted the Reddit comment URL; they should be prompted to provide it.

---

### GET `/api/engage/sent/stats`

Retrieve summary statistics for sent records (used for the top of the Sent page). **Scoped by the same `date` / `platform` / `status` filters as `GET /sent`** so the stat cards always match the filtered list below them.

**Query Params** (all optional — identical to `/sent`, pagination ignored)

| Param | Type | Description |
|---|---|---|
| `date` | `all` \| `day` \| `today` \| `week` \| `month` | Publish-date window. `all` / omitted / unknown = all-time. `day` and `today` are aliases. Same vocabulary as `/dashboard/summary`. |
| `platform` | `x` \| `reddit` | Restrict to one platform (via the linked opportunity). |
| `status` | `published` \| `scheduled` \| `manual` \| `error` | Restrict to a reply lifecycle state. |

**Response** `200 OK`

```json
{
  "repliesCount": 23,        // Replies in the selected window (all-time when no date)
  "responseRate": 35,        // Response rate (integer percentage, 0-100) over the window
  "totalImpressions": 48620, // SUM(Post.impressions) over the windowed engage posts
  "totalTrafficScore": 1284, // SUM(Post.trafficScore) over the windowed engage posts, rounded
  "avgLikes": 18             // Average likes — X like_count / Reddit score, read from Post.analytics
}
```

> Every field reflects the selected `date`/`platform`/`status` window. With no `date`, the window is all-time (matching `/sent`). `avgLikes` is platform-aware: for X it reads the `Likes` metric, for Reddit the `score` metric, from each reply's `Post.analytics` blob (bounded to the 1,000 most recent replies in the window). The Dashboard panel (`/dashboard/summary`) has its own combined/platform-scoped fields and is unaffected by this change.

---

### PATCH `/api/engage/sent/:id`

Edit a **scheduled** (QUEUE) engage reply. All fields are optional; supply only what needs to change.

**URL Param**: `id` — `EngageSentReply.id`

**Request Body**

| Field | Type | Description |
|---|---|---|
| `content` | `string` (max 4000) | New reply text — written to `Post.content`, read by Temporal at publish time |
| `scheduledAt` | `string` (ISO date) | New publish time — must be in the future; restarts the Temporal timer with claim-gate protection |
| `strategy` | `'EXPERT_ANSWER' \| 'DATA_BACKED' \| 'EMPATHY_LED'` | Updated generation strategy — stored in `inputData` |
| `brandStrength` | `number` (0–3) | Updated brand strength — stored in `inputData` |
| `mentions` | `string[]` (max 20) | Updated mention list — stored in `inputData` |

```json
{
  "content": "Updated reply text here...",
  "scheduledAt": "2026-05-30T10:00:00.000Z",
  "strategy": "DATA_BACKED",
  "brandStrength": 2,
  "mentions": ["acme_corp"]
}
```

**Propagation**

- `content` → `Post.content` (the value Temporal reads when publishing to the social platform)
- `scheduledAt` → `Post.publishDate` via `PostsService.changeDate`, which terminates the old Temporal workflow and starts a new one sleeping until the new time
- `strategy` / `brandStrength` / `mentions` → `EngageSentReply.inputData` only (metadata for AI draft re-generation)

**Response** `200 OK` — Returns the updated `EngageSentReply` with `post` fields `{ id, content, state, publishDate }`.

**Errors**
- `400` — Reply has already been sent (post state is not `QUEUE`)
- `400` — `scheduledAt` is not in the future
- `400` — Post is within the 30 s publish lockout window (Temporal already claiming it)
- `404` — Record not found

---

### PATCH `/api/engage/sent/:id/reply-url`

**Reddit Manual Reply Only**. Submit a Reddit comment URL to enable metrics tracking.

**URL Param**: `id` — `EngageSentReply.id`

**Request Body**

```json
{
  "url": "https://www.reddit.com/r/SEO/comments/abc123/title/xyz789/"
}
```

URL format must match: `reddit.com/r/{subreddit}/comments/{post_id}/{title}/{comment_id}/`

**Response** `200 OK` — Returns the updated `Post` object (including `releaseURL`)

**Errors**
- `400` — Invalid URL format (must be a valid Reddit comment URL)
- `400` — This record is not a Reddit reply
- `404` — Record not found

---

## Dashboard Stats — Dashboard Statistics

The Engage data surfaces inside the existing Dashboard as three panels (no standalone page). Each panel has its own endpoint below.

> **Data source.** All figures derive from `Post` records with `source = 'engage'`. X reply metrics (`impressions`, `trafficScore`, `analytics`) are populated by `PostsService.checkPostAnalytics` using the integration's OAuth token — the same path regular posts use — so `impression_count` and `bookmark_count` are captured. The X traffic index uses the `x` weights in `traffic.calculator.ts` (`likes×1 + replies×2 + retweets×1.5 + quotes×2 + bookmarks×1.5`), which match the spec's `X_traffic_index`. Reddit replies are synced separately (`impressions = (score+comments)×20`, `trafficScore = score×1 + num_comments×3`). Engage posts are intentionally excluded from the global analytics job and aggregated via `EngageDataTicks` instead.

### GET `/api/engage/dashboard/summary`

**Panel ① — Engagement Performance.** Five headline metrics plus all-time platform split and best reply. The panel has platform chips/tabs:

- no `platform` param: combined X + Reddit view
- `platform=x`: X-only view
- `platform=reddit`: Reddit-only view

**Query Params**

| Param | Type | Default | Description |
|---|---|---|---|
| `platform` | `string` (`x` \| `reddit`) | — (all) | Scope the headline cards and best-reply badge to one platform. Empty / omitted = combined. |
| `date` | `all` \| `day` \| `week` \| `month` | `all` | Date window on `Post.publishDate`. `all` = all-time (no window); `day` = today; `week` = current ISO week; `month` = current calendar month. Empty / unknown = all-time. |

Every metric (`repliesCount`, `responseRate`, `totalImpressions`, `totalTrafficScore`, `totalLikes`, `platformSplit`, `bestReply`) is scoped to the selected `date` window and `platform`.

**Response** `200 OK`

```json
{
  "repliesCount": 23,             // Replies — all-time SENT (PUBLISHED) replies, scoped by platform if provided
  "responseRate": 35,            // Reply rate — authorReplied / total, integer percentage 0-100, scoped by platform if provided
  "totalImpressions": 48620,     // Total impressions — SUM(Post.impressions), scoped by platform if provided
  "totalTrafficScore": 1284,     // Traffic — SUM(Post.trafficScore), rounded, scoped by platform if provided
  "totalLikes": 1650,            // Total likes/upvotes — SUM(X like_count or Reddit score), scoped by platform if provided
  "xImpressions": 48620,         // Legacy helper — X-only SUM(Post.impressions), always X scoped
  "xTrafficIndex": 1284,         // Legacy helper — X-only SUM(Post.trafficScore), always X scoped and rounded
  "platformSplit": {             // Platform split — reply counts THIS WEEK per platform, used to render/switch X and Reddit chips
    "x": 15,
    "reddit": 8
  },
  "bestReply": {                 // Most-liked/upvoted reply in the selected scope, or null
    "opportunityId": "uuid",
    "platform": "x",
    "content": "Reply text...",
    "likes": 142,                // X like_count / Reddit score (from Post.analytics)
    "url": "https://twitter.com/.../status/123",  // Post.releaseURL, falls back to the original post URL
    "author": {                  // Account info of the original post's author (engagement source)
      "username": "koraygubur",
      "displayName": "Koray Gubur",
      "avatarUrl": "https://.../avatar.jpg"
    }
  }
}
```

- `bestReply` is `null` when no sent reply in the selected scope has any recorded likes/score yet.
- `bestReply.author` carries the original post author's handle/display name/avatar (`displayName` and `avatarUrl` may be `null`).
- `repliesCount`, `platformSplit`, and `bestReply` count only SENT (`PUBLISHED`) replies — future-scheduled (QUEUE) and errored replies are excluded — within the selected `date` window (all-time by default).
- In the combined view, `totalLikes` is `X likes + Reddit score`. In the Reddit chip view, the UI label should read "Total upvotes"; in the X chip view, it should read "Total likes".

---

### GET `/api/engage/dashboard/replies-trend`

**Panel ② — "Your Posts" chart overlay.** Engage reply counts bucketed by period, for the lime overlay bars on the existing posts chart.

**Query Params**

| Param | Type | Default | Description |
|---|---|---|---|
| `period` | `'daily' \| 'weekly' \| 'monthly'` | `daily` | Time aggregation granularity |
| `days` | `number` (1–90) | `30` | Legacy trailing-window size; ignored when `period` is set |

Lookback: 30 days (daily), 12 weeks (weekly), 12 months (monthly).

**Response** `200 OK`

```json
{
  "period": "daily",
  "items": [
    { "date": "2026-04-30", "count": 0, "x": 0, "reddit": 0 },
    { "date": "2026-05-01", "count": 3, "x": 2, "reddit": 1 }
    // ... one entry per bucket, zero-filled, oldest → newest
  ]
}
```

- Date format: `YYYY-MM-DD` (daily/weekly — ISO week Monday), `YYYY-MM` (monthly).
- Buckets are pre-seeded for every slot in the window so the chart is continuous with no gaps.
- Includes **today**, which the daily `EngageDataTicks` aggregate does not yet cover.

---

### GET `/api/engage/dashboard/traffics`

**Panel ③ — "Traffic from Engage".** Total traffic index ("clicks") plus a per-reply breakdown for the progress-bar list.

**Query Params**

| Param | Type | Default | Description |
|---|---|---|---|
| `platform` | `string` (`x` \| `reddit`) | — (all) | Restrict the aggregate and list to one platform. Pass `x` for the X-only "X 流量指数汇总". |
| `limit` | `number` (1–50) | `10` | Number of top-traffic replies to return |

**Response** `200 OK`

```json
{
  "totalClicks": 1284,         // Total clicks — SUM(Post.trafficScore) over engage posts (filtered by platform if given)
  "items": [                   // Top-N replies by trafficScore, descending
    {
      "opportunityId": "uuid",
      "platform": "x",
      "content": "Reply text...",
      "clicks": 312,           // this reply's Post.trafficScore, rounded
      "time": "2026-05-20T10:00:00.000Z",  // Post.publishDate
      "url": "https://twitter.com/.../status/123"  // Post.releaseURL, falls back to the original post URL
    }
  ]
}
```

- Only replies whose `Post.trafficScore` is non-null appear in `items`.
- Omit `platform` to total both X and Reddit; pass `platform=x` for the X-only figure the panel headlines.

---

### GET `/api/engage/dashboard/impressions`

**Panel ④ — "Engage Impressions Trend".** Impressions by publish date and platform, bucketed by period. Response shape matches `/dashboard/impressions` so the same chart component can consume both endpoints.

**Query Params**

| Param | Type | Default | Description |
|---|---|---|---|
| `period` | `'daily' \| 'weekly' \| 'monthly'` | `daily` | Time aggregation granularity |

Lookback: 30 days (daily), 90 days (weekly), 365 days (monthly).

**Response** `200 OK`

```json
[
  { "date": "2026-05-01", "value": 1500, "platform": "x" },
  { "date": "2026-05-01", "value": 800, "platform": "reddit" },
  { "date": "2026-05-02", "value": 2300, "platform": "x" }
]
```

- `value` is SUM(Post.impressions) for posts with `source = 'engage'` on that platform in that time bucket.
- Data comes directly from the Post table (written by `engageMetricsSyncWorkflow`), not DataTicks.
- Only dates with actual impressions appear; no zero-fill is applied. The chart component handles gaps.
- Date format: `YYYY-MM-DD` (daily/weekly — ISO week Monday), `YYYY-MM` (monthly).

---

### GET `/api/engage/dashboard/top-sources`

**Panel ⑤ — "Top engage sources".** Engage replies aggregated by the **original post author** (the traffic source), ranked by traffic index ("clicks"). Note: the mockup's "Visitors" metric is not tracked and is omitted.

**Query Params**

| Param | Type | Default | Description |
|---|---|---|---|
| `platform` | `string` (`x` \| `reddit`) | — (all) | Restrict to one platform. |
| `limit` | `number` (1–50) | `10` | Number of top sources to return. |

**Response** `200 OK`

```json
{
  "totalClicks": 51,             // SUM(Post.trafficScore) across all sources (not just top-N)
  "items": [
    {
      "author": "koraygubur",    // original post author handle
      "avatar": "https://.../avatar.jpg",  // author avatar, or null
      "platform": "x",
      "clicks": 30,              // SUM(Post.trafficScore) for this author, rounded
      "replies": 3               // number of replies sent to this author
    }
  ]
}
```

- Sources are grouped by `(platform, authorUsername)` and sorted by `clicks` descending.
- "clicks" is the rounded traffic index (weighted engagement), not literal link clicks.

---

## Scan — Manual Scan Trigger

### POST `/api/engage/scan`

Immediately trigger a scan without waiting for the next cadence window.

Internally, this sends the `triggerScanNow` signal to the global `engage-scan-ticker` workflow, which wakes immediately and runs **all** scan units (force = bypass the per-type cadence gate, but not the per-unit rate-limit cooldown). If the ticker isn't running yet it is started, then signaled.

**Rate Limit**: Max 5 calls per organization per hour.

**Request Body**

A JSON array of keyword IDs to scan. Pass an empty array (or omit the body) to scan all enabled keywords.

```json
["keyword-uuid-1", "keyword-uuid-2", "keyword-uuid-3"]
```

| Body | Behavior |
|------|----------|
| `["id1", "id2"]` | Only scan the specified keywords |
| `[]` | Scan all enabled keywords |
| _(empty body)_ | Scan all enabled keywords |

**Response** `200 OK` — Empty body (fire-and-forget; scan runs asynchronously)

**Errors**
- `429 Too Many Requests` — Rate limit exceeded (5 calls/hour/org)

> **Note**: A forced scan runs on the next ticker wake (≤ `ENGAGE_SCAN_TICK_MINUTES`, default 5 min) and results appear shortly after. The normal per-type cadence (keyword 24h / channel 3h / tracked 3h) is unaffected.

---

## Error Handling

All error response formats (NestJS default):

```json
{
  "statusCode": 404,
  "message": "Opportunity not found",
  "error": "Not Found"
}
```

| HTTP Status Code | Meaning |
|---|---|
| `400 Bad Request` | Parameter validation failed, invalid URL format, scheduledAt is not in the future |
| `404 Not Found` | Resource doesn't exist, doesn't belong to current organization, opportunity already in a final state |
| `429 Too Many Requests` | Draft generation rate limit exceeded (20 calls/hour/user); or scan trigger rate limit exceeded (5 calls/hour/org) |
| `500 Internal Server Error` | X API call failed, database exception |

**Concurrency Protection**: `POST /reply`, `POST /schedule`, `POST /batch-send`, and `POST /batch-schedule` all use internal atomic locks on the opportunity. Only one concurrent request will succeed; others return `404` ("Opportunity already claimed by another request"). The batch endpoints claim the opportunity once and create multiple posts/replies within that single claim.

---

## Appendix: Scoring Algorithm Quick Reference

```
// Total Score (Only ≥60 enters the Feed)
total = scoreKeyword(0-35) + scoreHeat(0-45) + scoreAuthority(0-15)
      + scoreRecency(0-5) + scoreTracked(0 or 5)   // max 105

// X Heat
x_heat = likes×1 + replies×3 + retweets×2 + quotes×2
// Threshold mapping: >2000→45, >1000→33, >300→23, >80→12, else→4

// Reddit Heat
reddit_heat = score × upvote_ratio + num_comments × 2
// Thresholds: >800→45, >400→33, >100→23, >30→12, else→4

// X Traffic Index (Used for display on Sent page)
x_traffic = likes×1.0 + replies×2.0 + retweets×1.5 + quotes×2.0 + bookmarks×1.5

// Reddit Estimated Impressions
reddit_impressions = (score + num_comments) × 20

// Reddit Traffic Index
reddit_traffic = score×1.0 + num_comments×3.0
```
