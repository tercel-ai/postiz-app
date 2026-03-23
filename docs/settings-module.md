# Settings Module

## Overview

Generic key-value configuration store backed by the `Settings` table in PostgreSQL. Supports any JSON-compatible value type. Designed to be a unified place for application configuration, similar to aisee_orchestrator's `config_service`.

## Database Schema

```prisma
model Settings {
  id          String   @id @default(uuid())
  key         String   @unique
  type        String   @default("string") // string, number, boolean, object, array
  required    Boolean  @default(false)
  description String?
  value       Json?
  default     Json?    @map("default_value")
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}
```

## Service API

### SettingsService

| Method | Description |
|--------|-------------|
| `get<T>(key)` | Get value by key (falls back to default if value is null) |
| `set(key, value, options?)` | Create or update a setting |
| `delete(key)` | Delete a setting (returns `boolean`) |
| `listByPrefix(prefix)` | List all settings with key starting with prefix |
| `paginate({ page, pageSize, keyword, type })` | Paginated query with search |

### SettingsRepository

Handles all Prisma operations. Uses `upsert` for set, `deleteMany` for safe delete (no throw on missing key).

## Usage Example

```typescript
// Inject
constructor(private _settingsService: SettingsService) {}

// Read
const pricing = await this._settingsService.get<AiModelPricingConfig>('ai_model_pricing');

// Write
await this._settingsService.set('my_feature_flag', true, {
  type: 'boolean',
  description: 'Enable my feature',
});
```

## Auto-Seeded Settings

These keys are initialized automatically on application startup (`OnModuleInit`) — only created if the key does not already exist.

| Key | Type | Default | Seeded by | Description |
|-----|------|---------|-----------|-------------|
| `ai_model_pricing` | object | See [ai-pricing-module.md](./ai-pricing-module.md) | `AiPricingService` | AI model pricing config (credits per token/image) |
| `post_send_overage_cost` | number | `25` | `PostOverageService` | Credits deducted per post when monthly send limit is exceeded |

## Admin API

See [admin-api.md](./admin-api.md) for REST endpoints.

## Key Files

- `libraries/nestjs-libraries/src/database/prisma/settings/settings.repository.ts`
- `libraries/nestjs-libraries/src/database/prisma/settings/settings.service.ts`
- `libraries/nestjs-libraries/src/database/prisma/schema.prisma` — `Settings` model
