import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { PostsRepository } from '../posts.repository';

function setup(overrides: Record<string, unknown> = {}, receipts: unknown[] = []) {
  const root = { id: 'p', organizationId: 'org', group: 'g', state: 'QUEUE', parentPostId: null,
    projectId: 'project', providerIdentifier: 'x', publishMethod: 'EXTENSION', intervalInDays: null,
    releaseId: 'ext_live', claimedAt: new Date(), executionProtocol: 'LEGACY', ...overrides };
  const tx = {
    userOrganization: { findUnique: vi.fn().mockResolvedValue({ disabled: false }) },
    sendMutationReceipt: { findMany: vi.fn().mockResolvedValue(receipts) },
    post: { findFirst: vi.fn().mockResolvedValue(root), findMany: vi.fn().mockResolvedValue([root]), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  };
  const repo = new PostsRepository({ model: { post: tx.post } } as any, {} as any, {} as any, {} as any, {} as any, {} as any);
  return { repo, tx, root };
}

describe('autonomous queued Post now', () => {
  it('updates schedule and root priority while retaining an already issued lease and account', async () => {
    const { repo, tx } = setup();
    const now = new Date();
    await repo.rescheduleAutonomousQueuedPost('org', 'p', 'owner', now, true, tx as any);
    expect(tx.post.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: { publishDate: now, sendTarget: { dispatch: { mode: 'now', requestedAt: now.toISOString() } } } }));
    for (const [query] of tx.post.updateMany.mock.calls) {
      expect(query.data).not.toHaveProperty('content');
      expect(query.data).not.toHaveProperty('integrationId');
      expect(query.data).not.toHaveProperty('releaseId');
      expect(query.data).not.toHaveProperty('claimedAt');
    }
  });
  it('rejects a future reschedule of a leased post without changing its schedule', async () => {
    const { repo, tx } = setup();
    await expect(repo.rescheduleAutonomousQueuedPost('org', 'p', 'owner', new Date('2099-01-01T00:00:00Z'), false, tx as any))
      .rejects.toThrow('LEGACY_SCHEDULE_NOT_RESCHEDULABLE');
    expect(tx.post.updateMany).not.toHaveBeenCalled();
  });
  it('clears priority when rescheduling an unleased queued post normally', async () => {
    const { repo, tx } = setup({ releaseId: null, claimedAt: null, sendTarget: { dispatch: {mode:'now',requestedAt:new Date().toISOString()} } });
    const publishDate = new Date('2099-01-01T00:00:00Z');
    await repo.rescheduleAutonomousQueuedPost('org', 'p', 'owner', publishDate, false, tx as any);
    expect(tx.post.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.post.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { publishDate, sendTarget: Prisma.DbNull } }));
  });
  it.each(['AUTHORIZED', 'UNKNOWN', 'CONFIRMED'])('rejects %s write receipts', async (status) => {
    const { repo, tx } = setup({}, [{ result: { status, postIds: ['p'] } }]);
    await expect(repo.rescheduleAutonomousQueuedPost('org', 'p', 'owner', new Date(), true, tx as any)).rejects.toThrow('LEGACY_SCHEDULE_NOT_RESCHEDULABLE');
    expect(tx.post.updateMany).not.toHaveBeenCalled();
  });
  it.each([{ state: 'PUBLISHED' }, { releaseURL: 'https://x.com/sent' }, { executionProtocol: 'LEGACY_QUARANTINED' }, { intervalInDays: 1 }])('rejects unsafe roots %j', async (overrides) => {
    const { repo, tx } = setup(overrides);
    await expect(repo.rescheduleAutonomousQueuedPost('org', 'p', 'owner', new Date(), true, tx as any)).rejects.toThrow('LEGACY_SCHEDULE_NOT_RESCHEDULABLE');
    expect(tx.post.updateMany).not.toHaveBeenCalled();
  });
});

  it('prioritizes valid JSON before limiting and keeps null/malformed ordinary rows eligible', async () => {
    const { repo, tx } = setup();
    const date = new Date('2026-11-11T00:00:00Z');
    const target = (requestedAt: string) => ({dispatch:{mode:'now',requestedAt}});
    tx.post.findMany.mockReset().mockResolvedValueOnce([
      {id:'later',sendTarget:target('2026-11-11T02:00:00Z'),publishDate:date},
      {id:'invalid',sendTarget:target('broken'),publishDate:date},
      {id:'first',sendTarget:target('2026-11-11T01:00:00Z'),publishDate:date},
    ]).mockResolvedValueOnce([{id:'first',sendTarget:target('2026-11-11T01:00:00Z'),publishDate:date}]);
    const result = await repo.getDueExtensionPublishPosts('org', [], date, 1);
    expect(result.map(row=>row.id)).toEqual(['first']);
    expect(tx.post.findMany.mock.calls[0][0].take).toBe(100);
    expect(tx.post.findMany.mock.calls[0][0].select).toEqual({id:true,sendTarget:true,publishDate:true});
    expect(JSON.stringify(tx.post.findMany.mock.calls)).not.toContain('publishNowRequestedAt');
  });


describe('JSON dispatch selection and schedule identity', () => {
  const date = new Date('2026-11-11T00:00:00Z');
  const dispatch = { mode: 'now', requestedAt: date.toISOString() };
  it('excludes only valid immediate IDs so missing, JSON null and invalid metadata stay ordinary', async () => {
    const { repo, tx } = setup();
    const priority = { id:'priority',publishDate:date,sendTarget:{dispatch} };
    const ordinary = [
      { id:'missing',publishDate:date },
      { id:'jsonnull',publishDate:date,sendTarget:JSON.parse('null') },
      { id:'invalid',publishDate:date,sendTarget:{dispatch:{mode:'now',requestedAt:'bad'}} },
    ];
    tx.post.findMany.mockReset().mockResolvedValueOnce([priority,ordinary[2]])
      .mockResolvedValueOnce(ordinary).mockResolvedValueOnce([ordinary[2],priority,ordinary[0],ordinary[1]]);
    const result = await repo.claimDueExtensionPublishPosts('org',[],date,4,'lease',date,[],tx as any);
    expect(result.map(row=>row.id)).toEqual(['priority','missing','jsonnull','invalid']);
    const ordinaryQuery = tx.post.findMany.mock.calls[1][0] as any;
    expect(ordinaryQuery.take).toBe(3);
    expect(ordinaryQuery.where.AND).toContainEqual({id:{notIn:['priority']}});
    const nullClaim = tx.post.updateMany.mock.calls.find(([q]) => q.where.AND.some((x:any)=>x.id==='jsonnull'))![0] as any;
    expect(nullClaim.where.AND).toContainEqual({sendTarget:{equals:Prisma.AnyNull}});
    const priorityClaim = tx.post.updateMany.mock.calls[0][0] as any;
    expect(priorityClaim.where.AND).toContainEqual({sendTarget:{equals:{dispatch}}});
  });
  it('preserves bound identity and handover on promotion, then clears only dispatch on future scheduling', async () => {
    const identity = {id:'actor',platform:'x',handoverMode:'AUTONOMOUS'};
    const {repo,tx} = setup({releaseId:null,claimedAt:null,sendTarget:{...identity,dispatch}});
    await repo.rescheduleAutonomousQueuedPost('org','p','owner',date,true,tx as any);
    expect(tx.post.updateMany.mock.calls[0][0].data.sendTarget).toEqual({...identity,dispatch});
    tx.post.updateMany.mockClear();
    await repo.rescheduleAutonomousQueuedPost('org','p','owner',new Date('2099-01-01T00:00:00Z'),false,tx as any);
    expect(tx.post.updateMany.mock.calls[0][0].data.sendTarget).toEqual(identity);
  });
  it('sets priority on the draft root only while retaining all account targets', async () => {
    const {repo,tx} = setup();
    const root = {id:'root',parentPostId:null,sendTarget:{id:'actor',dispatch}};
    const child = {id:'child',parentPostId:'root',sendTarget:{id:'actor',dispatch}};
    tx.post.findMany.mockResolvedValueOnce([root,child]);
    tx.post.updateMany.mockResolvedValueOnce({count:2}).mockResolvedValue({count:1});
    await repo.schedulePostGroupToQueue('org','g','EXTENSION',date,tx as any,true);
    expect(tx.post.updateMany.mock.calls[1][0].data.sendTarget).toEqual({id:'actor',dispatch});
    expect(tx.post.updateMany.mock.calls[2][0].data.sendTarget).toEqual({id:'actor'});
  });
});

it('fails a draft scheduling transaction when the captured target changes before metadata write', async () => {
  const {repo,tx} = setup();
  tx.post.findMany.mockResolvedValueOnce([{id:'root',parentPostId:null,sendTarget:{id:'actor'}}]);
  tx.post.updateMany.mockResolvedValueOnce({count:1}).mockResolvedValueOnce({count:0});
  await expect(repo.schedulePostGroupToQueue('org','g','EXTENSION',new Date(),tx as any,true))
    .rejects.toThrow('SEND_DRAFT_CHANGED');
});


describe('bounded priority candidate pages', () => {
  const now = new Date('2026-11-11T12:00:00.000Z');
  function pagedQueue() {
    const {repo,tx} = setup();
    const rows = Array.from({length:205}, (_, index) => ({
      id: `priority-${String(index).padStart(4,'0')}`,
      publishDate: now,
      sendTarget: {dispatch:{mode:'now',requestedAt:new Date(now.getTime()-index*1000).toISOString()}},
    }));
    tx.post.findMany.mockReset().mockImplementation(async (query:any) => {
      const priorityScan = query.where.AND?.some((clause:any)=>clause.sendTarget?.path);
      if (!priorityScan) return rows;
      const offset = query.cursor ? rows.findIndex(row=>row.id===query.cursor.id)+query.skip : 0;
      return rows.slice(offset,query.take ? offset+query.take : undefined);
    });
    return {repo,tx,rows};
  }
  it('checks every bounded page before choosing FIFO priority, including the earliest request at the end', async () => {
    const {repo,tx,rows} = pagedQueue();
    const result = await repo.claimDueExtensionPublishPosts('org',[],now,2,'lease',now,[],tx as any);
    expect(result.map(row=>row.id)).toEqual([rows[204].id,rows[203].id]);
    const scans = tx.post.findMany.mock.calls.map(([q])=>q as any).filter(q=>q.where.AND?.some((clause:any)=>clause.sendTarget?.path));
    expect(scans).toHaveLength(3);
    for (const scan of scans) {
      expect(scan.take).toBe(100);
      expect(scan.orderBy).toEqual({id:'asc'});
      expect(scan.select).toEqual({id:true,sendTarget:true,publishDate:true});
    }
    expect(scans[0]).not.toHaveProperty('cursor');
    expect(scans[1]).toMatchObject({cursor:{id:rows[99].id},skip:1});
    expect(scans[2]).toMatchObject({cursor:{id:rows[199].id},skip:1});
    expect(tx.post.updateMany).toHaveBeenCalledTimes(2);
    expect(tx.post.updateMany.mock.calls[0][0].where.AND).toContainEqual({sendTarget:{equals:rows[204].sendTarget}});
  });
  it('caps a claim at fifty while still scanning later pages for earlier requests', async () => {
    const {repo,tx,rows} = pagedQueue();
    const result = await repo.claimDueExtensionPublishPosts('org',[],now,500,'lease',now,[],tx as any);
    expect(result).toHaveLength(50);
    expect(result[0].id).toBe(rows[204].id);
    expect(result[49].id).toBe(rows[155].id);
    expect(tx.post.updateMany).toHaveBeenCalledTimes(50);
  });
});
