import { describe, it, expect, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { EngageRepository } from '../engage.repository';

// Retiring an opportunity whose post no longer exists on the platform.
//
// The loop this closes: the extension is handed a QUEUE reply, the poster opens
// the permalink and finds the post deleted, the reply fails, the record stays
// QUEUE, the lease expires, and the same reply comes back on the next poll —
// forever, because nothing in that cycle learns anything.
//
// Two things carry the weight here. `EngageOpportunity` is GLOBAL — one row
// shared by every org that scanned the same post — so the entitlement check is
// what stops one caller retiring a post for everyone. And the retirement is
// only half the fix: the replies already parked against the opportunity have to
// be closed too, or they sit in QUEUE forever instead of looping forever.
function buildRepo(opts: { parked?: any[]; reply?: any } = {}) {
  const sentFindMany = vi.fn(async () => opts.parked ?? []);
  const sentFindFirst = vi.fn(async () =>
    'reply' in opts ? opts.reply : { postId: 'p1' }
  );
  const oppUpdateMany = vi.fn(async () => ({ count: 1 }));
  // Answers like Prisma would: how many rows the where-clause named. The two
  // callers address rows differently — target-gone updates a set of ids,
  // closeUnconfirmedReply a single one — so this reads the clause rather than
  // hard-coding a count either of them would get wrong.
  const postUpdateMany = vi.fn(async (args: any) => ({
    count: Array.isArray(args?.where?.id?.in) ? args.where.id.in.length : 1,
  }));

  const _sentReply = {
    model: {
      engageSentReply: { findMany: sentFindMany, findFirst: sentFindFirst },
    },
  } as any;
  // closeUnconfirmedReply writes through _post directly, not the transaction.
  const _post = { model: { post: { updateMany: postUpdateMany } } } as any;
  // The transaction runs its callback against a client exposing the two writes.
  const _tx = {
    model: {
      $transaction: (fn: any) =>
        fn({
          engageOpportunity: { updateMany: oppUpdateMany },
          post: { updateMany: postUpdateMany },
        }),
    },
  } as any;

  const repo = new EngageRepository(
    {} as any, {} as any, {} as any, {} as any, {} as any, _sentReply,
    {} as any, {} as any, _post, _tx, {} as any, {} as any, {} as any
  );
  return { repo, sentFindMany, sentFindFirst, oppUpdateMany, postUpdateMany };
}

const now = new Date('2026-09-01T08:40:00Z');

describe('EngageRepository.markOpportunityTargetGone — authorisation', () => {
  it('refuses a caller with no queued reply waiting on the opportunity', async () => {
    // THE safety property. The opportunity row is shared across orgs, so
    // without this any authenticated caller could retire any post for everyone.
    // Owning a reply parked against it is what makes "my extension just tried
    // to post here and the post was gone" a claim this caller can make.
    const { repo, oppUpdateMany, postUpdateMany } = buildRepo({ parked: [] });

    await expect(
      repo.markOpportunityTargetGone('org-1', 'opp-1', 'the post was deleted', true, now)
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(oppUpdateMany).not.toHaveBeenCalled();
    expect(postUpdateMany).not.toHaveBeenCalled();
  });

  it('looks for the caller’s own live queue rows, not anyone’s reply ever', async () => {
    const { repo, sentFindMany } = buildRepo({ parked: [{ postId: 'p1' }] });

    await repo.markOpportunityTargetGone('org-1', 'opp-1', 'gone', true, now);

    expect(sentFindMany.mock.calls[0][0].where).toMatchObject({
      organizationId: 'org-1',
      opportunityId: 'opp-1',
      // A reply that already went out is not evidence of anything current, and
      // a soft-deleted one is not waiting on anything.
      post: { state: 'QUEUE', deletedAt: null, releaseURL: null },
    });
  });
});

describe('EngageRepository.markOpportunityTargetGone — the two writes', () => {
  it('stamps deletedAt so nothing is drafted or claimed against it again', async () => {
    const { repo, oppUpdateMany } = buildRepo({ parked: [{ postId: 'p1' }] });

    await repo.markOpportunityTargetGone('org-1', 'opp-1', 'gone', true, now);

    expect(oppUpdateMany).toHaveBeenCalledWith({
      where: { id: 'opp-1', deletedAt: null },
      data: { deletedAt: now },
    });
  });

  it('keeps the FIRST retirement timestamp when a second org reports the same post', async () => {
    // `deletedAt: null` in the where is what does this: the stamp means "when
    // the post was first observed gone", not "when the last report arrived".
    const { repo, oppUpdateMany } = buildRepo({ parked: [{ postId: 'p1' }] });

    await repo.markOpportunityTargetGone('org-2', 'opp-1', 'gone', true, now);

    expect(oppUpdateMany.mock.calls[0][0].where.deletedAt).toBeNull();
  });

  it('closes the queued replies instead of leaving them parked forever', async () => {
    // Retiring the opportunity alone would only stop the rows being handed out.
    // They would then sit in QUEUE indefinitely — invisible to the queue counts
    // and to anyone wondering why a project's reply budget never drains.
    const { repo, postUpdateMany } = buildRepo({
      parked: [{ postId: 'p1' }, { postId: 'p2' }],
    });

    const result = await repo.markOpportunityTargetGone(
      'org-1',
      'opp-1',
      'the post was deleted by its author',
      true,
      now
    );

    const call = postUpdateMany.mock.calls[0][0];
    expect(call.where).toMatchObject({
      id: { in: ['p1', 'p2'] },
      // Re-asserted at write time: a row that left QUEUE between the read and
      // the write went out for real, and must not be marked ERROR.
      state: 'QUEUE',
    });
    expect(call.data.state).toBe('ERROR');
    // The lease token goes with it, but NOT claimedAt — that column is the
    // platform write clock (see the dedicated case below), and `state: 'ERROR'`
    // is already what stops the row being handed out again.
    expect(call.data.releaseId).toBeNull();
    expect('claimedAt' in call.data).toBe(false);
    expect(result).toEqual({ retired: true, repliesClosed: 2 });
  });

  it('preserves claimedAt — it is the platform write clock, not just a lease', async () => {
    // `post.claimedAt` is the sole reply-side input to getLastPlatformWriteAt,
    // documented there as "the moment the account is actually touched", and the
    // publish branch of that query explicitly excludes engage rows — so there is
    // no fallback. Clearing it would rewind the platform write floor. This
    // method's own premise makes it sharpest: the send FIRED, so this row's
    // claimedAt is the most recent moment the account was written to.
    const { repo, postUpdateMany } = buildRepo();

    await repo.closeUnconfirmedReply('org-1', 'sent-1', 'unconfirmed');

    const data = postUpdateMany.mock.calls[0][0].data;
    expect(data.releaseId).toBeNull();
    expect('claimedAt' in data).toBe(false);
  });

  it('records the poster’s own reason on the closed reply', async () => {
    // This string is what a user reads in the extension history and on the
    // record. "Failed" tells them nothing; the platform's own verdict does.
    const { repo, postUpdateMany } = buildRepo({ parked: [{ postId: 'p1' }] });

    await repo.markOpportunityTargetGone(
      'org-1',
      'opp-1',
      'the post was deleted by its author',
      true,
      now
    );

    expect(postUpdateMany.mock.calls[0][0].data.error).toContain(
      'the post was deleted by its author'
    );
    expect(postUpdateMany.mock.calls[0][0].data.error).toMatch(/not be retried/i);
  });

  it('does not let an oversized reason overflow the error column', async () => {
    const { repo, postUpdateMany } = buildRepo({ parked: [{ postId: 'p1' }] });

    await repo.markOpportunityTargetGone('org-1', 'opp-1', 'x'.repeat(5_000), true, now);

    expect(postUpdateMany.mock.calls[0][0].data.error.length).toBeLessThan(600);
  });
});

// ─── Closing a send that fired but was never confirmed ──────────────────────
//
// A DIFFERENT claim from target-gone, with a deliberately smaller blast radius:
// "we submitted and could not read the result" is a fact about one attempt, not
// about the post, so exactly one reply record is closed and the shared
// opportunity is left alone.
//
// It closes a reply that might be LIVE, on purpose. Leaving it queued means the
// lease expires, the reply is offered again, and a second copy of the same
// comment goes up — and a duplicate comment on someone else's post cannot be
// taken back, while an unsent reply can be re-sent by hand (and the extension's
// reply.unconfirmed pass commits the ones that did land).
// ─── Blast radius: who a report is allowed to speak for ─────────────────────
//
// Owning a parked reply establishes STANDING, not truth. `EngageOpportunity` is
// one row shared by every org that scanned the same post, `deletedAt` has no
// un-retire path anywhere in the backend, and every opportunity read filters on
// it — so acting globally on a verdict we merely inferred from page text would
// delete a live post from every other tenant's Engage surface, permanently.
//
// The extension grades its own evidence: an HTTP 404/410 is the platform
// stating the address does not resolve (true for everyone); a text match cannot
// separate "deleted for everyone" from "invisible to THIS browser session" — a
// protected account, a private community, an author who blocked that one login.
describe('EngageRepository.markOpportunityTargetGone — blast radius', () => {
  it('does NOT retire the shared opportunity on an unconfirmed report', async () => {
    const { repo, oppUpdateMany, postUpdateMany } = buildRepo({
      parked: [{ postId: 'p1' }],
    });

    const result = await repo.markOpportunityTargetGone(
      'org-1',
      'opp-1',
      'the post was deleted',
      false,
      now
    );

    // The global row is untouched — another tenant signed in as a follower can
    // still see and reply to this post.
    expect(oppUpdateMany).not.toHaveBeenCalled();
    // But the caller's own loop still ends: its parked reply is closed, and
    // pickAutoReplyCandidates will not draft another (it excludes opportunities
    // this project already has a reply against).
    expect(postUpdateMany.mock.calls[0][0].data.state).toBe('ERROR');
    expect(result).toEqual({ retired: false, repliesClosed: 1 });
  });

  it('reports what it did, not what was asked — retired mirrors confirmed', async () => {
    // A caller told `retired: true` after an unconfirmed report would have no
    // way to tell the two outcomes apart.
    const { repo } = buildRepo({ parked: [{ postId: 'p1' }] });

    expect(
      (await repo.markOpportunityTargetGone('org-1', 'opp-1', 'gone', false, now))
        .retired
    ).toBe(false);
    expect(
      (await repo.markOpportunityTargetGone('org-1', 'opp-1', 'gone', true, now))
        .retired
    ).toBe(true);
  });

  it('still refuses an unconfirmed report from a caller with no parked reply', async () => {
    // Standing is checked first and independently — an unconfirmed report is
    // narrower, not exempt.
    const { repo, postUpdateMany } = buildRepo({ parked: [] });

    await expect(
      repo.markOpportunityTargetGone('org-1', 'opp-1', 'gone', false, now)
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(postUpdateMany).not.toHaveBeenCalled();
  });
});

describe('EngageRepository.closeUnconfirmedReply', () => {
  it('closes the reply without touching the opportunity', async () => {
    const { repo, oppUpdateMany, postUpdateMany } = buildRepo();

    const result = await repo.closeUnconfirmedReply(
      'org-1',
      'sent-1',
      'the platform never showed the reply'
    );

    // THE distinction from target-gone. The post may be perfectly alive; all
    // that happened is that we could not read our own send back.
    expect(oppUpdateMany).not.toHaveBeenCalled();
    expect(postUpdateMany.mock.calls[0][0].data.state).toBe('ERROR');
    expect(result).toEqual({ closed: true });
  });

  it('scopes the lookup to the calling org', async () => {
    const { repo, sentFindFirst } = buildRepo();

    await repo.closeUnconfirmedReply('org-1', 'sent-1', 'unconfirmed');

    // Without the org scope one caller could close another's record by guessing
    // an id.
    expect(sentFindFirst.mock.calls[0][0].where).toEqual({
      id: 'sent-1',
      organizationId: 'org-1',
    });
  });

  it('refuses an id that is not this org’s reply', async () => {
    const { repo, postUpdateMany } = buildRepo({ reply: null });

    await expect(
      repo.closeUnconfirmedReply('org-1', 'sent-1', 'unconfirmed')
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(postUpdateMany).not.toHaveBeenCalled();
  });

  it('will not overwrite a reply that turned out to have gone out', async () => {
    // Re-asserted at write time: between the extension's attempt and this call
    // the record may have reached PUBLISHED, and marking that ERROR would
    // contradict a confirmed send.
    const { repo, postUpdateMany } = buildRepo();

    await repo.closeUnconfirmedReply('org-1', 'sent-1', 'unconfirmed');

    expect(postUpdateMany.mock.calls[0][0].where).toEqual({
      id: 'p1',
      state: 'QUEUE',
    });
  });

  it('reports closed:false when nothing was in QUEUE to close', async () => {
    // Makes a second report — or a row that went out meanwhile — a no-op rather
    // than a lie.
    const { repo } = buildRepo();
    const postUpdateMany = vi.fn(async () => ({ count: 0 }));
    (repo as any)._post = { model: { post: { updateMany: postUpdateMany } } };

    expect(
      await repo.closeUnconfirmedReply('org-1', 'sent-1', 'unconfirmed')
    ).toEqual({ closed: false });
  });

  it('tells the reader not to re-send, and why', async () => {
    // This string is the only explanation anyone gets for a reply that stopped
    // moving. "Failed" would invite exactly the duplicate this prevents.
    const { repo, postUpdateMany } = buildRepo();

    await repo.closeUnconfirmedReply(
      'org-1',
      'sent-1',
      'dev.to never showed the comment'
    );

    const error = postUpdateMany.mock.calls[0][0].data.error;
    expect(error).toContain('dev.to never showed the comment');
    expect(error).toMatch(/may be live/i);
    expect(error).toMatch(/NOT be re-sent/i);
  });
});
