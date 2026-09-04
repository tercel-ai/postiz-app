# Engage Module — Frontend API Reference

**Version**: 1.0  
**Date**: 2026-07-16
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
  - [GET /opportunities](#get-apienageopportunities) — paginated signal feed
  - [GET /opportunities/:id](#get-apienageopportunitiesid) — single signal-feed item
  - [GET /opportunities/locate](#get-apienageopportunitieslocate) — locate the page of an opportunityId within /opportunities
  - [GET /opportunities/counts/summary](#get-apiengageopportunitiescountssummary) — total/byStatus/byPlatform rollup for /opportunities
  - [GET /opportunities/count](#get-apiengageopportunitiescount) — total + byStatus under exactly the /opportunities filters
- [Draft Generation — AI Draft Generation (SSE)](#draft-generation--ai-draft-generation-sse)
  - [POST /opportunities/:id/draft](#post-apienageopportunitiesiddraft) — stream an AI draft (not persisted)
  - [POST /opportunities/:id/save-draft](#post-apienageopportunitiesidsave-draft) — save an unpublished working draft (DRAFT)
- [Reference-Post Generation — Original Post Inspired By An Opportunity](#reference-post-generation--original-post-inspired-by-an-opportunity)
  - [POST /opportunities/:id/generate-post](#post-apienageopportunitiesidgenerate-post) — stream an AI-generated original post AND save it as a DRAFT (not a reply)
- [Reply Actions — Send/Schedule/Manual Reply](#reply-actions--sendschedulemanual-reply)
  - [POST /send-now](#post-apienageopportunitiesidsend-now) — immediate single (cancels scheduled if exists)
  - [POST /schedule](#post-apienageopportunitiesidschedule) — scheduled single
  - [POST /batch-schedule](#post-apienageopportunitiesidatch-schedule) — scheduled multi-integration
  - [POST /batch-send](#post-apienageopportunitiesidatch-send) — immediate multi-integration
  - [POST /manual-reply](#post-apienageopportunitiesidanual-reply) — Reddit manual
- [Browser-Extension Replies — Standalone In-Browser Replies](#browser-extension-replies--standalone-in-browser-replies)
  - [POST /extension-replies](#post-apienageextension-replies) — record an extension reply
  - [GET /extension-replies](#get-apienageextension-replies) — paginated history
  - [DELETE /extension-replies](#delete-apienageextension-replies) — clear history (all | 1d | 1w | 1m)
- [Sent Replies — Sent Records](#sent-replies--sent-records)
  - [GET /sent](#get-apienagesent) — paginated list (`status` rollups: `settled` = live+scheduled, `awaiting` = draft+manual+error; `awaiting-draft` / `awaiting-expired` / `awaiting-link` sub-filter the Awaiting-review tabs)
  - [GET /sent/:id](#get-apienagesentid) — single sent reply item
  - [GET /sent/locate](#get-apienagesentlocate) — locate the page of a sentReplyId within /sent
  - [GET /sent/stats](#get-apienagesentstats) — aggregate stats
  - [GET /sent/counts/summary](#get-apiengagesentcountssummary) — total/byPlatform/rollups/awaitingBreakdown rollup for /sent
  - [GET /sent/count](#get-apiengagesentcount) — filtered counts under exactly the /sent filters
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
- `projectId` is an opaque Aisee product id. When supplied, reads/writes are scoped to that project. Omitting it preserves the legacy organization-wide/null-project behavior during migration.

### Project-Scoped Requests

The following endpoints accept `projectId` as a query parameter: `GET /config`, `POST /config/reset`, `GET /monitored-channels`, `GET /tracked-accounts`, `GET /reply-accounts`, `GET /opportunities/score-stats`, `GET /opportunities/counts/summary`, `GET /opportunities/count`, `GET /opportunities`, `GET /opportunities/:id`, `PATCH /opportunities/:id/dismiss`, `PATCH /opportunities/:id/bookmark`, `GET /opportunities/locate`, `GET /sent`, `GET /sent/locate`, `GET /sent/stats`, `GET /sent/counts/summary`, `GET /sent/count`, `GET /dashboard/summary`, `GET /dashboard/replies-trend`, `GET /dashboard/traffics`, `GET /dashboard/impressions`, and `GET /dashboard/top-sources`.

Mutation endpoints that create project-owned config records accept `projectId` in the JSON body: `POST /setup`, `POST /config`, `POST /keywords`, `POST /keywords/bulk`, `POST /monitored-channels`, and `POST /tracked-accounts`.

Reply mutation endpoints use the `stateId` returned with each opportunity (`POST /opportunities/:stateId/draft`, `save-draft`, `send-now`, `schedule`, `batch-send`, `batch-schedule`, and `manual-reply`). The backend derives the project and shared opportunity identities from that state row, so a reply request does not need `projectId`. The older `opportunity id + projectId` form remains supported for compatibility.

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
type ReplyStrategy =
  | 'EXPERT_ANSWER'
  | 'DATA_BACKED'
  | 'EMPATHY_LED'
  | 'CONTRARIAN'
  | 'QUESTION_LED'
  | 'QUICK_TAKE'
  | 'AMPLIFY';

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
  monitoredChannels: MonitoredChannel[];   // channel-scope scan targets (reddit)
  trackedAccounts: EngageTrackedAccount[];
  // Unattended-reply controls (§ Unattended Replying below). Two different
  // grains: autoReplyEnabled is a project-level switch, replyPolicies refines it
  // per platform. Neither is an embedded relation — plain columns on this row.
  autoReplyEnabled: boolean;
  replyPolicies: Record<string, ReplyPolicy> | null;
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
  // Admin-configured operation-plan limits (only returned by GET /config), so a
  // plan-creation UI can bound its date range / platform picker from this same
  // call. Global admin Settings, NOT per-org config — see
  // docs/operation-plan-api.md § Admin Settings.
  operationPlan: {
    maxDurationDays: number;    // operation_plan.max_duration_days (default 30)
    // RESOLVED, ready-to-use list — see the note below. NOT the raw setting.
    allowedPlatforms: string[];
  };
}
```

> **`allowedPlatforms` is resolved, not raw.** It is `connected integrations ∩ operation_plan.allowed_platforms` (or simply every connected platform when that allowlist is empty) — i.e. exactly the set `POST /projects/:projectId/operation-plans` will accept, since it applies both gates. Render the platform picker straight from this list and it can never offer something the server rejects.
>
> Because it is resolved, an **empty array means "no platform is available"** (nothing connected, or the allowlist excludes everything connected) — a real, actionable state. It never means "everything", even though the underlying setting's empty value does mean "no extra restriction" server-side.

> `operationPlan` deliberately omits `operation_plan.platform_cadence`: that key steers the generator's editorial strategy (posting rhythm / AI-citation weight) and no client has a use for it. The block degrades to the backend defaults (`30` / `[]`) if the Settings rows are unset or unreadable — a settings hiccup never fails the Engage page.

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

### MonitoredChannel

> **Storage note.** There is no `EngageMonitoredChannel` table any more — monitored
> channels are `EngageTrackedAccount` rows whose platform has a *channel* scope
> (reddit). The `/monitored-channels` routes are a **thin alias** that keeps this
> wire shape unchanged (`username`→`channelId`, `displayName`→`channelName`,
> `lastCheckedAt`→`lastScannedAt`), so no client change was needed. See
> `tech-design.md` § SCAN TARGETS.

```typescript
interface MonitoredChannel {
  id: string;
  configId: string;
  organizationId: string;
  platform: string;      // 'reddit' — the only platform with a channel scope
  channelId: string;     // e.g. 'seo' — the CANONICAL key (see below)
  channelName: string;   // e.g. 'r/SEO' (display name; never null)
  audienceSize: number;
  enabled: boolean;
  lastScannedAt: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}
```

> **`channelId` is normalised on write.** The server stores the canonical
> scan-unit key: lowercased, with a leading `r/` or `u/` and any trailing slashes
> stripped. `r/SEO`, `/r/SEO/` and `SEO` all store — and read back — as `seo`.
> Match it case-insensitively if you compare it against a value from Reddit,
> which returns the community's display casing.
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

### Reply Accounts & Reply Policies

Two independent concepts, at two different grains — merged into one nested
config table until the rework this doc reflects:

| | Grain | Applies to | Lives on |
| --- | --- | --- | --- |
| **Reply account** — may this connected account send Engage replies, in this project? | (integration, project) | Platforms that reply through a connected account (**X** today) | `IntegrationProject.engageEnabled` |
| **Reply policy** — is this platform auto-replied to, and where/when? | (project, platform) | Every engage platform, including extension-published ones (Reddit, …) | `EngageConfig.replyPolicies` (see `POST /config` above) |

A platform that publishes replies through the browser extension's own session
(Reddit and friends) has no "which account" question to answer — nothing picks
an account for it — so it never appears in `GET /reply-accounts`; its only
control is the reply policy.

```typescript
// GET /reply-accounts returns Integration objects with a flat engageEnabled —
// no nested config object.
interface Integration {
  id: string;
  name: string;
  providerIdentifier: 'x';   // scoped to ACCOUNT_REPLY_PLATFORMS (['x'] today)
  picture: string | null;
  // Other Integration fields...
  // May Engage reply as this account, for the requested project. Absent binding
  // (account not bound to the project, or no projectId given) reads as `true` —
  // opt-OUT, not opt-in: a connected account is usable until excluded.
  engageEnabled: boolean;
}

// EngageConfig.replyPolicies value shape, keyed by platform.
interface ReplyPolicy {
  autoReplyEnabled?: boolean;
  windowStart?: string;   // 'HH:MM', local to `timezone`
  windowEnd?: string;
  timezone?: string;      // IANA; omitted window = UTC
  defaultStrategy?: ReplyStrategy;
  length?: 'short' | 'medium' | 'long';   // draft length tier; omit for 'medium'
  mentionTags?: string[];                 // @-mentions steered into the draft
  checkIntervalMinutes?: number;          // overrides engage_reply_pacing.minGapMinutes for THIS platform
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
  channelFollowers: number | null; // Reddit: subreddit audience size (drives authority); X: null
  authorUsername: string | null;
  authorDisplayName: string | null;
  authorAvatarUrl: string | null;
  authorFollowers: number | null; // X: post author's real followers; Reddit: null (not collected)
  postContent: string;
  postPublishedAt: string;
  // Scoring (0-105) — heat/authority/recency are global; keyword/tracked/total per-org
  score: number;
  scoreKeyword: number;     // Keyword score 0-35 (关键词质量)
  scoreHeat: number;        // Heat score 0-45 (平台热度)
  scoreAuthority: number;   // Authority 0-15 — X: author followers; Reddit: channelFollowers (账号影响力)
  scoreRecency: number;     // Recency score 0-5: within 24h→5, else→0 (时效性)
  scoreTracked: number;     // 0 or 5: X tracked account OR Reddit monitored subreddit (重点账户/频道)
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
  // Attachment URLs (X photos / videos). ALWAYS an array — `[]` when the post
  // has none, which is most rows. postContent cannot carry these: it strips X's
  // t.co attachment placeholder, which x.com renders as an image, not as text.
  // Derived from EngageOpportunity.rawData; rawData ITSELF IS NOT RETURNED (it
  // archives a whole tweet payload server-side). See opportunity-content-rendering.md.
  mediaUrls: string[];
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
    state: string;         // 'PUBLISHED' | 'QUEUE' | 'ERROR' | 'DRAFT' (DRAFT only via ?status=awaiting)
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

### EngageExtensionReply

Standalone in-browser replies logged by the Postiz browser extension (Option A). Unlike `EngageSentReply`, these are **not** bound to an `EngageOpportunity` or a `Post` — the extension replies to an arbitrary Reddit/X URL using the user's own browser session and reports the result back.

```typescript
interface EngageExtensionReply {
  id: string;
  organizationId: string;
  platform: string;          // 'reddit' | 'x'
  targetUrl: string;         // the post/tweet that was replied to
  content: string;           // reply text
  permalink: string | null;  // URL of the posted reply (Reddit comment / X status)
  postId: string | null;     // reddit fullname (t1_/t3_) or X tweet rest_id
  status: string;            // 'sent' | 'pending' | 'failed' (default 'sent')
  createdAt: string;
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
  "projectId": "product_123",
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
| `projectId` | No | Project scope for the created config/keywords/channels/accounts. Omit for legacy null-project config. |
| `keywords` | **Yes** (1–100 items) | Keywords to monitor. `type` optional (`CORE`/`BRAND`/`COMPETITOR`). Duplicates skipped. |
| `monitoredChannels` | No | Channels to scan. Duplicates (`platform`+normalised `channelId`) skipped. Each entry is validated exactly as `POST /monitored-channels` — a bad platform or community name rejects the whole payload with a 400. |
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

**Query Params**

| Parameter | Type | Description |
|---|---|---|
| `projectId` | string | Optional project scope. Omit to get the org-wide aggregate (every real project's enabled keywords/channels/tracked accounts, unioned) layered onto the legacy null-project row's own settings — this is what the browser extension, which has no project context, calls. |

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
  "autoReplyEnabled": false,
  "replyPolicies": null,
  "automationEnabled": false
}
```

> **Frontend routing**: If `enabled: false`, redirect to the Setup Wizard. If `enabled: true`, render the Signal Feed.

> **`automationEnabled`** is the Automation master switch (see
> [automation-api.md](../automation-api.md#the-switch-chain)), read-only here.
> With a `projectId`, it is that project's own switch. Without one, it is an
> OR across every one of the org's real projects — this org-wide view has no
> single project to report a scoped value for, so it can only answer "is
> automation running anywhere." A client that needs a specific project's
> switch — or wants to change it — must call
> `GET /projects/:projectId/automation` directly.

---

### POST `/api/engage/config`

Update configuration fields. Does not perform bulk writes to related tables — use `POST /setup` for the initial wizard submission.

**Request Body**

```jsonc
{
  "enabled": true,
  "projectId": "product_123",
  "autoReplyEnabled": true                     // optional; omit = unchanged
}
```

**`autoReplyEnabled` — unattended replying.** The opt-in switch for turning a
project's operation-plan reply targets from a ceiling into a driver:

| Value | Behaviour |
| --- | --- |
| `false` (default) | The plan's `targetRepliesPerDay` / `keywordTargets` stay a **send-time ceiling** on replies a user initiates. Nothing is generated or sent on its own. |
| `true` | The backend drafts up to the day's budget and the browser extension posts them, unattended, using the user's own platform session. |

Replaced a tri-state `autoReplyMode` (`off | review | auto`) whose middle value
parked drafts for a human to send. Managed replying has one behaviour, so that
described a step the product does not have — and no client ever set it to
anything but `review`. Stored rows carrying the old key are read as this boolean
(`review`/`auto` → `true`); there is no migration, the first write drops the key.

Defaults to `false` deliberately: replying with a real account's session is the
irreversible part of this feature, so it is opted into per project.

Switching it ON **requires `projectId`** — the driver only reads
project-scoped configs, so a switch set on the legacy null-project row would be
stored, echoed back, and never do anything. Sending one returns `400` with
`code: "engage_auto_reply_requires_project"`. Turning it `off` is never blocked.

Omitting the field leaves the stored switch unchanged, so a plain enable/disable
of Engage itself never resets it.

**`replyPolicies` — per-platform refinement.** `autoReplyEnabled` decides WHETHER
a project replies unattended at all; `replyPolicies` decides WHERE and WHEN, keyed
by platform:

```jsonc
{
  "replyPolicies": {
    "reddit": {
      "autoReplyEnabled": true,
      "windowStart": "09:00",       // 'HH:MM', local to `timezone` below
      "windowEnd": "18:00",
      "timezone": "Asia/Shanghai",  // IANA; omitted window = UTC
      "defaultStrategy": "EXPERT_ANSWER",
      "length": "medium",           // optional; omit for 'medium'
      "mentionTags": ["@aisee"],    // optional; omit for none
      "checkIntervalMinutes": 30    // optional; omit to use the org-wide default
    }
  }
}
```

A platform absent from the map — or present with `autoReplyEnabled: false` —
is never auto-replied to, **even when the project-level `autoReplyEnabled` is
on**. This is the one place where "no setting" means OFF rather than "inherit":
an unconfigured
platform must not start replying on its own just because the project opted in
generally. Conversely, **the platform loop is entirely data-driven off this
map's keys** — any platform can be given a policy, not just Reddit/X — but see
the caveat below on how far unattended sending actually reaches.

The map is **replaced wholesale** — send every platform's policy you want kept,
not just the one you're changing (the client should merge locally against the
value `GET /config` returned, then POST the merged map).

`windowStart`/`windowEnd` bound the LOCAL-time hours the driver may hand out
replies for this platform (a window that wraps past midnight, e.g. `22:00`–
`02:00`, is honoured as a wrap). Omit both for no window restriction.
`defaultStrategy` is the reply strategy `POST /reply-due` drafts with on this
platform; omit for `EXPERT_ANSWER`. `length` is the draft length tier (mirrors
the user-driven `POST /opportunities/:id/draft`'s `length`); omit for `medium`.
`mentionTags` are steered into the generated draft the same way the user-driven
path's `mentions` are. `checkIntervalMinutes` overrides the org-wide
`engage_reply_pacing.minGapMinutes` for THIS platform only — useful because
platforms carry very different account risk (e.g. a slower cadence on X than on
Reddit).

**Unattended reach.** The backend driver (this endpoint's scheduling half) will
draft for any platform with a policy — Reddit, X, LinkedIn, whatever. Sending
additionally requires the browser extension to know how to POST a reply on that
platform; today it only does for `reddit`/`x`. A policy on another platform still
drafts and parks replies until the extension gains a poster for it — it will not
error, but it will not send either.

**Response** `200 OK` — Returns the updated `EngageConfig` (without embedded relations).
`GET /api/engage/config` echoes `autoReplyEnabled` and `replyPolicies` back for the
project-scoped view; the org-wide aggregate view always reports the (inert)
null-project row's value.

---

### POST `/api/engage/reply-due`

The browser extension polls this for reply drafts that are due right now, across
every project whose `autoReplyEnabled` is on. The mirror of
`POST /posts/publish-due`: backend = scheduler, extension = executor — this
endpoint makes **no** platform call. It claims whatever is already queued, then
generates more if the per-platform cap allows, and returns what is ready.

Deliberately org-scoped with **no `planId`**: a project needs no operation plan
for this to run at all — see **Plan budget** below.

**Pacing.** Governed by the `engage_reply_pacing` setting: `maxPerPoll` (default
1) bounds how much one poll may hand out **for each platform independently** —
a busy Reddit slate does not starve X, and vice versa, within the same poll,
though it IS shared across every project on that platform. Also: the minimum
spacing between two replies of the same project+platform (`minGapMinutes`,
default 25), the UTC active-hours window, the maximum age of a post worth
replying to, and the minimum opportunity score. A trickle per poll is what
spreads a day's target across the day — handing out a whole budget at once is
what gets an account rate-limited.

**Plan budget.** Off by default (`ENGAGE_REPLY_BUDGET_GATE_ENABLED` unset) — the
driver is then paced by interval/active-hours alone and drafts happily for a
project with no active operation plan. Set `ENGAGE_REPLY_BUDGET_GATE_ENABLED=true`
to additionally gate on the project's active plan (`targetRepliesPerDay` /
`dailyHardCap` / `keywordTargets` via `EngageService.getReplyBudget`): with the
flag on, a project with no active plan — or one whose daily target is already
spent — is skipped entirely rather than spaced only by interval.

**Response**

```jsonc
{
  "due": [
    {
      "sentReplyId": "<engage-sent-reply-uuid>",  // the queued reply record
      "opportunityId": "<opportunity-uuid>",
      "projectId": "product_123",
      "platform": "reddit",
      "url": "https://reddit.com/r/x/comments/1", // the post being replied to
      "text": "…"                                  // the generated reply
    }
  ]
}
```

Every item is a `Post(state=QUEUE)` claimed under a lease. They do **not** appear
in Awaiting review — that lists `DRAFT`, which now means exactly "a person saved
this and has not sent it".

There is no `mode` field. It used to carry the project's `autoReplyMode`, and the
extension posted only the `"auto"` items, parking `"review"` for a human. Both
are retired — managed replying has one behaviour.

It was deleted rather than kept as a constant because the API carries exactly one
contract: see [Extension version floor](#extension-version-floor).

**Queued, claimed, drained — the same shape as scheduled posts.** The driver
writes each generated reply as `Post(state=QUEUE)` and this endpoint hands it to
a browser under a lease, exactly as `POST /posts/publish-due` does for scheduled
posts. Same two columns (`releaseId` + `claimedAt`), same claim, same release.

| | Scheduled post | Engage reply |
| --- | --- | --- |
| Waiting | `Post(state=QUEUE)` | same |
| Drained by | `POST /posts/publish-due` | `POST /api/engage/reply-due` |
| Lease | `releaseId` + `claimedAt` | same |
| Released by | publish backfills `PUBLISHED` | same |
| Paced by | each post's own `publishDate` | the driver's window + minimum gap |

**Sharing the state machine is not sharing the pipeline.** A reply is a
`Post(state=QUEUE)` like any other, so every mechanism that walks QUEUE posts
sees it — and two of them must not act on it. Both exclude it by
`source: 'engage'`, and both would fail loudly if they did not:

| Mechanism | Engage replies | What excluding it prevents |
| --- | --- | --- |
| `POST /posts/publish-due` | **excluded** | The due-item shape carries no reply target, so the extension would publish the text as a brand-new post (X) or reject it forever for lacking a subreddit (Reddit). |
| `markStaleQueuePostsAsError` (7-day sweep) | **excluded** | A reply Post matches neither routing branch — no `publishMethod`, no integration — so it would be swept to `ERROR`. Waiting a week is a user who has not opened Chrome, not a failure, and `retryPost` could not resurrect it (it needs an integration). |

`publishMethod: EXTENSION` would have inherited the sweep's existing exclusion,
but it is not available: publish-due selects on exactly that field, so setting it
would hand replies to the wrong drain. `source` is what separates them.

**Redelivery is not a separate mechanism — it is what a lease already does.** A
claim that never results in a send (browser closed, network dropped, platform
errored) simply expires, and the reply is offered again on a later poll. Nothing
tracks attempts and nothing needs to.

**A queued reply passes the same gates as a fresh one**, per (project, platform):

| Gate | Queued | Fresh | Why |
| --- | --- | --- | --- |
| local-time window | ✅ | ✅ | it decides *when* a reply may leave; a re-offer at 3am is outside the hours the project set |
| minimum gap | ✅ | ✅ | draining a backlog as fast as the extension polls is the burst the gap exists to prevent |
| plan budget | ❌ | ✅ | the budget bounds what is *produced*; a queued reply was counted when generated, and blocking it would strand what the budget already paid for |

One queued reply per (project, platform) per poll, mirroring generation — a
backlog therefore clears at the configured pace, deliberately. Re-offers cost
nothing to produce but still consume `maxPerPoll`, because the cap protects the
user's account and the account cannot tell a re-offer from a first attempt. The
queue is drained before anything new is generated, or new work would permanently
outrank the replies already waiting.

`claimLeaseMinutes` in `engage_reply_pacing` (default **30**) sets how long a
claimed reply stays spoken for. **It must exceed the extension's poll interval**
(15 min) with room to spare — a shorter lease hands a reply still being posted to
a second client, which is the one failure this must never introduce.

> **`state` is the only thing separating an automated reply from a human's
> draft.** `POST /opportunities/:id/save-draft` writes `DRAFT`; the unattended
> driver writes `QUEUE`. Both produce an `EngageSentReply` over a `Post` and are
> otherwise identical. A `DRAFT` belongs to a person who has not pressed send —
> it waits in Awaiting review and no automated path may claim it. The public
> save-draft endpoint accepts no `state` for exactly this reason: a client able
> to ask for `QUEUE` could put text in front of a real audience with no human
> step. Queueing is `EngageService.queueAutoReply`, reachable only by the driver.

Each draft costs reply-generation credits and is admitted by the same monthly cap
as the user-driven `POST /opportunities/:id/draft`.

---

### Extension version floor

The extension runs in browsers nobody controls, updated on Chrome's schedule, so
several builds are always live at once. Two ways to handle that, and only one
scales:

**Serve every old shape forever.** Each retired field leaves a permanent shim,
because "has the whole fleet updated?" has no answer — so the shim is never
removed and the contract only ever grows.

**State the contract and refuse builds too old to speak it.** The API carries one
shape; a stale client is told to update rather than quietly handed a payload it
will misread.

The second is what runs. Every extension call sends `x-aisee-ext-version`
(its Chrome manifest version). `ExtensionVersionGuard` compares it against the
`extension_min_version` setting and answers **`426 Upgrade Required`** below the
floor:

```jsonc
{
  "code": "extension_upgrade_required",
  "message": "This extension build (1.2.0) is older than the minimum supported version (2.0.0). Update the extension to continue.",
  "minVersion": "2.0.0",
  "yourVersion": "1.2.0"
}
```

The extension's `backendCall` turns a 426 into an `UpgradeRequiredError`, pauses
**all** background loops, and calls `chrome.runtime.requestUpdateCheck()` — which
typically turns "within a day or two" into minutes. Handled centrally in the
transport rather than per loop, because one refusal has to stop every loop and a
check per runner is a check the next runner forgets. The pause is mirrored into
`chrome.storage.local`, so an MV3 worker eviction does not silently un-pause it,
and it clears itself once the running build differs from the refused one — a
successful update must not leave the user stuck on "please update".

### Telling a client the floor BEFORE it is refused

Every served response to an extension caller carries
**`x-aisee-ext-min-version`**. A 426 says "you have stopped working", which is
too late to be a warning; the header says "you will stop working", while
everything still functions.

It is a header rather than a field on `/engage/config`, `/user/subscription`, or
any other payload, for two reasons:

- The floor is a property of the **contract**, not of engage config or of a
  subscription. Those endpoints would be carrying it only because they happen to
  be called.
- A client already below the floor gets 426 from **every** business endpoint —
  so a payload field is unreadable in exactly the situation it exists for. The
  header is present on the served and the refused answer alike.

The extension records it in `chrome.storage.local` from `fetchRequestUtil` (one
place, every call) and the popup renders a **banner over the working UI** while
the build is below the floor but not yet refused — never a block, because the
extension still works and taking it away would be the wrong trade. Once actually
refused, the banner yields to the blocking notice; two notices about the same
thing is one too many.

Both headers are listed in the API's CORS config — `x-aisee-ext-version` under
`allowedHeaders`, `x-aisee-ext-min-version` under `exposedHeaders`. A service
worker with host permissions bypasses CORS, but the same transport is reachable
from page contexts that do not, and a request header missing from `allowedHeaders`
fails preflight — taking out every call rather than just this one.

Four properties make raising the floor safe:

- **No header, no gate.** The web app and server-to-server calls state no version
  and pass. They have no build to gate, and refusing them would take out the
  whole API rather than just stale extensions.
- **The default floor is the build that introduced the header.**
  `extension_min_version` defaults to `1.10.0` — anything older cannot state a
  version at all and passes as "not the extension", so the default refuses
  exactly the builds that *do* announce themselves and are behind. Editable in
  aisee-manage (**Post → 配置 → 插件 → 版本管理**); raising it when a contract
  changes needs no deploy. An empty value turns the gate off without deleting
  the key.
- **A read failure enforces nothing.** Not the same as "nothing stored": an
  unreadable setting yields *no floor at all*, never the default. A gate that
  cannot read its own configuration must not enforce it — falling back to the
  default there would let a settings outage start refusing clients. Nothing
  behind the gate is protected *by* it, so failing open costs one stale client
  one more poll, while failing closed costs every user their automation.
- **A build too old to understand 426 still fails safely.** It sees an error,
  publishes nothing, and keeps polling until Chrome updates it. The failure
  direction is "nothing happens", never "the wrong thing happens" — which is the
  only reason the floor can be raised without waiting for the fleet.

Only `426` triggers this. A `500` is the server having a bad moment, and pausing
all background work over one would be an outage of our own making.

---

### POST `/api/engage/config/reset`

Reset `enabled` to `false` (re-enter Setup Wizard). Does not delete existing keywords or channels.

**Query Params**

| Parameter | Type | Description |
|---|---|---|
| `projectId` | string | Optional project scope. |

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
  "enabled": true,           // Optional, default true
  "projectId": "product_123" // Optional project scope
}
```

**Response** `200 OK` — Returns the created `EngageKeyword` object

---

### POST `/api/engage/keywords/bulk`

Bulk add keywords (atomic operation). Duplicate keywords are automatically skipped without throwing an error.

**Request Body**

```json
{
  "projectId": "product_123",
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

**Query Params**

| Parameter | Type | Description |
|---|---|---|
| `projectId` | string | Optional project scope. |

**Response** `200 OK` — `MonitoredChannel[]`

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
  "platform": "reddit",        // Required — MUST be 'reddit' (only channel-scope platform)
  "channelId": "SEO",          // Required, subreddit name; normalised to 'seo' on store
  "channelName": "r/SEO",      // Required, display name
  "audienceSize": 1200000,     // Optional
  "metadata": {},              // Optional, any JSON
  "projectId": "product_123"   // Optional project scope
}
```

**Response** `200 OK` — Returns the created `MonitoredChannel`. Note `channelId`
comes back **normalised**, which may differ from what you sent (`r/SEO` → `seo`).

**Error** `400` — one of:
- `platform` is not `reddit` (no other platform has a channel scope)
- `platform` has no scanner at all
- `channelId` is not a valid subreddit name after normalisation
  (`[a-z0-9_]{2,21}` — note `-` is legal in a reddit *username* but not a
  community name)

**Error** `409` — this config already monitors that community.

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

**Response** `200 OK` — Returns the updated `MonitoredChannel`

> `channelId` is immutable — the scan cursor is keyed on it. Delete and re-add to change it.

**Error** `404` — Channel not found

---

### DELETE `/api/engage/monitored-channels/:id`

Delete a monitored channel (historical Feed records are preserved).

**Response** `200 OK` — Returns the deleted `MonitoredChannel`

**Error** `404` — Channel not found

---

## Tracked Accounts — Tracked Accounts

> Tracked accounts are **external third-party X accounts** (not ours), used to monitor their posts and push them into the Feed. They cannot be used to send replies.

### GET `/api/engage/tracked-accounts`

Retrieve all tracked accounts.

**Query Params**

| Parameter | Type | Description |
|---|---|---|
| `projectId` | string | Optional project scope. |

**Response** `200 OK` — `EngageTrackedAccount[]`

---

### POST `/api/engage/tracked-accounts`

Add a tracked account.

**Request Body**

```json
{
  "username": "randfish",       // Required, 1-50 characters; @ / u/ prefixes are stripped
  "platform": "x",             // Optional, default 'x'. Must have an AUTHOR scope
  "categoryLabel": "GEO Expert", // Optional, max 100 characters
  "projectId": "product_123"     // Optional project scope
}
```

**Response** `200 OK` — Returns the created `EngageTrackedAccount`. `username`
comes back **normalised** (`@Alice` → `alice` on case-insensitive platforms;
LinkedIn / Hacker News / Quora keep their casing, their handles are case-sensitive).

**Error** `400` — one of:
- `platform` is `reddit` — reddit has a *channel* scope, so use
  `POST /monitored-channels` instead
- `platform` has no scanner (`youtube`, `qq`, `discord`, …). A platform that has
  a scanner but is not currently in the operator's allowlist is **accepted** —
  that is a config state, not a capability gap
- `username` is not a plain handle after normalisation (guards the `from:<user>`
  search query against injected operators)

**Error** `409` — this config already tracks that account.

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

> Reply accounts are **our connected accounts** (Integration table) that Engage
> may reply AS, scoped to platforms that reply through a connected account (**X**
> today — see `ACCOUNT_REPLY_PLATFORMS`). Completely independent from tracked
> accounts (which are scan *targets*, not senders). For platforms that reply
> through the extension's own browser session (Reddit, …), see `replyPolicies`
> on `POST /config` instead — there is no account to choose there.

### GET `/api/engage/reply-accounts`

Retrieve connected accounts Engage may reply as, and whether each is currently
enabled for this project.

**Query Params**

| Parameter | Type | Description |
|---|---|---|
| `projectId` | string | Optional project scope. Omit for the org-wide view (every binding reads as enabled — see below). |

**Response** `200 OK` — `Integration[]`, flat `engageEnabled` (no nested config object)

```json
[
  {
    "id": "integration-uuid",
    "name": "mycompany_x",
    "providerIdentifier": "x",
    "picture": "https://...",
    "engageEnabled": true
  }
]
```

> `engageEnabled` reflects `IntegrationProject.engageEnabled` for THIS project.
> An account not (yet) bound to the project — or no `projectId` given — reads as
> `true`: opt-OUT, not opt-in. A connected account is usable until explicitly
> excluded.

---

### PATCH `/api/engage/reply-accounts/:integrationId`

Set whether Engage may reply as this account, for one project.

**URL Param**: `integrationId` — The `id` of the Integration (from `GET /reply-accounts`)

**Request Body**

```json
{
  "engageEnabled": true,   // required; the only field this endpoint still owns
  "projectId": "product_123"   // required — see below
}
```

`projectId` is **required** (unlike most engage endpoints, which default to the
legacy null-project config): this writes `IntegrationProject.engageEnabled`, the
join row between the account and a specific project, so there is no
"legacy config" row to fall back to. Per-account auto-reply time windows and
default strategy moved to `POST /config`'s `replyPolicies` (per-platform, not
per-account) — this endpoint no longer accepts them.

**Response** `200 OK` — `{ "integrationId": string, "projectId": string, "engageEnabled": boolean }`

**Error** `404` — Integration not found / not this organization's, or not bound to the given project (bind it first via the project's integration settings).

---

## Opportunities — Signal Feed

### GET `/api/engage/opportunities/score-stats`

Retrieve scoring statistics for the Feed (used for the top dashboard).

**Query Params**

| Parameter | Type | Description |
|---|---|---|
| `projectId` | `string` | Optional project scope |
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

### GET `/api/engage/opportunities/counts/summary`

> `GET /opportunities/counts` remains a compatibility alias for this endpoint. Use the canonical `/counts/summary` path for new clients. To narrow by `platform` or `status`, use [`GET /opportunities/count`](#get-apiengageopportunitiescount).

Total + byStatus + byPlatform counts for `/opportunities` in one round trip, **all computed under the SAME conditions**: the `/opportunities` filter contract minus `platform`/`status` (those two are the breakdown axes here, not filters — to narrow by them use `GET /opportunities/count`) and minus `sortBy`/`sortOrder`/`page`/`limit` (a counts response has no rows to sort or paginate). Use this instead of firing several `GET /opportunities?platform=x&limit=1` calls just to read `.total` for tab/platform badges — that N+1 pattern used to run a full `findMany` + `count` per call.

**Query Params** (all optional — same scoping filters as `/opportunities`, minus `platform`/`status`/`sortBy`/`sortOrder`/`page`/`limit`)

| Parameter | Type | Description |
|---|---|---|
| `projectId` | `string` | Optional project scope |
| `keyword` | `string` | Same as `/opportunities` |
| `keywords` | `string[]` | Same as `/opportunities` |
| `intent` | `IntentType \| IntentType[]` | Same as `/opportunities` |
| `date` | `'today' \| 'week'` | Same as `/opportunities` |
| `startDate` / `endDate` | `string` (ISO datetime) | Same as `/opportunities` |
| `minScore` / `minScoreKeyword` / `minScoreHeat` / `minScoreAuthority` | `number` | Same as `/opportunities` |
| `channels` | `string \| string[]` | Same as `/opportunities` |
| `authors` | `string \| string[]` | Same as `/opportunities` |
| `bookmarked` | `boolean` | Same as `/opportunities` |

**Response** `200 OK`

```json
{
  "total": 142,
  "byStatus": {
    "NEW": 98,
    "DISMISSED": 12,
    "REPLIED": 20,
    "SCHEDULED": 4,
    "AUTO_QUEUED": 6,
    "EXPIRED": 2
  },
  "byPlatform": { "x": 90, "reddit": 52 }
}
```

> `byStatus` always has all six `EngageOpportunityStatus` keys present (0 when empty), so the UI can render fixed tab badges without existence checks. `byPlatform` always has all broken-out platform keys (`x`/`reddit`/`linkedin`/`medium`/`devto`/`hackernews`/`quora`), 0 when empty.

---

### GET `/api/engage/opportunities/count`

Filtered counts under **exactly** the same filters as `GET /opportunities`, sharing the list's where-clause builder server-side so the two can never drift:

- `total` honors every filter — `status` and `platform` included — and is the same number the list returns for that query string.
- `byStatus` honors every filter **except `status` itself** (status is the breakdown axis; applying it would zero the very badges the breakdown exists for), so per-status badges stay complete while `platform`/`keywords`/date-window/etc. all narrow them.

`sortBy`/`sortOrder`/`page`/`limit` are accepted and ignored (they can't change a count), so clients can reuse the list query string verbatim.

**Query Params** — identical to [`GET /opportunities`](#get-apiengageopportunities).

**Response** `200 OK`

```json
{
  "total": 37,
  "byStatus": {
    "NEW": 30,
    "DISMISSED": 4,
    "REPLIED": 7,
    "SCHEDULED": 1,
    "AUTO_QUEUED": 0,
    "EXPIRED": 2
  }
}
```

> `byStatus` always has all six `EngageOpportunityStatus` keys present (0 when empty). With `?status=NEW&platform=x`, `total` counts only NEW x-posts while `byStatus` breaks down ALL statuses among x-posts.

---

### GET `/api/engage/opportunities`

Retrieve the list of opportunities (main Signal Feed endpoint).

**Query Params**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `projectId` | `string` | — | Optional project scope |
| `platform` | `string \| string[]` | — | Platform filter. Multi-value (OR): `?platform=x&platform=reddit` or `?platform=x,reddit`. Max 20. |
| `status` | `EngageOpportunityStatus \| EngageOpportunityStatus[]` | — | Status filter. Multi-value (OR): repeated params or comma-separated. Max 20. |
| `intent` | `IntentType \| IntentType[]` | — | Intent filter. Multi-value (OR): repeated params or comma-separated. Max 20. |
| `keyword` | `string` | — | Restrict to opportunities that matched this exact keyword (text as configured; per-org via `matchedKeywords`) |
| `keywords` | `string[]` | — | Multi-keyword variant of `keyword`: keep opportunities that matched **any** of these exact keywords (OR). Same per-org scope (`matchedKeywords`). Accepts repeated params `?keywords=react&keywords=nextjs` **or** comma-separated `?keywords=react,nextjs`. Combinable with `keyword` (the two sets are unioned). Max 50. |
| `date` | `'today' \| 'week'` | — | Calendar-preset lower bound on `postPublishedAt` (UTC day/isoWeek start) |
| `startDate` | `string` (ISO datetime) | — | Exact lower bound on `postPublishedAt`, no rounding. Takes priority over `date` when both are given — use for rolling windows (e.g. "last 24h") that need hour precision. |
| `endDate` | `string` (ISO datetime) | — | Exact upper bound on `postPublishedAt`, no rounding. Combines with `date`/`startDate` to form a window. |
| `minScore` | `number` | — | Minimum total score |
| `minScoreKeyword` | `number` | — | Minimum keyword score |
| `minScoreHeat` | `number` | — | Minimum heat score |
| `minScoreAuthority` | `number` | — | Minimum authority score |
| `channels` | `string \| string[]` | — | Channel id filter. Multi-value (OR): `?channels=SEO&channels=TECH` or `?channels=SEO,TECH`. Omit for no filter. Max 50. |
| `authors` | `string \| string[]` | — | Author username filter (case-insensitive). Multi-value (OR): repeated params or comma-separated. Omit for no filter. Max 50. |
| `bookmarked` | `boolean` | — | Only show bookmarked |
| `sortBy` | `string` | `'score'` | Sort field: `score` / `scoreKeyword` / `scoreHeat` / `scoreAuthority` / `scoreRecency` / `scoreTracked` / `postPublishedAt` |
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

# Project-scoped feed
GET /api/engage/opportunities?projectId=product_123&status=NEW

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

Total score max is **105, not 100** — this is intended, not an overflow. The four base dimensions (scoreKeyword 35 + scoreHeat 45 + scoreAuthority 15 + scoreRecency 5) add up to 100, and `scoreTracked` is a **+5 bonus stacked on top of that full 100**, so a post that maxes out every dimension lands on 105. Only posts scoring ≥60 are stored.

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
| `scoreAuthority` | 15 | 账号影响力 — X: author follower count; Reddit: subreddit audience size (channelFollowers) |
| `scoreRecency` | 5 | 时效性 — freshness: 5 if within 24h, else 0 |
| `scoreTracked` | 5 | 重点账户/频道 — 5 if X tracked account OR Reddit monitored subreddit, else 0 |
| `score` | 105 | 总分 — sum of all dimensions; 100 base + `scoreTracked` bonus, so >100 is expected |

---

### GET `/api/engage/opportunities/:id`

Retrieve one opportunity by `id`.

The response is the same shape as one object from `GET /api/engage/opportunities`
`items[]`, including `sentReplyId`, `replyLink`, and `channelAvatar`.

**Path Params**

| Parameter | Type | Description |
|---|---|---|
| `id` | `string` | `item.id` from `/opportunities` response (`EngageOpportunity.id`) |

**Query Params**

| Parameter | Type | Description |
|---|---|---|
| `projectId` | `string` | Optional project scope. Required to disambiguate a project-owned opportunity state from the legacy null-project state. |

**Response** `200 OK`

```json
{
  "id": "opp-uuid",
  "platform": "x",
  "externalPostId": "post-id",
  "externalPostUrl": "https://x.com/user/status/post-id",
  "status": "NEW",
  "bookmarked": false,
  "score": 85,
  "scoreKeyword": 35,
  "scoreHeat": 30,
  "scoreAuthority": 10,
  "scoreRecency": 5,
  "scoreTracked": 5,
  "matchedKeywords": ["GEO SEO"],
  "sentReplyId": null,
  "replyLink": null,
  "channelAvatar": null
}
```

Returns `404` when the opportunity does not exist for the current organization.

---

### GET `/api/engage/opportunities/locate`

Locate which page a given opportunity lives on within `/opportunities`, using **the same filters and sort**. Use this to jump directly to the right page when linking to or reopening a specific opportunity.

**Query Params**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `opportunityId` | `string` | **required** | `item.id` from `/opportunities` response (`EngageOpportunity.id`) |
| `projectId` | `string` | — | Optional project scope. Must match the active `/opportunities` filter. |
| `limit` | `number` | `20` | Page size — must match the `limit` you pass to `/opportunities`, max 100 |
| All `/opportunities` filter params | — | — | `platform`, `status`, `intent`, `keyword`, `keywords`, `date`, `startDate`, `endDate`, `minScore`, `minScoreKeyword`, `minScoreHeat`, `minScoreAuthority`, `channels`, `authors`, `bookmarked`, `sortBy`, `sortOrder` — must match the active list filters exactly |

**Response** `200 OK`

```json
// Found — opportunity is visible under the current filters
{
  "found": true,
  "page": 3,
  "position": 41,
  "total": 150,
  "limit": 20,
  "totalPages": 8
}

// Not found — opportunity does not exist or is excluded by the filters
{
  "found": false,
  "page": null,
  "position": null,
  "total": 150,
  "limit": 20,
  "totalPages": 8
}
```

**Usage pattern** — navigate to a specific opportunity:

```js
const { found, page } = await fetch(
  `/api/engage/opportunities/locate?opportunityId=${id}&sortBy=score&limit=20`
).then(r => r.json());

if (found) {
  // load /opportunities?sortBy=score&limit=20&page=${page} and scroll to id
}
```

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
  "strategy": "EXPERT_ANSWER",  // Required: ReplyStrategy (see type def above)
  "brandStrength": 1,           // Required: 0-3 integer
  "mentions": ["AISEE"],        // Optional: brand names to weave in (max 20)
  "outputLength": 1000,         // Optional: target reply length (chars); omit to use platform default
  "projectId": "product_123"    // Optional project scope
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `strategy` | `ReplyStrategy` | ✓ | One of the 7 strategy keys (see Strategy Descriptions) |
| `brandStrength` | `number` (0–3) | ✓ | Brand emphasis level (see table below) |
| `mentions` | `string[]` (max 20) | | Brand names the model may mention (used when `brandStrength` ≥ 2) |
| `outputLength` | `integer` (≥ 2) | | Target reply length fed into the prompt. Omitted → platform default (X = 260 weighted chars, Reddit = 1000 chars) |
| `projectId` | `string` | | Optional project scope |

**Output length & character limits**

`outputLength` is the **target** the model is instructed to aim for — it is not the hard rejection threshold:

| Platform | Default target | Hard cap (draft rejected above this) |
|---|---|---|
| X / Twitter | 260 Twitter-weighted chars | `max(outputLength, 280)` — i.e. X's exact 280-weighted max (one automatic retry if the first draft overshoots) |
| Reddit | 1000 chars | `max(outputLength, 2000)` — drafts of 1000–2000 chars are accepted; only above 2000 fails |

> Reddit's real limit is ~10000 chars, so a 2000-char reply always posts fine. Keeping the target at 1000 favors concise, natural replies while tolerating a slight overshoot instead of failing the whole generation. A Reddit draft over the hard cap fails with `generation_failed` and is **not** retried (unlike X).

**Strategy Descriptions**

| strategy | Use Case | Generation Style |
|---|---|---|
| `EXPERT_ANSWER` | Help-seeking, Discussion | Expert step-by-step advice |
| `DATA_BACKED` | Any type | Conversational reply optionally supported by an observation or metric from the original post |
| `EMPATHY_LED` | Help-seeking, Ranting | Empathize first, then provide insights |
| `CONTRARIAN` | Opinion, Discussion | Counter the post's specific claim with reasoning |
| `QUESTION_LED` | Discussion, Data-share | Ask one genuine, open question from a specific detail |
| `QUICK_TAKE` | Rant, Opinion | One sharp single-sentence quip that flips a detail |
| `AMPLIFY` | Opinion, Data-share | Agree, then add the one underrated angle |

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

### POST `/api/engage/opportunities/:id/save-draft`

Save (upsert) an **unpublished working draft** reply for an opportunity — **one DRAFT per opportunity**. The content may be AI-generated, AI-then-edited, or **fully hand-typed**: the save is decoupled from generation (the SSE `/draft` endpoint above does *not* persist anything, and a manually-typed reply never calls it).

Stored as a `Post(state=DRAFT, source=engage)` + `EngageSentReply`, so it surfaces in `GET /sent?status=awaiting`. `DRAFT` is the whole meaning of "a person saved this and has not sent it": automated replies are written as `QUEUE` instead, and **no automated path may claim a `DRAFT`**. This endpoint accepts no `state` for that reason — a client able to ask for `QUEUE` could put text in front of a real audience with no human step. It is deliberately **lightweight** — unlike send/schedule/manual it does **NOT**:
- claim the opportunity (it stays actionable in the signal feed),
- charge reply credits (generation already did, if used),
- create a real post or sync metrics.

When the opportunity is later sent / scheduled / manually replied, every **un-held unsent** reply for it is **automatically deleted** — the saved `DRAFT` and any automated reply still sitting in `QUEUE` that no browser is currently holding. A reply under an *active claim* is left alone: the extension already has its text and is posting it, so deleting the row cannot call it back — it would only destroy the record of a reply that goes live anyway. The queued half matters: a reply queued *before* the user replied by hand is already past the driver's own exclusion and would otherwise go out too, posting the same opportunity twice. Published rows are history and are never touched.

**Request Body**

| Field | Type | Required | Description |
|---|---|---|---|
| `draftContent` | `string` (max 4000) | ✓ | The reply text to save |
| `strategy` | `ReplyStrategy` | ✓ | Generation strategy (stored in `inputData`) |
| `brandStrength` | `number` 0–3 | ✓ | Brand strength (stored in `inputData`) |
| `mentions` | `string[]` (≤20) | — | Optional brand mentions (stored in `inputData`) |
| `projectId` | `string` | — | Optional project scope |

**Response** `200 OK` — Returns the upserted `EngageSentReply` (with its `Post`, `state=DRAFT`).

**Errors**: `404` opportunity not found · `403` opportunity no longer actionable (expired / replied / scheduled / dismissed).

---

## Reference-Post Generation — Original Post Inspired By An Opportunity

Generates AND saves a normal calendar **Post** inspired by an opportunity's content — **not** a reply. See `docs/engage/reference-post-generation.md` for the full design (data model, billing, anti-plagiarism gate). Unlike every endpoint above, this one does **not** require the opportunity to be in an actionable status — an opportunity you already replied to, or that expired, is still valid inspiration — and it never claims the opportunity or creates an `EngageSentReply`.

**Rate Limit**: Max 20 calls per user per hour (same as `/draft`).

### POST `/api/engage/opportunities/:id/generate-post`

Stream an AI-generated **original** post via SSE (`text/event-stream`) and persist it as an account-less **DRAFT** `Post` in one call — there is no separate save step (see the design-revision note at the top of `docs/engage/reference-post-generation.md` for why: unlike `/save-draft`, this feature has no "fully hand-typed, AI never involved" case to decouple generation from). No `integrationId`/platform field in the request — the target platform is always the reference opportunity's own platform (`opportunity.platform`), never a client choice. Creative controls mirror `GenerateDraftDto` (`/draft`'s own body), not a bespoke shape — see `docs/engage/reference-post-generation.md` §6 for why the prompt *text* per strategy is still its own reworded set even though the field names match.

Stored as a normal `Post` with `source='calendar'` (behaves exactly like any other calendar post — publish queue, dashboard analytics, billing), `state='DRAFT'`, no bound `integrationId` (`providerIdentifier` set to the opportunity's platform instead), `referenceOpportunityId` set to the opportunity id, plus a content snapshot merged into `settings.referenceOpportunity` (the opportunity itself can be deleted or its content can drift later; the snapshot is what survives). **No** `EngageSentReply` is created and the opportunity is **not** claimed. Picking which account to publish through, further edits, and scheduling/publishing all happen afterward through the **generic** `POST /api/posts/` edit flow (re-post with the same `group`) — exactly like any other draft already in the calendar.

**Request Body**

| Field | Type | Required | Description |
|---|---|---|---|
| `strategy` | `string` (one of `VALID_STRATEGIES` — `EXPERT_ANSWER`, `DATA_BACKED`, `EMPATHY_LED`, `CONTRARIAN`, `QUESTION_LED`, `QUICK_TAKE`, `AMPLIFY`) | ✓ | Same 7 keys as `/draft` |
| `brandStrength` | `number` (0–3) | ✓ | Same brand-mention control as `/draft`, same shared implementation |
| `mentions` | `string[]` (≤20) | — | Optional brand names, used when `brandStrength` ≥ 2 |
| `outputLength` | `integer` (≥ 2) | — | Target length; soft target only, same semantics as reply drafts |
| `projectId` | `string` | — | Optional project scope |
| `sourceAdaptation` | `PRESERVE_STRUCTURE` \| `REFRAME` \| `FRESH_ANGLE` | — | How closely the post may follow the reference. Default `REFRAME`. Orthogonal to `strategy` (which picks the voice) — see the table below |
| `includeReferenceMedia` | `boolean` | — | Opt-in (default `false`): re-host the reference's own images/video onto the generated post. Unlike the text, media is reused as-is — see `reference-post-generation.md` §6.1 |
| `thread` | `boolean` | — | Opt-in (default `false`): produce a native **thread** (anchor + follow-up posts stored as a `parentPostId` chain in one `group`) instead of a single post. Honoured only where the platform can chain one — see the table below |
| `maxThreadParts` | `integer` (1–5) | — | How many posts the chain has **IN TOTAL, the anchor INCLUDED** — `3` is the anchor plus 2 follow-ups, `1` is a single post. Default 3. Read only when `thread` is `true`. **Despite the name it is an EXACT count of POSTS**, neither a maximum nor a count of follow-ups; the generator is instructed to write exactly this many and retried once if it writes fewer. A chain can still come back short — see `requestedParts` below. ⚠️ **This changed meaning.** It used to be a ceiling over follow-ups (chain = `1 + this`, model free to undershoot), so the same value now yields one post fewer: `5` was "up to 6 posts", it is now exactly 5. The name and the 1–5 range were kept so nothing starts rejecting, which means the output length changes silently for existing callers — see `reference-post-generation.md` §6.2 |

**Source adaptation** — the relationship between the generated post and the
reference. **No mode relaxes the anti-plagiarism gate**: all three sit under
the same do-not-copy instruction and the same output-side similarity check, so
none of them will hand back the reference's own wording.

| Value | What carries over | What is always rewritten |
|---|---|---|
| `PRESERVE_STRUCTURE` | The reference's information order and overall shape (hook → detail → takeaway, list, story arc) | Every sentence. Same skeleton, none of its phrasing — this mode trips the similarity gate more often than the others, by design |
| `REFRAME` (default) | The core point only | Opening, order of ideas, structure, wording |
| `FRESH_ANGLE` | The topic and what makes it resonate | Everything else — a different aspect/audience/question, no mirroring of the reference's argument or structure |

Named for what each mode preserves rather than a Close/Balanced/Fresh scale on
purpose: "close" reads as a promise to imitate the source, which is exactly
what this endpoint does not do.

**Thread support per platform** — resolved by the one shared rule
(`integrations/thread-capability.ts`), which accepts a platform when EITHER
publish path can chain it: the provider's own `comment()` (server/API path) or
the browser extension's in-browser segment chaining.

| Platform | Thread | Why |
|---|---|---|
| `x` | ✅ | reply-chain, both paths |
| `reddit` | ✅ | self-post + follow-up comments, both paths |
| `linkedin` | ✅ | comment chain, both paths |
| `hackernews` | ✅ | extension only — HN has no write API at all, so every HN post goes out in-browser, where follow-up comments chain fine |
| `medium` | ❌ | long-form article; a thread has no meaning there (`SINGLE_SEGMENT_PLATFORMS`) |
| `quora` | ❌ | same |
| `devto` | ❌ | same |

A `thread: true` request on one of the ❌ platforms is **not** a 400 — the
client never chose the platform (it is always the opportunity's), so the call
degrades to a single post and reports it in the response.

**SSE Response Format** — `data: {"text": "...", "postId": "...", "parts": ["..."], "thread": false}` then `data: [DONE]`.

| Field | Description |
|---|---|
| `text` | The whole post — thread parts joined by a blank line. Equals `parts[0]` for a single post |
| `postId` | The **root** `Post` id. Follow-up parts are its `parentPostId` chain, in the same `group`, and move/schedule/publish with it |
| `parts` | One entry per post in the chain, in publish order. Single-element array unless a thread was produced |
| `thread` | Whether a thread was actually produced (`parts.length > 1`) |
| `threadSkippedReason` | Only present when a thread of **more than one post** was requested but one post came back: `platform_unsupported` (the platform cannot chain — see the table above) or `single_post_generated` (the model judged one post enough). Absent for `maxThreadParts: 1`, which asks for a single post outright — nothing was skipped |
| `requestedParts` | Only present when `parts` came back **shorter than the `maxThreadParts` asked for**. A total post count, directly comparable to `parts.length`. Two causes: the model still wrote fewer posts after its corrective retry, or a too-long tail part was dropped for length (`droppedParts` is then also present). The short chain is still delivered and still billed — this field is what lets a client say it is short |
| `droppedParts` | Only present when trailing thread parts were discarded for overrunning the platform character ceiling. `parts`/`postId` already describe the truncated chain |

**On error**, one typed frame then `[DONE]`:

| error code | Meaning |
|---|---|
| `opportunity_unavailable` | Opportunity not found (404) |
| `too_similar_to_reference` | The draft reused too much of the reference post's own wording, even after one corrective retry — nothing usable was produced |
| `generation_failed` | Model call failed, or (rare) the generation succeeded but persisting the post failed — the generated text is not re-delivered in that case |

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
  "brandStrength": 1,                   // Required, 0-3
  "projectId": "product_123"            // Optional project scope
}
```

**Response** `200 OK` — Returns `EngageSentReply`

**Errors**
- `400` — Existing scheduled post is no longer pending (already published or failed)
- `403` — **Pacing gate (§6/§6.1)** — blocked BEFORE the send; the opportunity claim is rolled back. The JSON `code` distinguishes the cause (see [Reply pacing 403s](#reply-pacing-403s)):
  - `engage_daily_hard_cap_reached` — the project's active-plan daily reply ceiling for this platform (the tighter of `targetRepliesPerDay` and an optional `dailyHardCap`) would be exceeded.
  - `engage_daily_keyword_target_reached` — a per-keyword daily target (`keywordTargets[keyword]`) for one of the opportunity's matched keywords would be exceeded.
  - `engage_account_daily_cap_reached` — the sending account's per-account daily cap (`engage_reply_account_daily_cap` Setting, default 50) would be exceeded.
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
  "scheduledAt": "2026-05-23T10:00:00.000Z",
  "projectId": "product_123"
}
```

**Response** `200 OK` — Returns `EngageSentReply`

**Errors**
- `400` — `scheduledAt` is not in the future
- `403` — Reply pacing gate — same three `code`s as [`/send-now`](#reply-pacing-403s); the day counted is the reply's **scheduled publish day**, so scheduling for a future day checks that day's target, not today's.
- `404` — Opportunity doesn't exist or already replied

---

### POST `/api/engage/opportunities/:id/batch-schedule`

**Batch Schedule Reply** — Schedule replies from multiple integrations at different times in a single request.

> Internally: Single atomic claim → Creates one Post per item (each at its own `scheduledAt`) → Creates one `EngageSentReply` per item. All posts are rolled back if any Post creation fails. SentReply creation is best-effort (logged on failure, does not abort remaining items).

**Request Body**

```json
{
  "projectId": "product_123",
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
| `projectId` | `string` | — | Optional project scope for the whole batch |
| `items` | `array` | ✓ | 1–20 items |
| `items[].integrationId` | `string` | ✓ | Integration ID (from GET /reply-accounts) |
| `items[].draftContent` | `string` | ✓ | Reply content, max 4000 chars |
| `items[].strategy` | `ReplyStrategy` | ✓ | One of the 7 strategy keys (see Strategy Descriptions) |
| `items[].brandStrength` | `number` | ✓ | 0–3 |
| `items[].scheduledAt` | `string` | ✓ | ISO date string, must be in the future |

**Response** `200 OK` — Returns `EngageSentReply[]` (one entry per item)

**Errors**
- `400` — Any `scheduledAt` is not in the future, or array is empty / exceeds 20 items
- `403` — Reply pacing gate — same three `code`s as [`/send-now`](#reply-pacing-403s). The **whole batch** is checked before any post is created (every distinct item counts toward the caps), and all rolled back on a block.
- `404` — Opportunity doesn't exist or already replied

---

### POST `/api/engage/opportunities/:id/batch-send`

**Batch Send Reply** — Send replies from multiple integrations immediately in a single request.

> Internally: Single atomic claim → Calls X API sequentially per item → Creates one `EngageSentReply` + triggers metrics sync per item. Phase 1 (post creation) rolls back fully on failure; Phase 2 (record creation) is best-effort — individual failures are logged and skipped. Returns `500` only if **all** record creations fail.

**Request Body**

```json
{
  "projectId": "product_123",
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
| `projectId` | `string` | — | Optional project scope for the whole batch |
| `items` | `array` | ✓ | 1–20 items |
| `items[].integrationId` | `string` | ✓ | Integration ID (from GET /reply-accounts) |
| `items[].draftContent` | `string` | ✓ | Reply content, max 4000 chars |
| `items[].strategy` | `ReplyStrategy` | ✓ | One of the 7 strategy keys (see Strategy Descriptions) |
| `items[].brandStrength` | `number` | ✓ | 0–3 |

**Response** `200 OK` — Returns `EngageSentReply[]`. May be shorter than `items` if individual SentReply recording fails (individual failures are logged). Returns `500` only if all recording fails.

**Errors**
- `403` — Reply pacing gate — same three `code`s as [`/send-now`](#reply-pacing-403s). The **whole batch** is checked before any send; a block rolls back every post and releases the claim.
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
  "brandStrength": 1,                     // Required, 0-3
  "projectId": "product_123"              // Optional project scope
}
```

**Response** `200 OK` — Returns `EngageSentReply`

> After calling this endpoint, the record enters the Sent list with status "⚠ No reply URL submitted" until the URL is provided.

> **Not** subject to the reply pacing gate: the reply was already posted manually outside Postiz before this call, so blocking the confirmation would only lose the tracking record, not un-send anything. The confirmed reply still counts toward future pacing checks (it writes a normal `EngageSentReply` with `projectId` + `matchedKeywords`).

---

### Reply pacing 403s

The send/schedule/batch endpoints above run a **send-time pacing gate (§6/§6.1)** just before the platform publish. A block throws `403` with a JSON `code` and is fully rolled back (claim released, any created posts deleted). It is independent of the monthly reply-**generation** credit cap (`EngageEntitlementService`, enforced at draft time).

| `code` | Meaning | Source of the limit |
|---|---|---|
| `engage_daily_hard_cap_reached` | Project's daily reply ceiling for the platform would be exceeded. Response carries `hardCap`, `sentToday`, `requested`. | The tighter of the active `OperationPlan`'s `planPayload.engagePolicies[].targetRepliesPerDay` and an optional `dailyHardCap`/`hardCapRepliesPerDay`. No active plan / no matching enabled policy → no cap. |
| `engage_daily_keyword_target_reached` | A per-keyword daily target for one of the opportunity's matched keywords would be exceeded. Response carries `keyword`, `target`, `sentToday`, `requested`. | `planPayload.engagePolicies[].keywordTargets[keyword]` (`Record<keywordId, number>`). Only keywords the opportunity actually matched are checked. |
| `engage_account_daily_cap_reached` | The sending account's per-account daily cap would be exceeded. Response carries `cap`, `sentToday`, `requested`. Checked for every distinct account in a batch. | `engage_reply_account_daily_cap` Setting (default `50`; `0`/unset = uncapped), seeded on boot. |

"Today" is a UTC day, counted by the reply's **publish day** (`Post.publishDate`, states `QUEUE`+`PUBLISHED`) — so a reply scheduled for a future day counts toward that day, keeping the check consistent with how each request is grouped by its scheduled time.

---

## Browser-Extension Replies — Standalone In-Browser Replies

Reply history logged by the Postiz browser extension (in-browser **Option A**): the extension replies to an arbitrary Reddit/X URL through the user's own browser session and reports the result back here. These records are standalone — **not** tied to an `EngageOpportunity` or a `Post` (see [`EngageExtensionReply`](#engageextensionreply)).

---

### POST `/api/engage/extension-replies`

Record a reply posted via the browser extension.

**Request Body**

| Field | Type | Required | Description |
|---|---|---|---|
| `platform` | `'reddit' \| 'x'` | ✓ | Platform the reply was posted on |
| `targetUrl` | `string` (max 2000) | ✓ | URL of the post/tweet that was replied to |
| `content` | `string` (max 10000) | ✓ | The reply text |
| `permalink` | `string` (max 2000) | — | URL of the posted reply (Reddit comment / X status) |
| `postId` | `string` (max 200) | — | Reddit fullname (`t1_`/`t3_`) or X tweet `rest_id` |
| `status` | `'sent' \| 'pending' \| 'failed'` | — | Defaults to `sent` |

**Response** `200 OK` — Returns the created `EngageExtensionReply`.

---

### GET `/api/engage/extension-replies`

Paginated list of browser-extension replies, newest first.

**Query Params**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `platform` | `'reddit' \| 'x'` | — | Optional platform filter |
| `page` | `number` | `1` | Page number |
| `limit` | `number` | `20` | Items per page, max 100 |

**Response** `200 OK`

```json
{
  "items": [ /* EngageExtensionReply[], newest first */ ],
  "total": 12,
  "page": 1,
  "limit": 20
}
```

---

### DELETE `/api/engage/extension-replies`

Clear browser-extension reply history. Deletes all rows, or only those older than the given window.

**Query Params**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `olderThan` | `'all' \| '1d' \| '1w' \| '1m'` | ✓ | `all` clears everything; `1d`/`1w`/`1m` clear rows older than 1 day / week / month |

**Response** `200 OK`

```json
{ "deleted": 7 }
```

---

## Sent Replies — Sent Records

### GET `/api/engage/sent`

Retrieve the list of sent replies (includes original post summary and metrics data).

**Query Params**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `projectId` | `string` | — | Optional project scope |
| `platform` | `string` | — | Platform filter |
| `status` | `'published' \| 'scheduled' \| 'manual' \| 'error' \| 'draft' \| 'settled' \| 'awaiting' \| 'awaiting-draft' \| 'awaiting-expired' \| 'awaiting-link'` | — | Status filter (see table below). `settled` and `awaiting` are combined rollups; `awaiting-draft` / `awaiting-expired` / `awaiting-link` are sub-filters of `awaiting` that back the Awaiting-review tabs (Drafts / Expired / Awaiting link). |
| `date` | `all \| day \| today \| week \| month` | `all` | Publish-date window (`day`/`today` aliased) |
| `page` | `number` | `1` | Page number |
| `limit` | `number` | `20` | Items per page, max 100 |

**Status filter meanings** — the four granular states plus two combined rollups that partition them into "no action needed" vs "needs action", plus three sub-filters of `awaiting`:

| status | Post condition |
|---|---|
| `published` | `state=PUBLISHED` && `releaseURL != null` (published & live) |
| `scheduled` | `state=QUEUE` — queued for a future auto-publish. **Includes unattended replies** the driver generated and is waiting for a browser to drain (see [reply-due](#post-apiengagereply-due)); they are not drafts and never appear under `awaiting`. |
| `manual` | `state=PUBLISHED` && `releaseURL=null` (posted/copied, link not yet backfilled) |
| `error` | `state=ERROR` (publishing failed; the generated draft is preserved) |
| `draft` | `state=DRAFT` — a saved working copy a PERSON has not sent (see `POST /opportunities/:id/save-draft`). Unattended replies are never DRAFT; nothing automated may claim one. |
| `settled` | `published` **OR** `scheduled` — no further action needed (live, or will auto-fire) |
| `awaiting` | `draft` **OR** `manual` **OR** `error` — has content but not yet live |
| `awaiting-draft` | `draft` **AND** this org's `EngageOpportunityState.status != EXPIRED` — the "Drafts" tab: still-actionable saved drafts |
| `awaiting-expired` | `draft` **AND** this org's `EngageOpportunityState.status == EXPIRED` — the "Expired" tab: the draft's source post aged out of the actionable feed (read-only) |
| `awaiting-link` | `manual` **OR** `error` — the "Awaiting link" tab: needs the user to submit a reply link or retry a failed publish |

> **DRAFT working-copies:** a saved draft is a `Post(state=DRAFT)` (see `POST /opportunities/:id/save-draft`). Omitting `status` returns **all** states including `DRAFT`. Use `status=awaiting` to target the whole "needs action" bucket (`DRAFT` + `manual` + `error`), or one of `awaiting-draft` / `awaiting-expired` / `awaiting-link` to target a single Awaiting-review tab directly (no client-side triage of `post.state` needed). `EXPIRED` is a **per-org** status living on `EngageOpportunityState`, not a `Post` field — the same shared opportunity can be `EXPIRED` for one org's draft and still active for another's.

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

> `inputData` contains the generation metadata saved at reply time. Use it to pre-populate the edit form for scheduled replies. Fields: `strategy` (`ReplyStrategy`), `brandStrength` (0–3), `mentions` (optional string array).

**`post.state` Meanings**

| state | Meaning |
|---|---|
| `PUBLISHED` | Published |
| `QUEUE` | Scheduled |
| `ERROR` | Failed to send |

**Special Handling for Reddit Manual Replies**: When `post.releaseURL` is `null`, it means the user has not yet submitted the Reddit comment URL; they should be prompted to provide it.

---

### GET `/api/engage/sent/:id`

Retrieve one sent reply by `id`.

The response is the same shape as one object from `GET /api/engage/sent`
`items[]`, including decorated `opportunity.status`, `opportunity.matchedKeywords`,
`opportunity.generationHistory`, `post.replyAuthor`, and `post.metrics`.

**Path Params**

| Parameter | Type | Description |
|---|---|---|
| `id` | `string` | `item.id` from `/sent` response (`EngageSentReply.id`) |

**Response** `200 OK`

```json
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
    "replyAuthor": {
      "handle": "user",
      "id": "123",
      "name": "User",
      "avatarUrl": "https://..."
    },
    "metrics": {
      "likes": 42,
      "replies": 3,
      "retweets": 8,
      "quotes": 0,
      "bookmarks": 0,
      "views": 1240,
      "score": 0,
      "comments": 0,
      "shares": 0,
      "saves": 0,
      "upvoteRatio": null
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
    "status": "REPLIED",
    "matchedKeywords": ["SEO", "AI"],
    "generationHistory": []
  }
}
```

Returns `404` when the sent reply does not exist for the current organization.

---

### GET `/api/engage/sent/locate`

Locate which page a given sent reply lives on within `/sent`, using **the same filters**. Use this to jump directly to the right page when navigating back to a specific reply.

**Query Params**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `sentReplyId` | `string` | **required** | `item.id` from `/sent` response (`EngageSentReply.id`) |
| `projectId` | `string` | — | Optional project scope. Must match the active `/sent` filter. |
| `limit` | `number` | `20` | Page size — must match the `limit` you pass to `/sent`, max 100 |
| `platform` | `string` | — | Must match the active filter |
| `status` | `'published' \| 'scheduled' \| 'manual' \| 'error' \| 'draft' \| 'settled' \| 'awaiting' \| 'awaiting-draft' \| 'awaiting-expired' \| 'awaiting-link'` | — | Must match the active filter |
| `date` | `string` | — | Must match the active filter |

**Response** `200 OK`

```json
// Found
{
  "found": true,
  "page": 2,
  "position": 23,
  "total": 58,
  "limit": 20,
  "totalPages": 3
}

// Not found — reply does not exist or is excluded by the filters
{
  "found": false,
  "page": null,
  "position": null,
  "total": 58,
  "limit": 20,
  "totalPages": 3
}
```

---

### GET `/api/engage/sent/stats`

Retrieve summary statistics for sent records (used for the top of the Sent page). **Scoped by the same `date` / `platform` / `status` filters as `GET /sent`** so the stat cards always match the filtered list below them.

**Query Params** (all optional — identical to `/sent`, pagination ignored)

| Param | Type | Description |
|---|---|---|
| `projectId` | `string` | Optional project scope. |
| `date` | `all` \| `day` \| `today` \| `week` \| `month` | Publish-date window. `all` / omitted / unknown = all-time. `day` and `today` are aliases. Same vocabulary as `/dashboard/summary`. |
| `platform` | `x` \| `reddit` | Restrict to one platform (via the linked opportunity). |
| `status` | `published` \| `scheduled` \| `manual` \| `error` \| `draft` \| `settled` \| `awaiting` \| `awaiting-draft` \| `awaiting-expired` \| `awaiting-link` | Restrict to a reply lifecycle state. Same values as `/sent` (incl. the `settled` / `awaiting` rollups and the three `awaiting-*` sub-filters). |

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

### GET `/api/engage/sent/counts/summary`

> Replaces the removed `GET /sent/counts`, which was split into this rollup and [`GET /sent/count`](#get-apiengagesentcount) (filtered counts under exactly the `/sent` filters). Differences from the old endpoint: `status` is no longer a param (it skewed `total`/`byPlatform` while `rollups` ignored it), and `awaitingBreakdown` is now always present instead of appearing only when `status=awaiting`.

Total + byPlatform + settled/awaiting rollups + awaitingBreakdown for `/sent` in one round trip, **all computed under the SAME conditions**: the `/sent` filter contract minus `status`/`platform` (those two are the breakdown axes here, not filters — to narrow by them use `GET /sent/count`). Replaces several `GET /sent?status=…&limit=1` calls just to read `.total` for platform/tab badges.

**Query Params** (all optional)

| Param | Type | Description |
|---|---|---|
| `projectId` | `string` | Optional project scope. |
| `date` | `all` \| `day` \| `today` \| `week` \| `month` | Same vocabulary as `/sent`/`/sent/stats`. Scopes every field. |

**Response** `200 OK`

```json
{
  "total": 340,
  "byPlatform": { "x": 210, "reddit": 130 },
  "rollups": { "settled": 280, "awaiting": 60 },
  "awaitingBreakdown": { "drafts": 25, "link": 30, "expired": 5 }
}
```

`awaitingBreakdown` mirrors the `awaiting-draft` / `awaiting-link` / `awaiting-expired` sub-filters documented on `GET /sent` above — `drafts` = still-actionable saved draft, `link` = manual link-pending or failed publish, `expired` = draft whose source opportunity aged out.

---

### GET `/api/engage/sent/count`

Filtered counts under **exactly** the same filters as `GET /sent`, sharing the list's filter builder server-side so the two can never drift:

- `total` honors every filter — `status`, `platform`, and `date` included — and is the same number the list returns for that query string.
- `byPlatform` honors every filter **except `platform` itself** (each count pins one platform), so platform badges stay complete while `status`/`date` narrow them.
- `rollups` (`settled`/`awaiting`) honor every filter **except `status` itself** (the status axis), so the tab badges stay complete while `platform`/`date` narrow them.
- `awaitingBreakdown` (`drafts`/`link`/`expired`) — the awaiting rollup's sub-axis, same status-less scoping as `rollups`.

`page`/`limit` are accepted and ignored (they can't change a count), so clients can reuse the list query string verbatim.

**Query Params** — identical to [`GET /sent`](#get-apiengagesent).

**Response** `200 OK` (e.g. `?status=awaiting&platform=x`)

```json
{
  "total": 40,
  "byPlatform": { "x": 40, "reddit": 20 },
  "rollups": { "settled": 190, "awaiting": 40 },
  "awaitingBreakdown": { "drafts": 18, "link": 19, "expired": 3 }
}
```

> In the example, `total` counts awaiting x-replies, `byPlatform` breaks down awaiting replies per platform, and `rollups`/`awaitingBreakdown` break down x-replies per status.

---

### PATCH `/api/engage/sent/:id`

Edit a **scheduled** (QUEUE) engage reply. All fields are optional; supply only what needs to change.

**URL Param**: `id` — `EngageSentReply.id`

**Request Body**

| Field | Type | Description |
|---|---|---|
| `content` | `string` (max 4000) | New reply text — written to `Post.content`, read by Temporal at publish time |
| `scheduledAt` | `string` (ISO date) | New publish time — must be in the future; restarts the Temporal timer with claim-gate protection |
| `strategy` | `ReplyStrategy` | Updated generation strategy — stored in `inputData` |
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

The Engage data surfaces inside the existing Dashboard as five panels (no standalone page). Each panel has its own endpoint below.

> **Data source.** All figures derive from `Post` records with `source = 'engage'`. X reply metrics (`impressions`, `trafficScore`, `analytics`) are populated by `PostsService.checkPostAnalytics` using the integration's OAuth token — the same path regular posts use — so `impression_count` and `bookmark_count` are captured. The X traffic index uses the `x` weights in `traffic.calculator.ts` (`likes×1 + replies×2 + retweets×1.5 + quotes×2 + bookmarks×1.5`), which match the spec's `X_traffic_index`. Reddit replies are synced separately (`impressions = (score+comments)×20`, `trafficScore = score×1 + num_comments×3`). Dev.to replies are read server-side and anonymously from the comment permalink page (reaction count) plus Forem's public thread endpoint (`/api/comments?a_id=`, direct reply count), scored `trafficScore = reactions×1 + comments×3` off the shared `devto` weights — the same 1/3 ratio Reddit uses. Dev.to publishes no reach figure for a comment, so `impressions` stays 0 and the reply card omits it rather than showing a fabricated zero; a reply count that could not be read is omitted too, since a 0 there would be scored as "no replies". Engage posts are intentionally excluded from the global analytics job and aggregated via `EngageDataTicks` instead.

### GET `/api/engage/dashboard/summary`

**Panel ① — Engagement Performance.** Five headline metrics plus all-time platform split and best reply. The panel has platform chips/tabs:

- no `platform` param: combined X + Reddit view
- `platform=x`: X-only view
- `platform=reddit`: Reddit-only view

**Query Params**

| Param | Type | Default | Description |
|---|---|---|---|
| `projectId` | `string` | — (org-wide) | Optional project scope. Set = restrict every stat to posts/replies attributed to this project (`Post.projectId`); omitted = organization-wide (legacy behavior). |
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
| `projectId` | `string` | — (org-wide) | Optional project scope (`Post.projectId`); omitted = organization-wide. |
| `period` | `'daily' \| 'weekly' \| 'monthly'` | `daily` | Time aggregation granularity |

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
| `projectId` | `string` | — (org-wide) | Optional project scope (`Post.projectId`); omitted = organization-wide. |
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
| `projectId` | `string` | — (org-wide) | Optional project scope (`Post.projectId`); omitted = organization-wide. |
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

**Panel ⑤ — "Top engage sources".** The organization's best-performing individual engage replies, ranked by the per-platform engagement metric — **X by likes, Reddit by upvotes**, descending. Each item is one sent reply (not a per-author aggregate); the surfaced account is the **reply author** (the connected posting account), and the metrics are that reply's own stats.

**Query Params**

| Param | Type | Default | Description |
|---|---|---|---|
| `projectId` | `string` | — (org-wide) | Optional project scope (`Post.projectId`); omitted = organization-wide. |
| `platform` | `string` (`x` \| `reddit`) | — (all) | Restrict to one platform. |
| `limit` | `number` (1–50) | `10` | Number of top replies to return (applied **after** ranking). |

Candidate set = sent replies whose `Post.trafficScore` is non-null. Ranking metric per item: `likes` for X, `upvotes` for Reddit (a missing metric ranks as `0`). With no `platform` filter, a mixed X + Reddit list still sorts sensibly because each item ranks by its own platform's key.

**Response** `200 OK`

```json
{
  "items": [
    {
      "id": "sent-reply-uuid",          // EngageSentReply id
      "platform": "x",                  // 'x' | 'reddit' | 'unknown'
      "post": {
        "id": "post-uuid",              // Post.id, or null
        "content": "Reply text...",
        "releaseURL": "https://twitter.com/.../status/123",  // Post.releaseURL, falls back to the original post URL, or null
        "publishDate": "2026-05-20T10:00:00.000Z",           // Post.publishDate, or null
        "replyAuthor": {                // the connected account that posted the reply, or null
          "handle": "myhandle",         // '@' stripped
          "id": "internal-id",          // optional
          "name": "My Account",         // optional
          "avatarUrl": "https://.../avatar.jpg"  // optional
        },
        "metrics": {                    // this reply's own normalized metrics (platform-shaped)
          "trafficScore": 30,
          "impressions": 1200,
          "likes": 7,                   // X: likes/retweets/replies/quotes/bookmarks
          "retweets": 1,
          "replies": 0,
          "quotes": 0,
          "bookmarks": 2
        }
      },
      "metric": 7                       // the ranking value (X likes / Reddit upvotes)
    }
  ],
  "total": 42                           // size of the candidate set before the limit slice
}
```

- `metrics` is platform-shaped: X replies carry `{ trafficScore, impressions, likes, retweets, replies, quotes, bookmarks }`; Reddit replies carry `{ trafficScore, upvotes, comments, estReach }` instead.
- `replyAuthor` is resolved from the reply's stored `engageAuthor` settings first, then the connected integration; `id`/`name`/`avatarUrl` are present only when known. It is the account that **sent** the reply, not the original post's author.
- `total` is the count of eligible replies (non-null `trafficScore`) before the `limit` slice — not a sum of any metric.

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
| `403 Forbidden` | Opportunity no longer actionable (save-draft); or a reply pacing cap reached on send/schedule/batch — see [Reply pacing 403s](#reply-pacing-403s) for the JSON `code`s |
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
