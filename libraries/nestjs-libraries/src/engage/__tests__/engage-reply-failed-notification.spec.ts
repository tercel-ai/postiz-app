import { describe, it, expect, vi } from 'vitest';
import { EngageService } from '../engage.service';

/**
 * ENGAGE_REPLY_FAILED — the user-facing half of "the extension could not send
 * this reply".
 *
 * Three endpoints close a queued reply for good: the target is gone, the post
 * refuses replies, or a send fired and was never confirmed. Only the last one
 * used to notify, so the other two ended a reply silently — the user saw it
 * queued, then never saw anything again. These tests pin that all three emit
 * the same event, keyed per reply, and that the paths which do NOT end a reply
 * stay quiet.
 */
describe('ENGAGE_REPLY_FAILED on extension send failure', () => {
  const org = { id: 'org-1' } as any;

  function build(repoOverrides: Record<string, any>) {
    const notify = vi.fn(async () => true);
    const getSentReplyContext = vi.fn(async (_org: string, id: string) => ({
      sentReplyId: id,
      postId: `p-${id}`,
      opportunityId: 'o1',
      projectId: 'proj-1',
      state: 'ERROR',
      releaseURL: null,
      platform: 'reddit',
    }));
    const repo = { getSentReplyContext, ...repoOverrides } as any;
    const service = new EngageService(
      repo,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { notify } as any
    );
    return { service, notify, getSentReplyContext };
  }

  it('notifies once per reply the target-gone report closed', async () => {
    const { service, notify } = build({
      markOpportunityTargetGone: vi.fn(async () => ({
        retired: true,
        repliesClosed: 2,
        closedReplyIds: ['r1', 'r2'],
      })),
    });

    await service.markOpportunityTargetGone(org, 'opp-1', 'deleted', true);

    expect(notify).toHaveBeenCalledTimes(2);
    // Keyed on the reply, not the opportunity: an org can have several replies
    // parked on one opportunity, and each is its own dead reply to report.
    expect(notify.mock.calls.map((c: any[]) => c[0].dedupKey)).toEqual([
      'engage.reply_failed:r1',
      'engage.reply_failed:r2',
    ]);
    expect(notify.mock.calls[0][0]).toMatchObject({
      organizationId: 'org-1',
      eventKey: 'engage.reply_failed',
      channel: 'engage',
      data: { platform: 'reddit', sent_reply_id: 'r1', project_id: 'proj-1' },
    });
  });

  it('notifies for a replies-disabled report too', async () => {
    const { service, notify } = build({
      markOpportunityRepliesDisabled: vi.fn(async () => ({
        marked: true,
        repliesClosed: 1,
        closedReplyIds: ['r9'],
      })),
    });

    await service.markOpportunityRepliesDisabled(org, 'opp-1', 'comments off');

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0].dedupKey).toBe('engage.reply_failed:r9');
  });

  it('stays quiet when a report closed nothing', async () => {
    // An unconfirmed target-gone whose replies had already left QUEUE. Nothing
    // ended here, so announcing a failure would be a lie about a live reply.
    const { service, notify } = build({
      markOpportunityTargetGone: vi.fn(async () => ({
        retired: false,
        repliesClosed: 0,
        closedReplyIds: [],
      })),
    });

    await service.markOpportunityTargetGone(org, 'opp-1', 'maybe gone', false);

    expect(notify).not.toHaveBeenCalled();
  });

  it('still notifies when the context lookup fails', async () => {
    // The reply IS closed in the database by the time we get here. Losing the
    // platform label is worth far less than losing the notification.
    const { service, notify } = build({
      getSentReplyContext: vi.fn(async () => {
        throw new Error('db down');
      }),
      markOpportunityTargetGone: vi.fn(async () => ({
        retired: true,
        repliesClosed: 1,
        closedReplyIds: ['r1'],
      })),
    });

    await service.markOpportunityTargetGone(org, 'opp-1', 'deleted', true);

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0].data).toMatchObject({ sent_reply_id: 'r1' });
  });

  it('keeps the unconfirmed-send path on the same event', async () => {
    const { service, notify } = build({
      closeUnconfirmedReply: vi.fn(async () => ({ closed: true })),
    });

    await service.closeUnconfirmedReply(org, 'r5', 'never rendered');

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatchObject({
      eventKey: 'engage.reply_failed',
      dedupKey: 'engage.reply_failed:r5',
    });
  });

  it('does not notify for an unconfirmed report that closed nothing', async () => {
    // `closed: false` means the reply had already reached PUBLISHED.
    const { service, notify } = build({
      closeUnconfirmedReply: vi.fn(async () => ({ closed: false })),
    });

    await service.closeUnconfirmedReply(org, 'r5', 'never rendered');

    expect(notify).not.toHaveBeenCalled();
  });
});

/**
 * engage.reply_removed — the reply went out, was live, and the platform took it
 * down (the extension re-checks from a logged-out view seconds after posting).
 *
 * Deliberately NOT engage.reply_failed: that one means nothing went out and its
 * CTA is Retry, which here would send the user straight back into the rule that
 * just removed them.
 */
describe('engage.reply_removed on a platform takedown', () => {
  const org = { id: 'org-1' } as any;

  function build(ctx: any) {
    const notify = vi.fn(async () => true);
    const repo = {
      getSentReplyContext: vi.fn(async () => ctx),
      markSentReplyRemoved: vi.fn(async () => ({
        id: 'r1',
        removed: true,
        reason: 'removed',
      })),
    } as any;
    const service = new EngageService(
      repo,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { notify } as any
    );
    return { service, notify };
  }

  const live = {
    sentReplyId: 'r1',
    postId: 'p1',
    opportunityId: 'o1',
    projectId: 'proj-1',
    removedAt: null,
    state: 'PUBLISHED',
    releaseURL: 'https://reddit.com/r/x/comments/1',
    platform: 'reddit',
  };

  it('emits engage.reply_removed, keyed on the reply', async () => {
    const { service, notify } = build(live);

    await service.markExtensionReplyRemoved(org, 'r1', 'gone', null);

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatchObject({
      organizationId: 'org-1',
      eventKey: 'engage.reply_removed',
      dedupKey: 'engage.reply_removed:r1',
      channel: 'engage',
      data: {
        platform: 'reddit',
        sent_reply_id: 'r1',
        project_id: 'proj-1',
        // A detector label, not copy — the registry stores it and renders
        // nothing from it. `short_reason` there means "a sentence to append".
        verdict: 'gone',
        // Falls back to the stored permalink when the re-check reports none.
        external_url: 'https://reddit.com/r/x/comments/1',
      },
    });
  });

  it('notifies once when the same removal is reported twice', async () => {
    // markSentReplyRemoved re-stamps removedAt unconditionally, so the row
    // cannot answer "was this new?" after the write — the pre-write read must.
    const { service, notify } = build({
      ...live,
      removedAt: new Date('2026-09-11T00:00:00Z'),
    });

    await service.markExtensionReplyRemoved(org, 'r1', 'removed', null);

    expect(notify).not.toHaveBeenCalled();
  });

  it('normalizes an unrecognised verdict the same way the column does', async () => {
    const { service, notify } = build(live);

    await service.markExtensionReplyRemoved(org, 'r1', 'whatever', null);

    expect(notify.mock.calls[0][0].data.verdict).toBe('removed');
  });

  it('prefers the re-check URL over the stored one', async () => {
    const { service, notify } = build(live);

    await service.markExtensionReplyRemoved(
      org,
      'r1',
      'gone',
      'https://reddit.com/r/x/comments/2'
    );

    expect(notify.mock.calls[0][0].data.external_url).toBe(
      'https://reddit.com/r/x/comments/2'
    );
  });
});
