import { describe, it, expect } from 'vitest';
import { classifyReplyMetric } from '@gitroom/nestjs-libraries/engage/engage-metrics-stats';

const base = { releaseURL: 'https://x.com/u/status/1', releaseId: '1', integrationId: 'i1' };

describe('classifyReplyMetric', () => {
  it('has_metrics whenever impressions are populated, regardless of platform', () => {
    expect(classifyReplyMetric({ ...base, platform: 'x', impressions: 5 })).toBe('has_metrics');
    expect(classifyReplyMetric({ platform: 'reddit', impressions: 0, releaseURL: null, releaseId: null, integrationId: null })).toBe('has_metrics'); // 0 is a real value
  });

  it('no_release_url takes priority — nothing to fetch without a link', () => {
    expect(classifyReplyMetric({ platform: 'x', impressions: null, releaseURL: null, releaseId: '1', integrationId: 'i1' })).toBe('no_release_url');
    expect(classifyReplyMetric({ platform: 'reddit', impressions: null, releaseURL: '', releaseId: null, integrationId: null })).toBe('no_release_url');
  });

  it('X without an integration → no_integration', () => {
    expect(classifyReplyMetric({ ...base, platform: 'x', impressions: null, integrationId: null })).toBe('no_integration');
  });

  it('X with integration but no parsed tweet id → no_release_id', () => {
    expect(classifyReplyMetric({ ...base, platform: 'x', impressions: null, releaseId: null })).toBe('no_release_id');
  });

  it('all prerequisites present but still null → syncable', () => {
    expect(classifyReplyMetric({ ...base, platform: 'x', impressions: null })).toBe('syncable');
  });

  it('Reddit needs only a releaseURL (no integration/releaseId checks)', () => {
    expect(classifyReplyMetric({ platform: 'reddit', impressions: null, releaseURL: 'https://reddit.com/r/x/comments/a/b/c', releaseId: null, integrationId: null })).toBe('syncable');
  });
});
