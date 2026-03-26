# Admin API

## Overview

Superadmin-only REST API for managing application settings and AI pricing configuration. All endpoints require `isSuperAdmin = true` on the authenticated user.

## Authentication

All endpoints are behind `AuthMiddleware` (JWT cookie-based or Bearer token). Additionally, each handler checks `user.isSuperAdmin` and returns HTTP 403 if not a superadmin.

### Setting a user as superadmin

```sql
UPDATE "User" SET "isSuperAdmin" = true WHERE email = 'admin@example.com';
```

## Endpoints

### Settings CRUD

#### GET /admin/settings

List settings with pagination and search. All query params are optional.

| Query Param | Type | Default | Description |
|-------------|------|---------|-------------|
| `page` | number | 1 | Page number (min 1) |
| `pageSize` | number | 20 | Items per page (min 1, max 100) |
| `keyword` | string | - | Search in key and description (case-insensitive) |
| `type` | string | - | Filter by type (string, number, boolean, object, array) |

Response:
```json
{
  "items": [...],
  "total": 42,
  "page": 1,
  "pageSize": 20,
  "totalPages": 3
}
```

#### GET /admin/settings/:key

Get a single setting value.

Response: `{ "key": "my_key", "value": ... }`

Returns 404 if key doesn't exist.

#### POST /admin/settings

Create a new setting. Returns 409 if key already exists.

Body:
```json
{
  "key": "my_key",
  "value": { "any": "json value" },
  "type": "object",
  "description": "Optional description"
}
```

- `key` — required, must not already exist
- `value` — required
- `type`, `description` — optional

**Note:** Reserved keys (e.g., `ai_model_pricing`) cannot be created through this endpoint. Returns 400 for reserved keys.

#### PUT /admin/settings/:key

Update an existing setting. Returns 404 if key doesn't exist.

Body:
```json
{
  "value": { "any": "json value" },
  "type": "object",
  "description": "Optional description"
}
```

- `value` — required
- `type`, `description` — optional

**Note:** Reserved keys (e.g., `ai_model_pricing`) cannot be modified through this endpoint. Returns 400 for reserved keys.

#### DELETE /admin/settings/:key

Delete a setting. Returns 404 if key doesn't exist. Returns 400 for reserved keys.

---

### AI Pricing

#### GET /admin/ai-pricing

Get current AI model pricing configuration.

Response:
```json
{
  "text": {
    "servicer": "openrouter",
    "provider": "openai",
    "model": "gpt-5.1",
    "billing_mode": "per_token",
    "price": 15
  },
  "image": {
    "servicer": "openrouter",
    "provider": "google",
    "model": "gemini-3.1-flash-image-preview",
    "billing_mode": "per_token",
    "price": 4.5
  }
}
```

#### POST /admin/ai-pricing

Create AI model pricing config. Returns 409 if config already exists.

Body: same as PUT (see below).

#### PUT /admin/ai-pricing

Update AI model pricing. Returns 404 if config doesn't exist. Both `text` and `image` entries are required.

Body (validated with `class-validator`):
```json
{
  "text": {
    "servicer": "openrouter",
    "provider": "openai",
    "model": "gpt-5.1",
    "billing_mode": "per_token",
    "price": 15
  },
  "image": {
    "servicer": "openrouter",
    "provider": "google",
    "model": "gemini-3.1-flash-image-preview",
    "billing_mode": "per_token",
    "price": 4.5
  }
}
```

Validation rules:
- `servicer`, `provider`, `model` — required strings
- `billing_mode` — must be `per_token` or `per_image`
- `price` — required number, minimum 0

Both POST and PUT clear the in-memory pricing cache.

---

### Diagnostics

Health check endpoints for monitoring data anomalies.

#### GET /admin/diagnostics/overview

Aggregated health check across all diagnostic categories. Returns a single `healthy` boolean and per-category summaries.

Response:
```json
{
  "checkedAt": "2026-03-17T12:00:00.000Z",
  "healthy": false,
  "recurringPosts": { "recurringPostsCount": 5, "prematureCount": 1, "duplicateCount": 0, "missedCount": 0, "healthy": false },
  "stuckPosts": { "count": 0, "healthy": true },
  "integrations": { "total": 1, "refreshNeeded": 1, "inBetweenSteps": 0, "disabled": 0, "healthy": false },
  "errorPosts": { "count": 3, "healthy": false }
}
```

#### GET /admin/diagnostics/recurring-posts

Checks recurring post anomalies:

| Check | Description | Detection |
|-------|-------------|-----------|
| `prematureClones` | Clone published before its `publishDate` | `publishDate - createdAt > 1 hour` |
| `duplicateClones` | Multiple PUBLISHED clones on the same day | Same `sourcePostId` + same day |
| `missedCycles` | Expected publish date with no clone | Past 7 days, based on `intervalInDays` |

#### GET /admin/diagnostics/stuck-posts

Finds non-recurring QUEUE posts whose `publishDate` passed more than 2 hours ago. These should have been picked up by `missingPostWorkflow`. Excludes recurring posts (they stay QUEUE by design).

#### GET /admin/diagnostics/integrations

Lists unhealthy integrations (`refreshNeeded`, `inBetweenSteps`, or `disabled`) and counts how many QUEUE posts are blocked by each.

#### GET /admin/diagnostics/error-posts

Lists posts with ERROR state from the last 7 days, including error details. Covers both non-recurring errors and recurring clone errors.

---

### Dashboard

Overview and data management for application-wide statistics.

#### GET /admin/dashboard

Get a global overview of the application's health and activity.

**Response Fields:**
- `total_organizations` (number): Total count of organizations in the system.
- `total_posts` (number): Total count of non-deleted, root posts.
- `total_integrations` (number): Total count of non-deleted social media integrations.
- `posts_today` (number): Number of posts created today.
- `errors_last_7d` (number): Number of posts that failed (ERROR state) in the last 7 days.
- `error_rate_7d` (number): Percentage of failed posts over total posts created in the last 7 days (e.g., `1.5` for 1.5%).
- `posts_by_state` (array): Breakdown of posts by their current state.
  - `state` (string): `DRAFT`, `QUEUE`, `PUBLISHED`, or `ERROR`.
  - `count` (number): Number of posts in this state.
- `integrations_by_platform` (array): Breakdown of active integrations by social platform.
  - `platform` (string): The provider identifier (e.g., `twitter`, `linkedin`).
  - `count` (number): Number of connected accounts for this platform.

**Response Example:**
```json
{
  "total_organizations": 150,
  "total_posts": 1250,
  "posts_by_state": [
    { "state": "PUBLISHED", "count": 1000 },
    { "state": "QUEUE", "count": 200 },
    { "state": "DRAFT", "count": 40 },
    { "state": "ERROR", "count": 10 }
  ],
  "total_integrations": 300,
  "integrations_by_platform": [
    { "platform": "linkedin", "count": 150 },
    { "platform": "twitter", "count": 150 }
  ],
  "posts_today": 25,
  "error_rate_7d": 0.8,
  "errors_last_7d": 2
}
```

#### POST /admin/dashboard/data-ticks/backfill

Manually trigger a backfill of daily statistics (DataTicks) for a specific date or date range. This is useful for correcting missing or corrupted historical analytics data.

| Query Param | Type | Required | Description |
|-------------|------|----------|-------------|
| `startDate` | string | Yes | Start date in `YYYY-MM-DD` format. |
| `endDate` | string | No | End date in `YYYY-MM-DD` format. Defaults to `startDate`. |

**Response:**
```json
{
  "backfilled": 10,
  "results": [...]
}
```

---

## Key Files

- `apps/backend/src/admin-api/routes/admin-dashboard.controller.ts`
- `apps/backend/src/admin-api/routes/admin-settings.controller.ts`
- `apps/backend/src/admin-api/routes/admin-diagnostics.controller.ts`
- `libraries/nestjs-libraries/src/dtos/admin/ai-pricing.dto.ts`
- `libraries/nestjs-libraries/src/dtos/admin/settings-body.dto.ts`
- `libraries/nestjs-libraries/src/dtos/admin/settings-query.dto.ts`
