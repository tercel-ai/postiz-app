import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostActivity } from '../../../../../apps/orchestrator/src/activities/post.activity';
import { setupSend, sendNow as now } from './support/send-fixture';
import { controlledSubmit } from '../controlled-api-submit';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'true');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
async function fixture() {
  const setup = setupSend();
  const { service } = setup;
  await setup.create();
  const activity = Object.create(PostActivity.prototype) as PostActivity;
  const network = vi
    .fn()
    .mockResolvedValue([
      {
        id: 'root',
        postId: 'platform-id',
        releaseURL: 'https://x.com/alice/status/platform-id',
        status: 'posted',
      },
    ]);
  const provider = {
    identifier: 'x',
    getSendActor: vi
      .fn()
      .mockResolvedValue({ id: '123', idNamespace: 'x.rest_id' }),
    post: vi.fn().mockImplementation(() => controlledSubmit(network)),
  };
  Object.assign(activity, {
    _sendCoordinator: service,
    _integrationManager: { getSocialIntegration: () => provider },
    _postService: {
      updateTags: vi.fn().mockImplementation((_org, posts) => posts),
      updateMedia: vi.fn().mockResolvedValue([]),
    },
  });
  const execution = await service.reserveApi('org','root','historical-workflow',now);
  return { ...setup, activity, network, provider, id: execution.id };
}
describe('disabled OAuth publishing adapter',()=>{
  it('does not reserve new API work',async()=>{
    const {activity,db}=await fixture();const before=db.rows('sendExecution').length;
    expect(await activity.reserveCoordinatedSend('org','root','new-workflow')).toMatchObject({status:'CAPABILITY_UNSUPPORTED'});
    expect(db.rows('sendExecution')).toHaveLength(before);
  });
  it('does not invoke a platform provider or acquire quota for an old pending API execution',async()=>{
    const {activity,network,db,id}=await fixture();
    expect(await activity.sendCoordinatedSegment('org',id,0)).toEqual({status:'CAPABILITY_UNSUPPORTED'});
    expect(network).not.toHaveBeenCalled();expect(db.rows('sendQuotaReservation')).toHaveLength(0);
  });
  it('preserves confirmed or uncertain historical API facts without sending again',async()=>{
    const {activity,network,db,id}=await fixture();
    db.rows('sendSegment')[0].status='CONFIRMED';
    expect(await activity.sendCoordinatedSegment('org',id,0)).toEqual({status:'CONFIRMED'});
    db.rows('sendSegment')[0].status='UNKNOWN';
    expect(await activity.sendCoordinatedSegment('org',id,0)).toEqual({status:'RECONCILING'});
    expect(network).not.toHaveBeenCalled();
  });
});
