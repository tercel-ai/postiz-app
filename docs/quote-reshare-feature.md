# Quote / Reshare Feature

## Overview

Multiple providers support **quoting or resharing** an existing post when publishing a new one. The quoted/reshared post appears embedded below the new post's text on the respective platform.

| Platform | Feature Name | Setting Field | URL Example |
|----------|-------------|---------------|-------------|
| X (Twitter) | Quote Tweet | `quote_tweet_url` | `https://x.com/user/status/123456789` |
| LinkedIn | Reshare | `reshare_url` | `https://www.linkedin.com/feed/update/urn:li:activity:123456789` |
| Farcaster | Quote Cast | `quote_cast_url` | `https://warpcast.com/username/0xabcdef` |

---

## User Flow (All Platforms)

1. Create a new post and select a channel.
2. Click the settings icon (gear) on the channel.
3. Paste the URL of the post you want to quote/reshare into the corresponding input field.
4. Write your text and publish.

All fields are optional — leaving them empty publishes a normal post.

---

## X (Twitter)

### DTO

Defined in `libraries/nestjs-libraries/src/dtos/posts/providers-settings/x.dto.ts`.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `quote_tweet_url` | `string` | No | Full URL of the tweet to quote |
| `community` | `string` | No | X community URL |
| `who_can_reply_post` | `enum` | Yes | Reply permission: `everyone`, `following`, `mentionedUsers`, `subscribers`, `verified` |

### URL Validation

Accepts both `x.com` and `twitter.com` domains (empty string also allowed):

```
^(https:\/\/(x|twitter)\.com\/[a-zA-Z0-9_]+\/status\/\d+(\?.*)?)?$
```

Valid examples:
- `https://x.com/user/status/123456789`
- `https://twitter.com/user/status/123456789`
- `https://x.com/user/status/123456789?s=20`

Plain tweet IDs (e.g., `123456789`) are **not** accepted.

### Backend

File: `libraries/nestjs-libraries/src/integrations/social/x.provider.ts`

Two modes are supported, controlled by the `X_QUOTE_TWEET_APPEND_URL` environment variable:

| Mode | Trigger | Behavior |
|------|---------|----------|
| **Native** (default) | `X_QUOTE_TWEET_APPEND_URL` unset or `false` | Tweet id is parsed from the URL and passed as `quote_tweet_id` to `v2.tweet`. Produces a true native quote tweet — increments the source tweet's `quote_count` and appears in its quote timeline. Does **not** consume the character budget. |
| **URL append** (fallback) | `X_QUOTE_TWEET_APPEND_URL=true` | The URL is appended to the message text (`?...` query stripped). X auto-renders the trailing URL as a quote card. Not a true native quote — does not increment `quote_count`. Consumes ~24 characters (newline + `t.co` link) from the character limit. |

**Hard constraint from X's official OpenAPI spec** (`TweetCreateRequest` schema): `quote_tweet_id` is **mutually exclusive** with `media`, `poll`, and `card_uri`. As a result, **whenever the post has any attached media the provider unconditionally uses URL-append mode**, even if the env var is unset — otherwise X would reject the request with 400. This is logged at info level for observability.

The native mode may also return 403 on restricted API tiers (e.g. Pay Per Use, where `quote_tweet_id` is not whitelisted). When that happens the provider automatically falls back in this order:

1. Retry `v2.tweet` **without** `quote_tweet_id`, with the URL appended to the text. Preserves `community_id`, `reply_settings`, and media.
2. If the v2 retry also fails, fall back to `v1.1.tweet` with the URL appended. v1.1 cannot carry community/reply settings, so those are dropped at this stage.

```typescript
// Default (native): parse tweet id from URL and pass as quote_tweet_id.
const rawQuoteUrl = firstPost?.settings?.quote_tweet_url?.split('?')[0];
const appendQuoteUrlMode =
  String(process.env.X_QUOTE_TWEET_APPEND_URL || '').toLowerCase() === 'true';
let quoteTweetId: string | undefined;
if (rawQuoteUrl && !appendQuoteUrlMode) {
  const match = rawQuoteUrl.match(/\/status\/(\d+)/);
  if (match) quoteTweetId = match[1];
}
// ... later passed as: { ...params, quote_tweet_id: quoteTweetId }
```

### Frontend

File: `apps/frontend/src/components/new-launch/providers/x/x.provider.tsx`

### Known Limitations

- **Thread support**: Only the first tweet in a thread can quote another tweet. This matches X's native behavior.
- **Character limit (URL-append mode only)**: When the provider degrades to the URL-append path, the appended URL is wrapped by X as a `t.co` link, consuming ~24 characters (newline + 23-char t.co URL) from the character limit. In the default native mode the URL is **not** in the text, so the character limit is unaffected.

---

## LinkedIn

### DTO

Defined in `libraries/nestjs-libraries/src/dtos/posts/providers-settings/linkedin.dto.ts`.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `reshare_url` | `string` | No | Full URL of the LinkedIn post to reshare |

### URL Validation

Supports two LinkedIn URL formats (empty string also allowed):

```
^(https:\/\/(www\.)?linkedin\.com\/(feed\/update\/urn:li:activity:\d+|posts\/[a-zA-Z0-9_-]+activity-\d+-[a-zA-Z0-9_-]+)\/?(\?.*)?)?$
```

Valid examples:
- `https://www.linkedin.com/feed/update/urn:li:activity:1234567890`
- `https://www.linkedin.com/posts/username_activity-1234567890-xxxx`

### Backend

File: `libraries/nestjs-libraries/src/integrations/social/linkedin.provider.ts`

The activity URN is extracted from the URL via `extractLinkedInActivityUrn()`, then passed to the LinkedIn Posts API as `reshareContext.parent`:

```typescript
// In createLinkedInPostPayload:
const reshareActivityUrn = reshareUrl
  ? this.extractLinkedInActivityUrn(reshareUrl)
  : undefined;

return {
  // ...other fields
  ...(reshareActivityUrn
    ? { reshareContext: { parent: reshareActivityUrn } }
    : {}),
};
```

Two URL patterns are handled:
1. `/feed/update/urn:li:activity:123` → extracts `urn:li:activity:123` directly
2. `/posts/username_activity-123-xxxx` → extracts the numeric ID and builds `urn:li:activity:123`

### Frontend

File: `apps/frontend/src/components/new-launch/providers/linkedin/linkedin.provider.tsx`

---

## Farcaster (Warpcast)

### DTO

Defined in `libraries/nestjs-libraries/src/dtos/posts/providers-settings/farcaster.dto.ts`.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `quote_cast_url` | `string` | No | Full Warpcast URL of the cast to quote |

### URL Validation

Empty string also allowed:

```
^(https:\/\/warpcast\.com\/[a-zA-Z0-9._-]+\/0x[a-fA-F0-9]+(\?.*)?)?$
```

Valid example: `https://warpcast.com/username/0xabcdef`

### Backend

File: `libraries/nestjs-libraries/src/integrations/social/farcaster.provider.ts`

Farcaster's quote mechanism is native — a cast URL included as an embed is automatically rendered as a quote cast:

```typescript
const quoteCastUrl = firstPost?.settings?.quote_cast_url;
let embeds = mediaEmbeds;
if (quoteCastUrl) {
  if (mediaEmbeds.length >= 2) {
    console.warn('[farcaster] Quote cast URL dropped — embed limit (2) already reached by media');
  } else {
    embeds = [...mediaEmbeds.slice(0, 1), { url: quoteCastUrl }];
  }
}

await client.publishCast({
  embeds,
  signerUuid: accessToken,
  text: firstPost.message,
});
```

### Frontend

File: `apps/frontend/src/components/new-launch/providers/warpcast/warpcast.provider.tsx`

### Known Limitations

- Quote cast is only applied to the **first cast**. Thread replies do not carry the quote embed.
- **Embed limit**: Farcaster allows a maximum of 2 embeds per cast. If a post already has 2 media attachments, the quote cast URL is dropped (with a warning logged). If the post has 1 media attachment, the quote URL replaces the potential second media slot.
