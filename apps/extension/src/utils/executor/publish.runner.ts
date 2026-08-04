// Phase 2 — unattended scheduled publishing for extension-routed platforms
// (hackernews / quora / medium, or any platform an operator routed to the
// extension). The backend is the SCHEDULER: it leaves these Posts in QUEUE
// (Temporal is diverted, see posts.service startWorkflow) and this loop is the
// EXECUTOR — it pulls the due ones and feeds them into the SAME in-browser
// publish queue the page-driven bridge uses (taskId = Post.id, so the queue's
// existing extension-published backfill flips the same row to PUBLISHED).
//
//   POST /posts/publish-due { limit }  → { due: [{ id, platform, title, ... }] }
//   → enqueuePublishBatch(...)         → queue publishes in-browser + backfills
//
// De-dup is free: enqueuePublishBatch rejects a taskId already queued/publishing/
// sent, and a published Post leaves QUEUE so publish-due stops returning it — so
// re-polling every cadence is safe and idempotent.

import {
  IMAGE_CAPABLE_PLATFORMS,
  type PublishPlatform,
  type PublishPostItem,
} from '@gitroom/helpers/extension/post-publish';
import { backendCall, NotAuthenticatedError } from './api';
import {
  enqueuePublishBatch,
  initPublishQueue,
} from '@gitroom/extension/utils/post-publish/queue';

const PUBLISH_DUE_ENDPOINT = '/posts/publish-due';
const DUE_LIMIT = 10;

interface DuePublishPost {
  id: string;
  platform: string;
  title?: string;
  subreddit?: string;
  /** Dev.to topic tags (labels only — the backend strips the tag ids). */
  tags?: string[];
  segments: { text: string; images?: string[] }[];
  publishDate?: string | null;
  /** Account the post must go out as; absent when it has no bound account. */
  targetAccount?: { id: string; handle?: string; name?: string };
  /**
   * Admin-configured [minSeconds, maxSeconds] pause between thread segments
   * (extension_publish.segment_gap), resolved per platform by the backend.
   */
  segmentGapSeconds?: [number, number];
}

export interface PublishRunSummary {
  due: number;
  enqueued: number;
  rejected: number;
  /** Per-item rejection detail, present only when something was rejected. */
  rejections?: { taskId: string; reason: string }[];
  stoppedReason: 'ok' | 'idle' | 'error' | 'not-authenticated' | 'busy';
}

let publishInFlight = false;

/** Map a backend due-post into the publish queue's item shape. */
function toPublishItem(p: DuePublishPost): PublishPostItem {
  const platform = p.platform as PublishPlatform;
  // The backend resolves media for every extension-routed post, but only
  // IMAGE_CAPABLE_PLATFORMS' posters can upload one. Forwarding an image to a
  // text-only platform gets the whole item rejected at enqueue, and since a
  // rejected item never leaves Post.state=QUEUE the backend re-leases and
  // re-offers it every cycle — the post would never publish at all. Dropping
  // the image here keeps the text going out, which is what happened before
  // media was selected.
  const keepImages = IMAGE_CAPABLE_PLATFORMS.includes(platform);
  return {
    taskId: p.id,
    platform,
    segments: (p.segments || []).map((s) => ({
      text: s?.text ?? '',
      ...(keepImages && s?.images?.length ? { images: s.images } : {}),
    })),
    ...(p.title ? { title: p.title } : {}),
    ...(p.subreddit ? { subreddit: p.subreddit } : {}),
    ...(p.tags?.length ? { tags: p.tags } : {}),
    // Carried through so the queue can refuse to publish as the wrong account.
    // Dropping it here would silently disable that guard for the pull path —
    // which is exactly the unattended path that needs it most.
    ...(p.targetAccount?.id ? { targetAccount: p.targetAccount } : {}),
    // Admin-configured thread pacing. Dropping it here would silently pin the
    // pull path to the queue's hardcoded fallback and make the
    // extension_publish.segment_gap setting a no-op.
    ...(p.segmentGapSeconds ? { segmentGapSeconds: p.segmentGapSeconds } : {}),
    // No publishDate → the queue treats it as due-now (the backend already
    // filtered to publishDate <= now, so it should publish immediately).
  };
}

/**
 * Pull due extension-routed posts and enqueue them into the in-browser publish
 * queue. Safe to call on a schedule or manually; the queue owns the actual
 * posting, pacing and DB backfill.
 */
export async function runPublishLoop(): Promise<PublishRunSummary> {
  const summary: PublishRunSummary = {
    due: 0,
    enqueued: 0,
    rejected: 0,
    stoppedReason: 'ok',
  };
  if (publishInFlight) {
    summary.stoppedReason = 'busy';
    return summary;
  }
  publishInFlight = true;
  try {
    // Ensure the persisted queue is restored before enqueuing (so a dedup check
    // sees tasks that survived a worker restart).
    await initPublishQueue();

    let data: { due?: DuePublishPost[] } | null;
    try {
      const resp = await backendCall<{ due: DuePublishPost[] }>(
        PUBLISH_DUE_ENDPOINT,
        'POST',
        { limit: DUE_LIMIT }
      );
      if (!resp.ok) {
        console.warn('[aisee][publish] publish-due HTTP', resp.status, resp.data);
        summary.stoppedReason = 'error';
        return summary;
      }
      data = resp.data;
    } catch (e) {
      summary.stoppedReason =
        e instanceof NotAuthenticatedError ? 'not-authenticated' : 'error';
      if (!(e instanceof NotAuthenticatedError)) {
        console.warn('[aisee][publish] publish-due failed', e);
      }
      return summary;
    }

    const due = data?.due ?? [];
    summary.due = due.length;
    if (!due.length) {
      summary.stoppedReason = 'idle';
      return summary;
    }

    const items = due.map(toPublishItem);
    const ack = enqueuePublishBatch(`publish-due-${due.length}`, items, undefined);
    summary.enqueued = ack.accepted.length;
    summary.rejected = ack.rejected.length;
    console.log('[aisee][publish] enqueued from publish-due', {
      due: summary.due,
      enqueued: summary.enqueued,
      rejected: summary.rejected,
    });
    // The reason strings are the ONLY explanation of why a post could not be
    // accepted, and a rejected post stays QUEUE — so it comes back every cycle.
    // Logging just the count would make that loop indistinguishable from normal
    // operation and leave the failing taskId unrecoverable.
    if (ack.rejected.length) {
      summary.rejections = ack.rejected.map((r) => ({
        taskId: r.taskId,
        reason: r.reason,
      }));
      console.warn('[aisee][publish] rejected from publish-due', summary.rejections);
    }
    return summary;
  } finally {
    publishInFlight = false;
  }
}
