// Service-worker publish queue for the post-publish bridge: accepts a batch of
// posts (each optionally a thread, optionally scheduled via publishDate),
// drains DUE tasks serially (one post at a time, one segment at a time —
// parallel in-browser posting would look like automation and race the platform
// session), supports canceling tasks that have not started, and pushes every
// state transition back to the originating tab.
//
// Scheduling: a task with a future publishDate stays 'queued' until due. The
// queue is PERSISTED to chrome.storage.local and re-armed via chrome.alarms,
// so scheduled tasks survive service-worker death and browser restarts — the
// page does not need to stay open, only the browser (with its platform
// sessions) does. A task that was mid-'publishing' when the worker died is
// settled as 'error' on restore (segments may have partially posted; blind
// re-running would duplicate them — the recorded segmentPermalinks show what
// made it out).

import type {
  PublishEnqueueAck,
  PublishCancelAck,
  PublishPlatform,
  PublishPostItem,
  PublishTaskState,
} from '@gitroom/helpers/extension/post-publish';
import { ENGAGE_EXTENSION_ACTION } from '@gitroom/extension/utils/executor/actions';
import {
  postRedditComment,
  submitRedditPost,
} from '@gitroom/extension/utils/reddit.poster';
import {
  postXCompose,
  postXReply,
} from '@gitroom/extension/pages/background/x.poster';
import {
  postLinkedinCompose,
  postLinkedinComment,
} from '@gitroom/extension/pages/background/linkedin.poster';
import { backendCall } from '@gitroom/extension/utils/executor/api';

interface QueueEntry {
  item: PublishPostItem;
  state: PublishTaskState;
  requestId: string;
  tabId?: number;
  /** Epoch ms this task becomes due (0 = immediately). */
  dueAt: number;
}

const MAX_SETTLED = 200;
const STORAGE_KEY = 'aisee_publish_queue';
export const PUBLISH_ALARM = 'aisee-publish-due';

let entries: QueueEntry[] = [];
let drainPromise: Promise<void> | null = null;
let initPromise: Promise<void> | null = null;

// ── Test seams ──────────────────────────────────────────────────────────────

export interface SegmentResult {
  ok: boolean;
  permalink?: string;
  postId?: string;
  error?: string;
}

export type SegmentPublisher = (
  item: PublishPostItem,
  segmentIndex: number,
  prevPermalink: string | undefined
) => Promise<SegmentResult>;

/**
 * Default publisher.
 *   - Reddit: segment 0 submits a new self post (uploading + inlining its
 *     images); each following segment comments on the PREVIOUS segment
 *     (permalink chain → native thread).
 *   - X: segment 0 posts via the compose-page TAB automation (postXCompose);
 *     each following segment replies to the previous tweet via postXReply.
 *     NEVER direct API calls — the tab+interceptor path is the only allowed
 *     X write path.
 */
async function defaultPublishSegment(
  item: PublishPostItem,
  segmentIndex: number,
  prevPermalink: string | undefined
): Promise<SegmentResult> {
  const segment = item.segments[segmentIndex];
  const text = segment?.text ?? '';

  if (item.platform === 'x') {
    const r =
      segmentIndex === 0
        ? await postXCompose({ text, images: segment?.images })
        : prevPermalink
        ? await postXReply({ url: prevPermalink, text })
        : { ok: false as const, error: 'No previous segment permalink to thread onto' };
    if (!r.ok) return { ok: false, error: r.error };
    // pending = the composer was filled but X's own send never confirmed; for
    // an unattended queue that is a failure (the tab was surfaced to the user).
    if ('pending' in r && r.pending) {
      return {
        ok: false,
        error: r.message || 'X post left pending — finish it manually in the opened tab',
      };
    }
    // Sent but the CreateTweet capture timed out: without a permalink the
    // remaining segments cannot chain — only acceptable on the LAST segment.
    if (!r.permalink && segmentIndex < item.segments.length - 1) {
      return {
        ok: false,
        error:
          'tweet was sent but its URL could not be confirmed; remaining thread segments were not posted',
      };
    }
    return { ok: true, permalink: r.permalink, postId: r.postId };
  }

  if (item.platform === 'linkedin') {
    // LinkedIn: segment 0 is a new share; every following segment is a native
    // comment on the PREVIOUS segment's post (permalink chain → thread). Tab
    // automation only — never a direct Voyager call from the worker.
    const r =
      segmentIndex === 0
        ? await postLinkedinCompose({ text })
        : prevPermalink
        ? await postLinkedinComment({ url: prevPermalink, text })
        : { ok: false as const, error: 'No previous segment permalink to thread onto' };
    if (!r.ok) return { ok: false, error: r.error };
    if ('pending' in r && r.pending) {
      return {
        ok: false,
        error:
          r.message ||
          'LinkedIn post left pending — finish it manually in the opened tab',
      };
    }
    // A confirmed share returns an activity permalink; without one the following
    // comment segments have nothing to thread onto — only OK on the last segment.
    if (!r.permalink && segmentIndex < item.segments.length - 1) {
      return {
        ok: false,
        error:
          'LinkedIn post was sent but its URL could not be confirmed; remaining thread segments were not posted',
      };
    }
    return { ok: true, permalink: r.permalink, postId: r.postId };
  }

  if (segmentIndex === 0) {
    const r = await submitRedditPost({
      subreddit: item.subreddit || '',
      title: item.title || '',
      text,
      images: segment?.images,
    });
    if (!r.ok) return { ok: false, error: r.error };
    // pending = the captcha-fallback tab was surfaced but Reddit's own Post
    // button was never confirmed (a captcha to solve). For an unattended queue
    // that is a failure — never mark published without a real permalink (mirrors
    // the X/LinkedIn pending handling above).
    if (r.pending) {
      return {
        ok: false,
        error:
          r.message ||
          'Reddit post left pending — finish it manually in the opened tab',
      };
    }
    return { ok: true, permalink: r.permalink, postId: r.postId };
  }
  if (!prevPermalink) {
    return { ok: false, error: 'No previous segment permalink to thread onto' };
  }
  const r = await postRedditComment({ url: prevPermalink, text });
  return { ok: r.ok, permalink: r.permalink, postId: r.postId, error: r.error };
}

/**
 * Closed-loop DB backfill after a task publishes: report the permalink (+
 * platform post id) to the backend so the saved Post flips to PUBLISHED — the
 * Post-side mirror of the Engage reply's publish-reply callback. Uses the
 * extension's OWN authenticated session (backendCall → getValidAccessToken), so
 * it works even when the originating page is closed (scheduled posts). Taskid IS
 * the backend Post id. Best-effort: the post is live on-platform regardless, so
 * a failed backfill is logged, not fatal.
 */
export type PublishBackfiller = (
  taskId: string,
  releaseURL: string,
  releaseId: string | undefined
) => Promise<void>;

async function defaultBackfill(
  taskId: string,
  releaseURL: string,
  releaseId: string | undefined
): Promise<void> {
  const res = await backendCall<{ ok?: boolean; reason?: string }>(
    `/posts/${taskId}/extension-published`,
    'PATCH',
    { releaseURL, ...(releaseId ? { releaseId } : {}) }
  );
  // backendCall.ok is only the HTTP status; the endpoint also signals logical
  // failure (post not found / not owned by this session's org / recurring
  // original) as `{ ok: false }` in a 200 body. Throw on EITHER so the task
  // stays 'sent' with a real reason and offers Sync — never a silent
  // "published" while the DB row is untouched.
  if (!res.ok) {
    throw new Error(`backend responded ${res.status}`);
  }
  if (res.data && res.data.ok === false) {
    throw new Error(res.data.reason || 'backend rejected the backfill');
  }
}

/**
 * Advance a 'sent' task to 'published' by backfilling the DB, or leave it 'sent'
 * with a backfillError. The post is ALREADY live on-platform here, so a failure
 * is recorded (surfaced as a manual "Sync") — never a re-publish. Returns
 * whether it reached 'published' (callers use this rather than re-reading the
 * mutated status, which the type system can't narrow across the await).
 */
async function attemptBackfill(entry: QueueEntry): Promise<boolean> {
  if (!entry.state.permalink) {
    entry.state.backfillError = 'no permalink captured — cannot backfill';
    return false;
  }
  try {
    await backfillPublished(
      entry.state.taskId,
      entry.state.permalink,
      entry.state.postId
    );
    entry.state.status = 'published';
    delete entry.state.backfillError;
    return true;
  } catch (e: any) {
    // Stays 'sent'; the row shows a Sync button to retry.
    entry.state.backfillError = String(e?.message || e);
    return false;
  }
}

let publishSegment: SegmentPublisher = defaultPublishSegment;
let backfillPublished: PublishBackfiller = defaultBackfill;
let now: () => number = () => Date.now();

// ── Human-like pause between thread segments ────────────────────────────────
// Back-to-back follow-ups don't look human (and Reddit comments would fire
// within seconds of each other). A random pause is drawn per gap from the
// item's range, or these platform defaults.
// Conservative human-like defaults: real users don't machine-gun a thread, so
// wait 30–120s between segments on both platforms unless the caller overrides.
const DEFAULT_SEGMENT_GAP_S: Record<PublishPlatform, [number, number]> = {
  x: [30, 120],
  reddit: [30, 120],
  linkedin: [30, 120],
};
const MAX_SEGMENT_GAP_S = 600;

function segmentGapMs(item: PublishPostItem): number {
  const range =
    item.segmentGapSeconds ??
    DEFAULT_SEGMENT_GAP_S[item.platform as PublishPlatform] ??
    [0, 0];
  const lo = Math.max(0, Math.min(range[0], MAX_SEGMENT_GAP_S));
  const hi = Math.max(lo, Math.min(range[1], MAX_SEGMENT_GAP_S));
  return Math.round((lo + Math.random() * (hi - lo)) * 1000);
}

/**
 * Sleep in short chunks, touching a cheap extension API between chunks so the
 * MV3 service worker's idle timer keeps resetting during long thread gaps —
 * a single multi-minute setTimeout would let Chrome kill the worker mid-task.
 */
async function keepaliveSleep(ms: number): Promise<void> {
  const CHUNK_MS = 20_000;
  let remaining = ms;
  while (remaining > 0) {
    const step = Math.min(CHUNK_MS, remaining);
    await new Promise((r) => setTimeout(r, step));
    remaining -= step;
    try {
      await chrome.storage.local.get('__aisee_keepalive');
    } catch {
      /* no storage API (tests) — plain sleep is fine there */
    }
  }
}

let sleep: (ms: number) => Promise<void> = keepaliveSleep;

export function setSegmentPublisherForTest(fn: SegmentPublisher | null): void {
  publishSegment = fn ?? defaultPublishSegment;
}

export function setBackfillForTest(fn: PublishBackfiller | null): void {
  backfillPublished = fn ?? defaultBackfill;
}

export function setSleepForTest(
  fn: ((ms: number) => Promise<void>) | null
): void {
  sleep = fn ?? keepaliveSleep;
}

export function setNowForTest(fn: (() => number) | null): void {
  now = fn ?? (() => Date.now());
}

export function resetPublishQueueForTest(): void {
  entries = [];
  drainPromise = null;
  initPromise = null;
}

/** Await the current drain run (tests + graceful sequencing). */
export function waitForPublishIdle(): Promise<void> {
  return drainPromise ?? Promise.resolve();
}

// ── Persistence + alarm ─────────────────────────────────────────────────────

function persist(): void {
  try {
    const rows = entries.map(({ item, state, requestId, dueAt, tabId }) => ({
      item,
      state,
      requestId,
      dueAt,
      tabId,
    }));
    chrome.storage.local.set({ [STORAGE_KEY]: rows });
  } catch {
    /* no storage API (tests without stub) — queue stays in-memory */
  }
}

function loadPersisted(): Promise<QueueEntry[]> {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get([STORAGE_KEY], (data) => {
        const rows = data?.[STORAGE_KEY];
        resolve(Array.isArray(rows) ? rows : []);
      });
    } catch {
      resolve([]);
    }
  });
}

/** Point the wake-up alarm at the earliest future due time (or clear it). */
function armAlarm(): void {
  try {
    const nextDue = entries
      .filter((e) => e.state.status === 'queued' && e.dueAt > now())
      .reduce((min, e) => Math.min(min, e.dueAt), Infinity);
    if (nextDue === Infinity) {
      chrome.alarms.clear(PUBLISH_ALARM);
    } else {
      chrome.alarms.create(PUBLISH_ALARM, { when: nextDue });
    }
  } catch {
    /* no alarms API (tests without stub) — drain is kicked directly */
  }
}

/**
 * Restore the persisted queue on service-worker startup, settle interrupted
 * tasks, then resume draining/scheduling. Memoized per worker lifetime, and
 * every message handler awaits it BEFORE mutating the queue — otherwise an
 * enqueue arriving while the restore read is in flight would persist a
 * snapshot without the stored scheduled tasks and silently drop them. The
 * merge below is defense-in-depth for the same race.
 */
export function initPublishQueue(): Promise<void> {
  if (!initPromise) initPromise = restoreFromStorage();
  return initPromise;
}

async function restoreFromStorage(): Promise<void> {
  const rows = await loadPersisted();
  if (rows.length) {
    // Merge: keep whatever is already in memory and append stored rows whose
    // taskId isn't present — never wholesale-skip (that loses scheduled tasks).
    const known = new Set(entries.map((e) => e.state.taskId));
    for (const row of rows) {
      if (known.has(row.state.taskId)) continue;
      if (row.state.status === 'publishing') {
        row.state.status = 'error';
        row.state.error =
          'interrupted (service worker restarted mid-publish); ' +
          'check segmentPermalinks for what was already posted';
      }
      entries.push(row);
    }
    persist();
  }
  kickDrain();
  armAlarm();
}

/** chrome.alarms dispatcher hook; true when the alarm was ours. */
export function handlePublishAlarm(alarmName: string): boolean {
  if (alarmName !== PUBLISH_ALARM) return false;
  kickDrain();
  return true;
}

// ── Progress push ───────────────────────────────────────────────────────────

const QLOG = '[aisee-publish:sw:queue]';
function qlog(...args: unknown[]): void {
  try {
    // eslint-disable-next-line no-console
    console.log(QLOG, ...args);
  } catch {
    /* no console (tests) — ignore */
  }
}

function emit(entry: QueueEntry): void {
  if (entry.tabId == null) {
    qlog('emit skipped — no originating tab', {
      taskId: entry.state.taskId,
      status: entry.state.status,
    });
    return;
  }
  try {
    chrome.tabs.sendMessage(
      entry.tabId,
      {
        action: ENGAGE_EXTENSION_ACTION.publishProgressPush,
        requestId: entry.requestId,
        state: { ...entry.state },
      },
      () => {
        // Tab closed / bridge gone — progress is best-effort; the status
        // probe remains the source of truth.
        void chrome.runtime.lastError;
      }
    );
  } catch {
    /* no tabs API (tests) — ignore */
  }
}

// ── Enqueue / cancel / snapshot ─────────────────────────────────────────────

function isActive(e: QueueEntry): boolean {
  // 'sent' counts as active: the post is live on-platform (re-enqueuing the same
  // taskId would duplicate it) and it still needs its DB backfill, so it must
  // never be trimmed as "settled" either.
  return (
    e.state.status === 'queued' ||
    e.state.status === 'publishing' ||
    e.state.status === 'sent'
  );
}

function validate(item: PublishPostItem): string | null {
  if (!item?.taskId || typeof item.taskId !== 'string') return 'missing taskId';
  if (entries.some((e) => isActive(e) && e.state.taskId === item.taskId))
    return 'duplicate taskId (already queued, publishing, or sent)';
  if (
    item.platform !== 'reddit' &&
    item.platform !== 'x' &&
    item.platform !== 'linkedin'
  )
    return `unsupported platform: ${item.platform}`;
  const segments = Array.isArray(item.segments) ? item.segments : [];
  if (!segments.length || segments.some((s) => !(s?.text || '').trim() && !s?.images?.length))
    return 'segments must be a non-empty list with text or images';
  if (segments.slice(1).some((s) => s?.images?.length))
    return 'images are only supported on the first segment';
  if (item.platform === 'reddit') {
    if (!(item.subreddit || '').trim()) return 'reddit post needs a subreddit';
    if (!(item.title || '').trim()) return 'reddit post needs a title';
  }
  if (item.platform === 'linkedin') {
    // LinkedIn media upload isn't wired through the tab composer yet; reject at
    // enqueue so an image post never silently publishes text-only.
    if (segments.some((s) => s?.images?.length))
      return 'LinkedIn image posts are not supported via the extension yet';
  }
  if (item.publishDate != null && Number.isNaN(Date.parse(item.publishDate)))
    return 'invalid publishDate (must be an ISO datetime)';
  if (item.segmentGapSeconds != null) {
    const g = item.segmentGapSeconds;
    if (
      !Array.isArray(g) ||
      g.length !== 2 ||
      !Number.isFinite(g[0]) ||
      !Number.isFinite(g[1]) ||
      g[0] < 0 ||
      g[1] < g[0]
    )
      return 'invalid segmentGapSeconds (expected [minSeconds, maxSeconds])';
  }
  return null;
}

export function enqueuePublishBatch(
  requestId: string,
  items: PublishPostItem[],
  tabId: number | undefined
): PublishEnqueueAck {
  const ack: PublishEnqueueAck = { accepted: [], rejected: [] };
  for (const item of items) {
    const reason = validate(item);
    if (reason) {
      ack.rejected.push({ taskId: String(item?.taskId ?? ''), reason });
      continue;
    }
    const dueAt = item.publishDate ? Date.parse(item.publishDate) : 0;
    const entry: QueueEntry = {
      item,
      requestId,
      tabId,
      dueAt,
      state: {
        taskId: item.taskId,
        platform: item.platform,
        status: 'queued',
        segmentsTotal: item.segments.length,
        segmentsPublished: 0,
        ...(dueAt > 0
          ? { publishAt: new Date(dueAt).toISOString() }
          : {}),
      },
    };
    entries.push(entry);
    ack.accepted.push({ ...entry.state });
  }
  trimSettled();
  if (ack.accepted.length) {
    persist();
    kickDrain();
    armAlarm();
  }
  return ack;
}

export function cancelPublishTasks(taskIds: string[]): PublishCancelAck {
  const ack: PublishCancelAck = { canceled: [], notCancelable: [] };
  for (const taskId of taskIds) {
    // Latest entry wins: a re-enqueued taskId may also exist as an old settled row.
    const entry = [...entries]
      .reverse()
      .find((e) => e.state.taskId === taskId);
    if (!entry) {
      ack.notCancelable.push({ taskId, reason: 'not found' });
      continue;
    }
    if (entry.state.status === 'queued') {
      entry.state.status = 'canceled';
      emit(entry);
      ack.canceled.push(taskId);
    } else if (entry.state.status === 'publishing') {
      ack.notCancelable.push({ taskId, reason: 'already publishing' });
    } else {
      ack.notCancelable.push({
        taskId,
        reason: `already settled (${entry.state.status})`,
      });
    }
  }
  if (ack.canceled.length) {
    persist();
    armAlarm();
  }
  return ack;
}

/**
 * Make a still-'queued' task due immediately (manual "Publish now" from the
 * popup/panel). No-op with a reason when the task isn't queued (already
 * publishing or settled). Clears any future publishAt so the row stops reading
 * as scheduled, persists (so the popup's storage listener refreshes) and kicks
 * the drain.
 */
export function publishTaskNow(taskId: string): {
  ok: boolean;
  reason?: string;
} {
  // Latest entry wins: a re-enqueued taskId may also exist as an old settled row.
  const entry = [...entries].reverse().find((e) => e.state.taskId === taskId);
  if (!entry) return { ok: false, reason: 'not found' };
  if (entry.state.status !== 'queued')
    return { ok: false, reason: `not queued (${entry.state.status})` };
  entry.dueAt = 0;
  delete entry.state.publishAt;
  persist();
  emit(entry);
  kickDrain();
  armAlarm();
  return { ok: true };
}

/** Latest entry for a taskId (a re-enqueued id may also exist as an old row). */
function latestEntry(taskId: string): QueueEntry | undefined {
  return [...entries].reverse().find((e) => e.state.taskId === taskId);
}

/**
 * Manual "Sync": retry the DB backfill for a task that is live on-platform but
 * still 'sent' (auto-backfill failed). Idempotent on the backend, so pressing
 * it repeatedly is safe. Advances to 'published' on success.
 */
export async function syncPublishTask(
  taskId: string
): Promise<{ ok: boolean; reason?: string }> {
  const entry = latestEntry(taskId);
  if (!entry) return { ok: false, reason: 'not found' };
  if (entry.state.status !== 'sent')
    return { ok: false, reason: `not sent (${entry.state.status})` };
  const published = await attemptBackfill(entry);
  persist();
  emit(entry);
  return published
    ? { ok: true }
    : { ok: false, reason: entry.state.backfillError || 'backfill failed' };
}

/**
 * Manual "Retry" for a task whose platform send FAILED ('error'). Re-queues it
 * from scratch. Refused when any segment already went out (segmentsPublished >
 * 0): re-running a partially-posted thread would duplicate the live segments.
 */
export function retryPublishTask(taskId: string): {
  ok: boolean;
  reason?: string;
} {
  const entry = latestEntry(taskId);
  if (!entry) return { ok: false, reason: 'not found' };
  if (entry.state.status !== 'error')
    return { ok: false, reason: `not error (${entry.state.status})` };
  if (entry.state.segmentsPublished > 0)
    return {
      ok: false,
      reason: 'partial thread already posted — cannot safely retry',
    };
  entry.state.status = 'queued';
  entry.state.segmentsPublished = 0;
  delete entry.state.error;
  delete entry.state.backfillError;
  delete entry.state.permalink;
  delete entry.state.postId;
  delete entry.state.segmentPermalinks;
  delete entry.state.publishedAt;
  entry.dueAt = 0;
  persist();
  emit(entry);
  kickDrain();
  armAlarm();
  return { ok: true };
}

/**
 * Remove a settled row (error / canceled / published) from the queue. Refused
 * for in-flight or actionable states: 'publishing' (mid-send), 'queued' (cancel
 * it instead), and 'sent' (sync it — the post is live and unrecorded).
 */
export function removePublishTask(taskId: string): {
  ok: boolean;
  reason?: string;
} {
  const entry = latestEntry(taskId);
  if (!entry) return { ok: false, reason: 'not found' };
  const status = entry.state.status;
  if (status === 'publishing')
    return { ok: false, reason: 'cannot remove while publishing' };
  if (status === 'queued') return { ok: false, reason: 'cancel it first' };
  if (status === 'sent')
    return { ok: false, reason: 'sync it first (post is live but unrecorded)' };
  entries = entries.filter((e) => e !== entry);
  persist();
  return { ok: true };
}

/**
 * Best-effort "when did this settled task happen" timestamp, used to age out
 * history. Prefers the real send time, then the intended publish time, then the
 * due time it was enqueued for. Returns 0 when nothing is known (an ancient row
 * that any cutoff should sweep).
 */
function settledTimestamp(e: QueueEntry): number {
  const iso = e.state.publishedAt || e.state.publishAt;
  if (iso) {
    const t = Date.parse(iso);
    if (!Number.isNaN(t)) return t;
  }
  return e.dueAt || 0;
}

/**
 * Bulk-clear settled history rows (published / error / canceled). Active rows
 * (queued / publishing / sent) are always kept — a 'sent' post is live but not
 * yet recorded, and a queued/publishing one is still in flight. When olderThanMs
 * is given, only rows whose settled time is beyond that cutoff are dropped;
 * omit it to clear all history. Returns how many rows were removed.
 */
export function clearSettledPublishTasks(olderThanMs?: number): {
  removed: number;
} {
  const cutoff = olderThanMs != null ? now() - olderThanMs : Infinity;
  const before = entries.length;
  entries = entries.filter((e) => {
    if (isActive(e)) return true;
    return settledTimestamp(e) >= cutoff;
  });
  const removed = before - entries.length;
  if (removed) persist();
  return { removed };
}

/**
 * Bulk-drop every still-'queued' task (not yet sent, including future-scheduled
 * ones). 'publishing' is left alone (mid-send) and settled rows are untouched.
 * Re-arms the alarm since a dropped task may have held the next wake-up. Returns
 * how many were removed.
 */
export function clearQueuedPublishTasks(): { removed: number } {
  const drop = new Set(entries.filter((e) => e.state.status === 'queued'));
  if (!drop.size) return { removed: 0 };
  entries = entries.filter((e) => !drop.has(e));
  persist();
  armAlarm();
  return { removed: drop.size };
}

export function publishQueueSnapshot(): PublishTaskState[] {
  return entries.map((e) => ({ ...e.state }));
}

/** Cap remembered settled tasks so the queue can't grow without bound. */
function trimSettled(): void {
  const settled = entries.filter((e) => !isActive(e));
  const excess = settled.length - MAX_SETTLED;
  if (excess <= 0) return;
  const drop = new Set(settled.slice(0, excess));
  entries = entries.filter((e) => !drop.has(e));
}

// ── Serial drain (due tasks only) ───────────────────────────────────────────

function kickDrain(): void {
  if (drainPromise) return;
  drainPromise = drain().finally(() => {
    drainPromise = null;
  });
}

async function drain(): Promise<void> {
  for (;;) {
    const entry = entries.find(
      (e) => e.state.status === 'queued' && e.dueAt <= now()
    );
    if (!entry) {
      const waiting = entries.filter((e) => e.state.status === 'queued').length;
      qlog('drain idle — no due task', { queuedWaiting: waiting });
      armAlarm(); // future-scheduled tasks (if any) will wake us
      return;
    }

    qlog('drain → publishing', {
      taskId: entry.state.taskId,
      platform: entry.item.platform,
      segments: entry.item.segments.length,
    });
    entry.state.status = 'publishing';
    persist();
    emit(entry);

    const permalinks: string[] = [];
    let failed: string | undefined;
    for (let i = 0; i < entry.item.segments.length; i++) {
      let result: SegmentResult;
      try {
        qlog('publishing segment', {
          taskId: entry.state.taskId,
          segment: `${i + 1}/${entry.item.segments.length}`,
        });
        result = await publishSegment(entry.item, i, permalinks[i - 1]);
      } catch (e: any) {
        result = { ok: false, error: String(e?.message || e) };
      }
      qlog('segment result', {
        taskId: entry.state.taskId,
        segment: `${i + 1}/${entry.item.segments.length}`,
        ok: result.ok,
        permalink: result.permalink,
        error: result.error,
      });
      if (!result.ok) {
        failed = result.error || `segment ${i + 1} failed`;
        break;
      }
      if (result.permalink) permalinks.push(result.permalink);
      entry.state.segmentsPublished = i + 1;
      if (i === 0) {
        entry.state.permalink = result.permalink;
        entry.state.postId = result.postId;
        // Real publish time = when the anchor actually posted. Recorded on EVERY
        // successful publish (immediate, scheduled-due, or Publish-now on a
        // future-scheduled task), so history shows when it truly went out rather
        // than the scheduled publishAt.
        entry.state.publishedAt = new Date(now()).toISOString();
      }
      entry.state.segmentPermalinks = [...permalinks];
      // Persist per segment so a worker death mid-thread leaves an accurate
      // record of what already went out.
      persist();
      emit(entry);

      // Human-like pause before the NEXT segment of the same thread.
      if (i < entry.item.segments.length - 1) {
        const gap = segmentGapMs(entry.item);
        if (gap > 0) await sleep(gap);
      }
    }

    if (failed) {
      // Platform send itself failed — nothing (safely) live.
      entry.state.status = 'error';
      entry.state.error = failed;
      qlog('task error (platform send failed)', {
        taskId: entry.state.taskId,
        segmentsPublished: entry.state.segmentsPublished,
        error: failed,
      });
      persist();
      emit(entry);
      trimSettled();
      continue;
    }

    // Platform send succeeded → SENT. Surface it immediately, THEN try the DB
    // backfill (SENT → PUBLISHED, or stays SENT with a backfillError for the
    // user to Sync). Two-phase so the panel reflects "live, syncing…" honestly
    // and a backend outage never masquerades as a publish failure.
    entry.state.status = 'sent';
    delete entry.state.error;
    qlog('task sent (platform ok)', {
      taskId: entry.state.taskId,
      permalink: entry.state.permalink,
    });
    persist();
    emit(entry);

    await attemptBackfill(entry);
    qlog('after backfill', {
      taskId: entry.state.taskId,
      status: entry.state.status,
      backfillError: entry.state.backfillError,
    });
    persist();
    emit(entry);
    trimSettled();
  }
}
