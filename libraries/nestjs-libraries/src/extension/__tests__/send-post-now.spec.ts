import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupSend, sendNow } from './support/send-fixture';
import { readPublishNowRequestedAt } from '../send-dispatch';
import { sendBusinessSummary } from '../send-business-summary';
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(sendNow); vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'true'); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
async function queued() {
 const fixture = setupSend(); await fixture.create('root', 'EXTENSION');
 fixture.db.rows('post')[0].publishDate = new Date('2026-11-22T10:00:00Z');
 return fixture;
}
describe('explicit Post now scheduling of an original controlled queue', () => {
 it('advances the same root and intent without claiming, changing content, or allocating quota', async () => {
  const { service, db } = await queued();
  const original = structuredClone(db.rows('post')[0]);
  await service.rescheduleQueuedPost('org', 'root', 'user', sendNow, 0, 1);
  expect(db.rows('post')[0]).toMatchObject({ id: original.id, content: original.content, sendIntentId: original.sendIntentId, publishDate: sendNow });
  expect(db.rows('sendIntent')).toHaveLength(1); expect(db.rows('sendExecution')).toHaveLength(0); expect(db.rows('sendQuotaReservation')).toHaveLength(0);
 });
 it('keeps generic enqueue replays from silently changing an existing schedule', async () => {
  const { service, db } = await queued(); const future = db.rows('post')[0].publishDate;
  await service.enqueue('org', 'root', { userId: 'user', origin: 'MANUAL', publishDate: sendNow });
  expect(db.rows('post')[0].publishDate).toEqual(future);
 });
 it.each(['RESERVED', 'SENDING', 'RECONCILING', 'SUCCEEDED'])('rejects %s work without changing its date', async status => {
  const { service, db } = await queued(); const future = db.rows('post')[0].publishDate;
  db.rows('sendIntent')[0].status = status;
  await expect(service.rescheduleQueuedPost('org', 'root', 'user', sendNow, 0, 1)).rejects.toThrow('SEND_RESCHEDULE_UNSAFE');
  expect(db.rows('post')[0].publishDate).toEqual(future);
 });
 it('rejects stale route/content snapshots and active execution ownership', async () => {
  const { service, db } = await queued();
  for (const [route, content] of [[1,1],[0,2]]) await expect(service.rescheduleQueuedPost('org', 'root', 'user', sendNow, route, content)).rejects.toThrow('SEND_CONTENT_REVISION_CONFLICT');
  db.rows('sendIntent')[0].activeExecutionId = 'claimed';
  await expect(service.rescheduleQueuedPost('org', 'root', 'user', sendNow, 0, 1)).rejects.toThrow('SEND_RESCHEDULE_UNSAFE');
 });
 it('exposes rescheduling only for an idle unconfirmed queue', async () => {
  const { db } = await queued(); const post = db.rows('post')[0], intent = db.rows('sendIntent')[0];
  expect(sendBusinessSummary(post,intent,[],[],null,true).allowedActions.reschedule.allowed).toBe(true);
  expect(sendBusinessSummary(post,intent,[{id:'old',status:'RECONCILING'}],[],null,true).allowedActions.reschedule.allowed).toBe(false);
 });
});

it('records explicit now using server time and clears priority on ordinary reschedule', async () => {
 const {service, db} = await queued();
 await service.rescheduleQueuedPost('org', 'root', 'user', new Date('2020-01-01'), 0, 1, true);
 expect(db.rows('post')[0]).toMatchObject({publishDate: sendNow, sendTarget: {dispatch:{mode:'now',requestedAt:sendNow.toISOString()}}});
 const future = new Date('2027-01-01');
 await service.rescheduleQueuedPost('org', 'root', 'user', future, 0, 1);
 expect(db.rows('post')[0]).toMatchObject({publishDate: future});
 expect(readPublishNowRequestedAt(db.rows('post')[0].sendTarget)).toBeNull();
});
it('marks a freshly enqueued Post now using server time', async () => {
 const {service, db} = await queued();
 db.rows('post')[0].sendIntentId = null;
 db.rows('post')[0].contentUnitId = 'new-unit';
 await service.enqueue('org','root',{userId:'user',origin:'MANUAL',publishNow:true});
 expect(db.rows('post')[0]).toMatchObject({publishDate:sendNow,sendTarget:{dispatch:{mode:'now',requestedAt:sendNow.toISOString()}}});
});

it('uses manual admission for an automated Post now while retaining source provenance and pacing', async () => {
 const {service, db, quotas} = await queued();
 db.rows('sendIntent')[0].sendOrigin = 'AUTOMATION';
 db.rows('post')[0].sendOrigin = 'AUTOMATION';
 await service.rescheduleQueuedPost('org','root','user',sendNow,0,1,true);
 await service.claimabilityReasonIn(db as any,'org',db.rows('post')[0],{integrationId:'account',verificationStatus:'VERIFIED',verificationExpiresAt:new Date(Date.now()+60000),accountIdentity:{id:'123',namespace:'x.rest_id'}} as any,'POST',sendNow);
 expect(quotas.resolve).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({sendOrigin:'MANUAL'}),expect.anything(),0,sendNow);
 expect(db.rows('sendIntent')[0].sendOrigin).toBe('AUTOMATION');
 expect(db.rows('post')[0].sendOrigin).toBe('AUTOMATION');
});
it('clears manual Post now admission when returning automated work to an ordinary schedule', async () => {
 const {service, db, quotas} = await queued();
 db.rows('sendIntent')[0].sendOrigin = 'AUTOMATION';
 await service.rescheduleQueuedPost('org','root','user',sendNow,0,1,true);
 await service.rescheduleQueuedPost('org','root','user',sendNow,0,1);
 await service.claimabilityReasonIn(db as any,'org',db.rows('post')[0],{integrationId:'account',verificationStatus:'VERIFIED',verificationExpiresAt:new Date(Date.now()+60000),accountIdentity:{id:'123',namespace:'x.rest_id'}} as any,'POST',sendNow);
 expect(quotas.resolve).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({sendOrigin:'AUTOMATION'}),expect.anything(),0,sendNow);
});
it('marks an explicit Post now retry using server time while preserving the original intent', async () => {
 const {service,db} = await queued();
 Object.assign(db.rows('sendIntent')[0],{status:'FAILED_FINAL',sendOrigin:'AUTOMATION'});
 db.rows('post')[0].state='ERROR';
 const original = db.rows('sendIntent')[0].id;
 await service.retry('org','root','user',new Date('2020-01-01'),true);
 expect(db.rows('post')[0]).toMatchObject({publishDate:sendNow,sendTarget:{dispatch:{mode:'now',requestedAt:sendNow.toISOString()}},sendIntentId:original});
 expect(db.rows('sendIntent')[0]).toMatchObject({id:original,sendOrigin:'AUTOMATION',context:{manualPostNow:true}});
});

async function accountChoice() {
 const f = await queued();
 f.db.seed('integration', { ...f.db.rows('integration')[0], id: 'new-account', internalId: '456', profile: 'bob' });
 f.bindings.resolveForEnqueueInTransaction.mockResolvedValue({ integrationId: 'new-account', providerIdentifier: 'x', bindingSource: 'EXPLICIT', bindingRevision: null, canonicalAccountKey: 'new-account-key', targetAccount: { id: '456', idNamespace: 'x.rest_id', handle: 'bob' } });
 return f;
}
const choice = { integrationId: 'new-account', requestId: 'account-change-1' };
describe('explicit account-only Post Now on an unclaimed queue', () => {
 it('updates the original root, full thread and intent, then executes only as the selected actor', async () => {
  const {service,db} = await accountChoice();
  const original = structuredClone(db.rows('post')[0]);
  db.seed('post', {...original,id:'child',parentPostId:'root'});
  await service.rescheduleQueuedPost('org','root','user',sendNow,0,1,true,choice);
  expect(db.rows('sendIntent')).toHaveLength(1);
  expect(db.rows('sendIntent')[0]).toMatchObject({id:original.sendIntentId,integrationId:'new-account',routeRevision:1,contentRevision:1,target:{id:'456',idNamespace:'x.rest_id'}});
  for(const post of db.rows('post')) expect(post).toMatchObject({integrationId:'new-account',routeRevision:1,content:original.content,settings:original.settings,accountSelectionMode:'EXPLICIT'});
  expect(db.rows('sendExecution')).toHaveLength(0);
  expect(db.rows('sendQuotaReservation')).toHaveLength(0);
  const execution = await service.reserveApi('org','root','new-executor',sendNow);
  expect(execution).toMatchObject({integrationId:'new-account',routeRevision:1,target:{id:'456'}});
 });
 it('replays a lost response without changing the route twice and rejects a changed body for the same request', async () => {
  const {service,db} = await accountChoice();
  await service.rescheduleQueuedPost('org','root','user',sendNow,0,1,true,choice);
  await service.rescheduleQueuedPost('org','root','user',sendNow,0,1,true,choice);
  expect(db.rows('post')[0].routeRevision).toBe(1);
  expect(db.rows('sendMutationReceipt')).toHaveLength(1);
  await expect(service.rescheduleQueuedPost('org','root','user',sendNow,0,1,true,{...choice,integrationId:'another'})).rejects.toThrow('REQUEST_ID_CONFLICT');
 });
 it.each(['RESERVED','SENDING','RECONCILING','FAILED_FINAL','SUCCEEDED'])('rejects account changes for %s intents', async status => {
  const {service,db}=await accountChoice();db.rows('sendIntent')[0].status=status;
  await expect(service.rescheduleQueuedPost('org','root','user',sendNow,0,1,true,choice)).rejects.toThrow('SEND_RESCHEDULE_UNSAFE');
  expect(db.rows('post')[0].integrationId).toBe('account');
 });
 it('keeps old NOT_SUBMITTED execution evidence immutable even when date-only reschedule is safe', async () => {
  const {service,db}=await accountChoice();
  db.seed('sendExecution',{organizationId:'org',sendIntentId:db.rows('sendIntent')[0].id,status:'FAILED_FINAL'});
  await expect(service.rescheduleQueuedPost('org','root','user',sendNow,0,1,true,choice)).rejects.toThrow('SEND_ACCOUNT_CHANGE_UNSAFE');
  const summary=sendBusinessSummary(db.rows('post')[0],db.rows('sendIntent')[0],db.rows('sendExecution'),[],null,true);
  expect(summary.allowedActions.reschedule.allowed).toBe(true);
  expect(summary.allowedActions.selectAccount.allowed).toBe(false);
 });
 it('exposes account selection only before any execution, including on an accountless intent', async () => {
  const {db}=await accountChoice();
  expect(sendBusinessSummary(db.rows('post')[0],db.rows('sendIntent')[0],[],[],null,true).allowedActions.selectAccount.allowed).toBe(true);
  db.rows('post')[0].integrationId=null;db.rows('sendIntent')[0].integrationId=null;
  expect(sendBusinessSummary(db.rows('post')[0],db.rows('sendIntent')[0],[],[],null,true).allowedActions.selectAccount.allowed).toBe(true);
 });
 it('rolls back rejected account validation and stale selections', async () => {
  const {service,db,bindings}=await accountChoice();
  bindings.resolveForEnqueueInTransaction.mockRejectedValueOnce(new Error('ACCOUNT_NOT_ASSIGNED'));
  await expect(service.rescheduleQueuedPost('org','root','user',sendNow,0,1,true,choice)).rejects.toThrow('ACCOUNT_NOT_ASSIGNED');
  expect(db.rows('post')[0].integrationId).toBe('account');
  await expect(service.rescheduleQueuedPost('org','root','user',sendNow,2,1,true,choice)).rejects.toThrow('SEND_CONTENT_REVISION_CONFLICT');
  expect(db.rows('sendMutationReceipt')).toHaveLength(0);
 });
 it('serializes competing selections so the stale loser cannot replace the winner', async () => {
  const {service,db}=await accountChoice();
  const results=await Promise.allSettled([service.rescheduleQueuedPost('org','root','user',sendNow,0,1,true,choice),service.rescheduleQueuedPost('org','root','user',sendNow,0,1,true,{...choice,requestId:'competing'})]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  expect(db.rows('post')[0].routeRevision).toBe(1);
 });
 it('preserves autonomous mode and Reply account rules', async () => {
  const {service,db}=await accountChoice();db.rows('sendIntent')[0].action='REPLY';
  await expect(service.rescheduleQueuedPost('org','root','user',sendNow,0,1,true,choice)).rejects.toThrow('SEND_RESCHEDULE_UNSAFE');
  db.rows('settings').find(row=>row.key==='sending.organization_mode:org').value={mode:'AUTONOMOUS',revision:2};
  await expect(service.rescheduleQueuedPost('org','root','user',sendNow,0,1,true,choice)).rejects.toThrow('SEND_MODE_CONTROLLED_REQUIRED');
 });
});

it.each([true,false])('preserves one actor when a claim races account selection (claim invoked first: %s)', async claimFirst => {
 const {service,db}=await accountChoice();
 const claim=()=>service.reserveApi('org','root','racing-executor',sendNow);
 const change=()=>service.rescheduleQueuedPost('org','root','user',sendNow,0,1,true,choice);
 const results=await Promise.allSettled(claimFirst?[claim(),change()]:[change(),claim()]);
 // Invocation order is not transaction arrival order: reschedule validates scope before entering.
 const claimed=results[claimFirst?0:1], changed=results[claimFirst?1:0];
 expect(claimed.status).toBe('fulfilled');
 expect(db.rows('sendExecution')).toHaveLength(1);
 expect(db.rows('sendExecution')[0].integrationId).toBe(changed.status==='fulfilled'?'new-account':'account');
 expect(db.rows('sendIntent')[0].integrationId).toBe(db.rows('sendExecution')[0].integrationId);
});
it('rejects the previous browser actor after changing an unclaimed Post account', async () => {
 const {service,db}=await accountChoice();
 await service.rescheduleQueuedPost('org','root','user',sendNow,0,1,true,choice);
 const reason=await service.claimabilityReasonIn(db as any,'org',db.rows('post')[0],{integrationId:'account',verificationStatus:'VERIFIED',verificationExpiresAt:new Date(sendNow.getTime()+60000),accountIdentity:{id:'123',namespace:'x.rest_id'}} as any,'POST',sendNow);
 expect(reason).toBe('SEND_TARGET_ACCOUNT_MISMATCH');
});
