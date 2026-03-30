# POST /posts — Publish API

## Overview

The `/posts` endpoint creates, schedules, or immediately publishes posts across one or more social integrations. A single request can target multiple accounts simultaneously.

---

## Endpoint

```
POST /posts
Authorization: Bearer <session token>
Content-Type: application/json
```

**Guards:**
- Requires authenticated session
- `CheckPolicies([AuthorizationActions.Create, Sections.POSTS_PER_MONTH])` — enforces monthly post quota

---

## Request Body

```jsonc
{
  "type": "now" | "schedule" | "draft",
  "date": "2026-03-30T14:00:00",     // ISO datetime (UTC); ignored for type=now
  "shortLink": false,                  // convert URLs to tracked short links
  "inter": 7,                          // (optional) recurring interval in days
  "source": "calendar",               // (optional) "calendar" | "chat"
  "order": "...",                      // (optional) unused — accepted by DTO but not read by service
  "tags": [],                          // array of tag objects
  "posts": [ /* Post[] — see below */ ]
}
```

### `type`

| Value | Behaviour |
|-------|-----------|
| `now` | Posts immediately. Request blocks until all accounts succeed or fail (up to 60s). Errors returned as HTTP 400. |
| `schedule` | Saved to DB and handed to Temporal. Request returns immediately. Errors saved to DB only. |
| `draft` | Saved to DB, no workflow started. `posts` array is optional. |

### `Post` object

```jsonc
{
  "integration": { "id": "<integration-uuid>" },
  "group": "<group-uuid>",            // shared across accounts for same content set
  "settings": {
    "__type": "linkedin",             // provider discriminator key
    // provider-specific fields (see Settings section)
  },
  "value": [ /* PostContent[] */ ]
}
```

### `PostContent` object

```jsonc
{
  "id": "<post-uuid>",                // present when editing existing post
  "content": "Post text here",
  "delay": 0,                         // seconds delay before this content is sent
  "image": [
    {
      "id": "<media-uuid>",
      "path": "https://...",
      "alt": "alt text",
      "thumbnail": "https://...",     // video thumbnail URL
      "thumbnailTimestamp": 5.0       // thumbnail frame position in seconds
    }
  ]
}
```

`value` is an array to support thread-style posts (each element is a separate reply/comment in sequence).

---

## Provider Settings (`settings`)

The `settings` object is discriminated by `__type`. Each provider defines its own optional fields.

### LinkedIn (`__type: "linkedin"` or `"linkedin-page"`)

```jsonc
{
  "__type": "linkedin",
  "post_as_images_carousel": false,        // convert images to PDF carousel
  "visibility": "PUBLIC",                  // "PUBLIC" | "CONNECTIONS" | "LOGGED_IN"
  "disable_comments": false                // disable comments after posting
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `post_as_images_carousel` | boolean | `false` | Combines all images into a PDF carousel document |
| `visibility` | string | `PUBLIC` | Who can see the post |
| `disable_comments` | boolean | `false` | Disables comments via Social Metadata API after post creation |

### X / Twitter (`__type: "twitter"`)

Provider-specific settings defined in `twitter.dto.ts`.

### Other providers

Each provider has its own DTO under `libraries/nestjs-libraries/src/dtos/posts/providers-settings/`. All fields are optional — absent fields use provider defaults.

---

## Response

### `type: "schedule"` or `"draft"` — HTTP 200

```jsonc
[
  {
    "postId": "<post-uuid>",
    "integration": "<integration-uuid>"
  }
]
```

### `type: "now"` — HTTP 200 (all accounts succeeded)

```jsonc
[
  {
    "postId": "<post-uuid>",
    "integration": "<integration-uuid>",
    "state": "PUBLISHED",
    "releaseURL": "https://www.linkedin.com/feed/update/urn:li:activity:..."
  }
]
```

### `type: "now"` — HTTP 400 (one or more accounts failed)

```jsonc
{
  "statusCode": 400,
  "message": "Post failed on account A | Rate limit exceeded on account B"
}
```

All accounts are attempted before the error is thrown — partial success is not surfaced to the caller in this case. Check per-post DB state if granular per-account results are needed.

---

## Internal Flow

```
POST /posts
  │
  ├── mapTypeToPost()               validate & transform raw body
  │
  └── createPost()
        │
        ├── for each post (account):
        │     ├── shortLinkService.convertTextToShortLinks()   (if shortLink=true)
        │     ├── postRepository.createOrUpdatePost()           persist to DB
        │     │     ├── upsert Post records (QUEUE / DRAFT state)
        │     │     ├── soft-delete stale QUEUE/DRAFT siblings (edit flow)
        │     │     └── never touches PUBLISHED/ERROR records
        │     │
        │     ├── startWorkflow()                               → Temporal
        │     │     ├── terminate any existing workflow for this postId
        │     │     ├── start 'postWorkflowV101' on taskQueue='main'
        │     │     └── (type=now) poll DB every 500ms until state ≠ QUEUE (max 60s)
        │     │
        │     └── (type=now) read finalPost state:
        │           ├── state=PUBLISHED → add to postList
        │           └── state=ERROR     → push error to postNowErrors[]
        │
        ├── (type=now, errors exist) throw BadRequestException(errors.join(' | '))
        └── return postList
```

### Temporal workflow

- `workflowId`: `post_<postId>` (unique per post)
- `taskQueue`: `main`
- Provider workers pick up tasks from their own sub-queues (e.g. `linkedin`, `twitter`)
- `postNow: true` flag enables polling in `startWorkflow`; scheduled posts fire-and-forget

---

## Post States

| State | Meaning |
|-------|---------|
| `DRAFT` | Saved, no publish scheduled |
| `QUEUE` | Waiting for Temporal worker to pick up |
| `PUBLISHED` | Successfully posted to platform |
| `ERROR` | Platform returned an error; `post.error` contains the message |

For recurring posts (`inter > 0`), the original post stays in `QUEUE` perpetually. Each recurrence creates a clone that goes through `QUEUE → PUBLISHED/ERROR`.

---

## Editing an Existing Post

Send the same request with `value[].id` set to existing post UUIDs. The repository:

1. Upserts records with the new content
2. Soft-deletes any QUEUE/DRAFT posts in the same group that were not included in the new `value` array
3. Never modifies PUBLISHED or ERROR records (immutable publish history)

---

## Recurring Posts

Set `inter` to a positive integer (days between recurrences).

- The original post acts as the template; it remains in `QUEUE` with `intervalInDays` set
- Each time the workflow fires, a clone (`sourcePostId` set) is created for that cycle
- Setting `inter` to `null` on edit converts the post to non-recurring; existing published clones are preserved

---

## Frontend Error Handling

`manage.modal.tsx` checks `response.ok` after `POST /posts`:

- **Success**: refreshes post list, shows success toast, closes modal
- **Failure** (`res.ok === false`): parses `message` from response body, shows warning toast, keeps modal open

---

## Related Files

| File | Role |
|------|------|
| `apps/backend/src/api/routes/posts.controller.ts` | Route handler, guards |
| `libraries/nestjs-libraries/src/dtos/posts/create.post.dto.ts` | Request DTO |
| `libraries/nestjs-libraries/src/database/prisma/posts/posts.service.ts` | `createPost`, `startWorkflow` |
| `libraries/nestjs-libraries/src/database/prisma/posts/posts.repository.ts` | `createOrUpdatePost`, `_softDeleteGroupPosts` |
| `libraries/nestjs-libraries/src/integrations/social/social.integrations.interface.ts` | `PostDetails`, `PostResponse` types |
| `libraries/nestjs-libraries/src/dtos/posts/providers-settings/` | Per-provider settings DTOs |
| `apps/frontend/src/components/new-launch/manage.modal.tsx` | Frontend caller |
