import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupSend, sendNow } from './support/send-fixture';
import { SendExecutionService } from '../send-execution.service';

const auth={org:'org',user:'user',nodeId:'node',token:'node-token'};
beforeEach(()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date(sendNow.getTime()+6*60000));
 vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED','true');
 vi.stubEnv('SEND_EXECUTION_CREDENTIAL_KEY','test-key-with-more-than-32-characters-for-send');
});
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();});
async function fixture(){
 const f=setupSend();f.quotas.resolve.mockRestore();await f.create('root','EXTENSION');
 f.db.seed('settings',{key:'platform_pacing',value:{default:{write:[3,5],read:[1,2]}}});
 f.db.seed('settings',{key:'extension_publish.min_gap',value:{default:30}});
 Object.assign(f.db.rows('accountWriteState')[0],{lastConfirmedAt:sendNow,nextWriteNotBefore:new Date(sendNow.getTime()+3*60000)});
 f.db.seed('extensionNode',{id:'node',nodeId:'node',organizationId:'org',credentialVersion:1,status:'ACTIVE',capabilities:{x:{post:true,reply:true,strictAccountVerification:true}}});
 f.db.seed('extensionNodeSession',{extensionNodeId:'node',organizationId:'org',platform:'x',integrationId:'account',verificationStatus:'VERIFIED',verificationExpiresAt:new Date(sendNow.getTime()+3600000),sessionRevision:1,accountIdentity:{id:'123',namespace:'x.rest_id'}});
 const nodes={authenticateIn:vi.fn().mockImplementation(async()=>f.db.rows('extensionNode')[0])};
 const executions=new SendExecutionService(f.db as any,nodes as any,f.service);
 return {...f,executions};
}
describe('shared current account pacing deadline before draft exposure',()=>{
 it('does not claim a POST between an expired REPLY cooldown and the current POST minimum',async()=>{
  const f=await fixture();
  expect(await f.executions.claim(auth,{requestId:'early',action:'POST',rootPostId:'root'})).toMatchObject({items:[],reason:'ACCOUNT_COOLDOWN_ACTIVE'});
  expect(f.db.rows('sendExecution')).toHaveLength(0);expect(f.db.rows('sendQuotaReservation')).toHaveLength(0);
  expect(await f.service.businessSummary('org','user','root')).toMatchObject({timing:{reason:'ACCOUNT_WRITE_INTERVAL',nextSendNotBefore:new Date(sendNow.getTime()+30*60000)}});
 });
 it('claims and authorizes at the exact same effective deadline',async()=>{
  const f=await fixture();vi.setSystemTime(new Date(sendNow.getTime()+30*60000));
  const {items}=await f.executions.claim(auth,{requestId:'due',action:'POST',rootPostId:'root'});
  expect(items).toHaveLength(1);
  await expect(f.executions.draftExposure(auth,items[0].executionId,0,items[0].leaseToken)).resolves.toMatchObject({exposed:true});
  const execution=f.db.rows('sendExecution')[0];
  await expect(f.db.$transaction((tx:any)=>f.service.authorizeIn(tx,execution,0,{id:'123',idNamespace:'x.rest_id'},new Date()))).resolves.toMatchObject({granted:true});
  expect(await f.service.businessSummary('org','user','root')).toMatchObject({timing:{reason:'SEND_IN_PROGRESS',nextSendNotBefore:null}});
 });
 it('rechecks a raised policy before exposing a draft that was already reserved',async()=>{
  const f=await fixture();f.db.rows('settings').find(s=>s.key==='extension_publish.min_gap').value={default:3};
  const {items}=await f.executions.claim(auth,{requestId:'reserved',action:'POST',rootPostId:'root'});expect(items).toHaveLength(1);
  f.db.rows('settings').find(s=>s.key==='extension_publish.min_gap').value={default:30};
  await expect(f.executions.draftExposure(auth,items[0].executionId,0,items[0].leaseToken)).rejects.toThrow('ACCOUNT_SEND_INTERVAL_REQUIRED');
  expect(f.db.rows('sendSegment')[0].status).toBe('PENDING');expect(f.db.rows('sendSegment')[0].result).toBeUndefined();
  expect(f.db.rows('sendExecution')[0].status).toBe('RESERVED');
 });
 it('preserves a longer persisted POST cooldown for a following REPLY',async()=>{
  const f=await fixture();Object.assign(f.db.rows('post')[0],{settings:JSON.stringify({replyTo:'target'})});
  f.db.rows('sendIntent')[0].action='REPLY';f.db.rows('accountWriteState')[0].nextWriteNotBefore=new Date(sendNow.getTime()+30*60000);
  expect(await f.executions.claim(auth,{requestId:'reply-early',action:'REPLY',rootPostId:'root'})).toMatchObject({items:[],reason:'ACCOUNT_COOLDOWN_ACTIVE'});
 });
 it('applies current policy after the persisted deadline even when no stored next-write timestamp exists',async()=>{
  const f=await fixture();f.db.rows('accountWriteState')[0].nextWriteNotBefore=null;
  expect(await f.executions.claim(auth,{requestId:'no-stored-clock',action:'POST',rootPostId:'root'})).toMatchObject({items:[],reason:'ACCOUNT_COOLDOWN_ACTIVE'});
  expect(await f.service.businessSummary('org','user','root')).toMatchObject({timing:{nextSendNotBefore:new Date(sendNow.getTime()+30*60000)}});
 });
});

it('reprojects an increased current policy without changing the persisted confirmation clock',async()=>{
 const f=await fixture();f.db.rows('settings').find(s=>s.key==='extension_publish.min_gap').value={default:45};
 const before=structuredClone(f.db.rows('accountWriteState')[0]);
 expect(await f.service.businessSummary('org','user','root')).toMatchObject({timing:{reason:'ACCOUNT_WRITE_INTERVAL',nextSendNotBefore:new Date(sendNow.getTime()+45*60000)}});
 expect(f.db.rows('accountWriteState')[0]).toEqual(before);
 expect(f.db.rows('sendQuotaReservation')).toHaveLength(0);
});
it('shares the same account floor across organization projects and honors a later schedule',async()=>{
 const f=await fixture();f.db.rows('post')[0].publishDate=new Date(sendNow.getTime()+40*60000);
 expect(await f.service.businessSummary('org','user','root')).toMatchObject({timing:{reason:'SEND_NOT_DUE',nextSendNotBefore:new Date(sendNow.getTime()+40*60000)}});
});
