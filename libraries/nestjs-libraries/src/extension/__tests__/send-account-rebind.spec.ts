import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupSend, sendNow } from './support/send-fixture';
import { SendExecutionService } from '../send-execution.service';
import { sendBusinessSummary } from '../send-business-summary';
import { confirmSendPreflight } from '../send-preflight';

const auth = { org: 'org', user: 'user', nodeId: 'node', token: 'token' };
const change = { integrationId: 'new-account', requestId: 'rebind-1' };
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(sendNow); vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED','true'); vi.stubEnv('SEND_EXECUTION_CREDENTIAL_KEY','test-key-with-more-than-32-characters-for-rebind'); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
async function fixture(native = true) {
 const f=setupSend();
 f.db.seed('extensionNode',{id:'node',nodeId:'node',organizationId:'org',credentialVersion:1,status:'ACTIVE',capabilities:{x:{post:true,reply:true,strictAccountVerification:true}}});
 f.db.seed('extensionNodeSession',{extensionNodeId:'node',organizationId:'org',platform:'x',integrationId:'account',verificationStatus:'VERIFIED',verificationExpiresAt:new Date(+sendNow+300000),sessionRevision:1,probeId:'old',accountIdentity:{id:'123',namespace:'x.rest_id'}});
 const nodes={authenticateIn:vi.fn(async()=>f.db.rows('extensionNode')[0])};
 const executions=new SendExecutionService(f.db as any,nodes as any,f.service);
 await f.create('root','EXTENSION');
 const body={requestId:'original-claim',action:'POST' as const,...(native?{authorizationMode:'NATIVE_FLOW_V1' as const}:{})};
 const item=(await executions.claim(auth,body)).items[0];
 f.db.seed('integration',{...f.db.rows('integration')[0],id:'new-account',internalId:'456',profile:'bob'});
 f.db.seed('integrationProject',{id:'new-relation',organizationId:'org',projectId:'project',integrationId:'new-account',disabled:false,engageEnabled:true});
 f.bindings.resolveForEnqueueInTransaction.mockResolvedValue({integrationId:'new-account',providerIdentifier:'x',bindingSource:'EXPLICIT',bindingRevision:null,canonicalAccountKey:'new-key',targetAccount:{id:'456',idNamespace:'x.rest_id',handle:'bob'}});
 const summary=()=>sendBusinessSummary(f.db.rows('post')[0],f.db.rows('sendIntent')[0],f.db.rows('sendExecution'),f.db.rows('sendSegment'),null,true);
 const rebind=()=>f.service.rescheduleQueuedPost('org','root','user',sendNow,0,1,true,change);
 const proof=async()=>{
  const challenge=await executions.preflight(auth,item.executionId,0,item.leaseToken);
  const session=f.db.rows('extensionNodeSession')[0];session.probeId='fresh';
  await f.db.$transaction((tx:any)=>confirmSendPreflight(tx,f.db.rows('extensionNode')[0],{platform:'x',id:'123',identityNamespace:'x.rest_id',loggedIn:true,evidenceKind:'LIVE_COOKIE_ID',probeId:'fresh',identityObservedAt:sendNow.toISOString(),preflightChallenge:challenge.challenge},session,'old',sendNow));
 };
 return {...f,executions,item,body,summary,rebind,proof};
}
describe('account change revokes only pre-authorization native claims',()=>{
 it.each([false,true])('immediately revokes the original claim with preflight=%s and preserves old evidence',async preflight=>{
  const f=await fixture();if(preflight)await f.proof();
  expect(f.summary().allowedActions.selectAccount.allowed).toBe(true);
  expect(f.summary().allowedActions.reschedule.allowed).toBe(false);
  const original=structuredClone(f.db.rows('sendExecution')[0]);
  await f.rebind();
  expect(f.db.rows('sendExecution')[0]).toMatchObject({id:original.id,status:'CANCELLED',integrationId:'account',leaseTokenHash:original.leaseTokenHash,payload:original.payload});
  expect(f.db.rows('sendSegment')[0].status).toBe('NOT_SUBMITTED');
  expect(f.db.rows('sendIntent')[0]).toMatchObject({status:'QUEUED',activeExecutionId:null,integrationId:'new-account',routeRevision:1,fencingVersion:original.fencingVersion+1});
  expect(f.db.rows('post')[0]).toMatchObject({id:'root',state:'QUEUE',integrationId:'new-account',routeRevision:1,content:'hello'});
  expect(f.db.rows('sendQuotaReservation')).toHaveLength(0);
  expect((await f.executions.status(auth,f.item.executionId,f.item.leaseToken)).status).toBe('CANCELLED');
  expect((await f.executions.claim(auth,f.body)).items).toEqual([]);
  await expect(f.executions.renew(auth,f.item.executionId,f.item.leaseToken)).rejects.toThrow();
  await expect(f.executions.preflight(auth,f.item.executionId,0,f.item.leaseToken)).rejects.toThrow();
  await expect(f.executions.draftExposure(auth,f.item.executionId,0,f.item.leaseToken)).rejects.toThrow();
  expect((await f.executions.start(auth,f.item.executionId,0,f.item.leaseToken,{authorizationMode:'NATIVE_FLOW_V1'})).granted).toBe(false);
 });
 it('does not use a two-minute timeout to infer safety for old clients',async()=>{
  const f=await fixture(false);vi.setSystemTime(new Date(+sendNow+121000));
  expect(f.summary().allowedActions.selectAccount.allowed).toBe(false);
  await expect(f.rebind()).rejects.toThrow();
  expect(f.db.rows('sendExecution')[0].status).toBe('RESERVED');
 });
 it('blocks mode downgrade and draft exposure by an opted-in native client',async()=>{
  const f=await fixture();await f.proof();
  await expect(f.executions.start(auth,f.item.executionId,0,f.item.leaseToken)).rejects.toThrow('SEND_AUTHORIZATION_MODE_REQUIRED');
  await expect(f.executions.draftExposure(auth,f.item.executionId,0,f.item.leaseToken)).rejects.toThrow('SEND_NATIVE_AUTHORIZATION_REQUIRED');
 });
 it.each(['AUTHORIZED','UNKNOWN','CONFIRMED','EXPOSED'])('retains %s evidence and refuses account editing',async kind=>{
  const f=await fixture();const s=f.db.rows('sendSegment')[0];
  if(kind==='EXPOSED')s.result={status:'draft_exposed'};else s.status=kind;
  expect(f.summary().allowedActions.selectAccount.allowed).toBe(false);
  await expect(f.rebind()).rejects.toThrow();
  expect(f.db.rows('post')[0].integrationId).toBe('account');
 });
 it('keeps account pacing and unrelated ownership, and replays a lost response without another revocation',async()=>{
  const f=await fixture();const account=f.db.rows('accountWriteState')[0];
  account.activeExecutionId='independent';account.nextWriteNotBefore=new Date(+sendNow+60000);account.lastConfirmedAt=new Date(+sendNow-1000);
  await f.rebind();await f.rebind();
  expect(f.db.rows('post')[0].routeRevision).toBe(1);
  expect(f.db.rows('accountWriteState')[0]).toMatchObject({activeExecutionId:'independent',nextWriteNotBefore:new Date(+sendNow+60000),lastConfirmedAt:new Date(+sendNow-1000)});
 });
 it('allows a subsequent account choice after preserving the safely canceled execution',async()=>{
  const f=await fixture();await f.rebind();
  f.bindings.resolveForEnqueueInTransaction.mockResolvedValue({integrationId:'third',providerIdentifier:'x',bindingSource:'EXPLICIT',bindingRevision:null,canonicalAccountKey:'third-key',targetAccount:{id:'789',idNamespace:'x.rest_id'}});
  await f.service.rescheduleQueuedPost('org','root','user',sendNow,1,1,true,{integrationId:'third',requestId:'rebind-2'});
  expect(f.db.rows('post')[0]).toMatchObject({integrationId:'third',routeRevision:2});
  expect(f.db.rows('sendExecution')).toHaveLength(1);
 });
 it('does not let a stale stop change the new route or business status',async()=>{
  const f=await fixture();await f.rebind();
  await expect(f.executions.stop(auth,f.item.executionId,0,f.item.leaseToken,{eventId:'old-stop',permitHash:'',journalDigest:'a'.repeat(64),noPendingSubmit:true,lastPhase:'PREPARED',executorStoppedAt:sendNow.toISOString()})).rejects.toThrow();
  expect(f.db.rows('post')[0]).toMatchObject({state:'QUEUE',integrationId:'new-account'});
  expect(f.db.rows('sendIntent')[0].status).toBe('QUEUED');
 });
 it.each(['unknown','confirmed'] as const)('retains late %s evidence on the old actor and quarantines the original content',async status=>{
  const f=await fixture();await f.rebind();
  await expect(f.executions.outcome(auth,f.item.executionId,0,f.item.leaseToken,{eventId:'late',status,...(status==='confirmed'?{platformId:'published-old'}:{})})).rejects.toThrow('SEND_OUTCOME_CONFLICT_REQUIRES_RECONCILIATION');
  expect(f.db.rows('sendExecution')[0].integrationId).toBe('account');
  expect(f.db.rows('sendIntent')[0].status).toBe('RECONCILING');
  expect(f.summary().allowedActions.selectAccount.allowed).toBe(false);
 });
 it.each([true,false])('serializes authorization and rebind (start invoked first: %s)',async startFirst=>{
  const f=await fixture();await f.proof();
  const start=()=>f.executions.start(auth,f.item.executionId,0,f.item.leaseToken,{authorizationMode:'NATIVE_FLOW_V1'});
  const results=await Promise.allSettled(startFirst?[start(),f.rebind()]:[f.rebind(),start()]);
  const rebound=results[startFirst?1:0].status==='fulfilled';
  const authorized=f.db.rows('sendSegment')[0].status==='AUTHORIZED';
  expect(rebound&&authorized).toBe(false);expect(rebound||authorized).toBe(true);
  expect(f.db.rows('post')[0].integrationId).toBe(rebound?'new-account':'account');
 });
});

it('allows an expired opted-in reservation based on evidence rather than a two-minute cutoff',async()=>{
 const f=await fixture();vi.setSystemTime(new Date(+sendNow+121000));
 expect(f.summary().allowedActions.selectAccount.allowed).toBe(true);
 await f.rebind();expect(f.db.rows('sendExecution')[0].status).toBe('CANCELLED');
});
it.each(['missing-segment','permit','started'])('refuses incomplete or contradictory preparation evidence: %s',async kind=>{
 const f=await fixture();
 if(kind==='missing-segment')f.db.rows('sendSegment').length=0;
 if(kind==='permit')f.db.rows('sendSegment')[0].permitHash='old-permit';
 if(kind==='started')f.db.rows('sendExecution')[0].startedAt=sendNow;
 expect(f.summary().allowedActions.selectAccount.allowed).toBe(false);
 await expect(f.rebind()).rejects.toThrow();
 expect(f.db.rows('post')[0].integrationId).toBe('account');
});
it('rejects a disallowed new account without canceling the current preparation',async()=>{
 const f=await fixture();f.bindings.resolveForEnqueueInTransaction.mockRejectedValueOnce(new Error('ACCOUNT_NOT_ASSIGNED'));
 await expect(f.rebind()).rejects.toThrow('ACCOUNT_NOT_ASSIGNED');
 expect(f.db.rows('sendExecution')[0].status).toBe('RESERVED');
 expect(f.db.rows('sendSegment')[0].status).toBe('PENDING');
});
it('fences renewal racing with a successful account change',async()=>{
 const f=await fixture();
 const results=await Promise.allSettled([f.executions.renew(auth,f.item.executionId,f.item.leaseToken),f.rebind()]);
 expect(results[1].status).toBe('fulfilled');
 expect(f.db.rows('sendExecution')[0].status).toBe('CANCELLED');
 await expect(f.executions.renew(auth,f.item.executionId,f.item.leaseToken)).rejects.toThrow();
});
it.each(['unknown','confirmed'] as const)('a late %s receipt keeps a newer execution and its account fenced for review',async status=>{
 const f=await fixture();await f.rebind();
 const next=await f.service.reserveApi('org','root','new-executor',sendNow);
 const nextAccount=f.db.rows('accountWriteState').find(row=>row.integrationId==='new-account');nextAccount.activeExecutionId=next.id;
 await expect(f.executions.outcome(auth,f.item.executionId,0,f.item.leaseToken,{eventId:'late-new-owner',status,...(status==='confirmed'?{platformId:'old-publication'}:{})})).rejects.toThrow();
 expect(f.db.rows('sendExecution').find(row=>row.id===next.id).status).toBe('RECONCILING');
 expect(f.db.rows('accountWriteState').find(row=>row.integrationId==='new-account').activeExecutionId).toBe(next.id);
 expect(f.db.rows('sendIntent')[0].activeExecutionId).toBe(next.id);
});

it.each([true,false])('account changes after a proven no-permit stop require native claim opt-in: %s',async native=>{
 const f=await fixture(native);
 await f.executions.stop(auth,f.item.executionId,0,f.item.leaseToken,{eventId:'stopped-before-auth',permitHash:'',journalDigest:'a'.repeat(64),noPendingSubmit:true,lastPhase:'PREPARED',executorStoppedAt:sendNow.toISOString()});
 const evidence=structuredClone(f.db.rows('sendSegment')[0].result);
 expect(f.db.rows('post')[0].state).toBe('ERROR');
 expect(f.summary().allowedActions.selectAccount.allowed).toBe(native);
 if(native){
  await f.rebind();
  expect(f.db.rows('post')[0]).toMatchObject({state:'QUEUE',integrationId:'new-account',error:null});
  expect(f.db.rows('sendSegment')[0].result).toEqual(evidence);
  expect(f.db.rows('sendExecution')[0]).toMatchObject({status:'CANCELLED',integrationId:'account'});
 }else await expect(f.rebind()).rejects.toThrow();
});
it('a failed attempt that was authorized never gains account-edit permission from a later stop',async()=>{
 const f=await fixture();await f.proof();
 await f.executions.start(auth,f.item.executionId,0,f.item.leaseToken,{authorizationMode:'NATIVE_FLOW_V1'});
 const segment=f.db.rows('sendSegment')[0];vi.setSystemTime(new Date(+segment.submitBefore+1000));
 await f.executions.stop(auth,f.item.executionId,0,f.item.leaseToken,{eventId:'stopped-after-auth',permitHash:segment.permitHash,journalDigest:'a'.repeat(64),noPendingSubmit:true,lastPhase:'CANCELLED_BEFORE_SUBMIT',executorStoppedAt:new Date().toISOString()});
 expect(f.summary().allowedActions.selectAccount.allowed).toBe(false);
 await expect(f.rebind()).rejects.toThrow();
});

it('claims the new account only after live verification of that account, preserving the original content',async()=>{
 const f=await fixture();await f.rebind();
 expect((await f.executions.claim(auth,{requestId:'wrong-browser',action:'POST',rootPostId:'root',authorizationMode:'NATIVE_FLOW_V1'})).items).toEqual([]);
 Object.assign(f.db.rows('extensionNodeSession')[0],{integrationId:'new-account',sessionRevision:2,probeId:'new-actor',accountIdentity:{id:'456',namespace:'x.rest_id'}});
 const next=(await f.executions.claim(auth,{requestId:'verified-new-browser',action:'POST',rootPostId:'root',authorizationMode:'NATIVE_FLOW_V1'})).items[0];
 expect(next).toMatchObject({targetAccount:{id:'456'},routeRevision:1});
 expect(next.segments[0]).toMatchObject({id:'root',content:'hello'});
 expect(next.executionId).not.toBe(f.item.executionId);
 expect(f.db.rows('sendIntent')).toHaveLength(1);expect(f.db.rows('post')).toHaveLength(1);
});
it.each(['invalid-proof','missing-native','authorized-history','unknown-history'])('does not revive failed preparation with %s',async kind=>{
 const f=await fixture();
 await f.executions.stop(auth,f.item.executionId,0,f.item.leaseToken,{eventId:'safe-stop',permitHash:'',journalDigest:'a'.repeat(64),noPendingSubmit:true,lastPhase:'PREPARED',executorStoppedAt:sendNow.toISOString()});
 const segment=f.db.rows('sendSegment')[0],execution=f.db.rows('sendExecution')[0];
 if(kind==='invalid-proof')segment.result={status:'definitely_not_submitted',stopped:true,evidence:'{}'};
 if(kind==='missing-native')execution.context={};
 if(kind==='authorized-history')segment.authorizedAt=sendNow;
 if(kind==='unknown-history')segment.status='UNKNOWN';
 expect(f.summary().allowedActions.selectAccount.allowed).toBe(false);await expect(f.rebind()).rejects.toThrow();
});

it.each([false,true])('preserves proven no-permit account-change eligibility after explicit retry (new preparation: %s)',async prepare=>{
 const f=await fixture();
 await f.executions.stop(auth,f.item.executionId,0,f.item.leaseToken,{eventId:'safe-stop-retry',permitHash:'',journalDigest:'a'.repeat(64),noPendingSubmit:true,lastPhase:'PREPARED',executorStoppedAt:sendNow.toISOString()});
 const original=structuredClone(f.db.rows('sendSegment')[0].result);
 await f.service.retry('org','root','user',sendNow);
 if(prepare)expect((await f.executions.claim(auth,{requestId:'retry-preparation',action:'POST',rootPostId:'root',authorizationMode:'NATIVE_FLOW_V1'})).items).toHaveLength(1);
 expect(f.summary().allowedActions.selectAccount.allowed).toBe(true);
 await f.rebind();
 expect(f.db.rows('post')[0]).toMatchObject({state:'QUEUE',integrationId:'new-account'});
 expect(f.db.rows('sendSegment')[0].result).toEqual(original);
 expect(f.db.rows('sendExecution').every(e=>e.status==='CANCELLED')).toBe(true);
});

it('refuses revocation with an existing quota reservation without cancellation or refund',async()=>{
 const f=await fixture();
 await f.db.$transaction((tx:any)=>f.quotas.reserve(tx,'org',f.item.executionId,0,[{key:'held-quota',scope:'PROJECT',dimension:'ROOT_SENDS',limit:2,units:1,windowStart:new Date(+sendNow-60000),windowEnd:new Date(+sendNow+60000),timezone:'UTC',policyVersion:'test'}],sendNow));
 const before=structuredClone({posts:f.db.rows('post'),intents:f.db.rows('sendIntent'),executions:f.db.rows('sendExecution'),segments:f.db.rows('sendSegment'),quota:f.db.rows('sendQuotaReservation'),buckets:f.db.rows('sendQuotaBucket'),accounts:f.db.rows('accountWriteState')});
 await expect(f.rebind()).rejects.toThrow('SEND_ACCOUNT_CHANGE_UNSAFE');
 expect({posts:f.db.rows('post'),intents:f.db.rows('sendIntent'),executions:f.db.rows('sendExecution'),segments:f.db.rows('sendSegment'),quota:f.db.rows('sendQuotaReservation'),buckets:f.db.rows('sendQuotaBucket'),accounts:f.db.rows('accountWriteState')}).toEqual(before);
 expect(f.db.rows('sendMutationReceipt').filter(r=>r.operation==='post-now-account:root')).toHaveLength(0);
});
it.each(['cooldown','occupied'])('rebind preserves the selected account existing %s admission restriction',async restriction=>{
 const f=await fixture();
 f.db.seed('accountWriteState',{id:'existing-new-account-lock',organizationId:'org',canonicalAccountKey:'new-key',integrationId:'new-account',rolloutReady:true,revision:7,activeExecutionId:restriction==='occupied'?'other-execution':null,nextWriteNotBefore:restriction==='cooldown'?new Date(+sendNow+60000):null,lastConfirmedAt:new Date(+sendNow-1000)});
 const before=structuredClone(f.db.rows('accountWriteState').find(row=>row.integrationId==='new-account'));
 await f.rebind();
 Object.assign(f.db.rows('extensionNodeSession')[0],{integrationId:'new-account',sessionRevision:2,probeId:'new-actor',accountIdentity:{id:'456',namespace:'x.rest_id'}});
 const result=await f.executions.claim(auth,{requestId:'paced-new-account',action:'POST',rootPostId:'root',authorizationMode:'NATIVE_FLOW_V1'});
 expect(result.items).toEqual([]);
 expect(result.reason).toBe(restriction==='cooldown'?'ACCOUNT_COOLDOWN_ACTIVE':'ACCOUNT_EXECUTION_ACTIVE');
 expect(f.db.rows('accountWriteState').find(row=>row.integrationId==='new-account')).toEqual(before);
 expect(f.db.rows('sendExecution')).toHaveLength(1);
 expect(f.db.rows('sendQuotaReservation')).toHaveLength(0);
});
