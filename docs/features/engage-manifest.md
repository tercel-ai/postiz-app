# Engage Feature Manifest

**Project**: AISEE Engage  
**Source**: `docs/engage/tech-design.md`  
**Generated**: 2026-05-20  
**Decision**: SPLIT — 9 sub-features, sequential + parallel execution  

---

## Decomposition Rationale

Engage spans 8 new Prisma models, 4 Temporal workflows, 25+ API endpoints, a local ML model, 3 frontend pages, and modifications to 3 existing files. A single feature plan would be unmanageable. The natural split follows the dependency graph: schema first, then backend services, then workflows, then frontend layers.

---

## Sub-Feature Manifest

### F1 · Database Schema & Migration
**Slug**: `engage-f1-schema`  
**Scope**: All new Prisma models + extensions to existing models  
**Deliverables**:
- New models: `EngageConfig`, `EngageKeyword`, `EngageMonitoredChannel`, `EngageTrackedAccount`, `EngageXReplyAccount`, `EngageOpportunity`, `EngageSentReply`, `EngageDataTicks`
- Extensions: `Organization` (3 relations), `Integration` (1 relation), `Post` (1 back-relation)
- `pnpm prisma migrate dev --name add_engage_tables`

**Key files**:
- `libraries/nestjs-libraries/src/database/prisma/schema.prisma`

**Dependencies**: none — start here  
**Can run in parallel with**: nothing (all others depend on this)

---

### F2 · Engage Core Backend (Config + Account Management API)
**Slug**: `engage-f2-core-api`  
**Scope**: EngageModule scaffolding + config/account management endpoints  
**Deliverables**:
- `apps/backend/src/engage/engage.module.ts`
- `apps/backend/src/api/routes/engage.controller.ts` — config, keywords, channels, tracked-accounts, reply-accounts endpoints
- `libraries/nestjs-libraries/src/engage/engage.service.ts`
- `libraries/nestjs-libraries/src/engage/engage.repository.ts`
- `libraries/nestjs-libraries/src/engage/dtos/engage.dto.ts` — all DTO classes
- `apps/backend/src/app.module.ts` — register EngageModule

**Key API endpoints**: `GET/POST /config`, `POST/DELETE/PATCH /keywords`, `GET/POST/PATCH/DELETE /monitored-channels`, `GET/POST/PATCH/DELETE /tracked-accounts`, `GET/PATCH /reply-accounts`

**Dependencies**: F1  
**Can run in parallel with**: nothing yet (F3, F4 depend on this)

---

### F3 · Discovery Engine (Scoring + Intent + Scan Workflow)
**Slug**: `engage-f3-discovery`  
**Scope**: Scoring engine, intent classifier, daily scan workflow, tracked-accounts polling  
**Deliverables**:
- `libraries/nestjs-libraries/src/engage/engage-scorer.ts` — 5-dimension ScoreBreakdown
- `libraries/nestjs-libraries/src/engage/engage-intent-classifier.service.ts` — Xenova NLI model + Claude Haiku fallback
- `libraries/nestjs-libraries/src/engage/engage-intent.constants.ts` — INTENT_LABELS, INTENT_DEFAULT_STRATEGY
- `apps/orchestrator/src/workflows/engage-scan.workflow.ts` — daily 00:30
- `apps/orchestrator/src/workflows/engage-tracked-accounts.workflow.ts` — every 3h
- `apps/backend/src/api/routes/engage.controller.ts` — add `GET /opportunities`, `PATCH /opportunities/:id/dismiss`, `PATCH /opportunities/:id/bookmark`, `GET /opportunities/score-stats`
- `pnpm add @xenova/transformers --filter @postiz/nestjs-libraries`

**Dependencies**: F1, F2  
**Can run in parallel with**: F4 (no cross-dependency between discovery and reply flow)

---

### F4 · Reply Flow (Draft Generation + Send + Post Integration)
**Slug**: `engage-f4-reply`  
**Scope**: AI draft generation, X/Reddit reply sending, Post pipeline integration  
**Deliverables**:
- `libraries/nestjs-libraries/src/engage/engage-draft.service.ts` — Claude Sonnet SSE streaming
- `apps/backend/src/api/routes/engage.controller.ts` — add `POST /opportunities/:id/draft`, `POST /opportunities/:id/reply`, `POST /opportunities/:id/schedule`, `POST /opportunities/:id/manual-reply`, `PATCH /sent/:id/reply-url`, `GET /sent`, `GET /sent/stats`
- **Modify** `libraries/nestjs-libraries/src/dtos/posts/providers-settings/x.dto.ts` — add `reply_to_tweet_id`
- **Modify** `libraries/nestjs-libraries/src/dtos/posts/create.post.dto.ts` — add `'engage'` to source enum
- **Modify** `apps/orchestrator/src/workflows/post-workflows/post.workflow.v1.0.1.ts` — read `reply_to_tweet_id` from settings

**Dependencies**: F1, F2  
**Can run in parallel with**: F3

---

### F5 · Analytics Workflows (DataTicks + Metrics Sync)
**Slug**: `engage-f5-analytics`  
**Scope**: Time-series aggregation, reply metrics sync, DataTicks isolation  
**Deliverables**:
- `apps/orchestrator/src/workflows/engage-data-ticks.workflow.ts` — daily 01:00, writes to EngageDataTicks
- `apps/orchestrator/src/workflows/engage-metrics-sync.workflow.ts` — 24h after reply, authorReplied + Reddit metrics
- **Modify** `libraries/nestjs-libraries/src/database/prisma/data-ticks/data-ticks.service.ts` — add `source NOT IN ('engage')` filter to `getPublishedPostsWithRelease()`
- `apps/backend/src/api/routes/dashboard.controller.ts` — add `GET /engage-stats` endpoint
- `apps/backend/src/api/routes/engage.controller.ts` — add `GET /dashboard/summary`

**Dependencies**: F1, F4  
**Can run in parallel with**: F6, F7 (frontend does not block analytics)

---

### F6 · Frontend: Signal Feed & Reply Panel
**Slug**: `engage-f6-feed`  
**Scope**: Main daily-use UI — opportunity cards, filters, reply panel with AI draft  
**Deliverables**:
- `apps/frontend/src/app/(app)/(site)/engage/page.tsx` — Signal Feed
- `apps/frontend/src/app/(app)/(site)/engage/layout.tsx`
- `apps/frontend/src/components/engage/signal-feed/opportunity-card.tsx`
- `apps/frontend/src/components/engage/signal-feed/feed-filters.tsx`
- `apps/frontend/src/components/engage/signal-feed/reply-panel.tsx` — SSE draft streaming
- `apps/frontend/src/components/engage/setup-wizard/setup-wizard.tsx` — first-visit one-time config
- **Modify** `apps/frontend/src/components/layout/top.menu.tsx` — add Engage nav item

**Dependencies**: F2, F3, F4  
**Can run in parallel with**: F7, F8

---

### F7 · Frontend: Settings Page
**Slug**: `engage-f7-settings`  
**Scope**: Keywords & Accounts management UI  
**Deliverables**:
- `apps/frontend/src/app/(app)/(site)/engage/settings/page.tsx`
- `apps/frontend/src/components/engage/settings/keyword-manager.tsx`
- `apps/frontend/src/components/engage/settings/monitored-channel-manager.tsx`
- `apps/frontend/src/components/engage/settings/tracked-accounts.tsx` — EXTERNAL accounts (EngageTrackedAccount)
- `apps/frontend/src/components/engage/settings/reply-accounts.tsx` — OWN X accounts (Integration + EngageXReplyAccount)

**Dependencies**: F2  
**Can run in parallel with**: F6, F8

---

### F8 · Frontend: Sent History
**Slug**: `engage-f8-sent`  
**Scope**: Reply history list with platform-specific metrics display  
**Deliverables**:
- `apps/frontend/src/app/(app)/(site)/engage/sent/page.tsx`
- `apps/frontend/src/components/engage/sent/sent-list.tsx`
- `apps/frontend/src/components/engage/sent/sent-card-x.tsx` — 5 metric cells (impressions/likes/retweets/replies/bookmarks)
- `apps/frontend/src/components/engage/sent/sent-card-reddit.tsx` — 3 metric cells (score/comments/est.impressions)

**Dependencies**: F4, F5  
**Can run in parallel with**: F6, F7

---

### F9 · Dashboard & Calendar Integration
**Slug**: `engage-f9-integration`  
**Scope**: Surfacing Engage data in existing Dashboard and Calendar views  
**Deliverables**:
- `apps/frontend/src/components/engage/dashboard/engage-performance-panel.tsx` — 4-cell stats panel
- `apps/frontend/src/components/engage/dashboard/traffic-from-engage-panel.tsx` — per-reply progress bars
- **Modify** `apps/frontend/src/app/(app)/(site)/dashboard/page.tsx` — add EngagePerformancePanel + lime chart overlay
- **Modify** existing Calendar component — add source='engage' filter, color mapping, Show Engage toggle, banner counter

**Dependencies**: F5, F6, F7, F8  
**Can run in parallel with**: nothing (final integration layer)

---

## Execution Order

```
F1 (Schema)
  └── F2 (Core API)
        ├── F3 (Discovery) ──────────────────────┐
        └── F4 (Reply Flow)                       │
              └── F5 (Analytics)     ┌────────────┤
                    ├── F6 (Feed) ←──┤            │
                    ├── F7 (Settings)│ parallel   │ parallel
                    └── F8 (Sent) ←──┘            │
                          └── F9 (Dashboard+Cal) ←┘
```

**Parallel opportunities**:
- F3 ∥ F4 (after F2 completes)
- F6 ∥ F7 ∥ F8 (after their respective backend deps complete)

---

## Files to Create per Sub-Feature

| Sub-Feature | New Files | Modified Existing Files |
|---|---|---|
| F1 Schema | schema.prisma additions | schema.prisma, 1 migration |
| F2 Core API | engage.module, controller, service, repository, DTOs | app.module.ts |
| F3 Discovery | engage-scorer, intent-classifier, intent-constants, 2 workflows | — |
| F4 Reply | engage-draft.service, SSE endpoint additions | x.dto.ts, create.post.dto.ts, post.workflow.v1.0.1.ts |
| F5 Analytics | 2 workflows, dashboard endpoint | data-ticks.service.ts, dashboard.controller.ts |
| F6 Feed | 6 components + page | top.menu.tsx |
| F7 Settings | 4 components + page | — |
| F8 Sent | 3 components + page | — |
| F9 Dashboard | 2 components | dashboard page, calendar component |

---

## Next Steps

Run these commands to generate implementation plans for each sub-feature:

```bash
/code-forge:plan @docs/features/engage-f1-schema.md
/code-forge:plan @docs/features/engage-f2-core-api.md
# etc.
```

Or to generate feature spec files first:
```bash
/spec-forge:tech-design engage-f1-schema
```
