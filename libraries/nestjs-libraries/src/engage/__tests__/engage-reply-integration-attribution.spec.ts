/**
 * An engage reply drafted for the extension is created with NO integration
 * (upsertDraft writes content + platform only), and the extension then posts it
 * as the browser's own session. Without a fill, every such reply stayed
 * unattributed forever: the Sent card could not name the account that replied
 * and metrics sync had no account to read with.
 *
 * These tests pin how updateReplyUrl fills it — and, just as importantly, when
 * it refuses to.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EngageRepository } from '../engage.repository';

const FRESH = new Date(Date.now() - 10 * 60 * 1000);
const STALE = new Date(Date.now() - 6 * 60 * 60 * 1000);

function buildRepo(opts: {
  platform: string;
  postIntegrationId?: string | null;
  integrations?: any[];
}) {
  const sentFindFirst = vi.fn().mockResolvedValue({
    id: 'reply-1',
    postId: 'post-1',
    opportunity: { platform: opts.platform },
  });
  const postFindUnique = vi.fn().mockResolvedValue({
    integrationId: opts.postIntegrationId ?? null,
    settings: JSON.stringify({ __type: opts.platform }),
  });
  const postUpdate = vi.fn().mockResolvedValue({ id: 'post-1' });
  const integrationFindMany = vi.fn().mockResolvedValue(opts.integrations ?? []);

  const sentReply = {
    model: { engageSentReply: { findFirst: sentFindFirst } },
  } as any;
  const post = {
    model: { post: { findUnique: postFindUnique, update: postUpdate } },
  } as any;
  const integration = {
    model: { integration: { findMany: integrationFindMany } },
  } as any;

  const repo = new EngageRepository(
    {} as any, // _config
    {} as any, // _keyword
    {} as any, // _trackedAccount
    {} as any, // _opportunity
    {} as any, // _oppState
    sentReply,
    integration,
    {} as any, // _integrationProject
    post,
    {} as any, // _tx
    {} as any // _scanCursor
  );
  return { repo, postUpdate, integrationFindMany };
}

/** An org's integration row as the attribution read selects it. */
function row(
  id: string,
  internalId: string,
  profile: string | null,
  activeSessionClient: string,
  extensionSessionCheckedAt: Date | null
) {
  return {
    id,
    internalId,
    profile,
    activeSessionClient,
    extensionSessionCheckedAt,
  };
}

describe('updateReplyUrl — extension publish attributes the replying account', () => {
  beforeEach(() => vi.clearAllMocks());

  it('stamps the browser-session account on a Reddit reply the extension published', async () => {
    const { repo, postUpdate, integrationFindMany } = buildRepo({
      platform: 'reddit',
      integrations: [
        row('int_other', 'zzz', 'u/other', 'API', FRESH),
        row('int_live', 'abc123', 'u/live', 'EXTENSION', FRESH),
      ],
    });

    await repo.updateReplyUrl(
      'org-1',
      'reply-1',
      'https://www.reddit.com/r/n8n/comments/1abc/x/def/',
      undefined,
      { markPublished: true }
    );

    expect(integrationFindMany.mock.calls[0][0].where).toMatchObject({
      organizationId: 'org-1',
      providerIdentifier: 'reddit',
      deletedAt: null,
    });
    expect(postUpdate.mock.calls[0][0].data).toMatchObject({
      integrationId: 'int_live',
      state: 'PUBLISHED',
    });
  });

  it('prefers the author the extension actually captured over the session reading', async () => {
    const { repo, postUpdate } = buildRepo({
      platform: 'linkedin',
      integrations: [
        row('int_a', '111', 'alpha', 'API', FRESH),
        row('int_b', '222', 'beta', 'EXTENSION', FRESH),
      ],
    });

    await repo.updateReplyUrl(
      'org-1',
      'reply-1',
      'https://www.linkedin.com/feed/update/urn:li:activity:1/',
      { handle: 'alpha' },
      { markPublished: true }
    );

    expect(postUpdate.mock.calls[0][0].data.integrationId).toBe('int_a');
  });

  it('leaves a reply unattributed when the session reading has gone stale', async () => {
    const { repo, postUpdate } = buildRepo({
      platform: 'devto',
      integrations: [row('int_live', 'abc', 'live', 'EXTENSION', STALE)],
    });

    await repo.updateReplyUrl(
      'org-1',
      'reply-1',
      'https://dev.to/u/p/comment/1',
      undefined,
      { markPublished: true }
    );

    // The commit still lands — only the account is missing.
    expect(postUpdate.mock.calls[0][0].data).toMatchObject({ state: 'PUBLISHED' });
    expect(postUpdate.mock.calls[0][0].data.integrationId).toBeUndefined();
  });

  it('never overrides the account already on the reply', async () => {
    const { repo, postUpdate, integrationFindMany } = buildRepo({
      platform: 'reddit',
      postIntegrationId: 'int_chosen',
      integrations: [row('int_live', 'abc', 'u/live', 'EXTENSION', FRESH)],
    });

    await repo.updateReplyUrl(
      'org-1',
      'reply-1',
      'https://www.reddit.com/r/n8n/comments/1abc/x/def/',
      undefined,
      { markPublished: true }
    );

    expect(integrationFindMany).not.toHaveBeenCalled();
    expect(postUpdate.mock.calls[0][0].data.integrationId).toBeUndefined();
  });

  it('does NOT use the session reading on the human paste-your-link path', async () => {
    // That reply may have been posted from another device entirely, where this
    // browser's session says nothing about who replied.
    const { repo, postUpdate } = buildRepo({
      platform: 'reddit',
      integrations: [row('int_live', 'abc', 'u/live', 'EXTENSION', FRESH)],
    });

    await repo.updateReplyUrl(
      'org-1',
      'reply-1',
      'https://www.reddit.com/r/n8n/comments/1abc/x/def/'
    );

    expect(postUpdate.mock.calls[0][0].data.integrationId).toBeUndefined();
  });

  it('still attributes a URL-less extension publish (Quora captures no permalink)', async () => {
    const { repo, postUpdate } = buildRepo({
      platform: 'quora',
      integrations: [row('int_live', 'me', 'me', 'EXTENSION', FRESH)],
    });

    await repo.updateReplyUrl('org-1', 'reply-1', null, undefined, {
      markPublished: true,
    });

    expect(postUpdate.mock.calls[0][0].data).toMatchObject({
      releaseURL: null,
      state: 'PUBLISHED',
      integrationId: 'int_live',
    });
  });

  it('keeps the X permalink handle match as the stronger X answer', async () => {
    // resolveXReplyIntegrationId reads the account out of the permalink itself;
    // the session reading only answers when that finds nothing.
    const { repo, postUpdate } = buildRepo({
      platform: 'x',
      integrations: [
        row('int_url', '111', 'aipartnerup', 'API', FRESH),
        row('int_live', '222', 'other', 'EXTENSION', FRESH),
      ],
    });

    await repo.updateReplyUrl(
      'org-1',
      'reply-1',
      'https://x.com/aipartnerup/status/1234567890',
      undefined,
      { markPublished: true }
    );

    expect(postUpdate.mock.calls[0][0].data).toMatchObject({
      integrationId: 'int_url',
      releaseId: '1234567890',
    });
  });

  it('commits the reply even if the attribution lookup fails', async () => {
    const { repo, postUpdate, integrationFindMany } = buildRepo({
      platform: 'reddit',
      integrations: [],
    });
    integrationFindMany.mockRejectedValue(new Error('db down'));

    await repo.updateReplyUrl(
      'org-1',
      'reply-1',
      'https://www.reddit.com/r/n8n/comments/1abc/x/def/',
      undefined,
      { markPublished: true }
    );

    expect(postUpdate.mock.calls[0][0].data).toMatchObject({ state: 'PUBLISHED' });
    expect(postUpdate.mock.calls[0][0].data.integrationId).toBeUndefined();
  });
});
