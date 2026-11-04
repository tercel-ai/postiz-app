import { describe, expect, it, vi } from 'vitest';
import { assertDiagnosisDatabase, diagnoseSendAttempts, parseOptions, summarizeSendEvidence } from './diagnose-send-attempts';

describe('send attempt diagnosis', () => {
  it('requires the expected database without exposing the connection URL', () => {
    expect(() => assertDiagnosisDatabase('postgresql://user:secret@host/aisee_dev')).toThrow('requires database aisee_postiz_dev');
    expect(() => assertDiagnosisDatabase(undefined)).toThrow('DATABASE_URL is required');
    expect(() => assertDiagnosisDatabase('postgresql://user:secret@host/aisee_postiz_dev?schema=public')).not.toThrow();
  });
  it('bounds output and validates flags', () => {
    expect(parseOptions([])).toMatchObject({ limit: 100 });
    for (const value of ['0', '1001', 'NaN', '2.5']) expect(() => parseOptions(['--limit', value])).toThrow();
    expect(() => parseOptions(['--repair'])).toThrow();
  });
  it('uses bounded ORM reads and exposes deletion state without tokens or payloads', async () => {
    const row = { id: 'attempt', organizationId: 'org', integrationId: 'integration', intent: { rootPostId: 'post' } };
    const db = { sendExecution: { findMany: vi.fn(async () => [row]) },
      integration: { findMany: vi.fn(async () => [{ id: 'integration', deletedAt: 'deleted' }]) },
      post: { findMany: vi.fn(async () => [{ id: 'post', deletedAt: 'deleted' }]) } };
    const result = await diagnoseSendAttempts(db as any, { organization: 'org', limit: 1 });
    expect(db.sendExecution.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 1,
      where: expect.objectContaining({ kind: 'EXTENSION', organizationId: 'org', segments: { some: {
        status: 'PENDING', permitHash: null, authorizedAt: null, submitBefore: null,
      } } }) }));
    expect(result).toMatchObject({ nextCursor: 'attempt', attempts: [{ account: { deletedAt: 'deleted' }, root: { deletedAt: 'deleted' } }] });
    const selection = db.sendExecution.findMany.mock.calls[0] as unknown[];
    expect(JSON.stringify(selection)).not.toMatch(/leaseTokenHash|payload|permitHash":true/);
  });
  it('can inspect one attempt regardless of status and paginate organization scans', async () => {
    const db = { sendExecution: { findMany: vi.fn(async () => []) }, integration: { findMany: vi.fn(async () => []) }, post: { findMany: vi.fn(async () => []) } };
    await diagnoseSendAttempts(db as any, { attempt: 'attempt', organization: 'org', cursor: 'previous', limit: 10 });
    expect(db.sendExecution.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { kind: 'EXTENSION', id: 'attempt', organizationId: 'org' }, cursor: { id: 'previous' }, skip: 1,
    }));
  });
});


describe('detailed publish diagnosis', () => {
  it('accepts a read-only details switch in any argument position', () => {
    expect(parseOptions(['--details', '--attempt', 'attempt', '--limit', '5'])).toMatchObject({ details: true, attempt: 'attempt', limit: 5 });
    expect(parseOptions(['--attempt', 'attempt', '--details'])).toMatchObject({ details: true, attempt: 'attempt' });
  });
  it('extracts failure stage and code without exposing arbitrary evidence or credentials', () => {
    const evidence = { status: 'unknown', evidence: 'The platform submission could not be conclusively matched. Phase: SUBMITTING; code: CONTROLLED_COMPOSER_NOT_READY. secret=do-not-print', token: 'do-not-print' };
    expect(summarizeSendEvidence(evidence)).toEqual({ status: 'unknown', phase: 'SUBMITTING', code: 'CONTROLLED_COMPOSER_NOT_READY', workerRestarted: false });
    expect(JSON.stringify(summarizeSendEvidence(evidence))).not.toContain('do-not-print');
    expect(summarizeSendEvidence({ status: 'unknown', evidence: 'Worker restarted; no platform submission will be replayed.' })).toMatchObject({ workerRestarted: true });
    expect(summarizeSendEvidence(null)).toEqual({});
  });
  it('reads original outcome events and node metadata only when details are requested', async () => {
    const row = { id: 'attempt', organizationId: 'org', extensionNodeId: 'node', integrationId: 'integration', intent: { rootPostId: 'post' }, segments: [{ segmentIndex: 0, result: { status: 'unknown', evidence: 'Phase: SUBMITTING; code: PAGE_ACTOR_MISMATCH. secret=do-not-print' } }] };
    const db = {
      sendExecution: { findMany: vi.fn(async () => [row]) },
      integration: { findMany: vi.fn(async () => []) }, post: { findMany: vi.fn(async () => []) },
      sendOutcomeEvent: { findMany: vi.fn(async () => [{ executionId: 'attempt', segmentIndex: 0, eventId: 'unknown:one', createdAt: 'time', evidence: { status: 'unknown', evidence: 'Phase: SUBMITTING; code: PAGE_ACTOR_MISMATCH.' } }]) },
      extensionNode: { findMany: vi.fn(async () => [{ id: 'node', status: 'ACTIVE' }]) },
    };
    const result = await diagnoseSendAttempts(db as any, { attempt: 'attempt', details: true, limit: 1 });
    expect(JSON.stringify(result)).not.toContain('do-not-print');
    expect(result.attempts[0]).toMatchObject({ diagnostics: { node: { id: 'node' }, events: [{ phase: 'SUBMITTING', code: 'PAGE_ACTOR_MISMATCH' }] } });
    expect(db.sendOutcomeEvent.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { executionId: { in: ['attempt'] } }, take: 1001 }));
    expect(JSON.stringify(db.extensionNode.findMany.mock.calls)).not.toMatch(/credentialHash|credentialSalt/);
    await diagnoseSendAttempts(db as any, { attempt: 'attempt', limit: 1 });
    expect(db.sendOutcomeEvent.findMany).toHaveBeenCalledTimes(1);
  });
});
