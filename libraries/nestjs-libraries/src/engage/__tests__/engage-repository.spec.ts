/**
 * Unit tests for the two-table read paths in EngageRepository introduced by the
 * EngageOpportunity global/per-org split. Prisma is mocked; no DB.
 *
 * Guards (review W5):
 *  - _merge flattens state + opportunity into the legacy flat shape, id = opportunity id
 *  - listOpportunities routes sort fields to the table that owns them
 *  - getScoreStats sources objective averages from the opportunity aggregate and
 *    org-specific averages from the state aggregate
 */
import { describe, it, expect, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import dayjs from 'dayjs';
import isoWeek from 'dayjs/plugin/isoWeek';
import utc from 'dayjs/plugin/utc';
import {
  EngageRepository,
  opportunityMediaUrls,
  opportunityContentType,
} from '../engage.repository';

dayjs.extend(isoWeek);
dayjs.extend(utc);

function buildRepo() {
  const stateFindMany = vi.fn();
  const stateCount = vi.fn();
  const stateGroupBy = vi.fn();
  const stateAggregate = vi.fn();
  const stateFindFirst = vi.fn();
  const stateFindUnique = vi.fn();
  const stateUpdateMany = vi.fn();
  const oppAggregate = vi.fn();
  const oppFindFirst = vi.fn();
  const channelFindMany = vi.fn();
  const channelFindFirst = vi.fn();
  const trackedFindMany = vi.fn();
  const cursorFindMany = vi.fn();
  // Default to no keywords so tests that don't care about keyword status don't
  // trip the new per-keyword cursor lookup in getOrgScanStatus.
  const keywordFindMany = vi.fn().mockResolvedValue([]);
  const sentCount = vi.fn();
  // Default to an empty result so read paths that join sent replies (e.g.
  // listOpportunities' `.then((r) => r ?? [])`) don't NPE when a test doesn't
  // care about them. Tests that assert on sent replies override this.
  const sentFindMany = vi.fn().mockResolvedValue([]);
  const sentFindFirst = vi.fn();
  const sentCreate = vi.fn();
  const sentUpdate = vi.fn();
  const postAggregate = vi.fn();
  const postFindMany = vi.fn();
  const postCreate = vi.fn();
  const postUpdate = vi.fn();
  const postDeleteMany = vi.fn();

  // Channels and tracked accounts are rows of ONE table since the scan-target
  // merge, so both scopes hit engageTrackedAccount. The spec keeps two mock
  // pairs so each scope can still be stubbed independently; these dispatchers
  // route by the platform predicate the repository builds (channel-scope queries
  // name reddit, author-scope queries exclude it). A query with NO platform
  // predicate spans both scopes, so it gets both stubs' rows concatenated.
  const isChannelQuery = (args: any) => {
    const p = args?.where?.platform;
    if (!p) return null; // spans both scopes
    if (typeof p === 'string') return p === 'reddit';
    if (Array.isArray(p?.in)) return p.in.includes('reddit');
    if (Array.isArray(p?.notIn)) return !p.notIn.includes('reddit');
    return null;
  };
  const dispatchFindMany = vi.fn(async (args: any) => {
    const scope = isChannelQuery(args);
    if (scope === true) return channelFindMany(args);
    if (scope === false) return trackedFindMany(args);
    const [channels, accounts] = await Promise.all([
      channelFindMany(args),
      trackedFindMany(args),
    ]);
    return [...(channels ?? []), ...(accounts ?? [])];
  });
  const trackedFindFirst = vi.fn();
  const dispatchFindFirst = vi.fn(async (args: any) =>
    isChannelQuery(args) === true
      ? channelFindFirst(args)
      : trackedFindFirst(args)
  );
  const trackedAccount = {
    model: {
      engageTrackedAccount: {
        findMany: dispatchFindMany,
        findFirst: dispatchFindFirst,
      },
    },
  } as any;
  const scanCursor = {
    model: { engageScanCursor: { findMany: cursorFindMany } },
  } as any;
  const keyword = {
    model: { engageKeyword: { findMany: keywordFindMany } },
  } as any;
  const opportunity = {
    model: {
      engageOpportunity: { aggregate: oppAggregate, findFirst: oppFindFirst },
    },
  } as any;
  // appendGenerationHistory runs an atomic jsonb concat via $executeRaw on the
  // oppState client, so the mock exposes it alongside the model accessors.
  const stateExecuteRaw = vi.fn().mockResolvedValue(1);
  const oppState = {
    model: {
      engageOpportunityState: {
        findMany: stateFindMany,
        count: stateCount,
        groupBy: stateGroupBy,
        aggregate: stateAggregate,
        findFirst: stateFindFirst,
        findUnique: stateFindUnique,
        updateMany: stateUpdateMany,
      },
      $executeRaw: stateExecuteRaw,
    },
  } as any;
  const sentReply = {
    model: {
      engageSentReply: {
        count: sentCount,
        findMany: sentFindMany,
        findFirst: sentFindFirst,
        create: sentCreate,
        update: sentUpdate,
      },
    },
  } as any;
  const post = {
    model: {
      post: {
        aggregate: postAggregate,
        findMany: postFindMany,
        create: postCreate,
        update: postUpdate,
        deleteMany: postDeleteMany,
      },
    },
  } as any;
  // Interactive-transaction client: $transaction(cb) runs cb with a `tx` exposing the
  // model accessors. upsertDraft routes its writes through here — wire the SAME mock
  // fns so assertions on sentFindFirst/postCreate/sentCreate/etc. still capture the
  // tx-scoped calls.
  const txTransaction = vi.fn(async (cb: any) =>
    cb({
      engageSentReply: {
        findFirst: sentFindFirst,
        create: sentCreate,
        update: sentUpdate,
      },
      post: {
        create: postCreate,
        update: postUpdate,
        deleteMany: postDeleteMany,
      },
    })
  );
  const tx = { model: { $transaction: txTransaction } } as any;

  // Constructor order: _config, _keyword, _trackedAccount, _replyAccount,
  // _opportunity, _oppState, _sentReply, _integration, _post, _tx, _scanCursor
  const repo = new EngageRepository(
    {} as any,      // _config
    keyword,        // _keyword
    trackedAccount, // _trackedAccount (both scan-target scopes)
    opportunity,    // _opportunity
    oppState,       // _oppState
    sentReply,      // _sentReply
    {} as any,      // _integration
    {} as any,      // _integrationProject
    post,           // _post
    tx,             // _tx
    scanCursor      // _scanCursor
  );
  return {
    repo,
    stateFindMany,
    stateCount,
    stateGroupBy,
    stateAggregate,
    stateFindFirst,
    stateFindUnique,
    stateUpdateMany,
    stateExecuteRaw,
    oppAggregate,
    oppFindFirst,
    channelFindMany,
    channelFindFirst,
    trackedFindFirst,
    trackedFindMany,
    cursorFindMany,
    keywordFindMany,
    sentCount,
    sentFindMany,
    sentFindFirst,
    sentCreate,
    sentUpdate,
    postAggregate,
    postFindMany,
    postCreate,
    postUpdate,
    postDeleteMany,
    txTransaction,
  };
}

const STATE_ROW = {
  id: 'state1',
  projectId: null,
  status: 'NEW',
  bookmarked: true,
  score: 70,
  scoreKeyword: 30,
  scoreTracked: 5,
  matchedKeywords: ['react', 'nextjs'],
  opportunity: {
    id: 'opp1',
    platform: 'x',
    externalPostId: 'e1',
    postContent: 'hello',
    scoreHeat: 18,
    scoreAuthority: 8,
    scoreRecency: 4,
    intentTags: ['support'],
  },
};

describe('EngageRepository — two-table reads', () => {
  describe('getOpportunityCountsSummary', () => {
    it('isolates the total filter from later platform counts', async () => {
      const { repo, stateCount, stateGroupBy } = buildRepo();
      stateGroupBy.mockResolvedValue([]);
      stateCount.mockImplementation(async ({ where }: { where: any }) => {
        if (stateCount.mock.calls.length === 1) {
          where.opportunity.AND = [
            { OR: [{ channelId: { equals: 'mutated' } }] },
          ];
        }
        return 0;
      });

      await repo.getOpportunityCountsSummary('org1', {
        channels: ['expected'],
      });

      expect(stateCount.mock.calls[1][0].where.opportunity.AND).toEqual([
        { OR: [{ channelId: { equals: 'expected', mode: 'insensitive' } }] },
      ]);
    });

    it('computes total/byStatus/byPlatform under the same platform-less where', async () => {
      const { repo, stateCount, stateGroupBy } = buildRepo();
      stateGroupBy.mockResolvedValue([
        { status: 'NEW', _count: { _all: 2 } },
        { status: 'REPLIED', _count: { _all: 1 } },
      ]);
      stateCount
        .mockResolvedValueOnce(10) // total
        .mockResolvedValue(1); // each per-platform count

      const res = await repo.getOpportunityCountsSummary('org1', {
        channels: ['c1'],
      });

      // total + one count per broken-out platform
      expect(stateCount).toHaveBeenCalledTimes(8);
      // The total/byStatus where carries the scoping filters but NO platform —
      // platform is the breakdown axis, not a filter, on this contract.
      const totalWhere = stateCount.mock.calls[0][0].where;
      expect(totalWhere.opportunity.AND).toEqual([
        { OR: [{ channelId: { equals: 'c1', mode: 'insensitive' } }] },
      ]);
      expect(totalWhere.opportunity).not.toHaveProperty('platform');
      expect(totalWhere).not.toHaveProperty('status');
      expect(stateGroupBy.mock.calls[0][0].where).toEqual(totalWhere);
      // Each platform count keeps the scoping filters and pins one platform.
      expect(stateCount.mock.calls[1][0].where.opportunity).toMatchObject({
        AND: [{ OR: [{ channelId: { equals: 'c1', mode: 'insensitive' } }] }],
        platform: 'x',
      });

      expect(res.total).toBe(10);
      expect(res.byStatus.NEW).toBe(2);
      expect(res.byStatus.REPLIED).toBe(1);
      expect(res.byStatus.DISMISSED).toBe(0); // zero-filled
      expect(Object.keys(res.byPlatform).sort()).toEqual(
        [
          'x',
          'reddit',
          'linkedin',
          'medium',
          'devto',
          'hackernews',
          'quora',
        ].sort()
      );
    });
  });

  describe('countOpportunities', () => {
    it('applies exactly the /opportunities filter contract, status and platform included', async () => {
      const { repo, stateCount, stateGroupBy } = buildRepo();
      stateCount.mockResolvedValue(5);
      stateGroupBy.mockResolvedValue([]);

      const res = await repo.countOpportunities('org1', {
        status: ['NEW'],
        platform: ['x'],
        keyword: 'react',
      } as any);

      const where = stateCount.mock.calls[0][0].where;
      expect(where.status).toEqual({ in: ['NEW'] });
      expect(where.opportunity.platform).toEqual({ in: ['x'] });
      expect(where.matchedKeywords).toEqual({ hasSome: ['react'] });
      expect(res.total).toBe(5);
    });

    it('breaks down byStatus under every filter except status itself', async () => {
      const { repo, stateCount, stateGroupBy } = buildRepo();
      stateCount.mockResolvedValue(2);
      stateGroupBy.mockResolvedValue([
        { status: 'NEW', _count: { _all: 2 } },
        { status: 'REPLIED', _count: { _all: 3 } },
      ]);

      const res = await repo.countOpportunities('org1', {
        status: ['NEW'],
        platform: ['x'],
      } as any);

      // The breakdown drops ONLY the status filter — platform still narrows it.
      const groupByWhere = stateGroupBy.mock.calls[0][0].where;
      expect(groupByWhere).not.toHaveProperty('status');
      expect(groupByWhere.opportunity.platform).toEqual({ in: ['x'] });

      expect(res.byStatus.NEW).toBe(2);
      expect(res.byStatus.REPLIED).toBe(3);
      expect(res.byStatus.DISMISSED).toBe(0); // zero-filled
    });
  });

  describe('listOpportunities', () => {
    it('merges state + opportunity into the flat shape with id = opportunity id', async () => {
      const { repo, stateFindMany, stateCount } = buildRepo();
      stateFindMany.mockResolvedValue([STATE_ROW]);
      stateCount.mockResolvedValue(1);

      const res = await repo.listOpportunities('org1', {} as any);
      const item = res.items[0] as any;
      expect(item.id).toBe('opp1');           // opportunity id, not a state key
      expect(item.status).toBe('NEW');         // from state
      expect(item.bookmarked).toBe(true);      // from state
      expect(item.score).toBe(70);             // from state
      expect(item.scoreHeat).toBe(18);         // from opportunity
      expect(item.intentTags).toEqual(['support']);
      expect(item.matchedKeywords).toEqual(['react', 'nextjs']); // from state (per-org)
      expect(item).not.toHaveProperty('opportunity'); // flattened, not nested
    });

    it('exposes rawData\'s media URLs as mediaUrls, never rawData itself', async () => {
      // The body cannot carry these: postContent strips X's t.co attachment
      // placeholder. rawData stays unexposed — the server-side X adapter
      // archives a whole tweet payload in it.
      const { repo, stateFindMany, stateCount } = buildRepo();
      stateFindMany.mockResolvedValue([
        {
          ...STATE_ROW,
          opportunity: {
            ...STATE_ROW.opportunity,
            rawData: {
              mediaUrls: ['https://pbs.twimg.com/media/A.jpg'],
              tweet: { full_text: 'the whole archived payload' },
            },
          },
        },
      ]);
      stateCount.mockResolvedValue(1);

      const item = (await repo.listOpportunities('org1', {} as any))
        .items[0] as any;
      expect(item.mediaUrls).toEqual(['https://pbs.twimg.com/media/A.jpg']);
      expect(item).not.toHaveProperty('rawData');
    });

    it('returns mediaUrls as [] for a row with no attachment', async () => {
      // Clients can iterate unconditionally — no null check, no undefined.
      const { repo, stateFindMany, stateCount } = buildRepo();
      stateFindMany.mockResolvedValue([STATE_ROW]);
      stateCount.mockResolvedValue(1);

      const item = (await repo.listOpportunities('org1', {} as any))
        .items[0] as any;
      expect(item.mediaUrls).toEqual([]);
    });

    it('exposes rawData\'s postContentType as contentType', async () => {
      // Same "derive it out of rawData explicitly" contract as mediaUrls —
      // rawData itself never reaches the client.
      const { repo, stateFindMany, stateCount } = buildRepo();
      stateFindMany.mockResolvedValue([
        {
          ...STATE_ROW,
          opportunity: {
            ...STATE_ROW.opportunity,
            rawData: { postContentType: 'article' },
          },
        },
      ]);
      stateCount.mockResolvedValue(1);

      const item = (await repo.listOpportunities('org1', {} as any))
        .items[0] as any;
      expect(item.contentType).toBe('article');
      expect(item).not.toHaveProperty('rawData');
    });

    it('returns contentType as null for an ordinary post', async () => {
      const { repo, stateFindMany, stateCount } = buildRepo();
      stateFindMany.mockResolvedValue([STATE_ROW]);
      stateCount.mockResolvedValue(1);

      const item = (await repo.listOpportunities('org1', {} as any))
        .items[0] as any;
      expect(item.contentType).toBeNull();
    });

    it('filters by an exact matched keyword on the state table', async () => {
      const { repo, stateFindMany, stateCount } = buildRepo();
      stateFindMany.mockResolvedValue([]);
      stateCount.mockResolvedValue(0);

      await repo.listOpportunities('org1', { keyword: 'react' } as any);
      expect(stateFindMany.mock.calls[0][0].where.matchedKeywords).toEqual({
        hasSome: ['react'],
      });
    });

    it('filters by multiple matched keywords (OR) via hasSome', async () => {
      const { repo, stateFindMany, stateCount } = buildRepo();
      stateFindMany.mockResolvedValue([]);
      stateCount.mockResolvedValue(0);

      await repo.listOpportunities('org1', {
        keywords: ['react', 'nextjs'],
      } as any);
      expect(stateFindMany.mock.calls[0][0].where.matchedKeywords).toEqual({
        hasSome: ['react', 'nextjs'],
      });
    });

    it('unions single `keyword` and multi `keywords` into one OR set', async () => {
      const { repo, stateFindMany, stateCount } = buildRepo();
      stateFindMany.mockResolvedValue([]);
      stateCount.mockResolvedValue(0);

      await repo.listOpportunities('org1', {
        keyword: 'react',
        keywords: ['nextjs', 'vue'],
      } as any);
      expect(stateFindMany.mock.calls[0][0].where.matchedKeywords).toEqual({
        hasSome: ['react', 'nextjs', 'vue'],
      });
    });

    it('omits the keyword filter entirely when none is given', async () => {
      const { repo, stateFindMany, stateCount } = buildRepo();
      stateFindMany.mockResolvedValue([]);
      stateCount.mockResolvedValue(0);

      await repo.listOpportunities('org1', {} as any);
      expect(stateFindMany.mock.calls[0][0].where).not.toHaveProperty(
        'matchedKeywords'
      );
    });

    it('applies a postPublishedAt lower bound when date=today', async () => {
      const { repo, stateFindMany, stateCount } = buildRepo();
      stateFindMany.mockResolvedValue([]);
      stateCount.mockResolvedValue(0);

      await repo.listOpportunities('org1', { date: 'today' } as any);
      const oppWhere = stateFindMany.mock.calls[0][0].where.opportunity;
      expect(oppWhere.postPublishedAt.gte).toBeInstanceOf(Date);
      expect(oppWhere.postPublishedAt.lte).toBeUndefined();
    });

    it('applies an exact postPublishedAt upper bound when endDate is given, with no rounding', async () => {
      const { repo, stateFindMany, stateCount } = buildRepo();
      stateFindMany.mockResolvedValue([]);
      stateCount.mockResolvedValue(0);

      await repo.listOpportunities('org1', {
        endDate: '2026-06-30T10:15:00.000Z',
      } as any);
      const oppWhere = stateFindMany.mock.calls[0][0].where.opportunity;
      expect(oppWhere.postPublishedAt).toEqual({
        lte: dayjs.utc('2026-06-30T10:15:00.000Z').toDate(),
      });
    });

    it('applies an exact postPublishedAt lower bound when startDate is given', async () => {
      const { repo, stateFindMany, stateCount } = buildRepo();
      stateFindMany.mockResolvedValue([]);
      stateCount.mockResolvedValue(0);

      await repo.listOpportunities('org1', {
        startDate: '2026-06-27T10:15:00.000Z',
      } as any);
      const oppWhere = stateFindMany.mock.calls[0][0].where.opportunity;
      expect(oppWhere.postPublishedAt).toEqual({
        gte: dayjs.utc('2026-06-27T10:15:00.000Z').toDate(),
      });
    });

    it('lets startDate take priority over date when both are given', async () => {
      const { repo, stateFindMany, stateCount } = buildRepo();
      stateFindMany.mockResolvedValue([]);
      stateCount.mockResolvedValue(0);

      await repo.listOpportunities('org1', {
        date: 'week',
        startDate: '2026-06-27T10:15:00.000Z',
      } as any);
      const oppWhere = stateFindMany.mock.calls[0][0].where.opportunity;
      expect(oppWhere.postPublishedAt.gte).toEqual(
        dayjs.utc('2026-06-27T10:15:00.000Z').toDate()
      );
    });

    it('combines startDate (lower bound) and endDate (upper bound) into one rolling window', async () => {
      const { repo, stateFindMany, stateCount } = buildRepo();
      stateFindMany.mockResolvedValue([]);
      stateCount.mockResolvedValue(0);

      await repo.listOpportunities('org1', {
        startDate: '2026-06-27T10:15:00.000Z',
        endDate: '2026-06-30T10:15:00.000Z',
      } as any);
      const oppWhere = stateFindMany.mock.calls[0][0].where.opportunity;
      expect(oppWhere.postPublishedAt).toEqual({
        gte: dayjs.utc('2026-06-27T10:15:00.000Z').toDate(),
        lte: dayjs.utc('2026-06-30T10:15:00.000Z').toDate(),
      });
    });

    it('omits postPublishedAt entirely when none of date/startDate/endDate is given', async () => {
      const { repo, stateFindMany, stateCount } = buildRepo();
      stateFindMany.mockResolvedValue([]);
      stateCount.mockResolvedValue(0);

      await repo.listOpportunities('org1', {} as any);
      expect(
        stateFindMany.mock.calls[0][0].where.opportunity
      ).not.toHaveProperty('postPublishedAt');
    });

    it('attaches replyLink + sentReplyId from the latest sent reply', async () => {
      const { repo, stateFindMany, stateCount, sentFindMany } = buildRepo();
      stateFindMany.mockResolvedValue([STATE_ROW]);
      stateCount.mockResolvedValue(1);
      sentFindMany.mockResolvedValue([
        {
          id: 'reply-new',
          opportunityId: 'opp1',
          post: { releaseURL: 'https://x.com/a/status/1' },
        },
      ]);

      const item = (await repo.listOpportunities('org1', {} as any))
        .items[0] as any;
      expect(item.sentReplyId).toBe('reply-new');
      expect(item.replyLink).toBe('https://x.com/a/status/1');
      // The feed's reply-link lookup must EXCLUDE unsent DRAFT working-copies, so a
      // saved draft never makes an opportunity look "already replied".
      expect(sentFindMany.mock.calls[0][0].where.post).toEqual({
        state: { not: 'DRAFT' },
      });
    });

    it('reports replyLink null when the latest reply has no URL (pending backfill)', async () => {
      const { repo, stateFindMany, stateCount, sentFindMany } = buildRepo();
      stateFindMany.mockResolvedValue([STATE_ROW]);
      stateCount.mockResolvedValue(1);
      sentFindMany.mockResolvedValue([
        {
          id: 'reply-pending',
          opportunityId: 'opp1',
          post: { releaseURL: null },
        },
      ]);

      const item = (await repo.listOpportunities('org1', {} as any))
        .items[0] as any;
      expect(item.sentReplyId).toBe('reply-pending');
      expect(item.replyLink).toBeNull();
    });

    it('routes an opportunity-owned sort field through the nested relation', async () => {
      const { repo, stateFindMany, stateCount } = buildRepo();
      stateFindMany.mockResolvedValue([]);
      stateCount.mockResolvedValue(0);

      await repo.listOpportunities('org1', {
        sortBy: 'scoreHeat',
        sortOrder: 'desc',
      } as any);
      expect(stateFindMany.mock.calls[0][0].orderBy).toEqual([
        { opportunity: { scoreHeat: 'desc' } },
        { opportunity: { postPublishedAt: 'desc' } },
        // Final unique-key tiebreaker for stable pagination (locateOpportunity).
        { opportunityId: 'desc' },
      ]);
    });

    it('routes a state-owned sort field as a top-level column', async () => {
      const { repo, stateFindMany, stateCount } = buildRepo();
      stateFindMany.mockResolvedValue([]);
      stateCount.mockResolvedValue(0);

      await repo.listOpportunities('org1', {
        sortBy: 'score',
        sortOrder: 'desc',
      } as any);
      expect(stateFindMany.mock.calls[0][0].orderBy).toEqual([
        { score: 'desc' },
        { opportunity: { postPublishedAt: 'desc' } },
        { opportunityId: 'desc' },
      ]);
    });

    it('breaks postPublishedAt-sorted ties by highest score', async () => {
      const { repo, stateFindMany, stateCount } = buildRepo();
      stateFindMany.mockResolvedValue([]);
      stateCount.mockResolvedValue(0);

      await repo.listOpportunities('org1', {
        sortBy: 'postPublishedAt',
        sortOrder: 'desc',
      } as any);
      expect(stateFindMany.mock.calls[0][0].orderBy).toEqual([
        { opportunity: { postPublishedAt: 'desc' } },
        { score: 'desc' },
        { opportunityId: 'desc' },
      ]);
    });

    it('scopes the query to the org and project via the state table', async () => {
      const { repo, stateFindMany, stateCount } = buildRepo();
      stateFindMany.mockResolvedValue([]);
      stateCount.mockResolvedValue(0);

      await repo.listOpportunities('org1', { projectId: 'project-1' } as any);
      expect(stateFindMany.mock.calls[0][0].where.organizationId).toBe('org1');
      expect(stateFindMany.mock.calls[0][0].where.projectId).toBe('project-1');
      expect(
        stateFindMany.mock.calls[0][0].where.opportunity.deletedAt
      ).toBeNull();
    });

    // Channels and authors are both CASE-INSENSITIVE identity filters, each its
    // own OR set, combined through AND. Channels used to be an exact `in`, which
    // silently returned nothing once the scan-target key became normalized while
    // EngageOpportunity.channelId kept Reddit's display casing.
    it('channels=[<specific>] filters that channel id case-insensitively', async () => {
      const { repo, stateFindMany, stateCount } = buildRepo();
      stateFindMany.mockResolvedValue([]);
      stateCount.mockResolvedValue(0);

      await repo.listOpportunities('org1', { channels: ['SEO'] } as any);
      expect(stateFindMany.mock.calls[0][0].where.opportunity.AND).toEqual([
        { OR: [{ channelId: { equals: 'SEO', mode: 'insensitive' } }] },
      ]);
    });

    it('channels=[multiple] filters all listed channel ids case-insensitively', async () => {
      const { repo, stateFindMany, stateCount } = buildRepo();
      stateFindMany.mockResolvedValue([]);
      stateCount.mockResolvedValue(0);

      await repo.listOpportunities('org1', {
        channels: ['SEO', 'TECH'],
      } as any);
      expect(stateFindMany.mock.calls[0][0].where.opportunity.AND).toEqual([
        {
          OR: [
            { channelId: { equals: 'SEO', mode: 'insensitive' } },
            { channelId: { equals: 'TECH', mode: 'insensitive' } },
          ],
        },
      ]);
    });

    it('authors=[<specific>] filters authorUsername case-insensitively via OR', async () => {
      const { repo, stateFindMany, stateCount } = buildRepo();
      stateFindMany.mockResolvedValue([]);
      stateCount.mockResolvedValue(0);

      await repo.listOpportunities('org1', { authors: ['BobSmith'] } as any);
      expect(stateFindMany.mock.calls[0][0].where.opportunity.AND).toEqual([
        {
          OR: [{ authorUsername: { equals: 'BobSmith', mode: 'insensitive' } }],
        },
      ]);
    });

    it('authors=[multiple] filters all listed authors via OR', async () => {
      const { repo, stateFindMany, stateCount } = buildRepo();
      stateFindMany.mockResolvedValue([]);
      stateCount.mockResolvedValue(0);

      await repo.listOpportunities('org1', {
        authors: ['Alice', 'Bob'],
      } as any);
      expect(stateFindMany.mock.calls[0][0].where.opportunity.AND).toEqual([
        {
          OR: [
            { authorUsername: { equals: 'Alice', mode: 'insensitive' } },
            { authorUsername: { equals: 'Bob', mode: 'insensitive' } },
          ],
        },
      ]);
    });

    // Regression guard: the two axes must AND, not share one OR key — a row
    // matching only the author would otherwise pass a channel+author filter.
    it('channels + authors are ANDed as two separate OR sets', async () => {
      const { repo, stateFindMany, stateCount } = buildRepo();
      stateFindMany.mockResolvedValue([]);
      stateCount.mockResolvedValue(0);

      await repo.listOpportunities('org1', {
        channels: ['SEO'],
        authors: ['Alice'],
      } as any);
      expect(stateFindMany.mock.calls[0][0].where.opportunity.AND).toEqual([
        { OR: [{ channelId: { equals: 'SEO', mode: 'insensitive' } }] },
        { OR: [{ authorUsername: { equals: 'Alice', mode: 'insensitive' } }] },
      ]);
      expect(
        stateFindMany.mock.calls[0][0].where.opportunity
      ).not.toHaveProperty('OR');
    });
  });

  describe('getOpportunityById', () => {
    it('returns the same flat item shape as listOpportunities, including latest non-draft reply fields', async () => {
      const { repo, stateFindFirst, sentFindFirst } = buildRepo();
      stateFindFirst.mockResolvedValue(STATE_ROW);
      sentFindFirst.mockResolvedValue({
        id: 'reply-new',
        post: { releaseURL: 'https://x.com/a/status/1' },
      });

      const item = (await repo.getOpportunityById('org1', 'opp1')) as any;

      expect(item.id).toBe('opp1');
      expect(item.status).toBe('NEW');
      expect(item.bookmarked).toBe(true);
      expect(item.score).toBe(70);
      expect(item.scoreHeat).toBe(18);
      expect(item.matchedKeywords).toEqual(['react', 'nextjs']);
      expect(item).not.toHaveProperty('opportunity');
      expect(item.sentReplyId).toBe('reply-new');
      expect(item.replyLink).toBe('https://x.com/a/status/1');
      expect(item.channelAvatar).toBeNull();
      expect(sentFindFirst.mock.calls[0][0].where).toEqual({
        organizationId: 'org1',
        projectId: null,
        opportunityId: 'opp1',
        post: { state: { not: 'DRAFT' } },
      });
    });

    it('attaches a reddit channel avatar using the same field name as listOpportunities', async () => {
      const { repo, stateFindFirst, sentFindFirst, channelFindFirst } =
        buildRepo();
      stateFindFirst.mockResolvedValue({
        ...STATE_ROW,
        opportunity: {
          ...STATE_ROW.opportunity,
          platform: 'reddit',
          channelId: 'SEO',
        },
      });
      sentFindFirst.mockResolvedValue(null);
      channelFindFirst.mockResolvedValue({
        metadata: { avatar: 'https://styles.redditmedia.com/avatar.png' },
      });

      const item = (await repo.getOpportunityById('org1', 'opp1')) as any;

      expect(item.channelAvatar).toBe(
        'https://styles.redditmedia.com/avatar.png'
      );
      expect(item.sentReplyId).toBeNull();
      expect(item.replyLink).toBeNull();
      // The avatar comes off the merged scan-target row, so the lookup keys on
      // `username` — and NORMALIZED, because the stored key is lowercased while
      // the opportunity keeps Reddit's display casing ('SEO').
      expect(channelFindFirst.mock.calls[0][0].where).toEqual({
        platform: 'reddit',
        username: 'seo',
      });
    });
  });

  describe('listSentReplies', () => {
    it('selects lastMetricsFetchAt on every returned post', async () => {
      const { repo, sentFindMany, sentCount, stateFindMany } = buildRepo();
      sentFindMany.mockResolvedValue([]);
      sentCount.mockResolvedValue(0);
      stateFindMany.mockResolvedValue([]);

      await repo.listSentReplies('org1', {} as any);

      expect(
        sentFindMany.mock.calls[0][0].include.post.select.lastMetricsFetchAt
      ).toBe(true);
    });

    it('attaches per-org matchedKeywords to each opportunity via the state join', async () => {
      const { repo, sentFindMany, sentCount, stateFindMany } = buildRepo();
      sentFindMany.mockResolvedValue([
        {
          id: 's1',
          opportunity: { id: 'o1', platform: 'x' },
          post: { analytics: [], impressions: 0, trafficScore: 0 },
        },
        {
          id: 's2',
          opportunity: { id: 'o2', platform: 'reddit' },
          post: { analytics: [], impressions: 0, trafficScore: 0 },
        },
      ]);
      sentCount.mockResolvedValue(2);
      // Only o1 has a state row with keywords; o2 falls back to [].
      stateFindMany.mockResolvedValue([
        { opportunityId: 'o1', matchedKeywords: ['react', 'nextjs'] },
      ]);

      const res = await repo.listSentReplies('org1', {} as any);
      const [a, b] = res.items as any[];
      expect(a.opportunity.matchedKeywords).toEqual(['react', 'nextjs']);
      expect(b.opportunity.matchedKeywords).toEqual([]);
      // The state join is scoped to the org and the page's opportunity ids.
      expect(stateFindMany.mock.calls[0][0].where).toEqual({
        organizationId: 'org1',
        projectId: null,
        opportunityId: { in: ['o1', 'o2'] },
      });
    });

    it('attaches per-org generationHistory (newest-first) from the state join', async () => {
      const { repo, sentFindMany, sentCount, stateFindMany } = buildRepo();
      sentFindMany.mockResolvedValue([
        {
          id: 's1',
          opportunity: { id: 'o1', platform: 'x' },
          post: { analytics: [], impressions: 0, trafficScore: 0 },
        },
        {
          id: 's2',
          opportunity: { id: 'o2', platform: 'reddit' },
          post: { analytics: [], impressions: 0, trafficScore: 0 },
        },
      ]);
      sentCount.mockResolvedValue(2);
      // o1 has two generations stored oldest-first; o2 has none (null column).
      stateFindMany.mockResolvedValue([
        {
          opportunityId: 'o1',
          matchedKeywords: [],
          generationHistory: [
            {
              content: 'first',
              length: 'medium',
              cost: 3,
              billingTaskId: 't1',
              createdAt: '2026-06-16T00:00:00Z',
            },
            {
              content: 'second',
              length: 'long',
              cost: 5,
              billingTaskId: 't2',
              createdAt: '2026-06-16T01:00:00Z',
            },
          ],
        },
        { opportunityId: 'o2', matchedKeywords: [], generationHistory: null },
      ]);

      const res = await repo.listSentReplies('org1', {} as any);
      const [a, b] = res.items as any[];
      // Reversed → newest generation first.
      expect(
        a.opportunity.generationHistory.map((g: any) => g.content)
      ).toEqual(['second', 'first']);
      // null column / missing state → empty array, never undefined.
      expect(b.opportunity.generationHistory).toEqual([]);
      // The state select pulls generationHistory alongside matchedKeywords.
      expect(stateFindMany.mock.calls[0][0].select).toMatchObject({
        generationHistory: true,
      });
    });

    it('attaches per-org opportunity status from the state join (null when no state row)', async () => {
      const { repo, sentFindMany, sentCount, stateFindMany } = buildRepo();
      sentFindMany.mockResolvedValue([
        {
          id: 's1',
          opportunity: { id: 'o1', platform: 'x' },
          post: { analytics: [], impressions: 0, trafficScore: 0 },
        },
        {
          id: 's2',
          opportunity: { id: 'o2', platform: 'reddit' },
          post: { analytics: [], impressions: 0, trafficScore: 0 },
        },
      ]);
      sentCount.mockResolvedValue(2);
      // Only o1 has a state row; o2 has no row → status falls back to null.
      stateFindMany.mockResolvedValue([
        { opportunityId: 'o1', matchedKeywords: [], status: 'REPLIED' },
      ]);

      const res = await repo.listSentReplies('org1', {} as any);
      const [a, b] = res.items as any[];
      expect(a.opportunity.status).toBe('REPLIED');
      expect(b.opportunity.status).toBeNull();
      // The state select pulls status alongside matchedKeywords/generationHistory.
      expect(stateFindMany.mock.calls[0][0].select).toMatchObject({
        status: true,
      });
    });

    it('exposes a unified replyAuthor: from integration when present, else settings.engageAuthor', async () => {
      const { repo, sentFindMany, sentCount, stateFindMany } = buildRepo();
      sentFindMany.mockResolvedValue([
        {
          // Connected account authored the reply → replyAuthor comes from integration.
          id: 's1',
          opportunity: { id: 'o1', platform: 'x' },
          post: {
            analytics: [],
            impressions: 0,
            trafficScore: 0,
            integration: {
              id: 'int1',
              name: '0xKyd',
              providerIdentifier: 'x',
              picture: 'https://files/0xkyd.jpg',
              profile: '@0xKyd',
              internalId: '999',
            },
            settings: JSON.stringify({ __type: 'x' }),
          },
        },
        {
          // External account → replyAuthor comes from settings.engageAuthor.
          id: 's2',
          opportunity: { id: 'o2', platform: 'x' },
          post: {
            analytics: [],
            impressions: 0,
            trafficScore: 0,
            integration: null,
            settings: JSON.stringify({
              __type: 'x',
              engageAuthor: {
                handle: 'zhngyq310334',
                id: '7',
                name: '张玉琪',
                avatarUrl: 'https://files/zq.png',
              },
            }),
          },
        },
      ]);
      sentCount.mockResolvedValue(2);
      stateFindMany.mockResolvedValue([]);

      const res = await repo.listSentReplies('org1', {} as any);
      const [a, b] = res.items as any[];
      // From integration: handle de-@'d, id=internalId, name + avatar from picture.
      expect(a.post.replyAuthor).toEqual({
        handle: '0xKyd',
        id: '999',
        name: '0xKyd',
        avatarUrl: 'https://files/0xkyd.jpg',
      });
      // From settings.engageAuthor.
      expect(b.post.replyAuthor).toEqual({
        handle: 'zhngyq310334',
        id: '7',
        name: '张玉琪',
        avatarUrl: 'https://files/zq.png',
      });
      // Raw settings is stripped from the response.
      expect('settings' in a.post).toBe(false);
    });
  });

  describe('listSentRepliesForAdmin', () => {
    const ADMIN_ROW = {
      id: 's1',
      createdAt: new Date('2026-07-24T00:00:00Z'),
      projectId: null,
      matchedKeywords: ['react'],
      organization: {
        id: 'org1',
        name: 'Acme',
        users: [{ userId: 'u1' }],
      },
      opportunity: {
        id: 'o1',
        platform: 'x',
        externalPostUrl: 'https://x.com/p/1',
        postContent: 'original',
        authorUsername: 'bob',
      },
      post: {
        id: 'p1',
        content: 'reply body',
        state: 'PUBLISHED',
        analytics: [],
        impressions: 42,
        trafficScore: 7,
        integration: {
          id: 'int1',
          name: '0xKyd',
          providerIdentifier: 'x',
          picture: 'https://files/0xkyd.jpg',
          profile: '@0xKyd',
          internalId: '999',
        },
        settings: JSON.stringify({ __type: 'x' }),
      },
    };

    it('returns the admin envelope (results/total/page/pageSize/totalPages)', async () => {
      const { repo, sentFindMany, sentCount } = buildRepo();
      sentFindMany.mockResolvedValue([]);
      sentCount.mockResolvedValue(0);

      const res = await repo.listSentRepliesForAdmin({ page: 2, pageSize: 15 });
      expect(res).toEqual({
        results: [],
        total: 0,
        page: 2,
        pageSize: 15,
        totalPages: 0,
      });
      // page 2 of size 15 → skip 15, take 15.
      expect(sentFindMany.mock.calls[0][0].skip).toBe(15);
      expect(sentFindMany.mock.calls[0][0].take).toBe(15);
    });

    it('scopes to organizationId (array → { in }) and maps platform/state to where', async () => {
      const { repo, sentFindMany, sentCount } = buildRepo();
      sentFindMany.mockResolvedValue([]);
      sentCount.mockResolvedValue(0);

      await repo.listSentRepliesForAdmin({
        organizationId: ['org1', 'org2'],
        platform: 'reddit',
        state: 'ERROR' as any,
      });
      const where = sentFindMany.mock.calls[0][0].where;
      expect(where.organizationId).toEqual({ in: ['org1', 'org2'] });
      expect(where.post).toEqual({ source: 'engage', state: 'ERROR' });
      expect(where.opportunity).toEqual({ platform: 'reddit' });
    });

    it('finds one source post by externalPostUrl, normalising the pasted URL', async () => {
      // A URL copied from the X app carries twitter.com + tracking params; the
      // row is stored canonicalised, so an un-normalised match would find nothing.
      const { repo, sentFindMany, sentCount } = buildRepo();
      sentFindMany.mockResolvedValue([]);
      sentCount.mockResolvedValue(0);

      await repo.listSentRepliesForAdmin({
        externalPostUrl: '  https://twitter.com/alex/status/2090431343046095255?s=20  ',
      });
      expect(sentFindMany.mock.calls[0][0].where.opportunity).toEqual({
        externalPostUrl: {
          contains: 'https://x.com/alex/status/2090431343046095255',
          mode: 'insensitive',
        },
      });
    });

    it('accepts a bare status id as the search term', async () => {
      const { repo, sentFindMany, sentCount } = buildRepo();
      sentFindMany.mockResolvedValue([]);
      sentCount.mockResolvedValue(0);

      await repo.listSentRepliesForAdmin({ externalPostUrl: '2090431343046095255' });
      expect(sentFindMany.mock.calls[0][0].where.opportunity).toEqual({
        externalPostUrl: {
          contains: '2090431343046095255',
          mode: 'insensitive',
        },
      });
    });

    it('MERGES platform and externalPostUrl into one opportunity filter', async () => {
      // Written as two `opportunity` keys the second would overwrite the first,
      // silently dropping a filter the caller asked for.
      const { repo, sentFindMany, sentCount } = buildRepo();
      sentFindMany.mockResolvedValue([]);
      sentCount.mockResolvedValue(0);

      await repo.listSentRepliesForAdmin({
        platform: 'x',
        externalPostUrl: 'https://x.com/alex/status/209',
      });
      expect(sentFindMany.mock.calls[0][0].where.opportunity).toEqual({
        platform: 'x',
        externalPostUrl: {
          contains: 'https://x.com/alex/status/209',
          mode: 'insensitive',
        },
      });
    });

    it('ignores a blank externalPostUrl rather than matching everything', async () => {
      const { repo, sentFindMany, sentCount } = buildRepo();
      sentFindMany.mockResolvedValue([]);
      sentCount.mockResolvedValue(0);

      await repo.listSentRepliesForAdmin({ externalPostUrl: '   ' });
      expect(sentFindMany.mock.calls[0][0].where.opportunity).toBeUndefined();
    });

    it('omits org/platform/state filters when not provided (all-orgs)', async () => {
      const { repo, sentFindMany, sentCount } = buildRepo();
      sentFindMany.mockResolvedValue([]);
      sentCount.mockResolvedValue(0);

      await repo.listSentRepliesForAdmin({});
      const where = sentFindMany.mock.calls[0][0].where;
      expect(where.organizationId).toBeUndefined();
      expect(where.opportunity).toBeUndefined();
      expect(where.post).toEqual({ source: 'engage' });
    });

    it('enriches each row with org, userId, platform, replyAuthor and metrics', async () => {
      const { repo, sentFindMany, sentCount } = buildRepo();
      sentFindMany.mockResolvedValue([ADMIN_ROW]);
      sentCount.mockResolvedValue(1);

      const res = await repo.listSentRepliesForAdmin({});
      const row = res.results[0] as any;
      expect(row.organization).toEqual({ id: 'org1', name: 'Acme' });
      expect(row.userId).toBe('u1');
      expect(row.platform).toBe('x');
      expect(row.post.replyAuthor).toEqual({
        handle: '0xKyd',
        id: '999',
        name: '0xKyd',
        avatarUrl: 'https://files/0xkyd.jpg',
      });
      // metrics flattened from analytics; impressions falls back to the column.
      expect(row.post.metrics.impressions).toBe(42);
      expect(row.post.metrics.trafficScore).toBe(7);
      // raw settings stripped from the response.
      expect('settings' in row.post).toBe(false);
    });

    it('falls back to userId null when the org has no admin users', async () => {
      const { repo, sentFindMany, sentCount } = buildRepo();
      sentFindMany.mockResolvedValue([
        { ...ADMIN_ROW, organization: { id: 'org1', name: 'Acme', users: [] } },
      ]);
      sentCount.mockResolvedValue(1);

      const res = await repo.listSentRepliesForAdmin({});
      expect((res.results[0] as any).userId).toBeNull();
    });
  });

  describe('getSentReplyItemById', () => {
    it('returns the same decorated item shape as listSentReplies', async () => {
      const { repo, sentFindFirst, stateFindFirst } = buildRepo();
      sentFindFirst.mockResolvedValue({
        id: 'sent1',
        organizationId: 'org1',
        opportunityId: 'opp1',
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
        inputData: { strategy: 'helpful' },
        post: {
          id: 'post1',
          content: 'reply text',
          state: 'PUBLISHED',
          releaseURL: 'https://x.com/me/status/2',
          publishDate: new Date('2026-07-01T01:00:00.000Z'),
          impressions: 10,
          trafficScore: 3,
          analytics: [],
          lastMetricsFetchAt: null,
          integration: {
            id: 'int1',
            name: '0xKyd',
            providerIdentifier: 'x',
            picture: 'https://files/0xkyd.jpg',
            profile: '@0xKyd',
            internalId: '999',
          },
          settings: JSON.stringify({ __type: 'x' }),
        },
        opportunity: {
          id: 'opp1',
          platform: 'x',
          externalPostUrl: 'https://x.com/author/status/1',
          postContent: 'original post',
          authorUsername: 'author',
          authorDisplayName: 'Author',
          authorFollowers: 100,
          authorAvatarUrl: 'https://files/author.jpg',
          postPublishedAt: new Date('2026-07-01T00:30:00.000Z'),
        },
      });
      stateFindFirst.mockResolvedValue({
        matchedKeywords: ['react'],
        status: 'REPLIED',
        generationHistory: [
          {
            content: 'first',
            length: 'medium',
            cost: 3,
            billingTaskId: 't1',
            createdAt: '2026-07-01T00:00:00Z',
          },
          {
            content: 'second',
            length: 'long',
            cost: 5,
            billingTaskId: 't2',
            createdAt: '2026-07-01T00:10:00Z',
          },
        ],
      });

      const item = (await repo.getSentReplyItemById('org1', 'sent1')) as any;

      expect(item.id).toBe('sent1');
      expect(item.opportunity).toMatchObject({
        id: 'opp1',
        status: 'REPLIED',
        matchedKeywords: ['react'],
      });
      expect(
        item.opportunity.generationHistory.map((g: any) => g.content)
      ).toEqual(['second', 'first']);
      expect(item.post.replyAuthor).toEqual({
        handle: '0xKyd',
        id: '999',
        name: '0xKyd',
        avatarUrl: 'https://files/0xkyd.jpg',
      });
      expect(item.post.metrics).toBeDefined();
      expect('settings' in item.post).toBe(false);
      expect(sentFindFirst.mock.calls[0][0].where).toEqual({
        id: 'sent1',
        organizationId: 'org1',
      });
      expect(stateFindFirst.mock.calls[0][0].where).toEqual({
        organizationId: 'org1',
        projectId: null,
        opportunityId: 'opp1',
      });
    });

    it('falls back to empty opportunity decorations when the org state row is missing', async () => {
      const { repo, sentFindFirst, stateFindFirst } = buildRepo();
      sentFindFirst.mockResolvedValue({
        id: 'sent1',
        opportunity: { id: 'opp1', platform: 'reddit' },
        post: {
          analytics: [],
          impressions: 0,
          trafficScore: 0,
          integration: null,
          settings: null,
        },
      });
      stateFindFirst.mockResolvedValue(null);

      const item = (await repo.getSentReplyItemById('org1', 'sent1')) as any;

      expect(item.opportunity.status).toBeNull();
      expect(item.opportunity.matchedKeywords).toEqual([]);
      expect(item.opportunity.generationHistory).toEqual([]);
      expect(item.post.replyAuthor).toBeNull();
    });
  });

  describe('getScoreStats', () => {
    it('sources objective averages from the opportunity aggregate, org scores from state', async () => {
      const {
        repo,
        stateAggregate,
        stateCount,
        stateFindMany,
        stateFindFirst,
        oppAggregate,
        oppFindFirst,
      } = buildRepo();
      stateAggregate.mockResolvedValue({
        _count: { _all: 5 },
        _avg: { score: 72, scoreKeyword: 31, scoreTracked: 2 },
      });
      oppAggregate.mockResolvedValue({
        _avg: { scoreHeat: 20, scoreAuthority: 9, scoreRecency: 3 },
      });
      stateFindMany.mockResolvedValue([
        { score: 90 },
        { score: 75 },
        { score: 65 },
      ]);
      stateCount.mockResolvedValue(2);
      stateFindFirst.mockResolvedValue({
        opportunityId: 'opp1',
        scoreKeyword: 35,
        opportunity: { postContent: 'best keyword post' },
      });
      oppFindFirst
        .mockResolvedValueOnce({
          id: 'oppH',
          scoreHeat: 35,
          postContent: 'hot',
        })
        .mockResolvedValueOnce({
          id: 'oppA',
          scoreAuthority: 20,
          postContent: 'auth',
        });

      const stats = await repo.getScoreStats('org1');
      expect(stats.total).toBe(5);
      expect(stats.avgScore).toBe(72);          // state aggregate
      expect(stats.avgScoreHeat).toBe(20);       // opportunity aggregate
      expect(stats.avgScoreAuthority).toBe(9);   // opportunity aggregate
      expect(stats.trackedCount).toBe(2);
      expect(stats.topByKeyword).toEqual({
        id: 'opp1',
        score: 35,
        title: 'best keyword post',
      });
      expect(stats.topByHeat).toEqual({ id: 'oppH', score: 35, title: 'hot' });
    });

    it('returns a zeroed shape when the org has no state rows', async () => {
      const {
        repo,
        stateAggregate,
        stateCount,
        stateFindMany,
        stateFindFirst,
        oppAggregate,
        oppFindFirst,
      } = buildRepo();
      stateAggregate.mockResolvedValue({ _count: { _all: 0 }, _avg: {} });
      oppAggregate.mockResolvedValue({ _avg: {} });
      stateFindMany.mockResolvedValue([]);
      stateCount.mockResolvedValue(0);
      stateFindFirst.mockResolvedValue(null);
      oppFindFirst.mockResolvedValue(null);

      const stats = await repo.getScoreStats('org1');
      expect(stats.total).toBe(0);
      expect(stats.topByKeyword).toBeNull();
    });
  });

  describe('getDashboardSummary (panel ①)', () => {
    it('computes response rate, X-only impressions/traffic, all-time platform split, and best reply', async () => {
      const { repo, sentCount, sentFindMany, postAggregate } = buildRepo();
      // Promise.all order: total, replied, sentReplies, then one count per
      // OPPORTUNITY_COUNT_PLATFORMS entry (x, reddit, linkedin, medium, devto,
      // hackernews, quora).
      sentCount
        .mockResolvedValueOnce(10)
        .mockResolvedValueOnce(4)
        .mockResolvedValueOnce(6)
        .mockResolvedValueOnce(4) // x
        .mockResolvedValueOnce(2) // reddit
        .mockResolvedValueOnce(0) // linkedin
        .mockResolvedValueOnce(0) // medium
        .mockResolvedValueOnce(0) // devto
        .mockResolvedValueOnce(0) // hackernews
        .mockResolvedValueOnce(0); // quora
      postAggregate.mockResolvedValue({
        _sum: { impressions: 1200, trafficScore: 87.6 },
      });
      sentFindMany.mockResolvedValue([
        {
          opportunity: {
            id: 'o1',
            platform: 'x',
            externalPostUrl: 'u1',
            authorUsername: 'alice',
            authorDisplayName: 'Alice',
            authorAvatarUrl: 'a.png',
          },
          post: {
            content: 'a',
            releaseURL: 'r1',
            analytics: [{ label: 'like_count', data: [{ total: '5' }] }],
          },
        },
        {
          opportunity: {
            id: 'o2',
            platform: 'reddit',
            externalPostUrl: 'u2',
            authorUsername: 'bob',
            authorDisplayName: null,
            authorAvatarUrl: null,
          },
          post: {
            content: 'b',
            releaseURL: null,
            analytics: [{ label: 'score', data: [{ total: '12' }] }],
          },
        },
      ]);

      const stats = await repo.getDashboardSummary('org1');
      expect(stats.repliesCount).toBe(6);
      expect(stats.responseRate).toBe(40); // 4/10
      expect(stats.xImpressions).toBe(1200);
      expect(stats.xTrafficIndex).toBe(88); // round(87.6)
      expect(stats.totalImpressions).toBe(1200);
      expect(stats.totalTrafficScore).toBe(88);
      expect(stats.totalLikes).toBe(17);
      expect(stats.platformSplit).toEqual({
        x: 4,
        reddit: 2,
        linkedin: 0,
        medium: 0,
        devto: 0,
        hackernews: 0,
        quora: 0,
      });
      // repliesCount / platformSplit are ALL-TIME, PUBLISHED-only (no week window).
      expect(sentCount.mock.calls[2][0].where.post.is).toEqual({
        source: 'engage',
        state: 'PUBLISHED',
      });
      expect(
        sentCount.mock.calls[2][0].where.post.is.publishDate
      ).toBeUndefined();
      // Best reply is the Reddit one (score 12 > like 5); url falls back to externalPostUrl;
      // includes the original author's account info.
      expect(stats.bestReply).toEqual({
        opportunityId: 'o2',
        platform: 'reddit',
        content: 'b',
        likes: 12,
        url: 'u2',
        author: { username: 'bob', displayName: null, avatarUrl: null },
      });
    });

    it('scopes headline stats and best reply when a platform filter is provided', async () => {
      const { repo, sentCount, sentFindMany, postAggregate } = buildRepo();
      sentCount
        .mockResolvedValueOnce(5)
        .mockResolvedValueOnce(4)
        .mockResolvedValueOnce(2)
        .mockResolvedValueOnce(6) // x
        .mockResolvedValueOnce(2) // reddit
        .mockResolvedValueOnce(0) // linkedin
        .mockResolvedValueOnce(0) // medium
        .mockResolvedValueOnce(0) // devto
        .mockResolvedValueOnce(0) // hackernews
        .mockResolvedValueOnce(0); // quora
      postAggregate
        .mockResolvedValueOnce({
          _sum: { impressions: 900, trafficScore: 234.2 },
        }) // headline
        .mockResolvedValueOnce({
          _sum: { impressions: 1200, trafficScore: 87.6 },
        }) // x
        .mockResolvedValueOnce({
          _sum: { impressions: 700, trafficScore: 50 },
        }) // reddit
        .mockResolvedValueOnce({ _sum: { impressions: 0, trafficScore: 0 } }) // linkedin
        .mockResolvedValueOnce({ _sum: { impressions: 0, trafficScore: 0 } }) // medium
        .mockResolvedValueOnce({ _sum: { impressions: 0, trafficScore: 0 } }) // devto
        .mockResolvedValueOnce({ _sum: { impressions: 0, trafficScore: 0 } }) // hackernews
        .mockResolvedValueOnce({ _sum: { impressions: 0, trafficScore: 0 } }); // quora
      sentFindMany
        .mockResolvedValueOnce([
          {
            opportunity: { platform: 'reddit' },
            post: { analytics: [{ label: 'score', data: [{ total: '12' }] }] },
          },
        ])
        .mockResolvedValueOnce([
          {
            opportunity: {
              id: 'o2',
              platform: 'reddit',
              externalPostUrl: 'u2',
            },
            post: {
              content: 'b',
              releaseURL: null,
              analytics: [{ label: 'score', data: [{ total: '12' }] }],
            },
          },
        ]);

      const stats = await repo.getDashboardSummary('org1', {
        platform: 'reddit',
      });

      expect(stats.repliesCount).toBe(2);
      expect(stats.responseRate).toBe(80); // 4/5
      expect(stats.totalImpressions).toBe(900);
      expect(stats.totalTrafficScore).toBe(234);
      expect(stats.totalLikes).toBe(12);
      expect(stats.xImpressions).toBe(1200); // legacy helper remains X-only
      expect(stats.xTrafficIndex).toBe(88);
      expect(stats.bestReply?.platform).toBe('reddit');
      expect(sentCount.mock.calls[0][0].where.opportunity).toEqual({
        platform: 'reddit',
      });
      expect(sentCount.mock.calls[1][0].where.opportunity).toEqual({
        platform: 'reddit',
      });
      expect(sentCount.mock.calls[2][0].where.opportunity).toEqual({
        platform: 'reddit',
      });
      expect(postAggregate.mock.calls[0][0].where.engageSentReply).toEqual({
        is: { opportunity: { platform: 'reddit' } },
      });
      expect(sentFindMany.mock.calls[0][0].where.opportunity).toEqual({
        platform: 'reddit',
      });
      expect(sentFindMany.mock.calls[1][0].where.opportunity).toEqual({
        platform: 'reddit',
      });
    });

    it('returns bestReply=null and responseRate=0 when there is no engagement data', async () => {
      const { repo, sentCount, sentFindMany, postAggregate } = buildRepo();
      sentCount.mockResolvedValue(0);
      postAggregate.mockResolvedValue({
        _sum: { impressions: null, trafficScore: null },
      });
      sentFindMany.mockResolvedValue([]);

      const stats = await repo.getDashboardSummary('org1');
      expect(stats.responseRate).toBe(0);
      expect(stats.xImpressions).toBe(0);
      expect(stats.xTrafficIndex).toBe(0);
      expect(stats.bestReply).toBeNull();
    });

    it('date=month applies a publishDate window to counts and aggregates', async () => {
      const { repo, sentCount, sentFindMany, postAggregate } = buildRepo();
      sentCount.mockResolvedValue(0);
      postAggregate.mockResolvedValue({
        _sum: { impressions: 0, trafficScore: 0 },
      });
      sentFindMany.mockResolvedValue([]);

      await repo.getDashboardSummary('org1', { date: 'month' });

      // repliesCount (3rd count) → PUBLISHED + month window.
      const sentWhere = sentCount.mock.calls[2][0].where.post.is;
      expect(sentWhere.source).toBe('engage');
      expect(sentWhere.state).toBe('PUBLISHED');
      expect(sentWhere.publishDate.gte).toBeInstanceOf(Date);
      // responseRate denominator (1st count) → any SENT state (drafts excluded), windowed.
      const totalWhere = sentCount.mock.calls[0][0].where.post.is;
      expect(totalWhere.publishDate.gte).toBeInstanceOf(Date);
      expect(totalWhere.state).toEqual({ not: 'DRAFT' });
      // Headline impressions aggregate (1st aggregate) is windowed too.
      expect(
        postAggregate.mock.calls[0][0].where.publishDate.gte
      ).toBeInstanceOf(Date);
    });

    it('no date / "all" applies no publishDate window', async () => {
      const { repo, sentCount, sentFindMany, postAggregate } = buildRepo();
      sentCount.mockResolvedValue(0);
      postAggregate.mockResolvedValue({
        _sum: { impressions: 0, trafficScore: 0 },
      });
      sentFindMany.mockResolvedValue([]);

      await repo.getDashboardSummary('org1', { date: 'all' });

      expect(
        sentCount.mock.calls[2][0].where.post.is.publishDate
      ).toBeUndefined();
      expect(postAggregate.mock.calls[0][0].where.publishDate).toBeUndefined();
    });
  });

  describe('getDashboardRepliesTrend (panel ②)', () => {
    it('seeds a continuous window and buckets replies by publish day and platform', async () => {
      const { repo, sentFindMany } = buildRepo();
      sentFindMany.mockResolvedValue([
        { opportunity: { platform: 'x' }, post: { publishDate: new Date() } },
        {
          opportunity: { platform: 'reddit' },
          post: { publishDate: new Date() },
        },
        { opportunity: { platform: 'x' }, post: { publishDate: null } }, // ignored
      ]);

      const res = await repo.getDashboardRepliesTrend('org1', 'daily');
      expect(res.period).toBe('daily');
      expect(res.items).toHaveLength(30); // daily → 30 zero-filled continuous buckets
      const totals = res.items.reduce(
        (a, b) => ({
          count: a.count + b.count,
          x: a.x + b.x,
          reddit: a.reddit + b.reddit,
        }),
        { count: 0, x: 0, reddit: 0 }
      );
      expect(totals).toEqual({ count: 2, x: 1, reddit: 1 }); // null publishDate dropped
    });
  });

  describe('getDashboardTraffics (panel ③)', () => {
    it('returns total traffic index and a per-reply breakdown sorted by traffic', async () => {
      const { repo, sentFindMany, postAggregate } = buildRepo();
      postAggregate.mockResolvedValue({ _sum: { trafficScore: 42.4 } });
      sentFindMany.mockResolvedValue([
        {
          opportunity: { id: 'o1', platform: 'x', externalPostUrl: 'u1' },
          post: {
            content: 'c',
            releaseURL: 'r1',
            publishDate: new Date('2026-05-20'),
            trafficScore: 30.2,
          },
        },
        {
          opportunity: { id: 'o2', platform: 'reddit', externalPostUrl: 'u2' },
          post: {
            content: 'd',
            releaseURL: null,
            publishDate: new Date('2026-05-19'),
            trafficScore: 12,
          },
        },
      ]);

      const res = await repo.getDashboardTraffics('org1', { limit: 5 });
      expect(res.totalClicks).toBe(42); // round(42.4)
      expect(res.items).toHaveLength(2);
      expect(res.items[0]).toMatchObject({
        opportunityId: 'o1',
        clicks: 30,
        url: 'r1',
      });
      expect(res.items[1]).toMatchObject({
        opportunityId: 'o2',
        clicks: 12,
        url: 'u2',
      }); // releaseURL null → externalPostUrl
      // top-N ordering and platform filter wiring
      expect(sentFindMany.mock.calls[0][0].orderBy).toEqual({
        post: { trafficScore: 'desc' },
      });
      expect(sentFindMany.mock.calls[0][0].take).toBe(5);
    });

    it('scopes the aggregate and list to a platform when provided', async () => {
      const { repo, sentFindMany, postAggregate } = buildRepo();
      postAggregate.mockResolvedValue({ _sum: { trafficScore: 0 } });
      sentFindMany.mockResolvedValue([]);

      await repo.getDashboardTraffics('org1', { platform: 'x' });
      expect(postAggregate.mock.calls[0][0].where.engageSentReply).toEqual({
        is: { opportunity: { platform: 'x' } },
      });
      expect(sentFindMany.mock.calls[0][0].where.opportunity).toEqual({
        platform: 'x',
      });
      expect(sentFindMany.mock.calls[0][0].take).toBe(10); // default limit
    });
  });

  describe('getDashboardImpressions (panel ④)', () => {
    it('buckets impressions by publish day + platform, sums duplicates, drops null dates, sorts', async () => {
      const { repo, postFindMany } = buildRepo();
      postFindMany.mockResolvedValue([
        {
          impressions: 100,
          publishDate: new Date('2026-05-20T00:00:00Z'),
          engageSentReply: { opportunity: { platform: 'x' } },
        },
        {
          impressions: 50,
          publishDate: new Date('2026-05-20T12:00:00Z'),
          engageSentReply: { opportunity: { platform: 'x' } },
        }, // same day+x → 150
        {
          impressions: 30,
          publishDate: new Date('2026-05-20T06:00:00Z'),
          engageSentReply: { opportunity: { platform: 'reddit' } },
        },
        {
          impressions: 20,
          publishDate: new Date('2026-05-21T00:00:00Z'),
          engageSentReply: null,
        }, // no reply → 'unknown'
        {
          impressions: 999,
          publishDate: null,
          engageSentReply: { opportunity: { platform: 'x' } },
        }, // dropped (null date)
      ]);

      const res = await repo.getDashboardImpressions('org1'); // defaults to 'daily'

      // Sorted by date then platform; null-date row excluded.
      expect(res).toEqual([
        { date: '2026-05-20', platform: 'reddit', value: 30 },
        { date: '2026-05-20', platform: 'x', value: 150 },
        { date: '2026-05-21', platform: 'unknown', value: 20 },
      ]);

      // Query is scoped to this org's engage posts within a publish-date window.
      const where = postFindMany.mock.calls[0][0].where;
      expect(where.organizationId).toBe('org1');
      expect(where.source).toBe('engage');
      expect(where.publishDate.gte).toBeInstanceOf(Date);
    });

    it('collapses same ISO week into one weekly bucket', async () => {
      const { repo, postFindMany } = buildRepo();
      // 2026-05-20 (Wed) and 2026-05-22 (Fri) share the same ISO week.
      postFindMany.mockResolvedValue([
        {
          impressions: 10,
          publishDate: new Date('2026-05-20T00:00:00Z'),
          engageSentReply: { opportunity: { platform: 'x' } },
        },
        {
          impressions: 5,
          publishDate: new Date('2026-05-22T00:00:00Z'),
          engageSentReply: { opportunity: { platform: 'x' } },
        },
      ]);

      const res = await repo.getDashboardImpressions('org1', 'weekly');

      // Bucket key = Monday of that ISO week (mirrors the implementation).
      const monday = dayjs.utc('2026-05-20').isoWeekday(1).format('YYYY-MM-DD');
      expect(res).toEqual([{ date: monday, platform: 'x', value: 15 }]);
    });
  });

  describe('getDashboardTopSources (panel ⑤)', () => {
    // Build a Post.analytics series the way the metrics sync stores it.
    const xAnalytics = (likes: number) => [
      { label: 'likes', data: [{ total: String(likes) }] },
    ];
    const redditAnalytics = (upvotes: number) => [
      { label: 'score', data: [{ total: String(upvotes) }] },
    ];

    it('ranks replies by likes (X) / upvotes (Reddit), each item by its own key, desc', async () => {
      const { repo, sentFindMany } = buildRepo();
      sentFindMany.mockResolvedValue([
        {
          id: 's1',
          opportunity: {
            id: 'o1',
            platform: 'x',
            authorUsername: 'alice',
            authorAvatarUrl: 'a.png',
          },
          post: {
            id: 'p1',
            content: 'cx',
            releaseURL: 'rx',
            analytics: xAnalytics(7),
            integration: { profile: '@me', picture: 'm.png' },
            settings: null,
          },
        },
        {
          id: 's2',
          opportunity: {
            id: 'o2',
            platform: 'reddit',
            authorUsername: 'bob',
            authorAvatarUrl: null,
          },
          post: {
            id: 'p2',
            content: 'cr',
            releaseURL: 'rr',
            analytics: redditAnalytics(20),
            integration: null,
            settings: null,
          },
        },
        {
          id: 's3',
          opportunity: {
            id: 'o3',
            platform: 'x',
            authorUsername: 'carol',
            authorAvatarUrl: null,
          },
          post: {
            id: 'p3',
            content: 'cx2',
            releaseURL: 'rx2',
            analytics: xAnalytics(3),
            integration: null,
            settings: null,
          },
        },
      ]);

      const res = await repo.getDashboardTopSources('org1', { limit: 10 });

      // reddit/20 > x/7 > x/3 — each ranked by its own platform metric.
      expect(res.items.map((i) => i.id)).toEqual(['s2', 's1', 's3']);
      expect(res.items[0].metric).toBe(20); // upvotes
      expect(res.items[1].metric).toBe(7); // likes
      // reply-author (the posting account) is surfaced for the panel.
      expect(res.items[1].post.replyAuthor).toMatchObject({
        handle: 'me',
        avatarUrl: 'm.png',
      });
      expect(res.items[1].post.metrics.likes).toBe(7);
    });

    it('respects the limit after ranking', async () => {
      const { repo, sentFindMany } = buildRepo();
      sentFindMany.mockResolvedValue([
        {
          id: 's1',
          opportunity: { platform: 'x', authorUsername: 'a' },
          post: { analytics: xAnalytics(1), integration: null, settings: null },
        },
        {
          id: 's2',
          opportunity: { platform: 'x', authorUsername: 'b' },
          post: { analytics: xAnalytics(9), integration: null, settings: null },
        },
        {
          id: 's3',
          opportunity: { platform: 'x', authorUsername: 'c' },
          post: { analytics: xAnalytics(5), integration: null, settings: null },
        },
      ]);

      const res = await repo.getDashboardTopSources('org1', { limit: 2 });

      expect(res.items.map((i) => i.id)).toEqual(['s2', 's3']); // top 2 by likes
    });

    it('scopes to a platform and fetches a lean select (no original-post author fields)', async () => {
      const { repo, sentFindMany } = buildRepo();
      sentFindMany.mockResolvedValue([]);

      await repo.getDashboardTopSources('org1', {
        platform: 'reddit',
        limit: 3,
      });

      const call = sentFindMany.mock.calls[0][0];
      expect(call.where.opportunity).toEqual({ platform: 'reddit' });
      expect(call.where.post).toEqual({
        is: { source: 'engage', trafficScore: { not: null } },
      });
      // Split from /sent: only platform + url from the opportunity, never the
      // original-post author fields, and no matchedKeywords join.
      expect(call.select.opportunity.select).toEqual({
        platform: true,
        externalPostUrl: true,
      });
    });
  });

  // Every dashboard panel accepts an optional projectId. When supplied it filters
  // on Post.projectId (folded into the related `post.is` for EngageSentReply
  // queries, or the top-level where for direct Post queries). When omitted, no
  // projectId key is added at all — preserving the legacy org-wide behavior
  // asserted by the toEqual() checks above.
  describe('dashboard projectId scoping', () => {
    it('summary: threads projectId into the sent-reply post filter and the post aggregates', async () => {
      const { repo, sentCount, sentFindMany, postAggregate } = buildRepo();
      sentCount.mockResolvedValue(0);
      postAggregate.mockResolvedValue({
        _sum: { impressions: 0, trafficScore: 0 },
      });
      sentFindMany.mockResolvedValue([]);

      await repo.getDashboardSummary('org1', { projectId: 'proj-1' });

      // Sent-reply counts scope via the related Post.projectId.
      expect(sentCount.mock.calls[2][0].where.post.is.projectId).toBe('proj-1');
      // Both direct Post aggregates carry projectId on their own where.
      expect(postAggregate.mock.calls[0][0].where.projectId).toBe('proj-1');
      expect(postAggregate.mock.calls[1][0].where.projectId).toBe('proj-1');
    });

    it('replies-trend: filters the sent-reply query by Post.projectId', async () => {
      const { repo, sentFindMany } = buildRepo();
      sentFindMany.mockResolvedValue([]);

      await repo.getDashboardRepliesTrend('org1', 'daily', 'proj-1');

      expect(sentFindMany.mock.calls[0][0].where.post.is.projectId).toBe(
        'proj-1'
      );
    });

    it('traffics: filters both the aggregate and the per-reply list', async () => {
      const { repo, sentFindMany, postAggregate } = buildRepo();
      postAggregate.mockResolvedValue({ _sum: { trafficScore: 0 } });
      sentFindMany.mockResolvedValue([]);

      await repo.getDashboardTraffics('org1', { projectId: 'proj-1' });

      expect(postAggregate.mock.calls[0][0].where.projectId).toBe('proj-1');
      expect(sentFindMany.mock.calls[0][0].where.post.is.projectId).toBe(
        'proj-1'
      );
    });

    it('impressions: filters the direct Post query by projectId', async () => {
      const { repo, postFindMany } = buildRepo();
      postFindMany.mockResolvedValue([]);

      await repo.getDashboardImpressions('org1', 'daily', 'proj-1');

      expect(postFindMany.mock.calls[0][0].where.projectId).toBe('proj-1');
    });

    it('top-sources: filters the sent-reply query by Post.projectId', async () => {
      const { repo, sentFindMany } = buildRepo();
      sentFindMany.mockResolvedValue([]);

      await repo.getDashboardTopSources('org1', { projectId: 'proj-1' });

      expect(sentFindMany.mock.calls[0][0].where.post.is.projectId).toBe(
        'proj-1'
      );
    });

    it('omitting projectId adds no projectId key (legacy org-wide behavior)', async () => {
      const { repo, postFindMany } = buildRepo();
      postFindMany.mockResolvedValue([]);

      await repo.getDashboardImpressions('org1', 'daily');

      expect('projectId' in postFindMany.mock.calls[0][0].where).toBe(false);
    });
  });

  describe('getSentStats (date/platform/status filter alignment)', () => {
    it('no date → all-time: repliesCount = total, no publishDate window', async () => {
      const { repo, sentCount, sentFindMany, postAggregate } = buildRepo();
      sentCount.mockResolvedValueOnce(10).mockResolvedValueOnce(3); // total, replied
      postAggregate.mockResolvedValue({
        _sum: { impressions: 4200, trafficScore: 286.4 },
      });
      sentFindMany.mockResolvedValue([]); // no likes sample → avgLikes 0

      const res = await repo.getSentStats('org1', {});

      expect(res).toEqual({
        repliesCount: 10,
        responseRate: 30, // 3/10
        totalImpressions: 4200,
        totalTrafficScore: 286, // round(286.4)
        avgLikes: 0,
      });
      // All-time: engage source, no date window, and unsent drafts excluded.
      expect(sentCount.mock.calls[0][0].where.post).toEqual({
        source: 'engage',
        state: { not: 'DRAFT' },
      });
      expect(sentCount.mock.calls[0][0].where.post.publishDate).toBeUndefined();
    });

    it('date=month + platform scopes publishDate, opportunity, and the impressions aggregate', async () => {
      const { repo, sentCount, sentFindMany, postAggregate } = buildRepo();
      sentCount.mockResolvedValue(0);
      postAggregate.mockResolvedValue({ _sum: { impressions: 0 } });
      sentFindMany.mockResolvedValue([]);

      await repo.getSentStats('org1', { date: 'month', platform: 'x' });

      const sentWhere = sentCount.mock.calls[0][0].where;
      expect(sentWhere.post.source).toBe('engage');
      expect(sentWhere.post.publishDate.gte).toBeInstanceOf(Date);
      expect(sentWhere.opportunity).toEqual({ platform: 'x' });
      // Impressions aggregate is windowed AND platform-scoped via the post link.
      const aggWhere = postAggregate.mock.calls[0][0].where;
      expect(aggWhere.publishDate.gte).toBeInstanceOf(Date);
      expect(aggWhere.engageSentReply).toEqual({
        is: { opportunity: { platform: 'x' } },
      });
    });

    it('status=published narrows the post state filter', async () => {
      const { repo, sentCount, sentFindMany, postAggregate } = buildRepo();
      sentCount.mockResolvedValue(0);
      postAggregate.mockResolvedValue({ _sum: { impressions: 0 } });
      sentFindMany.mockResolvedValue([]);

      await repo.getSentStats('org1', { status: 'published' });

      expect(sentCount.mock.calls[0][0].where.post).toMatchObject({
        source: 'engage',
        state: 'PUBLISHED',
        releaseURL: { not: null },
      });
    });

    it("date='day' is accepted and windowed (shared vocab with /dashboard/summary)", async () => {
      const { repo, sentCount, sentFindMany, postAggregate } = buildRepo();
      sentCount.mockResolvedValue(0);
      postAggregate.mockResolvedValue({
        _sum: { impressions: 0, trafficScore: 0 },
      });
      sentFindMany.mockResolvedValue([]);

      // 'day' previously had no effect here (inline mapper only knew 'today');
      // now both endpoints route through the shared _engageDateWindow.
      await repo.getSentStats('org1', { date: 'day' });

      expect(sentCount.mock.calls[0][0].where.post.source).toBe('engage');
      expect(
        sentCount.mock.calls[0][0].where.post.publishDate.gte
      ).toBeInstanceOf(Date);
    });

    it('status=awaiting-draft: DRAFT posts whose opportunity is not EXPIRED for this org', async () => {
      const { repo, sentCount, sentFindMany, postAggregate } = buildRepo();
      sentCount.mockResolvedValue(0);
      postAggregate.mockResolvedValue({ _sum: { impressions: 0 } });
      sentFindMany.mockResolvedValue([]);

      await repo.getSentStats('org1', { status: 'awaiting-draft' });

      const where = sentCount.mock.calls[0][0].where;
      expect(where.post).toMatchObject({ source: 'engage', state: 'DRAFT' });
      expect(where.opportunity).toEqual({
        states: {
          some: {
            organizationId: 'org1',
            projectId: null,
            status: { not: 'EXPIRED' },
          },
        },
      });
    });

    it('status=awaiting-expired: DRAFT posts whose opportunity IS EXPIRED for this org', async () => {
      const { repo, sentCount, sentFindMany, postAggregate } = buildRepo();
      sentCount.mockResolvedValue(0);
      postAggregate.mockResolvedValue({ _sum: { impressions: 0 } });
      sentFindMany.mockResolvedValue([]);

      await repo.getSentStats('org1', { status: 'awaiting-expired' });

      const where = sentCount.mock.calls[0][0].where;
      expect(where.post).toMatchObject({ source: 'engage', state: 'DRAFT' });
      expect(where.opportunity).toEqual({
        states: {
          some: { organizationId: 'org1', projectId: null, status: 'EXPIRED' },
        },
      });
    });

    it('status=awaiting-expired + platform: merges the platform filter into the same opportunity where', async () => {
      const { repo, sentCount, sentFindMany, postAggregate } = buildRepo();
      sentCount.mockResolvedValue(0);
      postAggregate.mockResolvedValue({ _sum: { impressions: 0 } });
      sentFindMany.mockResolvedValue([]);

      await repo.getSentStats('org1', {
        status: 'awaiting-expired',
        platform: 'x',
      });

      const where = sentCount.mock.calls[0][0].where;
      expect(where.opportunity).toEqual({
        platform: 'x',
        states: {
          some: { organizationId: 'org1', projectId: null, status: 'EXPIRED' },
        },
      });
    });

    it('status=awaiting-link: manual link-pending (PUBLISHED, no releaseURL) OR a failed publish (ERROR)', async () => {
      const { repo, sentCount, sentFindMany, postAggregate } = buildRepo();
      sentCount.mockResolvedValue(0);
      postAggregate.mockResolvedValue({ _sum: { impressions: 0 } });
      sentFindMany.mockResolvedValue([]);

      await repo.getSentStats('org1', { status: 'awaiting-link' });

      const where = sentCount.mock.calls[0][0].where;
      expect(where.post).toMatchObject({
        source: 'engage',
        OR: [{ state: 'PUBLISHED', releaseURL: null }, { state: 'ERROR' }],
      });
      // No opportunity-state narrowing needed here — unlike awaiting-draft/-expired.
      expect(where.opportunity).toBeUndefined();
    });

    it('projectId scopes the sent-reply query (regression: stats used to drop it)', async () => {
      const { repo, sentCount, sentFindMany, postAggregate } = buildRepo();
      sentCount.mockResolvedValue(0);
      postAggregate.mockResolvedValue({ _sum: { impressions: 0 } });
      sentFindMany.mockResolvedValue([]);

      await repo.getSentStats('org1', {
        projectId: 'proj-1',
        platform: 'reddit',
      });

      // Stats must filter on the requested project, not collapse to null-project
      // (which returned the legacy/global replies and disagreed with /sent).
      expect(sentCount.mock.calls[0][0].where.projectId).toBe('proj-1');
    });

    it('omitting projectId keeps the legacy null-project scope', async () => {
      const { repo, sentCount, sentFindMany, postAggregate } = buildRepo();
      sentCount.mockResolvedValue(0);
      postAggregate.mockResolvedValue({ _sum: { impressions: 0 } });
      sentFindMany.mockResolvedValue([]);

      await repo.getSentStats('org1', {});

      expect(sentCount.mock.calls[0][0].where.projectId).toBeNull();
    });
  });

  describe('countSentReplies / getSentCountsSummary', () => {
    it('returns total + byPlatform + rollups + awaitingBreakdown in one round trip', async () => {
      const { repo, sentCount } = buildRepo();
      sentCount
        .mockResolvedValueOnce(340) // total
        .mockResolvedValueOnce(210) // x
        .mockResolvedValueOnce(130) // reddit
        .mockResolvedValueOnce(0) // linkedin
        .mockResolvedValueOnce(0) // medium
        .mockResolvedValueOnce(0) // devto
        .mockResolvedValueOnce(0) // hackernews
        .mockResolvedValueOnce(0) // quora
        .mockResolvedValueOnce(280) // settled
        .mockResolvedValueOnce(60) // awaiting
        .mockResolvedValueOnce(25) // awaiting-draft
        .mockResolvedValueOnce(30) // awaiting-link
        .mockResolvedValueOnce(5); // awaiting-expired

      const res = await repo.countSentReplies('org1', {});

      expect(res).toEqual({
        total: 340,
        byPlatform: {
          x: 210,
          reddit: 130,
          linkedin: 0,
          medium: 0,
          devto: 0,
          hackernews: 0,
          quora: 0,
        },
        rollups: { settled: 280, awaiting: 60 },
        awaitingBreakdown: { drafts: 25, link: 30, expired: 5 },
      });
      expect(sentCount).toHaveBeenCalledTimes(13);

      // The three sub-counts key off the same status filters as getSentStats'
      // awaiting-draft/-link/-expired branches.
      const draftWhere = sentCount.mock.calls[10][0].where;
      expect(draftWhere.post).toMatchObject({
        source: 'engage',
        state: 'DRAFT',
      });
      expect(draftWhere.opportunity).toEqual({
        states: {
          some: {
            organizationId: 'org1',
            projectId: null,
            status: { not: 'EXPIRED' },
          },
        },
      });

      const linkWhere = sentCount.mock.calls[11][0].where;
      expect(linkWhere.post).toMatchObject({
        source: 'engage',
        OR: [{ state: 'PUBLISHED', releaseURL: null }, { state: 'ERROR' }],
      });

      const expiredWhere = sentCount.mock.calls[12][0].where;
      expect(expiredWhere.post).toMatchObject({
        source: 'engage',
        state: 'DRAFT',
      });
      expect(expiredWhere.opportunity).toEqual({
        states: {
          some: { organizationId: 'org1', projectId: null, status: 'EXPIRED' },
        },
      });
    });

    it('each breakdown drops only its own axis: total keeps status+platform, byPlatform keeps status, rollups keep platform', async () => {
      const { repo, sentCount } = buildRepo();
      sentCount.mockResolvedValue(0);

      await repo.countSentReplies('org1', {
        status: 'awaiting',
        platform: 'x',
      });

      // total: full filter set — awaiting OR-states AND platform=x.
      const totalWhere = sentCount.mock.calls[0][0].where;
      expect(totalWhere.post.OR).toBeDefined();
      expect(totalWhere.opportunity).toMatchObject({ platform: 'x' });
      // byPlatform pins its own platform but keeps the status filter.
      const redditWhere = sentCount.mock.calls[2][0].where;
      expect(redditWhere.opportunity).toMatchObject({ platform: 'reddit' });
      expect(redditWhere.post.OR).toBeDefined();
      // rollups drop status (settled pins its own) but keep platform=x.
      const settledWhere = sentCount.mock.calls[8][0].where;
      expect(settledWhere.opportunity).toMatchObject({ platform: 'x' });
      expect(settledWhere.post.OR).toEqual([
        { state: 'PUBLISHED', releaseURL: { not: null } },
        { state: 'QUEUE' },
      ]);
    });

    it('projectId scopes every count (regression)', async () => {
      const { repo, sentCount } = buildRepo();
      sentCount.mockResolvedValue(0);

      await repo.countSentReplies('org1', {
        status: 'awaiting',
        projectId: 'proj-1',
      });

      // Total + rollups + all three awaiting sub-counts must carry projectId, so
      // the tab badges match the project-scoped /sent list instead of the global one.
      for (const call of sentCount.mock.calls) {
        expect(call[0].where.projectId).toBe('proj-1');
      }
    });

    it('getSentCountsSummary delegates with only date/projectId (no status/platform)', async () => {
      const { repo, sentCount } = buildRepo();
      sentCount.mockResolvedValue(0);

      const res = await repo.getSentCountsSummary('org1', {
        projectId: 'proj-1',
      });

      expect(sentCount).toHaveBeenCalledTimes(13);
      // total where: no status → not-DRAFT branch is skipped (includeDrafts) and
      // no platform filter on the linked opportunity.
      const totalWhere = sentCount.mock.calls[0][0].where;
      expect(totalWhere.opportunity).toBeUndefined();
      expect(totalWhere.projectId).toBe('proj-1');
      expect(res).toHaveProperty('awaitingBreakdown');
    });
  });

  describe('createManualXPost', () => {
    // Manual X reply posts parse a releaseId from the tweet URL (otherwise
    // checkPostAnalytics early-returns and impressions/likes/etc. stay null).
    // Integration handling: when the caller supplies one it is validated; when
    // omitted we attach an account ONLY if the reply URL's author handle matches a
    // connected account. Otherwise integrationId is left null (the author is
    // recorded in settings.engageAuthor) — metrics still sync app-only.
    function buildXRepo() {
      const integrationFindFirst = vi.fn();
      const integrationFindMany = vi.fn().mockResolvedValue([]);
      const postCreate = vi.fn();
      const integration = {
        model: {
          integration: {
            findFirst: integrationFindFirst,
            findMany: integrationFindMany,
          },
        },
      } as any;
      const post = { model: { post: { create: postCreate } } } as any;
      const repo = new EngageRepository(
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        integration, // _integration
        {} as any,   // _integrationProject
        post,        // _post
        {} as any
      );
      return { repo, integrationFindFirst, integrationFindMany, postCreate };
    }

    it('validates the integration belongs to the org and is an X account', async () => {
      const { repo, integrationFindFirst, postCreate } = buildXRepo();
      integrationFindFirst.mockResolvedValue(null);

      await expect(
        repo.createManualXPost({
          organizationId: 'org1',
          content: 'reply',
          date: new Date(0),
          replyUrl: 'https://x.com/u/status/123',
          integrationId: 'int1',
        })
      ).rejects.toThrow('X integration not found');

      expect(integrationFindFirst.mock.calls[0][0].where).toMatchObject({
        id: 'int1',
        organizationId: 'org1',
        providerIdentifier: 'x',
        deletedAt: null,
      });
      expect(postCreate).not.toHaveBeenCalled();
    });

    it('parses releaseId from the tweet URL and writes an X-typed engage post', async () => {
      const { repo, integrationFindFirst, postCreate } = buildXRepo();
      integrationFindFirst.mockResolvedValue({ id: 'int1' });
      postCreate.mockResolvedValue({ id: 'post1' });

      await repo.createManualXPost({
        organizationId: 'org1',
        content: 'reply',
        date: new Date(0),
        replyUrl: 'https://x.com/zhngyq310334/status/2061267353544146949?s=20',
        integrationId: 'int1',
      });

      const data = postCreate.mock.calls[0][0].data;
      expect(data.releaseId).toBe('2061267353544146949'); // snowflake parsed, query stripped
      expect(data.releaseURL).toBe(
        'https://x.com/zhngyq310334/status/2061267353544146949?s=20'
      );
      expect(data.integrationId).toBe('int1'); // scalar FK, enables analytics token lookup
      expect(JSON.parse(data.settings).__type).toBe('x'); // not 'reddit'
      expect(data.state).toBe('PUBLISHED');
      expect(data.source).toBe('engage');
    });

    it('resolves the author-handle integration when none is supplied', async () => {
      const { repo, integrationFindFirst, integrationFindMany, postCreate } =
        buildXRepo();
      // Org has two live X accounts; the reply tweet's author handle matches one.
      integrationFindMany.mockResolvedValue([
        { id: 'other', profile: 'someoneelse', integrationProjects: [] },
        { id: 'author', profile: 'zhngyq310334', integrationProjects: [] },
      ]);
      postCreate.mockResolvedValue({ id: 'post1' });

      await repo.createManualXPost({
        organizationId: 'org1',
        content: 'reply',
        date: new Date(0),
        replyUrl: 'https://x.com/zhngyq310334/status/2061267353544146949',
        // no integrationId — resolver picks the author's account by handle
      });

      expect(integrationFindFirst).not.toHaveBeenCalled(); // no explicit id to validate
      const data = postCreate.mock.calls[0][0].data;
      expect(data.releaseId).toBe('2061267353544146949');
      expect(data.integrationId).toBe('author'); // owner token → impressions readable
      expect(JSON.parse(data.settings).__type).toBe('x');
    });

    it('omits integrationId when the org has no usable X account', async () => {
      const { repo, integrationFindMany, postCreate } = buildXRepo();
      integrationFindMany.mockResolvedValue([]); // no connected X accounts
      postCreate.mockResolvedValue({ id: 'post1' });

      await repo.createManualXPost({
        organizationId: 'org1',
        content: 'reply',
        date: new Date(0),
        replyUrl: 'https://x.com/zhngyq310334/status/2061267353544146949',
      });

      const data = postCreate.mock.calls[0][0].data;
      expect(data.releaseId).toBe('2061267353544146949'); // still parsed
      expect('integrationId' in data).toBe(false); // FK omitted, column stays null
      expect(JSON.parse(data.settings).__type).toBe('x');
    });

    it('omits integrationId when no connected account authored the reply (external author)', async () => {
      const { repo, integrationFindMany, postCreate } = buildXRepo();
      // Org has live X accounts, but none match the reply tweet's author handle —
      // the reply was posted from an external account, so we attach nothing rather
      // than misrepresent authorship with a fallback account.
      integrationFindMany.mockResolvedValue([
        { id: 'other', profile: 'someoneelse', integrationProjects: [] },
        {
          id: 'brand',
          profile: 'brandhq',
          integrationProjects: [{ engageEnabled: true }],
        },
      ]);
      postCreate.mockResolvedValue({ id: 'post1' });

      await repo.createManualXPost({
        organizationId: 'org1',
        content: 'reply',
        date: new Date(0),
        replyUrl: 'https://x.com/externalguy/status/2061267353544146949',
      });

      const data = postCreate.mock.calls[0][0].data;
      expect('integrationId' in data).toBe(false); // no handle match → null, no fallback
    });

    it('persists engageAuthor into settings when supplied', async () => {
      const { repo, integrationFindMany, postCreate } = buildXRepo();
      integrationFindMany.mockResolvedValue([]);
      postCreate.mockResolvedValue({ id: 'post1' });

      await repo.createManualXPost({
        organizationId: 'org1',
        content: 'reply',
        date: new Date(0),
        replyUrl: 'https://x.com/externalguy/status/2061267353544146949',
        engageAuthor: { handle: 'externalguy', id: '42', name: 'External Guy' },
      });

      const settings = JSON.parse(postCreate.mock.calls[0][0].data.settings);
      expect(settings.__type).toBe('x');
      expect(settings.engageAuthor).toEqual({
        handle: 'externalguy',
        id: '42',
        name: 'External Guy',
      });
    });

    it('does NOT write engageAuthor when an integration authored the reply (integrationId is source of truth)', async () => {
      const { repo, integrationFindMany, postCreate } = buildXRepo();
      // The reply URL's author handle matches a connected account → integrationId set.
      integrationFindMany.mockResolvedValue([
        { id: 'author', profile: 'zhngyq310334', integrationProjects: [] },
      ]);
      postCreate.mockResolvedValue({ id: 'post1' });

      await repo.createManualXPost({
        organizationId: 'org1',
        content: 'reply',
        date: new Date(0),
        replyUrl: 'https://x.com/zhngyq310334/status/2061267353544146949',
        engageAuthor: { handle: 'zhngyq310334', id: '7', name: 'ZQ' },
      });

      const data = postCreate.mock.calls[0][0].data;
      expect(data.integrationId).toBe('author');
      expect(JSON.parse(data.settings).engageAuthor).toBeUndefined(); // not duplicated
    });

    it('omits releaseId when the URL has no /status/<id> segment', async () => {
      const { repo, integrationFindFirst, postCreate } = buildXRepo();
      integrationFindFirst.mockResolvedValue({ id: 'int1' });
      postCreate.mockResolvedValue({ id: 'post1' });

      await repo.createManualXPost({
        organizationId: 'org1',
        content: 'reply',
        date: new Date(0),
        replyUrl: 'https://x.com/zhngyq310334',
        integrationId: 'int1',
      });

      expect(postCreate.mock.calls[0][0].data.releaseId).toBeUndefined();
    });

    it('writes projectId onto the X engage post when supplied', async () => {
      const { repo, integrationFindFirst, postCreate } = buildXRepo();
      integrationFindFirst.mockResolvedValue({ id: 'int1' });
      postCreate.mockResolvedValue({ id: 'post1' });

      await repo.createManualXPost({
        organizationId: 'org1',
        content: 'reply',
        date: new Date(0),
        replyUrl: 'https://x.com/u/status/123',
        integrationId: 'int1',
        projectId: 'proj-1',
      });

      expect(postCreate.mock.calls[0][0].data.projectId).toBe('proj-1');
    });
  });

  describe('createManualCommunityPost', () => {
    function buildRedditRepo() {
      const postCreate = vi.fn();
      const post = { model: { post: { create: postCreate } } } as any;
      const repo = new EngageRepository(
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,   // _integrationProject,
        post, // _post
        {} as any
      );
      return { repo, postCreate };
    }

    it('writes a reddit-typed engage post and persists engageAuthor when supplied', async () => {
      const { repo, postCreate } = buildRedditRepo();
      postCreate.mockResolvedValue({ id: 'post1' });

      await repo.createManualCommunityPost({
        organizationId: 'org1',
        platform: 'reddit',
        content: 'reply',
        date: new Date(0),
        replyUrl: 'https://www.reddit.com/r/sub/comments/abc/title/def/',
        engageAuthor: {
          handle: 'bigbaffler',
          id: 't2_9',
          name: 'Big Baffler',
          avatarUrl: 'https://x/a.png',
        },
      });

      const data = postCreate.mock.calls[0][0].data;
      expect('integrationId' in data).toBe(false); // reddit never has an integration
      const settings = JSON.parse(data.settings);
      expect(settings.__type).toBe('reddit');
      expect(settings.engageAuthor).toEqual({
        handle: 'bigbaffler',
        id: 't2_9',
        name: 'Big Baffler',
        avatarUrl: 'https://x/a.png',
      });
    });

    it('omits engageAuthor from settings when not supplied', async () => {
      const { repo, postCreate } = buildRedditRepo();
      postCreate.mockResolvedValue({ id: 'post1' });

      await repo.createManualCommunityPost({
        organizationId: 'org1',
        platform: 'reddit',
        content: 'reply',
        date: new Date(0),
      });

      const settings = JSON.parse(postCreate.mock.calls[0][0].data.settings);
      expect(settings.__type).toBe('reddit');
      expect(settings.engageAuthor).toBeUndefined();
    });

    it('writes projectId when supplied, and omits it otherwise', async () => {
      const { repo, postCreate } = buildRedditRepo();
      postCreate.mockResolvedValue({ id: 'post1' });

      await repo.createManualCommunityPost({
        organizationId: 'org1',
        platform: 'reddit',
        content: 'reply',
        date: new Date(0),
        projectId: 'proj-1',
      });
      expect(postCreate.mock.calls[0][0].data.projectId).toBe('proj-1');

      await repo.createManualCommunityPost({
        organizationId: 'org1',
        platform: 'reddit',
        content: 'reply',
        date: new Date(0),
      });
      expect('projectId' in postCreate.mock.calls[1][0].data).toBe(false);
    });

    // Every non-X platform shares this path. It used to hard-code 'reddit',
    // which is how a Hacker News reply ended up as a reddit Post row whose
    // releaseURL pointed at news.ycombinator.com.
    it.each(['hackernews', 'quora', 'linkedin', 'medium', 'devto', 'reddit'])(
      'files a %s manual reply under its real platform',
      async (platform) => {
        const { repo, postCreate } = buildRedditRepo();
        postCreate.mockResolvedValue({ id: 'post1' });

        await repo.createManualCommunityPost({
          organizationId: 'org1',
          platform,
          content: 'reply',
          date: new Date(0),
        });

        const data = postCreate.mock.calls[0][0].data;
        expect(data.providerIdentifier).toBe(platform);
        expect(JSON.parse(data.settings).__type).toBe(platform);
      }
    );
  });

  describe('countProjectKeywordSentRepliesToday', () => {
    it('narrows the count to replies whose matchedKeywords contains the keyword, same window/state as the aggregate count', async () => {
      const count = vi.fn(async () => 3);
      const sentReply = { model: { engageSentReply: { count } } } as any;
      const repo = new EngageRepository(
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        sentReply, // _sentReply
        {} as any,
        {} as any // _integrationProject, {} as any, {} as any
      );
      const since = new Date('2026-07-16T00:00:00Z');
      const until = new Date('2026-07-17T00:00:00Z');

      const n = await repo.countProjectKeywordSentRepliesToday(
        'org1',
        'proj-1',
        'x',
        'react',
        since,
        until
      );

      expect(n).toBe(3);
      const where = count.mock.calls[0][0].where;
      expect(where.organizationId).toBe('org1');
      expect(where.projectId).toBe('proj-1');
      expect(where.matchedKeywords).toEqual({ has: 'react' });
      expect(where.opportunity).toEqual({ platform: 'x' });
      expect(where.post.publishDate).toEqual({ gte: since, lt: until });
      expect(where.post.state).toEqual({ in: ['QUEUE', 'PUBLISHED'] });
    });
  });

  describe('countQueuedEngageReplies', () => {
    it('counts EngageSentReply rows whose post is still QUEUE, undeleted, unreleased — read-only', async () => {
      const count = vi.fn(async () => 4);
      const sentReply = { model: { engageSentReply: { count } } } as any;
      const repo = new EngageRepository(
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        sentReply, // _sentReply
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any
      );

      const n = await repo.countQueuedEngageReplies('org1', 'proj-1', 'reddit');

      expect(n).toBe(4);
      const where = count.mock.calls[0][0].where;
      expect(where.organizationId).toBe('org1');
      expect(where.projectId).toBe('proj-1');
      expect(where.opportunity).toEqual({ platform: 'reddit' });
      expect(where.post).toEqual({
        state: 'QUEUE',
        deletedAt: null,
        releaseURL: null,
      });
    });
  });

  describe('pickAutoReplyCandidates', () => {
    it('never offers an opportunity whose replies the platform disabled', async () => {
      // The generation is the expensive half, so a post with no reply box has
      // to be excluded HERE rather than at send time. Before this filter, every
      // poll paid for a draft that the poster could only refuse — and refusing
      // it left the record QUEUE, so the next poll paid again.
      const findMany = vi.fn(async () => []);
      const oppState = { model: { engageOpportunityState: { findMany } } } as any;
      const repo = new EngageRepository(
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        oppState, // _oppState
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any
      );

      await repo.pickAutoReplyCandidates('org1', 'proj-1', 'quora', {
        limit: 5,
      });

      expect(findMany.mock.calls[0][0].where.opportunity).toMatchObject({
        repliesDisabledAt: null,
      });
    });

    it('never offers an opportunity with no address for drafting', async () => {
      const findMany = vi.fn(async () => []);
      const oppState = { model: { engageOpportunityState: { findMany } } } as any;
      const repo = new EngageRepository(
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        oppState, // _oppState
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any
      );

      await repo.pickAutoReplyCandidates('org1', 'proj-1', 'linkedin', { limit: 1 });

      // Drafting is where the money is spent. An opportunity that cannot be
      // replied to has to be excluded HERE — excluding it at send time means
      // every poll has already paid an LLM to write a reply the poster can only
      // refuse.
      const where = findMany.mock.calls[0][0].where;
      expect(where.opportunity.externalPostUrl).toEqual({ not: '' });
    });
  });

  describe('countEligibleOpportunities', () => {
    it('counts NEW, currently-matched opportunities not yet replied to for this project — same shape pickAutoReplyCandidates picks from', async () => {
      const count = vi.fn(async () => 9);
      const oppState = { model: { engageOpportunityState: { count } } } as any;
      const repo = new EngageRepository(
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        oppState, // _oppState
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any
      );

      const n = await repo.countEligibleOpportunities('org1', 'proj-1', 'x', {
        minScore: 70,
      });

      expect(n).toBe(9);
      const where = count.mock.calls[0][0].where;
      expect(where.organizationId).toBe('org1');
      expect(where.projectId).toBe('proj-1');
      expect(where.status).toBe('NEW');
      expect(where.isCurrentlyMatched).toBe(true);
      expect(where.score).toEqual({ gte: 70 });
      expect(where.opportunity).toEqual({
        deletedAt: null,
        // A post the platform accepts no replies on is not eligible work, for
        // the same reason a deleted one is not — drafting against either buys
        // an LLM generation nothing can accept.
        repliesDisabledAt: null,
        platform: 'x',
        externalPostUrl: { not: '' },
        sentReplies: { none: { organizationId: 'org1', projectId: 'proj-1' } },
      });
    });

    it('asks the database exactly what pickAutoReplyCandidates asks', async () => {
      // The doc comment on countEligibleOpportunities promises the two can
      // "never disagree about what eligible means". Asserting the two clauses
      // against each other keeps that true: a filter added to one and forgotten
      // on the other fails HERE, rather than shipping a status panel that counts
      // work the driver will never hand out.
      const mk = (fn: any) =>
        new EngageRepository(
          {} as any,
          {} as any,
          {} as any,
          {} as any,
          { model: { engageOpportunityState: fn } } as any,
          {} as any,
          {} as any,
          {} as any,
          {} as any,
          {} as any,
          {} as any,
          {} as any
        );

      const count = vi.fn(async () => 0);
      const findMany = vi.fn(async () => []);
      await mk({ count }).countEligibleOpportunities('org1', 'proj-1', 'x', {
        minScore: 70,
      });
      await mk({ findMany }).pickAutoReplyCandidates('org1', 'proj-1', 'x', {
        limit: 5,
        minScore: 70,
      });

      expect(count.mock.calls[0][0].where).toEqual(
        findMany.mock.calls[0][0].where
      );
    });

    it('omits the score filter when minScore is not supplied', async () => {
      const count = vi.fn(async () => 0);
      const oppState = { model: { engageOpportunityState: { count } } } as any;
      const repo = new EngageRepository(
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        oppState,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any
      );

      await repo.countEligibleOpportunities('org1', 'proj-1', 'x');

      expect('score' in count.mock.calls[0][0].where).toBe(false);
    });
  });

  describe('updateReplyUrl — the DRAFT/QUEUE→PUBLISHED commit write', () => {
    function buildRepo(platform: string) {
      const sentFindFirst = vi.fn(async () => ({
        id: 'r1',
        postId: 'p1',
        opportunity: { platform },
      }));
      const postUpdate = vi.fn(async () => ({ id: 'p1' }));
      const postFindUnique = vi.fn(async () => ({
        integrationId: null,
        settings: null,
      }));
      const sentReply = {
        model: { engageSentReply: { findFirst: sentFindFirst } },
      } as any;
      const post = {
        model: { post: { update: postUpdate, findUnique: postFindUnique } },
      } as any;
      const repo = new EngageRepository(
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        sentReply, // _sentReply
        {} as any,
        {} as any,
        post, // _post
        {} as any,
        {} as any,
        {} as any
      );
      return { repo, postUpdate, postFindUnique };
    }

    // The extension posts as the logged-in session, so it KNOWS who replied and
    // sends it. This write used to merge that author only on X and Reddit — on
    // every other platform the caller handed over ground truth and the write
    // silently threw it away.
    it.each(['hackernews', 'quora', 'linkedin', 'medium', 'devto'])(
      'records a supplied author on %s instead of dropping it',
      async (platform) => {
        const { repo, postUpdate } = buildRepo(platform);
        const author = { handle: 'someone', name: 'Some One' };

        await repo.updateReplyUrl('org1', 'r1', 'https://example.com/c/1', author, {
          markPublished: true,
        });

        const settings = JSON.parse(postUpdate.mock.calls[0][0].data.settings);
        expect(settings.engageAuthor).toEqual(author);
        expect(settings.__type).toBe(platform);
      }
    );

    it('leaves settings alone when no author is supplied', async () => {
      const { repo, postUpdate } = buildRepo('hackernews');

      await repo.updateReplyUrl('org1', 'r1', 'https://news.ycombinator.com/item?id=1', undefined, {
        markPublished: true,
      });

      expect('settings' in postUpdate.mock.calls[0][0].data).toBe(false);
    });

    // Resolving an OAuth account back from the reply URL is genuinely X-only —
    // opening author recording to every platform must not drag that along.
    it('does not attempt an integration lookup on a non-X platform', async () => {
      const { repo, postFindUnique } = buildRepo('hackernews');

      await repo.updateReplyUrl('org1', 'r1', 'https://news.ycombinator.com/item?id=1', undefined, {
        markPublished: true,
      });

      // No author and not X → nothing to read the post for at all.
      expect(postFindUnique).not.toHaveBeenCalled();
    });

    it('flips a devto reply to PUBLISHED — every SCANNABLE_PLATFORMS platform can commit, not just X/Reddit', async () => {
      // Regression: this used to throw for anything but X/Reddit, so a devto /
      // linkedin / hackernews / medium / quora reply the extension really did
      // post stayed QUEUE forever.
      const { repo, postUpdate } = buildRepo('devto');

      await repo.updateReplyUrl(
        'org1',
        'r1',
        'https://dev.to/alice/post/comment/1',
        undefined,
        { markPublished: true }
      );

      expect(postUpdate.mock.calls[0][0].data.state).toBe('PUBLISHED');
    });

    it('commits URL-less too — a confirmed send with no captured permalink still leaves QUEUE', async () => {
      const { repo, postUpdate } = buildRepo('hackernews');

      await repo.updateReplyUrl('org1', 'r1', null, undefined, {
        markPublished: true,
      });

      const data = postUpdate.mock.calls[0][0].data;
      expect(data.state).toBe('PUBLISHED');
      expect(data.releaseURL).toBeNull();
    });

    it('rejects a platform outside SCANNABLE_PLATFORMS', async () => {
      const { repo, postUpdate } = buildRepo('made-up-platform');

      await expect(
        repo.updateReplyUrl('org1', 'r1', 'https://example.com/x', undefined, {
          markPublished: true,
        })
      ).rejects.toThrow(/not supported for platform/i);
      expect(postUpdate).not.toHaveBeenCalled();
    });
  });

  describe('resolveOrCreateKeywordIds', () => {
    function buildRepo(existing: Array<{ id: string; keyword: string }>) {
      const findMany = vi.fn().mockResolvedValue(existing);
      const findFirst = vi.fn();
      const keyword = {
        model: { engageKeyword: { findMany, findFirst } },
      } as any;
      const configUpdate = vi.fn().mockResolvedValue({});
      const config = {
        model: { engageConfig: { update: configUpdate } },
      } as any;
      const repo = new EngageRepository(
        config, // _config
        keyword, // _keyword
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any // _integrationProject, {} as any, {} as any, {} as any, {} as any
      );
      return { repo, findMany, findFirst, configUpdate };
    }

    it('resolves existing ids (normalized) and creates missing keywords, keyed by original text', async () => {
      const { repo } = buildRepo([{ id: 'kw-ai', keyword: 'AI' }]);
      vi.spyOn(repo, 'getOrCreateConfig').mockResolvedValue({
        id: 'cfg-1',
        enabled: true,
      } as any);
      const addKeyword = vi
        .spyOn(repo, 'addKeyword')
        .mockImplementation(
          async (_c: any, _o: any, dto: any) =>
            ({ id: `new-${dto.keyword}` } as any)
        );

      const result = await repo.resolveOrCreateKeywordIds('org1', 'proj-1', [
        'AI',
        'apcore',
        'ai',
      ]);

      // 'AI' and 'ai' both collapse (normalizeKeyword) to the existing kw-ai;
      // only 'apcore' is created; the result preserves each original spelling.
      expect(result).toEqual({
        AI: 'kw-ai',
        ai: 'kw-ai',
        apcore: 'new-apcore',
      });
      expect(addKeyword).toHaveBeenCalledTimes(1);
      expect(addKeyword).toHaveBeenCalledWith('cfg-1', 'org1', {
        keyword: 'apcore',
      });
    });

    it('skips blank inputs and does not touch config/keywords when nothing usable is passed', async () => {
      const { repo, findMany } = buildRepo([]);
      const getCfg = vi.spyOn(repo, 'getOrCreateConfig');

      const result = await repo.resolveOrCreateKeywordIds('org1', null, [
        '',
        '   ',
        '',
      ]);

      expect(result).toEqual({});
      expect(getCfg).not.toHaveBeenCalled();
      expect(findMany).not.toHaveBeenCalled();
    });

    it('re-reads the row on a create race instead of dropping the keyword', async () => {
      const { repo, findFirst } = buildRepo([]);
      vi.spyOn(repo, 'getOrCreateConfig').mockResolvedValue({
        id: 'cfg-1',
        enabled: true,
      } as any);
      // addKeyword loses the unique race and throws; the row now exists.
      vi.spyOn(repo, 'addKeyword').mockRejectedValue(
        new Error('Keyword already exists')
      );
      findFirst.mockResolvedValue({ id: 'kw-raced', keyword: 'apcore' });

      const result = await repo.resolveOrCreateKeywordIds('org1', 'proj-1', [
        'apcore',
      ]);

      expect(result).toEqual({ apcore: 'kw-raced' });
    });

    it('activates a disabled config so the plan keywords actually run (config enabled:false → true)', async () => {
      const { repo, configUpdate } = buildRepo([
        { id: 'kw-ai', keyword: 'AI' },
      ]);
      // getOrCreateConfig returns a freshly-created, DISABLED project config.
      vi.spyOn(repo, 'getOrCreateConfig').mockResolvedValue({
        id: 'cfg-1',
        enabled: false,
      } as any);

      await repo.resolveOrCreateKeywordIds('org1', 'proj-1', ['AI']);

      // The config is flipped enabled so its (enabled) keywords pass the run gate.
      expect(configUpdate).toHaveBeenCalledWith({
        where: { id: 'cfg-1' },
        data: { enabled: true },
      });
    });

    it('leaves an already-enabled config untouched (no needless write on re-drive)', async () => {
      const { repo, configUpdate } = buildRepo([
        { id: 'kw-ai', keyword: 'AI' },
      ]);
      vi.spyOn(repo, 'getOrCreateConfig').mockResolvedValue({
        id: 'cfg-1',
        enabled: true,
      } as any);

      await repo.resolveOrCreateKeywordIds('org1', 'proj-1', ['AI']);

      expect(configUpdate).not.toHaveBeenCalled();
    });
  });

  describe('updateReplyAuthor (background author/avatar enrichment)', () => {
    function buildAuthorRepo() {
      const sentFindFirst = vi.fn();
      const postFindUnique = vi.fn();
      const postUpdate = vi.fn(async (a: any) => a);
      const sentReply = {
        model: { engageSentReply: { findFirst: sentFindFirst } },
      } as any;
      const post = {
        model: { post: { findUnique: postFindUnique, update: postUpdate } },
      } as any;
      const repo = new EngageRepository(
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        sentReply,    // _sentReply (index 6)
        {} as any,
        {} as any,   // _integrationProject,    // _integration (index 7)
        post,         // _post (index 8)
        {} as any,
        {} as any
      );
      return { repo, sentFindFirst, postFindUnique, postUpdate };
    }

    const author = {
      handle: 'benppoulton',
      id: 't2_1',
      name: 'Ben Poulton',
      avatarUrl: 'https://x/a.jpg',
    };

    it('reddit: always merges engageAuthor into settings, preserving __type', async () => {
      const { repo, sentFindFirst, postFindUnique, postUpdate } =
        buildAuthorRepo();
      sentFindFirst.mockResolvedValue({
        postId: 'post1',
        opportunity: { platform: 'reddit' },
      });
      postFindUnique.mockResolvedValue({
        integrationId: null,
        settings: '{"__type":"reddit"}',
      });

      await repo.updateReplyAuthor('org1', 'reply1', author);

      const data = postUpdate.mock.calls[0][0].data;
      const settings = JSON.parse(data.settings);
      expect(settings.__type).toBe('reddit');
      expect(settings.engageAuthor).toEqual(author);
      // Only settings is touched — never the URL/id.
      expect(Object.keys(data)).toEqual(['settings']);
    });

    it('x WITHOUT an integration: records engageAuthor (the fallback identity)', async () => {
      const { repo, sentFindFirst, postFindUnique, postUpdate } =
        buildAuthorRepo();
      sentFindFirst.mockResolvedValue({
        postId: 'post1',
        opportunity: { platform: 'x' },
      });
      postFindUnique.mockResolvedValue({
        integrationId: null,
        settings: '{"__type":"x"}',
      });

      await repo.updateReplyAuthor('org1', 'reply1', author);

      expect(
        JSON.parse(postUpdate.mock.calls[0][0].data.settings).engageAuthor
      ).toEqual(author);
    });

    it('x WITH a connected integration: no-op (integration is source of truth)', async () => {
      const { repo, sentFindFirst, postFindUnique, postUpdate } =
        buildAuthorRepo();
      sentFindFirst.mockResolvedValue({
        postId: 'post1',
        opportunity: { platform: 'x' },
      });
      postFindUnique.mockResolvedValue({
        integrationId: 'int1',
        settings: '{"__type":"x"}',
      });

      const out = await repo.updateReplyAuthor('org1', 'reply1', author);

      expect(out).toBeUndefined();
      expect(postUpdate).not.toHaveBeenCalled();
    });

    it('missing reply: no-op (a background enrich must never throw)', async () => {
      const { repo, sentFindFirst, postUpdate } = buildAuthorRepo();
      sentFindFirst.mockResolvedValue(null);

      const out = await repo.updateReplyAuthor('org1', 'gone', author);

      expect(out).toBeUndefined();
      expect(postUpdate).not.toHaveBeenCalled();
    });

    // This used to bail on anything that was not X or Reddit, so a reply on any
    // other engage platform could never record who posted it — not even when
    // the caller already knew. None of these platforms has an integration to
    // speak for the reply, so the supplied author IS the only identity there is.
    it.each(['hackernews', 'quora', 'linkedin', 'medium', 'devto'])(
      '%s: records the author instead of bailing on the platform',
      async (platform) => {
        const { repo, sentFindFirst, postFindUnique, postUpdate } =
          buildAuthorRepo();
        sentFindFirst.mockResolvedValue({
          postId: 'post1',
          opportunity: { platform },
        });
        postFindUnique.mockResolvedValue({
          integrationId: null,
          settings: JSON.stringify({ __type: platform }),
        });

        await repo.updateReplyAuthor('org1', 'reply1', author);

        const settings = JSON.parse(postUpdate.mock.calls[0][0].data.settings);
        expect(settings.engageAuthor).toEqual(author);
        // The discriminator survives the merge — it is what the read path uses.
        expect(settings.__type).toBe(platform);
      }
    );

    // The X rule is a semantic, not a gate: an integration IS the author there,
    // so it must NOT start applying to platforms that have no integration.
    it('a non-X platform records the author even with an integration attached', async () => {
      const { repo, sentFindFirst, postFindUnique, postUpdate } =
        buildAuthorRepo();
      sentFindFirst.mockResolvedValue({
        postId: 'post1',
        opportunity: { platform: 'linkedin' },
      });
      postFindUnique.mockResolvedValue({
        integrationId: 'int1',
        settings: '{"__type":"linkedin"}',
      });

      await repo.updateReplyAuthor('org1', 'reply1', author);

      expect(
        JSON.parse(postUpdate.mock.calls[0][0].data.settings).engageAuthor
      ).toEqual(author);
    });
  });

  describe('getEngageMetricsStats', () => {
    // Folds PUBLISHED engage replies into a per-platform snapshot: published /
    // withMetrics / missing / missingIntegration (X) / Σimpressions / Σtraffic.
    function buildStatsRepo() {
      const sentFindMany = vi.fn();
      const sentReply = {
        model: { engageSentReply: { findMany: sentFindMany } },
      } as any;
      const repo = new EngageRepository(
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        sentReply,    // _sentReply
        {} as any,
        {} as any,   // _integrationProject,    // _integration
        {} as any,    // _post
        {} as any,
        {} as any
      );
      return { repo, sentFindMany };
    }

    it('counts metrics presence, per-blocker missing breakdown, and totals per platform', async () => {
      const { repo, sentFindMany } = buildStatsRepo();
      const url = 'https://x.com/u/status/123';
      sentFindMany.mockResolvedValue([
        // X — one of each bucket
        {
          post: {
            impressions: 100,
            trafficScore: 2.4,
            integrationId: 'i1',
            releaseURL: url,
            releaseId: '123',
          },
          opportunity: { platform: 'x' },
        }, // has_metrics
        {
          post: {
            impressions: null,
            trafficScore: null,
            integrationId: null,
            releaseURL: null,
            releaseId: null,
          },
          opportunity: { platform: 'x' },
        }, // no_release_url
        {
          post: {
            impressions: null,
            trafficScore: null,
            integrationId: null,
            releaseURL: url,
            releaseId: '123',
          },
          opportunity: { platform: 'x' },
        }, // no_integration
        {
          post: {
            impressions: null,
            trafficScore: null,
            integrationId: 'i2',
            releaseURL: url,
            releaseId: null,
          },
          opportunity: { platform: 'x' },
        }, // no_release_id
        {
          post: {
            impressions: null,
            trafficScore: null,
            integrationId: 'i2',
            releaseURL: url,
            releaseId: '123',
          },
          opportunity: { platform: 'x' },
        }, // syncable
        // Reddit — needs only a releaseURL
        {
          post: {
            impressions: 40,
            trafficScore: 7.6,
            integrationId: null,
            releaseURL: 'https://reddit.com/r/x/comments/a/b/c1',
            releaseId: null,
          },
          opportunity: { platform: 'reddit' },
        }, // has_metrics
        {
          post: {
            impressions: null,
            trafficScore: null,
            integrationId: null,
            releaseURL: null,
            releaseId: null,
          },
          opportunity: { platform: 'reddit' },
        }, // no_release_url
        {
          post: {
            impressions: null,
            trafficScore: null,
            integrationId: null,
            releaseURL: 'https://reddit.com/r/x/comments/a/b/c2',
            releaseId: null,
          },
          opportunity: { platform: 'reddit' },
        }, // syncable
      ]);

      const stats = await repo.getEngageMetricsStats('org1');

      expect(stats.x).toEqual({
        published: 5,
        withMetrics: 1,
        missing: 4,
        missingNoReleaseURL: 1,
        missingNoIntegration: 1,
        missingNoReleaseId: 1,
        missingSyncable: 1,
        totalImpressions: 100,
        totalTrafficScore: 2, // Math.round(2.4)
      });
      expect(stats.reddit).toEqual({
        published: 3,
        withMetrics: 1,
        missing: 2,
        missingNoReleaseURL: 1,
        missingNoIntegration: 0,
        missingNoReleaseId: 0,
        missingSyncable: 1,
        totalImpressions: 40,
        totalTrafficScore: 8, // Math.round(7.6)
      });
    });

    it('scopes to the org and the given platform, filtering to PUBLISHED engage posts', async () => {
      const { repo, sentFindMany } = buildStatsRepo();
      sentFindMany.mockResolvedValue([]);

      await repo.getEngageMetricsStats('org1', 'x');

      expect(sentFindMany.mock.calls[0][0].where).toMatchObject({
        organizationId: 'org1',
        opportunity: { platform: 'x' },
        post: { source: 'engage', state: 'PUBLISHED' },
      });
    });
  });

  describe('backfillXReplyIntegrations', () => {
    // Resolves and fills Post.integrationId for X replies that have none, reusing
    // resolveXReplyIntegrationId (author handle match only; external authors stay
    // null by design).
    function buildBackfillRepo() {
      const sentFindMany = vi.fn();
      const integrationFindMany = vi.fn().mockResolvedValue([]);
      const postUpdate = vi.fn().mockResolvedValue({});
      const sentReply = {
        model: { engageSentReply: { findMany: sentFindMany } },
      } as any;
      const integration = {
        model: { integration: { findMany: integrationFindMany } },
      } as any;
      const post = { model: { post: { update: postUpdate } } } as any;
      const repo = new EngageRepository(
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        sentReply,    // _sentReply
        integration,
        {} as any,   // _integrationProject,  // _integration
        post,         // _post
        {} as any,
        {} as any
      );
      return { repo, sentFindMany, integrationFindMany, postUpdate };
    }

    it('resolves by author handle and writes integrationId when executing', async () => {
      const { repo, sentFindMany, integrationFindMany, postUpdate } =
        buildBackfillRepo();
      sentFindMany.mockResolvedValue([
        {
          post: {
            id: 'post1',
            releaseURL: 'https://x.com/zhngyq310334/status/1',
          },
        },
      ]);
      integrationFindMany.mockResolvedValue([
        { id: 'author', profile: 'zhngyq310334', integrationProjects: [] },
      ]);

      const res = await repo.backfillXReplyIntegrations('org1', false);

      expect(postUpdate).toHaveBeenCalledWith({
        where: { id: 'post1' },
        data: { integrationId: 'author' },
      });
      expect(res).toMatchObject({ found: 1, filled: 1, unresolved: 0 });
      expect(res.items[0]).toEqual({
        postId: 'post1',
        integrationId: 'author',
        matchedBy: 'handle',
      });
    });

    it('does not write in dry-run, but still reports what would be filled', async () => {
      const { repo, sentFindMany, integrationFindMany, postUpdate } =
        buildBackfillRepo();
      sentFindMany.mockResolvedValue([
        {
          post: {
            id: 'post1',
            releaseURL: 'https://x.com/someoneelse/status/1',
          },
        },
      ]);
      integrationFindMany.mockResolvedValue([
        { id: 'author', profile: 'someoneelse', integrationProjects: [] },
      ]);

      const res = await repo.backfillXReplyIntegrations('org1', true);

      expect(postUpdate).not.toHaveBeenCalled();
      expect(res).toMatchObject({ found: 1, filled: 1, unresolved: 0 });
      expect(res.items[0].matchedBy).toBe('handle');
    });

    it('counts replies as unresolved when the org has no usable X account', async () => {
      const { repo, sentFindMany, integrationFindMany, postUpdate } =
        buildBackfillRepo();
      sentFindMany.mockResolvedValue([
        { post: { id: 'post1', releaseURL: 'https://x.com/u/status/1' } },
      ]);
      integrationFindMany.mockResolvedValue([]); // no X integrations at all

      const res = await repo.backfillXReplyIntegrations('org1', false);

      expect(postUpdate).not.toHaveBeenCalled();
      expect(res).toMatchObject({ found: 1, filled: 0, unresolved: 1 });
      expect(res.items).toHaveLength(0);
    });

    it('leaves external-authored replies unresolved (no handle match → no fallback)', async () => {
      const { repo, sentFindMany, integrationFindMany, postUpdate } =
        buildBackfillRepo();
      sentFindMany.mockResolvedValue([
        {
          post: {
            id: 'post1',
            releaseURL: 'https://x.com/externalguy/status/1',
          },
        },
      ]);
      // Org has a live X account, but it isn't the reply's author.
      integrationFindMany.mockResolvedValue([
        {
          id: 'brand',
          profile: 'brandhq',
          integrationProjects: [{ engageEnabled: true }],
        },
      ]);

      const res = await repo.backfillXReplyIntegrations('org1', false);

      expect(postUpdate).not.toHaveBeenCalled();
      expect(res).toMatchObject({ found: 1, filled: 0, unresolved: 1 });
      expect(res.items).toHaveLength(0);
    });
  });

  describe('addKeyword', () => {
    // (configId, keyword) is unique. A duplicate insert must surface as a 409
    // ConflictException with a readable message, not a generic 500.
    function buildKeywordRepo() {
      const keywordCreate = vi.fn();
      const keyword = {
        model: { engageKeyword: { create: keywordCreate } },
      } as any;
      const repo = new EngageRepository(
        {} as any,
        keyword, // _keyword
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,   // _integrationProject, {} as any,
        {} as any
      );
      return { repo, keywordCreate };
    }

    it('creates the keyword on the config and org', async () => {
      const { repo, keywordCreate } = buildKeywordRepo();
      keywordCreate.mockResolvedValue({ id: 'kw1' });

      await repo.addKeyword('cfg1', 'org1', { keyword: 'nestjs' } as any);

      expect(keywordCreate.mock.calls[0][0].data).toMatchObject({
        configId: 'cfg1',
        organizationId: 'org1',
        keyword: 'nestjs',
        enabled: true,
      });
      expect(keywordCreate.mock.calls[0][0].data.initialScans.create).toEqual([
        {
          organizationId: 'org1',
          platform: 'reddit',
          keyword: 'nestjs',
          status: 'PENDING',
        },
        {
          organizationId: 'org1',
          platform: 'x',
          keyword: 'nestjs',
          status: 'PENDING',
        },
      ]);
    });

    it('does not create an initial scan for a disabled keyword', async () => {
      const { repo, keywordCreate } = buildKeywordRepo();
      keywordCreate.mockResolvedValue({ id: 'kw1' });

      await repo.addKeyword('cfg1', 'org1', {
        keyword: 'nestjs',
        enabled: false,
      } as any);

      expect(keywordCreate.mock.calls[0][0].data).not.toHaveProperty(
        'initialScans'
      );
    });

    it('maps a P2002 unique violation to a 409 ConflictException', async () => {
      const { repo, keywordCreate } = buildKeywordRepo();
      const err = new Prisma.PrismaClientKnownRequestError('dup', {
        code: 'P2002',
        clientVersion: 'test',
      });
      keywordCreate.mockRejectedValue(err);

      await expect(
        repo.addKeyword('cfg1', 'org1', { keyword: 'nestjs' } as any)
      ).rejects.toMatchObject({
        status: 409,
        message: 'Keyword "nestjs" already exists',
      });
    });

    it('rethrows unexpected errors untouched', async () => {
      const { repo, keywordCreate } = buildKeywordRepo();
      keywordCreate.mockRejectedValue(new Error('db down'));

      await expect(
        repo.addKeyword('cfg1', 'org1', { keyword: 'nestjs' } as any)
      ).rejects.toThrow('db down');
    });
  });

  describe('updateKeyword initial scan reset', () => {
    it('resets platform initial scans when a disabled keyword is re-enabled', async () => {
      const keywordFindFirst = vi.fn().mockResolvedValue({
        id: 'kw1',
        organizationId: 'org1',
        keyword: 'storage',
        enabled: false,
      });
      const keywordUpdate = vi.fn().mockResolvedValue({
        id: 'kw1',
        organizationId: 'org1',
        keyword: 'storage',
        enabled: true,
      });
      const initialUpsert = vi.fn().mockResolvedValue({});
      const repo = new EngageRepository(
        {} as any,   // _config
        {
          model: {
            engageKeyword: {
              findFirst: keywordFindFirst,
              update: keywordUpdate,
            },
          },
        } as any,
        {} as any,   // _trackedAccount
        {} as any,   // _opportunity
        {} as any,   // _oppState
        {} as any,   // _sentReply
        {} as any,   // _integration
        {} as any,   // _integrationProject
        {} as any,   // _post
        {} as any,   // _tx
        {} as any,   // _scanCursor
        {
          model: { engageKeywordInitialScan: { upsert: initialUpsert } },
        } as any
      );

      await repo.updateKeyword('org1', 'kw1', { enabled: true } as any);

      expect(initialUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            keywordId_platform: { keywordId: 'kw1', platform: 'reddit' },
          },
          update: expect.objectContaining({
            status: 'PENDING',
            startedAt: null,
            completedAt: null,
            error: null,
            attempts: 0,
          }),
        })
      );
      expect(initialUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { keywordId_platform: { keywordId: 'kw1', platform: 'x' } },
          update: expect.objectContaining({
            status: 'PENDING',
            startedAt: null,
            completedAt: null,
            error: null,
            attempts: 0,
          }),
        })
      );
    });

    it('does not reset initial scans for type-only updates', async () => {
      const keywordFindFirst = vi.fn().mockResolvedValue({
        id: 'kw1',
        organizationId: 'org1',
        keyword: 'storage',
        enabled: true,
      });
      const keywordUpdate = vi.fn().mockResolvedValue({
        id: 'kw1',
        organizationId: 'org1',
        keyword: 'storage',
        enabled: true,
      });
      const initialUpsert = vi.fn().mockResolvedValue({});
      const repo = new EngageRepository(
        {} as any,
        {
          model: {
            engageKeyword: {
              findFirst: keywordFindFirst,
              update: keywordUpdate,
            },
          },
        } as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,   // _integrationProject, {} as any,
        {} as any,
        {} as any,
        {
          model: { engageKeywordInitialScan: { upsert: initialUpsert } },
        } as any
      );

      await repo.updateKeyword('org1', 'kw1', { type: 'BRAND' } as any);

      expect(initialUpsert).not.toHaveBeenCalled();
    });
  });

  describe('addMonitoredChannel', () => {
    // (configId, platform, username) is unique — duplicate → 409. Channels write
    // to engageTrackedAccount since the scan-target merge.
    function buildChannelRepo() {
      const channelCreate = vi.fn();
      const trackedAccount = {
        model: { engageTrackedAccount: { create: channelCreate } },
      } as any;
      const repo = new EngageRepository(
        {} as any,
        {} as any,
        trackedAccount,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,   // _integrationProject,
        {} as any,
        {} as any
      );
      return { repo, channelCreate };
    }

    it('maps a P2002 unique violation to a 409 with the channel name', async () => {
      const { repo, channelCreate } = buildChannelRepo();
      channelCreate.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('dup', {
          code: 'P2002',
          clientVersion: 'test',
        })
      );

      await expect(
        repo.addMonitoredChannel('cfg1', 'org1', {
          platform: 'reddit',
          channelId: 'football',
          channelName: 'r/football',
        } as any)
      ).rejects.toMatchObject({
        status: 409,
        message: 'Channel "r/football" already exists',
      });
    });

    it('normalizes the channel key and stores it in the merged target columns', async () => {
      const { repo, channelCreate } = buildChannelRepo();
      channelCreate.mockResolvedValue({
        id: 'ch1',
        configId: 'cfg1',
        organizationId: 'org1',
        platform: 'reddit',
        username: 'football',
        displayName: 'r/football',
        audienceSize: 12,
        enabled: true,
        lastCheckedAt: null,
        metadata: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      });

      const res = await repo.addMonitoredChannel('cfg1', 'org1', {
        platform: 'reddit',
        channelId: 'r/FootBall',
        channelName: 'r/football',
        audienceSize: 12,
      } as any);

      // Stored under the merged column names, key normalized like the scan loop.
      expect(channelCreate.mock.calls[0][0].data).toMatchObject({
        platform: 'reddit',
        username: 'football',
        displayName: 'r/football',
        audienceSize: 12,
      });
      // Returned in the legacy channel shape the API contract still promises.
      expect(res).toMatchObject({
        channelId: 'football',
        channelName: 'r/football',
      });
    });

    it('rejects a platform that has no channel scope', async () => {
      const { repo } = buildChannelRepo();

      await expect(
        repo.addMonitoredChannel('cfg1', 'org1', {
          platform: 'x',
          channelId: 'someone',
          channelName: 'someone',
        } as any)
      ).rejects.toMatchObject({ status: 400 });
    });
  });

  describe('addTrackedAccount', () => {
    // (configId, platform, username) is unique — duplicate → 409.
    function buildTrackedRepo() {
      const trackedCreate = vi.fn();
      const trackedAccount = {
        model: { engageTrackedAccount: { create: trackedCreate } },
      } as any;
      const repo = new EngageRepository(
        {} as any,
        {} as any,
        trackedAccount,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,   // _integrationProject,
        {} as any,
        {} as any
      );
      return { repo, trackedCreate };
    }

    it('rejects a platform that has no author scope', async () => {
      const { repo } = buildTrackedRepo();

      // reddit is channel-scope: it used to be storable here and was then
      // scanned as /r/<username>. Now it is a 400 at the door.
      await expect(
        repo.addTrackedAccount('cfg1', 'org1', {
          platform: 'reddit',
          username: 'spez',
        } as any)
      ).rejects.toMatchObject({ status: 400 });
    });

    it('maps a P2002 unique violation to a 409 with the username', async () => {
      const { repo, trackedCreate } = buildTrackedRepo();
      trackedCreate.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('dup', {
          code: 'P2002',
          clientVersion: 'test',
        })
      );

      await expect(
        repo.addTrackedAccount('cfg1', 'org1', { username: 'elonmusk' } as any)
      ).rejects.toMatchObject({
        status: 409,
        message: 'Account "elonmusk" already exists',
      });
    });

    it('stores the NORMALIZED key, so the scan unit and the fan-out lookup agree', async () => {
      const { repo, trackedCreate } = buildTrackedRepo();
      trackedCreate.mockResolvedValue({ id: 'a1' });

      await repo.addTrackedAccount('cfg1', 'org1', {
        platform: 'x',
        username: '@Alice',
      } as any);

      // Stored raw, '@Alice' would be scanned as unit key 'alice' and then
      // resolve zero subscribers — `equals … insensitive` bridges case but not
      // the '@'. The posts would be fetched and silently discarded.
      expect(trackedCreate.mock.calls[0][0].data).toMatchObject({
        platform: 'x',
        username: 'alice',
      });
    });
  });

  // INV-2's 404 half: a row of one scope must not be reachable through the
  // other scope's endpoint. Only the 400-on-create half had coverage.
  describe('scope isolation on the id-addressed routes', () => {
    function buildScopedRepo() {
      const findFirst = vi.fn();
      const update = vi.fn();
      const del = vi.fn();
      const trackedAccount = {
        model: {
          engageTrackedAccount: { findFirst, update, delete: del },
        },
      } as any;
      const repo = new EngageRepository(
        {} as any,
        {} as any,
        trackedAccount,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,   // _integrationProject,
        {} as any,
        {} as any
      );
      return { repo, findFirst, update, del };
    }

    it('scopes the channel routes to channel-scope platforms', async () => {
      const { repo, findFirst } = buildScopedRepo();
      findFirst.mockResolvedValue(null);

      await expect(
        repo.updateMonitoredChannel('org1', 'id1', { enabled: true } as any)
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        repo.removeMonitoredChannel('org1', 'id1')
      ).rejects.toMatchObject({
        status: 404,
      });

      for (const call of findFirst.mock.calls) {
        expect(call[0].where).toMatchObject({
          organizationId: 'org1',
          platform: { in: ['reddit'] },
        });
      }
    });

    it('scopes the tracked routes to author-scope platforms', async () => {
      const { repo, findFirst } = buildScopedRepo();
      findFirst.mockResolvedValue(null);

      await expect(
        repo.updateTrackedAccount('org1', 'id1', { enabled: true } as any)
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        repo.removeTrackedAccount('org1', 'id1')
      ).rejects.toMatchObject({
        status: 404,
      });

      for (const call of findFirst.mock.calls) {
        expect(call[0].where).toMatchObject({
          organizationId: 'org1',
          platform: { notIn: ['reddit'] },
        });
      }
    });

    it('round-trips a PATCHed channelName through displayName', async () => {
      const { repo, findFirst, update } = buildScopedRepo();
      findFirst.mockResolvedValue({ id: 'ch1', platform: 'reddit' });
      update.mockResolvedValue({
        id: 'ch1',
        configId: 'cfg1',
        organizationId: 'org1',
        platform: 'reddit',
        username: 'seo',
        displayName: 'r/SEO renamed',
        audienceSize: 7,
        enabled: false,
        lastCheckedAt: null,
        metadata: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      });

      const res = await repo.updateMonitoredChannel('org1', 'ch1', {
        channelName: 'r/SEO renamed',
        enabled: false,
      } as any);

      expect(update.mock.calls[0][0].data).toMatchObject({
        displayName: 'r/SEO renamed',
        enabled: false,
      });
      // The legacy shape the API contract still promises, in full.
      expect(res).toMatchObject({
        channelId: 'seo',
        channelName: 'r/SEO renamed',
        audienceSize: 7,
        enabled: false,
        lastScannedAt: null,
        metadata: null,
      });
    });
  });
});

describe('EngageRepository projectId scoping (config-family)', () => {
  // Both lists now read the SAME table, so each also asserts the platform
  // predicate that keeps the two scopes from leaking into each other's endpoint.
  it('listMonitoredChannels defaults to the legacy null-project scope when projectId is omitted', async () => {
    const { repo, channelFindMany } = buildRepo();
    channelFindMany.mockResolvedValue([]);

    await repo.listMonitoredChannels('org-1');

    expect(channelFindMany.mock.calls[0][0].where).toEqual({
      organizationId: 'org-1',
      config: { projectId: null },
      platform: { in: ['reddit'] },
    });
  });

  it('listMonitoredChannels scopes to a given project via the config relation', async () => {
    const { repo, channelFindMany } = buildRepo();
    channelFindMany.mockResolvedValue([]);

    await repo.listMonitoredChannels('org-1', 'proj-1');

    expect(channelFindMany.mock.calls[0][0].where).toEqual({
      organizationId: 'org-1',
      config: { projectId: 'proj-1' },
      platform: { in: ['reddit'] },
    });
  });

  it('listTrackedAccounts defaults to the legacy null-project scope when projectId is omitted', async () => {
    const { repo, trackedFindMany } = buildRepo();
    trackedFindMany.mockResolvedValue([]);

    await repo.listTrackedAccounts('org-1');

    expect(trackedFindMany.mock.calls[0][0].where).toEqual({
      organizationId: 'org-1',
      config: { projectId: null },
      platform: { notIn: ['reddit'] },
    });
  });

  it('listTrackedAccounts scopes to a given project via the config relation', async () => {
    const { repo, trackedFindMany } = buildRepo();
    trackedFindMany.mockResolvedValue([]);

    await repo.listTrackedAccounts('org-1', 'proj-1');

    expect(trackedFindMany.mock.calls[0][0].where).toEqual({
      organizationId: 'org-1',
      config: { projectId: 'proj-1' },
      platform: { notIn: ['reddit'] },
    });
  });
});

describe('EngageRepository.createSentReply projectId/matchedKeywords', () => {
  it('writes projectId=null and matchedKeywords=[] when omitted (legacy call shape)', async () => {
    const { repo, sentCreate } = buildRepo();
    sentCreate.mockResolvedValue({ id: 'reply-1' });

    await repo.createSentReply({
      organizationId: 'org-1',
      opportunityId: 'opp-1',
      postId: 'post-1',
      inputData: {},
    });

    expect(sentCreate.mock.calls[0][0].data).toMatchObject({
      organizationId: 'org-1',
      projectId: null,
      opportunityId: 'opp-1',
      postId: 'post-1',
      matchedKeywords: [],
    });
  });

  it('writes the given projectId and matchedKeywords through untouched', async () => {
    const { repo, sentCreate } = buildRepo();
    sentCreate.mockResolvedValue({ id: 'reply-1' });

    await repo.createSentReply({
      organizationId: 'org-1',
      projectId: 'proj-1',
      opportunityId: 'opp-1',
      postId: 'post-1',
      inputData: {},
      matchedKeywords: ['react', 'nextjs'],
    });

    expect(sentCreate.mock.calls[0][0].data).toMatchObject({
      projectId: 'proj-1',
      matchedKeywords: ['react', 'nextjs'],
    });
  });
});

describe('EngageRepository.addTrackedAccount validation', () => {
  it('rejects a username that could shape the from: search query', async () => {
    const { repo } = buildRepo();
    await expect(
      repo.addTrackedAccount('cfg1', 'org1', {
        username: 'evil) OR is:verified',
        platform: 'x',
      } as any)
    ).rejects.toThrow(/Invalid x username/);
  });

  it('rejects an over-long X handle (>15 chars)', async () => {
    const { repo } = buildRepo();
    await expect(
      repo.addTrackedAccount('cfg1', 'org1', {
        username: 'thishandleistoolong',
        platform: 'x',
      } as any)
    ).rejects.toThrow(/Invalid/);
  });
});

describe('EngageRepository.getOrgScanStatus', () => {
  // Cadence is the org's single plan scan_interval_hours (keyword/channel/tracked
  // alike). With no interval passed it falls back to DEFAULT_SCAN_INTERVAL_HOURS = 24h.
  const H = 3_600_000;

  it('derives keyword next = lastScanStartedAt + cadence; last = lastScannedAt', async () => {
    const {
      repo,
      channelFindMany,
      trackedFindMany,
      cursorFindMany,
      keywordFindMany,
    } = buildRepo();
    const started = new Date('2026-06-01T00:00:00Z');
    const scanned = new Date('2026-06-01T00:05:00Z');
    channelFindMany.mockResolvedValue([]); // org monitors no subreddits
    trackedFindMany.mockResolvedValue([]); // org tracks no accounts
    keywordFindMany.mockResolvedValue([{ keyword: 'ai' }]); // org has one keyword
    cursorFindMany.mockImplementation(async ({ where }: any) =>
      where.scanType === 'keyword'
        ? [
            {
              lastScanStartedAt: started,
              lastScannedAt: scanned,
              cooldownUntil: null,
            },
          ]
        : []
    );

    const st = await repo.getOrgScanStatus('org1');
    expect(st.keyword.lastScanAt).toEqual(scanned);
    expect(st.keyword.nextScanAt).toEqual(new Date(started.getTime() + 24 * H));
    // Scoped types the org hasn't configured report null.
    expect(st.channel).toEqual({ lastScanAt: null, nextScanAt: null });
    expect(st.tracked).toEqual({ lastScanAt: null, nextScanAt: null });
    // Overall folds across types. `lastScanAt` is the latest across tracks and
    // `nextScanAt` the soonest — opposite directions, so the pair could invert.
    // The per-track value above is genuinely in the past (overdue = due now),
    // but the top-level one is floored at `now` so the two never contradict.
    const overdue = new Date(started.getTime() + 24 * H);
    expect(st.lastScanAt).toEqual(scanned);
    expect(st.nextScanAt!.getTime()).toBeGreaterThan(overdue.getTime());
    expect(st.nextScanAt!.getTime()).toBeGreaterThanOrEqual(
      st.lastScanAt!.getTime()
    );
  });

  // REGRESSION. `lastScanAt` folds with max() and `nextScanAt` with min(), so
  // they can describe different tracks: a keyword scan that just finished next
  // to a tracked cursor overdue since July reported "last scan today, next scan
  // in July". The per-track fields keep the overdue timestamp (the extension
  // reads `nextScanAt <= now` as "due now"); only the aggregate is floored.
  it('never reports a top-level nextScanAt earlier than lastScanAt', async () => {
    const {
      repo,
      channelFindMany,
      trackedFindMany,
      cursorFindMany,
      keywordFindMany,
    } = buildRepo();
    const freshKeywordScan = new Date('2026-08-28T00:55:00Z');
    const abandonedTracked = new Date('2026-07-23T21:08:00Z'); // stalled for a month
    channelFindMany.mockResolvedValue([]);
    trackedFindMany.mockResolvedValue([{ platform: 'x', username: 'someone' }]);
    keywordFindMany.mockResolvedValue([{ keyword: 'ai' }]);
    cursorFindMany.mockImplementation(async ({ where }: any) =>
      where.scanType === 'keyword'
        ? [
            {
              lastScanStartedAt: freshKeywordScan,
              lastScannedAt: freshKeywordScan,
              cooldownUntil: null,
            },
          ]
        : where.scanType === 'tracked'
          ? [
              {
                lastScanStartedAt: abandonedTracked,
                lastScannedAt: abandonedTracked,
                cooldownUntil: null,
              },
            ]
          : []
    );

    const st = await repo.getOrgScanStatus('org1');
    // The stalled track still reports its real, overdue next — that is what
    // makes it visible as "should have run long ago".
    expect(st.tracked.nextScanAt!.getTime()).toBeLessThan(Date.now());
    // The aggregate must not inherit it.
    expect(st.nextScanAt!.getTime()).toBeGreaterThanOrEqual(
      st.lastScanAt!.getTime()
    );
  });

  it('cooldownUntil pushes next scan beyond the cadence', async () => {
    const {
      repo,
      channelFindMany,
      trackedFindMany,
      cursorFindMany,
      keywordFindMany,
    } = buildRepo();
    const started = new Date('2026-06-01T00:00:00Z');
    const cooldown = new Date('2026-06-05T00:00:00Z'); // far past started + 24h
    channelFindMany.mockResolvedValue([]);
    trackedFindMany.mockResolvedValue([]);
    keywordFindMany.mockResolvedValue([{ keyword: 'ai' }]);
    cursorFindMany.mockImplementation(async ({ where }: any) =>
      where.scanType === 'keyword'
        ? [
            {
              lastScanStartedAt: started,
              lastScannedAt: started,
              cooldownUntil: cooldown,
            },
          ]
        : []
    );

    const st = await repo.getOrgScanStatus('org1');
    expect(st.keyword.nextScanAt).toEqual(cooldown);
  });

  it("aggregates the org's channel cursors: latest last, earliest next", async () => {
    const { repo, channelFindMany, trackedFindMany, cursorFindMany } =
      buildRepo();
    // getOrgScanStatus reads the merged table in ONE query and splits by
    // platform, so the channel stub must carry its platform now.
    channelFindMany.mockResolvedValue([
      { platform: 'reddit', username: 'a' },
      { platform: 'reddit', username: 'b' },
    ]);
    trackedFindMany.mockResolvedValue([]);
    const aStart = new Date('2026-06-01T00:00:00Z'); // next = +24h
    const bStart = new Date('2026-06-01T01:00:00Z'); // next = +24h (later)
    const aScanned = new Date('2026-06-01T00:10:00Z');
    const bScanned = new Date('2026-06-01T01:10:00Z'); // latest completion
    cursorFindMany.mockImplementation(async ({ where }: any) =>
      where.scanType === 'channel'
        ? [
            {
              lastScanStartedAt: aStart,
              lastScannedAt: aScanned,
              cooldownUntil: null,
            },
            {
              lastScanStartedAt: bStart,
              lastScannedAt: bScanned,
              cooldownUntil: null,
            },
          ]
        : []
    );

    const st = await repo.getOrgScanStatus('org1');
    expect(st.channel.lastScanAt).toEqual(bScanned); // max of completions
    expect(st.channel.nextScanAt).toEqual(new Date(aStart.getTime() + 24 * H)); // earliest due
    // Queried exactly this org's subreddit ids, under their own platform's arm.
    expect(cursorFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          scanType: 'channel',
          OR: [{ platform: 'reddit', scanKey: { in: ['a', 'b'] } }],
        }),
      })
    );
  });

  it('lowercases tracked usernames for the cursor lookup', async () => {
    const { repo, channelFindMany, trackedFindMany, cursorFindMany } =
      buildRepo();
    channelFindMany.mockResolvedValue([]);
    trackedFindMany.mockResolvedValue([
      { platform: 'x', username: 'OpenAI' },
      { platform: 'x', username: 'Vercel' },
    ]);
    cursorFindMany.mockResolvedValue([]);

    await repo.getOrgScanStatus('org1');
    expect(cursorFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          scanType: 'tracked',
          OR: [{ platform: 'x', scanKey: { in: ['openai', 'vercel'] } }],
        }),
      })
    );
  });

  // REGRESSION. The author-feed lookup pinned `platform: 'x'`, from back when X
  // was the only one — so a LinkedIn / dev.to / Medium / Quora / Hacker News
  // account was configured, enumerated and scanned, yet never appeared in the
  // status at all. Each platform gets its OWN arm because scan keys are unique
  // only within a platform, and because normalisation is per-platform: x and
  // dev.to handles lowercase, LinkedIn's stay verbatim.
  it('groups author-feed targets by platform instead of pinning x', async () => {
    const {
      repo,
      channelFindMany,
      trackedFindMany,
      cursorFindMany,
      keywordFindMany,
    } = buildRepo();
    channelFindMany.mockResolvedValue([
      { platform: 'reddit', username: 'Programming' },
    ]);
    trackedFindMany.mockResolvedValue([
      { platform: 'x', username: 'OpenAI' },
      { platform: 'linkedin', username: 'Acme' },
      { platform: 'devto', username: 'Ben' },
    ]);
    keywordFindMany.mockResolvedValue([]);
    const started = new Date('2026-06-01T00:00:00Z');
    const scanned = new Date('2026-06-01T00:05:00Z');
    cursorFindMany.mockImplementation(async ({ where }: any) =>
      where.scanType === 'tracked'
        ? [
            {
              lastScanStartedAt: started,
              lastScannedAt: scanned,
              cooldownUntil: null,
            },
          ]
        : []
    );

    const st = await repo.getOrgScanStatus('org1');

    const trackedCall = cursorFindMany.mock.calls.find(
      ([args]: any) => args?.where?.scanType === 'tracked'
    );
    expect(trackedCall![0].where.OR).toEqual([
      { platform: 'x', scanKey: { in: ['openai'] } },
      { platform: 'linkedin', scanKey: { in: ['Acme'] } },
      { platform: 'devto', scanKey: { in: ['ben'] } },
    ]);
    // The reddit row stays in the channel scope, not folded in with the authors.
    const channelCall = cursorFindMany.mock.calls.find(
      ([args]: any) => args?.where?.scanType === 'channel'
    );
    expect(channelCall![0].where.OR).toEqual([
      { platform: 'reddit', scanKey: { in: ['programming'] } },
    ]);
    expect(st.tracked.lastScanAt).toEqual(scanned);
  });

  // The reported set must equal the set the scan loop enumerates. The next four
  // cover the two axes on which they had drifted apart; either drift strands a
  // cursor that is counted here but scanned nowhere, and since `nextScanAt`
  // folds with min(), ONE such cursor pins the aggregate to a permanently
  // overdue time — which the top-level floor then renders as "due right now" on
  // every single call, making refreshOnVisit's throttle branch unreachable.
  const SCANNED_CONFIG = { enabled: true, projectId: { not: null } };

  // REGRESSION (config axis). Keywords/targets used to be read org-wide, which
  // included the legacy null-project config — excluded from every scan path, so
  // its cursors froze on the day that exclusion landed.
  it('reads keywords and targets through the same config filter the scan loop uses', async () => {
    const {
      repo,
      channelFindMany,
      trackedFindMany,
      cursorFindMany,
      keywordFindMany,
    } = buildRepo();
    channelFindMany.mockResolvedValue([]);
    trackedFindMany.mockResolvedValue([]);
    keywordFindMany.mockResolvedValue([]);
    cursorFindMany.mockResolvedValue([]);

    await repo.getOrgScanStatus('org1');

    expect(keywordFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: 'org1',
          enabled: true,
          config: SCANNED_CONFIG,
        }),
      })
    );
    // Channels and tracked accounts are one query on the merged table, so the
    // spec's dispatcher hands it to both stubs.
    expect(trackedFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: 'org1',
          enabled: true,
          config: SCANNED_CONFIG,
        }),
      })
    );
  });

  // REGRESSION (platform axis). Keyword units fan out per allowlist platform, so
  // switching X off (its documented kill switch) leaves every keyword's x cursor
  // frozen. The lookup used to span all platforms and counted them.
  it('narrows keyword cursors to the resolved scan allowlist', async () => {
    const {
      repo,
      channelFindMany,
      trackedFindMany,
      cursorFindMany,
      keywordFindMany,
    } = buildRepo();
    channelFindMany.mockResolvedValue([]);
    trackedFindMany.mockResolvedValue([]);
    keywordFindMany.mockResolvedValue([{ keyword: 'ai' }]);
    cursorFindMany.mockResolvedValue([]);

    await repo.getOrgScanStatus('org1', 24, ['reddit']);

    expect(cursorFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          scanType: 'keyword',
          platform: { in: ['reddit'] },
        }),
      })
    );
  });

  // A target carries its own platform, so there the allowlist filters the
  // targets before they are grouped into query arms — a platform with nothing
  // left is not queried at all.
  it('drops the channel and tracked tracks when their platform is off the allowlist', async () => {
    const {
      repo,
      channelFindMany,
      trackedFindMany,
      cursorFindMany,
      keywordFindMany,
    } = buildRepo();
    channelFindMany.mockResolvedValue([{ platform: 'reddit', username: 'a' }]);
    trackedFindMany.mockResolvedValue([{ platform: 'x', username: 'openai' }]);
    keywordFindMany.mockResolvedValue([]);
    cursorFindMany.mockResolvedValue([]);

    const st = await repo.getOrgScanStatus('org1', 24, ['linkedin']);

    expect(st.channel).toEqual({ lastScanAt: null, nextScanAt: null });
    expect(st.tracked).toEqual({ lastScanAt: null, nextScanAt: null });
    // Not merely folded away afterwards — never queried at all.
    expect(cursorFindMany).not.toHaveBeenCalled();

    // A PARTIAL allowlist drops only what falls outside it: same two targets,
    // allowlist `x` — the reddit channel goes, the x author feed stays.
    const partial = buildRepo();
    partial.channelFindMany.mockResolvedValue([
      { platform: 'reddit', username: 'a' },
    ]);
    partial.trackedFindMany.mockResolvedValue([
      { platform: 'x', username: 'openai' },
    ]);
    partial.keywordFindMany.mockResolvedValue([]);
    partial.cursorFindMany.mockResolvedValue([]);

    await partial.repo.getOrgScanStatus('org1', 24, ['x']);

    expect(
      partial.cursorFindMany.mock.calls.map(([args]: any) => args.where.scanType)
    ).toEqual(['tracked']);
  });

  // A status reader must not narrow to zero because a caller could not resolve
  // the allowlist (no scan-config service wired in, or the Settings read threw):
  // an unresolvable gate degrades to the old, wider reading.
  it('applies no platform gate when the allowlist is absent or empty', async () => {
    for (const platforms of [undefined, []]) {
      const {
        repo,
        channelFindMany,
        trackedFindMany,
        cursorFindMany,
        keywordFindMany,
      } = buildRepo();
      channelFindMany.mockResolvedValue([]);
      trackedFindMany.mockResolvedValue([]);
      keywordFindMany.mockResolvedValue([{ keyword: 'ai' }]);
      cursorFindMany.mockResolvedValue([]);

      await repo.getOrgScanStatus('org1', 24, platforms);

      const kwCall = cursorFindMany.mock.calls.find(
        ([args]: any) => args?.where?.scanType === 'keyword'
      );
      expect(kwCall?.[0].where.platform).toBeUndefined();
    }
  });

  // These decorate each keyword / channel / account on /engage/config with its
  // own cursor row. Same gate as the aggregate above, same reason: a platform
  // the operator switched off would otherwise show a permanently-overdue "next
  // scan" for something nothing scans.
  describe('per-unit cursor decorators — allowlist gate', () => {
    it('narrows the keyword lookup to the allowlist, and applies none without one', async () => {
      const { repo, cursorFindMany } = buildRepo();
      cursorFindMany.mockResolvedValue([]);

      await repo.getKeywordCursors(['ai'], 24 * H, Date.now(), ['reddit']);
      expect(cursorFindMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ platform: { in: ['reddit'] } }),
        })
      );

      await repo.getKeywordCursors(['ai'], 24 * H);
      expect(
        cursorFindMany.mock.calls.at(-1)![0].where.platform
      ).toBeUndefined();
    });

    it('drops a target whose platform is off the allowlist', async () => {
      const { repo, cursorFindMany } = buildRepo();
      cursorFindMany.mockResolvedValue([
        {
          platform: 'x',
          scanKey: 'openai',
          lastScanStartedAt: new Date('2026-06-01T00:00:00Z'),
          lastScannedAt: new Date('2026-06-01T00:05:00Z'),
          cooldownUntil: null,
        },
      ]);

      const out = await repo.getTrackedCursors(
        [
          { platform: 'x', username: 'openai' },
          { platform: 'linkedin', username: 'Acme' },
        ],
        24 * H,
        Date.now(),
        ['x']
      );

      // The LinkedIn account reports no cursor at all rather than a frozen one,
      // and is gone before the query is built — its key is not even asked for.
      expect(Object.keys(out)).toEqual(['x:openai']);
      expect(cursorFindMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            scanType: 'tracked',
            scanKey: { in: ['openai'] },
            platform: { in: ['x'] },
          }),
        })
      );

      // Nothing left in scope → no query at all, not an empty-result one.
      const allOut = buildRepo();
      const empty = await allOut.repo.getTrackedCursors(
        [{ platform: 'linkedin', username: 'Acme' }],
        24 * H,
        Date.now(),
        ['x']
      );
      expect(empty).toEqual({});
      expect(allOut.cursorFindMany).not.toHaveBeenCalled();
    });
  });

  describe('getOpportunityForReply — status gate (no time-based expiry)', () => {
    it('returns the merged opportunity for an actionable NEW row', async () => {
      const { repo, stateFindFirst } = buildRepo();
      stateFindFirst.mockResolvedValue({ ...STATE_ROW, status: 'NEW' });

      const opp = (await repo.getOpportunityForReply('org1', 'opp1')) as any;
      expect(opp.id).toBe('opp1');
      expect(opp.stateId).toBe('state1');
      expect(opp.status).toBe('NEW');
    });

    it('resolves an unscoped reply id as the per-project state id', async () => {
      const { repo, stateFindFirst } = buildRepo();
      stateFindFirst.mockResolvedValue({
        ...STATE_ROW,
        projectId: 'proj1',
        status: 'NEW',
      });

      const opp = (await repo.getOpportunityForReply('org1', 'state1')) as any;

      expect(opp.id).toBe('opp1');
      expect(opp.stateId).toBe('state1');
      expect(opp.projectId).toBe('proj1');
      expect(stateFindFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { organizationId: 'org1', id: 'state1' },
        })
      );
    });

    it('allows an AUTO_QUEUED row', async () => {
      const { repo, stateFindFirst } = buildRepo();
      stateFindFirst.mockResolvedValue({ ...STATE_ROW, status: 'AUTO_QUEUED' });

      const opp = (await repo.getOpportunityForReply('org1', 'opp1')) as any;
      expect(opp.id).toBe('opp1');
    });

    it.each([
      ['EXPIRED', 'engage_opportunity_expired', 'expired'],
      ['REPLIED', 'engage_opportunity_replied', 'already replied'],
      ['SCHEDULED', 'engage_opportunity_scheduled', 'already scheduled'],
      ['DISMISSED', 'engage_opportunity_dismissed', 'dismissed'],
    ])(
      'blocks a %s row with a typed reason instead of a generic 404',
      async (status, code, reasonFragment) => {
        const { repo, stateFindFirst } = buildRepo();
        stateFindFirst.mockResolvedValue({ ...STATE_ROW, status });

        await expect(
          repo.getOpportunityForReply('org1', 'opp1')
        ).rejects.toMatchObject({
          // ForbiddenException — surfaced as a typed code + human reason so the
          // UI can tell the user why generation is blocked.
          response: {
            code,
            message: expect.stringContaining(reasonFragment),
          },
        });
      }
    );

    it('404s only a genuinely missing row', async () => {
      const { repo, stateFindFirst } = buildRepo();
      stateFindFirst.mockResolvedValue(null);
      await expect(
        repo.getOpportunityForReply('org1', 'missing')
      ).rejects.toThrow('Opportunity not found');
    });
  });

  // The four granular states roll up into two combined status values:
  //   `awaiting` = manual link-pending (PUBLISHED + no releaseURL) OR error —
  //                "generated but not yet live" (folds in the former
  //                GET /engage/awaiting-review endpoint).
  //   `settled`  = published (PUBLISHED + releaseURL) OR scheduled (QUEUE) —
  //                "no further action needed". The exact complement of `awaiting`.
  describe('combined status filters (awaiting / settled)', () => {
    it('status=awaiting OR-combines DRAFT + the two unpublished buckets', async () => {
      const { repo, sentFindMany, sentCount, stateFindMany } = buildRepo();
      sentFindMany.mockResolvedValue([]);
      sentCount.mockResolvedValue(0);

      await repo.listSentReplies('org1', { status: 'awaiting' } as any);

      const where = sentFindMany.mock.calls[0][0].where;
      expect(where.post.OR).toEqual([
        { state: 'DRAFT' },
        { state: 'PUBLISHED', releaseURL: null },
        { state: 'ERROR' },
      ]);
      expect(where.post.source).toBe('engage');
      // No rows → skip the matchedKeywords join entirely.
      expect(stateFindMany).not.toHaveBeenCalled();
    });

    it('no status filter ("All") LIST includes DRAFT (no state exclusion) so awaiting can never exceed it', async () => {
      const { repo, sentFindMany, sentCount } = buildRepo();
      sentFindMany.mockResolvedValue([]);
      sentCount.mockResolvedValue(0);

      await repo.listSentReplies('org1', {} as any);

      const where = sentFindMany.mock.calls[0][0].where;
      // The list passes includeDrafts:true, so the "All" view applies NO state
      // filter — every engage item (incl. DRAFT working-copies) is returned.
      expect(where.post).toEqual({ source: 'engage' });
    });

    it('no status filter ("All") STATS still excludes DRAFT (sent-reply performance only)', async () => {
      const { repo, sentCount, sentFindMany, postAggregate } = buildRepo();
      sentCount.mockResolvedValue(0);
      postAggregate.mockResolvedValue({
        _sum: { impressions: 0, trafficScore: 0 },
      });
      sentFindMany.mockResolvedValue([]);

      await repo.getSentStats('org1', {});

      // Stats keep includeDrafts:false → a never-sent draft must not pollute the
      // "发出回复" / response-rate / impression cards.
      expect(sentCount.mock.calls[0][0].where.post).toEqual({
        source: 'engage',
        state: { not: 'DRAFT' },
      });
    });

    it('status=settled OR-combines published(live) + scheduled', async () => {
      const { repo, sentFindMany, sentCount } = buildRepo();
      sentFindMany.mockResolvedValue([]);
      sentCount.mockResolvedValue(0);

      await repo.listSentReplies('org1', { status: 'settled' } as any);

      const where = sentFindMany.mock.calls[0][0].where;
      expect(where.post.OR).toEqual([
        { state: 'PUBLISHED', releaseURL: { not: null } },
        { state: 'QUEUE' },
      ]);
      expect(where.post.source).toBe('engage');
    });

    it('getSentStats applies the same combined OR to the stats scope', async () => {
      const { repo, sentCount, sentFindMany, postAggregate } = buildRepo();
      sentCount.mockResolvedValue(0);
      postAggregate.mockResolvedValue({
        _sum: { impressions: 0, trafficScore: 0 },
      });
      sentFindMany.mockResolvedValue([]);

      await repo.getSentStats('org1', { status: 'awaiting' });

      expect(sentCount.mock.calls[0][0].where.post).toMatchObject({
        source: 'engage',
        OR: [
          { state: 'DRAFT' },
          { state: 'PUBLISHED', releaseURL: null },
          { state: 'ERROR' },
        ],
      });
    });
  });

  describe('appendGenerationHistory', () => {
    it('issues an atomic jsonb concat scoped to the org + opportunity', async () => {
      const { repo, stateExecuteRaw } = buildRepo();
      const entry = {
        source: 'ai' as const,
        content: 'a generated reply',
        length: 'medium' as const,
        cost: 3,
        strategy: 'EXPERT_ANSWER',
        brandStrength: 1,
        billingTaskId: 'postiz_engage_reply_opp1_123_abcd',
        createdAt: '2026-06-16T00:00:00Z',
      };

      await repo.appendGenerationHistory('org1', 'opp1', entry);

      // One raw UPDATE; the tagged-template params carry the serialized entry +
      // org/opportunity scope so two concurrent generations can't clobber.
      expect(stateExecuteRaw).toHaveBeenCalledTimes(1);
      const params = stateExecuteRaw.mock.calls[0].slice(1);
      expect(params).toContain('org1');
      expect(params).toContain('opp1');
      expect(params).toContain(JSON.stringify([entry]));
    });
  });

  describe('recordManualGeneration (manual draft versions, deduped)', () => {
    const manualEntry = {
      source: 'manual' as const,
      content: 'hand-typed reply',
      strategy: 'EXPERT_ANSWER',
      brandStrength: 0,
      createdAt: '2026-06-16T00:00:00Z',
    };

    it('appends a manual entry when the content differs from the latest', async () => {
      const { repo, stateFindFirst, stateExecuteRaw } = buildRepo();
      stateFindFirst.mockResolvedValue({
        generationHistory: [{ source: 'ai', content: 'an older AI draft' }],
      });

      const wrote = await repo.recordManualGeneration(
        'org1',
        'opp1',
        manualEntry
      );

      expect(wrote).toBe(true);
      expect(stateExecuteRaw).toHaveBeenCalledTimes(1);
    });

    it('skips (no append) when the content matches the most-recent entry', async () => {
      const { repo, stateFindFirst, stateExecuteRaw } = buildRepo();
      stateFindFirst.mockResolvedValue({
        generationHistory: [{ source: 'ai', content: 'hand-typed reply' }],
      });

      const wrote = await repo.recordManualGeneration(
        'org1',
        'opp1',
        manualEntry
      );

      expect(wrote).toBe(false);
      expect(stateExecuteRaw).not.toHaveBeenCalled();
    });

    it('returns false without writing when no state row exists', async () => {
      const { repo, stateFindFirst, stateExecuteRaw } = buildRepo();
      stateFindFirst.mockResolvedValue(null);

      const wrote = await repo.recordManualGeneration(
        'org1',
        'opp1',
        manualEntry
      );

      expect(wrote).toBe(false);
      expect(stateExecuteRaw).not.toHaveBeenCalled();
    });
  });

  describe('upsertDraft (save-draft)', () => {
    it('creates a Post(state=DRAFT, source=engage) + EngageSentReply when none exists', async () => {
      const {
        repo,
        sentFindFirst,
        postCreate,
        sentCreate,
        postUpdate,
        txTransaction,
      } = buildRepo();
      sentFindFirst.mockResolvedValue(null); // no existing draft
      postCreate.mockResolvedValue({ id: 'post-d' });
      sentCreate.mockResolvedValue({ id: 'reply-d', postId: 'post-d' });

      await repo.upsertDraft('org1', 'opp1', {
        platform: 'x',
        content: 'my draft reply',
        inputData: { strategy: 'EXPERT_ANSWER', brandStrength: 1 },
      });

      // Atomic: the lookup + both writes run inside ONE transaction (no orphan Post
      // on partial failure).
      expect(txTransaction).toHaveBeenCalledTimes(1);

      // The lookup is scoped to this org+opportunity AND DRAFT state.
      expect(sentFindFirst.mock.calls[0][0].where).toEqual({
        organizationId: 'org1',
        projectId: null,
        opportunityId: 'opp1',
        post: { state: 'DRAFT' },
      });
      // A DRAFT engage Post is created (not published, no claim).
      expect(postCreate.mock.calls[0][0].data).toMatchObject({
        organizationId: 'org1',
        content: 'my draft reply',
        state: 'DRAFT',
        source: 'engage',
        providerIdentifier: 'x',
        settings: JSON.stringify({ __type: 'x' }),
      });
      // Linked to a fresh EngageSentReply; no in-place update on the create path.
      expect(sentCreate.mock.calls[0][0].data).toMatchObject({
        organizationId: 'org1',
        opportunityId: 'opp1',
        postId: 'post-d',
      });
      expect(postUpdate).not.toHaveBeenCalled();
    });

    it('updates the existing draft in place (no second Post created)', async () => {
      const {
        repo,
        sentFindFirst,
        postUpdate,
        sentUpdate,
        postCreate,
        sentCreate,
      } = buildRepo();
      sentFindFirst.mockResolvedValue({ id: 'reply-d', postId: 'post-d' });
      postUpdate.mockResolvedValue({ id: 'post-d' });
      sentUpdate.mockResolvedValue({ id: 'reply-d' });

      await repo.upsertDraft('org1', 'opp1', {
        platform: 'reddit',
        content: 'edited draft',
        inputData: { strategy: 'DATA_BACKED', brandStrength: 2 },
      });

      expect(postUpdate.mock.calls[0][0]).toMatchObject({
        where: { id: 'post-d' },
        data: { content: 'edited draft' },
      });
      expect(sentUpdate.mock.calls[0][0]).toMatchObject({
        where: { id: 'reply-d' },
      });
      // Upsert — never creates a second draft.
      expect(postCreate).not.toHaveBeenCalled();
      expect(sentCreate).not.toHaveBeenCalled();
    });

    // A draft written before the platform fix carries providerIdentifier
    // 'reddit'. Editing it must repair the row, not preserve the lie — otherwise
    // the only cure is the backfill migration.
    it('re-stamps the real platform when an existing draft is edited', async () => {
      const { repo, sentFindFirst, postUpdate, sentUpdate } = buildRepo();
      sentFindFirst.mockResolvedValue({
        id: 'reply-d',
        postId: 'post-d',
        post: { settings: JSON.stringify({ __type: 'reddit' }) },
      });
      postUpdate.mockResolvedValue({ id: 'post-d' });
      sentUpdate.mockResolvedValue({ id: 'reply-d' });

      await repo.upsertDraft('org1', 'opp1', {
        platform: 'hackernews',
        content: 'edited',
        inputData: {},
      });

      expect(postUpdate.mock.calls[0][0].data).toMatchObject({
        content: 'edited',
        providerIdentifier: 'hackernews',
      });
      expect(
        JSON.parse(postUpdate.mock.calls[0][0].data.settings).__type
      ).toBe('hackernews');
    });

    // settings also carries engageAuthor (who posted a manual reply), merged in
    // by the publish paths. Re-stamping __type must not drop it.
    it('preserves every other settings key when re-stamping __type', async () => {
      const { repo, sentFindFirst, postUpdate, sentUpdate } = buildRepo();
      const engageAuthor = { handle: 'someone', id: 't2_1' };
      sentFindFirst.mockResolvedValue({
        id: 'reply-d',
        postId: 'post-d',
        post: { settings: JSON.stringify({ __type: 'reddit', engageAuthor }) },
      });
      postUpdate.mockResolvedValue({ id: 'post-d' });
      sentUpdate.mockResolvedValue({ id: 'reply-d' });

      await repo.upsertDraft('org1', 'opp1', {
        platform: 'quora',
        content: 'edited',
        inputData: {},
      });

      expect(JSON.parse(postUpdate.mock.calls[0][0].data.settings)).toEqual({
        __type: 'quora',
        engageAuthor,
      });
    });

    // A row whose settings never parsed must still come out with a usable
    // discriminator rather than throwing the edit away.
    it.each([null, undefined, 'not json at all', '[1,2]'])(
      'falls back to a fresh {__type} when settings is %s',
      async (settings) => {
        const { repo, sentFindFirst, postUpdate, sentUpdate } = buildRepo();
        sentFindFirst.mockResolvedValue({
          id: 'reply-d',
          postId: 'post-d',
          post: { settings },
        });
        postUpdate.mockResolvedValue({ id: 'post-d' });
        sentUpdate.mockResolvedValue({ id: 'reply-d' });

        await repo.upsertDraft('org1', 'opp1', {
          platform: 'devto',
          content: 'edited',
          inputData: {},
        });

        expect(JSON.parse(postUpdate.mock.calls[0][0].data.settings)).toEqual({
          __type: 'devto',
        });
      }
    );

    // The reply is filed under the opportunity's OWN platform. This used to be
    // `platform === 'x' ? 'x' : 'reddit'`, which stored every hackernews, quora,
    // linkedin, medium and devto reply as a reddit row — the admin Post list and
    // the calendar filter on this column, so a Hacker News reply appeared as a
    // reddit post whose releaseURL pointed at news.ycombinator.com.
    it.each(['hackernews', 'quora', 'linkedin', 'medium', 'devto', 'reddit', 'x'])(
      'stores a %s reply under its real platform, never collapsed to reddit',
      async (platform) => {
        const { repo, sentFindFirst, postCreate, sentCreate } = buildRepo();
        sentFindFirst.mockResolvedValue(null);
        postCreate.mockResolvedValue({ id: 'post-d' });
        sentCreate.mockResolvedValue({ id: 'reply-d', postId: 'post-d' });

        await repo.upsertDraft('org1', 'opp1', {
          platform,
          content: 'reply',
          inputData: {},
        });

        expect(postCreate.mock.calls[0][0].data).toMatchObject({
          providerIdentifier: platform,
          settings: JSON.stringify({ __type: platform }),
        });
      }
    );
  });

  describe('draft cleanup on a committed reply', () => {
    it('createSentReply deletes every UNSENT reply for the opportunity', async () => {
      const { repo, sentCreate, sentFindMany, postDeleteMany } = buildRepo();
      sentCreate.mockResolvedValue({ id: 'reply-1' });
      // A saved draft exists for this opportunity.
      sentFindMany.mockResolvedValue([{ postId: 'post-d' }]);

      await repo.createSentReply({
        organizationId: 'org1',
        opportunityId: 'opp1',
        postId: 'post-real',
        inputData: {},
      });

      // Both unsent states, and the QUEUE half is the one that matters: an
      // automated reply queued BEFORE the user replied by hand is already past
      // pickAutoReplyCandidates' exclusion and would otherwise go out too,
      // posting the same opportunity twice. `releaseURL: null` keeps a published
      // row — history — out of it.
      const where = sentFindMany.mock.calls[0][0].where;
      expect(where).toMatchObject({
        organizationId: 'org1',
        projectId: null,
        opportunityId: 'opp1',
      });
      expect(where.post.state).toEqual({ in: ['DRAFT', 'QUEUE'] });
      expect(where.post.releaseURL).toBeNull();
      // Un-held only. Deleting a reply the extension is mid-send on cannot call
      // it back — it would only destroy the record of a reply that goes live
      // anyway, leaving it unbillable and invisible in Sent.
      expect(where.post.OR[0]).toEqual({ releaseId: null });
      expect(where.post.OR[1].claimedAt.lte).toBeInstanceOf(Date);
      expect(postDeleteMany.mock.calls[0][0]).toEqual({
        where: { id: { in: ['post-d'] } },
      });
    });

    it('claimOpportunityForReply does NOT delete drafts (a rolled-back publish keeps the draft)', async () => {
      const { repo, stateFindFirst, stateUpdateMany, postDeleteMany } =
        buildRepo();
      stateFindFirst
        .mockResolvedValueOnce({ status: 'NEW' })
        .mockResolvedValueOnce({ ...STATE_ROW, status: 'REPLIED' });
      stateUpdateMany.mockResolvedValue({ count: 1 });

      await repo.claimOpportunityForReply('org1', 'opp1', 'REPLIED');

      // Cleanup moved to createSentReply (post-commit), so the claim itself must not
      // touch drafts — otherwise a failed publish would lose the saved draft.
      expect(postDeleteMany).not.toHaveBeenCalled();
    });

    it('claimOpportunityForReply throws 403 with a typed reason for a non-actionable status (already replied)', async () => {
      const { repo, stateFindFirst, stateUpdateMany } = buildRepo();
      stateFindFirst.mockResolvedValueOnce({ status: 'REPLIED' });

      await expect(
        repo.claimOpportunityForReply('org1', 'opp1', 'REPLIED')
      ).rejects.toMatchObject({
        status: 403,
        response: { code: 'engage_opportunity_replied' },
      });
      // Rejected at the status gate — the CAS update must never run.
      expect(stateUpdateMany).not.toHaveBeenCalled();
    });

    it('claimOpportunityForReply throws 409 when a concurrent request won the claim (CAS count=0)', async () => {
      const { repo, stateFindFirst, stateUpdateMany } = buildRepo();
      stateFindFirst.mockResolvedValueOnce({ status: 'NEW' });
      stateUpdateMany.mockResolvedValue({ count: 0 });

      await expect(
        repo.claimOpportunityForReply('org1', 'opp1', 'REPLIED')
      ).rejects.toMatchObject({ status: 409 });
    });

    it('claimOpportunityForReply throws 404 only when the per-org state row is genuinely missing', async () => {
      const { repo, stateFindFirst } = buildRepo();
      stateFindFirst.mockResolvedValueOnce(null);

      await expect(
        repo.claimOpportunityForReply('org1', 'missing', 'REPLIED')
      ).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('getKeywordActivationStats', () => {
    it('queries only ACTIVATED rows: enabled keyword on an enabled config', async () => {
      const { repo, keywordFindMany } = buildRepo();
      keywordFindMany.mockResolvedValueOnce([]);

      await repo.getKeywordActivationStats();

      expect(keywordFindMany).toHaveBeenCalledWith({
        where: { enabled: true, config: { enabled: true } },
        select: { keyword: true, organizationId: true },
      });
    });

    it('groups by normalized keyword, counts DISTINCT orgs, keeps raw variants, sorts desc', async () => {
      const { repo, keywordFindMany } = buildRepo();
      // 'AI' / 'ai' / 'Ai' all normalize to 'ai'. org1 appears under two case
      // variants → must be counted ONCE. variants keeps the raw spellings.
      keywordFindMany.mockResolvedValueOnce([
        { keyword: 'AI', organizationId: 'org1' },
        { keyword: 'ai', organizationId: 'org2' },
        { keyword: 'Ai', organizationId: 'org1' },
        { keyword: 'React', organizationId: 'org3' },
      ]);

      const stats = await repo.getKeywordActivationStats();

      expect(stats).toEqual([
        { keyword: 'ai', activatedOrgs: 2, variants: ['AI', 'ai', 'Ai'] },
        { keyword: 'react', activatedOrgs: 1, variants: ['React'] },
      ]);
    });

    it('drops blank-normalizing keywords and returns [] when nothing is activated', async () => {
      const { repo, keywordFindMany } = buildRepo();
      keywordFindMany.mockResolvedValueOnce([
        { keyword: '   ', organizationId: 'org1' }, // normalizes to '' → skipped
      ]);

      expect(await repo.getKeywordActivationStats()).toEqual([]);
    });
  });

  describe('getOrgAggregateConfig', () => {
    function buildConfigRepo(opts: { baseNull: any; enabledConfigs: any[] }) {
      const configFindFirst = vi.fn().mockResolvedValue(opts.baseNull);
      const configCreate = vi.fn();
      const configFindMany = vi.fn().mockResolvedValue(opts.enabledConfigs);
      const _config = {
        model: {
          engageConfig: {
            findFirst: configFindFirst,
            create: configCreate,
            findMany: configFindMany,
          },
        },
      } as any;
      const repo = new EngageRepository(
        _config,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any // _integrationProject, {} as any, {} as any, {} as any, {} as any
      );
      return { repo, configFindFirst, configFindMany };
    }

    it('unions keywords/channels/accounts across every enabled project-scoped config, deduped by global unit identity, base scalars preserved', async () => {
      const base = {
        id: 'cfg-null',
        organizationId: 'org1',
        projectId: null,
        enabled: true,
        replyAccounts: [{ id: 'ra1' }],
        keywords: [],
        monitoredChannels: [],
        trackedAccounts: [],
      };
      // Channels and accounts arrive in ONE relation now (platform decides the
      // scope), and the response splits them back apart.
      const { repo, configFindMany } = buildConfigRepo({
        baseNull: base,
        enabledConfigs: [
          {
            projectId: 'p0',
            keywords: [{ id: 'k1', keyword: 'AI', enabled: true }],
            trackedAccounts: [
              { id: 'a1', platform: 'x', username: '@Alice', enabled: true },
            ],
          },
          {
            projectId: 'p1',
            // 'ai' dups p0's 'AI' (same normalized key) → one entry; 'ML' is
            // project-only. Channel + a dup account (@alice) too.
            keywords: [
              { id: 'k2', keyword: 'ai', enabled: true },
              { id: 'k3', keyword: 'ML', enabled: true },
            ],
            trackedAccounts: [
              {
                id: 'c1',
                platform: 'reddit',
                username: 'LocalLLM',
                enabled: true,
              },
              { id: 'a2', platform: 'x', username: 'alice', enabled: true },
            ],
          },
        ],
      });

      const res = await repo.getOrgAggregateConfig('org1');

      // Only ENABLED, project-scoped configs are queried; the legacy null-project
      // row is excluded from the union (consistent with the scan loop).
      expect(configFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            organizationId: 'org1',
            enabled: true,
            projectId: { not: null },
          },
        })
      );
      // Base scalars + replyAccounts preserved.
      expect(res.id).toBe('cfg-null');
      expect(res.replyAccounts).toEqual([{ id: 'ra1' }]);
      // 'AI'/'ai' collapse to one; 'ML' present → 2 keywords.
      expect(res.keywords.map((k: any) => k.keyword).sort()).toEqual([
        'AI',
        'ML',
      ]);
      // @Alice / alice collapse to one tracked account.
      expect(res.trackedAccounts).toHaveLength(1);
      // project channel surfaced, rendered back in the legacy channel shape.
      expect(res.monitoredChannels.map((c: any) => c.channelId)).toEqual([
        'LocalLLM',
      ]);
    });

    it('prefers the enabled row when the same unit is disabled in one config and enabled in another', async () => {
      const base = {
        id: 'cfg-null',
        organizationId: 'org1',
        projectId: null,
        enabled: true,
        replyAccounts: [],
        keywords: [],
        monitoredChannels: [],
        trackedAccounts: [],
      };
      const { repo } = buildConfigRepo({
        baseNull: base,
        enabledConfigs: [
          {
            keywords: [{ id: 'k1', keyword: 'AI', enabled: false }],
            monitoredChannels: [],
            trackedAccounts: [],
          },
          {
            keywords: [{ id: 'k2', keyword: 'ai', enabled: true }],
            monitoredChannels: [],
            trackedAccounts: [],
          },
        ],
      });

      const res = await repo.getOrgAggregateConfig('org1');
      expect(res.keywords).toHaveLength(1);
      expect(res.keywords[0].enabled).toBe(true);
    });
  });
});

// Found on re-review: same-score candidates were tiebroken by
// EngageOpportunityState.createdAt ASC (when WE scanned it in) — the OPPOSITE
// of "most recent" from a reader's perspective, and the wrong field besides
// (postPublishedAt is the post's own timestamp; createdAt can lag it by hours
// depending on scan cadence).
describe('EngageRepository.pickAutoReplyCandidates', () => {
  it("orders by score desc, then the POST's own recency desc (not our scan-discovery time)", async () => {
    const { repo, stateFindMany } = buildRepo();
    stateFindMany.mockResolvedValue([]);

    await repo.pickAutoReplyCandidates('org-1', 'proj-1', 'reddit', {
      limit: 1,
    });

    expect(stateFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [
          { score: 'desc' },
          { opportunity: { postPublishedAt: 'desc' } },
        ],
      })
    );
  });

  it('claims a candidate with a conditional NEW → AUTO_QUEUED transition', async () => {
    const { repo, stateUpdateMany } = buildRepo();
    stateUpdateMany.mockResolvedValue({ count: 1 });

    await expect(
      repo.claimAutoReplyCandidate('org-1', 'proj-1', 'state-1')
    ).resolves.toBe(true);
    expect(stateUpdateMany).toHaveBeenCalledWith({
      where: {
        id: 'state-1',
        organizationId: 'org-1',
        projectId: 'proj-1',
        status: 'NEW',
      },
      data: { status: 'AUTO_QUEUED' },
    });
  });
});

describe('EngageRepository.upsertReplyAccount', () => {
  function buildReplyAccountRepo() {
    const integrationFindFirst = vi.fn();
    const integrationProjectUpsert = vi.fn();
    const integration = {
      model: { integration: { findFirst: integrationFindFirst } },
    } as any;
    const integrationProject = {
      model: { integrationProject: { upsert: integrationProjectUpsert } },
    } as any;
    const repo = new EngageRepository(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      integration,
      integrationProject,
      {} as any,
      {} as any,
      {} as any,
      {} as any
    );
    return { repo, integrationFindFirst, integrationProjectUpsert };
  }

  it('creates the project binding and reply setting in one upsert', async () => {
    const { repo, integrationFindFirst, integrationProjectUpsert } =
      buildReplyAccountRepo();
    integrationFindFirst.mockResolvedValue({ id: 'integration-1' });
    integrationProjectUpsert.mockResolvedValue({ engageEnabled: false });

    await expect(
      repo.upsertReplyAccount('org-1', 'integration-1', {
        projectId: 'project-1',
        engageEnabled: false,
      })
    ).resolves.toEqual({
      integrationId: 'integration-1',
      projectId: 'project-1',
      engageEnabled: false,
    });

    expect(integrationProjectUpsert).toHaveBeenCalledWith({
      where: {
        integrationId_projectId: {
          integrationId: 'integration-1',
          projectId: 'project-1',
        },
      },
      create: {
        integrationId: 'integration-1',
        projectId: 'project-1',
        organizationId: 'org-1',
        engageEnabled: false,
      },
      update: { organizationId: 'org-1', engageEnabled: false },
      select: { engageEnabled: true },
    });
  });
});

describe('opportunityMediaUrls', () => {
  it('reads the archived media URLs', () => {
    expect(
      opportunityMediaUrls({ mediaUrls: ['https://pbs.twimg.com/media/A.jpg'] })
    ).toEqual(['https://pbs.twimg.com/media/A.jpg']);
  });

  it('returns [] for every shape that carries none', () => {
    // null rawData (every row ingested before this existed), an unrelated
    // payload (the server-side adapter's archived tweet), and junk entries.
    expect(opportunityMediaUrls(null)).toEqual([]);
    expect(opportunityMediaUrls(undefined)).toEqual([]);
    expect(opportunityMediaUrls({ tweet: { full_text: 'x' } })).toEqual([]);
    expect(opportunityMediaUrls({ mediaUrls: 'not-an-array' })).toEqual([]);
    expect(opportunityMediaUrls({ mediaUrls: [] })).toEqual([]);
  });

  it('drops non-string and blank entries', () => {
    expect(
      opportunityMediaUrls({ mediaUrls: ['https://a/1.jpg', 42, null, '  ', ''] })
    ).toEqual(['https://a/1.jpg']);
  });
});

describe('opportunityContentType', () => {
  it('reads the archived content type', () => {
    expect(opportunityContentType({ postContentType: 'article' })).toBe(
      'article'
    );
  });

  it('returns null for every shape that is not a marked article', () => {
    // null rawData (every row ingested before this existed, or every
    // non-X platform), an unrelated payload, and an unrecognised value.
    expect(opportunityContentType(null)).toBeNull();
    expect(opportunityContentType(undefined)).toBeNull();
    expect(opportunityContentType({ tweet: { full_text: 'x' } })).toBeNull();
    expect(opportunityContentType({ postContentType: 'video' })).toBeNull();
    expect(opportunityContentType({ postContentType: '' })).toBeNull();
  });
});
