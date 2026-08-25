import { describe, it, expect, vi } from 'vitest';
import { EngageRepository } from '../engage.repository';

// The clock the unattended reply driver paces against.
//
// The bug this pins down, seen live: a project configured for one Reddit reply
// every 4-6 hours sent three inside thirteen minutes. The gate in
// engage-auto-reply.service compares `now` against getLastSentReplyAt(), and
// that used to read EngageSentReply.createdAt alone — the moment the DRAFT was
// generated. Handing out an already-queued draft creates no row, so it left
// that timestamp untouched: once the newest draft aged past the interval the
// gate opened and never closed, draining the backlog at the extension's poll
// rate (one per five minutes) regardless of the configured interval.
//
// Post.claimedAt is stamped by claimDueEngageReplies when a draft is handed to
// the extension, so the later of the two is what "last replied" has to mean.

const DRAFTED = new Date('2026-08-25T08:00:00Z'); // generated five hours ago
const HANDED_OUT = new Date('2026-08-25T12:55:00Z'); // handed over five min ago

function buildRepo() {
  const findFirst = vi.fn();
  const findMany = vi.fn();
  const _sentReply = {
    model: { engageSentReply: { findFirst, findMany } },
  } as any;
  const repo = new EngageRepository(
    {} as any, {} as any, {} as any, {} as any, {} as any, _sentReply,
    {} as any, {} as any, {} as any, {} as any, {} as any, {} as any
  );
  return { repo, findFirst, findMany };
}

/** Route the two lookups getLastSentReplyAt fires by which column they sort on. */
function stubLookups(
  findFirst: ReturnType<typeof vi.fn>,
  rows: { drafted?: Date | null; handedOut?: Date | null }
) {
  findFirst.mockImplementation(async (args: any) => {
    if (args?.orderBy && 'createdAt' in args.orderBy) {
      return rows.drafted ? { createdAt: rows.drafted } : null;
    }
    return rows.handedOut ? { post: { claimedAt: rows.handedOut } } : null;
  });
}

describe('EngageRepository.getLastSentReplyAt', () => {
  it('advances the clock when a QUEUED draft is handed out, not only when one is generated', async () => {
    // THE regression. Without this the gate compares against a five-hour-old
    // draft timestamp forever and releases a reply on every poll.
    const { repo, findFirst } = buildRepo();
    stubLookups(findFirst, { drafted: DRAFTED, handedOut: HANDED_OUT });

    const last = await repo.getLastSentReplyAt('org-1', 'proj-1', 'reddit');

    expect(last).toEqual(HANDED_OUT);
  });

  it('falls back to the draft time while nothing has been handed out yet', async () => {
    const { repo, findFirst } = buildRepo();
    stubLookups(findFirst, { drafted: DRAFTED, handedOut: null });

    expect(await repo.getLastSentReplyAt('org-1', 'proj-1', 'reddit')).toEqual(
      DRAFTED
    );
  });

  it('reports null — never a zero date — when this platform has no history', async () => {
    // The caller reads null as "no gate applies"; anything else would silently
    // hold the first reply of a project's life.
    const { repo, findFirst } = buildRepo();
    stubLookups(findFirst, { drafted: null, handedOut: null });

    expect(await repo.getLastSentReplyAt('org-1', 'proj-1', 'reddit')).toBeNull();
  });

  it('asks the database for the most recent hand-out, not just any claimed row', async () => {
    const { repo, findFirst } = buildRepo();
    stubLookups(findFirst, { drafted: DRAFTED, handedOut: HANDED_OUT });

    await repo.getLastSentReplyAt('org-1', 'proj-1', 'reddit');

    const claimQuery = findFirst.mock.calls
      .map(([args]) => args)
      .find((args: any) => !('createdAt' in (args.orderBy ?? {})));
    expect(claimQuery.orderBy).toEqual({ post: { claimedAt: 'desc' } });
    // Never-claimed rows would otherwise sort in and answer "no hand-out".
    expect(claimQuery.where.post).toEqual({ claimedAt: { not: null } });
    expect(claimQuery.where.opportunity).toEqual({ platform: 'reddit' });
  });
});

describe('EngageRepository.getLastSentReplyAtByPlatform', () => {
  // Same clock as the gate, deliberately: this one feeds the "next reply in
  // 4h 56m" countdown, and a countdown measuring something other than the gate
  // it describes is worse than no countdown — that mismatch is how the bug
  // stayed invisible while replies went out every five minutes.
  it('prefers a hand-out over a newer draft that never left the queue', async () => {
    const { repo, findMany } = buildRepo();
    findMany.mockResolvedValue([
      // Newest by createdAt, but still sitting in the queue.
      {
        createdAt: new Date('2026-08-25T12:00:00Z'),
        post: { claimedAt: null },
        opportunity: { platform: 'reddit' },
      },
      // Older draft — but it was handed to the extension minutes ago.
      {
        createdAt: DRAFTED,
        post: { claimedAt: HANDED_OUT },
        opportunity: { platform: 'reddit' },
      },
    ]);

    const out = await repo.getLastSentReplyAtByPlatform('org-1', 'proj-1', [
      'reddit',
    ]);

    expect(out.reddit).toEqual(HANDED_OUT);
  });

  it('keeps platforms apart and skips one with nothing to report', async () => {
    const { repo, findMany } = buildRepo();
    findMany.mockResolvedValue([
      {
        createdAt: DRAFTED,
        post: { claimedAt: HANDED_OUT },
        opportunity: { platform: 'reddit' },
      },
      {
        createdAt: new Date('2026-08-24T09:00:00Z'),
        post: { claimedAt: null },
        opportunity: { platform: 'x' },
      },
    ]);

    const out = await repo.getLastSentReplyAtByPlatform('org-1', 'proj-1', [
      'reddit',
      'x',
      'medium',
    ]);

    expect(out.reddit).toEqual(HANDED_OUT);
    expect(out.x).toEqual(new Date('2026-08-24T09:00:00Z'));
    expect(out.medium).toBeUndefined();
  });

  it('makes no query at all for an empty platform list', async () => {
    const { repo, findMany } = buildRepo();

    expect(await repo.getLastSentReplyAtByPlatform('org-1', 'proj-1', [])).toEqual(
      {}
    );
    expect(findMany).not.toHaveBeenCalled();
  });
});
