// Drives the demand-driven post-metrics track:
//   POST /posts/metrics/due       → the subset of viewed posts due for a refresh
//   fetch each with the session    → AnalyticsData per platform
//   POST /posts/metrics/ingest     → submit fetched metrics; server reuses
//                                    extractMetrics + traffic (pure data submit)
// View-scoped by design: the caller supplies the post ids currently in view
// (or, for debugging, any ids). The server enforces the window ∩ interval gate.

import { backendCall, NotAuthenticatedError } from './api';
import { DueMetricsResponse, MetricsIngestItem } from './executor.types';
import { applyDelay, tryConsumeHourly } from './pacing';
import { fetchRedditMetrics } from './metrics.reddit';
import { fetchXMetrics } from './metrics.x';
import { X_EXECUTOR_ENABLED } from './flags';

const DUE_ENDPOINT = '/posts/metrics/due';
const INGEST_ENDPOINT = '/posts/metrics/ingest';

// Metrics GETs hit x.com / reddit.com with the personal session too, so they
// share a paced, capped cadence (no per-task pacing is sent for this track).
const METRICS_HOURLY_CAP = 60;
const METRICS_INTER_POST_DELAY_MS = 2_000;
const METRICS_INTER_POST_JITTER_MS = 3_000;

export interface MetricsRunSummary {
  due: number;
  fetched: number;
  ingested: number;
  stoppedReason: 'ok' | 'cap' | 'error' | 'not-authenticated' | 'no-ids';
}

let metricsInFlight = false;

export async function runMetrics(ids: string[]): Promise<MetricsRunSummary> {
  const summary: MetricsRunSummary = {
    due: 0,
    fetched: 0,
    ingested: 0,
    stoppedReason: 'ok',
  };
  const clean = Array.from(
    new Set((ids ?? []).filter((s) => typeof s === 'string' && s))
  ).slice(0, 100); // backend caps the due request at 100
  if (!clean.length) {
    summary.stoppedReason = 'no-ids';
    return summary;
  }
  if (metricsInFlight) {
    summary.stoppedReason = 'error';
    return summary;
  }
  metricsInFlight = true;
  try {
    let due: DueMetricsResponse;
    try {
      const resp = await backendCall<DueMetricsResponse>(DUE_ENDPOINT, 'POST', {
        ids: clean,
      });
      if (!resp.ok) {
        console.warn('[aisee][metrics] due HTTP', resp.status, resp.data);
        summary.stoppedReason = 'error';
        return summary;
      }
      due = resp.data;
    } catch (e) {
      summary.stoppedReason =
        e instanceof NotAuthenticatedError ? 'not-authenticated' : 'error';
      if (!(e instanceof NotAuthenticatedError)) {
        console.warn('[aisee][metrics] due failed', e);
      }
      return summary;
    }

    const posts = due.due ?? [];
    summary.due = posts.length;
    const items: MetricsIngestItem[] = [];

    for (let i = 0; i < posts.length; i++) {
      const post = posts[i];
      const platform = post.integration?.providerIdentifier;
      const url = post.releaseURL;
      if (!platform || !url) continue;
      // X metrics go through the personal x.com session — OFF by default (see
      // flags.ts). Skip before consuming any budget / hitting x.com.
      if (platform === 'x' && !X_EXECUTOR_ENABLED) continue;

      if (!(await tryConsumeHourly(METRICS_HOURLY_CAP, platform))) {
        summary.stoppedReason = 'cap';
        break;
      }
      if (i > 0) {
        await applyDelay(
          METRICS_INTER_POST_DELAY_MS,
          METRICS_INTER_POST_JITTER_MS
        );
      }

      let analytics = null;
      if (platform === 'reddit') analytics = await fetchRedditMetrics(url);
      else if (platform === 'x') analytics = await fetchXMetrics(url);
      else continue; // platform the extension can't fetch with a session

      if (analytics?.length) {
        summary.fetched += 1;
        items.push({ postId: post.id, analytics });
      }
    }

    if (items.length) {
      try {
        const resp = await backendCall<{ updated: string[]; stamped: string[] }>(
          INGEST_ENDPOINT,
          'POST',
          { items }
        );
        if (resp.ok) {
          summary.ingested = resp.data?.updated?.length ?? items.length;
        } else {
          console.warn('[aisee][metrics] ingest HTTP', resp.status, resp.data);
          summary.stoppedReason = 'error';
        }
      } catch (e) {
        console.warn('[aisee][metrics] ingest failed', e);
        summary.stoppedReason = 'error';
      }
    }
  } finally {
    metricsInFlight = false;
  }
  console.log('[aisee][metrics] run complete', summary);
  return summary;
}
