# Scripts

Database utilities validate PostgreSQL URLs and derive the database name from
`DATABASE_URL`; they do not require a development-only database name. Existing
environment variables take precedence over `.env`. Verify that the configured
host, database, and schema belong to this deployment before using a utility:
parsing a URL cannot detect that the URL points at the wrong service.

## diagnose-linkedin-profile.ts

Read-only diagnosis of a reported LinkedIn miniProfile ID and public profile.
The script and its tests live in this backend repository.

```bash
pnpm exec ts-node --project scripts/tsconfig.json scripts/diagnose-linkedin-profile.ts \
  --id ACoAAA07H24BGZjYnfpiSuwbLgBaajh84HUelEc \
  --handle kyd-feng-92640b62

# Limit diagnosis to the organization used by the failing request
pnpm exec ts-node --project scripts/tsconfig.json scripts/diagnose-linkedin-profile.ts \
  --id <miniProfile-id> --handle <public-profile> --org <organization-id>
```

It reads `DATABASE_URL` from the environment, then this repository's `.env` as
fallback, independent of the working directory. `--backend-dir` or
`AISEE_BACKEND_DIR` may explicitly select another backend checkout. It validates
the configured PostgreSQL target, uses paginated Prisma `findMany` reads,
and selects no tokens, credentials or metadata. It never changes accounts,
verifies identities, or submits session reports. `--help` does not connect.

Without `--org`, it scans LinkedIn member accounts and reports only organizations
related to the supplied ID or normalized profile. The JSON includes matching
and conflicting Integration IDs, identity namespaces and deleted/disabled state.
Recovery candidates are profile-only suggestions with eligibility marked
`NOT_CHECKED`; the backend may reject them based on stored identity provenance,
coordinated references or other recovery guards. This is a diagnostic tool,
not a migration script.

Exit codes: `0` means no initial identity/profile gate block was found; `2` means
a block was found; `1` means diagnosis failed. A zero exit code does not prove
that session registration or recovery will succeed. Run the regression tests
with `pnpm exec vitest run scripts/diagnose-linkedin-profile.spec.ts`.

## audit-integration-profiles.ts

Read-only audit of social-account profile uniqueness within each organization
and exact provider. It trims whitespace, ignores case, and removes the display
prefixes `@` and `u/`, using the existing handle normalizer. LinkedIn members
(`linkedin`) and company pages (`linkedin-page`) remain separate providers.

```bash
# Audit all social accounts, including disabled and deleted records
pnpm exec ts-node --project scripts/tsconfig.json scripts/audit-integration-profiles.ts

# Narrow to an organization and provider
pnpm exec ts-node --project scripts/tsconfig.json \
  scripts/audit-integration-profiles.ts --org <organization-id> --platform x

# Save the report locally as JSON
pnpm exec ts-node --project scripts/tsconfig.json \
  scripts/audit-integration-profiles.ts --json > profile-audit.json
```

The script loads `.env` without overriding existing environment variables and
derives the database name from the validated PostgreSQL `DATABASE_URL`.
It only performs paginated Prisma `findMany` reads and selects
no tokens, credentials, or metadata. There is no write or repair mode.

Reports include duplicate groups with Integration IDs, original profiles,
platform IDs, identity namespaces, disabled/deleted state, and the number of
non-deleted accounts. Identity comparisons distinguish equal identities,
different identities, and missing/legacy identity fields; they are diagnostic
comparisons, not proof that two records belong to the same actor. Missing
profiles and unresolved identities are also listed separately. Historical-only
duplicates still count as duplicates, with deleted rows explicitly identified.

Exit codes: `0` means no duplicate profiles in the selected scope; `2` means
duplicates were found; `1` means invalid input or an audit failure. Informational
missing-profile and unresolved-identity findings alone do not change exit code
`0`. The audit never merges accounts, repairs identities, or changes bindings.

## cleanup-integration-profile-duplicates.ts

Previews soft deletion of one explicitly reviewed duplicate social account.
Both IDs must have the same organization, exact provider and nonempty normalized
profile. The retained account must not be deleted. No record is automatically
selected as the survivor based on its age, namespace, or profile alone.

```bash
# Preview first
pnpm exec ts-node --project scripts/tsconfig.json \
  scripts/cleanup-integration-profile-duplicates.ts \
  --keep <retained-integration-id> --remove <duplicate-integration-id>

# After reviewing the preview, apply the same explicit pair yourself
pnpm exec ts-node --project scripts/tsconfig.json \
  scripts/cleanup-integration-profile-duplicates.ts \
  --keep <retained-integration-id> --remove <duplicate-integration-id> --apply
```

The script validates its configured PostgreSQL target, reads no credentials,
and defaults to preview. `--apply` sets only `deletedAt` and `disabled` on the
specified duplicate. Published history, metrics, project assignments, and
terminal-session references retain their original Integration IDs. Nothing is
merged or reassigned to the retained account. Already-deleted duplicates are
idempotent no-ops.

Defaults, unfinished posts/intents/executions, unresolved autonomous effects,
held quota, and active account writers block application. Autonomous effects
include browser admissions linked through historical or deleted posts; only
`CONFIRMED` and `NOT_SUBMITTED` receipts are settled. The preview lists unsettled
receipt IDs. Resolve those references through normal application
flows before retrying; the script never silently clears them. Application
rechecks blockers and account identity snapshots in a Serializable transaction.
`livePosts` counts undeleted posts whose state is not `PUBLISHED`, including
drafts and failures; it does not mean every counted post is actively sending.
`blockingPosts` lists up to 20 post IDs with state, project, publication time,
title and intent ID. `blockingPostsTruncated` indicates additional rows; the
full blocker count remains authoritative. Post bodies and lease tokens are
not selected for this diagnostic output.
Pause publishing during maintenance. Exit codes are `0` for an allowed preview,
successful application, or an already-deleted duplicate; `2` for blocked cleanup;
`1` for invalid input or failure.

### delete-blocking-quora-draft.ts

One-off API script for the reviewed Quora draft `cmu1wtvql0048qmece78j97tb`
that blocks cleanup of integration `cmtsdcu1s0005qm83o7mkc4cc`.
The development API URL, organization, project, account and draft IDs are fixed
in the script to prevent accidental targeting of another record.

```bash
# Preview only
pnpm exec ts-node --project scripts/tsconfig.json scripts/delete-blocking-quora-draft.ts

# Delete the reviewed draft through the normal application API
pnpm exec ts-node --project scripts/tsconfig.json scripts/delete-blocking-quora-draft.ts --apply
```

Use a current login token. The script reads `AISEE_AUTH_TOKEN` from the environment
or `.env`; otherwise it prompts in the terminal without displaying the input.
Do not pass tokens as command-line arguments. `--help` needs no token or network.
The script has no database connection and never executes SQL.
The application's existing GET endpoint may normalize and persist image metadata
while loading the draft, including during preview. Without `--apply`, the script
does not request deletion of any post or account.

It checks the organization, project, account, Quora provider and `DRAFT` state,
and refuses send intents, claims, threads or recurring posts. It calls
`DELETE /posts/id/:id`, which performs the application's normal soft deletion,
then checks the organization-wide post lookup without state or project filters.
The legacy deletion response's `error` field is ignored because the existing
service returns `{ "error": true }` even on success. An HTTP error, malformed
response or failed verification stops the script with exit code `1`; it never
retries deletion automatically. Initial absence is reported as `not-found`,
not proof that a previous deletion succeeded.

Pause editing and publishing during maintenance: the existing API does not
atomically check the draft state with deletion. The script's checks are client
preconditions and do not replace server guards. If deletion succeeds but
verification is interrupted, rerun preview and the duplicate-account cleanup
preview to establish the current state.

After successful deletion, rerun the Quora cleanup preview, then apply if
`canApply` is `true`. That script rechecks all blockers before changing the account:

```bash
pnpm exec ts-node --project scripts/tsconfig.json scripts/cleanup-integration-profile-duplicates.ts --keep cmvhiw7cf0003qmt6qw8jrqyy --remove cmtsdcu1s0005qm83o7mkc4cc
pnpm exec ts-node --project scripts/tsconfig.json scripts/cleanup-integration-profile-duplicates.ts --keep cmvhiw7cf0003qmt6qw8jrqyy --remove cmtsdcu1s0005qm83o7mkc4cc --apply
```

### Applying profile uniqueness

The application rejects new normalized profile claims that collide with
`ACCOUNT_PROFILE_CONFLICT`, including creation, restoration and changes to a
profile, organization, provider or social-account eligibility. An existing
active claim with the same normalized profile may still refresh its credentials
or session while historical duplicates await cleanup; this never creates a new
duplicate or merges identities. Disabled accounts still reserve their profile. Deleted
accounts keep their history without reserving a profile; restoration checks
uniqueness again. Organizations and exact providers remain separate, including
LinkedIn personal and company accounts. Profile equality never authorizes an
identity merge or a change to historical account references.

After reviewing and cleaning active duplicates, the operator or deployment
pipeline must apply
`libraries/nestjs-libraries/src/database/prisma/migrations/unique-active-integration-profile.sql`.
It prepares a partial unique expression index as the final concurrent-write
guard, without adding a column. Prisma cannot express this index; the schema
records its migration location in a comment. The migration checks the database
name and fails if active duplicates remain. Agents must never execute it.

Prepare a deployment-specific SQL file offline. This reads `DATABASE_URL` from
the environment or `.env`, decodes its database name, and sets a transaction-local
expected target in the generated SQL. It makes no database connection and refuses
to overwrite an existing file:

```bash
pnpm migration:prepare:profile-uniqueness --output /tmp/postiz-profile-uniqueness.sql
```

Review the generated file and verify the production connection separately.
The operator or deployment pipeline can then apply the reviewed artifact, with
`DATABASE_URL` explicitly exported to the intended database:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f /tmp/postiz-profile-uniqueness.sql
```

The SQL rejects a connection whose actual database name differs from the prepared
target. Applying the source SQL directly without preparing the expected target
also fails before DDL. Never use `db push` or rerun all migration files to fill
missing custom indexes or CHECK constraints after a schema synchronization.

Re-run the audit afterward. `groupsWithMultipleNonDeletedAccounts` must be zero;
`duplicateGroups` may remain nonzero because the audit intentionally includes
soft-deleted history. Profile cleanup does not verify or upgrade `legacy`
identities; that remains the separate protected identity-verification workflow.

## Repairing missing send guards after db push

For an upgrade where the current Prisma tables and columns already exist, the
profile uniqueness index has been applied, and the inspected database is missing
both send indexes and all eighteen sending CHECKs, prepare the dedicated repair:

```bash
pnpm migration:prepare:send-safety --output /tmp/postiz-send-safety.sql
cat /tmp/postiz-send-safety.sql
```

This command only writes SQL. It derives the target from `DATABASE_URL` and uses
the same offline preparer and connection-name guard as profile uniqueness.
The existing profile preparation command remains supported.

Keep application writers stopped and retain a backup. Review and run the complete
generated script in the existing database client or the deployment pipeline.
Its transaction creates `SendExecution_one_active_content`,
`Post_controlled_claim_scan_idx`, and eighteen CHECK constraints from the original
node, identity, coordination, owner, and cursor migrations. Three identity checks
remain `NOT VALID` as originally designed; validating historical identities is a
separate audit step. It creates no tables or columns, removes no index, and does
not modify account identities, posts, leases, or quota data.

The repair targets the inspected all-missing state. Existing objects, conflicting
active executions, or invalid values cause a transaction failure; do not skip
errors, delete records, or rerun all base migrations. It does not recreate the old
bare-ID identity key and does not make an old application rollback safe.

The application URL can contain client-specific options such as
`sslmode=no-verify` or `schema` that `psql` does not accept. Do not pass that URL
unchanged to `psql` or alter the application's `.env` solely for the migration.
An already-working graphical database client can execute the complete generated
SQL in its verified connection. Exported result rows formatted as
`INSERT INTO "" (...)` are display/export data, not statements to execute against
PostgreSQL system catalogs.

## reconcile-legacy-identities.ts

Safely reconciles historical `Integration.identityNamespace = legacy` rows for
selected social accounts, one or more affected users, or all users. Preview is the default and performs database reads
only. `--apply` never writes Integration directly; it calls the protected
`POST /integrations/:id/identity/verify` endpoint so the normal OAuth actor
probe, conflict checks, organization permissions, and identity audit remain in
force.

```bash
# Preview
pnpm exec ts-node --project scripts/tsconfig.json \
  scripts/reconcile-legacy-identities.ts --users <user-id-1>,<user-id-2>

# Preview selected social accounts (Integration IDs, not platform account IDs)
pnpm exec ts-node --project scripts/tsconfig.json \
  scripts/reconcile-legacy-identities.ts --integrations <integration-id-1>,<integration-id-2>

# Preview legacy accounts across all users
pnpm exec ts-node --project scripts/tsconfig.json \
  scripts/reconcile-legacy-identities.ts --all

# Apply with an administrator or super-administrator token
export AISEE_AUTH_TOKEN='<token>'
pnpm exec ts-node --project scripts/tsconfig.json \
  scripts/reconcile-legacy-identities.ts --users <user-id-1>,<user-id-2> \
  --base-url https://api-post-dev.aisee.live --apply

# Apply across all users with a super-admin token
pnpm exec ts-node --project scripts/tsconfig.json \
  scripts/reconcile-legacy-identities.ts --all \
  --base-url https://api-post-dev.aisee.live --apply
```

`--user` and `--integration` may be repeated; their plural forms accept comma-separated
IDs. `--org` works alone or narrows another selection. User, organization, and
integration filters intersect. `--all` cannot be combined with explicit user or
integration IDs, and omitted or misspelled targeting options fail before any
database access. Already-normalized, deleted, or out-of-scope Integration IDs are
reported as unmatched rather than modified.

Accounts are scoped through organization membership, since Integration has no
userId. Each organization uses an active administrator membership for the existing
protected API. Organizations without Controlled mode or an active administrator
are explicitly reported as skipped; the script never switches sending modes.
The API still enforces system capability, authorization, credential ownership,
and identity conflicts. Cross-organization apply requires a super-admin token.
Each HTTP verification has a 60-second deadline, and an account failure does not
stop the rest of the batch.

The expected database defaults to the decoded name in `DATABASE_URL`.
Use `--expected-database` to add an independent intended-name check; a mismatch
is rejected before constructing a database client. OAuth-verifiable X,
Reddit, and LinkedIn Page rows are handled by the API. Session-only rows are
reported as `WAIT_FOR_SESSION` and are upgraded automatically when an
organization administrator's registered node submits fresh live identity
evidence in Controlled mode. Deleted accounts are never restored automatically.

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

## repair-stale-publish-date.ts

One-off repair for posts and engage replies that were PUBLISHED **before** `publishDate` started recording the real send time. Until that fix, every publish-success commit flipped `state` to PUBLISHED and left `publishDate` holding the moment we *intended* to send — the scheduled minute for a post, the save-draft moment for an engage reply — while the extension actually sent minutes to hours later.

### The evidence it uses

There is no `publishedAt` column, so the repair leans on the one timestamp the codebase already treats as the real write moment: **`Post.claimedAt`**, stamped when the extension takes the post/reply to publish it (`claimExtensionPublishPosts`, `claimDueEngageReplies`). See `getLastPlatformWriteAt`'s note — *"it is stamped when the extension takes the post to publish, which is the instant the platform actually sees traffic."*

`updatedAt` is deliberately **not** used as a fallback: it is bumped by metrics sync, publisher attribution, author enrichment and removal callbacks, so for an engage reply still being polled it can sit days past the send. Rows with no `claimedAt` are reported as unrecoverable rather than guessed at.

### Quick Start

```bash
# 1. Preview — how many rows are wrong, and by how much (dry-run, no changes)
npx ts-node --project scripts/tsconfig.json scripts/repair-stale-publish-date.ts

# 2. Apply
npx ts-node --project scripts/tsconfig.json scripts/repair-stale-publish-date.ts --execute
```

### Options

| Flag | Description | Default |
|------|-------------|---------|
| `--dry-run` | Report only, write nothing | Yes (default) |
| `--execute` | Apply the repairs | — |
| `--org <id>` | Scope to one organization | All |
| `--source <name>` | Scope to one `Post.source` (`engage`, `calendar`, …) | All |
| `--since <YYYY-MM-DD>` | Only rows whose `publishDate` is on/after this date | All time |
| `--min-drift-minutes <n>` | Ignore drift under n minutes | 2 |
| `--max-drift-hours <n>` | Skip drift over n hours, `0` = no ceiling | 168 (7 days) |
| `--limit <n>` | Max candidate rows to read | 5000 |
| `--help` | Show usage help | — |

### What it refuses to touch

- **Any group containing a recurring post** (`intervalInDays > 0`). There `publishDate` is not a timestamp but the cycle clone's *identity* — `findOrCreateCycleClone` matches a cycle by `(group, publishDate)`, so moving it would hide the published clone and let a restarted workflow post the content twice.
- **Any row that is not PUBLISHED.** A QUEUE row's `publishDate` is when it is still *due*; rewriting it would reschedule a pending post.
- **Anything that would move a date backwards**, or whose drift is under `--min-drift-minutes`. (The API/Temporal path commits within seconds and has no `claimedAt`, so it is excluded for free.)
- **`EngageSentReply.createdAt`** — that is the drafting time and feeds reply pacing (`getLastSentReplyAt`).

A thread is repaired as a whole: only the anchor is ever claimed (the publish-due query is roots-only), so its segments inherit the anchor's instant — exactly what the fixed publish path now does for new sends.

### Output Example

```
=== Repair stale publishDate ===

Mode:       DRY RUN (no changes)
Org:        all
Source:     engage
Since:      all time
Min drift:  2m
Max drift:  7.0d
Limit:      5000 candidate row(s)

Found 412 claimed published row(s) across 397 group(s).
38 published row(s) in scope have no claimedAt — not repairable, left as-is.

── Would apply 331 group(s) / 344 row(s) ──
  [engage/reddit] group=8f3c… 1 row(s)  2026-09-02 09:14:03 → 2026-09-02 14:51:10 (+5.6h)
  [engage/x] group=1a90… 1 row(s)  2026-09-02 10:02:00 → 2026-09-02 10:39:41 (+38m)
  … and 291 more

Drift distribution (groups):
  5m–30m   84
  30m–2h   147
  2h–12h   96
  > 24h    4

Skipped groups:
     42  drift under --min-drift-minutes
     20  no claimedAt on any row
      4  recurring — publishDate is the cycle clone identity

Re-run with --execute to write these changes.
```

## Legacy calendar recovery

Use `recover-legacy-calendar.ts --help` for token-free service-based maintenance.
Supply `--database-verified` only after verifying the actual connection target
matches the intended deployment's `DATABASE_URL`. The script automatically records the OS user and host as its
maintenance actor; no token or user ID is needed.
The default run only prepares a review plan. Mutations require `--apply`, explicit
executor-stop/no-pending-submit flags, and an evidence file. Keep the plan and
journal for idempotent recovery after interruption. See
[the recovery runbook](../docs/organization-sending-modes.md#token-free-service-recovery-script).
`recover-legacy-calendar-api.ts` remains a compatibility launcher and no longer
uses HTTP or tokens. Earlier API and user-based service plans require a fresh maintenance plan.
