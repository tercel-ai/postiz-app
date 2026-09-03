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
  `lemmy`, `listmonk`, `gmb`, `wrapcast`, `nostr`, `vk`, `quora`, `hackernews`
  (no hyphen — values equal the provider `identifier` strings).
- **`projectId`**: opaque aisee-core `products.id`. Omitting it preserves legacy,
  non-project behavior (returns every post the caller can already see). When
  present it is authorized against the org by `ProjectAuthGuard` before the
  handler runs.
- **Array query params** (`integrationId`, `channel`, `source`): accept either a
  repeated param or a single comma-separated string (`?channel=x,reddit`).
- **`channel` filtering** (`GET /posts`, `GET /posts/list`,
  `GET /posts/list/locate`): filters on the persisted **`Post.providerIdentifier`**
  column directly — no join against `Integration`, and it therefore also matches
  **accountless** posts (`integrationId` null, e.g. extension-published
  operation-plan posts), which the old relation-based filter silently excluded.
- **Timezone**: date-bucketing endpoints resolve the request timezone via
  `@GetTimezone` (falls back to the org default).

---

## Reading a post back for editing (`editable`)

`GET /posts/:id` and `GET /posts/group/:group` return the stored rows under
`posts`, which is a **different shape from what `POST /posts` accepts** and is
not meant to be sent back verbatim:

- read `posts[]` = one entry per **post in the chain** (a thread segment);
  write `posts[]` = one entry per **channel**, with the chain in `value[]`
- each read row carries runtime state (`state`, `releaseURL`, `error`,
  `impressions`, `analytics`, …) that the write DTO has no field for
- `settings` is a JSON **string** on each row; the write path wants an object
- `integration` reads back as a bare id **string**; the write path wants `{ id }`
- `publishMethod` is persisted uppercase; the write path accepts lowercase

Both responses therefore also include **`editable`** — the same post already
converted into a valid `CreatePostDto`. Send it to `POST /posts` as-is, or
override `type` (it is derived from the row's state: `DRAFT` → `draft`,
otherwise `schedule`; use `now` to publish immediately).

```jsonc
{
  "group": "...",
  "posts": [ /* stored rows, unchanged */ ],
  "integration": null,
  "settings": { "__type": "x" },
  "editable": {
    "type": "draft",
    "date": "2026-09-03T07:36:00.000Z",
    "shortLink": false,
    "tags": [],
    "source": "calendar",
    "posts": [{
      "providerIdentifier": "x",
      "settings": { "__type": "x" },
      "value": [
        { "id": "cmtl7ogyy0001qmtj89zns9jr", "content": "anchor", "image": [] },
        { "id": "cmtl8abcd0002qmtj89zns9jr", "content": "follow-up", "image": [] }
      ]
    }]
  }
}
```

> **`value[].id` is load-bearing.** `createOrUpdatePost` upserts on
> `value.id || uuidv4()`, so a payload that drops the ids does not update the
> chain — it silently creates a second one, and a 4-part thread edited once
> becomes 8 rows. `editable` always carries them.

`shortLink` is always `false` here: the stored content already has its links
shortened, so re-submitting with `true` would shorten them again.

## Publish method & the send queue

The **DB `QUEUE` state is the single source of truth** for what should be sent. A
`QUEUE` post is sent by exactly ONE of two paths, decided once at schedule time
and recorded in `Post.publishMethod`:

| `publishMethod` | Sent by | When |
| --- | --- | --- |
| `API` | The Temporal post workflow (provider backend write API) | Explicitly chosen, on a platform with a usable write API **and** a bound OAuth account. |
| `EXTENSION` | The browser extension, in-browser with the user's own session | Explicitly chosen, **or** the post made no choice — see the default below. |

Both send paths read the **same** `publishMethod`, so a post can never be picked
up by both — the structural **double-publish guard**. A second guard exists at
execution time: the API path uses the `releaseId` optimistic claim; the extension
path uses the [publish-due lease](#post-postspublish-due).

`publishMethod` is nullable. **When unset, the post goes to the extension** for
every platform the extension can actually publish — `x`, `reddit`, `linkedin`,
`hackernews`, `medium`, `quora`, `devto` (`isExtensionPublishProvider`). The
in-browser session path is the product direction and the API path is slated for
removal, so a post that does not choose gets the extension.

Platforms outside that list (instagram, facebook, mastodon, …) are **never**
diverted and keep the backend API path regardless — routing them to an executor
that cannot publish them would strand their posts in `QUEUE` with nothing to send
them. This intersection is a hard guard, not a preference.

`DEFAULT_PUBLISH_METHOD=api` restores the previous default (divert only
hackernews/medium/quora, plus anything named in the legacy additive allowlist
`EXTENSION_PUBLISH_PLATFORMS`). It is the operational escape hatch for an
extension fleet that is down: without it, unchosen posts wait in `QUEUE` for a
browser that is not coming. An explicit `publishMethod` on a post always wins
over this default either way.

`publishMethod` is set two ways:

- **Bulk**, for hand-picked drafts: [`POST /posts/schedule`](#post-postsschedule)
  resolves + stamps it while flipping DRAFT → QUEUE (and can set a new schedule
  time per post).
- **Single post**, on the main editor: [`POST /posts/`](#post-posts) accepts an
  optional `posts[].publishMethod` and persists it with the post.

The scheduling / editor UI asks
[`GET /posts/publish-methods`](#get-postspublish-methods) which methods are
selectable. That endpoint is **org-scoped** (any signed-in user) and returns the
RESOLVED answer for every platform — capability depends on both the platform and
whether THIS org has a bound account, and it applies the same
`resolvePublishMethod` rules the commit enforces, so the UI can never offer a
choice that would be rejected and no rule logic is duplicated client-side. It is
org-level state, so fetch it **once and cache it** (like `GET /engage/config`) —
not per post or per keystroke.

> `GET /admin/social-providers` also carries `extensionPublishable` + `hasWriteApi`
> static flags, but it is **superadmin-only** and cannot answer the per-org half
> ("is an account bound?") — do not use it for the user-facing picker.

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
| DELETE | [`/posts/id/:id`](#delete-postsidid) | Delete a single post by id |
| POST | [`/posts/:id/retry`](#post-postsidretry) | Retry a failed post |
| PUT | [`/posts/:id/date`](#put-postsiddate) | Reschedule a post |
| POST | [`/posts/separate-posts`](#post-postsseparate-posts) | Split long content into a thread |
| POST | [`/posts/schedule`](#post-postsschedule) | Commit hand-picked DRAFT posts to the send queue (DRAFT → QUEUE) |
| GET | [`/posts/publish-methods`](#get-postspublish-methods) | Per-platform send-path capability for the UI (org-scoped, cacheable) |
| PATCH | [`/posts/:id/extension-published`](#patch-postsidextension-published) | Extension publish-on-success callback |
| PATCH | [`/posts/:id/extension-publish-failed`](#patch-postsidextension-publish-failed) | Extension publish-failed callback (carries partial thread success) |
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
| `hasOperationPlan` | `boolean` | no | Presence filter on `operationPlanId`: `true` = plan-generated only, `false` = plan-less only. Omit for both. Ignored when `operationPlanId` is set. |
| `state` | `State` | no | `QUEUE` / `PUBLISHED` / `ERROR` / `DRAFT`. |
| `source` | `PostSource[]` | no | `calendar` / `chat` / `engage` (CSV ok). |
| `integrationId` | `string[]` | no | Max 50 (CSV ok). |
| `channel` | `Channel[]` | no | Max 30 (CSV ok). Filters `Post.providerIdentifier` directly (matches accountless posts too — see Conventions). |

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
| `channel` | `Channel[]` | — | Max 30, CSV ok. Filters `Post.providerIdentifier` directly (matches accountless posts too — see Conventions). |
| `sourcePostId` | `string` | — | |
| `projectId` | `string` | — | |
| `operationPlanId` | `string` | — | |
| `hasOperationPlan` | `boolean` | — | Presence filter on `operationPlanId`: `true` = plan-generated only, `false` = plan-less only. Omit for both. Ignored when `operationPlanId` is set. |
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
| `posts` | `Post[]` | yes¹ | ≥1; each has `value[]` (content + media), provider `settings`, optional `group`, optional `publishMethod` (`extension` \| `api` — explicit send path; validated against the platform + bound account, persisted on the post; omit to fall back to the capability check), and **either** `integration.id` **or** an explicit platform via `providerIdentifier` (legacy alias: `settings.__type`)². |
| `projectId` | `string` | no | aisee project scope. |
| `source` | `PostSource` | no | `calendar` / `chat` / `engage`. |
| `order` | `string` | no | Ordering hint. |
| `inter` | `number` | no | Inter-post delay. |

¹ `posts` is required unless `type === 'draft'`.

² `integration` is **optional**: `Post.integrationId` is nullable, and an
operation-plan post for a platform the org has not connected is created without
one — it is published in-browser by the extension, which resolves the platform
from the persisted **`Post.providerIdentifier`** column. That column is the
source of truth for platform routing, resolved once at write time: when an
`integration.id` is given, `mapTypeToPost` overwrites it (and `settings.__type`)
from the bound account; when there is no account, the request's
`providerIdentifier` is persisted, falling back to `settings.__type` for
back-compat. A post with neither is rejected
(`400 A post must have either an integration id or a providerIdentifier`).
`settings.__type` itself remains only as the provider-settings discriminator.
Note the consequence for an accountless post: only the extension can publish it,
so an explicit `publishMethod: "api"` is rejected, and a platform the extension
cannot publish lands in `ERROR` at publish time.

**Response**: array of `{ postId, integration, state, releaseURL? }`, where
`integration` is `null` for a post with no bound account.

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

Commit a batch of hand-picked `DRAFT` posts to the send queue (`DRAFT → QUEUE`),
and the place where the **send-path decision is made once per post** (the
double-publish guard — see [Publish method & the send queue](#publish-method--the-send-queue)):

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

> **Committing a whole operation plan** ("activate this plan") is
> [`POST /projects/:projectId/automation/publishing`](./automation-api.md#post-projectsprojectidautomationpublishing)
> with `commit: true`, **not** this route. It used to be a `planId` form here,
> which put a project-scoped action in an org-scoped body: with no `projectId`
> anywhere in the request, the global `ProjectAuthGuard` never fired, so nothing
> checked the plan belonged to a project the caller was acting on — and a
> deactivated project could still be made to queue posts. The Automation route
> names its project in the path and resolves the plan **server-side**, so a
> client cannot name a plan at all.

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

> **Rendering the method choice.** Fetch
> [`GET /posts/publish-methods`](#get-postspublish-methods) once and cache it;
> `resolvePublishMethod` on the backend remains the authority — a bad choice comes
> back in `failed[]`.

### GET /posts/publish-methods

Which send paths are selectable, per platform, for the current org. Use it to
render the publish-method choice in the editor / scheduling UI before committing
via [`POST /posts/schedule`](#post-postsschedule) or `posts[].publishMethod` on
[`POST /posts/`](#post-posts).

- **No parameters.** Returns an entry for **every registered platform**.
- **Org-scoped** — any signed-in user (unlike the superadmin-only
  [`GET /admin/social-providers`](./admin-api.md), which is static and cannot say
  whether *this* org has a bound account).
- Pure read of org-level state → **fetch once and cache** (same usage shape as
  `GET /engage/config`), not per post or per keystroke.

**Response**:

```jsonc
[
  {
    "platform": "x",
    "extensionCapable": true,          // the extension can publish it in-browser
    "apiCapable": true,                // a non-disabled account is bound AND the platform has a write API
    "hasBoundIntegration": true,
    "methods": ["extension", "api"],   // selectable methods (render these)
    "defaultMethod": "extension",      // what auto-resolve picks (both-capable → extension)
    "reason": "ACCOUNT_BINDING_REQUIRED" // ONLY when methods is empty — why it's unavailable
  }
]
```

Rules mirror `resolvePublishMethod` exactly: extension-only platforms
(hackernews / medium / quora — no backend write API) → `["extension"]`; platforms
with a write API **and** a bound account also offer `"api"`; a platform with
neither viable path → `methods: []` plus `reason`.

### DELETE /posts/:group

Delete a whole post group.

- **Path**: `group` — group id.

### DELETE /posts/id/:id

Delete a single post by id, without touching other posts in the same group.
Terminates any running Temporal workflow for that post, same as the
group-delete path.

- **Path**: `id` — post id.

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
| `releaseURL` | `string` | no | Permalink of the **anchor**; max 2048 chars. Omitted for a confirmed URL-less publish (e.g. Quora) — the post still flips `PUBLISHED` so it leaves `QUEUE`. |
| `releaseId` | `string` | no | Platform post id (Reddit `t3_*` / X `rest_id`); max 512. |
| `segments` | `PublishedSegment[]` | no | Per-segment results for a **thread** (see below). |

**`segments` (threads).** The two fields above describe the anchor only, so
without this every follow-up segment is stored `PUBLISHED` with no URL — on every
successful thread, not just a failing one — and is therefore never eligible for
metrics. Each entry:

| Field | Type | Required | Rules |
| --- | --- | --- | --- |
| `postId` | `string` | yes | **Our** Post id for this segment, echoed from the due-item's `segments[].postId`. |
| `url` | `string` | no | This segment's permalink; max 2048. |
| `releaseId` | `string` | no | This segment's platform post id; max 512. |

Segments are settled **by id, never by position**: a thread is offered and settled
across a network hop and a lease window (minutes), during which the chain can
change (an edit, a plan re-materialize, a soft-delete). A positional match would
then stamp a live permalink onto the wrong row. Reported ids are intersected with
the chain's real children, so an id outside it is ignored.

Optional for version skew — an older extension omits it and the follow-ups keep
the URL-less treatment.

### PATCH /posts/:id/extension-publish-failed

Publish-**failed** callback: the in-browser send settled as an error (platform
rejected it, wrong account, or the send could not be verified), so the row flips
`QUEUE → ERROR` with the reason instead of sitting in `QUEUE` to be re-offered on
every poll. Org-scoped; a row already `PUBLISHED` is never touched, and recurring
originals keep their clone-per-cycle mechanism.

- **Path**: `id` — post id (the thread's **anchor**).
- **Body** — `MarkExtensionPublishFailedDto`:

| Field | Type | Required | Rules |
| --- | --- | --- | --- |
| `error` | `string` | no | Reason; max 2048. Defaults to `extension publish failed`. |
| `segments` | `PublishedSegment[]` | no | Segments that **did** publish before the failure (same shape as above). |

**Partial success is the normal shape of a thread failure.** Segments publish one
at a time and the run stops at the first failure, so the anchor is usually already
live. When `segments` is present:

- the segments it names are recorded `PUBLISHED` with their own permalinks —
  including the **anchor**, which is therefore *not* flipped to `ERROR`;
- only the remaining chain nodes become `ERROR`.

This matters because marking a live post `ERROR` drops it out of every metrics
path permanently: the permalinks exist only in the extension's queue state, which
is discarded when the task settles.

- **Response**: `{ ok: true }`, or `{ ok: true, partial: true, published: <n> }`
  when segments were reported. Failure shapes: `{ ok: false, reason }` with
  `not-found` / `already-published` / `blocked-recurring-original`.

An absent or empty `segments` means nothing went out (the classic total failure) —
also what an older extension sends, which keeps the previous all-or-nothing
behaviour.

### POST /posts/publish-due

The browser extension polls this for `QUEUE` posts due to publish in-browser
(backend = scheduler, extension = executor — the backend makes no provider API
call here). Returns due (`publishDate <= now`) **roots** whose send path resolves
to the extension (explicit `publishMethod = EXTENSION`, or the legacy fallback: an
extension-routed integration with `publishMethod` unset). Recurring originals are
excluded (they publish via the Temporal-only clone-per-cycle path).

**Threads.** A root with a thread chain is returned as ONE multi-segment item —
its children are never offered on their own (which is also why they cannot be
claimed twice). The chain is assembled by walking `parentPostId` from the anchor,
so a row that shares the group but is unreachable from it is never included.
Media is carried on the **anchor segment only**: every platform's thread
continuation is a reply/comment whose poster takes text alone, and the extension
rejects an item carrying images past segment 0 — a rejected item never leaves
`QUEUE`, so it would be re-offered forever.

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
      "platform": "hackernews",         // persisted Post.providerIdentifier
      "title": "…",                     // optional (article/story platforms)
      "subreddit": [ /* … */ ],         // optional (reddit publishing header)
      "segments": [                     // [0] = anchor; [1..] = thread chain, in publish order
        { "postId": "<post-uuid>", "text": "…", "images": ["https://…"] },
        { "postId": "<post-uuid>", "text": "…" }   // continuations are text-only
      ],
      "publishDate": "2026-07-27T00:00:00.000Z"
    }
  ]
}
```

`segments[].postId` is our Post id for that segment. The extension echoes it back
on both settle callbacks so each segment is recorded against the right row by
identity — see
[extension-published](#patch-postsidextension-published).

Cadence: the extension polls this on its own 1-min alarm (`aisee-publish-poll`),
and immediately on the `aisee:post-publish` sync trigger (see
[Extension Post-Publish Protocol](./extension-post-publish-protocol.md)).

**The Automation switches are not consulted here.** This query reads neither the
project's master switch, nor its scheduled-publishing switch, nor its
per-platform policy — those gate `DRAFT → QUEUE` only — and it is org-scoped
rather than project-scoped. A post that has reached `QUEUE` goes out regardless
of what the owning project's switches say afterwards. There is also **no lower
bound** on `publishDate`: overdue by any amount is still due. For the full chain
from generation to publish, see
[Post lifecycle: DRAFT → QUEUE → PUBLISHED](./post-lifecycle-draft-to-published.md).

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
