import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PostsRepository } from '../posts.repository';
import { PostsService } from '../posts.service';
import { SendModeService } from '../../../../extension/send-mode.service';
import { memorySendDatabase } from '../../../../extension/__tests__/support/memory-send-database';
import { ProjectInactiveException } from '../../../../projects/project.exception';

beforeEach(() => vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'true'));
afterEach(() => vi.unstubAllEnvs());
function fixture() {
  const db = memorySendDatabase();
  db.seed('settings', {
    key: 'sending.organization_mode:org',
    value: { mode: 'CONTROLLED', revision: 2 },
  });
  db.seed('userOrganization', {
    organizationId: 'org',
    userId: 'user',
    disabled: false,
  });
  db.seed('post', {
    id: 'root',
    organizationId: 'org',
    projectId: 'project',
    parentPostId: null,
    group: 'group',
    state: 'QUEUE',
    providerIdentifier: 'x',
    integrationId: 'account',
    content: '<p>Preserved content</p>',
    settings: '{"__type":"x"}',
    image: '[]',
    publishDate: new Date('2026-12-15T10:00:00Z'),
    executionProtocol: null,
    releaseId: null,
    releaseURL: null,
    claimedAt: null,
    intervalInDays: 5,
    source: 'calendar',
  });
  const modes = new SendModeService(db);
  const repo = new PostsRepository(
    { model: db } as any,
    {} as any,
    {} as any,
    { model: db } as any,
    { model: db } as any,
    {} as any,
    { model: db } as any,
    modes
  );
  const projects = {
    assertProjectAccess: vi.fn(),
    assertProjectActive: vi
      .fn()
      .mockRejectedValue(new ProjectInactiveException()),
  };
  const overage = {
    assertDraftQuota: vi.fn(),
    deductIfOverage: vi.fn().mockResolvedValue(undefined),
  };
  const service = new PostsService(
    repo,
    {} as any,
    {} as any,
    {} as any,
    { convertTextToShortLinks: vi.fn() } as any,
    {} as any,
    {} as any,
    {} as any,
    overage as any,
    {} as any,
    projects as any
  );
  const body = () =>
    ({
      type: 'draft',
      projectId: 'project',
      date: '2026-12-15T10:00:00Z',
      shortLink: false,
      tags: [],
      inter: 5,
      posts: [
        {
          group: 'group',
          integration: { id: 'account' },
          providerIdentifier: 'x',
          settings: { __type: 'x' },
          value: [
            { id: 'root', content: '<p>Preserved content</p>', image: [] },
          ],
        },
      ],
    } as any);
  return { db, modes, repo, service, projects, body };
}
it('withdraws an inactive project schedule through the original draft save without changing its content, account or date', async () => {
  const { db, service, body } = fixture();
  expect(await service.createPost('org', body(), 'user')).toEqual([
    { postId: 'root', integration: 'account' },
  ]);
  expect(db.rows('post')[0]).toMatchObject({
    id: 'root',
    state: 'DRAFT',
    content: '<p>Preserved content</p>',
    integrationId: 'account',
    projectId: 'project',
    group: 'group',
    publishDate: new Date('2026-12-15T10:00:00Z'),
    intervalInDays: null,
  });
  expect(db.rows('sendIntent')).toEqual([]);
  expect(db.rows('sendExecution')).toEqual([]);
  await service.createPost('org', body(), 'user');
  expect(db.rows('post')).toHaveLength(1);
  expect(db.rows('post')[0].state).toBe('DRAFT');
});
it('saves requested draft edits and a whole thread while preserving independent sibling roots', async () => {
  const { db, service, body } = fixture();
  db.seed('post', {
    ...db.rows('post')[0],
    id: 'child',
    parentPostId: 'root',
    content: 'Second',
  });
  db.seed('post', {
    ...db.rows('post')[0],
    id: 'sibling',
    parentPostId: null,
    content: 'Unrelated',
  });
  const request = body();
  request.posts[0].value.push({
    id: 'child',
    content: 'Edited second',
    image: [],
  });
  await service.createPost('org', request, 'user');
  expect(db.rows('post').map((p) => [p.id, p.state, p.content])).toEqual([
    ['root', 'DRAFT', '<p>Preserved content</p>'],
    ['child', 'DRAFT', 'Edited second'],
    ['sibling', 'QUEUE', 'Unrelated'],
  ]);
});
it.each([
  { releaseId: 'lease' },
  { releaseURL: 'https://x.com/post' },
  { claimedAt: new Date() },
  { sendIntentId: 'intent' },
  { executionProtocol: 'ACCOUNT_BOUND_V1' },
  { executionProtocol: 'UNKNOWN' },
  { state: 'PUBLISHED' },
  { state: 'ERROR' },
  { deletedAt: new Date() },
])(
  'protects submitted or unavailable content on the existing draft path: %j',
  async (change) => {
    const { db, repo, body } = fixture();
    Object.assign(db.rows('post')[0], change);
    const before = structuredClone(db.rows('post'));
    const request = body();
    await expect(
      repo.createOrUpdatePost(
        'draft',
        'org',
        request.date,
        request.posts[0],
        [],
        undefined,
        undefined,
        'project',
        undefined,
        undefined,
        undefined,
        { userId: 'user', existingOnly: true }
      )
    ).rejects.toThrow();
    expect(db.rows('post')).toEqual(before);
  }
);
it('rejects incomplete threads before any draft write', async () => {
  const { db, service, body } = fixture();
  db.seed('post', { ...db.rows('post')[0], id: 'child', parentPostId: 'root' });
  const before = structuredClone(db.rows('post'));
  await expect(service.createPost('org', body(), 'user')).rejects.toThrow();
  expect(db.rows('post')).toEqual(before);
});
it.each(['new-root', 'new-segment'])(
  'does not create %s while a project is inactive',
  async (scenario) => {
    const { db, service, body } = fixture();
    const request = body();
    if (scenario === 'new-root') delete request.posts[0].value[0].id;
    else
      request.posts[0].value.push({
        id: 'new',
        content: 'New work',
        image: [],
      });
    const before = structuredClone(db.rows('post'));
    await expect(service.createPost('org', request, 'user')).rejects.toThrow();
    expect(db.rows('post')).toEqual(before);
  }
);
it.each(['now', 'schedule'])(
  'still requires activation for %s',
  async (type) => {
    const { db, service, body, projects } = fixture();
    const request = body();
    request.type = type;
    await expect(
      service.createPost('org', request, 'user')
    ).rejects.toBeInstanceOf(ProjectInactiveException);
    expect(projects.assertProjectActive).toHaveBeenCalled();
    expect(db.rows('post')[0].state).toBe('QUEUE');
  }
);
it.each(['', 'stranger'])(
  'requires an active member for withdrawal: %s',
  async (user) => {
    const { db, service, body } = fixture();
    const before = structuredClone(db.rows('post'));
    await expect(service.createPost('org', body(), user)).rejects.toThrow();
    expect(db.rows('post')).toEqual(before);
  }
);
it('protects quarantined legacy work even without visible claim markers', async () => {
  const { db, modes, service, body } = fixture();
  vi.spyOn(modes, 'activeLegacyPostIdsIn').mockResolvedValue(['root']);
  await expect(service.createPost('org', body(), 'user')).rejects.toThrow();
  expect(db.rows('post')[0].state).toBe('QUEUE');
});
it('rolls back the entire thread if a child is claimed during the guarded write', async () => {
  const { db, service, body } = fixture();
  db.seed('post', { ...db.rows('post')[0], id: 'child', parentPostId: 'root' });
  const request = body();
  request.posts[0].value.push({ id: 'child', content: 'Second', image: [] });
  const before = structuredClone(db.rows('post'));
  const delegate = db.post;
  db.post = {
    ...delegate,
    upsert: async (args) => {
      if (args.where.id === 'child')
        throw Object.assign(new Error('claim conflict'), { code: 'P2002' });
      return delegate.upsert(args);
    },
  };
  await expect(service.createPost('org', request, 'user')).rejects.toThrow();
  expect(db.rows('post')).toEqual(before);
});

it.each([
  'disabled-member',
  'foreign-organization',
  'different-project',
  'different-group',
  'partial-submission',
  'branched-thread',
])('rejects unsafe withdrawal boundaries: %s', async (scenario) => {
  const { db, service, body } = fixture();
  const request = body();
  if (scenario === 'disabled-member')
    db.rows('userOrganization')[0].disabled = true;
  if (scenario === 'foreign-organization')
    db.rows('post')[0].organizationId = 'foreign';
  if (scenario === 'different-project') request.projectId = 'other-project';
  if (scenario === 'different-group') request.posts[0].group = 'other-group';
  if (scenario === 'partial-submission' || scenario === 'branched-thread') {
    db.seed('post', {
      ...db.rows('post')[0],
      id: 'child',
      parentPostId: 'root',
      ...(scenario === 'partial-submission' ? { releaseId: 'lease' } : {}),
    });
    request.posts[0].value.push({ id: 'child', content: 'Second', image: [] });
  }
  if (scenario === 'branched-thread')
    db.seed('post', {
      ...db.rows('post')[0],
      id: 'fork',
      parentPostId: 'root',
    });
  const before = structuredClone(db.rows('post'));
  await expect(service.createPost('org', request, 'user')).rejects.toThrow();
  expect(db.rows('post')).toEqual(before);
});
it('propagates project-validation outages and ownership failures instead of allowing an inactive draft bypass', async () => {
  const { service, projects, db, body } = fixture();
  const error = new Error('Project validation unavailable');
  projects.assertProjectActive.mockRejectedValue(error);
  await expect(service.createPost('org', body(), 'user')).rejects.toBe(error);
  expect(db.rows('post')[0].state).toBe('QUEUE');
  projects.assertProjectActive.mockRejectedValue(
    new ProjectInactiveException()
  );
  projects.assertProjectAccess.mockRejectedValue(error);
  await expect(service.createPost('org', body(), 'user')).rejects.toBe(error);
  expect(db.rows('post')[0].state).toBe('QUEUE');
});
it('keeps ordinary active-project draft creation available', async () => {
  const { service, projects, db, body } = fixture();
  projects.assertProjectActive.mockResolvedValue(undefined);
  const request = body();
  request.posts[0].value[0].id = 'fresh-root';
  request.posts[0].group = 'fresh-group';
  const result = await service.createPost('org', request, 'user');
  expect(projects.assertProjectActive).toHaveBeenCalledWith('org', 'project');
  expect(result).toEqual([{ postId: 'fresh-root', integration: 'account' }]);
  expect(db.rows('post').find((post) => post.id === 'fresh-root').state).toBe(
    'DRAFT'
  );
});

it('withdraws an inherited accountless schedule without clearing or advancing its route', async () => {
  const { db, service, body } = fixture();
  Object.assign(db.rows('post')[0], {
    integrationId: null,
    accountSelectionMode: 'INHERIT',
    routeRevision: 3,
  });
  const request = body();
  delete request.posts[0].integration;
  request.posts[0].accountSelectionMode = 'INHERIT';
  request.posts[0].expectedRouteRevision = 3;
  expect(await service.createPost('org', request, 'user')).toEqual([
    { postId: 'root', integration: null },
  ]);
  expect(db.rows('post')[0]).toMatchObject({
    state: 'DRAFT',
    integrationId: null,
    accountSelectionMode: 'INHERIT',
    routeRevision: 3,
  });
  await service.createPost('org', structuredClone(request), 'user');
  expect(db.rows('post')[0].routeRevision).toBe(3);
});
it('replays active-project withdrawal without restoring recurrence or deleting an independent sibling', async () => {
  const { db, service, body, projects } = fixture();
  projects.assertProjectActive.mockResolvedValue(undefined);
  db.seed('post', {
    ...db.rows('post')[0],
    id: 'sibling',
    parentPostId: null,
    content: 'Independent sibling',
  });
  const request = body();
  request.requestId = 'withdraw-request';
  await service.createPost('org', structuredClone(request), 'user');
  const before = structuredClone(db.rows('post'));
  await service.createPost('org', structuredClone(request), 'user');
  expect(db.rows('post')).toEqual(before);
  expect(
    db.rows('post').find((post) => post.id === 'root').intervalInDays
  ).toBeNull();
  expect(
    db.rows('post').find((post) => post.id === 'sibling').deletedAt
  ).toBeNull();
});

it.each(['changed-payload', 'newer-edit', 'changed-route', 'rescheduled'])(
  'rejects a stale withdrawal replay: %s',
  async (scenario) => {
    const { db, service, body, projects } = fixture();
    projects.assertProjectActive.mockResolvedValue(undefined);
    const request = body();
    request.requestId = 'withdraw-request';
    await service.createPost('org', structuredClone(request), 'user');
    if (scenario === 'changed-payload')
      request.posts[0].value[0].content = 'Changed request';
    if (scenario === 'newer-edit') {
      db.rows('post')[0].content = 'Newer edit';
      db.rows('post')[0].contentRevision += 1;
    }
    if (scenario === 'changed-route') db.rows('post')[0].routeRevision += 1;
    if (scenario === 'rescheduled') db.rows('post')[0].state = 'QUEUE';
    const before = structuredClone(db.rows('post'));
    await expect(service.createPost('org', request, 'user')).rejects.toThrow();
    expect(db.rows('post')).toEqual(before);
  }
);
it('rejects using withdrawal as an account-clear mutation on a bound schedule', async () => {
  const { db, service, body } = fixture();
  const request = body();
  delete request.posts[0].integration;
  request.posts[0].accountSelectionMode = 'INHERIT';
  request.posts[0].expectedRouteRevision = 0;
  await expect(service.createPost('org', request, 'user')).rejects.toThrow(
    'SEND_DRAFT_ROUTE_CHANGED'
  );
  expect(db.rows('post')[0]).toMatchObject({
    state: 'QUEUE',
    integrationId: 'account',
  });
});

it.each(['user', 'other-member'])(
  'replays the same withdrawal from another dialog as %s without restoring recurrence or deleting siblings',
  async (actor) => {
    const { db, service, body, projects } = fixture();
    projects.assertProjectActive.mockResolvedValue(undefined);
    db.seed('userOrganization', {
      organizationId: 'org',
      userId: 'other-member',
      disabled: false,
    });
    db.seed('post', {
      ...db.rows('post')[0],
      id: 'sibling',
      parentPostId: null,
      content: 'Independent sibling',
    });
    const request = body();
    request.requestId = 'dialog-one';
    await service.createPost('org', structuredClone(request), 'user');
    const before = structuredClone(db.rows('post'));
    request.requestId = 'dialog-two';
    await service.createPost('org', request, actor);
    expect(db.rows('post')).toEqual(before);
  }
);


it.each(['now','schedule','draft'] as const)('fully edits an unclaimed autonomous original as %s with the existing field mapper',async state=>{
 const f=fixture();f.db.rows('settings')[0].value={mode:'AUTONOMOUS',revision:2};
 const request=f.body();Object.assign(request.posts[0],{expectedRouteRevision:0,expectedContentRevision:1});
 request.posts[0].value[0].content='Edited original';request.posts[0].settings={__type:'x',quote_tweet_url:'https://x.com/alice/status/2'};
 const input={state,date:request.date,body:request.posts[0],tags:[],inter:0,projectId:'project',publishMethod:'EXTENSION' as const,userId:'user',requestId:'full-edit'};
 const result=await f.repo.editAutonomousQueuedPost('org',input);
 expect(result.posts[0]).toMatchObject({id:'root',content:'Edited original',state:state==='draft'?'DRAFT':'QUEUE',contentRevision:2,routeRevision:1,intervalInDays:null});
 expect(JSON.parse(result.posts[0].settings).quote_tweet_url).toBe('https://x.com/alice/status/2');
 await f.repo.editAutonomousQueuedPost('org',input);
 expect(f.db.rows('post')[0].contentRevision).toBe(2);expect(f.db.rows('sendIntent')).toHaveLength(0);
});
it('edits a version-zero autonomous original once and rejects a stale version-zero request', async () => {
  const f = fixture();
  f.db.rows('settings')[0].value = { mode: 'AUTONOMOUS', revision: 2 };
  Object.assign(f.db.rows('post')[0], { routeRevision: 0, contentRevision: 0 });
  const request = f.body();
  Object.assign(request.posts[0], { expectedRouteRevision: 0, expectedContentRevision: 0 });
  request.posts[0].value[0].content = 'Edited initial original';
  const input = { state: 'now' as const, date: request.date, body: request.posts[0], tags: [],
    inter: 0, projectId: 'project', userId: 'user', requestId: 'initial-edit' };
  const saved = await f.repo.editAutonomousQueuedPost('org', input);
  expect(saved.posts[0]).toMatchObject({ id: 'root', contentRevision: 1, routeRevision: 1, content: 'Edited initial original' });
  expect((await f.repo.editAutonomousQueuedPost('org', input)).posts[0].contentRevision).toBe(1);
  const before = structuredClone(f.db.rows('post'));
  await expect(f.repo.editAutonomousQueuedPost('org', { ...input, requestId: 'stale-initial-edit' }))
    .rejects.toThrow('SEND_CONTENT_REVISION_CONFLICT');
  expect(f.db.rows('post')).toEqual(before);
});
it.each([{claimedAt:new Date()},{releaseId:'captured'},{releaseURL:'https://x.com/live'},{sendIntentId:'intent'},{state:'PUBLISHED'}])('refuses unsafe autonomous full edits: %j',async change=>{
 const f=fixture();f.db.rows('settings')[0].value={mode:'AUTONOMOUS',revision:2};Object.assign(f.db.rows('post')[0],change);
 const before=structuredClone(f.db.rows('post'));const request=f.body();Object.assign(request.posts[0],{expectedRouteRevision:0,expectedContentRevision:1});
 await expect(f.repo.editAutonomousQueuedPost('org',{state:'now',date:request.date,body:request.posts[0],tags:[],projectId:'project',userId:'user',requestId:'unsafe'})).rejects.toThrow();
 expect(f.db.rows('post')).toEqual(before);
});

it('edits autonomous thread membership without deleting another root and rejects stale writes',async()=>{
 const f=fixture();f.db.rows('settings')[0].value={mode:'AUTONOMOUS',revision:2};
 f.db.seed('post',{...f.db.rows('post')[0],id:'old-child',parentPostId:'root'});f.db.seed('post',{...f.db.rows('post')[0],id:'sibling',parentPostId:null});
 const request=f.body();Object.assign(request.posts[0],{expectedRouteRevision:0,expectedContentRevision:1});request.posts[0].value.push({id:'new-child',content:'New segment',image:[]});
 const input={state:'schedule' as const,date:request.date,body:request.posts[0],tags:[],projectId:'project',userId:'user',requestId:'thread-edit'};
 await f.repo.editAutonomousQueuedPost('org',input);
 expect(f.db.rows('post').find(p=>p.id==='old-child').deletedAt).toBeTruthy();expect(f.db.rows('post').find(p=>p.id==='old-child').content).toBe('<p>Preserved content</p>');
 expect(f.db.rows('post').find(p=>p.id==='sibling')).toMatchObject({state:'QUEUE',contentRevision:1,deletedAt:null});
 expect(f.db.rows('post').find(p=>p.id==='new-child')).toMatchObject({parentPostId:'root',content:'New segment',contentRevision:2,routeRevision:1});
 await expect(f.repo.editAutonomousQueuedPost('org',{...input,requestId:'stale'})).rejects.toThrow('SEND_CONTENT_REVISION_CONFLICT');
});
it.each(['AUTHORIZED','UNKNOWN','CONFIRMED'])('an autonomous %s receipt keeps its original content immutable',async status=>{
 const f=fixture();f.db.rows('settings')[0].value={mode:'AUTONOMOUS',revision:2};
 f.db.seed('sendMutationReceipt',{organizationId:'org',operation:'autonomous-side-effect',result:{postIds:['root'],status}});
 const request=f.body();Object.assign(request.posts[0],{expectedRouteRevision:0,expectedContentRevision:1});const before=structuredClone(f.db.rows('post'));
 await expect(f.repo.editAutonomousQueuedPost('org',{state:'now',date:request.date,body:request.posts[0],tags:[],projectId:'project',userId:'user',requestId:'held'})).rejects.toThrow();
 expect(f.db.rows('post')).toEqual(before);
});

it('replays the raw autonomous editor request before repeating nondeterministic short-link conversion',async()=>{
 const f=fixture();f.db.rows('settings')[0].value={mode:'AUTONOMOUS',revision:2};const request=f.body();
 Object.assign(request.posts[0],{expectedRouteRevision:0,expectedContentRevision:1});request.posts[0].value[0].content='https://example.test/original';
 const prepare=vi.fn(async body=>({...body,value:body.value.map(value=>({...value,content:`https://short.test/${prepare.mock.calls.length}`}))}));
 const input={state:'draft' as const,date:request.date,body:request.posts[0],tags:[],projectId:'project',userId:'user',requestId:'lost-shortlink'};
 const first=await (f.repo.editAutonomousQueuedPost as any)('org',input,prepare);
 const replay=await (f.repo.editAutonomousQueuedPost as any)('org',structuredClone(input),prepare);
 expect(prepare).toHaveBeenCalledTimes(1);expect(first.posts[0].content).toBe('https://short.test/1');expect(replay.posts[0].content).toBe(first.posts[0].content);
 expect(f.db.rows('post')[0].contentRevision).toBe(2);
 await expect((f.repo.editAutonomousQueuedPost as any)('org',{...input,shortLink:true},prepare)).rejects.toThrow('SEND_IDEMPOTENCY_CONFLICT');
});
