import { ForbiddenException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupSend, sendNow } from './support/send-fixture';
import { sendBusinessSummary } from '../send-business-summary';

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(sendNow); vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'true'); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
const request = () => ({ requestId: 'retry-one', expectedResolutionRevision: 0 });
async function uncertainPost(segmentCount = 1) {
 const f=setupSend(); await f.create('root','EXTENSION');
 for(let index=1;index<segmentCount;index++) f.db.seed('post',{...f.db.rows('post')[0],id:`child-${index}`,
  parentPostId:index===1?'root':`child-${index-1}`,content:`thread segment ${index}`});
 const execution=await f.service.reserveApi('org','root','original',sendNow);
 await f.service.authorizeApiSegment('org',execution.id,0,{id:'123',idNamespace:'x.rest_id'},sendNow);
 await f.service.apiOutcome('org',execution.id,0,{eventId:'lost',status:'unknown',evidence:'Original network uncertainty'},sendNow);
 Object.assign(f.db.rows('sendExecution')[0],{kind:'EXTENSION',extensionNodeId:'node'});
 f.db.seed('extensionNode',{id:'node',organizationId:'org',registeredByUserId:'user'});
 vi.setSystemTime(new Date(sendNow.getTime()+180000));
 return {...f,execution};
}
const retry = (f: Awaited<ReturnType<typeof uncertainPost>>, body=request()) =>
 f.service.retryUnconfirmedPost('org','user',f.execution.id,'root',body);

describe('owner-requested retry of an uncertain original post',()=>{
 it('requeues the original intent while preserving unknown evidence and all held quota',async()=>{
  const f=await uncertainPost(); const evidence=structuredClone(f.db.rows('sendSegment')[0].result);
  expect(await f.service.postReview('org','user',f.execution.id,'root')).toMatchObject({canRetryUnconfirmed:true});
  expect(await retry(f)).toEqual({sendIntentId:f.execution.sendIntentId,status:'QUEUED'});
  expect(f.db.rows('sendExecution')[0]).toMatchObject({status:'RETRY_REQUESTED',resolutionRevision:1});
  expect(f.db.rows('sendIntent')[0]).toMatchObject({status:'QUEUED',activeExecutionId:null,fencingVersion:2});
  expect(f.db.rows('sendSegment')[0]).toMatchObject({status:'UNKNOWN',result:evidence});
  expect(f.db.rows('sendQuotaReservation')[0].state).toBe('HELD');
  expect(f.db.rows('sendQuotaBucket')[0]).toMatchObject({heldUnits:1,confirmedUnits:0});
  expect(f.db.rows('accountWriteState')[0].activeExecutionId).toBe(null);
  const summary=sendBusinessSummary(f.db.rows('post')[0],f.db.rows('sendIntent')[0],f.db.rows('sendExecution'),f.db.rows('sendSegment'),null,true);
  expect(summary.status).toBe('QUEUED'); expect(summary.execution).toBe(null);
 });
 it('replays a stable request after a newer claim without requeueing or revoking the newer owner',async()=>{
  const f=await uncertainPost(); const result=await retry(f);
  const newer=await f.service.reserveApi('org','root','newer',new Date());
  expect(await retry(f)).toEqual(result);
  expect(f.db.rows('sendIntent')[0]).toMatchObject({status:'RESERVED',activeExecutionId:newer.id});
  expect(f.db.rows('sendMutationReceipt').filter(r=>r.operation.startsWith('owner-send-retry:'))).toHaveLength(1);
  await expect(retry(f,{requestId:'retry-one',expectedResolutionRevision:1})).rejects.toThrow('SEND_RETRY_REQUEST_CONFLICT');
  await expect(retry(f,{requestId:'retry-two',expectedResolutionRevision:0})).rejects.toThrow();
 });
 it('lets later definitely-unsent failures retry without archived uncertainty blocking them',async()=>{
  const f=await uncertainPost(); await retry(f);
  const newer=await f.service.reserveApi('org','root','newer',new Date());
  await f.service.apiOutcome('org',newer.id,0,{eventId:'stopped',status:'definitely_not_submitted',stopped:true,evidence:'No composer opened'},new Date());
  await expect(f.service.retry('org','root','user')).resolves.toMatchObject({status:'QUEUED'});
  expect(f.db.rows('sendSegment')[0].status).toBe('UNKNOWN');
  expect(f.db.rows('sendQuotaBucket')[0].heldUnits).toBe(1);
 });
 it.each(['tenant','owner','member','project','revision','lease','permit','confirmed','partial','writer','rollout','mode','switch'])('rejects unsafe %s without releasing quota',async kind=>{
  const f=await uncertainPost();
  if(kind==='owner'){f.db.rows('sendIntent')[0].policySnapshot.policyOwnerUserId='other';f.db.rows('extensionNode')[0].registeredByUserId='other';}
  if(kind==='member')f.db.rows('userOrganization')[0].disabled=true;
  if(kind==='project')f.projects.assertProjectActive.mockRejectedValue(new Error('PROJECT_INACTIVE'));
  if(kind==='revision')f.db.rows('sendExecution')[0].resolutionRevision=1;
  if(kind==='lease')f.db.rows('sendExecution')[0].leaseExpiresAt=new Date(Date.now()+1000);
  if(kind==='permit')f.db.rows('sendSegment')[0].submitBefore=new Date(Date.now()+1000);
  if(kind==='confirmed')f.db.rows('sendSegment')[0].status='CONFIRMED';
  if(kind==='partial')f.db.rows('sendIntent')[0].hasConfirmedSegments=true;
  if(kind==='writer')f.db.rows('accountWriteState')[0].activeExecutionId='other';
  if(kind==='rollout')f.db.rows('accountWriteState')[0].rolloutReady=false;
  if(kind==='mode')f.db.rows('settings')[0].value={mode:'AUTONOMOUS',revision:2};
  if(kind==='switch')vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED','false');
  await expect(f.service.retryUnconfirmedPost(kind==='tenant'?'other':'org','user',f.execution.id,'root',request())).rejects.toThrow();
  expect(f.db.rows('sendQuotaReservation')[0].state).toBe('HELD');
  expect(f.db.rows('sendIntent')[0].activeExecutionId).toBe(f.execution.id);
 });
 it.each(['confirmed','unknown'] as const)('quarantines both the superseded attempt and newer writer on late %s evidence',async status=>{
  const f=await uncertainPost(); await retry(f);
  const newer=await f.service.reserveApi('org','root','newer',new Date());
  const event={eventId:'late',status,...(status==='confirmed'?{platformId:'old-post',url:'https://x.com/alice/status/old-post'}:{}),evidence:'Late original receipt'};
  const result=await f.db.$transaction((tx:any)=>f.service.outcomeIn(tx,f.db.rows('sendExecution').find(e=>e.id===f.execution.id),0,event,new Date()));
  expect(result.conflict).toBe(true);
  expect(f.db.rows('sendExecution').find(e=>e.id===newer.id).status).toBe('RECONCILING');
  expect(f.db.rows('accountWriteState')[0].rolloutReady).toBe(false);
  expect(f.db.rows('sendIntent')[0]).toMatchObject({status:'RECONCILING',activeExecutionId:newer.id});
  expect(f.db.rows('sendSegment')[0].result).toMatchObject({status,...(status==='confirmed'?{platformId:'old-post'}:{})});
  expect(f.db.rows('sendQuotaReservation')[0].state).toBe(status==='confirmed'?'COMMITTED':'HELD');
 });
 it('does not let a stale negative reconciliation reset the newer intent or release its owner',async()=>{
  const f=await uncertainPost();await retry(f);const newer=await f.service.reserveApi('org','root','newer',new Date());
  await expect(f.db.$transaction((tx:any)=>f.service.outcomeIn(tx,f.db.rows('sendExecution').find(e=>e.id===f.execution.id),0,{eventId:'late-negative',status:'definitely_not_submitted',stopped:true,evidence:'Old stop'},new Date()))).rejects.toThrow('SUPERSEDED_SEND_REQUIRES_RECONCILIATION');
  expect(f.db.rows('sendIntent')[0]).toMatchObject({activeExecutionId:newer.id,status:'RESERVED'});
  expect(f.db.rows('sendQuotaReservation')[0].state).toBe('HELD');
 });
});


it('supersedes an offline exposed draft without inventing an unknown or a negative outcome',async()=>{
 const f=await uncertainPost();
 f.db.rows('sendSegment')[0].status='PENDING';
 f.db.rows('sendSegment')[0].result={status:'draft_exposed'};
 f.db.rows('sendSegment')[0].authorizedAt=null;f.db.rows('sendSegment')[0].submitBefore=null;f.db.rows('sendSegment')[0].permitHash=null;
 f.db.rows('sendExecution')[0].status='SENDING';f.db.rows('sendIntent')[0].status='SENDING';
 f.db.rows('sendQuotaReservation').splice(0);f.db.rows('sendQuotaBucket').splice(0);
 await retry(f);
 expect(f.db.rows('sendSegment')[0]).toMatchObject({status:'PENDING',result:{status:'draft_exposed'}});
 const result=await f.db.$transaction((tx:any)=>f.service.outcomeIn(tx,f.db.rows('sendExecution')[0],0,{eventId:'manual-submit',status:'confirmed',platformId:'manually-posted'},new Date()));
 expect(result.conflict).toBe(true);
 expect(f.db.rows('sendSegment')[0]).toMatchObject({status:'CONFIRMED',result:{platformId:'manually-posted'}});
});
it.each(['mode','rollout','project','switch'])('does not advertise owner retry when %s is unavailable',async kind=>{
 const f=await uncertainPost();
 if(kind==='mode')f.db.rows('settings')[0].value={mode:'AUTONOMOUS',revision:2};
 if(kind==='rollout')f.db.rows('accountWriteState')[0].rolloutReady=false;
 if(kind==='project')f.projects.assertProjectActive.mockRejectedValue(new Error('PROJECT_INACTIVE'));
 if(kind==='switch')vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED','false');
 expect(await f.service.postReview('org','user',f.execution.id,'root')).toMatchObject({canRetryUnconfirmed:false});
});
it('keeps held quota restrictive for the new attempt and fences the old executor',async()=>{
 const f=await uncertainPost();await retry(f);
 const newer=await f.service.reserveApi('org','root','newer',new Date());
 await expect(f.service.authorizeApiSegment('org',newer.id,0,{id:'123',idNamespace:'x.rest_id'},new Date())).rejects.toThrow('SEND_QUOTA_EXHAUSTED');
 const result=await f.db.$transaction((tx:any)=>f.service.authorizeIn(tx,f.db.rows('sendExecution').find(e=>e.id===f.execution.id),0,{id:'123',idNamespace:'x.rest_id'},new Date()));
 expect(result).toEqual({granted:false,status:'UNKNOWN'});
 expect(f.db.rows('sendIntent')[0].activeExecutionId).toBe(newer.id);
 expect(f.db.rows('sendQuotaBucket')[0].heldUnits).toBe(1);
});
it('accepts the original node owner and rejects threads or a changed original root',async()=>{
 const f=await uncertainPost();f.db.rows('sendIntent')[0].policySnapshot.policyOwnerUserId='scheduler';
 await expect(retry(f)).resolves.toMatchObject({status:'QUEUED'});
 for(const kind of ['thread','root']){
  const next=await uncertainPost();
  if(kind==='thread')next.db.seed('sendSegment',{...next.db.rows('sendSegment')[0],id:'child',segmentIndex:1});
  else next.db.rows('post')[0].sendIntentId='other';
  await expect(retry(next)).rejects.toThrow('SEND_POST_REVIEW_NOT_SETTLED');
 }
});

it('deduplicates concurrent clicks and preserves a newer published identity on late confirmation',async()=>{
 const f=await uncertainPost();const results=await Promise.all([retry(f),retry(f)]);
 expect(results[0]).toEqual(results[1]);expect(f.db.rows('sendMutationReceipt')).toHaveLength(1);
 const newer=await f.service.reserveApi('org','root','newer',new Date());
 Object.assign(f.db.rows('sendExecution').find(e=>e.id===newer.id),{status:'SUCCEEDED'});
 Object.assign(f.db.rows('sendIntent')[0],{status:'SUCCEEDED',activeExecutionId:null,hasConfirmedSegments:true});
 Object.assign(f.db.rows('sendSegment').find(s=>s.executionId===newer.id),{status:'CONFIRMED',result:{status:'confirmed',platformId:'newer-post'}});
 Object.assign(f.db.rows('post')[0],{state:'PUBLISHED',releaseId:'newer-post',releaseURL:'https://x.com/alice/status/newer-post'});
 const event={eventId:'late-duplicate',status:'confirmed' as const,platformId:'older-post'};
 const result=await f.db.$transaction((tx:any)=>f.service.outcomeIn(tx,f.db.rows('sendExecution').find(e=>e.id===f.execution.id),0,event,new Date()));
 expect(result.conflict).toBe(true);expect(f.db.rows('post')[0].releaseId).toBe('newer-post');
 expect(f.db.rows('sendSegment').find(s=>s.executionId===f.execution.id).result.platformId).toBe('older-post');
 expect(f.db.rows('sendQuotaBucket')[0]).toMatchObject({heldUnits:0,confirmedUnits:1});
 await f.db.$transaction((tx:any)=>f.service.outcomeIn(tx,f.db.rows('sendExecution').find(e=>e.id===f.execution.id),0,event,new Date()));
 expect(f.db.rows('sendQuotaBucket')[0]).toMatchObject({heldUnits:0,confirmedUnits:1});
});
it.each([{requestId:'',expectedResolutionRevision:0},{requestId:'x',expectedResolutionRevision:-1},{requestId:'x',expectedResolutionRevision:0.5}])('rejects a malformed retry request',async body=>{
 const f=await uncertainPost();await expect(retry(f,body)).rejects.toThrow('INVALID_SEND_RETRY_REQUEST');
 expect(f.db.rows('sendIntent')[0].activeExecutionId).toBe(f.execution.id);
});

describe('owner retry of a saved reply', () => {
  async function uncertainReply(unpermitted = false) {
    const f = await uncertainPost();
    Object.assign(f.db.rows('post')[0], { source: 'engage' });
    Object.assign(f.db.rows('sendIntent')[0], { action: 'REPLY' });
    Object.assign(f.db.rows('sendExecution')[0], { action: 'REPLY' });
    f.db.seed('engageSentReply', { id: 'reply', organizationId: 'org', projectId: 'project', postId: 'root' });
    if (unpermitted) {
      Object.assign(f.db.rows('sendSegment')[0], { authorizedAt: null, submitBefore: null, permitHash: null });
      f.db.rows('sendQuotaReservation').splice(0);
      f.db.rows('sendQuotaBucket').splice(0);
    }
    return f;
  }

  it('requeues the X reply on a different browser without a submission permit', async () => {
    const f = await uncertainReply(true);
    const result = await f.service.retryUnconfirmedReply('org', 'user', f.execution.id, 'reply', { ...request(), confirmDuplicateRisk: true });
    expect(result).toMatchObject({ status: 'requeued' });
    expect(f.db.rows('sendIntent')[0]).toMatchObject({ status: 'QUEUED', activeExecutionId: null });
    expect(f.db.rows('sendExecution')[0]).toMatchObject({ status: 'RETRY_REQUESTED' });
    expect(await f.service.retryUnconfirmedReply('org', 'user', f.execution.id, 'reply', { ...request(), confirmDuplicateRisk: true })).toEqual(result);
  });



  it('uses manual admission for user-approved automation retries, including already requeued replies', async () => {
    const f = await uncertainReply();
    const intent = f.db.rows('sendIntent')[0];
    intent.sendOrigin = 'AUTOMATION';
    const originalContext = f.db.rows('sendExecution')[0].context;
    const resolve = vi.mocked(f.quotas.resolve);
    const plan = await f.quotas.resolve(f.db as any, intent, f.db.rows('accountWriteState')[0], 0, new Date());
    resolve.mockImplementation(async (_tx, effective) => {
      if (effective.sendOrigin === 'AUTOMATION') throw new ForbiddenException('PROJECT_REPLY_INTERVAL');
      return { ...plan, budgets: [] };
    });
    const reply = f.db.rows('post')[0];
    const session = { integrationId: 'account', verificationStatus: 'VERIFIED',
      verificationExpiresAt: new Date(Date.now() + 60000), accountIdentity: { id: '123', namespace: 'x.rest_id' } } as any;
    await f.service.retryUnconfirmedReply('org', 'user', f.execution.id, 'reply',
      { ...request(), confirmDuplicateRisk: true });
    // Simulate a request queued before the manual retry marker existed.
    f.db.rows('sendIntent')[0].context = null;
    expect(await f.service.claimabilityReasonIn(f.db as any, 'org', reply, session, 'REPLY', new Date())).toBeNull();
    const next = await f.service.reserveApi('org', 'root', 'manual-retry', new Date());
    expect(next.context).toMatchObject({ manualReplyRetry: true });
    expect(f.db.rows('sendIntent')[0].sendOrigin).toBe('AUTOMATION');
    expect(f.db.rows('sendExecution')[0].context).toEqual(originalContext);
    expect((await f.service.authorizeApiSegment('org', next.id, 0, { id: '123', idNamespace: 'x.rest_id' }, new Date())).granted)
      .toBe(true);
  });

  it('marks an explicit retry of a definitively failed automatic reply as manual', async () => {
    const f = await uncertainReply();
    Object.assign(f.db.rows('sendIntent')[0], { sendOrigin: 'AUTOMATION', status: 'FAILED_FINAL',
      activeExecutionId: null, context: { matchedKeywords: ['agents'] } });
    f.db.rows('sendExecution')[0].status = 'FAILED_FINAL';
    f.db.rows('sendSegment')[0].status = 'NOT_SUBMITTED';
    f.db.rows('post')[0].state = 'ERROR';
    await f.service.retry('org', 'root', 'user');
    expect(f.db.rows('sendIntent')[0]).toMatchObject({ status: 'QUEUED', sendOrigin: 'AUTOMATION',
      context: { manualReplyRetry: true, matchedKeywords: ['agents'] } });
  });

  it('blocks reserving or authorizing a reply that already has a published receipt', async () => {
    const f = await uncertainReply(true);
    await f.service.retryUnconfirmedReply('org', 'user', f.execution.id, 'reply', { ...request(), confirmDuplicateRisk: true });
    const next = await f.service.reserveApi('org', 'root', 'manual-retry', new Date());
    f.db.rows('post')[0].releaseURL = 'https://x.com/alice/status/321';
    await expect(f.service.authorizeApiSegment('org', next.id, 0, { id: '123', idNamespace: 'x.rest_id' }, new Date()))
      .rejects.toThrow('CONTENT_ALREADY_SUBMITTED');
    Object.assign(f.db.rows('sendIntent')[0], { status: 'QUEUED', activeExecutionId: null });
    await expect(f.service.reserveApi('org', 'root', 'another-retry', new Date())).rejects.toThrow('CONTENT_NOT_SENDABLE');
    expect(f.db.rows('sendExecution')).toHaveLength(2);
  });

  it('returns duplicate-risk review without writing or locking send settings', async () => {
    const f = await uncertainReply();
    const lock = vi.spyOn(f.service, 'assertControlledIn');
    await expect(f.service.retryUnconfirmedReply('org', 'user', f.execution.id, 'reply', request()))
      .resolves.toMatchObject({ status: 'review-required' });
    expect(lock).not.toHaveBeenCalled();
    expect(f.db.rows('sendMutationReceipt')).toHaveLength(0);
  });

  it('checks project activation before acquiring the send settings lock', async () => {
    const f = await uncertainReply(true);
    const lock = vi.spyOn(f.service, 'assertControlledIn');
    f.projects.assertProjectActive.mockRejectedValue(new Error('PROJECT_INACTIVE'));
    await expect(f.service.retryUnconfirmedReply('org', 'user', f.execution.id, 'reply', request()))
      .rejects.toThrow('PROJECT_INACTIVE');
    expect(lock).not.toHaveBeenCalled();
  });

  it('backs off and requeues once after transient serialization conflicts', async () => {
    const f = await uncertainReply(true);
    const conflict = Object.assign(new Error('Serialization conflict'), { code: 'P2034' });
    const lock = vi.spyOn(f.service, 'assertControlledIn')
      .mockRejectedValueOnce(conflict).mockRejectedValueOnce(conflict);
    const retry = f.service.retryUnconfirmedReply('org', 'user', f.execution.id, 'reply', { ...request(), confirmDuplicateRisk: true });
    const result = expect(retry).resolves.toEqual({ status: 'requeued' });
    await vi.advanceTimersByTimeAsync(0);
    expect(lock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    await result;
    expect(lock).toHaveBeenCalledTimes(3);
    expect(f.db.rows('sendMutationReceipt')).toHaveLength(1);
  });

  it('returns HTTP 409 after the serialization retry budget is exhausted', async () => {
    const f = await uncertainReply(true);
    const lock = vi.spyOn(f.service, 'assertControlledIn')
      .mockRejectedValue(Object.assign(new Error('Serialization conflict'), { code: 'P2034' }));
    const retry = f.service.retryUnconfirmedReply('org', 'user', f.execution.id, 'reply', { ...request(), confirmDuplicateRisk: true });
    await Promise.all([
      expect(retry).rejects.toMatchObject({ status: 409, response: { code: 'SEND_RETRY_BUSY' } }),
      vi.advanceTimersByTimeAsync(1000),
    ]);
    expect(lock).toHaveBeenCalledTimes(4);
    expect(f.db.rows('sendIntent')[0]).toMatchObject({ status: 'RECONCILING', activeExecutionId: f.execution.id });
    expect(f.db.rows('sendMutationReceipt')).toHaveLength(0);
  });

  it('requires consent for a stopped reply that had a permit', async () => {
    const f = await uncertainReply();
    expect(await f.service.retryUnconfirmedReply('org', 'user', f.execution.id, 'reply', request()))
      .toMatchObject({ status: 'review-required' });
    expect(f.db.rows('sendIntent')[0].status).toBe('RECONCILING');
    expect(await f.service.retryUnconfirmedReply('org', 'user', f.execution.id, 'reply',
      { ...request(), confirmDuplicateRisk: true })).toMatchObject({ status: 'requeued' });
    expect(f.db.rows('sendQuotaReservation')[0].state).toBe('HELD');
  });

  it('leaves a live reply alone and returns the link when already published', async () => {
    const f = await uncertainReply();
    f.db.rows('sendExecution')[0].leaseExpiresAt = new Date(Date.now() + 60_000);
    expect(await f.service.retryUnconfirmedReply('org', 'user', f.execution.id, 'reply',
      { ...request(), confirmDuplicateRisk: true })).toMatchObject({ status: 'waiting' });
    expect(f.db.rows('sendIntent')[0].activeExecutionId).toBe(f.execution.id);
    const url = 'https://x.com/alice/status/321';
    Object.assign(f.db.rows('post')[0], { state: 'PUBLISHED', releaseURL: url, releaseId: '321' });
    expect(await f.service.retryUnconfirmedReply('org', 'user', f.execution.id, 'reply', request()))
      .toEqual({ status: 'published', url });
    expect(f.db.rows('sendMutationReceipt')).toHaveLength(0);
  });

  it('rejects a mismatched reply ID and a user outside the original owner scope', async () => {
    const f = await uncertainReply(true);
    await expect(f.service.retryUnconfirmedReply('org', 'user', f.execution.id, 'other', request())).rejects.toThrow();
    f.db.rows('sendIntent')[0].policySnapshot.policyOwnerUserId = 'other';
    f.db.rows('extensionNode')[0].registeredByUserId = 'other';
    await expect(f.service.retryUnconfirmedReply('org', 'user', f.execution.id, 'reply', request())).rejects.toThrow();
    expect(f.db.rows('sendIntent')[0].status).toBe('RECONCILING');
  });
});


describe('owner retry of a zero-confirmed thread', () => {
 it('requeues all four original posts while preserving the unknown root, trailing pending segments and held quota', async () => {
  const f=await uncertainPost(4);
  const evidence=structuredClone(f.db.rows('sendSegment'));
  expect(await f.service.postReview('org','user',f.execution.id,'root')).toMatchObject({canRetryUnconfirmed:true,canReviewNotSent:false});
  expect(await retry(f)).toEqual({sendIntentId:f.execution.sendIntentId,status:'QUEUED'});
  expect(f.db.rows('sendSegment')).toEqual(evidence);
  expect(f.db.rows('post').every(p=>p.state==='QUEUE'&&p.sendIntentId===f.execution.sendIntentId)).toBe(true);
  expect(f.db.rows('sendExecution')[0]).toMatchObject({status:'RETRY_REQUESTED',resolutionRevision:1});
  expect(f.db.rows('sendQuotaReservation')[0].state).toBe('HELD');
  const next=await f.service.reserveApi('org','root','new-thread',new Date());
  expect(next.payload.map(p=>p.id)).toEqual(['root','child-1','child-2','child-3']);
  expect(await retry(f)).toEqual({sendIntentId:f.execution.sendIntentId,status:'QUEUED'});
  expect(f.db.rows('sendIntent')[0].activeExecutionId).toBe(next.id);
  await expect(f.service.authorizeApiSegment('org',next.id,0,{id:'123',idNamespace:'x.rest_id'},new Date())).rejects.toThrow('SEND_QUOTA_EXHAUSTED');
 });
 it.each(['confirmed-child','historical-confirmation','child-release','live-child-permit','authorized-child','missing-segment','duplicate-payload','changed-child','foreign-child','reply-thread'])('rejects unsafe %s without superseding evidence', async kind => {
  const f=await uncertainPost(4);const segments=f.db.rows('sendSegment');const child=segments[1];
  if(kind==='confirmed-child')child.status='CONFIRMED';
  if(kind==='historical-confirmation') {f.db.seed('sendExecution',{...f.db.rows('sendExecution')[0],id:'prior'});f.db.seed('sendSegment',{...child,id:'prior-segment',executionId:'prior',status:'CONFIRMED'});}
  if(kind==='child-release')f.db.rows('post')[1].releaseId='already-posted';
  if(kind==='live-child-permit')Object.assign(child,{status:'UNKNOWN',authorizedAt:new Date(),submitBefore:new Date(Date.now()+60000),permitHash:'child-permit',result:{status:'unknown'}});
  if(kind==='authorized-child')Object.assign(child,{status:'AUTHORIZED',authorizedAt:new Date(),submitBefore:new Date(Date.now()-1000),permitHash:'child-permit'});
  if(kind==='missing-segment')segments.splice(2,1);
  if(kind==='duplicate-payload')f.db.rows('sendExecution')[0].payload[1].id='root';
  if(kind==='changed-child')f.db.rows('post')[1].content='changed after execution';
  if(kind==='foreign-child')f.db.rows('post')[1].integrationId='another-account';
  if(kind==='reply-thread') {f.db.rows('sendExecution')[0].action='REPLY';f.db.rows('sendIntent')[0].action='REPLY';}
  await expect(f.service.postReview('org','user',f.execution.id,'root')).rejects.toThrow();
  await expect(retry(f)).rejects.toThrow();
  expect(f.db.rows('sendIntent')[0]).toMatchObject({status:'RECONCILING',activeExecutionId:f.execution.id});
  expect(f.db.rows('sendQuotaReservation')[0].state).toBe('HELD');
 });
 it('does not let legacy single-segment absence attestation clear a whole thread', async () => {
  const f=await uncertainPost(4);
  await expect(f.service.reviewPostNotSent('org','user',f.execution.id,'root', {eventId:'review',expectedResolutionRevision:0,reviewedNotSent:true,draftsClosed:true})).rejects.toThrow('SEND_POST_REVIEW_NOT_SETTLED');
  expect(f.db.rows('sendSegment')[0].status).toBe('UNKNOWN');
  expect(f.db.rows('sendQuotaReservation')[0].state).toBe('HELD');
 });
 it('fences a newer thread claim when an original positive result arrives late', async () => {
  const f=await uncertainPost(4);await retry(f);const next=await f.service.reserveApi('org','root','next-thread',new Date());
  const old=f.db.rows('sendExecution').find(e=>e.id===f.execution.id);
  const result=await f.db.$transaction((tx:any)=>f.service.outcomeIn(tx,old,0,{eventId:'late-root',status:'confirmed',platformId:'old-root',url:'https://x.com/alice/status/old-root'},new Date()));
  expect(result.conflict).toBe(true);
  expect(f.db.rows('sendExecution').find(e=>e.id===next.id).status).toBe('RECONCILING');
  expect(f.db.rows('accountWriteState')[0].rolloutReady).toBe(false);
  expect(f.db.rows('sendSegment').find(s=>s.executionId===f.execution.id&&s.segmentIndex===0).status).toBe('CONFIRMED');
 });
});
