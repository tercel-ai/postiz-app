# Extension Post-Publish Protocol (batch + thread + cancel)

The web app hands the extension a **batch of posts** (each optionally a
thread) to publish in-browser with the user's own platform session, tracks
per-task progress, and may **cancel tasks that have not started**.

Shared types + page-side helpers: `@gitroom/helpers/extension/post-publish`
(`enqueuePublishBatch` / `cancelPublishTasks` / `getPublishQueueStatus` /
`onPublishProgress`). External frontends (e.g. aisee-app) speak the raw
postMessage protocol below.

## Messages (same-origin `window.postMessage`)

| Direction | `action` | Payload |
|---|---|---|
| page → ext | `aisee:post-publish` | `{ requestId, items: PublishPostItem[] }` |
| ext → page | `aisee:post-publish-result` | `{ requestId, ok, accepted: PublishTaskState[], rejected: {taskId, reason}[] }` |
| ext → page | `aisee:post-publish-progress` | `{ requestId, state: PublishTaskState }` — pushed on every transition |
| page → ext | `aisee:post-publish-cancel` | `{ requestId, taskIds: string[] }` |
| ext → page | `aisee:post-publish-cancel-result` | `{ requestId, ok, canceled: string[], notCancelable: {taskId, reason}[] }` |
| page → ext | `aisee:post-publish-status` | `{ requestId }` |
| ext → page | `aisee:post-publish-status-result` | `{ requestId, ok, states: PublishTaskState[] }` |

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
  status: 'queued' | 'publishing' | 'published' | 'error' | 'canceled';
  segmentsTotal: number;
  segmentsPublished: number;
  permalink?: string;           // first segment, once published
  segmentPermalinks?: string[]; // every published segment in thread order
  postId?: string;              // platform id of the post (reddit t3_* / X rest_id)
  publishAt?: string;           // ISO, echoed from publishDate when scheduled
  error?: string;
}
```

## Example (batch enqueue)

One message carries the whole batch; the queue then drains it one task at a
time. In-repo frontends use the helper; external frontends post the same
`items` array over the raw protocol.

```ts
import { enqueuePublishBatch } from '@gitroom/helpers/extension/post-publish';

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

Raw protocol equivalent (external frontends):

```ts
window.postMessage(
  { source: 'aisee', action: 'aisee:post-publish', requestId, items: [/* same array */] },
  location.origin
);
```

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
- **Progress** is pushed to the tab that enqueued the batch (best-effort; if
  the tab closed, poll `aisee:post-publish-status` — it is the source of
  truth and also remembers up to 200 settled tasks).

## Follow-ups

- X follow-up segments with images (reply automation doesn't attach files yet).
- Reddit gallery/kind=image posts (v1 embeds images inline in a self post).
