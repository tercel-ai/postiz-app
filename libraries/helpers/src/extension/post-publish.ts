// Page-side helpers + shared types for the post-publish bridge: the web app
// hands the extension a BATCH of posts (each optionally a thread) to publish
// in-browser with the user's own platform session, then tracks progress and
// may cancel tasks that have not started yet.
//
// Protocol (all messages same-origin window.postMessage):
//   page → ext  aisee:post-publish         { requestId, items: PublishPostItem[] }
//   ext  → page aisee:post-publish-result  { requestId, ok, accepted, rejected }
//   ext  → page aisee:post-publish-progress{ requestId, state }   (pushed per transition)
//   page → ext  aisee:post-publish-cancel  { requestId, taskIds }
//   ext  → page aisee:post-publish-cancel-result { requestId, ok, canceled, notCancelable }
//   page → ext  aisee:post-publish-status  { requestId }
//   ext  → page aisee:post-publish-status-result { requestId, ok, states }
//
// Semantics:
//   - The queue lives in the extension service worker and drains SERIALLY (one
//     post at a time; a thread's segments post in order, each following segment
//     replying to the previous one — a native chain).
//   - Cancel only affects tasks still 'queued'. A task that is 'publishing' or
//     already settled is reported under notCancelable with a reason.
//   - The queue is in-memory: if the service worker is killed, queued (not yet
//     started) tasks are dropped. The page should reconcile via the status
//     probe and re-enqueue; taskId de-dupe makes re-enqueueing safe while a
//     task is still active.
//   - Platforms: reddit publishes via the session API (new submission +
//     comment-chain thread). x and linkedin publish via BROWSER-TAB automation
//     only — the extension opens the platform's own composer, fills it, clicks
//     the platform's own Post/Reply button and intercepts the create response.
//     Neither calls the platform API directly from the worker. LinkedIn threads
//     continue as native comments on the previous segment; LinkedIn image posts
//     are not supported via the extension yet (text-only).
//
// Both sides import these types, so the payload shape can never drift.

import { EXTENSION_MESSAGE } from './brand';

export type PublishPlatform = 'x' | 'reddit' | 'linkedin';

export interface PublishThreadSegment {
  /** Plain text of this segment. */
  text: string;
  /**
   * Absolute URLs of images ALREADY stored on our server. The extension
   * downloads each and hands it to the platform's own upload pipeline
   * (Reddit: media-asset lease → inline `![img](assetId)` markdown; X: files
   * attached to the native composer in the automation tab). Every image
   * origin must be covered by the extension's host_permissions (backend
   * hosts are; a separate CDN needs adding). Only the FIRST segment may
   * carry images (Reddit comments can't; X reply automation doesn't attach).
   */
  images?: string[];
}

export interface PublishPostItem {
  /** Caller's id for this post (e.g. the backend Post id) — echoed in every event. */
  taskId: string;
  platform: PublishPlatform;
  /**
   * First segment = the post itself; every following segment publishes as a
   * native thread continuation (Reddit: comment chain under the submission).
   */
  segments: PublishThreadSegment[];
  /** Reddit only (required): subreddit to submit to, with or without the r/ prefix. */
  subreddit?: string;
  /** Reddit only (required): submission title. */
  title?: string;
  /**
   * ISO datetime to publish at (the Post's publishDate). Absent or in the
   * past = publish as soon as the queue reaches it. The extension persists
   * scheduled tasks and wakes itself with an alarm, so the browser session
   * (not the page) is what must be alive at fire time.
   */
  publishDate?: string;
  /**
   * Random human-like pause between THREAD segments, as a [minSeconds,
   * maxSeconds] range (a value in it is drawn per gap). Default [30, 120] on
   * both platforms — back-to-back follow-ups don't look human. [0, 0]
   * disables the pause. Capped at 600s per gap. Only applies between
   * segments of one thread, not between different posts.
   */
  segmentGapSeconds?: [number, number];
}

export type PublishTaskStatus =
  | 'queued'
  | 'publishing'
  | 'published'
  | 'error'
  | 'canceled';

export interface PublishTaskState {
  taskId: string;
  platform: PublishPlatform;
  status: PublishTaskStatus;
  segmentsTotal: number;
  segmentsPublished: number;
  /** Permalink of the FIRST segment (the post itself), once published. */
  permalink?: string;
  /** Permalinks of every published segment, in thread order. */
  segmentPermalinks?: string[];
  /** Platform id of the first segment (Reddit t3_* fullname). */
  postId?: string;
  /** When this task is scheduled to publish (ISO), echoed from publishDate. */
  publishAt?: string;
  error?: string;
}

export interface PublishRejectedItem {
  taskId: string;
  reason: string;
}

export interface PublishEnqueueAck {
  accepted: PublishTaskState[];
  rejected: PublishRejectedItem[];
}

export interface PublishCancelAck {
  canceled: string[];
  notCancelable: PublishRejectedItem[];
}

// ── Page-side API ───────────────────────────────────────────────────────────

function newRequestId(prefix: string): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

/** One request/response round-trip over the bridge, correlated by requestId. */
function bridgeRequest<T>(
  action: string,
  resultAction: string,
  extra: Record<string, unknown>,
  parse: (data: any) => T | undefined,
  timeoutMs: number
): Promise<T> {
  const requestId = newRequestId(action);
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      window.removeEventListener('message', onMessage);
      reject(new Error(`The extension did not answer ${action}`));
    }, timeoutMs);

    function onMessage(event: MessageEvent) {
      if (event.source !== window) return;
      if (event.origin !== window.location.origin) return;
      const data = event.data as {
        source?: string;
        action?: string;
        requestId?: string;
        ok?: boolean;
        error?: string;
      };
      if (data?.source !== EXTENSION_MESSAGE.resultSource) return;
      if (data.action !== resultAction) return;
      if (data.requestId !== requestId) return;
      window.clearTimeout(timeout);
      window.removeEventListener('message', onMessage);
      const parsed = data.ok ? parse(data) : undefined;
      if (parsed === undefined) {
        reject(new Error(data.error || `The extension rejected ${action}`));
        return;
      }
      resolve(parsed);
    }

    window.addEventListener('message', onMessage);
    window.postMessage(
      { source: EXTENSION_MESSAGE.source, action, requestId, ...extra },
      window.location.origin
    );
  });
}

/**
 * Enqueue a batch of posts. Resolves with the enqueue ACK (per-item
 * accepted/rejected split) — publishing itself continues in the background;
 * subscribe with onPublishProgress / poll getPublishQueueStatus to follow it.
 */
export function enqueuePublishBatch(
  items: PublishPostItem[],
  timeoutMs = 10_000
): Promise<PublishEnqueueAck> {
  return bridgeRequest(
    EXTENSION_MESSAGE.postPublish,
    EXTENSION_MESSAGE.postPublishResult,
    { items },
    (d) =>
      Array.isArray(d.accepted) && Array.isArray(d.rejected)
        ? { accepted: d.accepted, rejected: d.rejected }
        : undefined,
    timeoutMs
  );
}

/** Cancel publish tasks that have not started yet (status 'queued'). */
export function cancelPublishTasks(
  taskIds: string[],
  timeoutMs = 10_000
): Promise<PublishCancelAck> {
  return bridgeRequest(
    EXTENSION_MESSAGE.postPublishCancel,
    EXTENSION_MESSAGE.postPublishCancelResult,
    { taskIds },
    (d) =>
      Array.isArray(d.canceled) && Array.isArray(d.notCancelable)
        ? { canceled: d.canceled, notCancelable: d.notCancelable }
        : undefined,
    timeoutMs
  );
}

/** Snapshot every task the queue currently knows about (active + recent). */
export function getPublishQueueStatus(
  timeoutMs = 10_000
): Promise<PublishTaskState[]> {
  return bridgeRequest(
    EXTENSION_MESSAGE.postPublishStatus,
    EXTENSION_MESSAGE.postPublishStatusResult,
    {},
    (d) => (Array.isArray(d.states) ? d.states : undefined),
    timeoutMs
  );
}

/**
 * Subscribe to pushed per-task state transitions (queued → publishing →
 * published/error, plus segment counters). Returns an unsubscribe function.
 */
export function onPublishProgress(
  callback: (state: PublishTaskState) => void
): () => void {
  function onMessage(event: MessageEvent) {
    if (event.source !== window) return;
    if (event.origin !== window.location.origin) return;
    const data = event.data as {
      source?: string;
      action?: string;
      state?: PublishTaskState;
    };
    if (data?.source !== EXTENSION_MESSAGE.resultSource) return;
    if (data.action !== EXTENSION_MESSAGE.postPublishProgress) return;
    if (!data.state?.taskId) return;
    callback(data.state);
  }
  window.addEventListener('message', onMessage);
  return () => window.removeEventListener('message', onMessage);
}
