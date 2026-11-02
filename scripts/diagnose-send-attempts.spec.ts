import { describe, expect, it, vi } from 'vitest';
import { assertDiagnosisDatabase, diagnoseSendAttempts, parseOptions } from './diagnose-send-attempts';

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
