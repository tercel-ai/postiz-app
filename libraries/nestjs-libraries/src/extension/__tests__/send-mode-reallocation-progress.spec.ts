import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SendModeService } from '../send-mode.service';
import { memorySendDatabase } from './support/memory-send-database';

beforeEach(() => vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'true'));
afterEach(() => vi.unstubAllEnvs());
it('counts every blocked queued root while bounding public issue details and removing settled entries', async () => {
  const db = memorySendDatabase();
  db.seed('userOrganization', { organizationId: 'org', userId: 'admin', role: 'ADMIN', disabled: false });
  for (let i = 0; i < 105; i++) db.seed('post', { id: `post-${i}`, organizationId: 'org', state: 'QUEUE',
    parentPostId: null, publishDate: new Date('2026-12-15T10:00:00Z') });
  const modes = new SendModeService(db);
  await modes.save('org', 'admin', { expectedOrganizationId: 'org', expectedUserId: 'admin', mode: 'CONTROLLED',
    expectedRevision: 0, requestId: 'switch' });
  await modes.recordReallocationIssues('org', db.rows('post').map(post => ({ postId: post.id, code: 'SEND_PROJECT_REQUIRED' })));
  let state = await modes.get('org', 'admin');
  expect(state.reallocation).toMatchObject({ remainingCount: 105, blockedCount: 105 });
  expect(state.reallocation!.issues).toHaveLength(100);
  db.rows('post')[104].sendIntentId = 'allocated';
  state = await modes.get('org', 'admin');
  expect(state.reallocation).toMatchObject({ remainingCount: 104, blockedCount: 104 });
});
it('counts all queued segments of a blocked thread and preserves old markers without blocked IDs', async () => {
  const db = memorySendDatabase();
  db.seed('userOrganization', { organizationId: 'org', userId: 'admin', role: 'ADMIN', disabled: false });
  db.seed('post', { id: 'root', organizationId: 'org', state: 'QUEUE', parentPostId: null });
  db.seed('post', { id: 'child', organizationId: 'org', state: 'QUEUE', parentPostId: 'root' });
  const modes = new SendModeService(db);
  await modes.save('org', 'admin', { expectedOrganizationId: 'org', expectedUserId: 'admin', mode: 'CONTROLLED',
    expectedRevision: 0, requestId: 'switch' });
  await modes.recordReallocationIssues('org', [{ postId: 'root', code: 'SEND_BINDING_REQUIRED' }]);
  expect((await modes.get('org', 'admin')).reallocation).toMatchObject({ remainingCount: 2, blockedCount: 2,
    issues: [{ postId: 'root', code: 'SEND_BINDING_REQUIRED' }] });
  const setting = db.rows('settings').find(row => row.value?.reallocation);
  delete setting.value.reallocation.blockedPostIds;
  expect((await modes.get('org', 'admin')).reallocation).toMatchObject({ remainingCount: 2, blockedCount: 2 });
});
