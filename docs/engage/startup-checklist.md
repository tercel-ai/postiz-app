# Engage Module Startup & Deployment Checklist

**Version**: 1.3
**Date**: 2026-05-22
**Status**: Pre-launch requirements for core features

> v1.3 Revision: Split paths for "Cold Start / Upgrading Existing Environment". §5 updated to use `scripts/redeploy-orchestrator.sh` (build → terminate old workflows → pm2 restart) to avoid running `pnpm run pm2` on active systems, which triggers redundant initialization and workflow nondeterminism.
>
> v1.2 Revision: Reordered chapters to "Config → Dependencies → Models → DB → Start → Verify". Merged HuggingFace mirror/pre-download instructions into one section. Added copyable commands for each step.
>
> v1.1 Revision: Corrected Prisma / pnpm commands, API Key variable names, HF mirror conditions, and Temporal workflow registration timing based on actual code.

---

## 0. Overview: Determine Cold Start or Upgrade

**First, identify your scenario** as the paths for §5 differ:

| Scenario | Characteristics | Path to Follow |
|---|---|---|
| **A. Cold Start** | Fresh environment / First deployment / No existing Postiz data in DB | §0.A |
| **B. Upgrade Existing Environment** (**Current Engage launch belongs here**) | System is running, PM2 processes exist, Temporal workflows are executing | §0.B |

> ⚠️ **Do not execute `pnpm run pm2` directly on a running system** — this script re-runs `prisma-seed`, restarts all processes in parallel, and may cause old workflows to trigger *nondeterminism* errors under new code. Upgrades must follow `scripts/redeploy-orchestrator.sh`.

### 0.A Cold Start Path

```bash
# 1. Edit .env, configure ANTHROPIC_API_KEY (Required)
# 2. Install dependencies (postinstall automatically runs prisma generate)
pnpm install

# 3. (Recommended) Pre-download NLP intent model to avoid startup lag
pnpm dlx ts-node -r tsconfig-paths/register scripts/download-model.ts

# 4. Push Prisma schema (pm2-run also does this, listed here for standalone use)
pnpm run prisma-db-push

# 5. Start dev or prod orchestration
pnpm run pm2          # dev
# pnpm run pm2:prod   # prod

# 6. Run Smoke Test in §7 for verification
```

### 0.B Upgrade Existing Environment Path (Applicable for Engage Launch)

```bash
# 1. Pull latest code
git pull

# 2. Edit .env, add ANTHROPIC_API_KEY (sync if .env.example has changed)

# 3. Install new dependencies (postinstall automatically runs prisma generate)
pnpm install

# 4. (Recommended) Pre-download NLP intent model
pnpm dlx ts-node -r tsconfig-paths/register scripts/download-model.ts

# 5. Push new Engage tables / fields (no data loss; --accept-data-loss only for unreferenced columns)
pnpm run prisma-db-push

# 6. Redeploy orchestrator (build → terminate old workflows → pm2 restart)
bash scripts/redeploy-orchestrator.sh

# 7. Restart backend / frontend (Required to load new Engage routes and UI components)
pm2 restart backend frontend                 # dev
# pm2 restart backend-prod frontend-prod    # prod

# 8. Run Smoke Test in §7 for verification
```

The following chapters provide detailed instructions for each step.

---

## 1. Environment Variable Configuration (.env)

Engage has two LLM call points (Draft generation, Intent classification fallback). Both support **Native Anthropic** or **OpenRouter**. Follow the path corresponding to your `.env` configuration.

### 1.1 Using Native Anthropic

- [ ] **`ANTHROPIC_API_KEY`** (or alias `CLAUDE_API_KEY`)

### 1.2 Using OpenRouter (Recommended if used by other modules)

- [ ] **`OPENROUTER_API_KEY`**: Once set, both draft generation and intent fallback will switch to `https://openrouter.ai/api/v1`.
- [ ] **`OPENROUTER_TEXT_MODEL`** (e.g., `openai/gpt-4.1`): Used for draft generation; falls back to `anthropic/claude-sonnet-4-6` if unset.
- [ ] **`OPENROUTER_INTENT_MODEL`** (e.g., `anthropic/claude-haiku-4.5`): Used for intent classification fallback; defaults to `anthropic/claude-haiku-4.5` if unset. These **must be configured separately** to avoid inflated costs for classification.

> **Key Priority** (consistent across both services): `ANTHROPIC_API_KEY` → `CLAUDE_API_KEY` → `OPENROUTER_API_KEY`. If the first two are set, the entire chain uses Native Anthropic, and the OpenRouter Key will not take effect.
>
> See §3 for HuggingFace mirror / NLP model pre-download configuration.

---

## 2. Install Dependencies & Generate Prisma Client

```bash
pnpm install
```

- [ ] `pnpm install` will install new dependencies like `@xenova/transformers`.
- [ ] **The `postinstall` hook automatically executes `pnpm run prisma-generate`**; no manual rerun required.
- [ ] If you need to manually regenerate the Prisma client:

  ```bash
  pnpm run prisma-generate
  ```

  ⚠️ **Do not** use `pnpm --filter @postiz/nestjs-libraries prisma generate` — `libraries/nestjs-libraries/` has no `package.json` and is not an independent pnpm package. This command will return `No projects matched the filters`.

---

## 3. NLP Model Pre-download (Highly recommended before §5)

`EngageIntentClassifierService` downloads an NLP model (~44MB, `Xenova/nli-deberta-v3-small`) to `~/.cache/huggingface/` during initialization. If not pre-downloaded, the Backend or Orchestrator `onModuleInit` will hang for 30–60 seconds (depending on network) during the first start.

### 3.1 Recommended: Pre-download before starting services

```bash
pnpm dlx ts-node -r tsconfig-paths/register scripts/download-model.ts
```

- [ ] Cache is ready once you see the `downloaded` log.
- [ ] Subsequent startups will hit the cache and complete in seconds.

### 3.2 Mirror Configuration for Restricted Networks

**The current code does not read the `HF_ENDPOINT` environment variable**; setting it will **not work**. If the initial download fails, use one of the following:

1. Add the following to the top of `onModuleInit` in `libraries/nestjs-libraries/src/engage/engage-intent-classifier.service.ts`:

   ```ts
   import { env } from '@xenova/transformers';
   env.remoteHost = 'https://hf-mirror.com';
   ```

   Apply the same `env.remoteHost` setting to the top of `scripts/download-model.ts` if it needs to use a mirror.

2. Pre-place or mount the model cache to `~/.cache/huggingface/` before deployment. **Recommended for Docker**: Mount the host's `~/.cache/huggingface/` as a volume to avoid re-downloading on every container rebuild.

### 3.3 If you choose not to pre-download

- [ ] Monitor the initial startup logs. It is **normal** for the process to hang at `onModuleInit` for 30–60 seconds; do not force terminate it.

---

## 4. Database Schema Upgrade

Engage introduces 8 new tables and extends existing tables like `Post`, `Organization`, and `Integration`.

```bash
pnpm run prisma-db-push
```

- [ ] The project currently uses **`prisma db push`** instead of `prisma migrate`.
- [ ] This step is automatically included in the `pm2-run` / `pm2-run:prod` startup sequence; no need to rerun if using those commands in §5.
- [ ] `prisma-db-push` now also runs **`engage-indexes.sql`** (chained as `prisma-db-indexes`), which creates the `pg_trgm` extension + the Engage `postContent` trigram GIN index. `db push` cannot create that index on its own, so a fresh DB must go through this script (not a bare `prisma db push`).
- [ ] Although historical SQL files like `add-engage-tables.sql` exist in `libraries/nestjs-libraries/src/database/prisma/migrations/`, they are **not applied** via `prisma migrate deploy`. Do not mix workflows, or the `_prisma_migrations` table will go out of sync with the actual schema.

---

## 5. Start / Redeploy Services

Follow the subsection corresponding to your scenario from §0:

### 5.A Cold Start: `pnpm run pm2`

```bash
# Development Mode
pnpm run pm2

# Production Mode
pnpm run pm2:prod
```

The `pm2-run` script executes the following in order:
1. `ensure-pm2-names.sh` (Clears old process names)
2. `prisma-db-push` (Idempotent, can be rerun)
3. `prisma-seed` (AI pricing seed data)
4. Starts backend / frontend / orchestrator in parallel
5. `pm2 logs`

### 5.B Upgrade Existing Environment: `redeploy-orchestrator.sh` + `pm2 restart`

This applies to the current Engage launch. **Do not run `pnpm run pm2` directly**:
- It reruns `ensure-pm2-names.sh`, which may clear/reorder existing PM2 process names.
- It reruns `prisma-seed` (AI pricing), which is redundant for production.
- It restarts all processes via `pnpm run --parallel pm2` **after** db-push, meaning the old orchestrator might briefly run against the new schema with old workflow code, causing transient errors.

Correct procedure:

```bash
# 1) Orchestrator: Use the script to build → terminate old workflows → pm2 restart
bash scripts/redeploy-orchestrator.sh
```

`scripts/redeploy-orchestrator.sh` executes the following (see script comments for details):
1. `pnpm build` —— If it fails, workflows remain untouched (Safe).
2. `npx ts-node scripts/terminate-workflows.ts --execute` —— Terminates old workflows in `TEMPORAL_NAMESPACE` (from `.env`) to avoid nondeterminism during replay.
3. `pm2 restart $PM2_ORCHESTRATOR_NAME` (from `.env`, defaults to `orchestrator`).
4. Upon Orchestrator startup, `infinite.workflow.register.ts` automatically re-registers resident workflows (including the new `engageDataTicksWorkflow`).

```bash
# 2) Backend / Frontend: Required to load new /engage routes, controllers, and UI components
pm2 restart backend frontend                 # dev (See PM2 name conventions below)
# pm2 restart backend-prod frontend-prod    # prod
```

- [ ] After restarting, check `pm2 logs <name> --lines 30 --nostream` for `nondeterminism` or Prisma errors.
- [ ] Confirm `engageDataTicksWorkflow` appears in the Running list in the Temporal UI (See §6).

**PM2 Process Name Conventions** (Written to `.env` by `scripts/ensure-pm2-names.sh` during `pm2-run`):

| Process | dev | prod | `.env` Key |
|---|---|---|---|
| Backend | `backend` | `backend-prod` | `PM2_BACKEND_NAME` |
| Frontend | `frontend` | `frontend-prod` | *(Not managed by script, use convention)* |
| Orchestrator | `orchestrator` | `orchestrator-prod` | `PM2_ORCHESTRATOR_NAME` |

`redeploy-orchestrator.sh` reads `PM2_ORCHESTRATOR_NAME` from `.env`; the same command works for both dev and prod. Use `pm2 ls` to verify current names.

### 5.C Terminating Only Engage-related Historical Workflows

If stale `engage-scan-*`, `engage-tracked-*`, or `engage-metrics-*` workflows exist, they can be terminated individually by filtering by workflowId prefix in `scripts/terminate-workflows.ts`. **Do not terminate indiscriminately in a production namespace** as it may kill critical business workflows.

---

## 6. Temporal Workflow Registration (Varying Start Times)

Engage includes 5 core asynchronous workflows with **different trigger timings**. Content in the Temporal UI will change based on user actions. Do not expect to see all 5 immediately after a cold start:

| Workflow ID | Function Name | Trigger Mechanism | When it appears in Temporal UI |
|---|---|---|---|
| `engage-data-ticks` | `engageDataTicksWorkflow` | Registered as a resident instance by `infinite.workflow.register.ts` at Orchestrator start | ✓ **Immediately after Orchestrator cold start** |
| `engage-keyword-global` | `engageGlobalKeywordScanWorkflow` | `EngageService.onApplicationBootstrap()` — Starts automatically on Orchestrator launch with `USE_EXISTING` | ✓ **Immediately after Orchestrator cold start** |
| `engage-channel-global` | `engageGlobalChannelScanWorkflow` | Same as above | ✓ **Same as above** |
| `engage-tracked-global` | `engageGlobalTrackedWorkflow` | Same as above | ✓ **Same as above** |
| `engage-metrics-{sentReplyId}` | `engageMetricsSyncWorkflow` | Started by `EngageService.startMetricsSyncForReply()` using `sentReplyId` after each reply creation | After each successful Engage reply |

> The 3 global scan workflows are **single-instance global** and no longer created per organization. The `USE_EXISTING` conflict policy ensures that multiple calls to `onApplicationBootstrap` do not create duplicate instances.

**Scan Interval Environment Variables** (Optional `.env` config, defaults built-in):

| Variable | Default | Description |
|---|---|---|
| `ENGAGE_SCAN_TICK_MINUTES` | `5` | Engage scan ticker wake interval; restart/terminate-start the ticker for changes to affect an already running workflow |
| `ENGAGE_KEYWORD_SCAN_INTERVAL_HOURS` | `24` | Global keyword search (X + Reddit) |
| `ENGAGE_CHANNEL_SCAN_INTERVAL_HOURS` | `3` | Reddit monitored subreddit scan |
| `ENGAGE_TRACKED_SCAN_INTERVAL_HOURS` | `3` | X tracked account scan |

**Keyword Initial Scan Environment Variables** (Optional `.env` config, defaults built-in):

When a keyword is newly added or re-enabled, Engage creates a per-platform
`EngageKeywordInitialScan` row. The ticker processes these rows before the
normal shared-cursor scan, batching claimed rows into one platform OR catch-up query so new
keywords do not wait up to the 24h global keyword cadence and do not miss recent
posts that are already behind the shared platform keyword cursor.

These values are read from the **Settings** table on every `runDueScans` activity,
so platform-specific tuning changes do not require an orchestrator restart. Env
vars remain fallback/bootstrap defaults only.

| Settings key | Env fallback | Default | Description |
|---|---|---:|---|
| `engage.keyword_initial_scan.enabled_platforms` | `ENGAGE_KEYWORD_INITIAL_SCAN_PLATFORMS` | `["reddit","x"]` | Platforms with active initial-scan execution |
| `engage.keyword_initial_scan.lookback_hours` | `ENGAGE_KEYWORD_INITIAL_SCAN_LOOKBACK_HOURS` | `24` | Recent-history window for time-based platforms such as Reddit |
| `engage.keyword_initial_scan.max_attempts` | `ENGAGE_KEYWORD_INITIAL_SCAN_MAX_ATTEMPTS` | `3` | Maximum attempts before a repeatedly failing row stays `FAILED` |
| `engage.keyword_initial_scan.retry_ms` | `ENGAGE_KEYWORD_INITIAL_SCAN_RETRY_MS` | `900000` | Retry delay for `FAILED` rows that still have attempts remaining |
| `engage.keyword_initial_scan.stale_ms` | `ENGAGE_KEYWORD_INITIAL_SCAN_STALE_MS` | `1800000` | Stale `RUNNING` lease timeout; allows recovery if a worker dies mid-scan |
| `engage.keyword_initial_scan.reddit.max_units` | `ENGAGE_REDDIT_KEYWORD_INITIAL_SCAN_MAX_UNITS`, then `ENGAGE_KEYWORD_INITIAL_SCAN_MAX_UNITS` | `10` | Reddit rows claimed per activity and OR-batched into a catch-up scan |
| `engage.keyword_initial_scan.reddit.max_calls` | `ENGAGE_REDDIT_KEYWORD_INITIAL_SCAN_MAX_CALLS`, then `ENGAGE_KEYWORD_INITIAL_SCAN_MAX_CALLS` | `2` | Reddit upstream call budget per initial-scan batch |
| `engage.keyword_initial_scan.x.max_units` | `ENGAGE_X_KEYWORD_INITIAL_SCAN_MAX_UNITS`, then `ENGAGE_KEYWORD_INITIAL_SCAN_MAX_UNITS` | `5` | X rows claimed per activity and OR-batched into a catch-up scan |
| `engage.keyword_initial_scan.x.max_calls` | `ENGAGE_X_KEYWORD_INITIAL_SCAN_MAX_CALLS`, then `ENGAGE_KEYWORD_INITIAL_SCAN_MAX_CALLS` | `1` | X upstream call budget per initial-scan batch |

Future platform keys follow the same pattern:
`engage.keyword_initial_scan.<platform>.max_units` and
`engage.keyword_initial_scan.<platform>.max_calls`.

When an adapter exhausts `<platform>.max_calls` before exhausting all pages or
OR-batches, fetched posts are still persisted, but the claimed initial-scan rows
must remain retryable instead of being marked `DONE`. Increase `max_calls` only
when repeated retries cannot drain normal backlog within the desired delay.

Naming/case rules:

- Settings **keys must be lowercase** and dot-separated, e.g.
  `engage.keyword_initial_scan.reddit.max_units`.
- The `<platform>` segment in Settings keys must be lowercase (`reddit`, `x`).
  Do not use `Reddit`, `REDDIT`, or `X` in key names.
- Values inside `engage.keyword_initial_scan.enabled_platforms` are normalized to
  lowercase by the scanner, so `["REDDIT", "X"]` works, but write
  `["reddit", "x"]` for consistency.
- Env fallback names remain uppercase, e.g.
  `ENGAGE_REDDIT_KEYWORD_INITIAL_SCAN_MAX_UNITS`.

Example Settings rows:

| key | type | value |
|---|---|---|
| `engage.keyword_initial_scan.enabled_platforms` | `array` | `["reddit", "x"]` |
| `engage.keyword_initial_scan.reddit.max_units` | `number` | `10` |
| `engage.keyword_initial_scan.reddit.max_calls` | `number` | `2` |
| `engage.keyword_initial_scan.x.max_units` | `number` | `5` |
| `engage.keyword_initial_scan.x.max_calls` | `number` | `1` |

SQL example:

```sql
INSERT INTO "Settings" ("id", "key", "type", "value", "default_value", "createdAt", "updatedAt")
VALUES
  (gen_random_uuid(), 'engage.keyword_initial_scan.enabled_platforms', 'array', '["reddit","x"]'::jsonb, '["reddit","x"]'::jsonb, NOW(), NOW()),
  (gen_random_uuid(), 'engage.keyword_initial_scan.reddit.max_units', 'number', '10'::jsonb, '10'::jsonb, NOW(), NOW()),
  (gen_random_uuid(), 'engage.keyword_initial_scan.reddit.max_calls', 'number', '2'::jsonb, '2'::jsonb, NOW(), NOW()),
  (gen_random_uuid(), 'engage.keyword_initial_scan.x.max_units', 'number', '5'::jsonb, '5'::jsonb, NOW(), NOW()),
  (gen_random_uuid(), 'engage.keyword_initial_scan.x.max_calls', 'number', '1'::jsonb, '1'::jsonb, NOW(), NOW())
ON CONFLICT ("key") DO UPDATE
SET
  "type" = EXCLUDED."type",
  "value" = EXCLUDED."value",
  "default_value" = EXCLUDED."default_value",
  "updatedAt" = NOW();
```

**Scan Tuning Environment Variables** (Optional `.env` config, defaults built-in):

| Variable | Default | Description |
|---|---|---|
| `ENGAGE_OPPORTUNITY_TTL_DAYS` | `7` | NEW opportunities older than this are marked EXPIRED |
| `ENGAGE_MIN_SCORE` | `60` | Minimum total score (0–100) for a scored post to become an opportunity. Lower → more (noisier) opportunities; raise → only strong matches |
| `ENGAGE_X_SEARCH_DELAY_MS` | `1000` | Inter-request pacing for X keyword search (rate-limit guard) |
| `ENGAGE_REDDIT_SEARCH_DELAY_MS` | `500` | Inter-request pacing for Reddit keyword search (rate-limit guard) |

> These are read once at orchestrator process start — **restart the orchestrator** for changes to take effect.

**Cold Start Check** (Default Temporal UI: `http://localhost:8233`):

- [ ] **After Cold Start**: `engage-data-ticks`, `engage-keyword-global`, `engage-channel-global`, and `engage-tracked-global` should all appear in the Running list.
- [ ] **After First Engage Reply**: `engage-metrics-{sentReplyId}` appears.

---

## 7. Debug Scripts: Manual Scan Trigger & Stats

`scripts/engage-scan.ts` can trigger Temporal scan signals locally and display opportunity counts in the DB in real-time, bypassing the Temporal UI.

**Prerequisites**: `DATABASE_URL` and `TEMPORAL_ADDRESS` (default `localhost:7233`) in `.env` must be reachable; Temporal service must be running.

```bash
# Trigger all 3 scans (Immediate)
npx ts-node --project scripts/tsconfig.json scripts/engage-scan.ts --all

# Trigger Keyword scan only (Global X + Reddit)
npx ts-node --project scripts/tsconfig.json scripts/engage-scan.ts --keyword

# Trigger Channel scan only (Reddit subreddits)
npx ts-node --project scripts/tsconfig.json scripts/engage-scan.ts --channel

# Trigger Tracked account scan only (X tracked accounts)
npx ts-node --project scripts/tsconfig.json scripts/engage-scan.ts --tracked

# View current DB stats (Does not trigger scans)
npx ts-node --project scripts/tsconfig.json scripts/engage-scan.ts --stats

# Trigger scans + refresh results every 10 seconds until Ctrl-C
npx ts-node --project scripts/tsconfig.json scripts/engage-scan.ts --all --watch

# View current scan targets(X accounts, Reddit subreddits, Keywords)
npx ts-node --project scripts/tsconfig.json scripts/engage-scan.ts --targets
```

Output includes:
- Running status of each workflow (Running / NOT FOUND)
- Opportunity counts per platform, configured Channels, and Tracked accounts
- Top 10 keywords by hit count (sorted by `weeklyHitCount`)
- Most recent 8 Opportunities (Platform, score, author, content summary)

> The platform list is dynamically derived from actual `platform` values in `EngageMonitoredChannel` and `EngageTrackedAccount`, not hardcoded.

---

## 8. Feature Isolation Verification (Smoke Test)

Perform the following manual checks to ensure system stability before formal use:

- [ ] **Existing Business Verification**: Schedule and send a standard Post (`source='calendar'`) to ensure posting logic and statistics are unaffected.
- [ ] **Engage Activation**: Enable an X account in `/engage/settings`, add keywords, and trigger the first scan. Confirm `engage-keyword-global`, `engage-channel-global`, and `engage-tracked-global` are Running in the Temporal UI.
- [ ] **Data Isolation Purity**: After sending an Engage reply, verify the following endpoints **do not** include Engage data:
  - `GET /dashboard/summary`
  - `GET /dashboard/traffics`
  - `GET /dashboard/posts-trend`
  - `GET /dashboard/impressions`
  - `GET /dashboard/post-engagement`

  These endpoints have `source: { notIn: ['engage'] }` filters applied in `dashboard.repository.ts`. If Engage posts appear, investigate the filters immediately.

- [ ] **Shared Quota Verification (Product Decision: Engage shares standard post quota)**:
  - After sending an Engage reply, the user's monthly post count (`countPostsFromDay`) **should include** this reply — this is by design.
  - If an overage is triggered, the `data.source` field in the AiseeCredit charge record should be `'engage'` (instead of the old hardcoded `'calendar'`).
