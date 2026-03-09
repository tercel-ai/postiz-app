# Admin API

## Overview

Superadmin-only REST API for managing application settings and AI pricing configuration. All endpoints require `isSuperAdmin = true` on the authenticated user.

## Authentication

All endpoints are behind `AuthMiddleware` (JWT cookie-based). Additionally, each handler checks `user.isSuperAdmin` and returns HTTP 403 if not a superadmin.

### Setting a user as superadmin

```sql
UPDATE "User" SET "isSuperAdmin" = true WHERE email = 'admin@example.com';
```

## Endpoints

### Settings CRUD

#### GET /admin/settings

List settings with pagination and search.

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

#### PUT /admin/settings/:key

Create or update a setting.

Body:
```json
{
  "value": { "any": "json value" },
  "type": "object",
  "description": "Optional description"
}
```

**Note:** Reserved keys (e.g., `ai_model_pricing`) cannot be modified through this endpoint. Use the dedicated `/admin/ai-pricing` endpoint instead. Returns 400 for reserved keys.

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

#### PUT /admin/ai-pricing

Update AI model pricing. Both `text` and `image` entries are required.

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

This endpoint also clears the in-memory pricing cache.

## Key Files

- `apps/backend/src/api/routes/admin.controller.ts`
- `libraries/nestjs-libraries/src/dtos/admin/ai-pricing.dto.ts`
