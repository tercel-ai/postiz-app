import { hashSecret } from '../extension-node.protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupSend, sendNow as now } from './support/send-fixture';
import { SendExecutionService } from '../send-execution.service';
import { confirmSendPreflight } from '../send-preflight';
import { sendHash } from '../send-coordination.utils';

const auth = { org: 'org', user: 'user', nodeId: 'node', token: 'node-token' };
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'true');
  vi.stubEnv(
    'SEND_EXECUTION_CREDENTIAL_KEY',
    'test-key-with-more-than-32-characters-for-send'
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
function fixture() {
  const setup = setupSend();
  const { db, service } = setup;
  db.seed('extensionNode', {
    id: 'node',
    nodeId: 'node',
    organizationId: 'org',
    credentialVersion: 1,
    status: 'ACTIVE',
    capabilities: {
      x: { post: true, reply: true, strictAccountVerification: true },
    },
  });
  db.seed('extensionNodeSession', {
    extensionNodeId: 'node',
    organizationId: 'org',
    platform: 'x',
    integrationId: 'account',
    verificationStatus: 'VERIFIED',
    verificationExpiresAt: new Date(now.getTime() + 300_000),
    sessionRevision: 1,
    probeId: 'old',
    accountIdentity: { id: '123', namespace: 'x.rest_id' },
  });
  const nodes = {
    authenticateIn: vi
      .fn()
      .mockImplementation(async (_tx, org, user, id, token, historical = false) => {
        if (
          org !== 'org' ||
          user !== 'user' ||
          id !== 'node' ||
          token !== 'node-token' ||
          (!historical && db.rows('extensionNode')[0].status !== 'ACTIVE')
        )
          throw new Error('NODE_AUTHENTICATION_REQUIRED');
        return db.rows('extensionNode')[0];
      }),
  };
  const executions = new SendExecutionService(db as any, nodes as any, service);
  const claim = async () => {
    await setup.create('root', 'EXTENSION');
    return (
      await executions.claim(auth, { requestId: 'request', action: 'POST' })
    ).items[0];
  };
  const proof = async (item: any) => {
    const challenge = await executions.preflight(
      auth,
      item.executionId,
      0,
      item.leaseToken
    );
    const observation = {
      platform: 'x',
      id: '123',
      identityNamespace: 'x.rest_id',
      loggedIn: true,
      verificationStatus: 'VERIFIED',
      evidenceKind: 'LIVE_COOKIE_ID',
      probeId: 'fresh',
      identityObservedAt: now.toISOString(),
      preflightChallenge: challenge.challenge,
    };
    const session = db.rows('extensionNodeSession')[0];
    session.probeId = 'fresh';
    await db.$transaction((tx: any) =>
      confirmSendPreflight(
        tx,
        db.rows('extensionNode')[0],
        observation,
        session,
        'old',
        now
      )
    );
  };
  return { ...setup, executions, claim, proof };
}
describe('authenticated extension send execution', () => {
  it('replays the same claim lease without claiming another content unit', async () => {
    const { claim, executions, create, db } = fixture();
    const item = await claim();
    await create('second', 'EXTENSION');
    const replay = await executions.claim(auth, {
      requestId: 'request',
      action: 'POST',
    });
    expect(replay.items[0].leaseToken).toBe(item.leaseToken);
    expect(db.rows('sendExecution')).toHaveLength(1);
    await expect(
      executions.claim(auth, { requestId: 'request', action: 'REPLY' })
    ).rejects.toThrow('CLAIM_REQUEST_CONFLICT');
  });
  it('persists an empty claim receipt and does not claim later work with that request ID', async () => {
    const { executions, create, db } = fixture();
    expect(
      (await executions.claim(auth, { requestId: 'empty', action: 'POST' }))
        .items
    ).toEqual([]);
    await create('later', 'EXTENSION');
    expect(
      (await executions.claim(auth, { requestId: 'empty', action: 'POST' }))
        .items
    ).toEqual([]);
    expect(db.rows('sendExecution')).toHaveLength(0);
  });
  it('requires a new challenge-bound actor probe and never replays a submission permit', async () => {
    const { claim, executions, proof, db } = fixture();
    const item = await claim();
    await expect(
      executions.start(auth, item.executionId, 0, item.leaseToken)
    ).rejects.toThrow('FRESH_SEND_PREFLIGHT_REQUIRED');
    await proof(item);
    const first = await executions.start(
      auth,
      item.executionId,
      0,
      item.leaseToken
    );
    expect(first.granted).toBe(true);
    const duplicate = await executions.start(
      auth,
      item.executionId,
      0,
      item.leaseToken
    );
    expect(duplicate).toEqual({ granted: false, status: 'AUTHORIZED' });
    expect(duplicate).not.toHaveProperty('permit');
    await executions.outcome(auth, item.executionId, 0, item.leaseToken, {
      status: 'unknown',
      eventId: 'lost',
    });
    expect(db.rows('sendQuotaReservation')[0].state).toBe('HELD');
    const retry = await executions.claim(auth, {
      requestId: 'request',
      action: 'POST',
    });
    expect(retry.items).toEqual([]);
    expect(
      await executions.status(auth, item.executionId, item.leaseToken)
    ).not.toHaveProperty('leaseToken');
  });
  it('rejects stale sessions, revoked nodes, and wrong lease credentials', async () => {
    const { claim, executions, proof, db } = fixture();
    const item = await claim();
    await expect(
      executions.preflight(auth, item.executionId, 0, 'wrong')
    ).rejects.toThrow('SEND_LEASE_AUTHENTICATION_FAILED');
    await proof(item);
    db.rows('extensionNodeSession')[0].sessionRevision++;
    await expect(
      executions.start(auth, item.executionId, 0, item.leaseToken)
    ).rejects.toThrow('FRESH_SEND_PREFLIGHT_REQUIRED');
    db.rows('extensionNode')[0].status = 'REVOKED';
    await expect(
      executions.start(auth, item.executionId, 0, item.leaseToken)
    ).rejects.toThrow('NODE_AUTHENTICATION_REQUIRED');
    expect(db.rows('sendQuotaReservation')).toHaveLength(0);
  });
  it('requires structured stopped-executor evidence after the permit deadline', async () => {
    const { claim, executions, proof, db } = fixture();
    const item = await claim();
    await proof(item);
    const grant = await executions.start(
      auth,
      item.executionId,
      0,
      item.leaseToken
    );
    await expect(
      executions.outcome(auth, item.executionId, 0, item.leaseToken, {
        eventId: 'unsafe',
        status: 'definitely_not_submitted',
        stopped: true,
        evidence: 'ordinary error',
      })
    ).rejects.toThrow('STRUCTURED_STOP_CONFIRMATION_REQUIRED');
    const stop = {
      eventId: 'stop',
      journalDigest: sendHash('durable local journal'),
      permitHash: hashSecret((grant as any).permit),
      lastPhase: 'PREPARED',
      noPendingSubmit: true as const,
      executorStoppedAt: now.toISOString(),
    };
    await expect(
      executions.stop(auth, item.executionId, 0, item.leaseToken, stop)
    ).rejects.toThrow('STOP_CONFIRMATION_REQUIRED');
    vi.setSystemTime(new Date(now.getTime() + 31_000));
    await executions.stop(auth, item.executionId, 0, item.leaseToken, stop);
    expect(db.rows('sendQuotaReservation')[0].state).toBe('RELEASED');
  });
  it('settles confirmed plugin outcomes once even after the claim lease expires', async () => {
    const { claim, executions, proof, db } = fixture();
    const item = await claim();
    await proof(item);
    await executions.start(auth, item.executionId, 0, item.leaseToken);
    vi.setSystemTime(new Date(now.getTime() + 300_000));
    const success = {
      eventId: 'success',
      status: 'confirmed' as const,
      platformId: 'tweet',
    };
    await executions.outcome(
      auth,
      item.executionId,
      0,
      item.leaseToken,
      success
    );
    await executions.outcome(
      auth,
      item.executionId,
      0,
      item.leaseToken,
      success
    );
    expect(db.rows('sendQuotaBucket')[0]).toMatchObject({
      heldUnits: 0,
      confirmedUnits: 1,
    });
  });
});

describe('preparation leases and immutable browser payloads', () => {
  it('renews only an unexpired reservation and keeps the original lease credential', async () => {
    const { claim, executions } = fixture();
    const item = await claim();
    vi.setSystemTime(new Date(now.getTime() + 60_000));
    const renewed = await executions.renew(auth, item.executionId, item.leaseToken);
    expect(renewed.leaseExpiresAt).toBe(new Date(now.getTime() + 180_000).toISOString());
    expect(await executions.status(auth, item.executionId, item.leaseToken)).toMatchObject({ status: 'RESERVED' });
    vi.setSystemTime(new Date(now.getTime() + 181_000));
    await expect(executions.renew(auth, item.executionId, item.leaseToken)).rejects.toThrow('SEND_LEASE_NOT_RENEWABLE');
  });
  it('never renews a short submit permit or a sending execution', async () => {
    const { claim, executions, proof, db } = fixture(); const item = await claim(); await proof(item);
    await executions.start(auth, item.executionId, 0, item.leaseToken);
    const deadline = db.rows('sendSegment')[0].submitBefore;
    await expect(executions.renew(auth, item.executionId, item.leaseToken)).rejects.toThrow('SEND_LEASE_NOT_RENEWABLE');
    expect(db.rows('sendSegment')[0].submitBefore).toEqual(deadline);
  });
  it('renders frozen HTML content and organization-scoped media before issuing a browser lease', async () => {
    const { claim, executions, db } = fixture(); const item = await claim();
    expect(item.segments[0]).toMatchObject({ text: 'hello', mediaUrls: [] });
    expect(await executions.status(auth, item.executionId, item.leaseToken)).toHaveProperty('serverNow');
    expect(db.rows('sendQuotaReservation')).toHaveLength(0);
  });
});

describe('review regressions: stopped and revoked executors', () => {
 it('accepts the same unstarted stop receipt after the first response was lost', async () => {
  const { claim, executions, db } = fixture(); const item = await claim();
  const stop = { eventId: 'stop-before-start', journalDigest: sendHash('journal'), permitHash: '', lastPhase: 'PREPARED', noPendingSubmit: true as const, executorStoppedAt: now.toISOString() };
  await executions.stop(auth, item.executionId, 0, item.leaseToken, stop);
  await expect(executions.stop(auth, item.executionId, 0, item.leaseToken, stop)).resolves.toBeDefined();
  expect(db.rows('sendOutcomeEvent')).toHaveLength(1);
  await expect(executions.stop(auth, item.executionId, 0, item.leaseToken, { ...stop, journalDigest: sendHash('changed') })).rejects.toThrow('SEND_OUTCOME_EVENT_CONFLICT');
 });
});


it('allows a revoked original terminal to read status and stop but never start new work', async () => {
 const { claim, executions, db } = fixture(); const item = await claim(); db.rows('extensionNode')[0].status = 'REVOKED';
 await expect(executions.status(auth, item.executionId, item.leaseToken)).resolves.toMatchObject({ status: 'RESERVED' });
 await expect(executions.start(auth, item.executionId, 0, item.leaseToken)).rejects.toThrow('NODE_AUTHENTICATION_REQUIRED');
 await expect(executions.stop(auth, item.executionId, 0, item.leaseToken, { eventId: 'revoked-stop', journalDigest: sendHash('stopped original'), permitHash: '', lastPhase: 'PREPARED', noPendingSubmit: true, executorStoppedAt: now.toISOString() })).resolves.toBeDefined();
});

describe('durable X draft exposure before a submit permit', () => {
  it('fences an offline exposed draft, while allowing its live owner to obtain a permit', async () => {
    const { claim, executions, proof, db } = fixture();
    const item = await claim();
    await expect((executions as any).draftExposure(auth, item.executionId, 0, item.leaseToken)).resolves.toMatchObject({ exposed: true });
    expect(db.rows('sendSegment')[0]).toMatchObject({ status: 'PENDING', result: { status: 'draft_exposed' } });
    expect(db.rows('sendExecution')[0].status).toBe('SENDING');
    expect(db.rows('sendQuotaReservation')).toHaveLength(0);
    await proof(item);
    expect((await executions.start(auth, item.executionId, 0, item.leaseToken)).granted).toBe(true);
  });
  it('does not automatically reclaim an exposed draft after the browser goes offline', async () => {
    const { claim, executions, service, db } = fixture(); const item = await claim();
    await (executions as any).draftExposure(auth, item.executionId, 0, item.leaseToken);
    vi.setSystemTime(new Date(now.getTime() + 180000));
    await expect(service.reserveApi('org', 'root', 'other', new Date())).rejects.toThrow();
    await expect(executions.preflight(auth,item.executionId,0,item.leaseToken)).rejects.toThrow('SEND_LEASE_EXPIRED');
    expect(db.rows('sendIntent')[0].activeExecutionId).toBe(item.executionId);
    expect(db.rows('sendQuotaReservation')).toHaveLength(0);
  });
  it('records pre-permit uncertainty and requires attended absence review before retry', async () => {
    const { claim, executions, service, db } = fixture(); const item = await claim();
    await (executions as any).draftExposure(auth,item.executionId,0,item.leaseToken);
    await executions.outcome(auth,item.executionId,0,item.leaseToken,{status:'unknown',eventId:'exposed-error'});
    expect(db.rows('sendSegment')[0].status).toBe('UNKNOWN');
    vi.setSystemTime(new Date(now.getTime()+180000));
    db.rows('extensionNode')[0].registeredByUserId='user';
    await service.reviewPostNotSent('org','user',item.executionId,'root',{eventId:'review',expectedResolutionRevision:0,reviewedNotSent:true,draftsClosed:true});
    expect(db.rows('sendSegment')[0].status).toBe('NOT_SUBMITTED');
    expect(db.rows('sendQuotaReservation')).toHaveLength(0);
  });
  it('allows attended absence review after an exposed browser crashes without reporting an outcome', async () => {
    const { claim, executions, service, db } = fixture(); const item = await claim();
    await (executions as any).draftExposure(auth,item.executionId,0,item.leaseToken);
    db.rows('extensionNode')[0].registeredByUserId='user';
    await expect(service.postReview('org','user',item.executionId,'root')).rejects.toThrow();
    vi.setSystemTime(new Date(now.getTime()+180000));
    expect(await service.postReview('org','user',item.executionId,'root')).toMatchObject({canReviewNotSent:true});
    await service.reviewPostNotSent('org','user',item.executionId,'root',{eventId:'closed',expectedResolutionRevision:0,reviewedNotSent:true,draftsClosed:true});
    expect(db.rows('sendExecution')[0].status).toBe('FAILED_FINAL');
  });
  it.each(['lease','token','tenant','writer'])('fails closed for a wrong %s before exposing a draft', async reason => {
    const { claim, executions, db }=fixture(); const item=await claim();
    if(reason==='writer')db.rows('accountWriteState')[0].activeExecutionId='other';
    await expect((executions as any).draftExposure({...auth,...(reason==='token'?{token:'wrong'}:{}),...(reason==='tenant'?{org:'other'}:{})},item.executionId,0,reason==='lease'?'wrong':item.leaseToken)).rejects.toThrow();
    expect(db.rows('sendExecution')[0].status).toBe('RESERVED');
  });
});

it('requires attended review instead of a no-permit stop proof after draft exposure', async () => {
 const { claim, executions }=fixture(); const item=await claim();
 await executions.draftExposure(auth,item.executionId,0,item.leaseToken);
 await expect(executions.stop(auth,item.executionId,0,item.leaseToken,{eventId:'unsafe-stop',journalDigest:sendHash('stopped'),permitHash:'',lastPhase:'PREPARED',noPendingSubmit:true,executorStoppedAt:now.toISOString()})).rejects.toThrow('EXPOSED_DRAFT_REQUIRES_REVIEW');
});
it('exposes replies and later thread segments only after prior confirmation and account spacing', async () => {
 const { claim, executions, db }=fixture(); const item=await claim();
 db.rows('sendExecution')[0].action='REPLY'; db.rows('sendIntent')[0].action='REPLY';
 await executions.draftExposure(auth,item.executionId,0,item.leaseToken);
 const segment=db.rows('sendSegment')[0];
 db.seed('sendSegment',{...segment,id:'later',segmentIndex:1,postId:'child',result:null});
 await expect(executions.draftExposure(auth,item.executionId,1,item.leaseToken)).rejects.toThrow('PREVIOUS_SEGMENT_NOT_CONFIRMED');
 db.rows('sendSegment')[0].status='CONFIRMED'; db.rows('sendSegment')[0].result={status:'confirmed',platformId:'first'};
 db.rows('accountWriteState')[0].nextWriteNotBefore=new Date(now.getTime()+1000);
 await expect(executions.draftExposure(auth,item.executionId,1,item.leaseToken)).rejects.toThrow('ACCOUNT_SEND_INTERVAL_REQUIRED');
 vi.setSystemTime(new Date(now.getTime()+1000));
 await expect(executions.draftExposure(auth,item.executionId,1,item.leaseToken)).resolves.toMatchObject({exposed:true});
});
it('quarantines a later writer when an old no-permit draft reports uncertainty', async () => {
 const { claim, executions, db }=fixture(); const item=await claim();
 db.seed('sendExecution',{...db.rows('sendExecution')[0],id:'newer',fencingVersion:2,status:'RESERVED'});
 db.rows('sendIntent')[0].activeExecutionId='newer'; db.rows('sendIntent')[0].fencingVersion=2;
 await expect(executions.outcome(auth,item.executionId,0,item.leaseToken,{status:'unknown',eventId:'late-exposure'})).rejects.toThrow('SEND_OUTCOME_CONFLICT_REQUIRES_RECONCILIATION');
 expect(db.rows('sendSegment')[0].status).toBe('UNKNOWN');
 expect(db.rows('sendExecution').every(e=>e.status==='RECONCILING')).toBe(true);
 expect(db.rows('accountWriteState')[0].rolloutReady).toBe(false);
 expect(db.rows('sendQuotaReservation')).toHaveLength(0);
});


describe('retained X thread preparation lease', () => {
 it('renews an expired retained writer between confirmed segments before exposing the next draft', async () => {
  const { claim, executions, db }=fixture(); const item=await claim();
  await executions.draftExposure(auth,item.executionId,0,item.leaseToken);
  const first=db.rows('sendSegment')[0];
  db.seed('sendSegment',{...first,id:'next',segmentIndex:1,postId:'child',result:null});
  first.status='CONFIRMED'; first.result={status:'confirmed',platformId:'first'};
  vi.setSystemTime(new Date(now.getTime()+180000));
  await expect(executions.draftExposure(auth,item.executionId,1,item.leaseToken)).rejects.toThrow('SEND_DRAFT_EXPOSURE_UNSAFE');
  await expect(executions.renew(auth,item.executionId,item.leaseToken)).resolves.toMatchObject({leaseExpiresAt:new Date(now.getTime()+300000).toISOString()});
  await expect(executions.draftExposure(auth,item.executionId,1,item.leaseToken)).resolves.toMatchObject({exposed:true});
 });
 it('never renews an expired exposed draft or extends the thirty-minute preparation deadline', async () => {
  const { claim, executions, db }=fixture(); const item=await claim();
  await executions.draftExposure(auth,item.executionId,0,item.leaseToken);
  vi.setSystemTime(new Date(now.getTime()+180000));
  await expect(executions.renew(auth,item.executionId,item.leaseToken)).rejects.toThrow('SEND_LEASE_NOT_RENEWABLE');
  const first=db.rows('sendSegment')[0];
  db.seed('sendSegment',{...first,id:'next',segmentIndex:1,postId:'child',result:null});
  first.status='CONFIRMED'; first.result={status:'confirmed',platformId:'first'};
  vi.setSystemTime(new Date(now.getTime()+1800001));
  await expect(executions.renew(auth,item.executionId,item.leaseToken)).rejects.toThrow('SEND_PREPARATION_DEADLINE');
 });
 it('refuses renewal when a preceding segment is still uncertain', async () => {
  const { claim, executions, db }=fixture(); const item=await claim();
  await executions.draftExposure(auth,item.executionId,0,item.leaseToken);
  const first=db.rows('sendSegment')[0];
  db.seed('sendSegment',{...first,id:'next',segmentIndex:1,postId:'child',result:null});
  first.status='UNKNOWN'; first.result={status:'unknown'};
  vi.setSystemTime(new Date(now.getTime()+180000));
  await expect(executions.renew(auth,item.executionId,item.leaseToken)).rejects.toThrow('SEND_LEASE_NOT_RENEWABLE');
 });
});
