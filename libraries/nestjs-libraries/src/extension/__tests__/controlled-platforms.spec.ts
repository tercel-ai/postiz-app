import { afterEach, describe, expect, it, vi } from 'vitest';
import { stableSocialIdentity } from '../social-account-identity.service';
import { setupSend, sendNow } from './support/send-fixture';
import { controlledReplySettings, hasControlledReplyTarget } from '../controlled-platforms';

const identities = [
  ['linkedin', 'linkedin.fs_miniProfile', 'ACoAAaBc_123'],
  ['medium', 'medium.handle', 'alice'],
  ['quora', 'quora.user_id', '1923931969'],
  ['hackernews', 'hackernews.handle', 'Alice_1'],
  ['devto', 'devto.user_id', '12345'],
] as const;
afterEach(() => vi.unstubAllEnvs());

describe('controlled platform coverage', () => {
  it('preserves the existing X and Reddit reply contract', () => {
    expect(controlledReplySettings('x', '1', 'unused')).toEqual({ reply_to_tweet_id: '1' });
    expect(controlledReplySettings('reddit', 't3_1')).toEqual({ replyToId: 't3_1' });
    expect(controlledReplySettings('unsupported', '1')).toBeNull();
    expect(hasControlledReplyTarget('x', { reply_to_tweet_id: '1' })).toBe(true);
    expect(hasControlledReplyTarget('reddit', { replyToId: 't3_1' })).toBe(true);
    expect(hasControlledReplyTarget('x', {})).toBe(false);
    expect(hasControlledReplyTarget('reddit', {})).toBe(false);
  });
  it.each([
    ['linkedin', 'https://www.linkedin.com/feed/update/urn:li:activity:1'],
    ['medium', 'https://medium.com/@alice/story-abcdef123456'],
    ['quora', 'https://www.quora.com/question/answer/Alice'],
    ['hackernews', 'https://news.ycombinator.com/item?id=1'],
    ['devto', 'https://dev.to/alice/article'],
  ])('freezes the actual %s reply URL instead of guessing from an opaque ID', (platform, replyUrl) => {
    expect(controlledReplySettings(platform, '1', replyUrl)).toEqual({ replyToId: '1', replyUrl });
    expect(hasControlledReplyTarget(platform, { replyUrl })).toBe(true);
    expect(hasControlledReplyTarget(platform, { replyToId: '1' })).toBe(false);
    expect(hasControlledReplyTarget(platform, { replyUrl: 'https://evil.test/post' })).toBe(false);
  });
  it.each(['invalid', 'http://dev.to/alice/article', 'https://user:pass@dev.to/alice/article', 'https://dev.to:444/alice/article', 'https://dev.to/'])('rejects an invalid controlled reply destination: %s', replyUrl => {
    expect(hasControlledReplyTarget('devto', { replyUrl })).toBe(false);
    expect(hasControlledReplyTarget('unsupported', { replyUrl })).toBe(false);
  });
  it.each(identities)('accepts the explicit browser actor namespace for %s', (platform, namespace, id) => {
    expect(stableSocialIdentity(platform, namespace, id)).toEqual({ platform, namespace, id });
    expect(stableSocialIdentity(platform, 'legacy', id)).toBeNull();
    expect(stableSocialIdentity('x', namespace, id)).toBeNull();
    expect(stableSocialIdentity(platform, namespace, 'bad/id')).toBeNull();
  });
  it('preserves opaque LinkedIn IDs and case-sensitive HN usernames', () => {
    expect(stableSocialIdentity('linkedin', 'linkedin.fs_miniProfile', 'ACoAAaBc')?.id).toBe('ACoAAaBc');
    expect(stableSocialIdentity('hackernews', 'hackernews.handle', 'Alice')?.id).not.toBe(
      stableSocialIdentity('hackernews', 'hackernews.handle', 'alice')?.id
    );
  });
  it.each(identities)('enqueues %s without falling back to legacy execution', async (platform, namespace, id) => {
    vi.stubEnv('ACCOUNT_BOUND_SENDING_ENABLED', 'true');
    const f = setupSend();
    await f.create();
    f.db.seed('post', {
      ...f.db.rows('post')[0], id: 'new-root', group: 'new-root',
      providerIdentifier: platform, state: 'DRAFT', sendIntentId: null,
      contentUnitId: null, executionProtocol: null, releaseId: null,
    });
    f.bindings.resolveForEnqueueInTransaction.mockResolvedValueOnce({
      integrationId: 'account', providerIdentifier: platform, bindingSource: 'EXPLICIT',
      bindingRevision: null, canonicalAccountKey: 'account-key',
      targetAccount: { id, idNamespace: namespace, handle: 'alice' },
    });
    const result = await f.service.enqueue('org', 'new-root', { userId: 'user', origin: 'MANUAL', now: sendNow });
    expect(result).toMatchObject({ executionProtocol: 'ACCOUNT_BOUND_V1', publishMethod: 'EXTENSION' });
    expect(f.db.rows('sendIntent').find((intent) => intent.rootPostId === 'new-root')?.platform).toBe(platform);
  });
});
