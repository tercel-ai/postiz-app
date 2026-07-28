# Posts API Reference

**Base Path**: `/posts`
**Source**: [apps/backend/src/api/routes/posts.controller.ts](../apps/backend/src/api/routes/posts.controller.ts)
**Auth**: All endpoints require a valid session cookie. Every request is scoped to
the caller's current **organization** (resolved via `@GetOrgFromRequest`); a post
that does not belong to the org is treated as not found.

This is the full REST reference for the `/posts` controller (create / schedule /
list / metrics / tags / extension callbacks). For the deep request-body detail of
`POST /posts` (per-provider `settings`, media, thread `value[]`), see
[post-publish-api.md](./post-publish-api.md). For the list/filter/sort semantics of
`GET /posts/list`, see [posts-list-module.md](./posts-list-module.md).

## Conventions

- **`State` enum**: `QUEUE` | `PUBLISHED` | `ERROR` | `DRAFT`.
- **`source` enum** (`Post.source`): `calendar` | `chat` | `engage`.
- **`channel` enum** (provider type): `x`, `reddit`, `linkedin`, `linkedin-page`,
  `instagram`, `instagram-standalone`, `facebook`, `youtube`, `tiktok`,
  `pinterest`, `threads`, `mastodon`, `bluesky`, `medium`, `devto`, `hashnode`,
  `wordpress`, `discord`, `slack`, `telegram`, `dribbble`, `kick`, `twitch`,
  `lemmy`, `listmonk`, `gmb`, `wrapcast`, `nostr`, `vk`.
- **`projectId`**: opaque aisee-core `products.id`. Omitting it preserves legacy,
  non-project behavior (returns every post the caller can already see). When
  present it is authorized against the org by `ProjectAuthGuard` before the
  handler runs.
- **Array query params** (`integrationId`, `channel`, `source`): accept either a
  repeated param or a single comma-separated string (`?channel=x,reddit`).
- **Timezone**: date-bucketing endpoints resolve the request timezone via
  `@GetTimezone` (falls back to the org default).

---

## Publish method & the send queue

The **DB `QUEUE` state is the single source of truth** for what should be sent. A
`QUEUE` post is sent by exactly ONE of two paths, decided once at schedule time
and recorded in `Post.publishMethod`:

| `publishMethod` | Sent by | When |
| --- | --- | --- |
| `API` | The Temporal post workflow (provider backend write API) | Platform has a usable write API **and** a bound OAuth account. |
| `EXTENSION` | The browser extension, in-browser with the user's own session | Platform has no usable write API (hackernews/medium/quora), or an operator/user routed a dual-capable platform (x/reddit/linkedin) to the extension. |

Both send paths read the **same** `publishMethod`, so a post can never be picked
up by both — the structural **double-publish guard**. A second guard exists at
execution time: the API path uses the `releaseId` optimistic claim; the extension
path uses the [publish-due lease](#post-postspublish-due).

`publishMethod` is nullable: when unset, routing falls back to the
platform-capability check (`isExtensionPublishProvider`), preserving legacy
behavior. It is set two ways:

- **Bulk**, for operation-plan drafts: [`POST /posts/schedule`](#post-postsschedule)
  resolves + stamps it while flipping DRAFT → QUEUE (and can set a new schedule
  time per post).
- **Single post**, on the main editor: [`POST /posts/`](#post-posts) accepts an
  optional `posts[].publishMethod` and persists it with the post.

The scheduling UI derives the selectable methods client-side from
[`GET /admin/social-providers`](./admin-api.md) — each provider carries
`extensionPublishable` + `hasWriteApi` static flags — intersected with the org's
own integrations list (a bound account is required for the API path). The backend
still enforces the full rules at commit time (`resolvePublishMethod`), so a bad
client choice is rejected per-post rather than mis-routed.

---

## Endpoint Index

| Method | Path | Summary |
| --- | --- | --- |
| POST | [`/posts/metrics/due`](#post-postsmetricsdue) | Extension: which viewed posts are due a metrics refresh |
| POST | [`/posts/metrics/ingest`](#post-postsmetricsingest) | Extension: submit fetched metrics for viewed posts |
| POST | [`/posts/metrics/backfill`](#post-postsmetricsbackfill) | Deprecated alias of `/metrics/ingest` |
| GET | [`/posts/:id/statistics`](#get-postsidstatistics) | Per-post analytics snapshot |
| POST | [`/posts/should-shortlink`](#post-postsshould-shortlink) | Ask whether messages should be short-linked |
| POST | [`/posts/:id/comments`](#post-postsidcomments) | Add an internal comment to a post |
| GET | [`/posts/tags`](#get-poststags) | List the org's post tags |
| POST | [`/posts/tags`](#post-poststags) | Create a tag |
| PUT | [`/posts/tags/:id`](#put-poststagsid) | Edit a tag |
| GET | [`/posts/`](#get-posts) | Calendar-range posts |
| GET | [`/posts/find-slot`](#get-postsfind-slot) | Next free scheduling slot (org) |
| GET | [`/posts/find-slot/:id`](#get-postsfind-slotid) | Next free slot for one integration |
| GET | [`/posts/release-list`](#get-postsrelease-list) | Paginated release history for a post |
| GET | [`/posts/list`](#get-postslist) | Paginated / filterable / sortable list |
| GET | [`/posts/list/locate`](#get-postslistlocate) | Find which list page a post is on |
| GET | [`/posts/old`](#get-postsold) | Posts older than a date |
| GET | [`/posts/group/:group`](#get-postsgroupgroup) | All posts in a group |
| GET | [`/posts/:id`](#get-postsid) | Single post |
| POST | [`/posts/`](#post-posts) | Create / schedule / publish post(s) |
| POST | [`/posts/generator/draft`](#post-postsgeneratordraft) | Generate draft posts (AI) |
| POST | [`/posts/generator`](#post-postsgenerator) | Streaming AI post generation |
| DELETE | [`/posts/:group`](#delete-postsgroup) | Delete a post group |
| POST | [`/posts/:id/retry`](#post-postsidretry) | Retry a failed post |
| PUT | [`/posts/:id/date`](#put-postsiddate) | Reschedule a post |
| POST | [`/posts/separate-posts`](#post-postsseparate-posts) | Split long content into a thread |
| POST | [`/posts/schedule`](#post-postsschedule) | Commit DRAFT posts to the send queue (DRAFT → QUEUE) |
| PATCH | [`/posts/:id/extension-published`](#patch-postsidextension-published) | Extension publish-on-success callback |
| POST | [`/posts/publish-due`](#post-postspublish-due) | Extension: claim due QUEUE posts to publish in-browser (leased) |
| POST | [`/posts/sync-metrics`](#post-postssync-metrics) | Sync raw external metrics for one post |

---

## Metrics (browser-extension demand-driven fetch)

These three endpoints implement the "server schedules, extension executes" metrics
loop. See [engage/extension-demand-driven-fetch.md](./engage/extension-demand-driven-fetch.md)
for the full protocol. They cover both own posts and Engage replies (both are
`Post` rows).

### POST /posts/metrics/due

Given the post ids the extension is currently viewing (one page), return only the
subset **due** for a refresh — inside the org's monitoring window and past the
fetch interval (the "visible ∩ due" intersection). The server makes no provider
call here.

**Body** — `MetricsDueDto`:

| Field | Type | Required | Rules |
| --- | --- | --- | --- |
| `ids` | `string[]` | yes | Non-empty, max **100** post ids. |

**Response**:

```json
{ "windowDays": 7, "intervalHours": 6, "due": ["postId1", "postId2"] }
```

`windowDays` / `intervalHours` come from the org's per-plan Engage entitlements;
`due` is the subset of `ids` to fetch now.

### POST /posts/metrics/ingest

Pure **data submission**: the extension read metrics on the user's own platform
session and submits them; the server persists (no provider API call). Platform is
resolved server-side from each post's ownership. Runs the same extract/traffic
pipeline as the OAuth analytics sync, stores impressions/traffic/snapshot, and
stamps `lastMetricsFetchAt` so the interval gate holds.

**Body** — `MetricsIngestDto`:

| Field | Type | Required | Rules |
| --- | --- | --- | --- |
| `items` | `MetricsIngestItem[]` | yes | Non-empty, max **100** items. |
| `items[].postId` | `string` | yes | Post id. |
| `items[].analytics` | `AnalyticsData[]` | yes | Max **32** metric series. |
| `items[].analytics[].label` | `string` | yes | Metric name (e.g. `impressions`). |
| `items[].analytics[].data` | `AnalyticsPoint[]` | yes | Max **64** points. |
| `items[].analytics[].data[].total` | `string \| number` | yes | Coerced with `Number()`. |
| `items[].analytics[].data[].date` | `string` | yes | Point date. |
| `items[].analytics[].percentageChange` | `number` | no | Optional. |

### POST /posts/metrics/backfill

**Deprecated.** Identical behavior to `POST /posts/metrics/ingest` (same
`MetricsIngestDto`). Kept only so already-deployed extension builds keep working;
remove once old builds are phased out.

---

## Read

### GET /posts/:id/statistics

Per-post analytics snapshot for post `:id` (org-scoped).

- **Path**: `id` — post id.
- **Response**: the post's stored statistics object.

### GET /posts/

Posts within a calendar date range (used by the calendar view).

**Query** — `GetPostsDto`:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `startDate` | ISO date-time | yes | Range start. |
| `endDate` | ISO date-time | yes | Range end. |
| `display` | `day` \| `week` \| `month` | no | Bucketing hint. |
| `customer` | `string` | no | Filter by customer. |
| `projectId` | `string` | no | Scope to an aisee project. |
| `operationPlanId` | `string` | no | Only posts from one OperationPlan. |
| `state` | `State` | no | `QUEUE` / `PUBLISHED` / `ERROR` / `DRAFT`. |
| `source` | `PostSource[]` | no | `calendar` / `chat` / `engage` (CSV ok). |
| `integrationId` | `string[]` | no | Max 50 (CSV ok). |
| `channel` | `Channel[]` | no | Max 30 (CSV ok). |

**Response**: `{ "posts": [ ... ] }`.

### GET /posts/list

Paginated, filterable, sortable list. Full semantics in
[posts-list-module.md](./posts-list-module.md).

**Query** — `GetPostsListDto`:

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `page` | int ≥ 1 | `1` | |
| `pageSize` | int 1–100 | `20` | |
| `state` | `State` | — | |
| `integrationId` | `string[]` | — | CSV ok. |
| `channel` | `Channel[]` | — | Max 30, CSV ok. |
| `sourcePostId` | `string` | — | |
| `projectId` | `string` | — | |
| `operationPlanId` | `string` | — | |
| `source` | `PostSource[]` | — | CSV ok. |
| `view` | `templates` \| `timeline` | `timeline` | |
| `sortBy` | `publishDate` \| `createdAt` \| `updatedAt` \| `state` | `publishDate` | |
| `sortOrder` | `asc` \| `desc` | `desc` | |

**Response**: `{ "total": number, "posts": [ ... ] }`.

### GET /posts/list/locate

Locate which `/posts/list` page a given `postId` falls on, using the **same**
filters/sort. Returns a null page if the post doesn't match the filters.

**Query** — `LocatePostInListDto`: same fields as `GetPostsListDto` **plus**
required `postId` (and no `page`).

**Response**:

```json
{ "found": true, "page": 3, "position": 12, "total": 240, "pageSize": 20, "totalPages": 12 }
```

### GET /posts/release-list

Paginated release (publish-attempt) history for one post.

**Query** — `GetPostReleasesDto`:

| Field | Type | Default | Rules |
| --- | --- | --- | --- |
| `postId` | `string` | — | Required, non-empty. |
| `page` | int ≥ 1 | `1` | |
| `pageSize` | int 1–100 | `20` | |

### GET /posts/old

Posts older than a given date.

- **Query**: `date` (`string`) — cutoff date.

### GET /posts/group/:group

All posts belonging to one group.

- **Path**: `group` — group id.

### GET /posts/:id

A single post.

- **Path**: `id` — post id.
- **Query**: `projectId` (optional) — scope to an aisee project.

### GET /posts/find-slot

Next free scheduling date/time for the org.

- **Query**: `projectId` (optional) — when set, posting-time slots are read from
  the per-project `IntegrationProject` binding only (see
  [integration-schedule-rules.md → Project-Scoped Schedules](./integration-schedule-rules.md#project-scoped-schedules-integrationproject)).
  Omitted → org-level `Integration.postingTimes`.
- **Response**: `{ "date": "<ISO>" }`.

### GET /posts/find-slot/:id

Next free slot restricted to one integration.

- **Path**: `id` — integration id.
- **Query**: `projectId` (optional) — scope slots to that project's binding for
  this integration (no fallback to the org-level schedule).
- **Response**: `{ "date": "<ISO>" }`.

### GET /posts/tags

List the org's post tags.

**Response**: `{ "tags": [ ... ] }`.

---

## Write

### POST /posts/

Create one or more posts as a **draft**, a **scheduled** post, or an **immediate
publish**. A single request can target multiple integrations. Guarded by
`@CheckPolicies([Create, POSTS_PER_MONTH])` (subscription quota).

**Body** — `CreatePostDto` (summary; full per-provider detail in
[post-publish-api.md](./post-publish-api.md)):

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `type` | `draft` \| `schedule` \| `now` | yes | Publish mode. |
| `date` | ISO date-time | yes | Scheduled time (also required for `now`/`draft`). |
| `shortLink` | `boolean` | yes | Apply short-linking. |
| `tags` | `{ value, label }[]` | yes | May be empty array. |
| `posts` | `Post[]` | yes¹ | ≥1; each has `integration.id`, `value[]` (content + media), optional `group`, provider `settings`, optional `publishMethod` (`extension` \| `api` — explicit send path; validated against the platform + bound account, persisted on the post; omit to fall back to the capability check). |
| `projectId` | `string` | no | aisee project scope. |
| `source` | `PostSource` | no | `calendar` / `chat` / `engage`. |
| `order` | `string` | no | Ordering hint. |
| `inter` | `number` | no | Inter-post delay. |

¹ `posts` is required unless `type === 'draft'`.

**Response**: array of `{ postId, integration, state, releaseURL? }`.

### POST /posts/generator/draft

Generate draft posts from a prompt (non-streaming). Guarded by
`@CheckPolicies([Create, POSTS_PER_MONTH])`.

- **Body**: `CreateGeneratedPostsDto`.

### POST /posts/generator

Streaming AI post generation. Responds with `application/json; charset=utf-8` as a
stream of newline-delimited JSON events (`AgentGraphService.start`). Guarded by
`@CheckPolicies([Create, POSTS_PER_MONTH])`.

- **Body**: `GeneratorDto`.

### POST /posts/should-shortlink

Ask whether a set of messages should be short-linked (LinkedIn heuristic).

- **Body**: `{ "messages": string[] }`.
- **Response**: `{ "ask": boolean }`.

### POST /posts/:id/comments

Add an internal comment to a post.

- **Path**: `id` — post id.
- **Body**: `{ "comment": string }`.

### POST /posts/tags

Create a tag.

- **Body** — `CreateTagDto`: `{ "name": string, "color": string }`.

### PUT /posts/tags/:id

Edit a tag.

- **Path**: `id` — tag id.
- **Body** — `CreateTagDto`: `{ "name": string, "color": string }`.

### POST /posts/:id/retry

Retry a failed (`ERROR`) post.

- **Path**: `id` — post id.

### PUT /posts/:id/date

Reschedule a post.

- **Path**: `id` — post id.
- **Body**: `{ "date": string }` (ISO date-time).

### POST /posts/separate-posts

Split long content into thread-sized segments.

- **Body**: `{ "content": string, "len": number }` — `len` is the per-segment
  character limit.

### POST /posts/schedule

Commit a batch of `DRAFT` posts to the send queue (`DRAFT → QUEUE`). This is the
single entry point that turns generated / operation-plan drafts into work the
send paths pick up, and where the **send-path decision is made once per post**
(the double-publish guard — see [Publish method & the send queue](#publish-method--the-send-queue)):

- Each post's `publishMethod` (`extension` | `api`) is resolved from platform
  capability + whether an account is bound + the caller's optional `publishMethod`
  choice, then stamped on the post **and its thread chain** (group-scoped flip).
- `api` posts additionally start their Temporal workflow; `extension` posts just
  stay `QUEUE` for the extension [publish-due](#post-postspublish-due) loop.
- Each post keeps its already-scheduled `publishDate` unless the item carries a
  new `date` (per-post — a batch can commit different posts at different times);
  a past date simply makes it due immediately. A new `date` applies group-wide
  (the post's whole thread chain).
- Partial success: each post is scheduled independently — one unschedulable post
  never blocks the rest.

- **Body** — `SchedulePostsDto`:

```jsonc
{
  "posts": [
    {
      "id": "<post-uuid>",
      "publishMethod": "extension" | "api",   // optional → auto-resolve
      "date": "2026-08-01T09:00:00.000Z"       // optional ISO → override this post's publishDate
    }
  ]
}
```

- **Response**:

```jsonc
{
  "scheduled": [ { "id": "<post-uuid>", "publishMethod": "extension" | "api" } ],
  "failed":    [ { "id": "<post-uuid>", "code": "<code>", "message": "<human text>" } ]
}
```

| `failed[].code` | Meaning |
| --- | --- |
| `ACCOUNT_BINDING_REQUIRED` | `api` chosen (or the only viable path) but no bound account for the platform. |
| `PLATFORM_NOT_EXTENSION_PUBLISHABLE` | `extension` chosen for a platform the extension can't publish. |
| `NOT_FOUND` | Post not found in this org. |
| `INVALID_STATE` | Post is not `DRAFT` (and not an idempotent already-`QUEUE`/`PUBLISHED`). |

An already-`QUEUE`/`PUBLISHED` post is an idempotent success (returned under `scheduled`, no re-flip).

> **Rendering the method choice (client-side).** There is no dedicated capability
> endpoint. The UI derives selectable methods from
> [`GET /admin/social-providers`](./admin-api.md) (each provider's
> `extensionPublishable` + `hasWriteApi` static flags) intersected with the org's
> integrations list (a bound account enables the API path). `resolvePublishMethod`
> on the backend is the authority — a bad choice comes back in `failed[]`.

### DELETE /posts/:group

Delete a whole post group.

- **Path**: `group` — group id.

---

## Extension callbacks

### PATCH /posts/:id/extension-published

Publish-on-success callback: the browser extension published this post in-browser
(X / Reddit) with the user's own platform session and reports the permalink back.
The server flips the post to `PUBLISHED` and backfills `releaseURL` / `releaseId`.
Org-scoped and idempotent.

- **Path**: `id` — post id.
- **Body** — `MarkExtensionPublishedDto`:

| Field | Type | Required | Rules |
| --- | --- | --- | --- |
| `releaseURL` | `string` | yes | Permalink; max 2048 chars. |
| `releaseId` | `string` | no | Platform post id (Reddit `t3_*` / X `rest_id`); max 512. |

### POST /posts/publish-due

The browser extension polls this for `QUEUE` posts due to publish in-browser
(backend = scheduler, extension = executor — the backend makes no provider API
call here). Returns single-segment, due (`publishDate <= now`) roots whose send
path resolves to the extension (explicit `publishMethod = EXTENSION`, or the
legacy fallback: an extension-routed integration with `publishMethod` unset).
Recurring originals are excluded (they publish via the Temporal-only
clone-per-cycle path).

**Lease.** Each returned post is atomically **claimed** for a lease window: it is
stamped with a unique token (`releaseId`) + `claimedAt = now` and is not re-offered
until the lease expires (`now − EXTENSION_PUBLISH_LEASE_MINUTES`, default 10). This
stops two browser instances — or the same instance after an uninstall/reinstall —
from both claiming and double-publishing the same post. A successful
[extension-published](#patch-postsidextension-published) backfill leaves `QUEUE`
(overwriting `releaseId`), releasing the lease; a crashed publish is re-offered
only after the lease expires.

- **Body**: `{ "limit"?: number }` (default 10, clamped to `[1, 50]`).
- **Response**:

```jsonc
{
  "due": [
    {
      "id": "<post-uuid>",              // taskId — the extension backfills the SAME row
      "platform": "hackernews",         // integration.providerIdentifier, else settings.__type
      "title": "…",                     // optional (article/story platforms)
      "subreddit": [ /* … */ ],         // optional (reddit publishing header)
      "segments": [ { "text": "…" } ],
      "publishDate": "2026-07-27T00:00:00.000Z"
    }
  ]
}
```

Cadence: the extension polls this on its own 2-min alarm (`aisee-publish-poll`),
and immediately on the `aisee:post-publish` sync trigger (see
[Extension Post-Publish Protocol](./extension-post-publish-protocol.md)).

### POST /posts/sync-metrics

Sync raw external metrics for one post identified by its platform + external id.
The server normalizes and persists them.

- **Body**:

```json
{ "platform": "x", "externalPostId": "1234567890", "metrics": { "impressions": 1000 } }
```

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `platform` | `string` | yes | Provider identifier. |
| `externalPostId` | `string` | yes | Platform-side post id. |
| `metrics` | `Record<string, number>` | no | Raw counters; defaults to `{}`. |
