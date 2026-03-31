# LinkedIn Provider — Technical Notes

## Overview

The LinkedIn provider (`libraries/nestjs-libraries/src/integrations/social/linkedin.provider.ts`) supports both personal accounts and company pages. It uses LinkedIn's REST API v202511.

---

## Authentication & Scopes

OAuth 2.0 with the following scopes:

| Scope | Purpose |
|-------|---------|
| `openid`, `profile` | Basic identity |
| `w_member_social` | Post on behalf of personal account |
| `r_basicprofile` | Read profile info |
| `rw_organization_admin` | Manage company pages |
| `w_organization_social` | Post on behalf of company page |
| `r_organization_social` | Read company page analytics |
| `r_member_postAnalytics` | Read personal post analytics (impressions, reach, reactions, reshares, comments) |

> **Note:** `r_member_postAnalytics` is only in the personal provider's scopes. `LinkedinPageProvider` overrides the scopes array and excludes it — company page OAuth does not request this scope.

Tokens are refreshed via the refresh token flow. `refreshWait = true` serialises refresh calls to avoid race conditions.

---

## Post Creation Flow

```
post()
  ├── (optional) convertImagesToPdfCarousel()   # if post_as_images_carousel=true
  ├── processMediaForPosts()                     # upload all media
  │     └── uploadPicture() per media item
  ├── createMainPost()                           # POST /rest/posts → x-restli-id header
  └── (optional) _setCommentsState('CLOSED')    # if disable_comments=true
```

### Main post

`createMainPost` calls `POST https://api.linkedin.com/rest/posts` and reads the post URN from the **`x-restli-id` response header** (not the response body). If the header is absent, an error is thrown — this prevents a false-positive PUBLISHED state when LinkedIn accepts the request but does not create the post.

### Comment threads

`createCommentPost` calls `POST /v2/socialActions/{parentPostId}/comments` and likewise reads the comment URN from the `x-restli-id` header.

---

## Media Upload

### Images / Documents

Single PUT to the `uploadUrl` returned by `initializeUpload`. PDFs get `Content-Type: application/pdf`.

### Videos (multi-part)

LinkedIn returns an `uploadInstructions[]` array, each entry with its own `uploadUrl`, `firstByte`, and `lastByte`. The upload loop **must use each instruction's own `uploadUrl`** — reusing part-0's URL for all chunks causes silent corruption and invalid ETags.

```
initializeUpload → { uploadInstructions[], video URN }
for each instruction:
    PUT instruction.uploadUrl  body=file.slice(firstByte, lastByte+1)
    collect ETag from response header
finalizeUpload → { video URN, uploadedPartIds: [etags] }
```

Finalize is called at `POST https://api.linkedin.com/rest/videos?action=finalizeUpload`.

---

## Post Settings (LinkedinDto)

Defined in `libraries/nestjs-libraries/src/dtos/posts/providers-settings/linkedin.dto.ts`.

All fields are optional.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `post_as_images_carousel` | `boolean` | `false` | Convert post images to a PDF carousel |
| `visibility` | `'PUBLIC' \| 'CONNECTIONS' \| 'LOGGED_IN'` | `'PUBLIC'` | Who can see the post |
| `disable_comments` | `boolean` | `false` | Disable comments on the post |

### Visibility

Passed directly to the LinkedIn post payload's `visibility` field:

- `PUBLIC` — Anyone on LinkedIn
- `CONNECTIONS` — Your connections only
- `LOGGED_IN` — All LinkedIn members (logged in)

### Disable comments

LinkedIn does not support comment control at post creation time. After `createMainPost` succeeds, the backend internally calls `_setCommentsState` which hits the **Social Metadata API**:

```
POST https://api.linkedin.com/rest/socialMetadata/{postUrn}?actor={actorUrn}
{ "patch": { "$set": { "commentsState": "CLOSED" } } }
```

Returns **202 Accepted** on success. This endpoint is NOT called via `SocialAbstract.fetch()` — it uses native `fetch` directly, because `SocialAbstract.fetch()` only accepts HTTP 200/201 and would reject the 202.

`commentsState: 'CLOSED'` disables new comments and removes existing ones.

**Non-critical**: if this call fails, the post is already live. The failure is logged and does not mark the post as ERROR.

See: [Social Metadata API docs](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/social-metadata-api)

---

## Frontend Settings UI

`apps/frontend/src/components/new-launch/providers/linkedin/linkedin.provider.tsx` renders three settings controls:

1. **Post as images carousel** — `Checkbox`
2. **Who can see your post** — `Select` (Anyone / Connections only / LinkedIn members only)
3. **Disable comments** — `Checkbox`

The UI uses react-hook-form via `useSettings()`. Visibility defaults to `PUBLIC` at the backend level if not set.

---

## Error Handling

| Scenario | Behaviour |
|----------|-----------|
| `x-restli-id` missing from post response | Throws with body text — prevents false PUBLISHED state |
| `x-restli-id` missing from comment response | Throws with body text |
| `_setCommentsState` fails | Caught, logged with `console.error`, post remains PUBLISHED |
| Post-now failure | `BadRequestException` thrown after all accounts are attempted; error message returned directly to frontend |
| Scheduled post failure | Error saved to DB (`post.error`), state set to `ERROR` |

---

## Analytics

### LinkedIn Personal (`linkedin`)

`postAnalytics` uses the **`memberCreatorPostAnalytics` REST API** (requires `r_member_postAnalytics` scope) to fetch:
- **Impressions** (`IMPRESSION` queryType)
- **Likes** (`REACTION` queryType)
- **Comments** (`COMMENT` queryType)
- **Shares** (`RESHARE` queryType)
- **Reach** (`MEMBERS_REACHED` queryType)

API endpoint: `GET /rest/memberCreatorPostAnalytics?q=entity&entity=(share:{encodedUrn})&queryType={METRIC}&aggregation=TOTAL`

Each metric requires a separate API call (5 calls per post). All 5 are fetched in parallel via `Promise.allSettled`.

**Graceful fallback:** If the user's token lacks `r_member_postAnalytics` (e.g., existing users who haven't re-authenticated), the API returns 403. The provider falls back to the legacy `GET /v2/socialActions/{postId}` endpoint which only provides Likes and Comments.

**Entity encoding:** Uses RestLi 2.0 tuple format — `(share:urn%3Ali%3Ashare%3A123)` or `(ugcPost:urn%3Ali%3AugcPost%3A123)` depending on the post URN type.

No `accountMetrics` or `batchPostAnalytics` — LinkedIn does not expose follower count for personal accounts, and the `memberCreatorPostAnalytics` API does not support batch per-post queries.

### LinkedIn Page (`linkedin-page`)

Full analytics support:

| Method | API | Metrics |
|--------|-----|---------|
| `postAnalytics` | `GET /v2/organizationalEntityShareStatistics` + fallback `GET /v2/socialActions/{postId}` | Impressions, Unique Impressions, Clicks, Likes, Comments, Shares, Engagement |
| `batchPostAnalytics` | Same API with `shares=List(...)` parameter (up to 20 posts per request) | Same as above, per-post |
| `accountMetrics` | `GET /v2/networkSizes/urn:li:organization:{id}?edgeType=CompanyFollowedByMember` | followers |
| `analytics` (account-level) | `organizationPageStatistics` + `organizationalEntityFollowerStatistics` + `organizationalEntityShareStatistics` | Page Views, Organic/Paid Followers, Clicks, Shares, Engagement, Comments |

All API calls use `LinkedIn-Version: 202511` and `X-Restli-Protocol-Version: 2.0.0` headers.

---

## Known Limitations

- `createCommentPost` still uses the v2 API (`/v2/socialActions/`) rather than the newer REST API with `LinkedIn-Version: 202511`. This is functional but inconsistent with the rest of the provider.
- `maxConcurrentJob = 2` due to LinkedIn professional posting rate limits.
- LinkedIn personal accounts now support impressions/reach/reactions/reshares/comments via `memberCreatorPostAnalytics` API, but still cannot access follower count. Users must re-authenticate to grant the `r_member_postAnalytics` scope — existing tokens fall back to the legacy socialActions API (likes + comments only).
- The `memberCreatorPostAnalytics` API requires 5 separate API calls per post (one per metric). For accounts with many posts, this can consume significant API quota during daily sync.
