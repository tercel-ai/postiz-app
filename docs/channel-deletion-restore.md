# Channel Deletion & Restoration

## Overview

When a user deletes a social account (channel) and later re-adds the same account, previously published posts and analytics data are preserved and automatically restored.

---

## Deletion Behavior

### What happens when a channel is deleted

1. **Unpublished posts** (QUEUE, DRAFT) belonging to this integration are soft-deleted
   - Uses `integrationId` filter — only affects this integration's posts
   - Does NOT affect other integrations' posts in the same multi-channel group
2. **Published posts** (PUBLISHED, ERROR) are preserved — they remain in the database with their analytics data
3. **The Integration record** is soft-deleted (`deletedAt = now()`)
4. **DataTicks records** are not modified — historical analytics remain in the database

### Key design choice: integration-scoped deletion

Multi-channel posts share the same `group` ID. Deleting by group would accidentally remove other integrations' published posts. Instead, deletion operates directly on `integrationId + state` to avoid cross-integration data loss.

**File:** `apps/backend/src/api/routes/integrations.controller.ts` — `deleteChannel()`

---

## Restoration Behavior

### Non-page platforms (X, Threads, TikTok, Reddit, Bluesky, Mastodon, Pinterest, LinkedIn personal, Instagram Standalone)

These platforms have `isBetweenSteps = false` — authentication directly produces the final `internalId`.

**Flow:**
1. User re-authenticates via OAuth
2. Platform returns the same immutable ID (e.g., Twitter numeric user ID)
3. `createOrUpdateIntegration` calls Prisma `upsert` with `where: { organizationId, internalId }`
4. The soft-deleted record still exists in the database (unique constraint matches it)
5. Upsert runs the `update` branch: clears `deletedAt`, updates token
6. All Post and DataTicks records still reference this Integration `id` — data is immediately visible

### Page platforms (Facebook, Instagram, YouTube, LinkedIn Page)

These platforms have `isBetweenSteps = true` — authentication creates a temporary record, then the user selects a page/channel.

**Flow:**
1. User re-authenticates via OAuth → temporary Integration record created with interim `internalId` (e.g., user ID or `p_xxx`)
2. User selects page → `saveProviderPage()` called
3. `fetchPageInformation()` returns the real page ID
4. System checks `findIntegrationByInternalId(org, pageId)` for existing records:
   - **Soft-deleted record found**: Restore it (clear `deletedAt`, update token/name/picture), discard the temporary record
   - **Active record found**: Update its token in place, discard the temporary record (prevents unique constraint violation)
   - **No match**: Update the temporary record's `internalId` to the page ID (first-time connection)
5. All Post and DataTicks records still reference the restored Integration `id`

**File:** `libraries/nestjs-libraries/src/database/prisma/integrations/integration.service.ts` — `saveProviderPage()`

---

## Platform `internalId` Reference

All platforms use immutable, platform-assigned IDs — never mutable usernames.

| Platform | `internalId` Source | Immutable? |
|----------|-------------------|:---:|
| X | Numeric user ID from v2.me() | Yes |
| LinkedIn | OpenID `sub` claim | Yes |
| LinkedIn Page | Organization numeric ID | Yes |
| Facebook | Page numeric ID | Yes |
| Instagram | IG Business Account ID | Yes |
| Instagram Standalone | IG user_id | Yes |
| YouTube | Channel ID (e.g., UCxxxx) | Yes |
| Threads | Threads user ID | Yes |
| TikTok | open_id (hyphens removed) | Yes |
| Pinterest | Account ID | Yes |
| Reddit | User ID | Yes |
| Bluesky | DID (did:plc:...) | Yes |
| Mastodon | Instance user numeric ID | Yes |

**Security:** Since `internalId` is an immutable platform-assigned ID (not a changeable username), re-adding an account always matches the same owner. The OAuth flow guarantees the user controls the account.

---

## Data Integrity

### What is preserved across delete/restore

| Data | Preserved? | Notes |
|------|:---:|-------|
| Published posts | Yes | Never deleted during channel removal |
| Post analytics (impressions, trafficScore) | Yes | Stored on the Post record |
| DataTicks (daily aggregated metrics) | Yes | Keyed by integrationId, not modified on deletion |
| Account metrics (followers etc.) | Yes | Stored on Integration record, updated on restore |
| Unpublished posts (QUEUE, DRAFT) | No | Soft-deleted during channel removal |
| Token / refresh token | Updated | New OAuth tokens applied on restore |

### What about multi-channel groups?

A group may contain posts from multiple integrations (e.g., posting to X + Facebook simultaneously). When one channel is deleted:
- Only that channel's unpublished posts are soft-deleted
- The other channel's posts (including published ones) are untouched
- The group itself is not affected

---

## File Locations

| Component | Path |
|-----------|------|
| Delete channel controller | `apps/backend/src/api/routes/integrations.controller.ts` |
| Integration repository | `libraries/nestjs-libraries/src/database/prisma/integrations/integration.repository.ts` |
| Integration service | `libraries/nestjs-libraries/src/database/prisma/integrations/integration.service.ts` |
| Post repository | `libraries/nestjs-libraries/src/database/prisma/posts/posts.repository.ts` |

---

## Known Limitations

- **TikTok**: Post analytics require `video.list` scope and account metrics require `user.info.stats` scope, which are not currently requested during OAuth. Analytics will return empty until these scopes are added to the auth flow.
- **Mastodon Custom**: The custom instance URL is not available in the `postAnalytics`/`accountMetrics` method signatures. Analytics calls use the `MASTODON_URL` environment variable, consistent with the `post()`/`comment()` methods.
- **LinkedIn personal**: No account-level metrics (followers) available via API.
