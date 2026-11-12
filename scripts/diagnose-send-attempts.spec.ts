import { describe, expect, it, vi } from 'vitest';
import { assertDiagnosisDatabase, diagnoseSendAttempts, parseOptions, summarizeSendEvidence } from './diagnose-send-attempts';

describe('send attempt diagnosis', () => {
  it('accepts a production database from DATABASE_URL', () => {
    expect(() => assertDiagnosisDatabase('postgresql://user:secret@host/aisee_postiz')).not.toThrow();
  });

  it('requires a PostgreSQL database name without exposing the connection URL', () => {
    expect(() => assertDiagnosisDatabase('postgresql://user:secret@host/')).toThrow('DATABASE_URL');
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


describe('platform and action diagnostic filters', () => {
  it.each(['x','reddit','linkedin','medium','quora','hackernews','devto','all'])('accepts the canonical %s platform', platform => {
    expect(parseOptions(['--platform',platform,'--action','POST'])).toMatchObject({platform,action:'POST'});
  });
  it.each(['POST','REPLY','all'])('accepts the %s action selector', action => {
    expect(parseOptions(['--action',action])).toMatchObject({action});
  });
  it.each([['--platform','linkedin-page'],['--platform','LinkedIn'],['--platform','unknown'],['--action','post'],['--action','DELETE'],['--platform'],['--action']])('rejects invalid selector arguments %j', (...args) => {
    expect(()=>parseOptions(args)).toThrow();
  });
  it('rejects a POST selector for a reply scope before reading any records', () => {
    expect(()=>parseOptions(['--reply','reply-id','--action','POST'])).toThrow('Reply scope requires REPLY or all');
    expect(parseOptions(['--reply','reply-id','--action','all'])).toMatchObject({reply:'reply-id',action:'all'});
  });
  const fixture = () => ({
    extensionNode:{findMany:vi.fn(async()=>[{id:'owned-node'}])},
    sendExecution:{findMany:vi.fn(async()=>[])},
    integration:{findMany:vi.fn(async()=>[])},post:{findMany:vi.fn(async()=>[])},
  });
  it('preserves the existing user-only Dev.to REPLY selection', async () => {
    const db=fixture(); await diagnoseSendAttempts(db as any,parseOptions(['--user','user','--organization','org']));
    expect(db.sendExecution.findMany).toHaveBeenCalledWith(expect.objectContaining({where:{kind:'EXTENSION',organizationId:'org',platform:'devto',action:'REPLY',OR:[
      {extensionNodeId:{in:['owned-node']}},{intent:{policySnapshot:{path:['policyOwnerUserId'],equals:'user'}}},
    ]}}));
  });
  it('selects LinkedIn POST attempts using the same owner scope, organization and cursor', async () => {
    const db=fixture();
    await diagnoseSendAttempts(db as any,parseOptions(['--user','user','--organization','org','--platform','linkedin','--action','POST','--cursor','previous','--limit','20','--details']));
    expect(db.extensionNode.findMany).toHaveBeenCalledWith({where:{registeredByUserId:'user',organizationId:'org'},select:{id:true}});
    expect(db.sendExecution.findMany).toHaveBeenCalledWith(expect.objectContaining({where:{kind:'EXTENSION',organizationId:'org',platform:'linkedin',action:'POST',OR:[
      {extensionNodeId:{in:['owned-node']}},{intent:{policySnapshot:{path:['policyOwnerUserId'],equals:'user'}}},
    ]},cursor:{id:'previous'},skip:1,take:20}));
  });
  it('removes both legacy filters only when all platforms and actions are explicit', async () => {
    const db=fixture(); await diagnoseSendAttempts(db as any,parseOptions(['--user','user','--platform','all','--action','all','--organization','org']));
    const args=db.sendExecution.findMany.mock.calls[0] as unknown as [{where:Record<string,unknown>}];
    expect(args[0].where).toEqual({kind:'EXTENSION',organizationId:'org',OR:[
      {extensionNodeId:{in:['owned-node']}},{intent:{policySnapshot:{path:['policyOwnerUserId'],equals:'user'}}},
    ]});
  });
  it('keeps attempt and reply bounds when all selectors are explicit', async () => {
    const db=fixture(); await diagnoseSendAttempts(db as any,parseOptions(['--attempt','attempt','--reply','reply','--organization','org','--platform','all','--action','all']));
    expect(db.sendExecution.findMany).toHaveBeenCalledWith(expect.objectContaining({where:{kind:'EXTENSION',id:'attempt',organizationId:'org',action:'REPLY',intent:{rootPost:{engageSentReply:{id:'reply'}}}}}));
  });
});
