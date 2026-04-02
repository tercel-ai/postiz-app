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

The tweet ID is extracted from the URL and passed to the X API:

```typescript
const quoteTweetId = firstPost?.settings?.quote_tweet_url
  ? firstPost.settings.quote_tweet_url.split('/status/').pop()?.split('?')[0]
  : undefined;

await client.v2.tweet({
  ...(quoteTweetId ? { quote_tweet_id: quoteTweetId } : {}),
  text: firstPost.message,
});
```

### Frontend

File: `apps/frontend/src/components/new-launch/providers/x/x.provider.tsx`

### Known Limitations

- **Thread support**: Only the first tweet in a thread can quote another tweet. This matches X's native behavior.
- **v1.1 fallback**: If the v2 API fails and the provider falls back to v1.1, the quote tweet parameter is not forwarded (v1.1 uses `attachment_url` instead of `quote_tweet_id`).

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
