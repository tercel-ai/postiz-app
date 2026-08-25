import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EngageRepository } from '../engage.repository';

// Triage of broken-address opportunities: which rows may be deleted, and which
// are spared because someone was charged for work against them. Getting this
// wrong in the deleting direction destroys paid work, so every signal that
// spares a row is pinned here.

const deleteMany = vi.fn();
const findManyReplies = vi.fn();
const findManyStates = vi.fn();
const findManyCharges = vi.fn();
const findManyOpps = vi.fn();
const countOpps = vi.fn();
const updateMany = vi.fn();

/** EngageRepository with only the four models this triage touches wired up. */
function buildRepo(): EngageRepository {
  const opportunity = {
    model: {
      engageOpportunity: {
        deleteMany,
        findMany: findManyOpps,
        count: countOpps,
        updateMany,
      },
    },
  };
  const oppState = {
    model: { engageOpportunityState: { findMany: findManyStates } },
  };
  const sentReply = {
    model: { engageSentReply: { findMany: findManyReplies } },
  };
  const billingRecord = {
    model: { billingRecord: { findMany: findManyCharges } },
  };
  const unused = {} as never;

  return new EngageRepository(
    unused, // _config
    unused, // _keyword
    unused, // _trackedAccount
    opportunity as never,
    oppState as never,
    sentReply as never,
    unused, // _integration
    unused, // _integrationProject
    unused, // _post
    unused, // _tx
    unused, // _scanCursor
    unused, // _keywordInitialScan
    billingRecord as never
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  findManyReplies.mockResolvedValue([]);
  findManyStates.mockResolvedValue([]);
  findManyCharges.mockResolvedValue([]);
  deleteMany.mockResolvedValue({ count: 0 });
});

describe('deleteOpportunitiesForAdmin — what is spared', () => {
  it('deletes a row with no replies, no history and no charge', async () => {
    deleteMany.mockResolvedValue({ count: 1 });

    const res = await buildRepo().deleteOpportunitiesForAdmin(['free']);

    expect(deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['free'] } } });
    expect(res).toEqual({ deleted: 1, skipped: 0 });
  });

  it('spares a row that has a sent reply', async () => {
    findManyReplies.mockResolvedValue([{ opportunityId: 'paid' }]);

    const res = await buildRepo().deleteOpportunitiesForAdmin(['paid']);

    expect(deleteMany).not.toHaveBeenCalled();
    expect(res).toEqual({ deleted: 0, skipped: 1 });
  });

  it('spares a row with a non-empty generationHistory', async () => {
    findManyStates.mockResolvedValue([
      { opportunityId: 'paid', generationHistory: [{ source: 'ai' }] },
    ]);

    expect(await buildRepo().deleteOpportunitiesForAdmin(['paid'])).toEqual({
      deleted: 0,
      skipped: 1,
    });
  });

  it('does NOT spare a row whose generationHistory is an empty array', async () => {
    deleteMany.mockResolvedValue({ count: 1 });
    findManyStates.mockResolvedValue([
      { opportunityId: 'free', generationHistory: [] },
    ]);

    expect(await buildRepo().deleteOpportunitiesForAdmin(['free'])).toEqual({
      deleted: 1,
      skipped: 0,
    });
  });

  it('spares a legacy row that only has a charge — history is NULL there', async () => {
    // The signal that matters most: generationHistory was added later, so paid
    // generations from before it exists carry SQL NULL. Judging by history
    // alone would read those as free and delete them.
    findManyCharges.mockResolvedValue([{ relatedId: 'legacy' }]);

    expect(await buildRepo().deleteOpportunitiesForAdmin(['legacy'])).toEqual({
      deleted: 0,
      skipped: 1,
    });
  });

  it('spares a row whose only charge was released', async () => {
    // releaseReplyGeneration fires both when generateDraft threw (nothing made)
    // and when queueAutoReply failed to persist a draft that WAS made. Those are
    // indistinguishable in the data, so the charge row alone spares the row —
    // hence no status filter on the query at all.
    await buildRepo().deleteOpportunitiesForAdmin(['maybe']);

    expect(findManyCharges).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ businessType: 'engage_reply' }),
      })
    );
    const [[call]] = findManyCharges.mock.calls;
    expect(JSON.stringify(call.where)).not.toContain('status');
  });

  it('deletes only the free rows out of a mixed batch', async () => {
    findManyReplies.mockResolvedValue([{ opportunityId: 'a' }]);
    findManyCharges.mockResolvedValue([{ relatedId: 'c' }]);
    deleteMany.mockResolvedValue({ count: 2 });

    const res = await buildRepo().deleteOpportunitiesForAdmin(['a', 'b', 'c', 'd']);

    expect(deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['b', 'd'] } } });
    expect(res).toEqual({ deleted: 2, skipped: 2 });
  });

  it('touches nothing for an empty id list', async () => {
    const res = await buildRepo().deleteOpportunitiesForAdmin([]);

    expect(deleteMany).not.toHaveBeenCalled();
    expect(res).toEqual({ deleted: 0, skipped: 0 });
  });
});

describe('listOpportunitiesForAdmin', () => {
  const row = {
    id: 'o1',
    platform: 'linkedin',
    externalPostId: 'sdui-abc',
    externalPostUrl: 'https://www.linkedin.com/company/harba1/posts/',
    postContent: 'body',
    authorDisplayName: 'HARBA',
    postPublishedAt: new Date('2026-08-18T00:00:00Z'),
  };

  beforeEach(() => {
    findManyOpps.mockResolvedValue([row]);
    countOpps.mockResolvedValue(1);
  });

  it('flags rows with paid work so the client repairs instead of deleting', async () => {
    findManyCharges.mockResolvedValue([{ relatedId: 'o1' }]);

    const res = await buildRepo().listOpportunitiesForAdmin({ platform: 'linkedin' });

    expect(res.items[0].replyCount).toBe(1);
    expect(res.total).toBe(1);
  });

  it('reports a free row as deletable', async () => {
    const res = await buildRepo().listOpportunitiesForAdmin({});
    expect(res.items[0].replyCount).toBe(0);
  });

  it('filters to entity-page addresses only when asked', async () => {
    await buildRepo().listOpportunitiesForAdmin({ onlyBrokenUrls: true });

    const where = findManyOpps.mock.calls[0][0].where;
    expect(JSON.stringify(where.OR)).toContain('linkedin.com/company/');
    expect(JSON.stringify(where.OR)).toContain('linkedin.com/school/');
    expect(JSON.stringify(where.OR)).toContain('linkedin.com/showcase/');
  });

  it('applies no URL filter without the flag', async () => {
    await buildRepo().listOpportunitiesForAdmin({});
    expect(findManyOpps.mock.calls[0][0].where.OR).toBeUndefined();
  });

  it('pages from 1 and never serves soft-deleted rows', async () => {
    await buildRepo().listOpportunitiesForAdmin({ page: 3, pageSize: 25 });

    const args = findManyOpps.mock.calls[0][0];
    expect(args.skip).toBe(50);
    expect(args.take).toBe(25);
    expect(args.where.deletedAt).toBeNull();
  });
});

describe('repairOpportunityUrlsForAdmin', () => {
  it('writes only externalPostUrl, never the id it was verified against', async () => {
    updateMany.mockResolvedValue({ count: 1 });

    const res = await buildRepo().repairOpportunityUrlsForAdmin([
      { id: 'o1', externalPostUrl: 'https://www.linkedin.com/posts/a_b-activity-1-Z/' },
    ]);

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'o1', deletedAt: null },
      data: { externalPostUrl: 'https://www.linkedin.com/posts/a_b-activity-1-Z/' },
    });
    expect(res).toEqual({ updated: 1 });
  });

  it('counts a vanished row as not updated rather than failing the batch', async () => {
    updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });

    const res = await buildRepo().repairOpportunityUrlsForAdmin([
      { id: 'gone', externalPostUrl: 'https://www.linkedin.com/posts/x-activity-1-Z/' },
      { id: 'here', externalPostUrl: 'https://www.linkedin.com/posts/y-activity-2-Z/' },
    ]);

    expect(res).toEqual({ updated: 1 });
  });
});
