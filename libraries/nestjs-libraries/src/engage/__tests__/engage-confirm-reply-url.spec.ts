import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EngageService } from '../engage.service';

/**
 * confirmManualReply must hold a supplied reply URL to the same standard as the
 * backfill path (format + reachability), but skip all checks when no URL is
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
  let service: EngageService;

  beforeEach(() => {
    claim = vi.fn(async () => ({ opp: { platform: 'x', externalPostId: 't1' }, priorStatus: 'NEW' }));
    createX = vi.fn(async () => ({ id: 'post-1' }));
    createReddit = vi.fn(async () => ({ id: 'post-1' }));
    release = vi.fn(async () => undefined);
    createSentReply = vi.fn(async () => ({ id: 'reply-1' }));

    const repo = {
      claimOpportunityForReply: claim,
      createManualXPost: createX,
      createManualRedditPost: createReddit,
      releaseOpportunityClaim: release,
      createSentReply,
    } as any;
    // No temporal client → startMetricsSyncForReply is a no-op.
    service = new EngageService(repo, { client: undefined } as any, {} as any, {} as any);
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

  it('rejects a malformed X URL and releases the claim (no record created)', async () => {
    await expect(
      service.confirmManualReply(org, undefined, 'opp-1', body({ replyUrl: 'not-a-tweet-url' }))
    ).rejects.toThrow(/Invalid X reply URL/);
    expect(createX).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('rejects a malformed Reddit URL and releases the claim', async () => {
    claim.mockResolvedValue({ opp: { platform: 'reddit' }, priorStatus: 'NEW' });
    await expect(
      service.confirmManualReply(org, undefined, 'opp-1', body({ replyUrl: 'https://example.com/not-reddit' }))
    ).rejects.toThrow(/Invalid Reddit comment URL/);
    expect(createReddit).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });
});
