import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EngageService } from '../engage.service';

/**
 * confirmManualReply must hold a supplied reply URL to the same standard as the
 * backfill path (platform-host format check), but skip all checks when no URL is
 * given ("I'll add the link later"). A bad URL must release the claim so the
 * opportunity isn't stuck in REPLIED with no record.
 */
describe('EngageService.confirmManualReply — URL verification gating', () => {
  const org = { id: 'org-1' } as any;

  let claim: ReturnType<typeof vi.fn>;
  let createX: ReturnType<typeof vi.fn>;
  let createReddit: ReturnType<typeof vi.fn>;
  let release: ReturnType<typeof vi.fn>;
  let createSentReply: ReturnType<typeof vi.fn>;
  let updateReplyAuthor: ReturnType<typeof vi.fn>;
  let fetchEngageXAuthor: ReturnType<typeof vi.fn>;
  let service: EngageService;

  const flush = () => new Promise((r) => setImmediate(r));

  beforeEach(() => {
    claim = vi.fn(async () => ({ opp: { platform: 'x', externalPostId: 't1' }, priorStatus: 'NEW' }));
    createX = vi.fn(async () => ({ id: 'post-1' }));
    createReddit = vi.fn(async () => ({ id: 'post-1' }));
    release = vi.fn(async () => undefined);
    createSentReply = vi.fn(async () => ({ id: 'reply-1' }));
    updateReplyAuthor = vi.fn(async () => undefined);
    fetchEngageXAuthor = vi.fn(async () => ({ handle: 'benppoulton', id: 't2_1', name: 'Ben' }));

    const repo = {
      claimOpportunityForReply: claim,
      createManualXPost: createX,
      createManualCommunityPost: createReddit,
      releaseOpportunityClaim: release,
      createSentReply,
      updateReplyAuthor,
    } as any;
    const postsService = { fetchEngageXAuthor } as any;
    // No temporal client → startMetricsSyncForReply is a no-op.
    service = new EngageService(repo, { client: undefined } as any, postsService, {} as any, {} as any);
  });

  const body = (over: Record<string, unknown> = {}) => ({
    draftContent: 'hi',
    strategy: 'expert_answer',
    brandStrength: 1,
    mentions: [],
    ...over,
  }) as any;

  it('records the reply WITHOUT a URL — no verification, claim kept', async () => {
    await service.confirmManualReply(org, undefined, 'opp-1', body());
    expect(createX).toHaveBeenCalledTimes(1);
    expect(createX.mock.calls[0][0].replyUrl).toBeUndefined();
    expect(createSentReply).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
  });

  it('with a URL: creates the post WITHOUT engageAuthor, then enriches in the background', async () => {
    await service.confirmManualReply(
      org,
      undefined,
      'opp-1',
      body({ replyUrl: 'https://x.com/benppoulton/status/123' })
    );
    // Post is created WITHOUT the author baked in — it is not resolved on the
    // critical path; createManualXPost never receives an engageAuthor.
    expect(createX).toHaveBeenCalledTimes(1);
    expect(createX.mock.calls[0][0].engageAuthor).toBeUndefined();

    await flush(); // let the fire-and-forget enrichment settle

    // Resolved from the URL and persisted out of band against the sent reply id.
    expect(fetchEngageXAuthor).toHaveBeenCalledWith('org-1', 'https://x.com/benppoulton/status/123');
    expect(updateReplyAuthor).toHaveBeenCalledWith('org-1', 'reply-1', {
      handle: 'benppoulton',
      id: 't2_1',
      name: 'Ben',
    });
  });

  it('does NOT enrich when the author cannot be resolved (stays handle-less, no throw)', async () => {
    fetchEngageXAuthor.mockResolvedValue(null);
    await service.confirmManualReply(
      org,
      undefined,
      'opp-1',
      body({ replyUrl: 'https://x.com/benppoulton/status/123' })
    );
    await flush();
    expect(updateReplyAuthor).not.toHaveBeenCalled();
  });

  // Host rejection now names the accepted domains, sourced from PLATFORM_HOSTS
  // rather than a hand-written sentence per platform (_validateReplyUrl). The
  // assertions below pin that the domains reach the user, not the old wording.
  it('rejects a malformed X URL and releases the claim (no record created)', async () => {
    await expect(
      service.confirmManualReply(org, undefined, 'opp-1', body({ replyUrl: 'not-a-tweet-url' }))
    ).rejects.toThrow(/Invalid x reply URL.*x\.com or twitter\.com/);
    expect(createX).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('rejects a malformed Reddit URL and releases the claim', async () => {
    claim.mockResolvedValue({ opp: { platform: 'reddit' }, priorStatus: 'NEW' });
    await expect(
      service.confirmManualReply(org, undefined, 'opp-1', body({ replyUrl: 'https://example.com/not-reddit' }))
    ).rejects.toThrow(/Invalid reddit reply URL.*reddit\.com/);
    expect(createReddit).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  // Every non-X platform shares createManualCommunityPost. The platform it is
  // filed under must come from the OPPORTUNITY — this branch used to call a
  // `createManualRedditPost` that hard-coded 'reddit', so a Hacker News reply
  // was persisted as a reddit Post whose releaseURL pointed at ycombinator.
  it.each([
    ['hackernews', 'https://news.ycombinator.com/item?id=49494133'],
    ['quora', undefined],
    ['linkedin', undefined],
    ['medium', undefined],
    ['devto', undefined],
    ['reddit', 'https://www.reddit.com/r/sub/comments/abc/title/def/'],
  ])('files a %s manual reply under its own platform', async (platform, replyUrl) => {
    claim.mockResolvedValue({ opp: { platform }, priorStatus: 'NEW' });

    await service.confirmManualReply(org, undefined, 'opp-1', body({ replyUrl }));

    expect(createX).not.toHaveBeenCalled();
    expect(createReddit).toHaveBeenCalledTimes(1);
    expect(createReddit.mock.calls[0][0].platform).toBe(platform);
  });

  it('still routes an X reply to the X-specific path, not the community one', async () => {
    await service.confirmManualReply(org, undefined, 'opp-1', body());
    expect(createX).toHaveBeenCalledTimes(1);
    expect(createReddit).not.toHaveBeenCalled();
  });

  it('still rejects a right-host-but-id-less Reddit URL with the comment-id message', async () => {
    // The host layer passes; the id-shape layer is what refuses. Both layers
    // must stay reachable after the registry refactor collapsed the host checks.
    claim.mockResolvedValue({ opp: { platform: 'reddit' }, priorStatus: 'NEW' });
    await expect(
      service.confirmManualReply(
        org,
        undefined,
        'opp-1',
        body({ replyUrl: 'https://www.reddit.com/r/sub/comments/abc/' })
      )
    ).rejects.toThrow(/must link to a specific comment/);
    expect(createReddit).not.toHaveBeenCalled();
  });
});
