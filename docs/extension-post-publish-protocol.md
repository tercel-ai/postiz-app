# Extension Post-Publish Protocol (batch + thread + cancel)

> **⚠️ Updated model — the DB `QUEUE` state is the source of truth.**
> `aisee:post-publish` is now a **pure sync trigger**: the page no longer hands
> the extension the posts to publish. Instead the page (1) commits the posts to
> the send queue via [`POST /posts/schedule`](./posts-api.md#post-postsschedule)
> (DRAFT → QUEUE), then (2) sends `aisee:post-publish` **with no `items`** just to
> make the extension pull immediately. The extension pulls the due work from
> [`POST /posts/publish-due`](./posts-api.md#post-postspublish-due) (also on its
> own 1-min `aisee-publish-poll` alarm — so a missed trigger only adds latency),
> then feeds it into the SAME internal queue described below. Any `items` a page
> still sends on `aisee:post-publish` are **ignored**.
>
> Everything below the Messages table (payload shapes, serial drain, pacing,
> backfill, scheduling, cancel/status) still describes that internal queue — it is
> now fed by the publish-due pull loop (`runPublishLoop` → `enqueuePublishBatch`)
> instead of by the page payload. Status is now read from the DB
> (`GET /operation-plans/:id` post `state`), not the extension queue mirror.

The extension publishes each queued post in-browser with the user's own platform
session, tracks per-task progress, and may **cancel tasks that have not started**.

Shared types + internal helpers: `@gitroom/helpers/extension/post-publish`
(`enqueuePublishBatch` / `cancelPublishTasks` / `getPublishQueueStatus` /
`onPublishProgress`) — used by the pull loop and any in-repo caller.

## Messages (same-origin `window.postMessage`)

| Direction | `action` | Payload |
|---|---|---|
| page → ext | `aisee:post-publish` | `{ requestId }` — **pure trigger** (any `items` ignored); makes the extension pull publish-due now |
| ext → page | `aisee:post-publish-result` | `{ requestId, ok, summary: { due, enqueued, rejected, stoppedReason } }` — result of the triggered pull |
| ext → page | `aisee:post-publish-progress` | `{ requestId, state: PublishTaskState }` — pushed on every transition (still emitted as the pulled queue drains) |
| page → ext | `aisee:post-publish-cancel` | `{ requestId, taskIds: string[] }` |
| ext → page | `aisee:post-publish-cancel-result` | `{ requestId, ok, canceled: string[], notCancelable: {taskId, reason}[] }` |
| page → ext | `aisee:post-publish-status` | `{ requestId }` |
| ext → page | `aisee:post-publish-status-result` | `{ requestId, ok, states: PublishTaskState[] }` |

> The `aisee:post-publish-result` shape **changed** with the demotion: it now
> reports the pull `summary` (`{ due, enqueued, rejected, stoppedReason }`), not
> the old `{ accepted, rejected }` enqueue ack.

All page → ext messages carry `source: 'aisee'`; all ext → page messages carry
`source: 'aisee-extension'`. Correlate request/response by `requestId`;
correlate progress by `state.taskId`.

## Payload shapes

```ts
interface PublishPostItem {
  taskId: string;              // caller's id (e.g. backend Post id), echoed everywhere
  platform: 'x' | 'reddit';
  segments: {
    text: string;
    images?: string[];         // server URLs; FIRST segment only
  }[];                         // [0] = the post; [1..] = native thread chain
  subreddit?: string;          // reddit required (with or without r/)
  title?: string;              // reddit required
  publishDate?: string;        // ISO; absent/past = publish ASAP
  segmentGapSeconds?: [number, number]; // thread-segment pause range; default [30,120]
}

interface PublishTaskState {
  taskId: string;
  platform: 'x' | 'reddit';
  // 'sent' = live on-platform (permalink captured) but the backend Post is not
  // yet flipped to PUBLISHED — the DB backfill is pending or failed; a manual
  // "Sync" retries it and advances to 'published'.
  status: 'queued' | 'publishing' | 'sent' | 'published' | 'error' | 'canceled';
  segmentsTotal: number;
  segmentsPublished: number;
  permalink?: string;           // first segment, once published
  segmentPermalinks?: string[]; // every published segment in thread order
  postId?: string;              // platform id of the post (reddit t3_* / X rest_id)
  publishAt?: string;           // ISO, echoed from publishDate — the SCHEDULED time
  publishedAt?: string;         // ISO, the REAL send time (set when the anchor posts;
                                //   differs from publishAt for overdue / publish-now tasks)
  error?: string;               // platform send itself failed (status 'error')
  backfillError?: string;       // DB backfill failed while live (status 'sent')
}
```

## DB backfill (closed loop to the backend Post)

After a task's platform send succeeds it settles as `sent`, then the extension
calls the backend with its own authenticated session (works even if the page is
closed, e.g. scheduled posts) to flip the saved Post to PUBLISHED:

```
PATCH /posts/:taskId/extension-published   { releaseURL, releaseId? }
  → { ok: true }                         // flipped (or already PUBLISHED — idempotent)
  → { ok: false, reason }                // not found / not this org / recurring original
```

On success the task advances `sent → published`. On failure (HTTP error OR a
`{ ok: false }` body) it stays `sent` with `backfillError` set, so nothing is
ever marked published while the DB row is untouched, and the popup offers a
manual **Sync** (idempotent retry). This mirrors the Engage reply's
`PATCH /engage/sent/:id/publish-reply` callback.

## Example — frontend flow (schedule, then trigger)

The page commits to the send queue, then fires the trigger. Status is polled
from the DB, not from the extension.

```ts
// 1) (optional) render the send-path choice — no dedicated endpoint: derive it
//    from GET /admin/social-providers (extensionPublishable + hasWriteApi flags)
//    intersected with the org's integrations list (a bound account → API path).

// 2) commit DRAFT → QUEUE (the real "send"); publishMethod + date optional.
const res = await fetch('/posts/schedule', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ posts: [
    { id: 'post-1' },
    { id: 'post-2', publishMethod: 'api', date: '2026-08-01T09:00:00.000Z' },
  ] }),
}).then((r) => r.json());
// res.scheduled: [{id, publishMethod}]   res.failed: [{id, code, message}]

// 3) trigger the extension to pull immediately (NO items). Optional — the 1-min
//    aisee-publish-poll alarm would pick it up anyway.
const requestId = crypto.randomUUID();
window.postMessage({ source: 'aisee', action: 'aisee:post-publish', requestId }, location.origin);
// ext → page: { source:'aisee-extension', action:'aisee:post-publish-result', requestId, ok, summary }

// 4) poll DB for status: GET /operation-plans/:id → post.state (QUEUE|PUBLISHED|ERROR)
```

## Internal queue item shape (built by the publish-due pull loop)

The pull loop maps each `POST /posts/publish-due` row into the `PublishPostItem`
below and calls `enqueuePublishBatch`; the queue then drains one task at a time.
This is no longer sent by the page — it is documented as the internal contract.

```ts
import { enqueuePublishBatch } from '@gitroom/helpers/extension/post-publish';

// Illustrative — this is what runPublishLoop builds from the publish-due response:
const ack = await enqueuePublishBatch([
  // 1) plain single post
  {
    taskId: 'post-1',
    platform: 'x',
    segments: [{ text: 'just one tweet' }],
  },
  // 2) X thread with images on the first segment + custom pacing + scheduled
  {
    taskId: 'post-2',
    platform: 'x',
    segments: [
      {
        text: '1/ main tweet',
        images: [
          'https://api-post-dev.aisee.live/uploads/a.png', // first segment only
          'https://api-post-dev.aisee.live/uploads/b.png',
        ],
      },
      { text: '2/ second' },
      { text: '3/ third' },
    ],
    segmentGapSeconds: [45, 90], // per-gap random pause; omit for the [30,120] default
    publishDate: '2026-07-23T10:00:00.000Z', // omit/past = publish ASAP
  },
  // 3) Reddit thread (submission + comment chain), default pacing
  {
    taskId: 'post-3',
    platform: 'reddit',
    subreddit: 'r/test',
    title: 'A title',
    segments: [{ text: 'body' }, { text: 'first follow-up comment' }],
  },
]);
// ack.accepted: PublishTaskState[]   ack.rejected: { taskId, reason }[]
```

> Historical note: before the demotion, the page sent this whole array on
> `aisee:post-publish` and the extension enqueued it directly. That path is gone —
> the page now commits via `POST /posts/schedule` and only *triggers* the pull
> (see the frontend flow above). The item shape above survives only as what the
> pull loop constructs internally.

## Semantics

- **Serial queue** in the extension service worker: one post at a time, one
  segment at a time.
  - Reddit: segment 0 → `POST /api/submit` (new self post); segment N →
    `POST /api/comment` replying to segment N-1's permalink (native chain
    thread). Session/modhash handling is shared with the Engage reply poster
    (cached, one forced-refresh retry on stale modhash).
  - X: **browser-tab automation only — never direct API calls from the
    worker.** Segment 0 opens `x.com/compose/post`, attaches images to the
    native composer's file input, fills the text, clicks X's own Post button
    and captures the CreateTweet response (MAIN-world interceptor) for the
    permalink; segment N replies to segment N-1 via the existing reply-tab
    automation. A `pending` outcome (X needed a human click — the tab is
    surfaced) settles the task as `error` for the unattended queue; a sent
    tweet whose URL couldn't be captured mid-thread also stops the chain.
- **Thread pacing (`segmentGapSeconds`)**: a random pause is drawn per gap
  from this `[minSeconds, maxSeconds]` range and slept BETWEEN thread segments
  (never after the last, never between different posts) — back-to-back
  follow-ups don't look human. Default `[30, 120]` on both platforms; `[0, 0]`
  disables it; capped at 600s/gap; a malformed range is rejected at enqueue.
  The sleep is chunked and touches a cheap extension API every ~20s to keep the
  MV3 worker alive across the pause; each segment is persisted as it posts.
- **Scheduling (`publishDate`)**: a future-dated task stays `queued` until
  due; the queue is persisted to `chrome.storage.local` and re-armed via a
  `chrome.alarms` wake-up, so scheduled posts survive service-worker death
  and browser restarts. The page does NOT need to stay open — but the browser
  must be running and logged in at fire time. A task that was mid-`publishing`
  when the worker died settles as `error` on restore (blind re-run would risk
  duplicates; `segmentPermalinks` shows what made it out).
- **Images** (`segments[0].images`, server URLs): the extension downloads
  each image and feeds it to the platform's OWN upload pipeline — Reddit via
  the media-asset lease + inline `![img](assetId)` markdown (subs that
  disable inline media reject at submit time), X via the composer's file
  input in the automation tab. Any image failing fails the whole task —
  never a silently image-less post. Image origins must be inside
  host_permissions (backend hosts already are; a separate CDN must be added
  to vite.config.base.ts).
- **Cancel** flips `queued` → `canceled` only — including scheduled tasks
  that haven't fired (that's the main cancel window). `publishing` and
  settled tasks come back under `notCancelable` with a reason
  (`already publishing` / `already settled (…)` / `not found`). Nothing
  already sent to the platform is ever undone.
- **Enqueue validation** rejects per-item (batch never fails whole): missing
  taskId, duplicate active taskId, empty segments (text or images required),
  images on non-first segments, reddit without subreddit/title, unparseable
  publishDate, unknown platform.
- **Progress** for a PAGE-driven task is pushed to the tab that enqueued the
  batch (best-effort; if the tab closed, poll `aisee:post-publish-status`). For a
  PULL-driven task (backend publish-due, no originating tab) progress is instead
  **broadcast to every frontend tab** as the same `aisee:post-publish-progress`
  message (with a fixed `requestId: "publish-due"`). A DB-authoritative page
  listens for the settling transition and re-fetches from the DB — live status
  without polling, the event only triggers the refresh. Wiring: the queue's
  `emit()` calls a registered broadcaster when `tabId == null`
  (`setPublishBroadcaster` in the service worker → `chrome.tabs.query` over the
  bridge origins).

## Follow-ups

- X follow-up segments with images (reply automation doesn't attach files yet).
- Reddit gallery/kind=image posts (v1 embeds images inline in a self post).
