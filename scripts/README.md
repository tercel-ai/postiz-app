# Scripts

## test-agent-simple.ts

A simplified E2E test script for the Chat Agent. It bypasses the login process by signing a JWT directly using `JWT_SECRET` from `.env`. This allows for rapid testing of the Agent's content generation and X.com (Twitter) scheduling.

### Scenarios Covered
- **Text Only**: Professional tech tip post.
- **Image + Text**: Marketing post with AI-generated image.
- Each scenario automatically handles the "Confirm schedule" multi-turn step.

### Quick Start

```bash
# Run with all integrations
USER_ID="your-user-uuid" ORG_ID="your-org-uuid" pnpm dlx ts-node scripts/test-agent-simple.ts

# Target a specific X.com account (by name or integration ID)
USER_ID="your-uuid" ORG_ID="your-uuid" INTEGRATION="my-x-account" pnpm dlx ts-node scripts/test-agent-simple.ts
```

### Environment Variables

| Variable | Required | Source | Description |
|----------|----------|--------|-------------|
| `USER_ID` | Yes | Pass on command line | UUID of the user to impersonate |
| `ORG_ID` | No | Pass on command line | UUID of the organization (if user has multiple) |
| `INTEGRATION` | No | Pass on command line | Filter to a specific integration by name or ID |
| `JWT_SECRET` | Yes | Loaded from `.env` | Used to sign the authentication token |
| `BACKEND_INTERNAL_URL` | No | Loaded from `.env` | Backend API URL (defaults to `http://localhost:3000`) |

---

## reauth-integrations.ts

Safe re-authorization script for integrations after server-level API key rotation.

When you change OAuth app credentials (e.g. `X_API_KEY`, `FACEBOOK_APP_ID`), existing tokens in the database become invalid. This script marks affected integrations for re-authorization **without deleting any data** — all posts, schedules, settings, and relations are preserved.

### Quick Start

```bash
# 1. Preview affected integrations (dry-run, no changes)
npx ts-node scripts/reauth-integrations.ts

# 2. Execute for all OAuth providers
npx ts-node scripts/reauth-integrations.ts --execute
```

### Options

| Flag | Description | Default |
|------|-------------|---------|
| `--dry-run` | Show what would be updated, no changes made | Yes (default) |
| `--execute` | Apply the changes | — |
| `--provider <name>` | Target specific provider(s), comma-separated | All OAuth providers |
| `--org <id>` | Scope to a specific organization | All organizations |
| `--help` | Show usage help | — |

### Examples

```bash
# Only X (Twitter)
npx ts-node scripts/reauth-integrations.ts --provider x --execute

# Multiple providers
npx ts-node scripts/reauth-integrations.ts --provider x,linkedin,facebook --execute

# Specific organization
npx ts-node scripts/reauth-integrations.ts --provider x --org org_123 --execute
```

### Supported Providers

| Provider | Env Vars |
|----------|----------|
| `x` | `X_API_KEY`, `X_API_SECRET` |
| `facebook` | `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET` |
| `instagram-business` | `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET` |
| `instagram` | `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET` |
| `linkedin` | `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` |
| `linkedin-page` | `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` |
| `youtube` | `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET` |
| `tiktok` | `TIKTOK_CLIENT_ID`, `TIKTOK_CLIENT_SECRET` |
| `reddit` | `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET` |
| `pinterest` | `PINTEREST_CLIENT_ID`, `PINTEREST_CLIENT_SECRET` |
| `discord` | `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` |
| `slack` | `SLACK_ID`, `SLACK_SECRET` |
| `threads` | `THREADS_APP_ID`, `THREADS_APP_SECRET` |
| `twitch` | `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET` |
| `kick` | `KICK_CLIENT_ID`, `KICK_SECRET` |
| `vk` | `VK_ID` |
| `dribbble` | `DRIBBBLE_CLIENT_ID`, `DRIBBBLE_CLIENT_SECRET` |

Providers that do **not** need re-authorization (API-key or passwordless auth): `devto`, `medium`, `hashnode`, `mastodon`, `bluesky`, `lemmy`, `telegram`, `nostr`, `farcaster`, `listmonk`, `wordpress`.

### What Changes

For each affected integration:

| Field | Before | After |
|-------|--------|-------|
| `refreshNeeded` | `false` | `true` |
| `token` | OAuth token | `''` (empty) |
| `refreshToken` | refresh token | `null` |
| `tokenExpiration` | expiry date | `null` |

### What Is Preserved

- All posts and their content
- Scheduling configuration (`postingTimes`)
- Provider-specific settings (`additionalSettings`)
- Display info (`name`, `picture`, `profile`)
- Custom instance details
- All relations: plugs, webhooks, order items

### Post-Execution Verification

```sql
-- Check flagged integrations
SELECT id, name, "providerIdentifier", "refreshNeeded"
FROM "Integration"
WHERE "refreshNeeded" = true;

-- Verify posts are intact
SELECT COUNT(*)
FROM "Post"
WHERE "integrationId" IN (
  SELECT id FROM "Integration" WHERE "refreshNeeded" = true
);
```

In the UI, affected channels will show a "re-authorization needed" prompt. Once the user re-authorizes via OAuth, new tokens are stored and `refreshNeeded` resets to `false`.
