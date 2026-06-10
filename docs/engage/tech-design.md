# AISEE Engage — Technical Design Document

**Version**: 1.1  
**Date**: 2026-05-20  
**Status**: Draft — Pending Review  
**PRD Reference**: `docs/engage/prd.md`

---

## 1. Overview

### 1.1 Problem

Postiz currently manages only *outbound* social media publishing. There is no capability to:
- Discover relevant conversations to join on X or Reddit
- Generate AI-powered reply drafts calibrated to post context and brand voice
- Send replies back to the platform
- Track the engagement performance of those replies

### 1.2 Proposed Solution

Add a new **Engage** module that follows a 4-phase workflow: **Discover → Generate → Send → Track**.

The module introduces:
1. A new NestJS `EngageModule` with its own controller, services, and repository layer
2. Five new Prisma models for engagement data storage
3. A single scan-ticker Temporal workflow for incremental discovery, plus the metrics-sync workflow
4. Five new frontend routes under `/engage`
5. Non-breaking additions to Dashboard and Calendar

### 1.3 Critical Distinction: Two Account Systems

Engage involves two completely separate "account" concepts. Confusing them is a major implementation risk.

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Reply Account (回复账号)           Tracked Account (追踪账号)              │
│  ─────────────────────────         ──────────────────────────────────── │
│  Source:  Integration table        Source:  EngageTrackedAccount table  │
│  Owned:   By the user (our acct)   Owned:   External/third-party        │
│  Purpose: SEND replies FROM        Purpose: MONITOR for new posts       │
│  Auth:    OAuth 1.0a / 2.0 token   Auth:    None (read-only public API) │
│  UI:      Reply Panel dropdown     UI:      Page 04 Block 4 settings    │
│  Scoring: N/A                      Scoring: +5 bonus if post from these │
└─────────────────────────────────────────────────────────────────────────┘
```

- **Reply Account (回复账号)**: The user's own X account already in `Integration`. When replying to a post, the user selects which of their own accounts to reply from. Token stored in `Integration.token`.
- **Tracked Account (追踪账号)**: Any external X account (competitor, influencer, industry expert) the user wants to monitor. Stored in `EngageTrackedAccount`. When they post, the post enters Signal Feed as an opportunity. Gets +5 score bonus.

### 1.4 Non-Goals

- Modifying existing Post scheduling or publishing flows
- Replacing or refactoring existing social provider architecture
- Supporting LinkedIn, Bluesky, or Threads in v1.0
- Building automated content moderation or spam detection

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│  Frontend (Next.js)                                                  │
│  /engage         → Signal Feed  (filter/sort by dimension score)    │
│  /engage/sent    → Sent History  (reads Post WHERE source='engage') │
│  /engage/settings → Keywords & Accounts                             │
│  First visit     → Setup Wizard (one-time)                           │
│                                                                      │
│  Dashboard  → Engage panel queries Post WHERE source='engage'       │
│  Calendar   → Engage events = Post WHERE source='engage' (colored)  │
└──────────────────────────┬──────────────────────────────────────────┘
                           │ REST API
┌──────────────────────────▼──────────────────────────────────────────┐
│  Backend (NestJS)                                                    │
│  EngageController  — discovery, draft gen, triggers PostService     │
│  EngageService     — config, opportunities, score, classify          │
│  EngageScorerService   — returns ScoreBreakdown (5 dimensions)      │
│  EngageIntentClassifier — local NLI model, 44MB, in-process         │
│                                                                      │
│  PostService (existing) ← Engage reuses for send/schedule/metrics  │
└─────┬──────────────────────────────────┬────────────────────────────┘
      │ Prisma                           │ Temporal Client
┌─────▼──────────────┐         ┌─────────▼──────────────────────────────┐
│  PostgreSQL        │         │  Temporal Orchestrator                  │
│  Engage models:    │         │  engage-scan-ticker.workflow (~5m tick) │
│  Config/Keyword/   │         │    └─ runDueScans → adapters(X/Reddit)   │
│  Channel/Tracked/  │         │       → score → classify → persist      │
│  Opportunity/State │         │  (cursor cadence + cooldown per unit)   │
│  ScanCursor        │         │  postWorkflowV101 (existing, reused)    │
│  SentReply (slim)  │         │    └─ sends/schedules Engage Post       │
│  Post (existing)   │         │  engageDataTicksWorkflow (daily 01:00)  │
│  ← metrics live   │         │    └─ aggregate → EngageDataTicks       │
│    in Post.analytics│        │  engage-metrics-sync.workflow (24h)     │
│  EngageDataTicks   │         │    └─ authorReplied + Reddit analytics  │
│    in Post.analytics│        └────────────┬────────────────────────────┘
└────────────────────┘                      │
                   ┌────────────────────────┼──────────────────────────┐
                   │                        │                          │
           ┌───────▼──────┐  ┌─────────────▼──┐  ┌──────────────────▼──┐
           │  X API v2    │  │  Reddit / other  │  │  Claude API         │
           │  search +    │  │  platform APIs   │  │  Sonnet: draft gen  │
           │  send via    │  │  (search only;   │  │  Haiku: intent      │
           │  XProvider   │  │   reply=manual)  │  │  fallback (<15%)    │
           └──────────────┘  └──────────────────┘  └─────────────────────┘

  Local (in-process): Xenova/nli-deberta-v3-small (44MB) — intent classification
```

---

## 3. Data Model

### 3.1 New Prisma Models

Add to `libraries/nestjs-libraries/src/database/prisma/schema.prisma`:

```prisma
// Engage module: per-org configuration (global settings only)
// Per-account auto-reply config is stored in EngageXReplyAccount (linked to Integration)
model EngageConfig {
  id                    String    @id @default(uuid())
  organizationId        String    @unique
  organization          Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  setupCompleted        Boolean   @default(false)
  lastScanAt            DateTime? // when the last daily keyword scan completed; shown in UI as "last updated"
  createdAt             DateTime  @default(now())
  updatedAt             DateTime  @updatedAt

  keywords              EngageKeyword[]
  monitoredChannels     EngageMonitoredChannel[]
  trackedAccounts       EngageTrackedAccount[]
  xReplyAccounts        EngageXReplyAccount[]
}

// Keyword with type and stats
model EngageKeyword {
  id                    String    @id @default(uuid())
  configId              String
  config                EngageConfig @relation(fields: [configId], references: [id], onDelete: Cascade)
  organizationId        String
  keyword               String
  type                  String    @default("CORE")  // "CORE" | "BRAND" | "COMPETITOR" | ...
  enabled               Boolean   @default(true)
  weeklyHitCount        Int       @default(0)   // reset every Monday; used for weekly stats display
  totalHitCount         Int       @default(0)   // cumulative; never reset; used for all-time analytics
  lastCountedAt         DateTime?
  createdAt             DateTime  @default(now())
  updatedAt             DateTime  @updatedAt

  initialScans          EngageKeywordInitialScan[]

  @@unique([configId, keyword])               // prevent duplicate keywords per org
  @@index([organizationId])
  @@index([configId, enabled])
}

// Per-keyword/per-platform current initial-scan state. This is NOT a historical
// job log and NOT an incremental cursor. It exists because the shared global
// keyword cursor (`reddit/keyword/__global__`) is efficient for steady-state
// future posts, but cannot backfill recent posts for a keyword that was added
// after the global cursor had already advanced. A newly added/re-enabled keyword
// gets a PENDING row; the ticker performs a single-keyword catch-up scan for a
// bounded lookback window, then marks it DONE/FAILED.
model EngageKeywordInitialScan {
  id             String    @id @default(uuid())
  organizationId String    // immutable denormalization for org/platform status reads
  keywordId      String
  keywordRef     EngageKeyword @relation(fields: [keywordId], references: [id], onDelete: Cascade)
  platform       String    // "reddit" today; future: "x", "youtube", ...
  keyword        String    // snapshot refreshed when the keyword is re-enabled/edited
  status         String    @default("PENDING") // PENDING | RUNNING | DONE | FAILED
  startedAt      DateTime? // RUNNING lease start; stale rows are reclaimable
  completedAt    DateTime?
  error          String?
  attempts       Int       @default(0)
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt

  @@unique([keywordId, platform])
  @@index([status, platform, createdAt])
  @@index([organizationId, platform])
}

// Keyword types stored as String — no migration needed when adding new types.
// Canonical values: "CORE" | "BRAND" | "COMPETITOR" | future values
// Define in engage-keyword.constants.ts alongside KEYWORD_TYPE_COLORS etc.

// A monitored channel / community the user subscribes to.
// One row = one specific channel, regardless of platform.
// Examples:
//   Reddit subreddit: platform="reddit",  channelId="SEO",        channelName="r/SEO",          audienceSize=memberCount
//   YouTube channel:  platform="youtube", channelId="UCxxxxxx",   channelName="Channel title",   audienceSize=subscriberCount
//   QQ group:         platform="qq",      channelId="123456789",  channelName="SEO交流群",        audienceSize=memberCount
//   Discord server:   platform="discord", channelId="server_id",  channelName="Server name",     audienceSize=memberCount
model EngageMonitoredChannel {
  id                    String    @id @default(uuid())
  configId              String
  config                EngageConfig @relation(fields: [configId], references: [id], onDelete: Cascade)
  organizationId        String
  platform              String    // "reddit" | "youtube" | "qq" | "discord" | ...
  channelId             String    // platform-native identifier
  channelName           String    // display name shown in UI
  audienceSize          Int       @default(0)  // members/subscribers — DISPLAY ONLY (no longer feeds authority scoring; a post in a monitored subreddit grants scoreTracked +5 instead)
  enabled               Boolean   @default(true)
  lastScannedAt         DateTime? // last time this channel was scanned; used for incremental fetch
  metadata              Json?     // platform-specific extras ({ url, description, iconUrl })
  createdAt             DateTime  @default(now())
  updatedAt             DateTime  @updatedAt

  @@unique([configId, platform, channelId])
  @@index([organizationId])
  @@index([configId, platform, enabled])
}

// ──────────────────────────────────────────────────────────────────────────
// TRACKED ACCOUNTS (追踪账号): EXTERNAL third-party X accounts we MONITOR.
// These are NOT the user's own accounts. They have no OAuth tokens here.
// Purpose: when these external accounts post on X, their posts are pushed
//          into Signal Feed as engagement opportunities (checked every 3h).
//          Posts from tracked accounts also receive a +5 score bonus.
// DO NOT confuse with EngageXReplyAccount (our own accounts we send from).
// ──────────────────────────────────────────────────────────────────────────
model EngageTrackedAccount {
  id                    String    @id @default(uuid())
  configId              String
  config                EngageConfig @relation(fields: [configId], references: [id], onDelete: Cascade)
  organizationId        String
  platform              String    @default("x")
  username              String    // external user's X @username (no @ prefix)
  displayName           String?
  categoryLabel         String?   // user-defined label: "GEO专家", "SEO媒体", etc.
  enabled               Boolean   @default(true)
  lastCheckedAt         DateTime? // when we last polled their tweets
  createdAt             DateTime  @default(now())
  updatedAt             DateTime  @updatedAt

  @@unique([configId, platform, username])  // username is platform-scoped; same name on X vs Bluesky = different rows
  @@index([organizationId, enabled])
}

// ──────────────────────────────────────────────────────────────────────────
// X REPLY ACCOUNTS (回复账号): The user's OWN X accounts used to SEND replies.
// These reference the existing Integration model (which holds OAuth tokens).
// Per-account Engage settings: enabled for Engage? auto-reply on? time window?
// DO NOT confuse with EngageTrackedAccount (external accounts we monitor).
// ──────────────────────────────────────────────────────────────────────────
model EngageXReplyAccount {
  id                    String    @id @default(uuid())
  configId              String
  config                EngageConfig @relation(fields: [configId], references: [id], onDelete: Cascade)
  organizationId        String
  integrationId         String    // FK → Integration.id (the user's own X account)
  integration           Integration @relation(fields: [integrationId], references: [id], onDelete: Cascade)
  engageEnabled         Boolean   @default(true)   // visible in Reply Panel dropdown
  autoReplyEnabled      Boolean   @default(false)  // auto-send without manual confirm
  autoReplyTimeStart    String?   // "09:00" (24h format, interpreted in autoReplyTimezone)
  autoReplyTimeEnd      String?   // "18:00"
  autoReplyTimezone     String?   // IANA timezone, e.g. "Asia/Shanghai" (defaults to org timezone)
  defaultStrategy       String    @default("EXPERT_ANSWER")  // strategy used for auto-generated drafts
  createdAt             DateTime  @default(now())
  updatedAt             DateTime  @updatedAt

  @@unique([configId, integrationId])
  @@index([organizationId, engageEnabled])
}

// Discovered engagement opportunity — GLOBAL post, shared across all orgs.
// One row per (platform, externalPostId): the same public post is stored ONCE,
// not duplicated per org. Holds immutable content, raw metrics, and the
// OBJECTIVE scores (identical for every org). Per-org mutable state (status,
// bookmark, keyword/tracked scores) lives in EngageOpportunityState below.
// (Refactored 2026-05-27 from a per-org table into this two-table split.)
model EngageOpportunity {
  id                    String    @id @default(uuid())
  platform              String    // "x" | "reddit" | "youtube" | ...
  externalPostId        String    // platform-native ID (tweet_id, reddit post id, YT video id, etc.)
  externalPostUrl       String
  channelId             String?   // platform community: subreddit name, YT channel ID, etc. (null for X)
  channelName           String?   // display name: "r/SEO", "Channel Title", etc.
  authorUsername        String
  authorDisplayName     String?
  authorFollowers       Int?      // post author's real follower count, all platforms (Reddit = u/<name> profile subscribers, fetched per-author during scan)
  authorAvatarUrl       String?
  postContent           String
  postPublishedAt       DateTime

  // ── Objective scores (same for every org → live on the global row) ────────
  // scoreHeat       45   per-platform engagement; 4 branches (see §9):
  //                      text(x/threads/mastodon/bluesky), video(youtube/tiktok),
  //                      network(linkedin/instagram/pinterest), community(reddit)
  // scoreAuthority  15   post author's real follower count (all platforms); see §9 for thresholds
  // scoreRecency     5   within 24h → 5; else → 0
  scoreHeat             Int       @default(0)
  scoreAuthority        Int       @default(0)
  scoreRecency          Int       @default(0)

  // ── Intent classification ─────────────────────────────────────────────
  // Canonical values:
  // help_seeking | rant | discussion | opinion | comparison | data_share
  intentTags            String[]  // all matched intents (confidence > 0.4)
  primaryIntent         String    @default("discussion")
  intentScore           Float?    // classifier confidence for primaryIntent (0-1)

  // ── Raw platform metrics at discovery time (inputs to scoring) ────────
  metricLikes           Int       @default(0)
  metricReplies         Int       @default(0)
  metricRetweets        Int       @default(0)  // X retweet | Threads repost | Mastodon reblog | Bluesky repost
  metricQuotes          Int       @default(0)
  metricBookmarks       Int       @default(0)  // X bookmark_count
  metricViews           Int       @default(0)  // YouTube/TikTok views | Threads/LinkedIn/IG impressions
  metricShares          Int       @default(0)  // TikTok/LinkedIn/IG shares
  metricSaves           Int       @default(0)  // Instagram saved | Pinterest SAVE
  metricScore           Int       @default(0)  // Reddit score
  metricUpvoteRatio     Float?                  // Reddit
  metricComments        Int       @default(0)  // Reddit num_comments | YouTube/TikTok comment_count

  rawData               Json?     // original platform API response (debug / field-coverage audit)

  createdAt             DateTime  @default(now())
  updatedAt             DateTime  @updatedAt
  deletedAt             DateTime?

  states                EngageOpportunityState[]
  sentReplies           EngageSentReply[]

  // ── Deduplication constraint (now GLOBAL, not per-org) ────────────────────
  @@unique([platform, externalPostId])

  @@index([createdAt])
  @@index([deletedAt])
  @@index([postPublishedAt])
  // GIN index for intentTags @> ARRAY[...] (Prisma: has: tag).
  @@index([intentTags], type: Gin)
  // NOTE: a pg_trgm GIN index on postContent (backs the getKeywordPosts ILIKE
  // preview) is NOT declarable here — `prisma db push` can't create a
  // gin_trgm_ops index. It lives in prisma/engage-indexes.sql, run by the
  // `prisma-db-indexes` npm script which is chained into `prisma-db-push`.
}

// Per-org mutable state for a global opportunity. Created at scan time when a
// post matches THIS org's keywords. SUBJECTIVE scores (depend on the org's own
// keyword set / tracked accounts) live here; objective scores stay on the
// global row. The feed's total `score` is recomputed every scan and stored here.
//
// Dimension      Max   Formula / thresholds
// scoreKeyword    35   each keyword hit +15, capped at 35 (关键词质量)
// scoreTracked     5   X: author is in this org's EngageTrackedAccount; Reddit: post is in
//                      one of this org's EngageMonitoredChannel subreddits → +5 (重点账户/频道)
// score          105   = scoreKeyword + scoreTracked + opportunity.(scoreHeat+scoreAuthority+scoreRecency)
model EngageOpportunityState {
  organizationId String
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  opportunityId  String
  opportunity    EngageOpportunity @relation(fields: [opportunityId], references: [id], onDelete: Cascade)

  status         EngageOpportunityStatus @default(NEW)
  bookmarked     Boolean   @default(false)
  score          Int       @default(0)
  scoreKeyword   Int       @default(0)
  scoreTracked   Int       @default(0)
  matchedKeywords String[]                  // this org's enabled keywords the post hit (per-org; refreshed each re-scan)

  createdAt      DateTime  @default(now())  // when THIS org first matched the post (drives TTL/expiry)
  updatedAt      DateTime  @updatedAt

  @@id([organizationId, opportunityId])
  @@index([organizationId, status])
  @@index([organizationId, score])
  @@index([organizationId, bookmarked])   // support "Saved" Feed filter
  @@index([opportunityId])
}

// ── EngageScanCursor: org-independent cursor for one scan unit ─────────────
// One row per (platform, scanType, scanKey) — a single upstream fetch shared by
// all orgs (the same keyword/subreddit/account is fetched once, then fanned out).
// Drives incremental fetching (lastSeen*) and the cadence ticker's scheduling
// (lastScanStartedAt + per-type cadence → next due; cooldownUntil = rate-limit
// back-off; status = single-flight). Read by getOrgScanStatus to report per-org
// last/next scan time. See §5.1.
model EngageScanCursor {
  id                 String    @id @default(uuid())
  platform           String    // 'x' | 'reddit'
  scanType           String    // 'keyword' | 'tracked' | 'channel'
  scanKey            String    // keyword '__global__' | username | subreddit id
  lastSeenExternalId String?   // X since_id / Reddit fullname of newest seen post
  lastSeenAt         DateTime? // newest seen post's publish time (Reddit stop cond.)
  lastScanStartedAt  DateTime? // anchors next-due (start + cadence)
  lastScannedAt      DateTime? // last successful completion (display)
  cooldownUntil      DateTime? // rate-limit back-off; null when not cooling down
  status             String    @default("IDLE") // IDLE | SCANNING (single-flight)
  createdAt          DateTime  @default(now())
  updatedAt          DateTime  @updatedAt

  @@unique([platform, scanType, scanKey])
  @@index([status, scanType, lastScanStartedAt])
}

enum EngageOpportunityStatus {
  NEW          // in Feed, not yet acted on
  DISMISSED    // user skipped; hidden from Feed
  REPLIED      // reply sent or manually confirmed
  SCHEDULED    // reply queued for later send
  AUTO_QUEUED  // added to auto-reply queue; waiting for time window
  EXPIRED      // exceeded TTL (e.g. 30 days old); excluded from Feed, kept for audit
}

// Intent types are NOT a Prisma enum — stored as plain strings for forward compatibility.
// New intent types can be added without schema migration.
// Canonical values defined in EngageIntentClassifier.INTENT_LABELS (see §6.x).

// ── EngageSentReply: thin join/metadata table ─────────────────────────────
// Sending / scheduling / state / error / metrics all live in the linked Post.
// This model stores ONLY Engage-specific context that Post cannot express.
//
// X flow:   Post created on "Send/Schedule" → postWorkflowV101 handles publish
// Reddit:   Post created when user submits comment URL (state=PUBLISHED, releaseURL=url)
// Status:   Read from Post.state (QUEUE=pending, PUBLISHED=sent, ERROR=failed)
// Metrics:  Read from Post.impressions / Post.trafficScore / Post.analytics
model EngageSentReply {
  id             String   @id @default(uuid())
  organizationId String
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  opportunityId  String   // FK → EngageOpportunity (global post)
  opportunity    EngageOpportunity @relation(fields: [opportunityId], references: [id])

  postId         String   @unique  // FK → Post (source='engage'; created atomically with this record)
  post           Post     @relation(fields: [postId], references: [id], onDelete: Cascade)

  // Engage-specific metadata — everything else is in Post
  strategy       String           // "EXPERT_ANSWER" | "DATA_BACKED" | "EMPATHY_LED" | future
  brandStrength  Int      @default(1)   // 0-3: brand mention level used when generating draft
  authorReplied  Boolean  @default(false) // did the original post author reply to our reply?

  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  // Each org replies to a given global post at most once; different orgs may
  // each reply to the same post (so the key is composite, not opportunityId-unique).
  @@unique([organizationId, opportunityId])
  @@index([organizationId])
}

// EngageSentStatus enum REMOVED.
// Post.state (QUEUE / PUBLISHED / ERROR) is the single source of truth for send status.
// Strategy stored as String (not enum) — canonical values in STRATEGY_PROMPTS.

// ── EngageDataTicks: time-series aggregation for Engage replies ───────────
// Mirrors the existing DataTicks model pattern, but scoped to Engage.
//
// Why not reuse DataTicks?
//   - DataTicks is per-integration (per social account); Engage needs per-platform aggregation
//   - Reddit Engage posts have no integrationId; DataTicks unique key requires integrationId
//   - Keeping Engage stats separate avoids polluting the existing Post analytics pipeline
//
// Populated by engageDataTicksWorkflow (daily, after the scan ticker has run).
// Aggregates: Post WHERE source='engage' + state=PUBLISHED
//
// type values (mirrors DataTicks):
//   "replies"     — COUNT of replies published that day
//   "impressions" — SUM(Post.impressions)
//   "traffic"     — SUM(Post.trafficScore)
model EngageDataTicks {
  organizationId  String
  platform        String    // "x" | "reddit" | "all" (cross-platform total)
  type            String    // "replies" | "impressions" | "traffic"
  timeUnit        String    // "day" | "week" | "month"
  statisticsTime  DateTime  // bucket start, aligned to timeUnit (UTC)
  value           BigInt    @default(0)

  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt

  @@unique([organizationId, platform, type, timeUnit, statisticsTime])
  @@index([organizationId, platform, type, timeUnit])
  @@index([organizationId, type, statisticsTime])
}
```

### 3.2 Model Extension: Organization

```prisma
// Add to existing model Organization:
engageConfig             EngageConfig?
engageOpportunityStates  EngageOpportunityState[]  // per-org state; EngageOpportunity itself is global (no org relation)
engageSentReplies        EngageSentReply[]
// EngageDataTicks has no Prisma relation — queried directly by organizationId
```

### 3.3 Model Extension: Integration

```prisma
// Add to existing model Integration:
engageXReplyAccount   EngageXReplyAccount?
```

### 3.4 Model Extension: Post (existing)

Two small additions to make Engage replies flow through the Post pipeline:

```prisma
// Add to existing model Post:
engageSentReply       EngageSentReply?   // back-relation; null for non-Engage posts

// Post.source is a String @default("calendar") (no schema migration needed for
// new values). Valid values: "calendar" | "chat" | "engage" — enforced in code
// via the shared VALID_POST_SOURCES constant (dtos/posts/post-source.ts).

// Add to existing XDto (providers-settings/x.dto.ts):
// reply_to_tweet_id?: string   — the tweet ID to reply to (read by postWorkflowV101)
```

### 3.5 Model Relationship Summary

```
Organization
├── EngageConfig (1:1)
│   ├── EngageKeyword[] (1:N)
│   ├── EngageMonitoredChannel[] (1:N)  ← subscribed channels (r/SEO, YT, QQ群, ...)
│   ├── EngageTrackedAccount[] (1:N)    ← EXTERNAL accounts monitored for new posts
│   └── EngageXReplyAccount[] (1:N)    ← OUR OWN X accounts (→ Integration)
├── EngageOpportunityState[] (1:N)     ← per-org state for a discovered post (status, bookmark, keyword/tracked score)
│   └── EngageOpportunity (N:1) ←─────── GLOBAL post (content, metrics, objective scores); shared across orgs
├── EngageSentReply[] (1:N)            ← Engage metadata (strategy, brandStrength, authorReplied); unique per (org, opportunity)
│   └── Post (1:1) ←──────────────────── source='engage'; carries state/metrics/content
├── Post[] (1:N, source='engage')      ← All Engage replies; queried for real-time stats
└── EngageDataTicks[] (1:N)           ← Pre-aggregated time-series (replies/impressions/traffic)

EngageOpportunity (GLOBAL — no Organization relation)
├── EngageOpportunityState[] (1:N)     ← one per org that matched this post
└── EngageSentReply[] (1:N)            ← one per org that replied to this post

Integration (existing)
└── EngageXReplyAccount (1:0..1)       ← Per-account Engage settings (enabled, auto-reply)

Post (existing, source='engage')
├── state    → QUEUE/PUBLISHED/ERROR (send status)
├── error    → failure message
├── releaseURL → X tweet_id or Reddit comment URL
├── analytics  → raw platform metrics (JSON)
├── impressions / trafficScore → normalized metrics
└── settings.reply_to_tweet_id → X reply target (new XDto field)
```

---

## 4. Backend API

### 4.1 New Controller

**File**: `apps/backend/src/api/routes/engage.controller.ts`

Following the existing `posts.controller.ts` pattern:

```typescript
@ApiTags('Engage')
@Controller('/engage')
export class EngageController {
  constructor(private _engageService: EngageService) {}

  // Config endpoints
  @Get('/config')
  getConfig(@GetOrgFromRequest() org: Organization) { ... }

  @Post('/config')
  saveConfig(@GetOrgFromRequest() org: Organization, @Body() body: SaveEngageConfigDto) { ... }

  @Post('/config/reset')
  resetConfig(@GetOrgFromRequest() org: Organization) { ... }

  // Opportunities endpoints
  @Get('/opportunities')
  listOpportunities(
    @GetOrgFromRequest() org: Organization,
    @Query() query: ListOpportunitiesDto  // platform, score, intent, status, date
  ) { ... }

  @Patch('/opportunities/:id/dismiss')
  dismissOpportunity(@GetOrgFromRequest() org: Organization, @Param('id') id: string) { ... }

  @Patch('/opportunities/:id/bookmark')
  toggleBookmark(@GetOrgFromRequest() org: Organization, @Param('id') id: string) { ... }

  // Score dimension analytics — used by Feed header stats and future analytics page
  @Get('/opportunities/score-stats')
  getScoreStats(
    @GetOrgFromRequest() org: Organization,
    @Query() query: ScoreStatsDto,  // { date?, platform? }
  ) { ... }
  // Returns: ScoreStatsResult (see below)

  // ── Reply endpoints — delegate to PostService ────────────────────────────
  // All send/schedule logic is handled by the existing Post pipeline.
  // EngageController only creates the Post + EngageSentReply atomically.

  @Post('/opportunities/:id/reply')
  sendReply(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Body() body: SendReplyDto
    // Internally: PostService.createPost({ source:'engage', type:'now', settings.reply_to_tweet_id })
    //             + create EngageSentReply linking opportunity → Post
    //             + update EngageOpportunity.status = REPLIED
  ) { ... }

  @Post('/opportunities/:id/schedule')
  scheduleReply(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body() body: ScheduleReplyDto
    // Internally: PostService.createPost({ source:'engage', type:'schedule', date: scheduledAt })
    //             + create EngageSentReply + update EngageOpportunity.status = SCHEDULED
  ) { ... }

  // Reddit manual-flow STEP 1: user clicked "✓ Replied Manually" (confirmed reply, no URL yet)
  // Creates Post(PUBLISHED, no releaseURL) + EngageSentReply immediately.
  // Record appears in Sent with "⚠ Reply URL missing" warning until URL is submitted.
  @Post('/opportunities/:id/manual-reply')
  confirmManualReply(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Body() body: ConfirmManualReplyDto  // { draftContent, strategy, brandStrength }
    // Internally: PostService.createPost({ source:'engage', state→PUBLISHED, no releaseURL })
    //             + create EngageSentReply(postId) + EngageOpportunity.status = REPLIED
  ) { ... }

  // Reddit manual-flow STEP 2: user submits the Reddit comment URL
  // Updates Post.releaseURL — enables metrics polling in engage-metrics-sync.workflow.
  @Patch('/sent/:id/reply-url')
  submitManualReplyUrl(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body() body: { url: string }  // reddit.com/r/.../comments/.../comment/...
    // Internally: Post.releaseURL = url
  ) { ... }

  // AI draft generation
  @Post('/opportunities/:id/draft')
  generateDraft(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body() body: GenerateDraftDto,
    @Res() res: Response
  ) { ... }  // SSE streaming response

  // Sent history list
  @Get('/sent')
  listSentReplies(
    @GetOrgFromRequest() org: Organization,
    @Query() query: ListSentDto  // platform, status, date, page, limit
  ) { ... }

  // Sent page top-4 stats cells (发出回复 all-time / Reply rate / Total Impressions / Avg Likes)
  @Get('/sent/stats')
  getSentStats(@GetOrgFromRequest() org: Organization) { ... }
  // Returns: SentStatsResult

  // Dashboard stats — three panels (see §11.1)
  @Get('/dashboard/summary')                // ① Engagement Performance (?platform=x|reddit)
  getDashboardSummary(@GetOrgFromRequest() org: Organization, @Query() q: DashboardSummaryDto) { ... }
  @Get('/dashboard/replies-trend')          // ② Your Posts overlay (?days=30)
  getDashboardRepliesTrend(@GetOrgFromRequest() org: Organization, @Query() q: DashboardRepliesTrendDto) { ... }
  @Get('/dashboard/traffics')               // ③ Traffic from Engage (?platform&limit)
  getDashboardTraffics(@GetOrgFromRequest() org: Organization, @Query() q: DashboardTrafficsDto) { ... }

  // Keywords
  @Post('/keywords')
  addKeyword(@GetOrgFromRequest() org: Organization, @Body() body: AddKeywordDto) { ... }

  @Delete('/keywords/:id')
  deleteKeyword(@GetOrgFromRequest() org: Organization, @Param('id') id: string) { ... }

  @Patch('/keywords/:id')
  updateKeyword(@GetOrgFromRequest() org: Organization, @Param('id') id: string, @Body() body: UpdateKeywordDto) { ... }

  // ── MONITORED CHANNELS (r/SEO, YT channel, QQ group, ...) ────────
  @Get('/monitored-channels')
  listMonitoredChannels(@GetOrgFromRequest() org: Organization) { ... }

  @Post('/monitored-channels')
  addMonitoredChannel(@GetOrgFromRequest() org: Organization, @Body() body: AddMonitoredChannelDto) { ... }

  @Patch('/monitored-channels/:id')
  updateMonitoredChannel(@GetOrgFromRequest() org: Organization, @Param('id') id: string, @Body() body: UpdateMonitoredChannelDto) { ... }

  @Delete('/monitored-channels/:id')
  removeMonitoredChannel(@GetOrgFromRequest() org: Organization, @Param('id') id: string) { ... }

  // Search available channels for a given platform (used by "Add channel" UI)
  @Post('/monitored-channels/search')
  searchChannels(@GetOrgFromRequest() org: Organization, @Body() body: SearchChannelsDto) { ... }

  // ── TRACKED ACCOUNTS: External X accounts we MONITOR ──────────
  // These are NOT the user's own accounts. No OAuth. Just username + settings.
  @Get('/tracked-accounts')
  listTrackedAccounts(@GetOrgFromRequest() org: Organization) { ... }

  @Post('/tracked-accounts')
  addTrackedAccount(@GetOrgFromRequest() org: Organization, @Body() body: AddTrackedAccountDto) { ... }

  @Patch('/tracked-accounts/:id')
  updateTrackedAccount(@GetOrgFromRequest() org: Organization, @Param('id') id: string, @Body() body: UpdateTrackedAccountDto) { ... }

  @Delete('/tracked-accounts/:id')
  removeTrackedAccount(@GetOrgFromRequest() org: Organization, @Param('id') id: string) { ... }

  // ── REPLY ACCOUNTS: Our own X accounts from Integration ────────
  // Returns Integration accounts with their EngageXReplyAccount settings.
  // Does NOT create integrations — those are managed in /integrations routes.
  @Get('/reply-accounts')
  listReplyAccounts(@GetOrgFromRequest() org: Organization) { ... }

  @Patch('/reply-accounts/:integrationId')
  updateReplyAccountSettings(
    @GetOrgFromRequest() org: Organization,
    @Param('integrationId') integrationId: string,
    @Body() body: UpdateReplyAccountDto  // { engageEnabled, autoReplyEnabled, timeStart, timeEnd }
  ) { ... }
}
```

### 4.2 DTOs

**File**: `libraries/nestjs-libraries/src/engage/dtos/engage.dto.ts`

```typescript
export class GenerateDraftDto {
  // strategy is a plain string — not bound to a TS enum.
  // v1.0 values: 'EXPERT_ANSWER' | 'DATA_BACKED' | 'EMPATHY_LED'
  // Future values added in STRATEGY_PROMPTS without DTO changes.
  strategy: string;
  brandStrength: number;  // 0-3
}

export class SendReplyDto {
  integrationId: string;  // Integration.id — the user's OWN X account (reply account, NOT tracked account)
  draftContent: string;
  strategy: string;       // matches STRATEGY_PROMPTS keys
  brandStrength: number;
}

export class ScheduleReplyDto extends SendReplyDto {
  scheduledAt: string;    // ISO date string
}

// Step 1: confirm manual reply (no URL yet) — creates Post + EngageSentReply
export class ConfirmManualReplyDto {
  draftContent:  string;
  strategy:      string;
  brandStrength: number;
  // commentUrl intentionally absent — submitted separately via PATCH /sent/:id/reply-url
}
// Step 2: submit URL — updates Post.releaseURL to enable metrics polling
// Uses body: { url: string } on PATCH /sent/:id/reply-url (already defined above)

export class ListOpportunitiesDto {
  // ── Basic filters — all multi-value (OR); accepts repeated params or comma-separated ──
  platform?: string[];  // e.g. ['x', 'reddit']; omit = no filter; max 20
  status?: EngageOpportunityStatus[];  // OR across statuses; max 20
  intent?: string[];    // OR across intentTags values; max 20
  date?: 'today' | 'week';

  // ── Per-dimension score filters (min threshold) ────────────────────────
  minScore?:          number;  // total composite score
  minScoreKeyword?:   number;  // keyword quality
  minScoreHeat?:      number;  // platform heat
  minScoreAuthority?: number;  // account influence
  bookmarked?:        boolean; // true = only bookmarked; false = only non-bookmarked; omit = all

  // ── Source filters — multi-value (OR); omit = no filter ───────────────
  // channels: specific channel ids (e.g. ['SEO', 'TECH']); omit = all channels
  // authors:  specific author usernames, case-insensitive (e.g. ['alice', 'bob']); omit = all authors
  channels?: string[];  // max 50
  authors?:  string[];  // max 50

  // ── Sorting ────────────────────────────────────────────────────────────
  // Default: score DESC (highest total first)
  sortBy?:    'score' | 'scoreKeyword' | 'scoreHeat' | 'scoreAuthority' | 'scoreRecency' | 'scoreTracked' | 'createdAt';
  sortOrder?: 'asc' | 'desc';

  // ── Pagination ─────────────────────────────────────────────────────────
  page?:  number;
  limit?: number;
}

// ── SENT LIST + STATS DTOs ────────────────────────────────────────────────
export class ListSentDto {
  platform?:  string;                  // filter by platform (x | reddit | ...)
  status?:    string;                  // 'published' | 'scheduled' | 'manual' | 'error'
  date?:      'today' | 'week' | 'month';
  page?:      number;
  limit?:     number;
}

// GET /engage/sent/stats — stat cells shown above Sent history list.
// Scoped by the same date/platform/status filters as /sent (all-time when no date).
interface SentStatsResult {
  repliesCount:       number;   // replies in the window (all-time default): COUNT EngageSentReply
  responseRate:      number;   // reply rate: COUNT(authorReplied=true) / total × 100
  totalImpressions:  number;   // total impressions: SUM(Post.impressions) over windowed engage posts
  totalTrafficScore: number;   // total traffic: SUM(Post.trafficScore) over windowed engage posts, rounded
  avgLikes:          number;   // avg likes: AVG of X likes + Reddit score from Post.analytics
}

// ── SCORE STATS DTO ────────────────────────────────────────────────────────
export class ScoreStatsDto {
  date?:     'today' | 'week' | 'month';
  platform?: string;
}

// GET /engage/opportunities/score-stats response shape
interface ScoreStatsResult {
  total: number;           // total opportunities in range
  avgScore: number;        // avg total composite score
  avgScoreKeyword:   number;
  avgScoreHeat:      number;
  avgScoreAuthority: number;
  // Score distribution buckets (for histogram)
  distribution: {
    range:  '85-100' | '70-84' | '60-69';
    count:  number;
    pct:    number;    // percentage of total
  }[];
  // Top score per dimension (for "what's driving quality")
  topByKeyword:   { id: string; score: number; title: string };
  topByHeat:      { id: string; score: number; title: string };
  topByAuthority: { id: string; score: number; title: string };
  trackedCount:   number;  // how many from tracked accounts
}

// ── TRACKED ACCOUNTS DTOs ───────────────────────────────────────────────
export class AddTrackedAccountDto {
  username: string;      // external X @username (no @ prefix)
  categoryLabel?: string; // e.g. "GEO Expert"
  enabled?: boolean;    // default true
}

export class UpdateTrackedAccountDto {
  enabled?: boolean;
  categoryLabel?: string;
}

// ── MONITORED CHANNELS DTOs ───────────────────────────────────────────────
export class AddMonitoredChannelDto {
  platform: string;      // "reddit" | "youtube" | "qq" | "discord" | ...
  channelId: string;     // platform-native ID (subreddit name, YT channel ID, QQ group ID, etc.)
  channelName: string;   // display name ("r/SEO", "Channel Title", "SEO Chat Group")
  audienceSize?: number;
  metadata?: Record<string, unknown>;
}

export class UpdateMonitoredChannelDto {
  enabled?: boolean;
  channelName?: string;
  audienceSize?: number;
}

export class SearchChannelsDto {
  platform: string;  // "reddit" | "youtube" | ...
  query: string;
}

// ── REPLY ACCOUNTS (回复账号) DTOs — our own Integration accounts ──────────
export class UpdateReplyAccountDto {
  engageEnabled?: boolean;
  autoReplyEnabled?: boolean;
  autoReplyTimeStart?: string;  // "HH:MM" 24h
  autoReplyTimeEnd?: string;
}
```

### 4.3 Module Registration

**File**: `apps/backend/src/app.module.ts`

```typescript
// Add to imports array:
import { EngageModule } from './engage/engage.module';

@Module({
  imports: [
    // ... existing imports
    EngageModule,
  ],
})
export class AppModule {}
```

**File**: `apps/backend/src/engage/engage.module.ts`

```typescript
@Module({
  imports: [DatabaseModule, PostsModule],  // PostsModule provides PostService for reply creation
  controllers: [EngageController],
  providers: [
    EngageService,
    EngageRepository,
    EngageScannerService,
    EngageDraftService,
    EngageIntentClassifierService,
  ],
  exports: [EngageService],
})
export class EngageModule {}
```

---

## 5. Temporal Workflows

### 5.1 Scan Ticker + Cursor-Driven Units

**Purpose**: Discover X and Reddit posts matching org keywords. A single global
ticker scans only the units whose cadence is due, incrementally (never re-fetching
already-seen posts), and fans the results out to every enabled org.

**Files**:
- `apps/orchestrator/src/workflows/engage-scan-ticker.workflow.ts` — the ticker
- `apps/orchestrator/src/activities/engage-scan.activity.ts` — `runDueScans`
- `libraries/nestjs-libraries/src/engage/scan/` — platform adapters + token pool

**Workflow** — one global instance (`workflowId: engage-scan-ticker`):

```typescript
export async function engageScanTickerWorkflow(tickMinutes = 5): Promise<void> {
  let force = false;
  setHandler(triggerScanNowSignal, () => { force = true; });
  await condition(() => force, tickMinutes * 60 * 1000); // sleep one tick, or wake on signal
  const runForce = force; force = false;
  try { await runDueScans(runForce); } catch (err) { log.error('runDueScans failed', { err }); }
  await continueAsNew(tickMinutes);
}
```

- Ticks every `ENGAGE_SCAN_TICK_MINUTES` (default 5). `triggerScanNow` forces an
  immediate scan of all units (the user-facing "Scan Now") — bypasses the cadence
  gate, NOT the rate-limit cooldown.
- Replaces the three retired fixed-interval workflows
  (`engage-keyword/channel/tracked-global`), which `_ensureGlobalWorkflowsRunning`
  terminates on boot. `retry: { maximumAttempts: 1 }` — hit-count increments are
  non-idempotent, so the next tick recovers on transient failure rather than retrying.

**Scan units**. `runDueScans(force)` builds every unit and scans the due ones:

| scanType | unit (`scanKey`) | query |
|---|---|---|
| keyword | one per platform (`__global__`) | OR-batched keywords across all orgs |
| channel | one per monitored subreddit | OR-batched keywords, `restrict_sr` |
| tracked | one per unique X username | `from:username (OR-batched keywords)` |

All scans are keyword-driven (the union of every org's enabled keywords is
OR-batched into the query). Each unit owns a row in **`EngageScanCursor`** (§3)
holding its incremental position + scheduling state — org-independent, since the
same keyword/subreddit/account is fetched once and fanned out.

**Keyword initial scans**. The global keyword cursor is intentionally shared, so
it is only correct while the keyword set is stable. When a user adds or
re-enables a keyword, recent posts for that keyword may already be behind the
shared `reddit/keyword/__global__` cursor and would otherwise never be revisited.
To close that gap, keyword writes create or reset an **`EngageKeywordInitialScan`**
row per supported platform. At the beginning of each ticker activity,
`runDueScans`:

1. lazily creates missing initial-scan rows for enabled keywords (upgrade safety);
2. reads Settings keys under `engage.keyword_initial_scan.*`;
3. processes enabled platforms in priority order (`reddit`, then `x` today);
4. claims up to `<platform>.max_units` pending rows per platform;
5. runs one OR-batched catch-up query for the claimed keywords (`reddit` uses a
   bounded lookback cursor; `x` uses an empty `since_id` cursor against recent search);
6. fans the results out to the claimed orgs through the same scoring and
   persistence path as normal scans; and
7. marks the row `DONE` only when the adapter exhausted the page/batch backlog,
   otherwise leaves it retryable as `FAILED`.

Initial scans do **not** advance or reset `EngageScanCursor`. After the catch-up
is complete, the keyword participates in the normal shared global cursor for
future posts. The initial-scan table is kept separate from `EngageScanCursor`
because it has one-shot job semantics (`DONE`/`FAILED`, attempts, error, stale
RUNNING lease recovery), while `EngageScanCursor` represents ongoing incremental
position and cadence.

If an adapter hits `<platform>.max_calls` before exhausting all pages/batches, it
returns `backlogRemaining=true`. The activity still persists and fans out the
posts already fetched, but it must not mark the initial-scan rows `DONE`. The
rows remain retryable under `retry_ms`/`max_attempts`, preventing a partial
catch-up from permanently hiding older posts in the lookback/recent-search
window.

Initial scan settings are stored in the Settings table and read on every
`runDueScans` activity. Env vars are fallback/bootstrap defaults only, so tuning
platform budgets does not require an orchestrator restart.

| Settings key | Default | Purpose |
|---|---:|---|
| `engage.keyword_initial_scan.enabled_platforms` | `["reddit","x"]` | Platforms with active initial-scan execution |
| `engage.keyword_initial_scan.lookback_hours` | `24` | Recent-history window for time-based platforms |
| `engage.keyword_initial_scan.max_attempts` | `3` | Attempts before a row remains `FAILED` |
| `engage.keyword_initial_scan.retry_ms` | `900000` | Retry delay for failed rows |
| `engage.keyword_initial_scan.stale_ms` | `1800000` | RUNNING lease timeout for worker-crash recovery |
| `engage.keyword_initial_scan.reddit.max_units` | `10` | Reddit rows claimed and OR-batched per activity |
| `engage.keyword_initial_scan.reddit.max_calls` | `2` | Reddit upstream call budget per initial-scan batch |
| `engage.keyword_initial_scan.x.max_units` | `5` | X rows claimed and OR-batched per activity |
| `engage.keyword_initial_scan.x.max_calls` | `1` | X upstream call budget per initial-scan batch |

Future platform budgets follow `engage.keyword_initial_scan.<platform>.max_units`
and `engage.keyword_initial_scan.<platform>.max_calls`.

Settings key names are case-sensitive by convention and must be lowercase:
`engage.keyword_initial_scan.reddit.max_units`, not
`engage.keyword_initial_scan.REDDIT.max_units`. Platform values in
`enabled_platforms` are normalized to lowercase by the scanner, but should be
written lowercase (`["reddit", "x"]`) for consistency. Env fallback variables
remain uppercase.

Concrete Settings examples:

```json
{
  "engage.keyword_initial_scan.enabled_platforms": ["reddit", "x"],
  "engage.keyword_initial_scan.reddit.max_units": 10,
  "engage.keyword_initial_scan.reddit.max_calls": 2,
  "engage.keyword_initial_scan.x.max_units": 5,
  "engage.keyword_initial_scan.x.max_calls": 1
}
```

**Per-unit lifecycle** (`_scanUnit` → `_claimCursor`):

1. Upsert the cursor row; skip unless **due** — not `SCANNING`, not cooling down,
   and (unless `force`) `lastScanStartedAt + cadence(scanType) ≤ now`.
2. Atomically claim it (`IDLE→SCANNING`, stamp `lastScanStartedAt`) — single-flight
   via a conditional `updateMany`.
3. Acquire a token from the platform `TokenPool` and call the adapter.
4. On success with no backlog → advance the cursor
   (`lastSeenExternalId`/`lastSeenAt`), `lastScannedAt = now`, clear cooldown. On
   rate-limit → set `cooldownUntil` and **do not advance** (retry from the same
   point next tick). On call-budget exhaustion with adapter-reported backlog →
   release the lock and **do not advance**. On error → release the lock, leave the
   cursor untouched.

Cadence is **per unit**, derived from the owning orgs' plan `scan_interval_hours`
(see §5.2), not a fixed per-type env value. `_scanUnit` receives an explicit
`cadenceMs`; `_claimCursor` skips a unit until `lastScanStartedAt + cadenceMs` has
elapsed. A frequent tick + per-unit cooldown means a rate-limited unit recovers on
the next tick after its cooldown — independent of the (longer) base cadence.

**Platform adapters** (`PlatformScanAdapter.searchScoped`) own all fetch mechanics;
the activity stays platform-agnostic:

- **X** (`x-scan-adapter.ts`): `/2/tweets/search/recent` with `since_id` +
  `next_token` pagination; `from:username` for the tracked scope; drops
  reply-restricted tweets; parses `x-rate-limit-*` headers. A pure **retweet** is
  resolved to its **original** post (via the `referenced_tweets.id` expansion,
  returned inline — no extra call): the opportunity gets the original's
  id/author/text/metrics/reply_settings, so it's a real repliable target by the
  original author (dropped if the original is deleted/protected). Quotes and
  replies are kept as-is. The cursor still advances by the top-level result id,
  not the older original's. Tracked scope adds `-is:retweet` (the account's own
  posts only).
- **Reddit** (`reddit-scan-adapter.ts`): no `since_id`, so TIME-based — `sort=new`
  + `after` paging, stop when `created_utc ≤ lastSeenAt`; `restrict_sr` for the
  channel scope; OAuth path first, then the public loid/proxy fallback.
- **TokenPool** (`token-pool.ts`): LRU rotation across all connected X integration
  tokens (+ optional `X_BEARER_TOKEN`); parks a token on rate-limit.

After all due units are scanned, posts are deduped and fanned out to every org:
`scorePost` (per-org keyword/tracked scoring) → intent classify (§6.2) → two-phase
persist (§3.1) → keyword hit counts → expire stale → `lastScanAt`.

> Tracked-account posts are no longer a separate workflow — they are the `tracked`
> scan units above. The `isFromTrackedAccount` +5 bonus is applied **per-org during
> fan-out** (an org gets the bonus only if IT tracks that author), so it lives on
> `EngageOpportunityState`, never the shared global row.

**Observability**: `EngageRepository.getOrgScanStatus(orgId, scanIntervalHours)`
derives per-org last/next scan time (overall + per type) from the cursor rows
(`next = max(lastScanStartedAt + cadence, cooldownUntil)` — derived, never stored),
using the org's own plan interval as the cadence. Exposed via `GET /engage/config`
→ `scanStatus` and shown in the Signal Feed header.

---

### 5.2 Per-Plan Scan Cadence (interval grouping)

The plan entitlement `scan_interval_hours` (Starter/Developer 24h, Pro 6h; default
24h — see §15) controls how often a unit is scanned. Scans stay **global and
unit-based** (one shared cursor per `(platform, scanType, scanKey)`); we do not
schedule per org. Instead each unit's **effective cadence = the MIN
`scan_interval_hours` across every org that contributes it** — "whoever scans most
often wins". Shared data is always safe to refresh sooner, so an org riding on a
unit kept fresh by a higher tier simply benefits.

The interval is a **single value per org**, applied uniformly to keyword, channel,
and tracked units (it replaced the old per-type env cadences of 24/3/3h). At the
top of `runDueScans`, `_orgIntervalHours(orgContexts)` resolves each enabled org's
interval once (cached in `EngageEntitlementService`, 5-min TTL); a missing
entitlement service or billing-off falls back to `DEFAULT_SCAN_INTERVAL_HOURS` (24).

Grouping differs by the unit's natural granularity:

| Unit | Granularity | Grouping | Effective cadence |
| --- | --- | --- | --- |
| **keyword** | one union firehose | **bucketed by interval** — `scanKey = __global__:<hours>` | the bucket's hours |
| **channel** | per-subreddit | already per-key | `min` over orgs monitoring that subreddit |
| **tracked** | per-username | already per-key | `min` over orgs tracking that username |

- **channel / tracked** are already per-key units (independent cursors), so we just
  take the `min` interval per key: `minMerge(map, channelId|username, hoursOf(org))`,
  then scan each at `hoursToMs(min)`.
- **keyword** is the hard case: the firehose scans the **union** of all keywords in
  one query (a single `__global__` cursor historically). Taking a single global min
  would drag *every* keyword to 6h the moment one Pro org exists — wasting API
  budget. So keywords are **partitioned into interval buckets**: each keyword's
  bucket = the `min` interval across the orgs that enabled it; each bucket is scanned
  as its own unit keyed `__global__:<hours>` (× `{x, reddit}`) with its own cursor.
  - A keyword lands in exactly **one** bucket → buckets are disjoint, no double-scan.
  - `ai` shared by Pro(6h) + Starter(24h) → 6h bucket (Starter benefits).
  - `ml` Starter-only → 24h bucket, **not** dragged onto the 6h cadence ← the budget
    saving the bucketing exists for.

`getOrgScanStatus` queries keyword cursors by `scanKey startsWith '__global__:'` to
cover all buckets.

> **Upgrade note (legacy cursor).** Before bucketing, the keyword firehose used a
> single bare `__global__` cursor. After upgrade that row matches neither the new
> writer (emits `__global__:<hours>`) nor the reader (`startsWith '__global__:'`),
> so it is orphaned: each bucket starts from a null cursor and re-scans once over
> the recent, `SCAN_MAX_CALLS`-bounded window (X has no `since_id`; upserts dedup
> on `platform_externalPostId`, so no full-history storm), and keyword timing
> self-corrects on the next due tick. This is intentional and self-healing. To
> preserve the old incremental position instead, run a one-off
> `UPDATE "EngageScanCursor" SET "scanKey"='__global__:24' WHERE "scanType"='keyword' AND "scanKey"='__global__'`.

Implementation: `engage-scan.activity.ts` (`_orgIntervalHours`,
`_scanKeywordUnits` bucketing, `_scanChannelUnits`/`_scanTrackedUnits` per-key min,
`_scanUnit`/`_claimCursor` take `cadenceMs`). Tests: `engage-scan-interval.spec.ts`.

---

### 5.3 Engage DataTicks Workflow (daily aggregation)

**Purpose**: Aggregate Engage reply metrics into `EngageDataTicks` for time-series charts and trend analysis. Mirrors what `dataTicksSyncWorkflow` does for regular posts.

**File**: `apps/orchestrator/src/workflows/engage-data-ticks.workflow.ts`

**Schedule**: Daily at UTC 01:00 (after `dataTicksSyncWorkflow` at 00:05 so Post.impressions/trafficScore are already fresh; the scan ticker runs continuously so opportunities are already populated).

**Registration**: Registered as a single **global singleton** workflow via `libraries/nestjs-libraries/src/temporal/infinite.workflow.register.ts` — one instance handles ALL organizations in one pass per day — like the scan ticker, a single global workflow rather than per-org fan-out.

```typescript
// Workflow signature: no args — global singleton aggregates every org in one pass.
export async function engageDataTicksWorkflow(): Promise<void> {
  const yesterday = startOfDay(subDays(new Date(), 1));

  // Aggregate Post WHERE source='engage' AND publishDate IN yesterday bucket,
  // grouped by (organizationId, platform).
  const posts = await fetchEngagePublishedPosts(yesterday);

  // First group by org, then by platform within each org.
  const byOrgPlatform: Record<string, Record<string, { count: number; impressions: number; traffic: number }>> = {};
  for (const post of posts) {
    const orgId = post.organizationId;
    const p = post.integration?.providerIdentifier ?? 'reddit';  // reddit has no integration
    byOrgPlatform[orgId] ??= {};
    byOrgPlatform[orgId][p] ??= { count: 0, impressions: 0, traffic: 0 };
    byOrgPlatform[orgId][p].count       += 1;
    byOrgPlatform[orgId][p].impressions += post.impressions ?? 0;
    byOrgPlatform[orgId][p].traffic     += post.trafficScore ?? 0;
  }

  // Upsert per-org × per-platform rows + cross-platform "all" row per org.
  for (const [orgId, byPlatform] of Object.entries(byOrgPlatform)) {
    const platforms = [...Object.keys(byPlatform), 'all'];
    for (const platform of platforms) {
      const agg = platform === 'all'
        ? Object.values(byPlatform).reduce((a, b) => ({
            count: a.count + b.count,
            impressions: a.impressions + b.impressions,
            traffic: a.traffic + b.traffic,
          }), { count: 0, impressions: 0, traffic: 0 })
        : byPlatform[platform] ?? { count: 0, impressions: 0, traffic: 0 };

      for (const [type, val] of [
        ['replies',     agg.count      ],
        ['impressions', agg.impressions],
        ['traffic',     agg.traffic    ],
      ] as const) {
        await prisma.engageDataTicks.upsert({
          where: { organizationId_platform_type_timeUnit_statisticsTime: {
            organizationId: orgId, platform, type, timeUnit: 'day', statisticsTime: yesterday,
          }},
          create:  { organizationId: orgId, platform, type, timeUnit: 'day', statisticsTime: yesterday, value: val },
          update:  { value: val },
        });
      }
    }
  }
}
```

---

### 5.4 Engage Metrics Sync Workflow (simplified)

**Purpose**: Handles the things the global analytics job cannot do for Engage replies:
1. **`authorReplied` detection** — check if the original post author replied to our reply
2. **X metrics** — fetch the reply tweet's `public_metrics` and write `Post.{impressions, trafficScore, analytics}`
3. **Reddit metrics** — poll Reddit comment URL → write to `Post.analytics` (Reddit replies have a Post but were created manually, not via provider workflow)

> **Why X metrics are driven here.** Engage posts (`source='engage'`) are intentionally **excluded** from the global analytics job (`dashboard.repository.ts#getPublishedPostsWithRelease` filters `source NOT IN ('engage')`), so they are NOT picked up automatically. The Engage sync therefore calls `PostsService.checkPostAnalytics(orgId, postId, date)` itself — the *same* code path regular posts use. It refreshes the integration's OAuth token, calls `x.provider.postAnalytics` (reads `public_metrics` incl. `impression_count` + `bookmark_count`), computes `trafficScore` via `traffic.calculator.ts` (the `x` weights equal the spec's `X_traffic_index`), and writes `Post.{impressions, trafficScore, analytics}` back. The app-only `X_BEARER_TOKEN` is used only for `authorReplied` detection (conversation search).

> **Metric fields & the token fallback chain.** `x.provider.postAnalytics` emits all six metrics unconditionally — `Impressions`, `Likes`, `Retweets`, `Replies`, `Quotes`, `Bookmarks` — so no downstream field is ever missing; a metric the API omits defaults to `0` purely as a presence guard (never an estimate; `impression_count` is API-fetched, not computed). **`impression_count` and `bookmark_count` are part of `public_metrics` and are returned by ANY valid token — they are NOT owner-only** (verified empirically: an app-only bearer returns both). So the real cause of a blank engage reply is almost always a **dead integration token** (expired + refresh failed → `refreshNeeded=true`), where `checkPostAnalytics` returns `[]` before reading anything.
>
> To survive that, the engage sync uses a token fallback chain (`EngageService._checkEngageXAnalytics`, wired into the `checkPostAnalytics` dep — the shared `PostsService.checkPostAnalytics` is unchanged for regular posts):
> 1. **own integration token** — used only when the attached integration is healthy (`!refreshNeeded && !disabled && !deletedAt`); a dead one is skipped so we don't burn a doomed refresh.
> 2. **app-only fallback** — `PostsService.checkPostAnalyticsAppOnly` → `x.provider.postAnalyticsAppOnly`, which mints an app-only bearer at runtime from `X_API_KEY`/`X_API_SECRET` (`appLogin`, client_credentials) and reads `public_metrics` with **no user token at all**. Returns the **full** metric set (impression + bookmark included), works even when the org has zero live X accounts.
>
> Both paths append `Traffic` (`traffic.calculator.ts`, the `x` weights equal the spec's `X_traffic_index`) and write `Post.{impressions, trafficScore, analytics}` back. **History protection:** the write-back only persists `impressions` when `> 0`, so a transient/partial `0` read never clobbers a real value from an earlier sync. The app-only path shares the app's API tier quota and the global `x:tweets:rate-limit-reset` short-circuit. The app-only `X_BEARER_TOKEN` env (if set) is preferred over `appLogin`; it is also used for `authorReplied` detection (conversation search).

**File**: `apps/orchestrator/src/workflows/engage-metrics-sync.workflow.ts`

```typescript
export async function engageMetricsSyncWorkflow(sentReplyId: string): Promise<void> {
  await sleep('24 hours');

  const reply = await fetchSentReply(sentReplyId);  // includes reply.post (Post record)
  if (!reply) return;

  if (reply.opportunity.platform === 'x') {
    // 1) Fetch X reply metrics via the integration's OAuth token (engage posts
    //    are excluded from the global analytics job, so drive it explicitly).
    //    checkPostAnalytics writes Post.{impressions, trafficScore, analytics}.
    await postsService.checkPostAnalytics(reply.organizationId, reply.postId, Date.now());
    // 2) authorReplied detection via app-only bearer (conversation search).
    const replied = await checkXAuthorReplied(reply.post.releaseURL, reply.opportunity.externalPostId);
    if (replied) await markAuthorReplied(sentReplyId);

  } else if (reply.post.releaseURL) {
    // Reddit / manual-flow: Post.releaseURL = comment URL submitted by user.
    // No provider.postAnalytics for engage Reddit comments, so fetch + write directly.
    const commentId = extractCommentIdFromUrl(reply.post.releaseURL);
    const raw = await fetchRedditCommentMetrics(commentId);
    const analyticsData: AnalyticsData[] = [
      { label: 'score',    data: [{ total: String(raw.score),        date: todayISO() }], percentageChange: 0 },
      { label: 'comments', data: [{ total: String(raw.num_comments), date: todayISO() }], percentageChange: 0 },
    ];
    await updatePostMetrics(reply.postId, {
      analytics:    analyticsData,
      impressions:  Math.round((raw.score + raw.num_comments) * 20),  // Reddit has no public impressions; estimate ×20
      trafficScore: raw.score * 1 + raw.num_comments * 3,             // Reddit_traffic_index (set explicitly; no provider path)
    });
    const replied = await checkRedditAuthorReplied(commentId, reply.opportunity.authorUsername);
    if (replied) await markAuthorReplied(sentReplyId);
  }
}
```

**Reddit Metrics Fetch**:
```
GET https://www.reddit.com/api/info.json?id=t1_{comment_id}
Response: { data: { children: [{ data: { score, num_comments } }] } }
```

### 5.5 Workflow Registration

**File**: `apps/orchestrator/src/app.module.ts` (or equivalent workflow registration)

```typescript
// Scan: a single nestjs-temporal-core @Activity() class (EngageScanActivity)
// registered as a provider in apps/orchestrator/src/app.module.ts. Its
// @ActivityMethod runDueScans drives keyword + channel + tracked units in one
// pass (see §5.1). The engageScanTickerWorkflow that calls it is auto-discovered
// from workflows/index.ts. (Replaces the retired per-type scan/tracked workflows.)
//   EngageScanActivity.runDueScans → adapters(X/Reddit) → score → classify →
//     persist (two-phase) → keyword hit counts → expire stale → lastScanAt

// DataTicks aggregation activities (daily)
const engageDataTicksActivities = createActivities([
  fetchEngagePublishedPosts,
  upsertEngageDataTick,
]);

// Metrics sync activities (24h after reply sent)
// X impressions/trafficScore: engage drives PostsService.checkPostAnalytics itself
//   (engage posts are excluded from the global analytics job, source != 'engage')
// Reddit: fetch comment metrics + write {analytics, impressions, trafficScore} to Post
const engageMetricsActivities = createActivities([
  fetchRedditCommentMetrics,
  updatePostAnalytics,          // writes AnalyticsData[] to Post.analytics
  checkXAuthorReplied,
  checkRedditAuthorReplied,
  markAuthorReplied,
]);
```

---

## 6. Claude API Integration

### 6.1 Draft Generation Service

**File**: `libraries/nestjs-libraries/src/engage/engage-draft.service.ts`

```typescript
@Injectable()
export class EngageDraftService {
  private readonly anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

  async *generateDraft(
    opportunity: EngageOpportunity,
    strategy: string,
    brandStrength: number,
    mentions?: string[],
    signal?: AbortSignal,
    outputLength?: number  // target reply length; defaults per platform
  ): AsyncGenerator<string> {
    const systemPrompt = this.buildSystemPrompt(opportunity.platform, strategy, opportunity.primaryIntent, brandStrength);
    const userPrompt = this.buildUserPrompt(opportunity);

    const stream = await this.anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 400,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      stream: true,
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield event.delta.text;
      }
    }
  }

  private buildSystemPrompt(
    platform: string,
    strategy: string,
    primaryIntent: string,
    brandStrength: number
  ): string {
    // X aims for 260 Twitter-weighted chars; Reddit aims for `outputLength` (default 1000).
    // These are generation TARGETS — the hard rejection cap is enforced after generation:
    // X retries once then throws; Reddit accepts up to max(outputLength, 2000), throws above.
    const charLimit = platform === 'x' ? 'under 260 Twitter-weighted characters' : `under ${outputLength ?? 1000} characters`;
    const strategyInstruction = STRATEGY_PROMPTS[strategy];
    const brandInstruction = BRAND_PROMPTS[brandStrength];
    // Fallback to 'discussion' prompt if an unknown/future intent tag is passed
    const intentInstruction = INTENT_PROMPTS[primaryIntent] ?? INTENT_PROMPTS['discussion'];

    return `You are a social media engagement expert writing a reply on ${platform}.
${strategyInstruction}
${brandInstruction}
${intentInstruction}
Platform constraint: Keep the reply ${charLimit}.
Be direct, natural, and valuable. Do not start with "Great post!" or similar openers.`;
  }

  private buildUserPrompt(opportunity: EngageOpportunity): string {
    return `Original post by @${opportunity.authorUsername}:
---
${opportunity.postContent}
---
Write a reply to this post.`;
  }
}

// Keyed by string strategy name — add new strategies here without schema migration.
// Mirrors the INTENT_PROMPTS pattern: no enum dependency.
const STRATEGY_PROMPTS: Record<string, string> = {
  EXPERT_ANSWER: 'Give expert step-by-step advice. Share actionable frameworks. Be specific and concrete.',
  DATA_BACKED:   'Keep the reply conversational. When relevant, support one point with an observation or metric from the original post; never invent statistics.',
  EMPATHY_LED:   'Acknowledge the frustration or situation first, then pivot to a concrete insight.',
};

const BRAND_PROMPTS: Record<number, string> = {
  0: 'Do not mention AISEE or any brand name. Provide pure value.',
  1: 'Share insights and data naturally. Build authority without naming any brand.',
  2: 'When highly relevant, naturally mention AISEE as an example or tool.',
  3: 'Proactively introduce AISEE and invite the person to try it.',
};

// Keyed by string tag — add new intents here without touching schema or migrations.
const INTENT_PROMPTS: Record<string, string> = {
  help_seeking: 'The person is asking for help. Give them a direct, usable answer.',
  rant:         'The person is frustrated. Acknowledge that first, then offer a concrete insight.',
  discussion:   'This is an open discussion. Engage with an interesting question or perspective.',
  opinion:      'The person shared an opinion. Extend or add nuance to their point.',
  comparison:   'The person is comparing options. Provide neutral, balanced analysis.',
  data_share:   'The person shared data. Expand with related data or implications.',
};
```

### 6.2 Intent Classifier (Local Model)

**File**: `libraries/nestjs-libraries/src/engage/engage-intent-classifier.service.ts`

#### Model Selection

| Scenario | Model | Size | Speed/Item | Notes |
|---|---|---|---|---|
| v1.0 (English X/Reddit) | `Xenova/nli-deberta-v3-small` | **44 MB** | ~80ms | Primary choice |
| v1.x (Incl. Chinese QQ/WeChat) | `Xenova/mDeBERTa-v3-base-mnli-xnli` | 278 MB | ~150ms | Multilingual |

The model is downloaded once during `onModuleInit` and cached locally. All subsequent classifications are performed offline, with no API costs or rate limits.

#### Intent Labels (String Constants, not Enums)

```typescript
// libraries/nestjs-libraries/src/engage/engage-intent.constants.ts

export const INTENT_LABELS = [
  'help_seeking',  // help_seeking: contains ? + how/help/anyone
  'rant',          // rant: frustrated/hate/tired of/so annoying
  'discussion',    // discussion: open-ended statement + thoughts?/what do you think
  'opinion',       // opinion: I think/hot take/unpopular opinion
  'comparison',    // comparison: vs/compare/better than/alternative
  'data_share',    // data_share: numbers/% + found/report/study
] as const;

export type IntentLabel = typeof INTENT_LABELS[number];

// primaryIntent → Default recommended reply strategy
export const INTENT_DEFAULT_STRATEGY: Record<IntentLabel, string> = {
  help_seeking: 'EXPERT_ANSWER',
  rant:         'EMPATHY_LED',
  discussion:   'EXPERT_ANSWER',
  opinion:      'DATA_BACKED',
  comparison:   'DATA_BACKED',
  data_share:   'DATA_BACKED',
};
```

#### Classification Service

```typescript
import { pipeline, ZeroShotClassificationPipeline } from '@xenova/transformers';
import { INTENT_LABELS } from './engage-intent.constants';

@Injectable()
export class EngageIntentClassifierService implements OnModuleInit {
  private classifier: ZeroShotClassificationPipeline;

  async onModuleInit() {
    // Downloads on first boot, cached in ~/.cache/huggingface/
    this.classifier = await pipeline(
      'zero-shot-classification',
      'Xenova/nli-deberta-v3-small',
    );
  }

  async classify(text: string): Promise<{
    intentTags: string[];
    primaryIntent: string;
    intentScore: number;
  }> {
    const result = await this.classifier(
      text.slice(0, 512),        // truncate to model max length
      [...INTENT_LABELS],
      { multi_label: true },     // scores are independent per label
    );

    // All labels with confidence > 0.4 become tags
    const intentTags = (result.labels as string[]).filter(
      (_, i) => (result.scores as number[])[i] > 0.4,
    );
    const primaryIntent  = result.labels[0] as string;  // highest score first
    const intentScore    = result.scores[0] as number;

    return {
      intentTags: intentTags.length > 0 ? intentTags : [primaryIntent],
      primaryIntent,
      intentScore,
    };
  }

  // Used by the Temporal scan workflow — batch with concurrency control
  async classifyBatch(
    posts: Array<{ id: string; content: string }>,
    concurrency = 4,
  ) {
    const results: Record<string, Awaited<ReturnType<typeof this.classify>>> = {};
    for (let i = 0; i < posts.length; i += concurrency) {
      const batch = posts.slice(i, i + concurrency);
      const classified = await Promise.all(
        batch.map(p => this.classify(p.content).then(r => ({ id: p.id, ...r }))),
      );
      for (const item of classified) results[item.id] = item;
    }
    return results;
  }
}
```

#### Confidence Fallback to Claude Haiku

Low-confidence posts (primaryIntent confidence < 0.45) automatically fallback to Claude Haiku to ensure classification quality. Expected trigger rate < 15%, keeping overall costs extremely low.

```typescript
async classifyWithFallback(text: string) {
  const local = await this.classify(text);
  if (local.intentScore >= 0.45) return local;

  // Fallback: Claude Haiku structured output
  return this.claudeFallbackClassify(text);
}

private async claudeFallbackClassify(text: string) {
  const msg = await this.anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 128,
    tools: [{
      name: 'set_intent',
      input_schema: {
        type: 'object',
        properties: {
          intentTags:    { type: 'array', items: { type: 'string' } },
          primaryIntent: { type: 'string' },
          intentScore:   { type: 'number' },
        },
        required: ['intentTags', 'primaryIntent', 'intentScore'],
      },
    }],
    tool_choice: { type: 'tool', name: 'set_intent' },
    messages: [{
      role: 'user',
      content: `Classify this post's intent. Labels: ${INTENT_LABELS.join(', ')}.\n\n"${text.slice(0, 400)}"`,
    }],
  });
  const input = (msg.content[0] as any).input;
  return { intentTags: input.intentTags, primaryIntent: input.primaryIntent, intentScore: input.intentScore };
}
```

#### Temporal Activity

```typescript
// In engage-scan.activity.ts:
async function classifyIntentsBatch(scored: ScoredPost[]): Promise<ScoredPost[]> {
  const results = await intentClassifier.classifyBatch(
    scored.map(p => ({ id: p.id, content: p.postContent })),
  );
  return scored.map(p => ({
    ...p,
    intentTags:    results[p.id]?.intentTags    ?? ['discussion'],
    primaryIntent: results[p.id]?.primaryIntent ?? 'discussion',
    intentScore:   results[p.id]?.intentScore   ?? 0,
  }));
}
```

#### Dependency Installation

```bash
pnpm add @xenova/transformers --filter @postiz/nestjs-libraries
```

Model files are automatically downloaded (44 MB) during the first `onModuleInit`, stored in `~/.cache/huggingface/`. For Docker deployments, use volume mounting to reuse the cache.

### 6.3 Streaming API Endpoint

The `generateDraft` controller method uses SSE (Server-Sent Events):

```typescript
@Post('/opportunities/:id/draft')
async generateDraft(
  @GetOrgFromRequest() org: Organization,
  @Param('id') id: string,
  @Body() body: GenerateDraftDto,
  @Res() res: Response
) {
  const opportunity = await this._engageService.getOpportunity(org.id, id);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');

  for await (const chunk of this._engageDraftService.generateDraft(
    opportunity,
    body.strategy,
    body.brandStrength,
    body.mentions,
    abortController.signal,
    body.outputLength
  )) {
    res.write(`data: ${JSON.stringify({ text: chunk })}\n\n`);
  }
  res.write(`data: [DONE]\n\n`);
  res.end();
}
```

---

## 7. X API and Browser-Assisted X Replies

### 7.1 Sending a Reply via Post Pipeline

Engage does **not** call X API directly. It creates a `Post` with `source='engage'` and the existing `postWorkflowV101` handles publishing via `XProvider`.

#### Critical: Post.settings must include `__type`

`postWorkflowV101` determines which Temporal Task Queue to route to via:
```typescript
getSocialTaskQueue(post.settings.__type)  // e.g. '__type: "x"' → x task queue
```

If `__type` is missing, the workflow **silently fails to route**. When EngageController calls `PostService.createPost()`, the settings payload must include `__type`:

```typescript
// EngageController — when creating a reply Post for X:
const postPayload = {
  source: 'engage',
  type: 'now',  // or 'schedule'
  date: new Date().toISOString(),
  shortLink: false,
  posts: [{
    integration: { id: replyAccount.integrationId },
    value: [{ content: draftContent }],
    settings: {
      __type: 'x',                        // REQUIRED — workflow routing depends on this
      reply_to_tweet_id: opportunity.externalPostId,  // NEW field
      who_can_reply_post: 'everyone',
    },
  }],
};
```

#### Existing files to modify

**File 1**: `libraries/nestjs-libraries/src/dtos/posts/providers-settings/x.dto.ts`

```typescript
export class XDto {
  // ... existing fields ...

  @IsOptional()
  @IsString()
  reply_to_tweet_id?: string;  // NEW: external tweet ID to reply to (Engage only)
}
```

**File 2**: `apps/orchestrator/src/workflows/post-workflows/post.workflow.v1.0.1.ts`

```typescript
// In postSocial() activity — read reply_to_tweet_id from settings and pass to XProvider:
const xSettings = JSON.parse(post.settings ?? '{}');
if (xSettings.reply_to_tweet_id) {
  postDetails[0].settings = {
    ...postDetails[0].settings,
    reply: { in_reply_to_tweet_id: xSettings.reply_to_tweet_id },
  };
}
```

**File 3**: `libraries/nestjs-libraries/src/dtos/posts/create.post.dto.ts`

The valid `Post.source` values live in a single shared constant
`libraries/nestjs-libraries/src/dtos/posts/post-source.ts`:

```typescript
// post-source.ts — single source of truth
export const VALID_POST_SOURCES = ['calendar', 'chat', 'engage'] as const;
export type PostSource = (typeof VALID_POST_SOURCES)[number];
```

```typescript
// create.post.dto.ts
@IsOptional()
@IsIn(VALID_POST_SOURCES as unknown as string[])
source?: PostSource;
```

### 7.1.1 Browser-Assisted Reply Fallback

Some X API access tiers reject replies to other users' posts even when the user can reply manually in the browser. Engage therefore supports a browser-assisted fallback that uses the user's local Postiz browser extension session instead of storing platform cookies or attempting server-side browser automation.

Phase 1 is intentionally semi-automated:

1. The Reply Panel sends a `postiz:extension-task` window message with `{ platform: 'x', type: 'reply', externalPostUrl, draftContent }`.
2. The extension content script running on the Postiz frontend stores the pending task in `chrome.storage.local` and opens the X post URL in a normal browser tab.
3. The extension content script running on X reads the pending task, opens the reply composer when needed, and inserts the draft into X's contenteditable composer.
4. The user performs the final platform action by clicking X's Reply button.
5. Engage status and metrics tracking continue to use the existing manual-reply flow: the user records the reply URL through `/engage/opportunities/:id/manual-reply` or the Sent page URL backfill UI.

Non-goals for this phase:

- No server-side platform cookie collection.
- No hidden automatic final-submit click.
- No database task queue or new Engage state transition.
- No replacement of the existing X API send/schedule path.

This design keeps the first release compatible with the existing Engage state model while removing the most repetitive manual steps. A later phase can add a durable browser task queue and automatic release URL capture once the extension behavior is stable across X DOM changes.

### 7.2 Keyword Search

Uses user-context OAuth 2.0 token from an enabled `EngageXReplyAccount` → `Integration`.
No separate app-level bearer token needed; X API v2 search/recent supports user OAuth 2.0.

```typescript
async searchXByKeyword(keyword: string, oauthToken: string): Promise<Tweet[]> {
  const client = new TwitterApi(oauthToken);  // user OAuth 2.0, not app bearer
  const result = await client.v2.search(keyword, {
    max_results: 50,
    'tweet.fields': ['public_metrics', 'author_id', 'created_at', 'text'],
    'user.fields': ['public_metrics', 'name', 'username'],
    expansions: ['author_id'],
  });
  return result.data.data ?? [];
}
```

### 7.3 Rate Limit Strategy

- X Basic tier: 500,000 tweets/month read, 50 req/15min for search
- Scan job: max 20 keyword queries per org per run, with 1s delay between calls
- Use `X-Rate-Limit-Remaining` header to back off dynamically

---

## 8. Reddit API Integration

### 8.1 Post Search

Reddit's public JSON API requires no auth for read operations:

```typescript
async searchRedditPosts(channelId: string, keyword: string): Promise<RedditPost[]> {
  // channelId = subreddit name (e.g. "SEO" for r/SEO), from EngageMonitoredChannel.channelId
  const url = `https://www.reddit.com/r/${channelId}/search.json?q=${encodeURIComponent(keyword)}&sort=new&t=day&limit=25`;
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'AISEE-Engage/1.0' }
  });
  const json = await resp.json();
  return json.data?.children?.map((c: any) => c.data) ?? [];
}
```

### 8.2 Comment Metrics Fetch

```typescript
async fetchRedditCommentMetrics(commentId: string): Promise<{ score: number; numComments: number }> {
  const url = `https://www.reddit.com/api/info.json?id=t1_${commentId}`;
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'AISEE-Engage/1.0' }
  });
  const json = await resp.json();
  const data = json.data?.children?.[0]?.data;
  return { score: data?.score ?? 0, numComments: data?.num_comments ?? 0 };
}
```

### 8.3 Rate Limits

- Reddit public API: 60 requests/minute
- Scan job: max 10 community × keyword combos per batch (per platform), with 500ms delay between requests
- No OAuth required for read-only operations

---

## 9. Scoring Engine

**File**: `libraries/nestjs-libraries/src/engage/engage-scorer.ts`

### Scoring Dimension Descriptions

| Dimension | Field | Max | Stored on | Notes |
|---|---|---|---|---|
| Keyword Quality | `scoreKeyword` | 35 | `EngageOpportunityState` (per-org) | Each hit +15, capped at 35 (关键词质量) |
| Platform Heat | `scoreHeat` | 45 | `EngageOpportunity` (global) | Per-platform formula, 4 branches (see below) (平台热度) |
| Account Authority | `scoreAuthority` | 15 | `EngageOpportunity` (global) | Post author's real follower count, all platforms (Reddit = u/&lt;name&gt; profile subscribers); thresholds 50k/10k/1k (账号影响力) |
| Recency | `scoreRecency` | 5 | `EngageOpportunity` (global) | within 24h → 5; else → 0 (时效性) |
| Tracked Source | `scoreTracked` | 5 | `EngageOpportunityState` (per-org) | +5 if author is in this org's `EngageTrackedAccount` (X) OR post is in one of this org's `EngageMonitoredChannel` subreddits (Reddit) (重点账户/频道) |

**Score ownership (two-table split):** the OBJECTIVE dimensions (heat / authority / recency) are identical for every org, so they live on the global `EngageOpportunity` row — including authority, which is now the post author's own follower count (an objective, org-independent fact). The SUBJECTIVE dimensions (keyword / tracked) depend on the org's own keyword set, tracked accounts, and monitored subreddits, so they — plus the total `score` (= keyword + tracked + heat + authority + recency, max 105) — live on the per-org `EngageOpportunityState`. "Is this subreddit in *my* monitored list" is inherently per-org, which is why the Reddit +5 belongs to `scoreTracked`, not authority. The total is recomputed each scan; the feed reads it directly.

**Platform Heat branches** (`scoreHeat`, all 0–45, bucketed):

| Branch | Platforms | Formula |
|---|---|---|
| text | x / threads / mastodon / bluesky | `likes×1 + replies×3 + retweets×2 + quotes×2 + shares×2` |
| video | youtube / tiktok | `views×0.005 + likes×2 + comments×5 + shares×3` |
| network | linkedin / instagram / pinterest | `views×0.05 + likes×3 + comments×8 + shares×5 + saves×4` |
| community | reddit / fallback | `max(score,0)×upvoteRatio + comments×2` |


```typescript
// ── Types ────────────────────────────────────────────────────────────────

interface ScoreBreakdown {
  total:     number;  // sum of all dimensions, 0-105
  keyword:   number;  // 0-35 (关键词质量)
  heat:      number;  // 0-45 (平台热度)
  authority: number;  // 0-15 (账号影响力)
  recency:   number;  // 0 or 5: within 24h→5, else→0 (时效性)
  tracked:   number;  // 0 or 5 (重点账户)
  // Extensible: future dimensions added here without schema migration.
  // Not indexed — display / offline analysis only.
  extra?: Record<string, number>;
}

interface ScoredPost extends RawPost {
  score:          number;
  scoreKeyword:   number;
  scoreHeat:      number;
  scoreAuthority: number;
  scoreRecency:   number;
  scoreTracked:   number;
  intentTags:     string[];
  primaryIntent:  string;
}

// ── Main entry point ─────────────────────────────────────────────────────

export function scorePost(post: RawPost, keywords: EngageKeyword[]): ScoredPost | null {
  // Layer 1: keyword hard filter — must hit at least one enabled keyword
  const hits = keywords.filter(k => k.enabled && postMatchesKeyword(post.content, k.keyword));
  if (hits.length === 0) return null;

  const bd = computeBreakdown(post, hits);

  // Intent classification runs as a separate batch step after this (see §6.2).
  return {
    ...post,
    score:          bd.total,
    scoreKeyword:   bd.keyword,
    scoreHeat:      bd.heat,
    scoreAuthority: bd.authority,
    scoreRecency:   bd.recency,
    scoreTracked:   bd.tracked,
    intentTags:     [],
    primaryIntent:  'discussion',
  };
}

// ── Breakdown computation ─────────────────────────────────────────────────

function computeBreakdown(post: RawPost, hits: EngageKeyword[]): ScoreBreakdown {
  const keyword   = computeKeywordScore(hits);                     // 0-35
  const heat      = post.platform === 'x'                          // 0-45
    ? computeXHeatScore(post)
    : computeCommunityHeatScore(post);
  const authority = computeAuthorAuthorityScore(post.authorFollowers); // 0-15, post author's real followers (all platforms)
  const recency  = isWithin24Hours(post.publishedAt) ? 5 : 0;     // 0|5
  // +5 when the post is from a tracked source: an X tracked account, OR a Reddit
  // post in one of the org's monitored subreddits (flag set during fan-out).
  const tracked  = post.isFromTrackedAccount ? 5 : 0;             // 0|5

  return {
    keyword, heat, authority, recency, tracked,
    total: keyword + heat + authority + recency + tracked,
  };
}

// ── Dimension scorers ─────────────────────────────────────────────────────

function computeKeywordScore(hits: EngageKeyword[]): number {
  // Each hit: BRAND > COMPETITOR > CORE weighting; base +15 per hit, capped at 35
  const base = Math.min(hits.length * 15, 35);
  const hasBrand      = hits.some(k => k.type === 'BRAND');
  const hasCompetitor = hits.some(k => k.type === 'COMPETITOR');
  return Math.min(base + (hasBrand ? 5 : 0) + (hasCompetitor ? 3 : 0), 35);
}

function computeXHeatScore(post: RawPost): number {
  // x_heat = likes×1 + replies×3 + retweets×2 + quotes×2
  const heat = post.metricLikes * 1 + post.metricReplies * 3
             + post.metricRetweets * 2 + post.metricQuotes * 2;
  if (heat > 2000) return 45;
  if (heat > 1000) return 33;
  if (heat >  300) return 23;
  if (heat >   80) return 12;
  return 4;
}

function computeCommunityHeatScore(post: RawPost): number {
  // reddit_heat = score × upvoteRatio + comments × 2  (also used for other community platforms)
  const heat = (post.metricScore ?? 0) * (post.metricUpvoteRatio ?? 1)
             + (post.metricComments ?? 0) * 2;
  if (heat > 800) return 45;
  if (heat > 400) return 33;
  if (heat > 100) return 23;
  if (heat >  30) return 12;
  return 4;
}

function computeAuthorAuthorityScore(followers: number | null): number {
  // Post author's real follower count — all platforms. X uses public_metrics
  // followers; Reddit uses the author's u/<name> profile subscribers (fetched
  // per-author during scan, cached). Most redditors have ~0 → floor of 2.
  if (!followers) return 2;
  if (followers > 50_000) return 15;
  if (followers > 10_000) return 11;
  if (followers >  1_000) return  6;
  return 2;
}
```

> **Note (authority vs. community size):** earlier revisions scored Reddit authority
> from the *subreddit's* member count (`audienceSize`). That was dropped: authority is
> the **author's** influence, and "this subreddit matters to me" is now the per-org
> `scoreTracked` +5 (monitored subreddit). `EngageMonitoredChannel.audienceSize` is
> retained for display only and no longer feeds scoring.

---

## 10. Frontend

### 10.1 New Routes

```
apps/frontend/src/app/(app)/(site)/
├── engage/
│   ├── page.tsx              → Signal Feed (default)
│   ├── sent/
│   │   └── page.tsx          → Sent History
│   ├── settings/
│   │   └── page.tsx          → Keywords & Accounts
│   └── layout.tsx            → Engage layout with tab nav
```

### 10.2 Navigation Addition

**File**: `apps/frontend/src/components/layout/top.menu.tsx`

Add to `firstMenu` array (after Analytics):

```typescript
{
  name: 'Engage',
  icon: <EngageIcon />,
  path: '/engage',
  requireBilling: false,  // adjust if Engage is Pro-only
},
```

### 10.3 Component Structure

```
apps/frontend/src/components/engage/
├── signal-feed/
│   ├── opportunity-card.tsx      → Post card with score badge
│   ├── feed-filters.tsx          → Platform/score/intent filters
│   └── reply-panel.tsx           → Right-side drawer with draft generation
├── sent/
│   ├── sent-list.tsx             → Reply history list
│   ├── sent-card-x.tsx           → X metrics (5 cells)
│   └── sent-card-reddit.tsx      → Reddit metrics (3 cells)
├── settings/
│   ├── keyword-manager.tsx          → Keyword list + add/edit
│   ├── monitored-channel-manager.tsx  → Channel/community grid (r/SEO, YT channel, QQ群, ...)
│   ├── tracked-accounts.tsx         → Tracked Accounts: EXTERNAL accounts we monitor (EngageTrackedAccount)
│   └── reply-accounts.tsx           → Reply Accounts: OUR OWN X accounts (Integration + EngageXReplyAccount)
├── setup-wizard/
│   └── setup-wizard.tsx          → One-time config (Page 01)
└── dashboard/
    ├── engage-performance-panel.tsx
    └── traffic-from-engage-panel.tsx
```

### 10.4 Reply Panel — Account Selector Logic

The Reply Panel's account dropdown shows the user's **own** X accounts that have `engageEnabled=true` in their `EngageXReplyAccount` record:

```typescript
// Fetch reply accounts: Integration records with their EngageXReplyAccount settings
const replyAccounts = await fetch('/api/engage/reply-accounts');
// Returns: [{ integrationId, displayName, username, avatarUrl, autoReplyEnabled, ... }]

// Dropdown only shows engageEnabled=true accounts
const options = replyAccounts.filter(a => a.engageEnabled);
```

These are **NOT** the `EngageTrackedAccount` (external accounts). Never mix the two in UI state.

### 10.5 Reply Panel — Streaming Draft

```typescript
async function generateDraft(
  opportunityId: string,
  strategy: string,
  brandStrength: number,
  mentions?: string[],
  outputLength?: number  // optional target reply length
) {
  setDraft('');
  setGenerating(true);
  
  const resp = await fetch(`/api/engage/opportunities/${opportunityId}/draft`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ strategy, brandStrength, mentions, outputLength }),
  });

  const reader = resp.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value);
    const lines = buffer.split('\n\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6);
      if (data === '[DONE]') break;
      const { text } = JSON.parse(data);
      setDraft(prev => prev + text);
    }
  }
  setGenerating(false);
}
```

### 10.6 Reply Panel — Browser-Assisted X Reply

For X opportunities, the manual backfill block exposes an extension-assisted action when the user has a draft:

```typescript
window.postMessage({
  source: 'postiz',
  action: 'postiz:extension-task',
  task: {
    platform: 'x',
    type: 'reply',
    opportunityId,
    externalPostUrl,
    draftContent,
  },
}, window.location.origin);
```

The frontend treats this as a best-effort local automation request. If no extension handles the message, the existing Copy Draft + Open on X controls remain the fallback. The extension must validate the message origin and task shape before storing it.

---

## 11. Dashboard & Calendar Integration

### Data Isolation Principle

```
Standard Publishing Stats (Post.source='calendar'|'chat')
  └── DataTicks Aggregation → Dashboard Impressions/Traffic Charts
         ↑
         DataTicks sync filters source != 'engage'; Engage data does NOT enter this pipeline.

Engage Reply Stats (Post.source='engage')
  └── Direct Query on Post → Engage Performance Panel (Independent panel, doesn't affect standard stats)
```

**Two account systems are completely isolated** and do not interfere:
- Existing Dashboard charts (Impressions, Traffic) only reflect standard publishing performance.
- The Engage panel only reflects reply performance.
- The lime-colored overlay bar on the "Your Posts" chart is a **visual overlay** and does not alter the underlying data.

### DataTicks Isolation (Required Modification)

**File**: `libraries/nestjs-libraries/src/database/prisma/data-ticks/data-ticks.service.ts`

`getPublishedPostsWithRelease()` must include a source filter to prevent Engage replies from polluting DataTicks:

```typescript
// dashboard.repository.ts — getPublishedPostsWithRelease() add condition:
WHERE state = 'PUBLISHED'
  AND releaseId IS NOT NULL
  AND (source IS NULL OR source NOT IN ('engage'))  // ← NEW: Exclude Engage replies
```

### 11.1 Dashboard — Three Endpoints (as implemented)

**File**: `apps/backend/src/api/routes/engage.controller.ts`. All three read directly from `Post` (`source='engage'`), bypassing DataTicks. Full request/response contracts live in [`api.md`](./api.md#dashboard-stats--dashboard-statistics); summarised here:

**① `GET /api/engage/dashboard/summary?platform=x|reddit`** — Engagement Performance panel
```typescript
{
  repliesCount:       number,        // Replies — all-time SENT (PUBLISHED), scoped by platform if provided
  responseRate:      number,        // Reply rate — authorReplied / total × 100, scoped by platform if provided
  totalImpressions:  number,        // Total impressions — selected platform or combined
  totalTrafficScore: number,        // Traffic — selected platform or combined, rounded
  totalLikes:        number,        // Total likes/upvotes — X likes + Reddit score in combined view
  xImpressions:      number,        // Legacy helper: X-only impressions
  xTrafficIndex:     number,        // Legacy helper: X-only traffic index
  platformSplit: { x: number; reddit: number },  // 平台拆分 — reply counts THIS WEEK
  bestReply: {                      // 本周最佳回复 (most likes), or null
    opportunityId: string; platform: string; content: string;
    likes: number;                  // X like_count / Reddit score (from Post.analytics)
    url: string | null;             // Post.releaseURL → falls back to original post URL
  } | null,
}
```
Omit `platform` for the combined X + Reddit view. Pass `platform=x` or `platform=reddit` when the UI chip is selected; the headline cards and `bestReply` are then scoped to that platform. Reddit labels should render `totalLikes` as total upvotes.

**② `GET /api/engage/dashboard/replies-trend?days=30`** — "Your Posts" overlay
```typescript
{
  days: number,
  items: Array<{ date: string; count: number; x: number; reddit: number }>,  // zero-filled, incl. today
}
```
Buckets keyed by `Post.publishDate` (UTC `YYYY-MM-DD`). Computed directly from sent replies (not `EngageDataTicks`) so today's count is included.

**③ `GET /api/engage/dashboard/traffics?platform=x&limit=10`** — "Traffic from Engage"
```typescript
{
  totalClicks: number,              // SUM(Post.trafficScore) (filtered by platform if given), rounded
  items: Array<{                    // top-N replies by trafficScore, desc
    opportunityId: string; platform: string; content: string;
    clicks: number;                 // Post.trafficScore (rounded)
    time: string | null;            // Post.publishDate
    url: string | null;             // Post.releaseURL → falls back to original post URL
  }>,
}
```

**Frontend** (`apps/frontend/src/app/(app)/(site)/dashboard/page.tsx`):
- `<EngagePerformancePanel>` ← `/dashboard/summary` (independent panel, doesn't affect existing data).
- "Your Posts" chart lime overlay bar ← `/dashboard/replies-trend` (per-day reply counts, includes today).
- "Traffic from Engage" panel ← `/dashboard/traffics` (total + per-reply progress bars).

> The daily `EngageDataTicks` aggregate (`type='replies'|'impressions'|'traffic'`, `timeUnit='day'`) remains the long-horizon trend store, but the live dashboard endpoints query `Post` directly so they include same-day activity.

**Comparison: EngageDataTicks vs. DataTicks**:

| | DataTicks (Existing) | EngageDataTicks (New) |
|---|---|---|
| Granularity | per-integration (per social account) | per-platform (x/reddit/all) |
| type | impressions / traffic | replies / impressions / traffic |
| Update | `dataTicksSyncWorkflow` UTC 00:05 | `engageDataTicksWorkflow` UTC 01:00 |
| Purpose | Standard post trend charts | Engage reply trend charts |
| Cache | Redis `dashboard:impressions:${orgId}` | Redis `engage:ticks:${orgId}` |

### 11.2 Calendar Integration

**No new model, no new API.** The existing `GET /posts` calendar endpoint
(`PostsRepository.getPosts` / `GetPostsDto`) gained a `source` query-param
filter — the Engage Calendar and Upcoming Replies panels reuse it via
`GET /posts?source=engage`.

`source` accepts a single value (`?source=engage`) **or** a comma-separated
list (`?source=calendar,chat`); omitting it returns **all** sources. Values are
validated against `VALID_POST_SOURCES` (`@IsIn(..., { each: true })`), so an
unknown value yields `400`. The DTO normalises both forms to `PostSource[]` with
the same comma-splitting `@Transform` used by `channel` / `integrationId`:

```typescript
// get.posts.dto.ts
@IsOptional()
@IsArray()
@ArrayMaxSize(VALID_POST_SOURCES.length)
@IsString({ each: true })
@IsIn(VALID_POST_SOURCES as unknown as string[], { each: true })
@Transform(({ value }) =>
  (Array.isArray(value) ? value : [value]).flatMap((v) =>
    v.includes(',') ? v.split(',') : [v]
  )
)
source?: PostSource[];
```

```typescript
// posts.repository.ts — getPosts where-clause
...(query.source?.length ? { source: { in: query.source } } : {}),
```

> Examples: `?source=engage` (Engage panels) · `?source=calendar,chat`
> (standard posts only, exclude Engage) · _omitted_ (everything).

**Color mapping** (in calendar event renderer, keyed on `post.source` + `post.state`):

| Condition | Background | Border | Prefix |
|---|---|---|---|
| `source='engage'` AND `state=PUBLISHED` | `#FFF4D0` | `#D0A040` | 💬 |
| `source='engage'` AND `state=QUEUE` | `#F0E8FF` | `#A070D0` | 📅 |
| `source='engage'` AND `state=ERROR` | `#FFE4E4` | `#D04040` | ⚠️ |

**Toolbar additions** (minimal changes to existing calendar UI):
- "Show Engage" toggle → controls the `showEngage` flag in the query.
- Banner "Engage" counter: `COUNT Post WHERE source='engage' AND publishDate IN this month`.

---

## 12. Security Considerations

### 12.1 OAuth Token Scoping

- X API calls use the *user's own* connected integration token — never a shared platform token.
- Engage never reads DMs or private data; scopes limited to `tweet.read`, `tweet.write`, `users.read`.
- Reddit API calls are read-only (no OAuth needed); only the user manually posts on Reddit.

### 12.2 Rate Limit Protection

- Scan workflow: max 50 API calls per org per run; configurable backoff on 429.
- Draft generation: rate-limited to 20 generations/user/hour via existing throttle guard.
- X send: wrapped with existing `handleErrors` → `'retry' | 'bad-body' | 'refresh-token'` classification.

### 12.3 Organization Isolation

All per-org Engage data is scoped to `organizationId`. Config, keywords, channels, tracked accounts, `EngageOpportunityState`, and `EngageSentReply` are org-scoped, and every repository query filters by `organizationId`; existing `@CheckPolicies()` guards enforce this at the controller layer.

The `EngageOpportunity` row itself is GLOBAL (a shared public post — content + objective metrics, no `organizationId`), but an org can only see or mutate it **through its own `EngageOpportunityState`**: the feed inner-joins state→opportunity, and dismiss/bookmark/reply operate on the state row keyed by `[organizationId, opportunityId]`. So no org can read another org's status/bookmark/score or reply to a post on another org's behalf — isolation holds at the state/reply layer even though the post body is shared.

### 12.4 Input Validation

- Reddit comment URL validated via regex: `^https?://www\.reddit\.com/r/[^/]+/comments/[^/]+/[^/]*/[a-z0-9]+/?$`
- AI draft content stored as-is; no execution or further processing.
- Keyword max length: 100 chars; max 50 keywords per org.

---

## 13. Migration Plan

### 13.1 Schema Sync (db push, not migrate)

The project provisions schema with **`prisma db push`**, not `prisma migrate` — the
historical `migrations/*.sql` files are NOT applied (see startup-checklist §"Database").
Apply schema + the trigram index in one step:

```bash
pnpm run prisma-db-push   # db push  →  then chains prisma-db-indexes (engage-indexes.sql)
```

`prisma-db-indexes` runs `engage-indexes.sql` (`CREATE EXTENSION pg_trgm` + the
`postContent` GIN index) because `db push` cannot create a `gin_trgm_ops` index.

> The Engage data model is the two-table split (§3.1): global `EngageOpportunity`
> + per-org `EngageOpportunityState`. A single global post is shared across orgs.

### 13.2 Temporal Workflow Registration

A single global scan-ticker workflow (`engage-scan-ticker`) registered in the
orchestrator; `EngageService.onApplicationBootstrap` starts it with
`workflowIdConflictPolicy: USE_EXISTING` and terminates the three retired per-type
workflows (`engage-keyword/channel/tracked-global`). Per-type cadence + per-unit
rate-limit cooldown are enforced inside the activity (§5.1), so the ticker just wakes
every `ENGAGE_SCAN_TICK_MINUTES` (default 5). Activity-code changes are picked up on
worker restart (activities are re-invoked, not replayed), so no non-determinism risk.

### 13.3 Feature Flag (Optional)

If gradual rollout is desired, gate behind `org.features.engage` flag. Set to `true` for beta orgs, then roll out broadly.

---

## 14. Testing Strategy

### 14.1 Unit Tests

| Component | Tests |
|---|---|
| `engage-scorer.ts` | Per-dimension breakdown correctness; total = sum of parts; edge cases: null followers, zero metrics, tracked bonus |
| `engage-intent-classifier.service.ts` | Multi-label output; confidence threshold; fallback trigger; unknown intent graceful fallback |
| `engage-draft.service.ts` | System prompt per strategy/intent/brand; unknown intent falls back to `discussion` prompt |
| `engageMetricsSyncWorkflow` | Metric field mapping; X vs Reddit path selection |

### 14.2 Integration Tests

| Scenario | Test |
|---|---|
| Config save → opportunities scan → reply send → metrics sync | Full E2E workflow test with mocked external APIs |
| Keyword filter: case-insensitive, hashtag extraction, phrase matching | Unit + integration |
| X OAuth 1.0a vs 2.0 reply send | Mock both token formats |
| Reddit URL validation and parsing | Regex tests + URL parse tests |

### 14.3 Manual Verification Checklist

- [ ] Setup wizard completes and redirects to Signal Feed
- [ ] Signal Feed shows scored cards with correct color grades
- [ ] Reply Panel opens, draft generates with typewriter effect
- [ ] X send: actual tweet created via API test account
- [ ] Reddit flow: copy draft → manual reply → URL submission
- [ ] Sent page: metrics cells populate after 24h sync
- [ ] Dashboard: Engage Performance panel shows correct weekly stats
- [ ] Calendar: Engage events appear in amber/purple, toggle hides them
- [ ] Dismiss: card removed from feed; persisted in DB as dismissed

---

## 15. Subscription Entitlements & Credits

Engage is gated by the user's subscription plan. **Plans live in `aisee-core`**
(codes `starter` / `developer` / `pro`; monthly credits 1000 / 4000 / 10000) and
carry **no** engage-specific limits — those are defined on the Postiz side and the
backend enforces them (the frontend disables entrypoints for UX but can be bypassed,
so every check is server-side).

### 15.1 Limit configuration (Settings, admin-tunable, no redeploy)

Engage limits live in the global `Settings` table as JSON (same pattern as
`post_send_overage_cost` / `ai_model_pricing`), seeded on boot via
`EngageEntitlementService.onModuleInit` and editable through `/admin/settings`:

- **`engage_entitlements`** — plan code → limits. `null` = unlimited.

  | Field | Starter | Developer | Pro |
  | --- | --- | --- | --- |
  | `keywordsMax` | 3 | 10 | 30 |
  | `priorityAccountsMax` | 0 | 10 | `null` |
  | `subredditsMax` | 1 | 5 | 15 |
  | `scanIntervalHours` | 24 | 24 | 6 |
  | `replyMonthlyCap` | 10 | `null` | `null` |

- **`engage_reply_credits`** — `{ base, multipliers: { short, medium, long } }`.
  `cost = round(base × multiplier)`. Defaults: base 2, ×1.0/1.5/2.5 → **2 / 3 / 5**.

### 15.2 Plan resolution

`EngageEntitlementService` resolves the org's plan via
`UsersService.getUserLimits()` (which calls aisee `/user-credit-package/uid/{userId}`)
and maps the returned display `name` ("Pro Plan (Monthly)", …) to a code with
`normalizePlanName` (substring match). Rules:

- billing disabled (`getUserLimits → null`, self-hosted) → **unlimited** entitlement;
- unrecognised plan name → fall back to **`starter`** (most restrictive — over-block
  an anomaly rather than grant Pro for free);
- resolution is cached per org (5-min TTL) to bound aisee round-trips (the scan tick
  resolves every enabled org).

### 15.3 Hard limit enforcement

`EngageService` calls the asserts before mutating:

- `assertCanActivate(org, type, count)` on add (keyword / keyword-bulk / subreddit /
  tracked) — counts currently **enabled** rows; throws `ForbiddenException`
  (`code: engage_limit_reached`) when `current + count > max`. Starter tracked = 0 ⇒
  always blocked.
- `assertCanEnable(org, type, id)` on the enable toggle — enforces only on a
  disabled → enabled transition (re-enabling / unknown id is a no-op, never
  double-counts).
- `scanIntervalHours` is **not** accepted from the client; it drives scan cadence
  (§5.2).

### 15.4 Reply-draft credits (the only charging action)

Generating a reply draft is the sole credit-charging action (regenerate counts as a
new charge; scan / browse / filter / track / history / manual send never charge).
Fixed cost by length, deducted through the shared Aisee pipeline
(`AiseeCreditService.deductAndConfirm`, `businessType = engage_reply`).

`GenerateDraftDto.length` (`short` | `medium` | `long`, default `medium`) drives both
the cost and the generation target. The SSE endpoint `POST /opportunities/:id/draft`:

1. **Pre-flight (before any model call)** — `assertCanGenerateReply(org, length)`
   checks: monthly cap not reached (Starter hard-stops at 10 even with credits — an
   upgrade hook, no overflow), then balance ≥ cost. On block it emits an SSE error
   frame (`engage_reply_cap_reached` / `engage_insufficient_credits`) and **does not
   generate**.
2. **Charge on success** — after a complete, non-aborted, within-limit draft, deduct
   the fixed cost (best-effort: a billing hiccup must not fail an already-produced
   draft). Failure / timeout / abort → **no charge**.

**Monthly-cap counter** = count of `BillingRecord` rows with `businessType =
engage_reply` since the billing `periodStart` (each generation, incl. regenerate, is
one row; failures write no row, so they don't count). When no period is known, the
window is the start of the calendar month (UTC).

### 15.5 Read API for the frontend

The frontend needs the resolved limits + live usage to disable entrypoints and show
usage. `EngageEntitlementService.getEntitlementSummary(orgId)` returns
`{ plan, limits, usage: { keywords, trackedAccounts, subreddits, repliesThisPeriod }, replyCredits: { short, medium, long } }`,
embedded under `entitlement` in the **`GET /engage/config`** response (the keyword
manager and signal feed already fetch `/engage/config`, so they get it for free; to
refresh usage after generating a reply, revalidate that same key — no separate
endpoint). Server-side asserts remain the source of truth — this is UX only.

Implementation: `engage-entitlement.service.ts`, wired in `engage.service.ts` /
`engage.controller.ts`. Tests: `engage-entitlement.service.spec.ts`.

---

## 16. Open Questions

| Question | Owner | Deadline |
|---|---|---|
| X API cost model: user-provided key vs platform-paid? | Product | Before v1.0 dev starts |
| Reddit: use official OAuth API for future post automation (v2)? | Engineering | v1.2 planning |
| Auto-reply daily volume limit to prevent spam perception? | Product | Before auto-reply feature |
| Opportunity TTL: how long to keep dismissed/replied records? | Engineering | v1.0 dev |
| Claude API model: use claude-sonnet-4-5 or update to newer model? | Engineering | Before dev |
| Intent classifier: switch to `mDeBERTa` (278MB) when QQ/WeChat support ships? | Engineering | v1.x planning |
| Docker cache strategy for 44MB model file — bake into image or mount volume? | DevOps | Before deploy |
