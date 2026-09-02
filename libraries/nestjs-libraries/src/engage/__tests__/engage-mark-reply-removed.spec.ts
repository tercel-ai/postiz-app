import { describe, it, expect, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { EngageService } from '../engage.service';

// The service layer above EngageRepository.markSentReplyRemoved (covered
// directly in engage-mark-sent-reply-removed.spec.ts). What belongs here is
// what the service adds on top: resolving the sent-reply context so a 404
// reads clearly, and normalizing `reason` into exactly the two values the
// repository — and the stored column — are meant to hold.
describe('EngageService.markExtensionReplyRemoved', () => {
  const org = { id: 'org-1' } as any;

  function build(ctx: any = { platform: 'reddit' }) {
    const getSentReplyContext = vi.fn(async () => ctx);
    const markSentReplyRemoved = vi.fn(async () => ({
      id: 'r1',
      removed: true,
      reason: 'removed',
    }));
    const repo = { getSentReplyContext, markSentReplyRemoved } as any;
    const service = new EngageService(
      repo,
      { client: undefined } as any,
      {} as any,
      {} as any,
      {} as any
    );
    return { service, getSentReplyContext, markSentReplyRemoved };
  }

  it('throws NotFoundException when the sent reply does not exist', async () => {
    const { service, markSentReplyRemoved } = build(null);

    await expect(
      service.markExtensionReplyRemoved(org, 'r1', 'removed', null)
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(markSentReplyRemoved).not.toHaveBeenCalled();
  });

  it('passes "removed" straight through to the repository', async () => {
    const { service, markSentReplyRemoved } = build();

    await service.markExtensionReplyRemoved(org, 'r1', 'removed', null);

    expect(markSentReplyRemoved).toHaveBeenCalledWith(
      'org-1',
      'r1',
      'removed',
      null
    );
  });

  it('passes "gone" straight through to the repository', async () => {
    const { service, markSentReplyRemoved } = build();

    await service.markExtensionReplyRemoved(org, 'r1', 'gone', null);

    expect(markSentReplyRemoved).toHaveBeenCalledWith(
      'org-1',
      'r1',
      'gone',
      null
    );
  });

  it('normalizes an unrecognised reason to "removed" rather than storing it verbatim', async () => {
    // Defence in depth: the DTO's @IsIn already refuses anything but
    // 'removed'/'gone' at the HTTP boundary, but the service does not trust
    // that as the only line of defence — an unrecognised value still resolves
    // to the fact that matters (the platform removed it), not to garbage in
    // removedReason.
    const { service, markSentReplyRemoved } = build();

    await service.markExtensionReplyRemoved(
      org,
      'r1',
      'some-unexpected-value',
      null
    );

    expect(markSentReplyRemoved).toHaveBeenCalledWith(
      'org-1',
      'r1',
      'removed',
      null
    );
  });

  it('forwards the captured url to the repository', async () => {
    const { service, markSentReplyRemoved } = build();

    await service.markExtensionReplyRemoved(
      org,
      'r1',
      'removed',
      'https://www.reddit.com/r/test/comments/a/b/c1/'
    );

    expect(markSentReplyRemoved).toHaveBeenCalledWith(
      'org-1',
      'r1',
      'removed',
      'https://www.reddit.com/r/test/comments/a/b/c1/'
    );
  });

  it('returns the repository result unchanged', async () => {
    const { service } = build();

    const result = await service.markExtensionReplyRemoved(
      org,
      'r1',
      'removed',
      null
    );

    expect(result).toEqual({ id: 'r1', removed: true, reason: 'removed' });
  });
});
