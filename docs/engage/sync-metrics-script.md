# Engage Sync Metrics — manual wake-up + stats

`scripts/engage-sync-metrics.ts`

One command runs the whole "why is the *sent* list empty / has no metrics?" fix.
It does **not** copy production code — it boots the real NestJS DI context and calls
the same shared logic the 24h Temporal job and `POST /engage/admin/resync-metrics`
use. Every step is idempotent and safe to re-run; the default is a read-only dry run.

## What it does

1. **Backfill `Post.releaseId` (X only).** For X replies that have a
   `releaseURL` but no `releaseId`, re-parse the tweet id via `parseXTweetId`
   (`engage/x-tweet.ts`). `checkPostAnalytics` early-returns on a null
   `releaseId`, so without this the metric fetch can never run — this is the
   classic "URL saved but no metrics" case. Tracking params (`?s=20`), trailing
   slashes, `twitter.com`/`mobile.twitter.com`, and `/i/web/status/<id>` are all
   handled.
2. **Backfill `Post.integrationId` (X only).** For X replies with
   `integrationId = null`, resolve a usable X account via
   `EngageRepository.resolveXReplyIntegrationId` (author-handle → engage reply
   account → any live account). Without an integration, `checkPostAnalytics`
   has no OAuth token and can't read X metrics. Reddit never needs this.
3. **Re-fetch metrics.** Call `EngageService.resyncEngageMetrics` for every
   PUBLISHED engage reply whose `impressions` is still null. This is the *same*
   shared path as the 24h Temporal sync and `POST /engage/admin/resync-metrics`
   (X → `checkPostAnalytics` OAuth; Reddit → loid/WAF public fetch).
4. **Print before/after stats.** Per platform: `published`, `withMetrics`,
   `missing`, plus a blocker breakdown and `Σ impressions` / `Σ traffic`.

## Usage

```bash
# Dry-run: show current state + what it WOULD do (read-only)
npx ts-node --project scripts/tsconfig.json scripts/engage-sync-metrics.ts --dry-run

# Execute: backfill integration + fetch metrics + print results
npx ts-node --project scripts/tsconfig.json scripts/engage-sync-metrics.ts --execute

# Stats only — no sync, no DI bootstrap (fastest)
npx ts-node --project scripts/tsconfig.json scripts/engage-sync-metrics.ts --stats

# Scope to one org / one platform
npx ts-node --project scripts/tsconfig.json scripts/engage-sync-metrics.ts --org <orgId> --platform x --execute

# Skip the X integration backfill (metrics fetch only)
npx ts-node --project scripts/tsconfig.json scripts/engage-sync-metrics.ts --no-backfill --execute
```

## Flags

| Flag | Default | Effect |
|------|---------|--------|
| `--dry-run` | **on** | Read-only. Reports what would change; writes nothing. |
| `--execute` | — | Actually backfill + write metrics. |
| `--stats` | — | Print stats only; skip sync and the NestJS bootstrap entirely. |
| `--org <id>` | all orgs | Limit to one organization. |
| `--platform x\|reddit` | all | Limit to one platform. |
| `--no-backfill` | backfill on | Skip step 1 (X `integrationId` backfill); only re-fetch metrics. |
| `--help` | — | Print usage and exit. |

`--platform reddit` implicitly skips the X integration backfill (Reddit needs no integration).

## Output

### Stats table (`--stats`, BEFORE, AFTER)

```
── BEFORE ──
  [x     ] published=3  withMetrics=0  missing=3 (noIntegration=3)  Σimpr=0  Σtraffic=0
  [reddit] published=1  withMetrics=0  missing=1 (syncable=1)       Σimpr=0  Σtraffic=0
```

Each missing reply is classified by `classifyReplyMetric`
(`@gitroom/nestjs-libraries/engage/engage-metrics-stats`) into exactly one blocker:

| Status | Meaning | Fix |
|--------|---------|-----|
| `has_metrics` | Impressions present — counts toward `withMetrics`, `Σimpr`, `Σtraffic`. | — |
| `no_release_url` | Reply link never recorded. | `PATCH /engage/sent/:id/reply-url` |
| `no_integration` | X reply with no integration → no OAuth token. | Run the integration backfill (default on). |
| `no_release_id` | Reply URL has no `/status/<id>`. | Fix the link. |
| `syncable` | Ready, but the last fetch returned nothing. | X API tier block / Reddit WAF / not yet run. |

### MISSING breakdown

Dry-run (and post-execute) prints each missing reply with its status, URL, and a
one-line hint on how to clear the blocker.

### Resync result (`--execute`)

```
Resync: found 4  →  written 3, empty 1, unreachable 0, skipped 0, errors 0
```

- **written** — metrics landed.
- **empty** — API returned nothing (X tier block / deleted post).
- **unreachable** — network / WAF failure.
- **skipped** — missing prerequisite (e.g. no fetchable link).
- **errors** — unexpected failures.

## Notes

- Default mode is **dry run** — you must pass `--execute` to change anything.
- Idempotent: backfill fills only `null` `integrationId`; metrics are upserted.
- `empty` results for X usually mean the X reply API-tier block (Free/Pay-Per-Use
  tier can't read others' reply metrics) — not a script bug.
- **`empty` for X almost always means a dead integration token, not a tier/owner issue.**
  `impression_count` and `bookmark_count` are part of `public_metrics` and are returned
  by ANY valid token (even an app-only bearer) — they are **not** owner-only. So a blank
  X reply is almost always its attached integration being expired + `refreshNeeded=true`,
  where the user-token read returns nothing. The engage sync now falls back to an
  **app-only read** (`PostsService.checkPostAnalyticsAppOnly` → `appLogin` with
  `X_API_KEY`/`X_API_SECRET`, no user token) that recovers the **full** metric set
  (impression + bookmark included). If a reply is still `empty` after that, either
  `X_API_KEY`/`X_API_SECRET` are unset, the app's API tier blocks app-only reads
  (403/429), or the tweet was deleted/restricted. Use
  `scripts/engage-diagnose-x-reply.ts` to see the exact path. See `tech-design.md`
  → "Metric fields & the token fallback chain".
- Related: [reddit-loid-waf-bypass.md](./reddit-loid-waf-bypass.md),
  [reddit-metrics-sync-todo.md](./reddit-metrics-sync-todo.md).
