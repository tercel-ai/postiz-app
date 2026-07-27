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

import type { PublishPostItem } from '@gitroom/helpers/extension/post-publish';
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
  segments: { text: string }[];
  publishDate?: string | null;
}

export interface PublishRunSummary {
  due: number;
  enqueued: number;
  rejected: number;
  stoppedReason: 'ok' | 'idle' | 'error' | 'not-authenticated' | 'busy';
}

let publishInFlight = false;

/** Map a backend due-post into the publish queue's item shape. */
function toPublishItem(p: DuePublishPost): PublishPostItem {
  return {
    taskId: p.id,
    platform: p.platform as PublishPostItem['platform'],
    segments: (p.segments || []).map((s) => ({ text: s?.text ?? '' })),
    ...(p.title ? { title: p.title } : {}),
    ...(p.subreddit ? { subreddit: p.subreddit } : {}),
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
    return summary;
  } finally {
    publishInFlight = false;
  }
}
