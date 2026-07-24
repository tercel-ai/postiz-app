# Dashboard API Reference

**Base Path**: `/dashboard`
**Source**: [apps/backend/src/api/routes/dashboard.controller.ts](../apps/backend/src/api/routes/dashboard.controller.ts)
**Auth**: All endpoints require a valid session cookie. Every request is scoped to
the caller's current **organization** (`@GetOrgFromRequest`).

This is the full REST reference for the `/dashboard` controller. For the conceptual
model — what "impressions" and "traffic" mean, how metrics are scoped to
Postiz-managed posts, and the known accuracy caveats — see
[dashboard-module.md](./dashboard-module.md) and
[data-ticks-module.md](./data-ticks-module.md).

## Conventions

- **Scope**: All analytics are scoped to **Postiz-managed posts only**, never
  account-level platform data.
- **Project scope** (`projectId`): every endpoint accepts an optional `projectId`
  query param. When supplied, analytics are narrowed to that project:
  - Post-level metrics (post counts, per-platform impressions/traffic totals,
    posts trend, post-engagement) filter on `Post.projectId`.
  - Channel counts and the traffic/impressions time series are scoped to the
    channels **bound** to the project (via `IntegrationProject`, `disabled: false`);
    the DataTicks-backed series (`/traffics`, `/impressions`) resolve the project
    to its bound channel ids internally, since DataTicks has no `projectId` column.
  - A project with **no bound channels** yields empty channel-scoped results
    (e.g. `/traffics` and `/impressions` return `[]`) rather than falling back to
    the whole org.
  - **Billing quota** fields on `/summary` (`published_this_period`,
    `post_send_limit`, `period_end`) remain **organization-level** and are *not*
    affected by `projectId`.
  - Omitting `projectId` returns organization-wide analytics (unchanged behaviour).
- **Timezone**: Date parsing/bucketing uses the request timezone (`@GetTimezone`,
  falls back to the org default). Date strings are parsed to UTC via
  `parseDateToUTC`.
- **`channel` enum** (provider type): `x`, `reddit`, `linkedin`, `linkedin-page`,
  `instagram`, `instagram-standalone`, `facebook`, `youtube`, `tiktok`,
  `pinterest`, `threads`, `mastodon`, `bluesky`, `medium`, `devto`, `hashnode`,
  `wordpress`, `discord`, `slack`, `telegram`, `dribbble`, `kick`, `twitch`,
  `lemmy`, `listmonk`, `gmb`, `wrapcast`, `nostr`, `vk`.
- **Array query params** (`integrationId`, `channel`): accept either a repeated
  param or a single comma-separated string (`?channel=x,reddit`).
- **Date validation**: when both `startDate` and `endDate` are supplied and
  `startDate > endDate`, the endpoint returns **400 Bad Request**
  (`"startDate must be before endDate"`).

---

## Endpoint Index

| Method | Path | Summary |
| --- | --- | --- |
| GET | [`/dashboard/summary`](#get-dashboardsummary) | Headline totals for the org |
| GET | [`/dashboard/posts-trend`](#get-dashboardposts-trend) | Post volume over time |
| GET | [`/dashboard/traffics`](#get-dashboardtraffics) | Weighted traffic score series |
| GET | [`/dashboard/impressions`](#get-dashboardimpressions) | Impressions series |
| GET | [`/dashboard/post-engagement`](#get-dashboardpost-engagement) | Per-post engagement over N days |

---

### GET /dashboard/summary

Headline totals for the org, optionally filtered by date range, integrations, and
channels.

**Query** — `DashboardSummaryQueryDto`:

| Field | Type | Required | Rules |
| --- | --- | --- | --- |
| `projectId` | `string` | no | Scopes analytics to one project (billing quota fields stay org-level). |
| `startDate` | ISO date-time | no | Must be a valid date string. |
| `endDate` | ISO date-time | no | Must be ≥ `startDate` when both set. |
| `integrationId` | `string[]` | no | Max **50** (CSV or repeated). |
| `channel` | `Channel[]` | no | Max **30**, each must be a valid channel (CSV or repeated). |

**Errors**: `400` if `startDate > endDate`.

### GET /dashboard/posts-trend

Post volume bucketed over time.

**Query** — `PostsTrendQueryDto`:

| Field | Type | Default | Rules |
| --- | --- | --- | --- |
| `projectId` | `string` | — | Optional; scopes the trend to one project (`Post.projectId`). |
| `period` | `daily` \| `weekly` \| `monthly` | `daily` | |

### GET /dashboard/traffics

Weighted **traffic** score series (`DataTicks type=traffic`; a weighted sum of
engagement metrics per platform — not raw views). Optionally filtered.

**Query** — `TrafficsQueryDto`:

| Field | Type | Required | Rules |
| --- | --- | --- | --- |
| `projectId` | `string` | no | Scopes to the project's bound channels; no bound channels ⇒ `[]`. |
| `startDate` | ISO date-time | no | |
| `endDate` | ISO date-time | no | Must be ≥ `startDate` when both set. |
| `integrationId` | `string[]` | no | Max **50** (CSV or repeated). Intersected with `projectId`'s channels when both set. |
| `channel` | `Channel[]` | no | Max **30** (CSV or repeated). |

**Errors**: `400` if `startDate > endDate`.

### GET /dashboard/impressions

Impressions (cumulative snapshot metric) series, bucketed by `period` and
optionally filtered.

**Query** — `ImpressionsQueryDto`:

| Field | Type | Default / Rules |
| --- | --- | --- |
| `projectId` | `string` | optional; scopes to the project's bound channels; no bound channels ⇒ `[]` |
| `period` | `daily` \| `weekly` \| `monthly` | default `daily` |
| `startDate` | ISO date-time | optional |
| `endDate` | ISO date-time | optional; must be ≥ `startDate` when both set |
| `integrationId` | `string[]` | optional; max **50** (CSV or repeated) |
| `channel` | `Channel[]` | optional; max **30** (CSV or repeated) |

**Errors**: `400` if `startDate > endDate`.

### GET /dashboard/post-engagement

Per-post engagement over a trailing window of `days`.

**Query** — `PostEngagementQueryDto`:

| Field | Type | Default | Rules |
| --- | --- | --- | --- |
| `projectId` | `string` | — | Optional; scopes to the project's posts + bound channels. |
| `days` | int | `30` | Min **1**, max **90**. |
