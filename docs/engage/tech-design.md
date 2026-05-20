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
3. Two new Temporal workflows for async discovery and metrics sync
4. Five new frontend routes under `/engage`
5. Non-breaking additions to Dashboard and Calendar

### 1.3 Critical Distinction: Two Account Systems

Engage involves two completely separate "account" concepts. Confusing them is a major implementation risk.

```
┌─────────────────────────────────────────────────────────────────────────┐
│  回复账号 (Reply Account)          追踪账号 (Tracked Account)              │
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
│  Engage models:    │         │  engage-scan.workflow (daily 00:30)     │
│  Config/Keyword/   │         │    └─ score → classifyIntents           │
│  Channel/Tracked/  │         │         └─ persistOpportunities         │
│  Opportunity       │         │  postWorkflowV101 (existing, reused)    │
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

  @@unique([configId, keyword])               // prevent duplicate keywords per org
  @@index([organizationId])
  @@index([configId, enabled])
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
  audienceSize          Int       @default(0)  // members/subscribers — used in authority scoring
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

// Discovered engagement opportunity (scored post from X or Reddit)
model EngageOpportunity {
  id                    String    @id @default(uuid())
  organizationId        String
  organization          Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  platform              String    // "x" | "reddit" | "youtube" | ...
  externalPostId        String    // platform-native ID (tweet_id, reddit post id, YT video id, etc.)
  externalPostUrl       String
  channelId             String?   // platform community: subreddit name, YT channel ID, etc. (null for X)
  channelName           String?   // display name: "r/SEO", "Channel Title", etc.
  authorUsername        String
  authorDisplayName     String?
  authorFollowers       Int?      // X followers; for community platforms: audienceSize of the channel
  authorAvatarUrl       String?
  postContent           String
  postPublishedAt       DateTime
  // ── Composite score ──────────────────────────────────────────────────────
  score                 Int       // total 0-100 (sum of all dimensions below)

  // ── Per-dimension score breakdown ────────────────────────────────────────
  // Stored individually to support per-dimension filtering, sorting, and analytics.
  //
  // Dimension      Max   Formula / thresholds
  // scoreKeyword    35   hit core+15; brand > competitor > core weighting
  // scoreHeat       35   X: likes×1+replies×3+retweets×2+quotes×2 → 35/26/18/9/3
  //                      Reddit: score×upvoteRatio+comments×2 → 35/26/18/9/3
  // scoreAuthority  20   X followers >50K/10K/1K/≤1K → 20/15/8/3
  //                      Community audienceSize >1M/100K/10K/≤10K → 20/15/8/3
  // scoreRecency     5   within 24h → 1; else 0  (cap: 5, current: 0 or 1)
  // scoreTracked     5   post author is in EngageTrackedAccount → +5; else 0
  scoreKeyword          Int       @default(0)
  scoreHeat             Int       @default(0)
  scoreAuthority        Int       @default(0)
  scoreRecency          Int       @default(0)
  scoreTracked          Int       @default(0)  // tracked account bonus
  // Future dimensions go here as JSON — no migration needed.
  // DB-level filter/sort not supported; use for display or offline analysis only.
  // e.g. { "sentiment": 8, "replyGap": 6, "languageMatch": 9, "brandMention": 3 }
  scoreBreakdown        Json?

  // ── Intent classification ─────────────────────────────────────────────
  intentTags            String[]  // all matched intents (confidence > 0.4)
  primaryIntent         String    @default("discussion")
  intentScore           Float?    // classifier confidence for primaryIntent (0-1)

  status                EngageOpportunityStatus @default(NEW)
  bookmarked            Boolean   @default(false)

  // ── Raw platform metrics at discovery time (inputs to scoring) ────────
  metricLikes           Int       @default(0)
  metricReplies         Int       @default(0)
  metricRetweets        Int       @default(0)
  metricQuotes          Int       @default(0)
  metricScore           Int       @default(0)  // Reddit score
  metricUpvoteRatio     Float?                  // Reddit
  metricComments        Int       @default(0)  // Reddit num_comments

  createdAt             DateTime  @default(now())
  updatedAt             DateTime  @updatedAt
  deletedAt             DateTime?

  sentReply             EngageSentReply?

  // ── Deduplication constraint ─────────────────────────────────────────────
  // CRITICAL: prevents the same post from being inserted twice across daily scans.
  @@unique([organizationId, platform, externalPostId])

  // ── Base indexes ──────────────────────────────────────────────────────────
  @@index([organizationId])
  @@index([organizationId, status])
  @@index([organizationId, platform])
  @@index([createdAt])
  @@index([deletedAt])
  // ── Per-dimension score indexes — ORDER BY / WHERE on each dimension ──────
  @@index([organizationId, score])
  @@index([organizationId, scoreKeyword])
  @@index([organizationId, scoreHeat])
  @@index([organizationId, scoreAuthority])
  @@index([organizationId, scoreTracked])
  @@index([organizationId, bookmarked])   // support "已保存" Feed filter
  // ── GIN index for intentTags array contains queries ───────────────────────
  // Required for: WHERE intentTags @> ARRAY['help_seeking'] (Prisma: has: 'help_seeking')
  // Without this index, intent filtering causes full table scan.
  @@index([intentTags], type: Gin)
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

  opportunityId  String   @unique  // FK → EngageOpportunity (one reply per opportunity)
  opportunity    EngageOpportunity @relation(fields: [opportunityId], references: [id])

  postId         String   @unique  // FK → Post (source='engage'; created atomically with this record)
  post           Post     @relation(fields: [postId], references: [id], onDelete: Cascade)

  // Engage-specific metadata — everything else is in Post
  strategy       String           // "EXPERT_ANSWER" | "DATA_BACKED" | "EMPATHY_LED" | future
  brandStrength  Int      @default(1)   // 0-3: brand mention level used when generating draft
  authorReplied  Boolean  @default(false) // did the original post author reply to our reply?

  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

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
// Populated by engageDataTicksWorkflow (daily, after engageScanWorkflow).
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
engageConfig          EngageConfig?
engageOpportunities   EngageOpportunity[]
engageSentReplies     EngageSentReply[]
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

// Post.source already exists as String @default("calendar").
// Add 'engage' as a new valid value (no schema migration needed — it's a String).
// Existing values: "calendar" | "chat" | "engage"

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
├── EngageOpportunity[] (1:N)          ← Discovered posts from scan
│   └── EngageSentReply (1:0..1)       ← Engage metadata (strategy, brandStrength, authorReplied)
│       └── Post (1:1) ←──────────────── source='engage'; carries state/metrics/content
├── Post[] (1:N, source='engage')      ← All Engage replies; queried for real-time stats
└── EngageDataTicks[] (1:N)           ← Pre-aggregated time-series (replies/impressions/traffic)

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

  // Reddit manual-flow STEP 1: user clicked "✓ 已手动回复" (confirmed reply, no URL yet)
  // Creates Post(PUBLISHED, no releaseURL) + EngageSentReply immediately.
  // Record appears in Sent with "⚠ 未提交回复链接" warning until URL is submitted.
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

  // Sent page top-4 stats cells (本周发出 / 回复率 / 总曝光量 / 平均获赞)
  @Get('/sent/stats')
  getSentStats(@GetOrgFromRequest() org: Organization) { ... }
  // Returns: SentStatsResult

  // Dashboard stats
  @Get('/dashboard-stats')
  getDashboardStats(@GetOrgFromRequest() org: Organization) { ... }

  // Keywords
  @Post('/keywords')
  addKeyword(@GetOrgFromRequest() org: Organization, @Body() body: AddKeywordDto) { ... }

  @Delete('/keywords/:id')
  deleteKeyword(@GetOrgFromRequest() org: Organization, @Param('id') id: string) { ... }

  @Patch('/keywords/:id')
  updateKeyword(@GetOrgFromRequest() org: Organization, @Param('id') id: string, @Body() body: UpdateKeywordDto) { ... }

  // ── MONITORED CHANNELS (具体频道/社群: r/SEO, YT channel, QQ群, ...) ────────
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

  // ── TRACKED ACCOUNTS (追踪账号): External X accounts we MONITOR ──────────
  // These are NOT the user's own accounts. No OAuth. Just username + settings.
  @Get('/tracked-accounts')
  listTrackedAccounts(@GetOrgFromRequest() org: Organization) { ... }

  @Post('/tracked-accounts')
  addTrackedAccount(@GetOrgFromRequest() org: Organization, @Body() body: AddTrackedAccountDto) { ... }

  @Patch('/tracked-accounts/:id')
  updateTrackedAccount(@GetOrgFromRequest() org: Organization, @Param('id') id: string, @Body() body: UpdateTrackedAccountDto) { ... }

  @Delete('/tracked-accounts/:id')
  removeTrackedAccount(@GetOrgFromRequest() org: Organization, @Param('id') id: string) { ... }

  // ── REPLY ACCOUNTS (回复账号): Our own X accounts from Integration ────────
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
  // ── Basic filters ──────────────────────────────────────────────────────
  platform?: string;    // 'x' | 'reddit' | 'youtube' | ...
  status?: EngageOpportunityStatus;
  intent?: string;      // filter: intentTags contains this value
  date?: 'today' | 'week';

  // ── Per-dimension score filters (min threshold) ────────────────────────
  minScore?:          number;  // total composite score
  minScoreKeyword?:   number;  // keyword quality
  minScoreHeat?:      number;  // platform heat
  minScoreAuthority?: number;  // account influence
  trackedOnly?:       boolean; // only show posts from tracked accounts (scoreTracked > 0)
  bookmarked?:        boolean; // true = only bookmarked; false = only non-bookmarked; omit = all

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

// GET /engage/sent/stats — top-4 cells shown above Sent history list
// Separate from dashboard stats; scoped to all-time (not just this week)
interface SentStatsResult {
  weeklyCount:       number;   // 本周发出: COUNT Post(source='engage') WHERE publishDate >= Mon
  responseRate:      number;   // 回复率: COUNT(authorReplied=true) / total × 100
  totalImpressions:  number;   // 总曝光量: SUM(Post.impressions) WHERE source='engage'
  avgLikes:          number;   // 平均获赞: AVG of X likes + Reddit score from Post.analytics
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

// ── TRACKED ACCOUNTS (追踪账号) DTOs — external accounts ──────────────────
export class AddTrackedAccountDto {
  username: string;      // external X @username (no @ prefix)
  categoryLabel?: string; // e.g. "GEO专家"
}

export class UpdateTrackedAccountDto {
  enabled?: boolean;
  categoryLabel?: string;
}

// ── MONITORED CHANNELS DTOs ───────────────────────────────────────────────
export class AddMonitoredChannelDto {
  platform: string;      // "reddit" | "youtube" | "qq" | "discord" | ...
  channelId: string;     // platform-native ID (subreddit name, YT channel ID, QQ group ID, etc.)
  channelName: string;   // display name ("r/SEO", "Channel Title", "SEO交流群")
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

### 5.1 Daily Scan Workflow

**Purpose**: Fetch X and Reddit posts matching org keywords every 24 hours.

**File**: `apps/orchestrator/src/workflows/engage-scan.workflow.ts`

```typescript
// Temporal workflow definition
export async function engageScanWorkflow(orgId: string): Promise<void> {
  const config = await fetchEngageConfig(orgId);
  if (!config.setupCompleted) return;

  const xOpportunities = await scanXPlatform(orgId, config);
  // scanMonitoredChannels: iterates EngageMonitoredChannel[], dispatches per platform.
  const channelOpportunities = await scanMonitoredChannels(orgId, config);
  // NOTE: tracked account posts are NOT fetched here.
  // They are handled by the separate engageTrackedAccountsWorkflow (every 3h).

  const allRaw = [...xOpportunities, ...channelOpportunities];

  // Step 1: score and filter (intent fields left as placeholder at this stage)
  const scored = allRaw
    .map(post => scorePost(post, config.keywords))
    .filter(p => p.score >= 60);

  // Step 2: batch intent classification via local model (see §6.2)
  const classified = await classifyIntentsBatch(scored);

  // Step 3: upsert opportunities — same post may appear across multiple daily scans
  // (hot posts stay on trending for days). upsert updates scoring metrics without
  // overwriting status/intentTags for opportunities the user has already acted on.
  await persistOpportunities(orgId, classified);
  await updateKeywordHitCounts(orgId, classified);

  // Step 4: expire stale NEW opportunities beyond TTL
  await expireStaleOpportunities(orgId);

  // Step 5: mark scan complete
  await updateLastScanAt(orgId);
}
```

**Schedule**: Registered in orchestrator to run daily at UTC 00:30 per org (staggered to avoid rate limits).

**Activities**:

```typescript
// X scan: search recent tweets matching each keyword.
// Authentication: uses OAuth 2.0 user token from the first enabled EngageXReplyAccount.
// X API v2 /tweets/search/recent supports user-context OAuth 2.0 (180 req/15min).
// No app-level bearer token needed — user token is sufficient for daily scans.
// Rate limit headroom: max 20 keyword queries per org << 180 req/15min limit.
async function scanXPlatform(orgId: string, config: EngageConfig) {
  // Pick any enabled reply account's OAuth 2.0 token for search auth
  const searchAccount = config.xReplyAccounts.find(a => a.engageEnabled);
  if (!searchAccount) return [];  // no enabled X accounts configured

  const oauthToken = await fetchIntegrationToken(searchAccount.integrationId);
  const results = [];

  for (const keyword of config.keywords.filter(k => k.enabled)) {
    // GET https://api.twitter.com/2/tweets/search/recent
    // ?query={keyword}&max_results=50&tweet.fields=public_metrics,author_id,created_at
    const tweets = await xApiSearch(keyword.keyword, oauthToken);
    results.push(...tweets.map(t => mapTweetToOpportunity(t, keyword)));
    await sleep(1000);  // respect rate limits
  }
  return results;
}

// Iterate over each enabled EngageMonitoredChannel, dispatch by platform.
// Adding YouTube/QQ/etc. = add a new case here.
async function scanMonitoredChannels(orgId: string, config: EngageConfig) {
  const results = [];
  const activeChannels = config.monitoredChannels.filter(c => c.enabled);

  for (const channel of activeChannels) {
    switch (channel.platform) {
      case 'reddit':
        for (const keyword of config.keywords.filter(k => k.enabled)) {
          // channelId = subreddit name (e.g. "SEO" for r/SEO)
          const posts = await redditSearch(channel.channelId, keyword.keyword);
          results.push(...posts.map(p => mapRedditToOpportunity(p, keyword, channel)));
          await sleep(500);
        }
        // Update lastScannedAt for incremental scanning on next run
        await updateChannelLastScannedAt(channel.id);
        break;

      case 'youtube':
        // v1.x: search channel videos matching keywords
        // GET https://www.googleapis.com/youtube/v3/search?channelId={channel.channelId}&q={keyword}
        break;

      case 'qq':
        // v1.x: QQ group message scan via Bot API
        break;

      // future: 'discord', 'linkedin', 'hackernews', etc.
    }
  }
  return results;
}

// persistOpportunities uses UPSERT — same post can appear across multiple daily scans.
// On conflict (same org+platform+externalPostId): update scoring metrics only;
// do NOT overwrite status or intentTags (user may have already acted on this opportunity).
async function persistOpportunities(orgId: string, posts: ScoredPost[]) {
  for (const post of posts) {
    await prisma.engageOpportunity.upsert({
      where: { organizationId_platform_externalPostId: {
        organizationId: orgId, platform: post.platform, externalPostId: post.externalPostId,
      }},
      create: { ...post, status: 'NEW' },
      update: {
        // Refresh scoring (post may have gained more engagement since last scan)
        score: post.score,
        scoreKeyword: post.scoreKeyword, scoreHeat: post.scoreHeat,
        scoreAuthority: post.scoreAuthority, scoreRecency: post.scoreRecency,
        scoreTracked: post.scoreTracked, scoreBreakdown: post.scoreBreakdown,
        metricLikes: post.metricLikes, metricReplies: post.metricReplies,
        metricRetweets: post.metricRetweets, metricQuotes: post.metricQuotes,
        metricScore: post.metricScore, metricUpvoteRatio: post.metricUpvoteRatio,
        metricComments: post.metricComments,
        // intentTags/primaryIntent/status intentionally NOT updated — preserve user's state
      },
    });
  }
}

// expireStaleOpportunities: mark old unhandled opportunities as EXPIRED for TTL cleanup.
// Only NEW status is expired (DISMISSED/REPLIED/SCHEDULED are terminal states, keep them).
const OPPORTUNITY_TTL_DAYS = 7; // configurable via env
async function expireStaleOpportunities(orgId: string) {
  await prisma.engageOpportunity.updateMany({
    where: {
      organizationId: orgId,
      status: 'NEW',
      createdAt: { lt: subDays(new Date(), OPPORTUNITY_TTL_DAYS) },
    },
    data: { status: 'EXPIRED' },
  });
}

async function updateLastScanAt(orgId: string) {
  await prisma.engageConfig.update({
    where: { organizationId: orgId },
    data: { lastScanAt: new Date() },
  });
}
```

### 5.2 Tracked Accounts Polling Workflow (every 3h)

**Purpose**: PRD specifies tracked accounts should be checked every 3 hours — much more frequent than the daily scan. Separated to avoid blocking the main scan and to allow independent scheduling.

**File**: `apps/orchestrator/src/workflows/engage-tracked-accounts.workflow.ts`

```typescript
export async function engageTrackedAccountsWorkflow(orgId: string): Promise<void> {
  const config = await fetchEngageConfig(orgId);
  if (!config.setupCompleted) return;

  const results = [];
  for (const account of config.trackedAccounts.filter(a => a.enabled)) {
    // GET /2/users/by/username/{username}/tweets?max_results=10
    // Uses app-level bearer token — no user OAuth required for read
    const tweets = await xFetchUserTweets(account.username, account.lastCheckedAt);
    // isFromTrackedAccount=true → scorer applies +5 bonus
    results.push(...tweets.map(t => mapTweetToOpportunity(t, config.keywords, { ...account, isTrackedAccount: true })));
    await updateTrackedAccountLastChecked(account.id);
  }

  const scored = results
    .map(post => scorePost(post, config.keywords))
    .filter(p => p !== null && p.score >= 60);

  const classified = await classifyIntentsBatch(scored);
  await persistOpportunities(orgId, classified);  // same upsert as daily scan
}
```

**Schedule**: every 3 hours per org, staggered by `orgIndex * 5min` to avoid burst.

---

### 5.3 Engage DataTicks Workflow (daily aggregation)

**Purpose**: Aggregate Engage reply metrics into `EngageDataTicks` for time-series charts and trend analysis. Mirrors what `dataTicksSyncWorkflow` does for regular posts.

**File**: `apps/orchestrator/src/workflows/engage-data-ticks.workflow.ts`

**Schedule**: Daily at UTC 01:00 (after `engageScanWorkflow` at 00:30, and after `dataTicksSyncWorkflow` at 00:05 so Post.impressions/trafficScore are already fresh).

```typescript
export async function engageDataTicksWorkflow(orgId: string): Promise<void> {
  const yesterday = startOfDay(subDays(new Date(), 1));

  // Aggregate Post WHERE source='engage' AND publishDate IN yesterday bucket
  const posts = await fetchEngagePublishedPosts(orgId, yesterday);

  const byPlatform: Record<string, { count: number; impressions: number; traffic: number }> = {};

  for (const post of posts) {
    const p = post.integration?.providerIdentifier ?? 'reddit';  // reddit has no integration
    if (!byPlatform[p]) byPlatform[p] = { count: 0, impressions: 0, traffic: 0 };
    byPlatform[p].count       += 1;
    byPlatform[p].impressions += post.impressions ?? 0;
    byPlatform[p].traffic     += post.trafficScore ?? 0;
  }

  // Upsert per-platform rows + cross-platform "all" row
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
```

---

### 5.4 Engage Metrics Sync Workflow (simplified)

**Purpose**: Handles the two things the existing `postWorkflowV101` cannot do for Engage replies:
1. **`authorReplied` detection** — check if the original post author replied to our reply
2. **Reddit metrics** — poll Reddit comment URL → write to `Post.analytics` (Reddit replies have a Post but were created manually, not via provider workflow)

X metrics (impressions, trafficScore, analytics) are handled by the **existing Post analytics pipeline** — no duplication needed.

**File**: `apps/orchestrator/src/workflows/engage-metrics-sync.workflow.ts`

```typescript
export async function engageMetricsSyncWorkflow(sentReplyId: string): Promise<void> {
  await sleep('24 hours');

  const reply = await fetchSentReply(sentReplyId);  // includes reply.post (Post record)
  if (!reply) return;

  if (reply.post.platform === 'x') {
    // X metrics already handled by existing postWorkflowV101 analytics.
    // Only check authorReplied.
    const replied = await checkXAuthorReplied(reply.post.releaseURL, reply.opportunity.externalPostId);
    if (replied) await markAuthorReplied(sentReplyId);

  } else if (reply.post.releaseURL) {
    // Reddit / manual-flow: Post.releaseURL = comment URL submitted by user.
    // Fetch metrics and write to Post.analytics (existing field).
    const commentId = extractCommentIdFromUrl(reply.post.releaseURL);
    const raw = await fetchRedditCommentMetrics(commentId);
    // Write in AnalyticsData[] format — matches existing Post.analytics schema
    // so the existing traffic.calculator.ts can derive trafficScore consistently.
    // Reddit 'score' maps to impressions in the existing analytics pipeline.
    const analyticsData: AnalyticsData[] = [
      { label: 'score',    data: [{ total: String(raw.score),        date: todayISO() }], percentageChange: 0 },
      { label: 'comments', data: [{ total: String(raw.num_comments), date: todayISO() }], percentageChange: 0 },
    ];
    await updatePostAnalytics(reply.postId, {
      analytics:   analyticsData,
      impressions: Math.round((raw.score + raw.num_comments) * 20),
      // trafficScore computed by traffic.calculator.ts from analyticsData — NOT set manually here
      // This keeps formula consistent with all other platforms (traffic.calculator.ts is the SoT)
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

### 5.3 Workflow Registration

**File**: `apps/orchestrator/src/app.module.ts` (or equivalent workflow registration)

```typescript
// Daily scan activities
const engageScanActivities = createActivities([
  scanXPlatform,
  scanMonitoredChannels,
  classifyIntentsBatch,         // local NLI model; Haiku fallback for low-confidence
  persistOpportunities,         // upsert — safe for repeated scans of same posts
  updateKeywordHitCounts,
  expireStaleOpportunities,     // TTL cleanup: NEW → EXPIRED after N days
  updateLastScanAt,
]);

// Tracked accounts polling activities (every 3h, separate workflow)
const engageTrackedAccountActivities = createActivities([
  xFetchUserTweets,
  updateTrackedAccountLastChecked,
  classifyIntentsBatch,
  persistOpportunities,
]);

// DataTicks aggregation activities (daily)
const engageDataTicksActivities = createActivities([
  fetchEngagePublishedPosts,
  upsertEngageDataTick,
]);

// Metrics sync activities (24h after reply sent)
// X impressions/trafficScore: handled by existing postWorkflowV101 analytics pipeline
// Reddit: fetch comment metrics + write AnalyticsData[] to Post.analytics
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
    brandStrength: number
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
    const charLimit = platform === 'x' ? 'under 280 characters' : 'up to 500 words';
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
  DATA_BACKED:   'Lead with data from scanning 500+ brands. Cite specific numbers and findings.',
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

#### 模型选型

| 场景 | 模型 | 大小 | 速度/条 | 备注 |
|---|---|---|---|---|
| v1.0 (英文 X/Reddit) | `Xenova/nli-deberta-v3-small` | **44 MB** | ~80ms | 首选 |
| v1.x (含中文 QQ/微信) | `Xenova/mDeBERTa-v3-base-mnli-xnli` | 278 MB | ~150ms | 多语言 |

模型在 `onModuleInit` 时下载一次并缓存到本地，之后所有分类均离线完成，无 API 费用、无速率限制。

#### 意图标签（字符串常量，非 enum）

```typescript
// libraries/nestjs-libraries/src/engage/engage-intent.constants.ts

export const INTENT_LABELS = [
  'help_seeking',  // 求助型：含 ? + how/help/anyone
  'rant',          // 吐槽型：frustrated/hate/tired of/so annoying
  'discussion',    // 讨论型：开放性陈述 + thoughts?/what do you think
  'opinion',       // 观点型：I think/hot take/unpopular opinion
  'comparison',    // 比较型：vs/compare/better than/alternative
  'data_share',    // 数据分享：数字/% + found/report/study
] as const;

export type IntentLabel = typeof INTENT_LABELS[number];

// primaryIntent → 默认推荐的回复策略
export const INTENT_DEFAULT_STRATEGY: Record<IntentLabel, string> = {
  help_seeking: 'EXPERT_ANSWER',
  rant:         'EMPATHY_LED',
  discussion:   'EXPERT_ANSWER',
  opinion:      'DATA_BACKED',
  comparison:   'DATA_BACKED',
  data_share:   'DATA_BACKED',
};
```

#### 分类服务

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

低置信度帖子（primaryIntent confidence < 0.45）自动 fallback 到 Claude Haiku，保证分类质量。预计触发率 < 15%，整体成本极低。

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
// In engage-scan.workflow.ts activities:
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

#### 依赖安装

```bash
pnpm add @xenova/transformers --filter @postiz/nestjs-libraries
```

模型文件在首次 `onModuleInit` 时自动下载（44 MB），存入 `~/.cache/huggingface/`，Docker 部署时可通过 volume 挂载复用缓存。

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
    body.brandStrength
  )) {
    res.write(`data: ${JSON.stringify({ text: chunk })}\n\n`);
  }
  res.write(`data: [DONE]\n\n`);
  res.end();
}
```

---

## 7. X API Integration

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

```typescript
@IsOptional()
@IsIn(['calendar', 'chat', 'engage'])  // add 'engage' — currently only 'calendar'|'chat'
source?: 'calendar' | 'chat' | 'engage';
```

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

### 评分维度说明

| 维度 | 字段 | 最大分 | 备注 |
|---|---|---|---|
| 关键词质量 | `scoreKeyword` | 35 | 命中 brand > competitor > core 权重递减 |
| 平台热度 | `scoreHeat` | 35 | X / Reddit 各自公式，见下方 |
| 账号影响力 | `scoreAuthority` | 20 | X 用粉丝数；社区平台用 audienceSize |
| 时效性 | `scoreRecency` | 5 | 24h 内 +1，否则 0（维度上限 5，留扩展空间） |
| 重点账户 | `scoreTracked` | 5 | 作者在 EngageTrackedAccount → +5 |

> **注**：原始需求文档表头写的是「平台热度满分45、账号影响力满分15」，但 Appendix 公式为 `heat_score(0~35) + authority_score(0~20)`，总和才能达到 100。以 Appendix 公式为准。

```typescript
// ── Types ────────────────────────────────────────────────────────────────

interface ScoreBreakdown {
  total:     number;  // sum of all dimensions, 0-100
  keyword:   number;  // 0-35
  heat:      number;  // 0-35
  authority: number;  // 0-20
  recency:   number;  // 0-5 (currently 0 or 1)
  tracked:   number;  // 0 or 5
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
    scoreBreakdown: bd.extra ? bd.extra : undefined,  // future dimensions
    intentTags:     [],
    primaryIntent:  'discussion',
  };
}

// ── Breakdown computation ─────────────────────────────────────────────────

function computeBreakdown(post: RawPost, hits: EngageKeyword[]): ScoreBreakdown {
  const keyword   = computeKeywordScore(hits);                     // 0-35
  const heat      = post.platform === 'x'                          // 0-35
    ? computeXHeatScore(post)
    : computeCommunityHeatScore(post);
  const authority = post.platform === 'x'                          // 0-20
    ? computeXAuthorityScore(post.authorFollowers)
    : computeCommunityAuthorityScore(post.authorFollowers);        // audienceSize for Reddit/YT/etc.
  const recency  = isWithin24Hours(post.publishedAt) ? 1 : 0;     // 0-5 (currently 0|1)
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
  if (heat > 2000) return 35;
  if (heat > 1000) return 26;
  if (heat >  300) return 18;
  if (heat >   80) return  9;
  return 3;
}

function computeCommunityHeatScore(post: RawPost): number {
  // reddit_heat = score × upvoteRatio + comments × 2  (also used for other community platforms)
  const heat = (post.metricScore ?? 0) * (post.metricUpvoteRatio ?? 1)
             + (post.metricComments ?? 0) * 2;
  if (heat > 800) return 35;
  if (heat > 400) return 26;
  if (heat > 100) return 18;
  if (heat >  30) return  9;
  return 3;
}

function computeXAuthorityScore(followers: number | null): number {
  if (!followers) return 3;
  if (followers > 50_000) return 20;
  if (followers > 10_000) return 15;
  if (followers >  1_000) return  8;
  return 3;
}

function computeCommunityAuthorityScore(audienceSize: number | null): number {
  // Used for Reddit subreddits, YouTube channels, QQ groups, etc.
  if (!audienceSize) return 3;
  if (audienceSize > 1_000_000) return 20;
  if (audienceSize >   100_000) return 15;
  if (audienceSize >    10_000) return  8;
  return 3;
}
```

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
│   ├── tracked-accounts.tsx         → 追踪账号: EXTERNAL accounts we monitor (EngageTrackedAccount)
│   └── reply-accounts.tsx           → 回复账号: OUR OWN X accounts (Integration + EngageXReplyAccount)
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
async function generateDraft(opportunityId: string, strategy: string, brandStrength: number) {
  setDraft('');
  setGenerating(true);
  
  const resp = await fetch(`/api/engage/opportunities/${opportunityId}/draft`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ strategy, brandStrength }),
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

---

## 11. Dashboard & Calendar Integration

### 数据隔离原则

```
普通发帖统计 (Post.source='calendar'|'chat')
  └── DataTicks 聚合 → Dashboard 曝光/流量图表
         ↑
         DataTicks sync 过滤 source != 'engage'，Engage 数据不进入此管道

Engage 回帖统计 (Post.source='engage')
  └── 直接查 Post → Engage Performance 面板（独立面板，不影响普通统计）
```

**两套数据完全隔离**，互不干扰：
- Dashboard 现有的曝光量、流量图表只反映普通发帖效果
- Engage 面板只反映回帖效果
- "Your Posts" 图表上的 lime 色叠加柱是**视觉叠加**，不改变原有数据

### DataTicks 隔离（必须修改）

**File**: `libraries/nestjs-libraries/src/database/prisma/data-ticks/data-ticks.service.ts`

`getPublishedPostsWithRelease()` 需加 source 过滤，防止 Engage 回帖污染 DataTicks：

```typescript
// dashboard.repository.ts — getPublishedPostsWithRelease() 加条件：
WHERE state = 'PUBLISHED'
  AND releaseId IS NOT NULL
  AND (source IS NULL OR source NOT IN ('engage'))  // ← 新增：排除 Engage 回帖
```

### 11.1 Dashboard — Engage Performance Panel

**Existing file**: `apps/backend/src/api/routes/dashboard.controller.ts`

```typescript
@Get('/engage-stats')
async getEngageStats(
  @GetOrgFromRequest() org: Organization,
  @Query('days') days = 7
) {
  // 直接查 Post WHERE source='engage'，不经过 DataTicks
  return this._engageService.getDashboardStats(org.id, days);
}
```

**Return shape** — 指标直接读 `Post.impressions` / `Post.trafficScore` / `Post.analytics`：
```typescript
{
  // ① Engage Performance 面板 (4 cells)
  weeklyCount:       number,   // 本周互动条数
  responseRate:      number,   // 响应率: authorReplied=true / total × 100
  totalImpressions:  number,   // X 总曝光: SUM(Post.impressions WHERE platform='x')
  totalTrafficScore: number,   // X 流量指数: SUM(Post.trafficScore WHERE platform='x')
  byPlatform: {
    [platform: string]: { count: number; impressions: number; trafficScore: number }
  },
  bestReply: { platform, content, publishDate, trafficScore }, // 本周最佳回复

  // ③ Traffic from Engage 面板 — per-reply breakdown (progress bars in UI)
  trafficByReply: Array<{
    postId:       string,
    content:      string,      // reply text snippet
    platform:     string,
    publishDate:  string,
    trafficScore: number,      // Post.trafficScore
    impressions:  number,      // Post.impressions
  }>,
  trafficTotal: number,        // SUM(trafficScore) — same as totalTrafficScore above
}
```

**Frontend** (`apps/frontend/src/app/(app)/(site)/dashboard/page.tsx`):
- `<EngagePerformancePanel>` 读 `/dashboard/engage-stats`（独立面板，不影响现有数据）
- "Your Posts" 图表 lime 色叠加柱：读 `EngageDataTicks WHERE type='replies' AND timeUnit='day'` — 与现有 DataTicks 图表查询模式完全一致
- "Traffic from Engage" 趋势：读 `EngageDataTicks WHERE type='traffic' AND timeUnit='day'`

**EngageDataTicks 与 DataTicks 对比**：

| | DataTicks (现有) | EngageDataTicks (新增) |
|---|---|---|
| 粒度 | per-integration (per social account) | per-platform (x/reddit/all) |
| type | impressions / traffic | replies / impressions / traffic |
| 更新 | `dataTicksSyncWorkflow` UTC 00:05 | `engageDataTicksWorkflow` UTC 01:00 |
| 用途 | 普通发帖趋势图 | Engage 回帖趋势图 |
| 缓存 | Redis `dashboard:impressions:${orgId}` | Redis `engage:ticks:${orgId}` |

### 11.2 Calendar Integration

**No new model, no new API.** The existing calendar query fetches `Post` records. Add source-based filtering:

```typescript
// In existing calendar data fetch — add source filter:
const posts = await prisma.post.findMany({
  where: {
    organizationId,
    publishDate: { gte: rangeStart, lte: rangeEnd },
    ...(showEngage ? {} : { NOT: { source: 'engage' } }),
  },
});
```

**Color mapping** (in calendar event renderer, keyed on `post.source` + `post.state`):

| Condition | Background | Border | Prefix |
|---|---|---|---|
| `source='engage'` AND `state=PUBLISHED` | `#FFF4D0` | `#D0A040` | 💬 |
| `source='engage'` AND `state=QUEUE` | `#F0E8FF` | `#A070D0` | 📅 |
| `source='engage'` AND `state=ERROR` | `#FFE4E4` | `#D04040` | ⚠️ |

**Toolbar additions** (minimal changes to existing calendar UI):
- "Show Engage" toggle → controls the `showEngage` flag in the query
- Banner "Engage" counter: `COUNT Post WHERE source='engage' AND publishDate IN this month`

---

## 12. Security Considerations

### 12.1 OAuth Token Scoping

- X API calls use the *user's own* connected integration token — never a shared platform token
- Engage never reads DMs or private data; scopes limited to `tweet.read`, `tweet.write`, `users.read`
- Reddit API calls are read-only (no OAuth needed); only the user manually posts on Reddit

### 12.2 Rate Limit Protection

- Scan workflow: max 50 API calls per org per run; configurable backoff on 429
- Draft generation: rate-limited to 20 generations/user/hour via existing throttle guard
- X send: wrapped with existing `handleErrors` → `'retry' | 'bad-body' | 'refresh-token'` classification

### 12.3 Organization Isolation

All Engage data is scoped to `organizationId`. No cross-org data access. Existing `@CheckPolicies()` guards enforce this at the controller layer.

### 12.4 Input Validation

- Reddit comment URL validated via regex: `^https?://www\.reddit\.com/r/[^/]+/comments/[^/]+/[^/]*/[a-z0-9]+/?$`
- AI draft content stored as-is; no execution or further processing
- Keyword max length: 100 chars; max 50 keywords per org

---

## 13. Migration Plan

### 13.1 Prisma Migration

New migration file: `libraries/nestjs-libraries/src/database/prisma/migrations/YYYYMMDD_add_engage_tables.sql`

All new tables; no modifications to existing tables (only additive relation fields on `Organization`).

```bash
pnpm prisma migrate dev --name add_engage_tables
```

### 13.2 Temporal Workflow Registration

Add to orchestrator's workflow list. No changes to existing workflows.

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

## 15. Open Questions

| Question | Owner | Deadline |
|---|---|---|
| X API cost model: user-provided key vs platform-paid? | Product | Before v1.0 dev starts |
| Reddit: use official OAuth API for future post automation (v2)? | Engineering | v1.2 planning |
| Auto-reply daily volume limit to prevent spam perception? | Product | Before auto-reply feature |
| Opportunity TTL: how long to keep dismissed/replied records? | Engineering | v1.0 dev |
| Claude API model: use claude-sonnet-4-5 or update to newer model? | Engineering | Before dev |
| Intent classifier: switch to `mDeBERTa` (278MB) when QQ/WeChat support ships? | Engineering | v1.x planning |
| Docker cache strategy for 44MB model file — bake into image or mount volume? | DevOps | Before deploy |
