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
 (f.policies as any).lockSystemInTransaction=()=>f.policies.getSystem();
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


it('edits original native preparation, retains audit, supports dormant draft and explicit resume',async()=>{
 const f=await fixture();const old=structuredClone(f.db.rows('sendExecution')[0].payload);
 const body:any={requestId:'edit-1',projectId:'project',type:'draft',date:sendNow.toISOString(),posts:[{value:[{id:'root',content:'edited'}],integration:{id:'new-account'},expectedRouteRevision:0,expectedContentRevision:1}],tags:[]};
 const write=async(tx:any)=>[await tx.post.update({where:{id:'root'},data:{content:'edited',state:'DRAFT',contentRevision:{increment:1}}})];
 await f.service.editUnsentPost('org','user',body,write);
 expect(f.db.rows('post')[0]).toMatchObject({id:'root',state:'DRAFT',content:'edited',contentRevision:2});
 expect(f.db.rows('sendIntent')[0]).toMatchObject({status:'CANCELLED',context:{editableDraft:true}});
 expect(f.db.rows('sendExecution')[0]).toMatchObject({status:'CANCELLED',payload:old});
 expect(f.summary().allowedActions.edit.allowed).toBe(true);
 await f.service.editUnsentPost('org','user',body,write);
 expect(f.db.rows('post')[0].contentRevision).toBe(2);
 body.requestId='edit-2';body.type='now';body.posts[0].expectedRouteRevision=1;body.posts[0].expectedContentRevision=2;
 await f.service.editUnsentPost('org','user',body,async(tx:any)=>[await tx.post.update({where:{id:'root'},data:{state:'QUEUE',content:'again',contentRevision:{increment:1}}})]);
 expect(f.db.rows('sendIntent')[0]).toMatchObject({status:'QUEUED',contentRevision:3});
});


it('uses the real original editor repository mapping for media/settings/body and preserves old payload',async()=>{
 const f=await fixture();
 const {PostsRepository}=await import('../../database/prisma/posts/posts.repository');
 const {PostsService}=await import('../../database/prisma/posts/posts.service');
 const {SendModeService}=await import('../send-mode.service');
 const repo=new PostsRepository({model:f.db} as any,{} as any,{} as any,{model:f.db} as any,{model:f.db} as any,{} as any,{model:f.db} as any,new SendModeService(f.db));
 const svc=new PostsService(repo,{} as any,{} as any,{} as any,{} as any,{} as any,{} as any,{} as any,{assertDraftQuota:vi.fn()} as any,{} as any);
 Object.assign(svc,{_sendCoordinator:f.service});vi.spyOn(svc,'isControlled').mockResolvedValue(true);
 const old=structuredClone(f.db.rows('sendExecution')[0].payload);
 const body:any={requestId:'real-edit',projectId:'project',type:'draft',date:sendNow.toISOString(),shortLink:false,tags:[],posts:[{
  integration:{id:'new-account'},publishMethod:'api',providerIdentifier:'x',expectedRouteRevision:0,expectedContentRevision:1,
  settings:{__type:'x',who_can_reply_post:'following'},value:[{id:'root',content:'updated body',image:[{id:'media',path:'https://example.test/image.png'}]}]}]};
 body.posts[0].value.push({content:'new child',image:[]});
 const result=await svc.createPost('org',body,'user');
 expect(result[0]).toMatchObject({postId:'root',state:'DRAFT',sending:{status:'DRAFT',routeRevision:1,contentRevision:2,allowedActions:{edit:{allowed:true}}}});
 expect(f.db.rows('post')[0]).toMatchObject({content:'updated body',image:JSON.stringify(body.posts[0].value[0].image),settings:JSON.stringify(body.posts[0].settings)});
 expect(f.db.rows('sendExecution')[0].payload).toEqual(old);
 const child=f.db.rows('post').find(p=>p.id!=='root');expect(child).toMatchObject({parentPostId:'root',organizationId:'org',sendIntentId:result[0].sending.sendIntentId});
 body.requestId='shrink-real';body.posts[0].expectedRouteRevision=1;body.posts[0].expectedContentRevision=2;body.posts[0].value=[body.posts[0].value[0]];
 await svc.createPost('org',body,'user');
 expect(f.db.rows('post').find(p=>p.id===child.id).deletedAt).toBeTruthy();
 expect(f.db.rows('sendExecution')[0].payload).toEqual(old);
 body.requestId='resume-real';body.type='now';body.posts[0].publishMethod='extension';body.posts[0].expectedRouteRevision=2;body.posts[0].expectedContentRevision=3;
 const resumed=await svc.createPost('org',body,'user');expect(resumed[0]).toMatchObject({state:'QUEUE',publishMethod:'EXTENSION',sending:{routeRevision:3,contentRevision:4}});
});
it.each(['old-client','authorized','unknown','exposed'])('full editing refuses %s without calling writer',async kind=>{
 const f=await fixture(kind!=='old-client');const s=f.db.rows('sendSegment')[0];
 if(kind==='authorized')s.authorizedAt=sendNow;if(kind==='unknown')s.status='UNKNOWN';if(kind==='exposed')s.result={status:'draft_exposed'};
 const write=vi.fn();
 await expect(f.service.editUnsentPost('org','user',{requestId:'blocked',projectId:'project',type:'now',posts:[{expectedRouteRevision:0,expectedContentRevision:1,value:[{id:'root'}]}]} as any,write)).rejects.toThrow();
 expect(write).not.toHaveBeenCalled();
});
it('unclaimed API original exposes full edit while any API execution remains immutable',async()=>{
 const f=setupSend();await f.create('root','API');
 f.db.rows('post')[0].publishMethod='API';
 const post=f.db.rows('post')[0],intent=f.db.rows('sendIntent')[0];
 expect(sendBusinessSummary(post,intent,[],[],null,true).allowedActions.edit.allowed).toBe(true);
 const e=await f.service.reserveApi('org','root','api',sendNow);
 expect(sendBusinessSummary(post,intent,[e],f.db.rows('sendSegment'),null,true).allowedActions.edit.allowed).toBe(false);
});

it('edits a grown then shrunk thread across revoked payload revisions without deleting audit',async()=>{
 const f=await fixture();
 const request=(id:string,rev:number)=>({requestId:id,projectId:'project',type:'now',date:sendNow.toISOString(),posts:[{integration:{id:'new-account'},expectedRouteRevision:rev,expectedContentRevision:rev+1,value:[{id:'root',content:id}]}],tags:[]}) as any;
 await f.service.editUnsentPost('org','user',request('grow',0),async(tx:any)=>{
  const root=await tx.post.update({where:{id:'root'},data:{content:'grow',contentRevision:2}});
  const child=await tx.post.create({data:{...root,id:'child',parentPostId:'root',content:'child'}});return [root,child];
 });
 expect(f.summary().allowedActions.edit.allowed).toBe(true);
 const old=structuredClone(f.db.rows('sendExecution')[0]);
 await f.service.editUnsentPost('org','user',request('shrink',1),async(tx:any)=>[await tx.post.update({where:{id:'root'},data:{content:'shrink',contentRevision:3}})]);
 expect(f.db.rows('post').find(p=>p.id==='child').deletedAt).toBeTruthy();
 expect(f.db.rows('sendExecution')[0]).toEqual(old);
 expect(f.db.rows('sendSegment')[0].postId).toBe('root');
});
it.each([true,false])('full edit and native authorization cannot both commit (start first: %s)',async first=>{
 const f=await fixture();await f.proof();
 const edit=()=>f.service.editUnsentPost('org','user',{requestId:'edit-race',projectId:'project',type:'now',posts:[{expectedRouteRevision:0,expectedContentRevision:1,value:[{id:'root'}]}]} as any,async(tx:any)=>[await tx.post.findUnique({where:{id:'root'}})]);
 const start=()=>f.executions.start(auth,f.item.executionId,0,f.item.leaseToken,{authorizationMode:'NATIVE_FLOW_V1'});
 const results=await Promise.allSettled(first?[start(),edit()]:[edit(),start()]);
 const edited=results[first?1:0].status==='fulfilled',authorized=f.db.rows('sendSegment')[0].status==='AUTHORIZED';
 expect(edited&&authorized).toBe(false);expect(edited||authorized).toBe(true);
});

it('rejects unsupported controlled API dispatch before writing, but accepts explicit extension conversion',async()=>{
 const f=setupSend();(f.policies as any).lockSystemInTransaction=()=>f.policies.getSystem();await f.create('root','API');f.db.rows('post')[0].publishMethod='API';const before=structuredClone(f.db.rows('post'));
 const body:any={requestId:'api-edit',projectId:'project',type:'now',posts:[{expectedRouteRevision:0,expectedContentRevision:1,value:[{id:'root'}]}]};
 const write=vi.fn();await expect(f.service.editUnsentPost('org','user',body,write)).rejects.toThrow('API_PUBLISHING_UNSUPPORTED_USE_EXTENSION');
 expect(write).not.toHaveBeenCalled();expect(f.db.rows('post')).toEqual(before);
 body.posts[0].publishMethod='extension';
 const result=await f.service.editUnsentPost('org','user',body,async(tx:any)=>[await tx.post.update({where:{id:'root'},data:{publishMethod:'EXTENSION'}})]);
 expect(result).toMatchObject({postId:'root',publishMethod:'EXTENSION',sending:{contentRevision:2,routeRevision:1}});
});

async function realEditorFixture() {
 const f=await fixture();
 const {PostsRepository}=await import('../../database/prisma/posts/posts.repository');
 const {PostsService}=await import('../../database/prisma/posts/posts.service');
 const {SendModeService}=await import('../send-mode.service');
 const modes=new SendModeService(f.db);
 const repo=new PostsRepository({model:f.db} as any,{} as any,{} as any,{model:f.db} as any,{model:f.db} as any,{} as any,{model:f.db} as any,modes);
 let generated=0;
 const convert=vi.fn(async (_org:string,values:string[])=>values.map(value=>value+' https://short.test/'+(++generated)));
 const svc=new PostsService(repo,{} as any,{} as any,{} as any,{convertTextToShortLinks:convert} as any,{} as any,{} as any,{} as any,{assertDraftQuota:vi.fn()} as any,{} as any);
 Object.assign(svc,{_sendCoordinator:f.service});vi.spyOn(svc,'isControlled').mockResolvedValue(true);
 const body:any={requestId:'dormant-real',projectId:'project',type:'draft',date:sendNow.toISOString(),shortLink:false,tags:[],posts:[{
  integration:{id:'new-account'},publishMethod:'extension',providerIdentifier:'x',expectedRouteRevision:0,expectedContentRevision:1,
  settings:{__type:'x'},value:[{id:'root',content:'editable original',image:[]}]}]};
 return {...f,svc,modes,body,convert};
}
it('a saved original extension draft grants no fresh claim and does not block actual autonomous handover',async()=>{
 const f=await realEditorFixture();
 const accepted=await f.svc.createPost('org',f.body,'user');
 const intentId=accepted[0].sending.sendIntentId;
 expect(f.db.rows('sendIntent')[0]).toMatchObject({id:intentId,status:'CANCELLED',context:{editableDraft:true}});
 Object.assign(f.db.rows('extensionNodeSession')[0],{integrationId:'new-account',sessionRevision:2,probeId:'draft-new-actor',accountIdentity:{id:'456',namespace:'x.rest_id'}});
 const claimed=await f.executions.claim(auth,{requestId:'must-not-dispatch-draft',action:'POST',rootPostId:'root',authorizationMode:'NATIVE_FLOW_V1'});
 expect(claimed.items).toEqual([]);
 expect(f.db.rows('sendExecution')).toHaveLength(1);
 f.db.rows('userOrganization')[0].role='ADMIN';
 const state=await f.modes.save('org','user',{mode:'AUTONOMOUS',expectedRevision:1,requestId:'draft-handover',expectedOrganizationId:'org',expectedUserId:'user'});
 expect(state).toMatchObject({mode:'AUTONOMOUS',autonomousAllowed:true});
 expect(state.controlledDrain?.remainingCount ?? 0).toBe(0);
 expect((await f.modes.stateIn(f.db,'org')).controlledDrain?.remainingCount ?? 0).toBe(0);
 expect(f.db.rows('post')[0]).toMatchObject({id:'root',state:'DRAFT',sendIntentId:intentId});
});
it('controlled full editor raw-request replay converts short links exactly once after a lost response',async()=>{
 const f=await realEditorFixture();f.body.shortLink=true;
 const raw=structuredClone(f.body);
 const first=await f.svc.createPost('org',structuredClone(raw),'user');
 const post=structuredClone(f.db.rows('post')[0]);
 expect(post.content).toContain('https://short.test/1');
 const replay=await f.svc.createPost('org',structuredClone(raw),'user');
 expect(f.convert).toHaveBeenCalledTimes(1);
 expect(JSON.parse(JSON.stringify(replay))).toEqual(JSON.parse(JSON.stringify(first)));
 expect(f.db.rows('post')[0]).toEqual(post);
 expect(f.db.rows('sendIntent')).toHaveLength(1);
 expect(post).toMatchObject({id:'root',routeRevision:1,contentRevision:2});
});
