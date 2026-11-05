import { describe, expect, it, vi } from 'vitest';
import { parseRegressionOptions, summarizeRegressionAttempt, diagnosePublishRegression } from './diagnose-publish-regression';

describe('read-only publish regression diagnosis', () => {
  it('requires explicit organization scope and bounded reads', () => {
    expect(() => parseRegressionOptions([])).toThrow();
    expect(() => parseRegressionOptions(['--organization', 'org', '--limit', '501'])).toThrow();
    expect(parseRegressionOptions(['--organization', 'org', '--since', '2026-11-03T00:00:00Z'])).toMatchObject({ organization: 'org', limit: 200 });
  });
  it.each([
    ['SUBMITTING', 'CONTROLLED_COMPOSER_NOT_READY'],
    ['AUTHORIZED', 'SEND_ACTOR_CHANGED'],
  ])('retains the actual %s failure stage without printing credentials or content', (phase, code) => {
    const result = summarizeRegressionAttempt({ id: 'a', status: 'RECONCILING', payload: [{ id: 'post', content: 'private content', contentHash: 'same' }],
      intent: { activeExecutionId: 'a' }, segments: [{ postId: 'post', contentHash: 'same', status: 'UNKNOWN', result: {
        status: 'unknown', evidence: `Phase: ${phase}; code: ${code}. token=secret`,
      } }], outcomeEvents: [] });
    expect(result.segments[0].evidence).toMatchObject({ phase, code });
    expect(result.segments[0].payloadHashMatches).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/private content|secret|"payload":/);
  });
  it('does not treat a permit as proof of native dispatch', () => {
    const result = summarizeRegressionAttempt({ id: 'a', segments: [{ status: 'UNKNOWN', authorizedAt: 'time', result: { status: 'unknown' } }], outcomeEvents: [] });
    expect(result.segments[0].nativeClickProven).toBe(false);
  });
  it('distinguishes a worker restart from a platform rejection', () => {
    const result = summarizeRegressionAttempt({ id: 'a', segments: [{ status: 'UNKNOWN', result: { evidence: 'Worker restarted; no platform submission will be replayed.' } }], outcomeEvents: [] });
    expect(result.segments[0].evidence.workerRestarted).toBe(true);
  });
  it('scans all execution statuses instead of silently excluding authorized failures', async () => {
    const db = { sendExecution: { findMany: vi.fn(async () => []) }, extensionNode: { findMany: vi.fn(async () => []) } };
    const options = parseRegressionOptions(['--organization', 'org']);
    await diagnosePublishRegression(db as any, options);
    const query = db.sendExecution.findMany.mock.calls[0] as unknown[];
    expect(query[0]).toMatchObject({ take: 201, where: { organizationId: 'org', kind: 'EXTENSION', action: 'POST' } });
    expect((query[0] as any).where.segments).toBeUndefined();
    expect(JSON.stringify(query[0])).not.toMatch(/credentialHash|leaseTokenHash|permitHash":true/);
  });
});
