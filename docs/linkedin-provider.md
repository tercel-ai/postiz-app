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

LinkedIn does not support setting comment state at post creation time. After `createMainPost` succeeds, the backend internally calls `_setCommentsState` (a private method in `LinkedinProvider`) which hits the LinkedIn **Social Metadata API**:

```
POST https://api.linkedin.com/rest/socialMetadata/{postUrn}?actor={actorUrn}
X-RestLi-Method: PARTIAL_UPDATE
{ "patch": { "$set": { "commentsState": "CLOSED" } } }
```

This is a server-side call made during the publish workflow — not exposed to the frontend. `commentsState: 'CLOSED'` disables new comments and removes existing ones.

**Important**: this call is non-critical. If it fails (network error, rate limit), the post is already live on LinkedIn and the failure is logged as a warning — it does not cause the post to be marked as `ERROR`.

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

## Known Limitations

- `createCommentPost` still uses the v2 API (`/v2/socialActions/`) rather than the newer REST API with `LinkedIn-Version: 202511`. This is functional but inconsistent with the rest of the provider.
- `maxConcurrentJob = 2` due to LinkedIn professional posting rate limits.
