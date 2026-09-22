# Engage Module — Reply `metrics` Field Reference

**Version**: 1.0
**Date**: 2026-09-22
**Applies to**: the `post.metrics` object on `GET /engage/sent`, `GET /engage/sent/:id`,
`PATCH /engage/sent/:id/metrics`, `GET /engage/dashboard/top-sources`, and the admin sent list.

Source of truth: `normalizeReplyMetrics()`
(`libraries/nestjs-libraries/src/engage/engage-metrics-stats.ts:129`).

`Post.analytics` stores a verbose, platform-shaped `AnalyticsData[]` — an array of
`{ label, percentageChange, data: [{ total, date }] }` whose labels differ per platform and
change whenever a provider renames a counter. `normalizeReplyMetrics` flattens that array into
one stable object so a client can read `metrics.bookmarks` instead of regex-matching labels.
`Post.analytics` itself is left untouched for backward compatibility.

> **The one rule to internalize:** the key set is **platform-shaped**. A platform's branch returns
> only its own keys; every other key is **absent from the JSON entirely** — not `0`, not `null`.
> Never write `metrics.likes.toFixed()` without checking, and never render a missing key as zero.

---

## Response Shape

```jsonc
{
  // ── Always present, on every platform ──
  "trafficScore": 0,          // number — Post.trafficScore, or 0 when null
  "visibility": "unknown",    // 'visible' | 'hidden' | 'removed' | 'unknown'

  // ── X only ──
  "impressions": 0,           // also present on the generic fallback branch
  "likes": 0,
  "retweets": 0,
  "replies": 0,
  "quotes": 0,
  "bookmarks": 0,

  // ── Reddit + Hacker News ──
  "upvotes": 0,               // HN points reuse this key on purpose
  "comments": 0,
  "estReach": 0,              // Reddit only — an ESTIMATE, see below

  // ── Dev.to ──
  "reactions": 0
}
```

The example above is the **X** shape (8 keys). A Reddit reply returns a different five:
`{ trafficScore, visibility, upvotes, comments, estReach }`.

---

## Platform Key Matrix

| Key | `x` | `reddit` | `hackernews` | `devto` | `linkedin` / `medium` / `quora` / unknown |
|---|:--:|:--:|:--:|:--:|:--:|
| `trafficScore` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `visibility` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `impressions` | ✅ | — | — | — | ✅ |
| `likes` | ✅ | — | — | — | — |
| `retweets` | ✅ | — | — | — | — |
| `replies` | ✅ | — | — | — | — |
| `quotes` | ✅ | — | — | — | — |
| `bookmarks` | ✅ | — | — | — | — |
| `upvotes` | — | ✅ | ✅ | — | — |
| `comments` | — | ✅ | ✅ | ⚠️ optional | — |
| `estReach` | — | ✅ | — | — | — |
| `reactions` | — | — | — | ✅ | — |

`platform` comes from `EngageOpportunity.platform`, which is constrained to `SCANNABLE_PLATFORMS`
(`engage-scan-config.service.ts`): `x`, `reddit`, `linkedin`, `devto`, `hackernews`, `medium`,
`quora`. The last column is the **generic fallback branch** — any platform without a dedicated
branch, including a row whose platform could not be resolved (`'unknown'`).

---

## How Each Key Is Derived

Labels are matched **case-insensitively by regex**, so a branch tolerates the label variants
different writers emit (`Likes` from the OAuth provider, `likes` from the extension).

### `x`

| Key | Source |
|---|---|
| `impressions` | **`Post.impressions` column first**; only falls back to the `/impression\|views/i` series when the column is null |
| `likes` | `/like\|reaction/i` |
| `retweets` | `/retweet\|repost/i` |
| `replies` | `/repl/i` |
| `quotes` | `/quote/i` |
| `bookmarks` | `/bookmark\|save/i` |

⚠️ `impressions` preferring the column means it can legitimately differ from what
`Post.analytics` holds — the column is the one a sync writes authoritatively.

### `reddit`

| Key | Source |
|---|---|
| `upvotes` | `/score\|upvote/i` |
| `comments` | `/comment/i` |
| `estReach` | `Post.impressions`; when null, the **estimate `(upvotes + comments) × 20`** |

`estReach` is deliberately named apart from `impressions`: it is a documented Reddit formula, not
a measurement. Do not present it to users as a view count.

### `hackernews`

| Key | Source |
|---|---|
| `upvotes` | `/score\|point/i` |
| `comments` | `/comment/i` |

HN points map onto Reddit's key names on purpose — the two read identically to a human, so the
existing score/comments UI covers HN without a second layout. **No `estReach`**: HN publishes
nothing that would make a reach estimate anything but invented. Before this branch existed, every
HN reply fell to the generic branch and rendered as a flat `impressions: 0`.

### `devto`

| Key | Source |
|---|---|
| `reactions` | `/reaction\|like/i` |
| `comments` | `/comment/i`, read **optionally** — see below |

`reactions` is not folded into `likes` or `upvotes` because it is neither: it is the one
applause-shaped signal a dev.to comment carries.

`comments` uses `getOptional()`, the only key in the whole function that does: a **missing series
stays missing instead of defaulting to 0**. The reply count takes a second HTTP request that can
fail, and an unread count must not report itself as "no replies". Everywhere else a missing series
is a genuine zero, so the plain getter is correct.

No reach figure of any kind — dev.to's `page_views_count` is author-only and article-level, and
Reddit's ×20 estimate is a formula for Reddit, not a licence to invent one here.

### Generic fallback (`linkedin`, `medium`, `quora`, unknown)

`{ trafficScore, visibility, impressions }` — `impressions` reads `Post.impressions`, or `0`.

---

## `visibility`

```ts
type ReplyVisibility = 'visible' | 'hidden' | 'removed' | 'unknown';
```

Read from the `dead` / `deleted` flags the extension's metrics fetchers emit alongside the numbers
(`readVisibility`, `engage-metrics-stats.ts:80`).

| Value | Condition |
|---|---|
| `hidden` | `dead > 0` — the platform killed it (flagged, shadow-removed) |
| `removed` | `deleted > 0` and not `dead` — we removed it |
| `visible` | at least one flag present, neither set |
| `unknown` | **neither flag present** — never checked |

Three things that are easy to get wrong:

1. **`unknown` must NOT render as `visible`.** The flags only exist on rows written by an extension
   build that emits them, so most historical rows carry no answer at all. This distinction is the
   entire point of the field: a platform-killed reply otherwise reads exactly like a healthy one —
   it has a `releaseURL`, its `state` is `PUBLISHED`, and its metrics are merely low. An account
   whose every comment had been flagged into invisibility went forty days without a single signal
   reaching the product.
2. **Labels are matched EXACTLY here**, not by regex like the numeric getters — `/dead/` also
   matches `deleted`, which would report an author-removed item as platform-killed.
3. **`hidden` wins over `removed`** when both are set. They answer different questions and only one
   is actionable: a flagged item says something about the content whether or not we later deleted
   it, while "we removed it" closes the case.

The flags ride through `extractMetrics` **unweighted** and are **kept in `rawMetrics`**, because
`Post.analytics` is the only place `normalizeReplyMetrics` can read them back from.

---

## When Everything Is Zero

An all-zero X object usually means **never successfully synced**, not "nobody engaged". Use
`classifyReplyMetric()` (`engage-metrics-stats.ts:35`) to tell the cases apart:

| Status | Meaning | Fix |
|---|---|---|
| `has_metrics` | `impressions` already populated | nothing to do |
| `no_release_url` | no reply URL ("I'll add the link later") | user backfills via `PATCH /engage/sent/:id/reply-url` |
| `no_integration` | **X only** — `Post` has no connected account, so `checkPostAnalytics` can't read it | run the integration backfill (`backfill-engage-x-integration.ts`) |
| `no_release_id` | **X only** — URL present but no `/status/<id>` parsed | fix the stored URL |
| `syncable` | all prerequisites present, `impressions` still null — the fetch ran and returned nothing | X API tier block / Reddit WAF / not yet run; investigate with `engage-diagnose-x-reply.ts` or `engage-fetch-raw.ts` |

See [`sync-metrics-script.md`](./sync-metrics-script.md) and [`scripts.md`](./scripts.md).

---

## Write Side — Who Produces These Labels

`normalizeReplyMetrics` is a pure read-back. The labels it matches are written by:

| Platform | Server-side sync | Extension submission | Labels written |
|---|---|---|---|
| `x` | `syncXMetrics` (`engage-metrics-sync.ts:380`) | `PATCH /sent/:id/metrics` | `impressions`, `likes`, `replies`, `retweets`, `quotes`, `bookmarks` |
| `reddit` | `syncRedditMetrics` (`:62`) | `PATCH /sent/:id/metrics` | `score`, `comments` |
| `devto` | `syncDevtoMetrics` (`:302`) | `PATCH /sent/:id/metrics` | `reactions` (+ optional `comments`) |
| `hackernews` | — | `POST /posts/metrics/ingest` | `score`, `comments`, `dead`, `deleted` |

`dispatchReplyMetricsSync` (`:451`) routes the server-side path and handles **only** `reddit`, `x`
and `devto`. `buildReplyMetricsFromRaw` (`:527`) turns extension-scraped counters into the same
persisted shape using the **same formulas**, so an extension-sourced refresh is indistinguishable
from a backend-sourced one downstream.

Derived values, identical on both paths:

- Reddit — `impressions = round((score + comments) × 20)`, `trafficScore = score×1 + comments×3`
- Dev.to — `impressions = 0` (deliberate, not an estimate), `trafficScore` via `TRAFFIC_WEIGHTS.devto`
- X — `trafficScore` via the weighted `TRAFFIC_WEIGHTS.x` table; impressions unweighted

Two write-side traps:

1. `RawReplyMetrics.platform` on `PATCH /engage/sent/:id/metrics` accepts **only**
   `'x' | 'reddit' | 'devto'` (`engage-metrics-sync.ts:488`). Hacker News visibility flags arrive
   through the generic `POST /posts/metrics/ingest` instead.
2. Dev.to submits its reaction count in the `likes` field (reusing an existing field rather than
   adding one), and **the server relabels it to `reactions` on the way in**. `likes` is not a key in
   `TRAFFIC_WEIGHTS.devto` and would silently score 0 if it passed through unchanged.

For the per-platform label sets of ordinary (non-Engage) posts, and the `Post` / `PostRelease` /
`DataTicks` storage columns behind all of this, see [`../data-ticks-module.md`](../data-ticks-module.md).

---

## Endpoints Returning This Object

| Endpoint | Where | Source |
|---|---|---|
| `GET /engage/sent` | `items[].post.metrics` | `EngageRepository.listSentReplies` (`engage.repository.ts:4799`) |
| `GET /engage/sent/:id` | `post.metrics` | `getSentReplyItemById` (`:6319`) |
| `PATCH /engage/sent/:id/metrics` | `metrics` | `EngageService.ingestReplyMetrics` (`engage.service.ts:4345`) |
| `GET /engage/dashboard/top-sources` | `items[].post.metrics` | `getDashboardTopSources` (`:6141`) |
| admin sent list | `items[].post.metrics` | `listSentRepliesForAdmin` (`:5201`) |

`top-sources` additionally ranks by `upvotes` for Reddit and `likes` for everything else, with a
missing key ranking as `0` — which is why that one call site reads the keys defensively.
