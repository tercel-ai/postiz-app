import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupSend, sendNow } from './support/send-fixture';
import { sendBusinessSummary } from '../send-business-summary';

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(sendNow); vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'true'); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
const request = () => ({ requestId: 'retry-one', expectedResolutionRevision: 0 });
async function uncertainPost() {
 const f=setupSend(); await f.create('root','EXTENSION');
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
