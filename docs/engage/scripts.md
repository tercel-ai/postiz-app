# Engage Operations Scripts — Runbook

A scenario-organized reference for the `scripts/*engage*` maintenance scripts.
Each script's own header docstring is the source of truth; this runbook groups them
by **when you reach for them** and lists the flags/env you actually need.

> Conventions
> - Most scripts default to a **read-only dry-run** and only mutate with `--execute`
>   (exceptions called out per script). When in doubt, run dry-run first.
> - Runner differs per script: some use `ts-node --project scripts/tsconfig.json`,
>   others use `tsx`. The command shown for each is the correct one.
> - All read `.env` (via `dotenv`). `DATABASE_URL` is implicitly required by every
>   script that touches the DB (Prisma); only *extra* env is listed per script.
> - `NODE_ENV` defaults to `production` and `TZ` to `UTC` where set — day-bucketing
>   and metric reads assume UTC.

---

## Quick index

| Script | Scenario | Default | Runner |
|--------|----------|---------|--------|
| `engage-scan.ts` | Trigger scans / inspect ticker | read-only | ts-node |
| `engage-realtime-scan.ts` | Directly probe platform scan results for one org | read-only | ts-node |
| `engage-sync-metrics.ts` | One-shot "sent list is empty" fix (X+Reddit) | dry-run | ts-node |
| `backfill-engage-x-integration.ts` | Fill `Post.integrationId` for X replies | dry-run | ts-node |
| `engage-diagnose-x-reply.ts` | Explain why an X reply has no metrics | read-only | ts-node |
| `engage-fetch-raw.ts` | Raw fetch of ONE post's reply (回帖) + original (原帖) data via shared workflow funcs | read-only | ts-node |
| `ingest-engage-post.ts` | Manually inject one X post into the pool | **writes** | ts-node |
| `cleanup-engage-opportunities.ts` | Soft-delete un-repliable opportunities | list/check | tsx |
| `backfill-engage-data-ticks.ts` | Rebuild `EngageDataTicks` from `Post` | dry-run | ts-node |
| `backfill-engage-matched-keywords.ts` | Fill `EngageOpportunityState.matchedKeywords` for pre-field rows | dry-run | ts-node |
| `backfill-engage-generation-history.ts` | Seed `EngageOpportunityState.generationHistory` from sent/saved replies + `engage_reply` charges | dry-run | ts-node |

---

## 1. Scanning & opportunity pool

### `engage-scan.ts` — trigger scans / inspect the ticker
Debug tool to force the consolidated scan ticker (workflowId `engage-scan-ticker`,
signal `triggerScanNow`) and inspect DB state. Read-only on the DB; the trigger
just signals Temporal.

```bash
npx ts-node --project scripts/tsconfig.json scripts/engage-scan.ts --all      # force scan all due units
npx ts-node --project scripts/tsconfig.json scripts/engage-scan.ts --stats     # DB stats only, no trigger
npx ts-node --project scripts/tsconfig.json scripts/engage-scan.ts --stats --watch  # poll stats every 10s
npx ts-node --project scripts/tsconfig.json scripts/engage-scan.ts --targets   # what the ticker will scan
```

- **Flags:** `--all` (aliases `--scan` / `--trigger`); legacy `--keyword` / `--channel`
  / `--tracked` all now just force the whole ticker (per-type scoping was removed when
  the workflows were consolidated); `--stats`; `--watch`; `--targets`.
- **Env:** `DATABASE_URL`, `TEMPORAL_ADDRESS` (default `localhost:7233`),
  `TEMPORAL_NAMESPACE` (default `default`). If a trigger reports nothing, confirm
  these point at the same cluster the orchestrator deploys to.

### `engage-realtime-scan.ts` — direct platform scan diagnostic
Read-only diagnostic for answering "did the platform return posts, did this org's
keywords match, did score pass `ENGAGE_MIN_SCORE`, and is the opportunity already
in DB?" It calls the same scan adapters as the orchestrator and installs the same
Reddit proxy dispatcher (`REDDIT_PROXY`, falling back to `HTTPS_PROXY` /
`HTTP_PROXY` where applicable).

```bash
npx ts-node --project scripts/tsconfig.json scripts/engage-realtime-scan.ts \
  --org <orgId> --platform reddit

# Compare with production incremental cursor semantics
npx ts-node --project scripts/tsconfig.json scripts/engage-realtime-scan.ts \
  --org <orgId> --platform reddit --use-cursor

# Focus on one keyword
npx ts-node --project scripts/tsconfig.json scripts/engage-realtime-scan.ts \
  --org <orgId> --platform reddit --keyword "storage"
```

- **Flags:** `--org` / `--orgId` (required), `--platform reddit|x|all`,
  `--scope all|keyword|channel|tracked`, `--keyword`, `--max-calls`, `--use-cursor`,
  `--token` (X override), `--json`.
- **Env:** `DATABASE_URL`; Reddit uses `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET`
  when available and otherwise falls back to public Reddit reads. Reddit traffic
  follows `REDDIT_PROXY || HTTPS_PROXY || HTTP_PROXY` via the same global dispatcher
  used by the orchestrator.
- **Important:** default mode uses an empty diagnostic cursor. That is useful for
  seeing what a new-keyword catch-up would find, but it is not the same as the
  workflow's shared `EngageScanCursor`. Add `--use-cursor` to reproduce workflow
  incremental behavior.

If default mode returns `WOULD_SURFACE` rows but `--use-cursor` returns none, the
likely cause is shared-cursor history: the keyword was added after the global
cursor had already advanced. The ticker's `EngageKeywordInitialScan` catch-up path
is designed to close that gap for newly added/re-enabled keywords.

### `ingest-engage-post.ts` — manually inject one X post
Lands a specific tweet in the pool for an org so you can walk the reply/send flow in
the UI without waiting for a scan. Bypasses the keyword filter and `MIN_SCORE`.
**Writes immediately — there is no dry-run.** Mirrors the scan's two-phase persist
(global `EngageOpportunity` + per-org `EngageOpportunityState`).

```bash
npx ts-node --project scripts/tsconfig.json scripts/ingest-engage-post.ts \
  --url=https://x.com/user/status/123 --org=<orgId>

# optional overrides
  --score=90 --status=NEW
```

- **Flags:** `--url` (req), `--org` (req), `--score`, `--status`.
- **Env:** `X_BEARER_TOKEN` **or** (`X_API_KEY` + `X_API_SECRET`).

### `cleanup-engage-opportunities.ts` — soft-delete un-repliable opportunities
Sets `deletedAt = now()` (all repo queries already filter `deletedAt: null`). Useful
for clearing X opportunities that are reply-restricted (protected / reply-settings).

```bash
# one specific opportunity
npx tsx scripts/cleanup-engage-opportunities.ts --id=<opportunityId>

# check reply_settings of all X opportunities via X API (no delete)
npx tsx scripts/cleanup-engage-opportunities.ts --platform=x --check

# check + delete only the restricted ones
npx tsx scripts/cleanup-engage-opportunities.ts --platform=x --check --execute

# nuclear: delete ALL X opportunities without checking
npx tsx scripts/cleanup-engage-opportunities.ts --platform=x --execute
```

- **Flags:** `--id`, `--platform`, `--check`, `--execute`. Without `--execute` it only
  lists/checks.
- **Env:** `X_BEARER_TOKEN` **or** (`X_API_KEY` + `X_API_SECRET`) — only needed for `--check`.

---

## 2. Reply metrics — sync & repair

> Background: X impressions/bookmarks are **owner-only**, so a reply's metrics can only
> be read through an X integration whose handle matches the reply author. Replies
> recorded without an `integrationId` therefore show blank numbers forever until the
> integration is backfilled. The scripts below cover that whole chain.

### `engage-sync-metrics.ts` — the one-shot "sent list is empty" fix ⭐
The catch-all. Does the full repair in one idempotent pass:
1. Backfill `Post.integrationId` for X replies that lack one (author-handle → engage
   reply account → any live X account). *[X only]*
2. Re-fetch metrics for every published reply with null impressions via the **same**
   shared logic as the 24h Temporal sync and `POST /engage/admin/resync-metrics`
   (X → `checkPostAnalytics` OAuth token; Reddit → loid/WAF public fetch).
3. Print a before/after per-platform stats table.

```bash
npx ts-node --project scripts/tsconfig.json scripts/engage-sync-metrics.ts --dry-run
npx ts-node --project scripts/tsconfig.json scripts/engage-sync-metrics.ts --execute
npx ts-node --project scripts/tsconfig.json scripts/engage-sync-metrics.ts --org <orgId> --execute
npx ts-node --project scripts/tsconfig.json scripts/engage-sync-metrics.ts --platform x --execute
npx ts-node --project scripts/tsconfig.json scripts/engage-sync-metrics.ts --stats        # stats only, no DI bootstrap
npx ts-node --project scripts/tsconfig.json scripts/engage-sync-metrics.ts --no-backfill --execute
```

- **Flags:** `--dry-run` (default), `--execute`, `--org`, `--platform`, `--stats`, `--no-backfill`.
- See `sync-metrics-script.md` for the detailed output-format walkthrough.

### `backfill-engage-x-integration.ts` — fill `Post.integrationId` for X replies
Fixes X replies recorded with `integrationId = null` so metrics can ever be read.
Resolution mirrors `EngageRepository.resolveXReplyIntegrationId` exactly (author-handle
→ engage reply account → any live X account). After running, re-fetch metrics with
`engage-sync-metrics.ts --execute`.

```bash
npx ts-node --project scripts/tsconfig.json scripts/backfill-engage-x-integration.ts --dry-run
npx ts-node --project scripts/tsconfig.json scripts/backfill-engage-x-integration.ts --execute
npx ts-node --project scripts/tsconfig.json scripts/backfill-engage-x-integration.ts --org <orgId> --execute
```

- **Flags:** `--dry-run` (default), `--execute`, `--org`.

### `engage-diagnose-x-reply.ts` — explain why an X reply has no metrics
**Read-only.** For each matching X reply it prints the full decision chain: Post
fields, attached integration (handle/expiry/refreshNeeded), `parseXHandle(url)` vs
`integration.profile` → recomputed `matchedBy` (handle = author token → full metrics;
bound/fallback = public only), and the live `checkPostAnalytics()` result with the
inline empty-reason. This is the script to run **before** the repair scripts to know
*which* fix you need.

```bash
npx ts-node --project scripts/tsconfig.json scripts/engage-diagnose-x-reply.ts
npx ts-node --project scripts/tsconfig.json scripts/engage-diagnose-x-reply.ts --url aipartnerup
npx ts-node --project scripts/tsconfig.json scripts/engage-diagnose-x-reply.ts --url 2061981755566125311
npx ts-node --project scripts/tsconfig.json scripts/engage-diagnose-x-reply.ts --org <orgId>
```

- **Filter:** `--url <substring>` (default: all X replies), `--org`.
- **Env:** `X_BEARER_TOKEN` **or** (`X_API_KEY` + `X_API_SECRET`).

**Typical X-metrics troubleshooting flow:**
```
diagnose (read-only)  →  backfill-engage-x-integration (if integrationId null)
                      →  engage-sync-metrics --execute  (backfill + re-fetch in one)
   …or just run engage-sync-metrics --execute directly, which does all three.
```

---

## 3. EngageDataTicks aggregate

> `EngageDataTicks` is **write-only** today — the engage dashboard reads the `Post`
> table directly. The daily `engageDataTicksWorkflow` is gated off by default. These
> scripts let you rebuild it on demand if needed.

### `backfill-engage-data-ticks.ts` — rebuild the aggregate from `Post`
Reconstructs `EngageDataTicks` over a date range by replaying what the Temporal
activity `aggregateDailyEngageTicks` does (replies = exact count; impressions/traffic =
current cumulative `Post` values bucketed by publish day).

> ⚠️ Fidelity: this yields a *"current totals by publish date"* series (same semantic
> as the live dashboard), **not** a true as-of-day historical snapshot. The latter can
> only be captured by running the daily job going forward.

```bash
npx ts-node --project scripts/tsconfig.json scripts/backfill-engage-data-ticks.ts \
  --start-date 2026-04-01 --end-date 2026-05-31 --dry-run
npx ts-node --project scripts/tsconfig.json scripts/backfill-engage-data-ticks.ts \
  --start-date 2026-04-01 --end-date 2026-05-31 --execute
```

- **Flags:** `--start-date` / `--end-date` (**both required**, `YYYY-MM-DD`, UTC,
  inclusive), `--org`, `--platform`, `--type`, `--dry-run` (default) / `--execute`, `--help`.

### `backfill-engage-matched-keywords.ts` — fill `matchedKeywords` for pre-field rows
`EngageOpportunityState.matchedKeywords` was added after opportunities already
existed, so old rows default to `[]` and the signal-feed / sent cards render no
keyword chips for them until a scan re-upserts the row. This script fills them
now by re-matching each opportunity's `postContent` against its org's **current
enabled** keywords — reusing `engage-scorer.ts` `postMatchesKeyword` verbatim so
backfilled hits match scan-time hits. Idempotent; skips rows already correct and
rows that match no current keyword (left `[]`).

```bash
npx ts-node --project scripts/tsconfig.json scripts/backfill-engage-matched-keywords.ts --dry-run
npx ts-node --project scripts/tsconfig.json scripts/backfill-engage-matched-keywords.ts --execute
npx ts-node --project scripts/tsconfig.json scripts/backfill-engage-matched-keywords.ts --org <orgId> --execute
npx ts-node --project scripts/tsconfig.json scripts/backfill-engage-matched-keywords.ts --all --execute  # recompute every row, not just empty
```

- **Flags:** `--org`, `--all` (recompute non-empty rows too), `--dry-run` (default) / `--execute`, `--help`.
- **Prereq:** the `matchedKeywords` column must exist — run `pnpm run prisma-db-push` first.

---

## 4. Proxy diagnostics

### `test-proxy.ts` — verify an HTTP proxy path
Checks a proxy with undici's `ProxyAgent`, which is the same HTTP stack used by
the Reddit/Engage server code. Use this when `curl -x` works but Node-side proxy
traffic looks intermittent.

By default it:
- reads the proxy from the first arg, `HTTPS_PROXY`, or `HTTP_PROXY`;
- normalizes both `http://user:pass@host:port` and panel-style
  `host:port:user:pass`;
- tests only the proxy path (direct checks are opt-in);
- uses IPv4-first DNS to match the common fast `curl -4 -x` comparison;
- probes multiple exit-IP services for multiple rounds and prints elapsed time,
  HTTP status, and connection error codes.

```bash
# default: 2 rounds across api.ipify.org, ifconfig.me, and icanhazip.com
pnpm exec ts-node --transpile-only scripts/test-proxy.ts "http://user:pass@host:port"

# compare proxy vs direct from the same process
pnpm exec ts-node --transpile-only scripts/test-proxy.ts "http://user:pass@host:port" --direct

# stress the proxy path and match curl's IPv4-only check
pnpm exec ts-node --transpile-only scripts/test-proxy.ts "http://user:pass@host:port" --rounds 5
curl -4 -x "http://user:pass@host:port" https://api.ipify.org?format=json

# isolate one target service or loosen DNS family behavior
pnpm exec ts-node --transpile-only scripts/test-proxy.ts "http://user:pass@host:port" --target https://api.ipify.org?format=json
pnpm exec ts-node --transpile-only scripts/test-proxy.ts "http://user:pass@host:port" --any-family
```

- **Flags:** `--direct`, `--rounds <n>` (default 2), `--timeout <ms>` (default
  10000), `--target <url>`, `--ipv6`, `--any-family`.
- **Env:** `HTTPS_PROXY` or `HTTP_PROXY` if no proxy URL is passed. For Reddit-only
  routing, pass `REDDIT_PROXY` explicitly or run
  `REDDIT_PROXY=... pnpm exec ts-node --transpile-only scripts/test-proxy.ts "$REDDIT_PROXY"`.
- **Interpretation:** if `curl -4 -x` is consistently fast but this script fails
  with `ENOTFOUND`, `ETIMEDOUT`, `ECONNRESET`, or `UND_ERR_*`, the problem is in
  Node/undici's path to the proxy or the proxy tunnel, not in the direct network.
  If only one exit-IP target fails, treat it as target-service flakiness rather
  than a proxy outage.

---

## See also
- [`startup-checklist.md`](./startup-checklist.md) — deployment / cold-start / upgrade ops.
- [`sync-metrics-script.md`](./sync-metrics-script.md) — detailed output walkthrough for `engage-sync-metrics.ts`.
- [`reddit-loid-waf-bypass.md`](./reddit-loid-waf-bypass.md) — how Reddit public-JSON metric reads clear the WAF.
- [`tech-design.md`](./tech-design.md) — architecture, data model, workflows.
