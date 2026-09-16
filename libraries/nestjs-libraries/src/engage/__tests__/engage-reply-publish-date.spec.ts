/**
 * An engage reply's Post is created by save-draft, which stamps `publishDate`
 * at DRAFT time. The extension then posts it whenever the browser, the
 * platform's pacing and the reply queue allow — routinely hours later — so
 * until the commit re-stamped it, the Sent list, the replies-trend buckets and
 * the metrics freshness gate all reported the drafting time as the reply time.
 *
 * These tests pin the re-stamp to the publish commit, and pin the two paths
 * that must leave `publishDate` alone.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EngageRepository } from '../engage.repository';

function buildRepo(opts: { platform?: string; postState?: string } = {}) {
  const platform = opts.platform ?? 'reddit';
  const sentFindFirst = vi.fn().mockResolvedValue({
    id: 'reply-1',
    postId: 'post-1',
    opportunityId: 'opp-1',
    projectId: null,
    opportunity: { platform },
  });
  const postFindUnique = vi.fn().mockResolvedValue({
    integrationId: 'int-1',
    settings: JSON.stringify({ __type: platform }),
  });
  const postUpdate = vi.fn().mockResolvedValue({ id: 'post-1' });
  const sentUpdate = vi.fn().mockResolvedValue({ id: 'reply-1' });
  const oppStateUpdateMany = vi.fn().mockResolvedValue({ count: 1 });

  const repo = new EngageRepository(
    {} as any, // _config
    {} as any, // _keyword
    {} as any, // _trackedAccount
    {} as any, // _opportunity
    { model: { engageOpportunityState: { updateMany: oppStateUpdateMany } } } as any,
    {
      model: {
        engageSentReply: { findFirst: sentFindFirst, update: sentUpdate },
      },
    } as any,
    { model: { integration: { findMany: vi.fn().mockResolvedValue([]) } } } as any,
    {} as any, // _integrationProject
    { model: { post: { findUnique: postFindUnique, update: postUpdate } } } as any,
    {} as any, // _tx
    {} as any // _scanCursor
  );
  return { repo, postUpdate };
}

describe('updateReplyUrl — the reply is dated when it actually went live', () => {
  beforeEach(() => vi.clearAllMocks());

  it('re-stamps publishDate on the extension publish commit', async () => {
    const { repo, postUpdate } = buildRepo();

    const before = Date.now();
    await repo.updateReplyUrl(
      'org-1',
      'reply-1',
      'https://www.reddit.com/r/t/comments/a/b/',
      undefined,
      { markPublished: true }
    );
    const after = Date.now();

    const { data } = postUpdate.mock.calls[0][0];
    expect(data.state).toBe('PUBLISHED');
    expect(data.publishDate).toBeInstanceOf(Date);
    expect(data.publishDate.getTime()).toBeGreaterThanOrEqual(before);
    expect(data.publishDate.getTime()).toBeLessThanOrEqual(after);
  });

  it('stamps a URL-less confirm too — the send is what dates the reply, not the permalink', async () => {
    const { repo, postUpdate } = buildRepo();

    await repo.updateReplyUrl('org-1', 'reply-1', null, undefined, {
      markPublished: true,
    });

    const { data } = postUpdate.mock.calls[0][0];
    expect(data.state).toBe('PUBLISHED');
    expect(data.releaseURL).toBeNull();
    expect(data.publishDate).toBeInstanceOf(Date);
  });

  // The human "paste your reply link" path: the post has been PUBLISHED since
  // confirm time with the date the user gave it. Moving it to whenever somebody
  // got round to pasting the link would replace a true send time with a false one.
  it('leaves publishDate alone on the manual link backfill', async () => {
    const { repo, postUpdate } = buildRepo();

    await repo.updateReplyUrl(
      'org-1',
      'reply-1',
      'https://www.reddit.com/r/t/comments/a/b/'
    );

    expect(postUpdate.mock.calls[0][0].data).not.toHaveProperty('publishDate');
  });
});

describe('markSentReplyRemoved — a removal report is not a send time', () => {
  beforeEach(() => vi.clearAllMocks());

  it('re-asserts PUBLISHED without re-dating the reply', async () => {
    const { repo, postUpdate } = buildRepo();

    await repo.markSentReplyRemoved('org-1', 'reply-1', 'removed', null);

    expect(postUpdate.mock.calls[0][0].data.state).toBe('PUBLISHED');
    expect(postUpdate.mock.calls[0][0].data).not.toHaveProperty('publishDate');
  });
});
