# Engage Fetch Raw — black-box opener for reply & original post data

`scripts/engage-fetch-raw.ts`

A read-only diagnostic for **"why can't we get the metrics for this engage post?"**.
Given one Post id (or `EngageSentReply` id), it fetches and prints the data for
**both** the reply we published (**回帖**) and the original post we replied to
(**原帖**), so you can see *exactly* where a value is missing and why.

The guiding principle: the reply path runs the **same shared functions the
Temporal sync runs** (`syncXMetrics` / `syncRedditMetrics`), not a copy. So
**if this script can't fetch a reply's metrics, the production workflow can't
either** — and every internal `warn`/`error` the workflow would log is printed
here instead of disappearing into a black box.

---

## Storage model (what "reply" and "original" mean)

| | Table | Key fields | How it is fetched |
|---|---|---|---|
| **回帖 (reply)** — the comment/tweet we sent | `Post` (`source='engage'`) | `releaseId`, `releaseURL`, `impressions`, `trafficScore`, `analytics` | Re-fetched **by id, continuously**, by the metrics-sync workflow. |
| **原帖 (original)** — the post we replied to | `EngageOpportunity` | `metricLikes/Replies/Retweets/Quotes/Bookmarks`, `metricScore`, `metricComments` | Captured/refreshed **only when a re-scan's keyword search re-surfaces the post** (`upsert`'s `update` branch). |
| link between them | `EngageSentReply` | `postId` ↔ `opportunityId` | — |

This asymmetry is the single most important thing to understand:

- The workflow has a **by-id refetch** for the **reply** (`Post`). That is a
  shared method, so the script reproduces it 1:1.
- The workflow has **no by-id refetch** for the **original** (`EngageOpportunity`).
  Original metrics are only updated when the keyword scan happens to search up
  that same post again (`engage-scan.activity.ts` → `engageOpportunity.upsert`
  `update: { metric* }`). If a post stops matching active keywords, its stored
  metrics simply stop updating — **that is expected, not a bug.**

Because there is no shared original-by-id method, the script's original section
is an **independent raw probe** that reads the *same fields* (X `public_metrics`
/ Reddit `score` + `num_comments`) only to answer "is the original still
reachable?" (deleted / restricted / WAF / tier block).

---

## What it does

### Section 1 — REPLY (回帖): shared workflow code path

Boots the real NestJS DI context and calls the very functions
`EngageDataTicksActivity.syncEngageMetrics` calls:

- **X** → `syncXMetrics`, whose analytics read is
  `PostsService.checkEngageXAnalyticsWithFallback` (own integration token →
  app-only `appLogin` fallback) — identical to production.
- **Reddit** → `syncRedditMetrics` (loid/WAF public fetch of
  `/api/info?id=t1_<commentId>` + the comment thread for child-reply count).

Deps are **instrumented**: every `warn`/`log` is printed, the X analytics array
is dumped, and the computed `impressions`/`trafficScore`/`analytics` that *would*
be written are shown. Write-back is **off** unless `--write` (see Notes for the X
caveat). The section ends with the function's real `OUTCOME`:

| Outcome | Meaning |
|---------|---------|
| `written` | Metrics fetched and (would be) persisted to the `Post`. |
| `empty` | Platform returned no usable data — deleted post, X API-tier block, or no app-only bearer. |
| `unreachable` | The fetch itself failed — network / Reddit WAF / X API error. See the `WARN` line above it. |
| `skipped` | A precondition was missing — no comment/tweet id, no integration. |

### Section 2 — ORIGINAL (原帖): independent raw probe

Reads the original directly to confirm reachability and compare against the
scan-stored numbers (printed as `stored(orig@scan)` in the DB context):

- **X** → `singleTweet(opportunity.externalPostId)` with
  `tweet.fields=public_metrics,...`; dumps `data` + any `errors`.
- **Reddit** → `/api/info?id=t3_<threadId>` (thread id parsed from the reply
  permalink / `externalPostUrl`); dumps the full `thing.data`.

---

## Usage

```bash
# Most common: diagnose one engage post by its Post id
npx ts-node --project scripts/tsconfig.json scripts/engage-fetch-raw.ts --post <postId>

# By EngageSentReply id instead
npx ts-node --project scripts/tsconfig.json scripts/engage-fetch-raw.ts --reply <sentReplyId>

# Persist the reply metrics the run fetched (Reddit write-back; see X caveat)
npx ts-node --project scripts/tsconfig.json scripts/engage-fetch-raw.ts --post <postId> --write

# Skip the reply path, only probe whether the original is still reachable
npx ts-node --project scripts/tsconfig.json scripts/engage-fetch-raw.ts --post <postId> --no-reply
```

## Flags

| Flag | Default | Effect |
|------|---------|--------|
| `--post <id>` | — | Target by `Post` id (the reply). One of `--post`/`--reply` is required. |
| `--reply <id>` (alias `--id`) | — | Target by `EngageSentReply` id. |
| `--no-reply` | reply on | Skip Section 1; only run the original raw probe. |
| `--write` | **off** | Persist the reply metrics (Reddit `updatePostMetrics` + `markAuthorReplied`). Read-only otherwise. |
| `--help` | — | Print usage and exit. |

## Output

```
DB context:
  platform       = x
  post.releaseId = 1799...   (← 回帖)
  integrationId  = 3f2a...    or NULL
  stored(reply)  = impressions=1234 trafficScore=87
  opp.externalId = 1798...   (← 原帖)
  stored(orig@scan) = likes=42 replies=7 rt=3 ... score=- comments=-

########## 1) REPLY (回帖) — SHARED workflow code path ##########
  [checkEngageXAnalyticsWithFallback] returned 7 metric(s)
  [X analytics] [ {Impressions...}, {Likes...}, ... ]
  ► OUTCOME: written

########## 2) ORIGINAL (原帖) — independent raw probe ##########
── RAW X ORIGINAL (原帖) (id=1798...) ──
  data: { public_metrics: { impression_count: ..., like_count: ... } }
```

---

## Reading the results

| Symptom | What it tells you |
|---------|-------------------|
| Reply `OUTCOME: written`, numbers present | Healthy. The workflow can read this reply; if the dashboard is stale, look at the daily resync cadence, not the fetch. |
| Reply `OUTCOME: empty`, X | Almost always a **dead integration token** (expired + `refreshNeeded`) with the app-only fallback also returning nothing → `X_API_KEY`/`X_API_SECRET` unset, app tier blocks app-only reads, or the tweet was deleted/restricted. `impression_count`/`bookmark_count` are public, **not** owner-only, so it is rarely a true "owner-only" issue. |
| Reply `OUTCOME: empty`, Reddit | Comment deleted/removed, or the public fetch returned an empty `children` array. |
| Reply `OUTCOME: unreachable` | Read the `WARN` line directly above it — HTTP status + body slice for Reddit, API error/429 for X. |
| Reply `OUTCOME: skipped` | `releaseId`/comment id or integration missing → fix with `scripts/engage-sync-metrics.ts` (backfills `releaseId`/`integrationId`). |
| Original probe shows fresh numbers but `stored(orig@scan)` is older | Expected. The original is only re-upserted when a keyword scan re-surfaces it; the stored values are last-scan, not live. |
| Original probe `No public_metrics` / `404` / `removed=true` | The original post was deleted or restricted; the opportunity is now stale. |

---

## Notes

- **Read-only by default.** Section 2 (original probe) never writes. Section 1's
  Reddit write-back is gated behind `--write`. **X caveat:** the X analytics read
  goes through `PostsService.checkEngageXAnalyticsWithFallback`, which does a
  *fire-and-forget* write-back of `impressions`/`trafficScore` inside
  `PostsService` (identical to the workflow, idempotent) — this happens even
  without `--write`. Use `--no-reply` if you want a truly zero-write run.
- **This is a diagnostic, not a fixer.** To actually backfill ids and sync
  metrics across many replies, use `scripts/engage-sync-metrics.ts`
  ([sync-metrics-script.md](./sync-metrics-script.md)). This script is for
  drilling into **one** post when the sync reports `empty`/`unreachable` and you
  need the raw reason.
- **No copied logic for the reply.** Section 1 imports and runs the production
  `syncXMetrics`/`syncRedditMetrics`, so its behavior is guaranteed identical to
  the 24h Temporal job and `POST /engage/admin/resync-metrics`.
- Related: [sync-metrics-script.md](./sync-metrics-script.md),
  [reddit-loid-waf-bypass.md](./reddit-loid-waf-bypass.md),
  `scripts/engage-diagnose-x-reply.ts`, and `tech-design.md` →
  "Metric fields & the token fallback chain".
