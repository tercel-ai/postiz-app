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
import dayjs from 'dayjs';
import isoWeek from 'dayjs/plugin/isoWeek';
import utc from 'dayjs/plugin/utc';
import { EngageRepository } from '../engage.repository';

dayjs.extend(isoWeek);
dayjs.extend(utc);

function buildRepo() {
  const stateFindMany = vi.fn();
  const stateCount = vi.fn();
  const stateAggregate = vi.fn();
  const stateFindFirst = vi.fn();
  const oppAggregate = vi.fn();
  const oppFindFirst = vi.fn();
  const channelFindMany = vi.fn();
  const sentCount = vi.fn();
  const sentFindMany = vi.fn();
  const postAggregate = vi.fn();
  const postFindMany = vi.fn();

  const channel = {
    model: { engageMonitoredChannel: { findMany: channelFindMany } },
  } as any;
  const opportunity = {
    model: { engageOpportunity: { aggregate: oppAggregate, findFirst: oppFindFirst } },
  } as any;
  const oppState = {
    model: {
      engageOpportunityState: {
        findMany: stateFindMany,
        count: stateCount,
        aggregate: stateAggregate,
        findFirst: stateFindFirst,
      },
    },
  } as any;
  const sentReply = {
    model: { engageSentReply: { count: sentCount, findMany: sentFindMany } },
  } as any;
  const post = {
    model: { post: { aggregate: postAggregate, findMany: postFindMany } },
  } as any;

  // Constructor order: _config, _keyword, _channel, _trackedAccount,
  // _replyAccount, _opportunity, _oppState, _sentReply, _integration, _post, _tx
  const repo = new EngageRepository(
    {} as any, {} as any,
    channel,      // _channel
    {} as any, {} as any,
    opportunity,  // _opportunity
    oppState,     // _oppState
    sentReply,    // _sentReply
    {} as any,
    post,         // _post
    {} as any
  );
  return {
    repo, stateFindMany, stateCount, stateAggregate, stateFindFirst,
    oppAggregate, oppFindFirst, channelFindMany,
    sentCount, sentFindMany, postAggregate, postFindMany,
  };
}

const STATE_ROW = {
  status: 'NEW',
  bookmarked: true,
  score: 70,
  scoreKeyword: 30,
  scoreTracked: 5,
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
      expect(item).not.toHaveProperty('opportunity'); // flattened, not nested
    });

    it('routes an opportunity-owned sort field through the nested relation', async () => {
      const { repo, stateFindMany, stateCount } = buildRepo();
      stateFindMany.mockResolvedValue([]);
      stateCount.mockResolvedValue(0);

      await repo.listOpportunities('org1', { sortBy: 'scoreHeat', sortOrder: 'desc' } as any);
      expect(stateFindMany.mock.calls[0][0].orderBy).toEqual({
        opportunity: { scoreHeat: 'desc' },
      });
    });

    it('routes a state-owned sort field as a top-level column', async () => {
      const { repo, stateFindMany, stateCount } = buildRepo();
      stateFindMany.mockResolvedValue([]);
      stateCount.mockResolvedValue(0);

      await repo.listOpportunities('org1', { sortBy: 'score', sortOrder: 'desc' } as any);
      expect(stateFindMany.mock.calls[0][0].orderBy).toEqual({ score: 'desc' });
    });

    it('scopes the query to the org via the state table', async () => {
      const { repo, stateFindMany, stateCount } = buildRepo();
      stateFindMany.mockResolvedValue([]);
      stateCount.mockResolvedValue(0);

      await repo.listOpportunities('org1', {} as any);
      expect(stateFindMany.mock.calls[0][0].where.organizationId).toBe('org1');
      expect(stateFindMany.mock.calls[0][0].where.opportunity.deletedAt).toBeNull();
    });

    it('authors=__all__ filters scoreTracked on the state table', async () => {
      const { repo, stateFindMany, stateCount } = buildRepo();
      stateFindMany.mockResolvedValue([]);
      stateCount.mockResolvedValue(0);

      await repo.listOpportunities('org1', { authors: '__all__' } as any);
      expect(stateFindMany.mock.calls[0][0].where.scoreTracked).toEqual({ gt: 0 });
      // "all tracked" must NOT add an authorUsername filter on the opportunity.
      expect(stateFindMany.mock.calls[0][0].where.opportunity.authorUsername).toBeUndefined();
    });

    it('channels=<specific> filters the specific channel on the opportunity', async () => {
      const { repo, stateFindMany, stateCount, channelFindMany } = buildRepo();
      stateFindMany.mockResolvedValue([]);
      stateCount.mockResolvedValue(0);

      await repo.listOpportunities('org1', { channels: 'SEO' } as any);
      expect(stateFindMany.mock.calls[0][0].where.opportunity.channelId).toBe('SEO');
      // A specific channel must NOT trigger the org-channel-set lookup.
      expect(channelFindMany).not.toHaveBeenCalled();
    });

    it('channels=__all__ restricts to the org enabled monitored-channel set', async () => {
      const { repo, stateFindMany, stateCount, channelFindMany } = buildRepo();
      channelFindMany.mockResolvedValue([{ channelId: 'SEO' }, { channelId: 'marketing' }]);
      stateFindMany.mockResolvedValue([]);
      stateCount.mockResolvedValue(0);

      await repo.listOpportunities('org1', { channels: '__all__' } as any);
      expect(channelFindMany.mock.calls[0][0].where).toEqual({
        organizationId: 'org1',
        enabled: true,
      });
      expect(stateFindMany.mock.calls[0][0].where.opportunity.channelId).toEqual({
        in: ['SEO', 'marketing'],
      });
    });

    it('authors=<specific> filters authorUsername case-insensitively on the opportunity', async () => {
      const { repo, stateFindMany, stateCount } = buildRepo();
      stateFindMany.mockResolvedValue([]);
      stateCount.mockResolvedValue(0);

      await repo.listOpportunities('org1', { authors: 'BobSmith' } as any);
      expect(stateFindMany.mock.calls[0][0].where.opportunity.authorUsername).toEqual({
        equals: 'BobSmith',
        mode: 'insensitive',
      });
      // A specific author is NOT "all tracked" → no scoreTracked filter.
      expect(stateFindMany.mock.calls[0][0].where.scoreTracked).toBeUndefined();
    });
  });

  describe('getScoreStats', () => {
    it('sources objective averages from the opportunity aggregate, org scores from state', async () => {
      const { repo, stateAggregate, stateCount, stateFindMany, stateFindFirst, oppAggregate, oppFindFirst } =
        buildRepo();
      stateAggregate.mockResolvedValue({
        _count: { _all: 5 },
        _avg: { score: 72, scoreKeyword: 31, scoreTracked: 2 },
      });
      oppAggregate.mockResolvedValue({
        _avg: { scoreHeat: 20, scoreAuthority: 9, scoreRecency: 3 },
      });
      stateFindMany.mockResolvedValue([{ score: 90 }, { score: 75 }, { score: 65 }]);
      stateCount.mockResolvedValue(2);
      stateFindFirst.mockResolvedValue({
        opportunityId: 'opp1',
        scoreKeyword: 35,
        opportunity: { postContent: 'best keyword post' },
      });
      oppFindFirst
        .mockResolvedValueOnce({ id: 'oppH', scoreHeat: 35, postContent: 'hot' })
        .mockResolvedValueOnce({ id: 'oppA', scoreAuthority: 20, postContent: 'auth' });

      const stats = await repo.getScoreStats('org1');
      expect(stats.total).toBe(5);
      expect(stats.avgScore).toBe(72);          // state aggregate
      expect(stats.avgScoreHeat).toBe(20);       // opportunity aggregate
      expect(stats.avgScoreAuthority).toBe(9);   // opportunity aggregate
      expect(stats.trackedCount).toBe(2);
      expect(stats.topByKeyword).toEqual({ id: 'opp1', score: 35, title: 'best keyword post' });
      expect(stats.topByHeat).toEqual({ id: 'oppH', score: 35, title: 'hot' });
    });

    it('returns a zeroed shape when the org has no state rows', async () => {
      const { repo, stateAggregate, stateCount, stateFindMany, stateFindFirst, oppAggregate, oppFindFirst } =
        buildRepo();
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
    it('computes response rate, X-only impressions/traffic, weekly platform split, and best reply', async () => {
      const { repo, sentCount, sentFindMany, postAggregate } = buildRepo();
      // Promise.all order: total, replied, weekly, xWeekly, redditWeekly
      sentCount
        .mockResolvedValueOnce(10)
        .mockResolvedValueOnce(4)
        .mockResolvedValueOnce(6)
        .mockResolvedValueOnce(4)
        .mockResolvedValueOnce(2);
      postAggregate.mockResolvedValue({
        _sum: { impressions: 1200, trafficScore: 87.6 },
      });
      sentFindMany.mockResolvedValue([
        {
          opportunity: { id: 'o1', platform: 'x', externalPostUrl: 'u1' },
          post: { content: 'a', releaseURL: 'r1', analytics: [{ label: 'like_count', data: [{ total: '5' }] }] },
        },
        {
          opportunity: { id: 'o2', platform: 'reddit', externalPostUrl: 'u2' },
          post: { content: 'b', releaseURL: null, analytics: [{ label: 'score', data: [{ total: '12' }] }] },
        },
      ]);

      const stats = await repo.getDashboardSummary('org1');
      expect(stats.weeklyCount).toBe(6);
      expect(stats.responseRate).toBe(40); // 4/10
      expect(stats.xImpressions).toBe(1200);
      expect(stats.xTrafficIndex).toBe(88); // round(87.6)
      expect(stats.totalImpressions).toBe(1200);
      expect(stats.totalTrafficScore).toBe(88);
      expect(stats.totalLikes).toBe(17);
      expect(stats.platformSplit).toEqual({ x: 4, reddit: 2 });
      // Best reply is the Reddit one (score 12 > like 5); url falls back to externalPostUrl
      expect(stats.bestReply).toEqual({
        opportunityId: 'o2',
        platform: 'reddit',
        content: 'b',
        likes: 12,
        url: 'u2',
      });
    });

    it('scopes headline stats and best reply when a platform filter is provided', async () => {
      const { repo, sentCount, sentFindMany, postAggregate } = buildRepo();
      sentCount
        .mockResolvedValueOnce(5)
        .mockResolvedValueOnce(4)
        .mockResolvedValueOnce(2)
        .mockResolvedValueOnce(6)
        .mockResolvedValueOnce(2);
      postAggregate
        .mockResolvedValueOnce({ _sum: { impressions: 900, trafficScore: 234.2 } })
        .mockResolvedValueOnce({ _sum: { impressions: 1200, trafficScore: 87.6 } });
      sentFindMany
        .mockResolvedValueOnce([
          {
            opportunity: { platform: 'reddit' },
            post: { analytics: [{ label: 'score', data: [{ total: '12' }] }] },
          },
        ])
        .mockResolvedValueOnce([
          {
            opportunity: { id: 'o2', platform: 'reddit', externalPostUrl: 'u2' },
            post: { content: 'b', releaseURL: null, analytics: [{ label: 'score', data: [{ total: '12' }] }] },
          },
        ]);

      const stats = await repo.getDashboardSummary('org1', { platform: 'reddit' });

      expect(stats.weeklyCount).toBe(2);
      expect(stats.responseRate).toBe(80); // 4/5
      expect(stats.totalImpressions).toBe(900);
      expect(stats.totalTrafficScore).toBe(234);
      expect(stats.totalLikes).toBe(12);
      expect(stats.xImpressions).toBe(1200); // legacy helper remains X-only
      expect(stats.xTrafficIndex).toBe(88);
      expect(stats.bestReply?.platform).toBe('reddit');
      expect(sentCount.mock.calls[0][0].where.opportunity).toEqual({ platform: 'reddit' });
      expect(sentCount.mock.calls[1][0].where.opportunity).toEqual({ platform: 'reddit' });
      expect(sentCount.mock.calls[2][0].where.opportunity).toEqual({ platform: 'reddit' });
      expect(postAggregate.mock.calls[0][0].where.engageSentReply).toEqual({
        is: { opportunity: { platform: 'reddit' } },
      });
      expect(sentFindMany.mock.calls[0][0].where.opportunity).toEqual({ platform: 'reddit' });
      expect(sentFindMany.mock.calls[1][0].where.opportunity).toEqual({ platform: 'reddit' });
    });

    it('returns bestReply=null and responseRate=0 when there is no engagement data', async () => {
      const { repo, sentCount, sentFindMany, postAggregate } = buildRepo();
      sentCount.mockResolvedValue(0);
      postAggregate.mockResolvedValue({ _sum: { impressions: null, trafficScore: null } });
      sentFindMany.mockResolvedValue([]);

      const stats = await repo.getDashboardSummary('org1');
      expect(stats.responseRate).toBe(0);
      expect(stats.xImpressions).toBe(0);
      expect(stats.xTrafficIndex).toBe(0);
      expect(stats.bestReply).toBeNull();
    });
  });

  describe('getDashboardRepliesTrend (panel ②)', () => {
    it('seeds a continuous window and buckets replies by publish day and platform', async () => {
      const { repo, sentFindMany } = buildRepo();
      sentFindMany.mockResolvedValue([
        { opportunity: { platform: 'x' }, post: { publishDate: new Date() } },
        { opportunity: { platform: 'reddit' }, post: { publishDate: new Date() } },
        { opportunity: { platform: 'x' }, post: { publishDate: null } }, // ignored
      ]);

      const res = await repo.getDashboardRepliesTrend('org1', 7);
      expect(res.days).toBe(7);
      expect(res.items).toHaveLength(7); // zero-filled continuous buckets
      const totals = res.items.reduce(
        (a, b) => ({ count: a.count + b.count, x: a.x + b.x, reddit: a.reddit + b.reddit }),
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
          post: { content: 'c', releaseURL: 'r1', publishDate: new Date('2026-05-20'), trafficScore: 30.2 },
        },
        {
          opportunity: { id: 'o2', platform: 'reddit', externalPostUrl: 'u2' },
          post: { content: 'd', releaseURL: null, publishDate: new Date('2026-05-19'), trafficScore: 12 },
        },
      ]);

      const res = await repo.getDashboardTraffics('org1', { limit: 5 });
      expect(res.totalClicks).toBe(42); // round(42.4)
      expect(res.items).toHaveLength(2);
      expect(res.items[0]).toMatchObject({ opportunityId: 'o1', clicks: 30, url: 'r1' });
      expect(res.items[1]).toMatchObject({ opportunityId: 'o2', clicks: 12, url: 'u2' }); // releaseURL null → externalPostUrl
      // top-N ordering and platform filter wiring
      expect(sentFindMany.mock.calls[0][0].orderBy).toEqual({ post: { trafficScore: 'desc' } });
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
      expect(sentFindMany.mock.calls[0][0].where.opportunity).toEqual({ platform: 'x' });
      expect(sentFindMany.mock.calls[0][0].take).toBe(10); // default limit
    });
  });

  describe('getDashboardImpressions (panel ④)', () => {
    it('buckets impressions by publish day + platform, sums duplicates, drops null dates, sorts', async () => {
      const { repo, postFindMany } = buildRepo();
      postFindMany.mockResolvedValue([
        { impressions: 100, publishDate: new Date('2026-05-20T00:00:00Z'), engageSentReply: { opportunity: { platform: 'x' } } },
        { impressions: 50, publishDate: new Date('2026-05-20T12:00:00Z'), engageSentReply: { opportunity: { platform: 'x' } } }, // same day+x → 150
        { impressions: 30, publishDate: new Date('2026-05-20T06:00:00Z'), engageSentReply: { opportunity: { platform: 'reddit' } } },
        { impressions: 20, publishDate: new Date('2026-05-21T00:00:00Z'), engageSentReply: null }, // no reply → 'unknown'
        { impressions: 999, publishDate: null, engageSentReply: { opportunity: { platform: 'x' } } }, // dropped (null date)
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
        { impressions: 10, publishDate: new Date('2026-05-20T00:00:00Z'), engageSentReply: { opportunity: { platform: 'x' } } },
        { impressions: 5, publishDate: new Date('2026-05-22T00:00:00Z'), engageSentReply: { opportunity: { platform: 'x' } } },
      ]);

      const res = await repo.getDashboardImpressions('org1', 'weekly');

      // Bucket key = Monday of that ISO week (mirrors the implementation).
      const monday = dayjs.utc('2026-05-20').isoWeekday(1).format('YYYY-MM-DD');
      expect(res).toEqual([{ date: monday, platform: 'x', value: 15 }]);
    });
  });
});
