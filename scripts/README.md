# Scripts

## test-agent-simple.ts

A simplified E2E test script for the Chat Agent. It bypasses the login process by signing a JWT directly using `JWT_SECRET` from `.env`. This allows for rapid testing of the Agent's content generation and X.com (Twitter) scheduling.

### Scenarios Covered
- **Text Only**: Professional tech tip post.
- **Image + Text**: Marketing post with AI-generated image.
- Each scenario automatically handles the "Confirm schedule" multi-turn step.

### Quick Start

```bash
# Run with all integrations
USER_ID="your-user-uuid" ORG_ID="your-org-uuid" pnpm dlx ts-node scripts/test-agent-simple.ts

# Target a specific X.com account (by name or integration ID)
USER_ID="your-uuid" ORG_ID="your-uuid" INTEGRATION="my-x-account" pnpm dlx ts-node scripts/test-agent-simple.ts
```

### Environment Variables

| Variable | Required | Source | Description |
|----------|----------|--------|-------------|
| `USER_ID` | Yes | Pass on command line | UUID of the user to impersonate |
| `ORG_ID` | No | Pass on command line | UUID of the organization (if user has multiple) |
| `INTEGRATION` | No | Pass on command line | Filter to a specific integration by name or ID |
| `JWT_SECRET` | Yes | Loaded from `.env` | Used to sign the authentication token |
| `BACKEND_INTERNAL_URL` | No | Loaded from `.env` | Backend API URL (defaults to `http://localhost:3000`) |

---

## reauth-integrations.ts

Safe re-authorization script for integrations after server-level API key rotation.

When you change OAuth app credentials (e.g. `X_API_KEY`, `FACEBOOK_APP_ID`), existing tokens in the database become invalid. This script marks affected integrations for re-authorization **without deleting any data** — all posts, schedules, settings, and relations are preserved.

### Quick Start

```bash
# 1. Preview affected integrations (dry-run, no changes)
npx ts-node scripts/reauth-integrations.ts

# 2. Execute for all OAuth providers
npx ts-node scripts/reauth-integrations.ts --execute
```

### Options

| Flag | Description | Default |
|------|-------------|---------|
| `--dry-run` | Show what would be updated, no changes made | Yes (default) |
| `--execute` | Apply the changes | — |
| `--provider <name>` | Target specific provider(s), comma-separated | All OAuth providers |
| `--org <id>` | Scope to a specific organization | All organizations |
| `--help` | Show usage help | — |

### Examples

```bash
# Only X (Twitter)
npx ts-node scripts/reauth-integrations.ts --provider x --execute

# Multiple providers
npx ts-node scripts/reauth-integrations.ts --provider x,linkedin,facebook --execute

# Specific organization
npx ts-node scripts/reauth-integrations.ts --provider x --org org_123 --execute
```

### Supported Providers

| Provider | Env Vars |
|----------|----------|
| `x` | `X_API_KEY`, `X_API_SECRET` |
| `facebook` | `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET` |
| `instagram-business` | `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET` |
| `instagram` | `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET` |
| `linkedin` | `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` |
| `linkedin-page` | `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` |
| `youtube` | `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET` |
| `tiktok` | `TIKTOK_CLIENT_ID`, `TIKTOK_CLIENT_SECRET` |
| `reddit` | `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET` |
| `pinterest` | `PINTEREST_CLIENT_ID`, `PINTEREST_CLIENT_SECRET` |
| `discord` | `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` |
| `slack` | `SLACK_ID`, `SLACK_SECRET` |
| `threads` | `THREADS_APP_ID`, `THREADS_APP_SECRET` |
| `twitch` | `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET` |
| `kick` | `KICK_CLIENT_ID`, `KICK_SECRET` |
| `vk` | `VK_ID` |
| `dribbble` | `DRIBBBLE_CLIENT_ID`, `DRIBBBLE_CLIENT_SECRET` |

Providers that do **not** need re-authorization (API-key or passwordless auth): `devto`, `medium`, `hashnode`, `mastodon`, `bluesky`, `lemmy`, `telegram`, `nostr`, `farcaster`, `listmonk`, `wordpress`.

### What Changes

For each affected integration:

| Field | Before | After |
|-------|--------|-------|
| `refreshNeeded` | `false` | `true` |
| `token` | OAuth token | `''` (empty) |
| `refreshToken` | refresh token | `null` |
| `tokenExpiration` | expiry date | `null` |

### What Is Preserved

- All posts and their content
- Scheduling configuration (`postingTimes`)
- Provider-specific settings (`additionalSettings`)
- Display info (`name`, `picture`, `profile`)
- Custom instance details
- All relations: plugs, webhooks, order items

### Post-Execution Verification

```sql
-- Check flagged integrations
SELECT id, name, "providerIdentifier", "refreshNeeded"
FROM "Integration"
WHERE "refreshNeeded" = true;

-- Verify posts are intact
SELECT COUNT(*)
FROM "Post"
WHERE "integrationId" IN (
  SELECT id FROM "Integration" WHERE "refreshNeeded" = true
);
```

In the UI, affected channels will show a "re-authorization needed" prompt. Once the user re-authorizes via OAuth, new tokens are stored and `refreshNeeded` resets to `false`.

---

## sync-account-metrics.ts

Sync account-level metrics (followers, following, listed count, etc.) for social integrations. Uses the same `DataTicksService.syncAccountMetricsById()` method as the daily Temporal cron workflow, with cooldown skipped for on-demand use.

> **Note:** This script bootstraps a NestJS application context and must be run with the scripts-specific tsconfig to enable decorator compilation.

### Quick Start

```bash
# 1. Preview target integrations (dry-run, no API calls)
npx ts-node --project scripts/tsconfig.json scripts/sync-account-metrics.ts --dry-run

# 2. Sync all active integrations
npx ts-node --project scripts/tsconfig.json scripts/sync-account-metrics.ts --execute
```

### Options

| Flag | Description | Default |
|------|-------------|---------|
| `--dry-run` | List matching integrations without syncing | Yes (default) |
| `--execute` | Actually call platform APIs and update metrics | — |
| `--integration <id>` | Target a specific integration by ID | All |
| `--org <id>` | Scope to a specific organization | All |
| `--platform <name>` | Filter by platform (x, linkedin, instagram, etc.) | All |
| `--help` | Show usage help | — |

### Examples

```bash
# Only X (Twitter) integrations
npx ts-node --project scripts/tsconfig.json scripts/sync-account-metrics.ts --platform x --execute

# Specific organization
npx ts-node --project scripts/tsconfig.json scripts/sync-account-metrics.ts --org org_123 --execute

# Single integration
npx ts-node --project scripts/tsconfig.json scripts/sync-account-metrics.ts --integration clxyz123 --execute
```

### What It Does

1. Queries the database for active social integrations matching the filters
2. For each integration, calls the platform's `accountMetrics()` API (e.g. Twitter `v2.me`, LinkedIn `networkSizes`)
3. Writes metrics (followers, following, posts, etc.) into `Integration.additionalSettings`
4. Skips the 1-hour Redis cooldown so the script can be run repeatedly

### Output Example

```
=== Account Metrics Sync Script ===

Mode:     EXECUTE
Platform: x

Found 3 integration(s):

  [abc123] @myaccount (x, org: org_456)
  [def789] @otheracct (x, org: org_456)
  [ghi012] @third (x, org: org_789)

Bootstrapping NestJS context...

  Syncing [abc123] @myaccount (x) ... OK: followers=1234, following=567, posts=890, listed=12
  Syncing [def789] @otheracct (x) ... OK: followers=5678, following=123, posts=456, listed=3
  Syncing [ghi012] @third (x) ... SKIPPED (provider has no accountMetrics or integration unavailable)

Done: 2 synced, 1 skipped, 0 error(s).
```

---

## sync-post-data.ts

Sync post analytics and DataTicks for all organizations. Uses the same `DataTicksService.syncDailyTicks()` method as the daily Temporal cron workflow (UTC 00:05). Supports single-date, date-range, and backfill modes.

DataTicks use an upsert on `(organizationId, integrationId, type, timeUnit, statisticsTime)`, so running this multiple times per day safely **overwrites** previous values.

> **Note:** This script bootstraps a NestJS application context and must be run with the scripts-specific tsconfig to enable decorator compilation.

### Quick Start

```bash
# 1. Preview (dry-run, no API calls)
npx ts-node --project scripts/tsconfig.json scripts/sync-post-data.ts --dry-run

# 2. Sync yesterday (default)
npx ts-node --project scripts/tsconfig.json scripts/sync-post-data.ts --execute
```

### Options

| Flag | Description | Default |
|------|-------------|---------|
| `--dry-run` | Show what would be synced without making changes | Yes (default) |
| `--execute` | Actually perform the sync | — |
| `--date <YYYY-MM-DD>` | Sync for a specific date | Yesterday |
| `--start-date <YYYY-MM-DD>` | Start of date range (for backfill) | — |
| `--end-date <YYYY-MM-DD>` | End of date range (used with `--start-date`) | Same as start-date |
| `--help` | Show usage help | — |

### Examples

```bash
# Sync a specific date
npx ts-node --project scripts/tsconfig.json scripts/sync-post-data.ts --date 2026-03-28 --execute

# Backfill a date range
npx ts-node --project scripts/tsconfig.json scripts/sync-post-data.ts --start-date 2026-03-01 --end-date 2026-03-10 --execute
```

### What It Does

For each target date, calls `DataTicksService.syncDailyTicks(date)` which:

1. Fetches published posts with `releaseId` from the last 30 days across all organizations
2. Calls platform APIs (`batchPostAnalytics` or per-post `postAnalytics`) to get metrics
3. Updates individual `Post` records: `impressions`, `trafficScore`, `analytics`
4. Upserts aggregated `DataTicks` records (impressions + traffic per integration per day)
5. Invalidates dashboard Redis cache (`dashboard:impressions:*`, `dashboard:traffics:*`, `dashboard:summary:*`)
6. Syncs account-level metrics (followers, etc.) for each integration

### Output Example

```
=== Post Data & DataTicks Sync Script ===

Mode: EXECUTE
Date(s): 2026-03-28

Bootstrapping NestJS context...

  Syncing 2026-03-28 ... OK: 12 ticks upserted, 0 org error(s)

Done: 12 total ticks upserted, 0 total error(s).
```

### Backfill Example

```
=== Post Data & DataTicks Sync Script ===

Mode: EXECUTE
Date(s): 2026-03-01 to 2026-03-10 (10 days)

Bootstrapping NestJS context...

  Syncing 2026-03-01 ... OK: 8 ticks upserted, 0 org error(s)
  Syncing 2026-03-02 ... OK: 10 ticks upserted, 0 org error(s)
  ...
  Syncing 2026-03-10 ... OK: 12 ticks upserted, 0 org error(s)

Done: 98 total ticks upserted, 0 total error(s).
```

---

## Database Check Scripts

Lightweight diagnostic scripts for quickly inspecting recent database state. Useful for verifying deployment health, debugging user-reported issues, or spot-checking after incidents. All scripts read from the database configured in `.env` (`DATABASE_URL`).

### Quick Start

```bash
npx ts-node scripts/check_recent_posts.ts
npx ts-node scripts/check_recent_notifications.ts
npx ts-node scripts/check_new_orgs.ts
```

### check_recent_posts.ts

Fetches up to 10 posts created, updated, or scheduled within the last 2 days. Shows state, integration, publish date, and content preview.

**When to use:**
- A user reports a post is stuck or missing — quickly verify its state (QUEUE / PUBLISHED / ERROR)
- After a deployment — confirm recent posts are still flowing correctly
- Debugging recurring post issues — check if clones were created

### check_recent_notifications.ts

Lists all in-app notifications created today (UTC), sorted newest first.

**When to use:**
- Verify that error/success notifications are being generated after posting
- A user says they didn't receive a notification — check if it exists in the DB
- After changing notification logic — confirm new notifications appear

### check_new_orgs.ts

Lists organizations created today (UTC).

**When to use:**
- Daily sanity check for new sign-ups
- After changing onboarding flow — verify new orgs are still being created
- Investigating a registration issue reported by a user
