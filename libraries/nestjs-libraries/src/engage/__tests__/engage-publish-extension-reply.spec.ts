import { describe, it, expect, vi } from 'vitest';
import { EngageService } from '../engage.service';

/**
 * publishExtensionReply is the extension's publish-on-success commit point:
 * backfill URL + flip DRAFT→PUBLISHED + claim + charge, in that order, and
 * idempotent for an already-published reply. These tests pin that contract.
 */
describe('publishExtensionReply — commit on confirmed extension success', () => {
  const org = { id: 'org-1' } as any;
  const xUrl = 'https://x.com/alice/status/123';

  function build(ctx: any) {
    const updateReplyUrl = vi.fn(async () => ({ id: ctx?.postId ?? 'p1' }));
    const claimOpportunityForReply = vi.fn(async () => ({ opp: {}, priorStatus: 'NEW' }));
    const getSentReplyContext = vi.fn(async () => ctx);
    const updateReplyAuthor = vi.fn(async () => undefined);
    const repo = {
      getSentReplyContext,
      updateReplyUrl,
      claimOpportunityForReply,
      updateReplyAuthor,
    } as any;
    const postOverage = { deductIfOverage: vi.fn(async () => undefined) } as any;
    const postsService = { fetchEngageXAuthor: vi.fn(async () => null) } as any;
    const service = new EngageService(
      repo,
      { client: undefined } as any,
      postsService,
      postOverage,
      {} as any
    );
    return { service, updateReplyUrl, claimOpportunityForReply, postOverage, getSentReplyContext };
  }

  const draftCtx = {
    sentReplyId: 'r1',
    postId: 'p1',
    opportunityId: 'o1',
    state: 'DRAFT',
    releaseURL: null,
    platform: 'x',
  };

  const author = { handle: 'alice', id: 't2_1', name: 'Alice' };

  it('backfills+publishes, claims, and charges on success', async () => {
    const { service, updateReplyUrl, claimOpportunityForReply, postOverage } =
      build(draftCtx);

    const res = await service.publishExtensionReply(org, 'u1', 'r1', xUrl, author);

    expect(updateReplyUrl).toHaveBeenCalledWith('org-1', 'r1', xUrl, author, {
      markPublished: true,
    });
    expect(claimOpportunityForReply).toHaveBeenCalledWith('org-1', 'o1', 'REPLIED');
    expect(postOverage.deductIfOverage).toHaveBeenCalledWith(
      'org-1',
      'u1',
      'p1',
      'engage'
    );
    expect(res).toMatchObject({ id: 'r1', state: 'PUBLISHED', replyUrl: xUrl });
  });

  it('is idempotent: an already-published reply does NOT re-write or re-charge', async () => {
    const { service, updateReplyUrl, claimOpportunityForReply, postOverage } =
      build({ ...draftCtx, state: 'PUBLISHED', releaseURL: xUrl });

    const res = await service.publishExtensionReply(org, 'u1', 'r1', xUrl, author);

    expect(updateReplyUrl).not.toHaveBeenCalled();
    expect(claimOpportunityForReply).not.toHaveBeenCalled();
    expect(postOverage.deductIfOverage).not.toHaveBeenCalled();
    expect(res).toMatchObject({ alreadyPublished: true, state: 'PUBLISHED' });
  });

  it('still publishes + charges when the opportunity can no longer be claimed', async () => {
    const { service, claimOpportunityForReply, postOverage } = build(draftCtx);
    claimOpportunityForReply.mockRejectedValueOnce(
      new Error('Opportunity not found or already replied')
    );

    const res = await service.publishExtensionReply(org, 'u1', 'r1', xUrl, author);

    // Claim failed but the reply is live → recorded + charged anyway.
    expect(postOverage.deductIfOverage).toHaveBeenCalledOnce();
    expect(res).toMatchObject({ state: 'PUBLISHED', replyUrl: xUrl });
  });

  it('does not charge when there is no userId on the request', async () => {
    const { service, updateReplyUrl, postOverage } = build(draftCtx);

    await service.publishExtensionReply(org, undefined, 'r1', xUrl, author);

    expect(updateReplyUrl).toHaveBeenCalledOnce();
    expect(postOverage.deductIfOverage).not.toHaveBeenCalled();
  });

  it('throws when the reply is not found', async () => {
    const { service } = build(null);
    await expect(
      service.publishExtensionReply(org, 'u1', 'missing', xUrl, author)
    ).rejects.toThrow(/not found/i);
  });

  it('rejects a platform that is not X or Reddit', async () => {
    const { service, updateReplyUrl } = build({
      ...draftCtx,
      platform: 'linkedin',
    });
    await expect(
      service.publishExtensionReply(org, 'u1', 'r1', xUrl, author)
    ).rejects.toThrow(/only valid for X or Reddit/i);
    expect(updateReplyUrl).not.toHaveBeenCalled();
  });
});
