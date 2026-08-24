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
    const snapshotSentReplyMatchedKeywords = vi.fn(async () => undefined);
    const repo = {
      getSentReplyContext,
      updateReplyUrl,
      claimOpportunityForReply,
      updateReplyAuthor,
      snapshotSentReplyMatchedKeywords,
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
    return {
      service,
      updateReplyUrl,
      claimOpportunityForReply,
      postOverage,
      getSentReplyContext,
      snapshotSentReplyMatchedKeywords,
    };
  }

  const draftCtx = {
    sentReplyId: 'r1',
    postId: 'p1',
    opportunityId: 'o1',
    projectId: 'proj-1',
    state: 'DRAFT',
    releaseURL: null,
    platform: 'x',
  };

  const author = { handle: 'alice', id: 't2_1', name: 'Alice' };

  it('backfills+publishes, claims, snapshots keywords, and charges on success', async () => {
    const {
      service,
      updateReplyUrl,
      claimOpportunityForReply,
      postOverage,
      snapshotSentReplyMatchedKeywords,
    } = build(draftCtx);

    const res = await service.publishExtensionReply(org, 'u1', 'r1', xUrl, author);

    expect(updateReplyUrl).toHaveBeenCalledWith('org-1', 'r1', xUrl, author, {
      markPublished: true,
    });
    // The claim must target the project state row the draft was saved under —
    // an omitted projectId would claim the org-level (null-project) row instead.
    expect(claimOpportunityForReply).toHaveBeenCalledWith(
      'org-1',
      'o1',
      'REPLIED',
      'proj-1'
    );
    // The draft-created reply row has no matchedKeywords; the commit point fills it.
    expect(snapshotSentReplyMatchedKeywords).toHaveBeenCalledWith(
      'org-1',
      'r1',
      'proj-1',
      'o1'
    );
    expect(postOverage.deductIfOverage).toHaveBeenCalledWith(
      'org-1',
      'u1',
      'p1',
      'engage'
    );
    expect(res).toMatchObject({ id: 'r1', state: 'PUBLISHED', replyUrl: xUrl });
  });

  it('is idempotent: an already-published reply does NOT re-write or re-charge', async () => {
    const {
      service,
      updateReplyUrl,
      claimOpportunityForReply,
      postOverage,
      snapshotSentReplyMatchedKeywords,
    } = build({ ...draftCtx, state: 'PUBLISHED', releaseURL: xUrl });

    const res = await service.publishExtensionReply(org, 'u1', 'r1', xUrl, author);

    expect(updateReplyUrl).not.toHaveBeenCalled();
    expect(claimOpportunityForReply).not.toHaveBeenCalled();
    expect(snapshotSentReplyMatchedKeywords).not.toHaveBeenCalled();
    expect(postOverage.deductIfOverage).not.toHaveBeenCalled();
    expect(res).toMatchObject({ alreadyPublished: true, state: 'PUBLISHED' });
  });

  it('still publishes + charges when the opportunity can no longer be claimed', async () => {
    const {
      service,
      claimOpportunityForReply,
      postOverage,
      snapshotSentReplyMatchedKeywords,
    } = build(draftCtx);
    claimOpportunityForReply.mockRejectedValueOnce(
      new Error('Opportunity not found or already replied')
    );

    const res = await service.publishExtensionReply(org, 'u1', 'r1', xUrl, author);

    // Claim failed but the reply is live → recorded + charged anyway, and the
    // keyword snapshot is still taken (attribution is independent of the claim).
    expect(snapshotSentReplyMatchedKeywords).toHaveBeenCalledOnce();
    expect(postOverage.deductIfOverage).toHaveBeenCalledOnce();
    expect(res).toMatchObject({ state: 'PUBLISHED', replyUrl: xUrl });
  });

  it('a snapshot failure never fails the publish', async () => {
    const { service, snapshotSentReplyMatchedKeywords, postOverage } =
      build(draftCtx);
    snapshotSentReplyMatchedKeywords.mockRejectedValueOnce(new Error('db down'));

    const res = await service.publishExtensionReply(org, 'u1', 'r1', xUrl, author);

    expect(postOverage.deductIfOverage).toHaveBeenCalledOnce();
    expect(res).toMatchObject({ state: 'PUBLISHED', replyUrl: xUrl });
  });

  it('does not charge when there is no userId on the request', async () => {
    const { service, updateReplyUrl, postOverage } = build(draftCtx);

    await service.publishExtensionReply(org, undefined, 'r1', xUrl, author);

    expect(updateReplyUrl).toHaveBeenCalledOnce();
    expect(postOverage.deductIfOverage).not.toHaveBeenCalled();
  });

  it('publishes URL-less when the extension confirmed the send but captured no permalink', async () => {
    const { service, updateReplyUrl, claimOpportunityForReply, postOverage } =
      build(draftCtx);

    const res = await service.publishExtensionReply(org, 'u1', 'r1', undefined, author);

    // The commit must still land: DRAFT→PUBLISHED with releaseURL null —
    // leaving the row DRAFT is what makes a live reply re-sendable (duplicate).
    expect(updateReplyUrl).toHaveBeenCalledWith('org-1', 'r1', null, author, {
      markPublished: true,
    });
    expect(claimOpportunityForReply).toHaveBeenCalledOnce();
    expect(postOverage.deductIfOverage).toHaveBeenCalledOnce();
    expect(res).toMatchObject({ id: 'r1', state: 'PUBLISHED', replyUrl: null });
  });

  it('URL-less publish skips the author enrichment (it needs the reply URL)', async () => {
    const { service } = build(draftCtx);
    const postsService = (service as any)._postsService;

    await service.publishExtensionReply(org, 'u1', 'r1', undefined, undefined);

    // Background enrich resolves the author FROM the reply URL — nothing to do.
    expect(postsService.fetchEngageXAuthor).not.toHaveBeenCalled();
  });

  it('throws when the reply is not found', async () => {
    const { service } = build(null);
    await expect(
      service.publishExtensionReply(org, 'u1', 'missing', xUrl, author)
    ).rejects.toThrow(/not found/i);
  });

  it('publishes a non-X/Reddit SCANNABLE_PLATFORMS reply (linkedin) — this callback is its only path to PUBLISHED', async () => {
    // Regression: this used to reject every platform but X/Reddit, so a
    // linkedin/hackernews/devto/medium/quora reply that genuinely posted stayed
    // QUEUE forever — the extension's success callback was the only writer of
    // DRAFT/QUEUE→PUBLISHED and it always threw for these platforms.
    const { service, updateReplyUrl, claimOpportunityForReply } = build({
      ...draftCtx,
      platform: 'linkedin',
    });
    const linkedinUrl = 'https://www.linkedin.com/feed/update/urn:li:activity:123/';

    const res = await service.publishExtensionReply(
      org,
      'u1',
      'r1',
      linkedinUrl,
      undefined
    );

    expect(updateReplyUrl).toHaveBeenCalledWith(
      'org-1',
      'r1',
      linkedinUrl,
      undefined,
      { markPublished: true }
    );
    expect(claimOpportunityForReply).toHaveBeenCalledOnce();
    expect(res).toMatchObject({ state: 'PUBLISHED', replyUrl: linkedinUrl });
  });

  it('rejects a platform outside SCANNABLE_PLATFORMS entirely', async () => {
    const { service, updateReplyUrl } = build({
      ...draftCtx,
      platform: 'made-up-platform',
    });
    await expect(
      service.publishExtensionReply(org, 'u1', 'r1', xUrl, author)
    ).rejects.toThrow(/not supported for platform/i);
    expect(updateReplyUrl).not.toHaveBeenCalled();
  });

  it('rejects a linkedin URL whose domain does not match', async () => {
    const { service, updateReplyUrl } = build({
      ...draftCtx,
      platform: 'linkedin',
    });
    await expect(
      service.publishExtensionReply(org, 'u1', 'r1', xUrl, author) // an x.com URL
      // The accepted hosts come from PLATFORM_HOSTS, so the message names them.
    ).rejects.toThrow(/Invalid linkedin reply URL.*linkedin\.com/);
    expect(updateReplyUrl).not.toHaveBeenCalled();
  });
});
