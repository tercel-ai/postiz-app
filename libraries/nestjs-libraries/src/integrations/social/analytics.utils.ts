import { AnalyticsData } from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import { computeTrafficScore } from '@gitroom/nestjs-libraries/integrations/social/traffic.calculator';

/**
 * Per-platform mapping: which API label(s) represent total impressions/exposure.
 * All labels are matched case-insensitively.
 */
const IMPRESSIONS_LABELS: Record<string, Set<string>> = {
  x:                      new Set(['impressions']),
  youtube:                new Set(['views']),
  threads:                new Set(['views']),
  pinterest:              new Set(['impressions']),
  instagram:              new Set(['impressions']),
  'instagram-standalone': new Set(['impressions']),
  facebook:               new Set(['impressions']),
  linkedin:               new Set(['impressions']),
  'linkedin-page':        new Set(['impressions']),
};

const IMPRESSIONS_FALLBACK = new Set(['impressions', 'views']);

export function isImpressionsLabel(platform: string, label: string): boolean {
  const platformLabels = IMPRESSIONS_LABELS[platform.toLowerCase()];
  if (platformLabels) {
    return platformLabels.has(label.toLowerCase());
  }
  return IMPRESSIONS_FALLBACK.has(label.toLowerCase());
}

export function stripSyntheticMetrics(metrics: AnalyticsData[]): AnalyticsData[] {
  return metrics.filter((m) => m.label !== 'Traffic');
}

export function extractMetrics(
  platform: string,
  metrics: AnalyticsData[]
): { impressions: number; trafficScore: number | null; rawMetrics: AnalyticsData[] } {
  const rawMetrics = stripSyntheticMetrics(metrics);
  let impressions = 0;
  for (const metric of rawMetrics) {
    if (isImpressionsLabel(platform, metric.label)) {
      for (const point of metric.data) {
        impressions += Number(point.total || 0);
      }
    }
  }
  const trafficScore = computeTrafficScore(platform, rawMetrics);
  return { impressions, trafficScore, rawMetrics };
}
