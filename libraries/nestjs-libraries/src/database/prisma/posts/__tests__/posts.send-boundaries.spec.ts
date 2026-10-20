import { afterEach, expect, it, vi } from 'vitest';
import { PostsService } from '../posts.service';
import { PostsRepository } from '../posts.repository';
import { memorySendDatabase } from '../../../../extension/__tests__/support/memory-send-database';

afterEach(() => vi.unstubAllEnvs());

it('rejects legacy removal for managed posts without touching stored facts', async () => {
  const repository = { getPostById: vi.fn(async () => ({
    id: 'root', sendIntentId: 'intent', executionProtocol: 'ACCOUNT_BOUND_V1', state: 'PUBLISHED',
  })), markPostRemoved: vi.fn() };
  const service = new PostsService(repository as any, {} as any, {} as any, {} as any, {} as any,
    {} as any, {} as any, {} as any, {} as any, {} as any);
  expect(await service.markExtensionPostRemoved('org', 'root', 'gone', 'https://x.com/other/status/999'))
    .toEqual({ ok: false, reason: 'account-bound-protocol-required' });
  expect(repository.markPostRemoved).not.toHaveBeenCalled();
});

it('advertises extension-only controlled routes, including company actors and unsupported providers', async () => {
  vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'true');
  const context = {
    isControlled: vi.fn().mockResolvedValue(true),
    _integrationService: { getIntegrationsList: vi.fn(async () => [{ providerIdentifier: 'x' }]) },
    _integrationManager: { getSocialProviderList: () => ['x', 'linkedin-page', 'mastodon'].map(identifier => ({ identifier })) },
  };
  const result = await PostsService.prototype.getPublishMethods.call(context, 'org');
  expect(result[0]).toMatchObject({ apiCapable: false, methods: ['extension'], defaultMethod: 'extension' });
  expect(result[1]).toMatchObject({ apiCapable: false, methods: ['extension'] });
  expect(result[2]).toMatchObject({ apiCapable: false, methods: [], defaultMethod: null, reason: 'CONTROLLED_PLATFORM_UNSUPPORTED' });
});

function drafts() {
  const db = memorySendDatabase();
  db.seed('post', { id: 'root', organizationId: 'org', state: 'DRAFT', integrationId: 'old',
    accountSelectionMode: 'EXPLICIT', routeRevision: 2, executionProtocol: 'LEGACY' });
  db.seed('post', { ...db.rows('post')[0], id: 'child', parentPostId: 'root' });
  const repository = new PostsRepository({ model: db } as any, {} as any, {} as any,
    { model: db } as any, { model: db } as any, {} as any, { model: db } as any);
  const body = { providerIdentifier: 'x', settings: { __type: 'x' }, accountSelectionMode: 'INHERIT',
    expectedRouteRevision: 2, value: [{ id: 'root', content: 'one', image: [] }, { id: 'child', content: 'two', image: [] }] };
  const save = () => repository.createOrUpdatePost('draft', 'org', new Date().toISOString(), body as any, []);
  return { db, repository, body, save };
}

it('clears the whole draft chain atomically with route CAS and preserves the existing content IDs', async () => {
  const f = drafts();
  await f.save();
  expect(f.db.rows('post').map(p => p.id)).toEqual(['root', 'child']);
  for (const row of f.db.rows('post')) {
    expect(row).toMatchObject({ accountSelectionMode: 'INHERIT', routeRevision: 3, integrationId: null });
  }
  await expect(f.save()).rejects.toThrow('SEND_DRAFT_ROUTE_CHANGED');
});

it.each(['QUEUE', 'SENDING', 'UNKNOWN', 'PUBLISHED'])('does not clear a managed or started selection: %s', async state => {
  const f = drafts(); f.db.rows('post')[1].state = state;
  f.db.rows('post')[1].sendIntentId = 'intent';
  await expect(f.save()).rejects.toThrow('SEND_DRAFT_ROUTE_CHANGED');
  expect(f.db.rows('post')[0]).toMatchObject({ accountSelectionMode: 'EXPLICIT', routeRevision: 2 });
});

it('requires a revision to clear an existing selection and rejects contradictory input', async () => {
  const f = drafts(); delete (f.body as any).expectedRouteRevision;
  await expect(f.save()).rejects.toThrow('SEND_ROUTE_REVISION_REQUIRED');
  (f.body as any).integration = { id: 'old' };
  await expect(f.save()).rejects.toThrow('SEND_ACCOUNT_SELECTION_CONFLICT');
});

it('returns the saved selection and route revision in the editable HTTP payload', () => {
  const service = Object.create(PostsService.prototype);
  const payload = service.buildEditablePayload([{
    id: 'root', state: 'DRAFT', publishDate: new Date(), integrationId: 'old',
    accountSelectionMode: 'EXPLICIT', routeRevision: 2, content: 'body', image: [],
  }], { __type: 'x' });
  expect(payload.posts[0]).toMatchObject({
    integration: { id: 'old' }, accountSelectionMode: 'EXPLICIT', expectedRouteRevision: 2,
  });
});

it('cannot rebuild managed content through a legacy upsert using a new generated Post ID', async () => {
  const f = drafts(); f.db.rows('post')[0].sendIntentId = 'existing-intent';
  f.db.rows('post')[0].executionProtocol = 'ACCOUNT_BOUND_V1';
  delete (f.body as any).accountSelectionMode;
  await expect(f.save()).rejects.toMatchObject({ code: 'P2002' });
  expect(f.db.rows('post')).toHaveLength(2);
  expect(f.db.rows('post')[0]).toMatchObject({ id: 'root', sendIntentId: 'existing-intent' });
});
