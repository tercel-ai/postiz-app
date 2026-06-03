/**
 * Why is a PUBLISHED engage reply still missing metrics? Classify each reply so
 * the sync tooling can tell "needs the link first" apart from "everything's in
 * place but the fetch returned nothing". Pure + shared by EngageRepository
 * (getEngageMetricsStats) and scripts/engage-sync-metrics.ts so the breakdown
 * has one definition.
 *
 *   has_metrics     impressions already populated — nothing to do.
 *   no_release_url  no reply URL ("I'll add the link later") → nothing to fetch;
 *                   user must backfill via PATCH /engage/sent/:id/reply-url.
 *   no_integration  X only — Post has no connected account, so checkPostAnalytics
 *                   can't read it. Run the integration backfill.
 *   no_release_id   X only — URL present but no /status/<id> parsed; can't query.
 *   syncable        all prerequisites present, but impressions are still null —
 *                   the fetch was attempted and returned nothing (X API tier
 *                   block / Reddit WAF / not yet run). This is the bucket to
 *                   investigate with the platform-specific scripts.
 */

export type ReplyMetricStatus =
  | 'has_metrics'
  | 'no_release_url'
  | 'no_integration'
  | 'no_release_id'
  | 'syncable';

export interface ReplyMetricInput {
  platform: string;
  impressions: number | null | undefined;
  releaseURL: string | null | undefined;
  releaseId: string | null | undefined;
  integrationId: string | null | undefined;
}

export function classifyReplyMetric(r: ReplyMetricInput): ReplyMetricStatus {
  if (r.impressions != null) return 'has_metrics';
  if (!r.releaseURL) return 'no_release_url';
  if (r.platform === 'x') {
    if (!r.integrationId) return 'no_integration';
    if (!r.releaseId) return 'no_release_id';
  }
  return 'syncable';
}
