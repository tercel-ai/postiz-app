# Posts List Module — Feature Documentation

## 1. Module Overview

### What does this module do?

The Posts List endpoint provides **paginated, filterable, and sortable access to all posts** within an organization. It enables users to:

- Browse all posts with pagination support
- Filter posts by status (scheduled, draft, published, error)
- Filter posts by channel/platform type (X, Reddit, LinkedIn, Instagram, etc.)
- Filter posts by specific integration account IDs
- Sort results by publish date, creation date, update date, or status

This is the primary endpoint for building post management UIs such as list views, tables, and dashboards.

---

## 2. API Reference

### Endpoint

`GET /posts/list`

### Authentication

Requires organization-level authentication. The `organizationId` is extracted from the request context automatically.

---

## 3. Query Parameters

| Parameter | Type | Required | Default | Validation | Description |
|-----------|------|----------|---------|------------|-------------|
| `page` | number | No | `1` | Integer, min 1 | Page number for pagination |
| `pageSize` | number | No | `20` | Integer, min 1, max 100 | Number of items per page |
| `state` | string | No | — (all states) | Must be a valid `State` enum value | Filter by post status |
| `integrationId` | string[] | No | — (all integrations) | Array of strings; supports comma-separated | Filter by specific integration account IDs |
| `channel` | string[] | No | — (all channels) | Array of valid provider identifiers; max 30 items | Filter by platform/channel type |
| `sortBy` | string | No | `publishDate` | One of: `publishDate`, `createdAt`, `updatedAt`, `state` | Field to sort results by |
| `sortOrder` | string | No | `desc` | One of: `asc`, `desc` | Sort direction |

### State Values

| Value | Meaning |
|-------|---------|
| `QUEUE` | Scheduled — post is queued and waiting to be published |
| `DRAFT` | Draft — post is saved but not yet scheduled |
| `PUBLISHED` | Published — post has been successfully published |
| `ERROR` | Error — post publication failed |

### Supported Channels

The `channel` parameter accepts the following provider identifiers:

| Channel | Platform |
|---------|----------|
| `x` | X (Twitter) |
| `reddit` | Reddit |
| `linkedin` | LinkedIn Personal |
| `linkedin-page` | LinkedIn Page |
| `instagram` | Instagram (via Facebook) |
| `instagram-standalone` | Instagram Standalone |
| `facebook` | Facebook |
| `youtube` | YouTube |
| `tiktok` | TikTok |
| `pinterest` | Pinterest |
| `threads` | Threads |
| `mastodon` | Mastodon |
| `bluesky` | Bluesky |
| `medium` | Medium |
| `devto` | Dev.to |
| `hashnode` | Hashnode |
| `wordpress` | WordPress |
| `discord` | Discord |
| `slack` | Slack |
| `telegram` | Telegram |
| `dribbble` | Dribbble |
| `kick` | Kick |
| `twitch` | Twitch |
| `lemmy` | Lemmy |
| `listmonk` | Listmonk |
| `gmb` | Google My Business |
| `wrapcast` | Farcaster (Warpcast) |
| `nostr` | Nostr |
| `vk` | VK |

> **Note**: Providing an invalid channel value will result in a `400 Bad Request` validation error.

---

## 4. Response Format

```json
{
  "results": [
    {
      "id": "clxyz...",
      "content": "Post content text...",
      "publishDate": "2026-03-01T10:00:00.000Z",
      "releaseURL": "https://x.com/user/status/123",
      "state": "PUBLISHED",
      "group": "group-id",
      "tags": [
        { "tag": { "id": "tag1", "name": "marketing" } }
      ],
      "integration": {
        "id": "integration-id",
        "providerIdentifier": "x",
        "name": "My X Account",
        "picture": "https://..."
      }
    }
  ],
  "total": 128,
  "page": 1,
  "pageSize": 20,
  "totalPages": 7
}
```

| Field | Type | Description |
|-------|------|-------------|
| `results` | array | Array of post objects for the current page |
| `total` | number | Total number of posts matching the filters |
| `page` | number | Current page number |
| `pageSize` | number | Items per page |
| `totalPages` | number | Total number of pages (`ceil(total / pageSize)`) |

### Post Object Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique post ID |
| `content` | string | Post content text |
| `publishDate` | string (ISO 8601) | Scheduled or actual publish date |
| `releaseURL` | string \| null | URL of the published post on the platform |
| `state` | string | Post status (`QUEUE`, `DRAFT`, `PUBLISHED`, `ERROR`) |
| `group` | string | Group ID for posts scheduled together |
| `tags` | array | Associated tags |
| `integration` | object | Integration account details (id, providerIdentifier, name, picture) |

---

## 5. Usage Examples

### Basic — Get first page of all posts

```
GET /posts/list
```

### Filter by post status

```
GET /posts/list?state=PUBLISHED
GET /posts/list?state=DRAFT
GET /posts/list?state=QUEUE
```

### Filter by channel type

```
GET /posts/list?channel=x
GET /posts/list?channel=x,reddit,linkedin
GET /posts/list?channel=instagram&channel=facebook
```

### Filter by specific integration accounts

```
GET /posts/list?integrationId=abc123
GET /posts/list?integrationId=abc123,def456
```

### Combined filters with pagination and sorting

```
GET /posts/list?state=PUBLISHED&channel=x,instagram&page=2&pageSize=50&sortBy=createdAt&sortOrder=asc
```

### Filter scheduled posts on LinkedIn sorted by publish date

```
GET /posts/list?state=QUEUE&channel=linkedin,linkedin-page&sortBy=publishDate&sortOrder=asc
```

---

## 6. Filtering Behavior

- All filters are **AND**-based — when multiple filters are provided, posts must match **all** conditions.
- Within array filters (`integrationId`, `channel`), values are **OR**-based — a post matches if it belongs to **any** of the specified values.
- Omitting a filter means **no restriction** on that dimension (returns all).
- Deleted posts (`deletedAt` is not null) and child posts (`parentPostId` is not null) are always excluded.

**Example**: `?state=PUBLISHED&channel=x,reddit` returns posts that are PUBLISHED **AND** belong to either X or Reddit.

---

## 7. Technical Implementation

### Architecture

```
Controller (posts.controller.ts)
  └── Service (posts.service.ts)         # pass-through
        └── Repository (posts.repository.ts)  # Prisma query
```

### Key Files

| File | Purpose |
|------|---------|
| `apps/backend/src/api/routes/posts.controller.ts` | Route handler — `GET /posts/list` |
| `libraries/nestjs-libraries/src/dtos/posts/get.posts-list.dto.ts` | Query parameter validation and transformation |
| `libraries/nestjs-libraries/src/database/prisma/posts/posts.service.ts` | Service layer (delegates to repository) |
| `libraries/nestjs-libraries/src/database/prisma/posts/posts.repository.ts` | Prisma query construction and execution |

### Query Construction

The repository builds a dynamic `where` clause based on provided filters:

```typescript
const where = {
  organizationId: orgId,       // always required
  deletedAt: null,             // exclude soft-deleted
  parentPostId: null,          // only top-level posts
  ...(query.state ? { state: query.state } : {}),
  ...(query.integrationId?.length
    ? { integrationId: { in: query.integrationId } }
    : {}),
  ...(query.channel?.length
    ? { integration: { providerIdentifier: { in: query.channel } } }
    : {}),
};
```

- `state` filter: direct field match on `Post.state`
- `integrationId` filter: `IN` query on `Post.integrationId`
- `channel` filter: relation filter — joins `Integration` table and filters on `providerIdentifier`

### Validation

- `channel` values are validated against a whitelist of 30 known provider identifiers (`VALID_CHANNELS`)
- Array parameters support both repeated query params (`?channel=x&channel=reddit`) and comma-separated values (`?channel=x,reddit`)
- `channel` array is capped at 30 items via `@ArrayMaxSize(30)`
