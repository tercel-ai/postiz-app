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
  const trackedFindMany = vi.fn();
  const cursorFindMany = vi.fn();
  const sentCount = vi.fn();
  const sentFindMany = vi.fn();
  const postAggregate = vi.fn();
  const postFindMany = vi.fn();

  const channel = {
    model: { engageMonitoredChannel: { findMany: channelFindMany } },
  } as any;
  const trackedAccount = {
    model: { engageTrackedAccount: { findMany: trackedFindMany } },
  } as any;
  const scanCursor = {
    model: { engageScanCursor: { findMany: cursorFindMany } },
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
  // _replyAccount, _opportunity, _oppState, _sentReply, _integration, _post,
  // _tx, _scanCursor
  const repo = new EngageRepository(
    {} as any, {} as any,
    channel,        // _channel
    trackedAccount, // _trackedAccount
    {} as any,
    opportunity,    // _opportunity
    oppState,       // _oppState
    sentReply,      // _sentReply
    {} as any,
    post,           // _post
    {} as any,
    scanCursor      // _scanCursor
  );
  return {
    repo, stateFindMany, stateCount, stateAggregate, stateFindFirst,
    oppAggregate, oppFindFirst, channelFindMany, trackedFindMany, cursorFindMany,
    sentCount, sentFindMany, postAggregate, postFindMany,
  };
}

const STATE_ROW = {
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

    it('attaches replyLink + sentReplyId from the latest sent reply', async () => {
      const { repo, stateFindMany, stateCount, sentFindMany } = buildRepo();
      stateFindMany.mockResolvedValue([STATE_ROW]);
      stateCount.mockResolvedValue(1);
      sentFindMany.mockResolvedValue([
        { id: 'reply-new', opportunityId: 'opp1', post: { releaseURL: 'https://x.com/a/status/1' } },
      ]);

      const item = (await repo.listOpportunities('org1', {} as any)).items[0] as any;
      expect(item.sentReplyId).toBe('reply-new');
      expect(item.replyLink).toBe('https://x.com/a/status/1');
    });

    it('reports replyLink null when the latest reply has no URL (pending backfill)', async () => {
      const { repo, stateFindMany, stateCount, sentFindMany } = buildRepo();
      stateFindMany.mockResolvedValue([STATE_ROW]);
      stateCount.mockResolvedValue(1);
      sentFindMany.mockResolvedValue([
        { id: 'reply-pending', opportunityId: 'opp1', post: { releaseURL: null } },
      ]);

      const item = (await repo.listOpportunities('org1', {} as any)).items[0] as any;
      expect(item.sentReplyId).toBe('reply-pending');
      expect(item.replyLink).toBeNull();
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

    it('channels=[<specific>] filters those channel ids on the opportunity', async () => {
      const { repo, stateFindMany, stateCount } = buildRepo();
      stateFindMany.mockResolvedValue([]);
      stateCount.mockResolvedValue(0);

      await repo.listOpportunities('org1', { channels: ['SEO'] } as any);
      expect(stateFindMany.mock.calls[0][0].where.opportunity.channelId).toEqual({ in: ['SEO'] });
    });

    it('channels=[multiple] filters all listed channel ids', async () => {
      const { repo, stateFindMany, stateCount } = buildRepo();
      stateFindMany.mockResolvedValue([]);
      stateCount.mockResolvedValue(0);

      await repo.listOpportunities('org1', { channels: ['SEO', 'TECH'] } as any);
      expect(stateFindMany.mock.calls[0][0].where.opportunity.channelId).toEqual({ in: ['SEO', 'TECH'] });
    });

    it('authors=[<specific>] filters authorUsername case-insensitively via OR', async () => {
      const { repo, stateFindMany, stateCount } = buildRepo();
      stateFindMany.mockResolvedValue([]);
      stateCount.mockResolvedValue(0);

      await repo.listOpportunities('org1', { authors: ['BobSmith'] } as any);
      expect(stateFindMany.mock.calls[0][0].where.opportunity.OR).toEqual([
        { authorUsername: { equals: 'BobSmith', mode: 'insensitive' } },
      ]);
    });

    it('authors=[multiple] filters all listed authors via OR', async () => {
      const { repo, stateFindMany, stateCount } = buildRepo();
      stateFindMany.mockResolvedValue([]);
      stateCount.mockResolvedValue(0);

      await repo.listOpportunities('org1', { authors: ['Alice', 'Bob'] } as any);
      expect(stateFindMany.mock.calls[0][0].where.opportunity.OR).toEqual([
        { authorUsername: { equals: 'Alice', mode: 'insensitive' } },
        { authorUsername: { equals: 'Bob', mode: 'insensitive' } },
      ]);
    });
  });

  describe('listSentReplies', () => {
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
        opportunityId: { in: ['o1', 'o2'] },
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
              engageAuthor: { handle: 'zhngyq310334', id: '7', name: '张玉琪', avatarUrl: 'https://files/zq.png' },
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
    it('computes response rate, X-only impressions/traffic, all-time platform split, and best reply', async () => {
      const { repo, sentCount, sentFindMany, postAggregate } = buildRepo();
      // Promise.all order: total, replied, sentReplies, xSent, redditSent
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
          opportunity: { id: 'o1', platform: 'x', externalPostUrl: 'u1', authorUsername: 'alice', authorDisplayName: 'Alice', authorAvatarUrl: 'a.png' },
          post: { content: 'a', releaseURL: 'r1', analytics: [{ label: 'like_count', data: [{ total: '5' }] }] },
        },
        {
          opportunity: { id: 'o2', platform: 'reddit', externalPostUrl: 'u2', authorUsername: 'bob', authorDisplayName: null, authorAvatarUrl: null },
          post: { content: 'b', releaseURL: null, analytics: [{ label: 'score', data: [{ total: '12' }] }] },
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
      expect(stats.platformSplit).toEqual({ x: 4, reddit: 2 });
      // repliesCount / platformSplit are ALL-TIME, PUBLISHED-only (no week window).
      expect(sentCount.mock.calls[2][0].where.post.is).toEqual({
        source: 'engage',
        state: 'PUBLISHED',
      });
      expect(sentCount.mock.calls[2][0].where.post.is.publishDate).toBeUndefined();
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

      expect(stats.repliesCount).toBe(2);
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

    it('date=month applies a publishDate window to counts and aggregates', async () => {
      const { repo, sentCount, sentFindMany, postAggregate } = buildRepo();
      sentCount.mockResolvedValue(0);
      postAggregate.mockResolvedValue({ _sum: { impressions: 0, trafficScore: 0 } });
      sentFindMany.mockResolvedValue([]);

      await repo.getDashboardSummary('org1', { date: 'month' });

      // repliesCount (3rd count) → PUBLISHED + month window.
      const sentWhere = sentCount.mock.calls[2][0].where.post.is;
      expect(sentWhere.source).toBe('engage');
      expect(sentWhere.state).toBe('PUBLISHED');
      expect(sentWhere.publishDate.gte).toBeInstanceOf(Date);
      // responseRate denominator (1st count) → any state, but windowed.
      const totalWhere = sentCount.mock.calls[0][0].where.post.is;
      expect(totalWhere.publishDate.gte).toBeInstanceOf(Date);
      expect(totalWhere.state).toBeUndefined();
      // Headline impressions aggregate (1st aggregate) is windowed too.
      expect(postAggregate.mock.calls[0][0].where.publishDate.gte).toBeInstanceOf(Date);
    });

    it('no date / "all" applies no publishDate window', async () => {
      const { repo, sentCount, sentFindMany, postAggregate } = buildRepo();
      sentCount.mockResolvedValue(0);
      postAggregate.mockResolvedValue({ _sum: { impressions: 0, trafficScore: 0 } });
      sentFindMany.mockResolvedValue([]);

      await repo.getDashboardSummary('org1', { date: 'all' });

      expect(sentCount.mock.calls[2][0].where.post.is.publishDate).toBeUndefined();
      expect(postAggregate.mock.calls[0][0].where.publishDate).toBeUndefined();
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

      const res = await repo.getDashboardRepliesTrend('org1', 'daily');
      expect(res.period).toBe('daily');
      expect(res.items).toHaveLength(30); // daily → 30 zero-filled continuous buckets
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
          opportunity: { id: 'o1', platform: 'x', authorUsername: 'alice', authorAvatarUrl: 'a.png' },
          post: { id: 'p1', content: 'cx', releaseURL: 'rx', analytics: xAnalytics(7), integration: { profile: '@me', picture: 'm.png' }, settings: null },
        },
        {
          id: 's2',
          opportunity: { id: 'o2', platform: 'reddit', authorUsername: 'bob', authorAvatarUrl: null },
          post: { id: 'p2', content: 'cr', releaseURL: 'rr', analytics: redditAnalytics(20), integration: null, settings: null },
        },
        {
          id: 's3',
          opportunity: { id: 'o3', platform: 'x', authorUsername: 'carol', authorAvatarUrl: null },
          post: { id: 'p3', content: 'cx2', releaseURL: 'rx2', analytics: xAnalytics(3), integration: null, settings: null },
        },
      ]);

      const res = await repo.getDashboardTopSources('org1', { limit: 10 });

      // reddit/20 > x/7 > x/3 — each ranked by its own platform metric.
      expect(res.items.map((i) => i.id)).toEqual(['s2', 's1', 's3']);
      expect(res.items[0].metric).toBe(20); // upvotes
      expect(res.items[1].metric).toBe(7); // likes
      // reply-author (the posting account) is surfaced for the panel.
      expect(res.items[1].post.replyAuthor).toMatchObject({ handle: 'me', avatarUrl: 'm.png' });
      expect(res.items[1].post.metrics.likes).toBe(7);
    });

    it('respects the limit after ranking', async () => {
      const { repo, sentFindMany } = buildRepo();
      sentFindMany.mockResolvedValue([
        { id: 's1', opportunity: { platform: 'x', authorUsername: 'a' }, post: { analytics: xAnalytics(1), integration: null, settings: null } },
        { id: 's2', opportunity: { platform: 'x', authorUsername: 'b' }, post: { analytics: xAnalytics(9), integration: null, settings: null } },
        { id: 's3', opportunity: { platform: 'x', authorUsername: 'c' }, post: { analytics: xAnalytics(5), integration: null, settings: null } },
      ]);

      const res = await repo.getDashboardTopSources('org1', { limit: 2 });

      expect(res.items.map((i) => i.id)).toEqual(['s2', 's3']); // top 2 by likes
    });

    it('scopes to a platform and fetches a lean select (no original-post author fields)', async () => {
      const { repo, sentFindMany } = buildRepo();
      sentFindMany.mockResolvedValue([]);

      await repo.getDashboardTopSources('org1', { platform: 'reddit', limit: 3 });

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

  describe('getSentStats (date/platform/status filter alignment)', () => {
    it('no date → all-time: repliesCount = total, no publishDate window', async () => {
      const { repo, sentCount, sentFindMany, postAggregate } = buildRepo();
      sentCount.mockResolvedValueOnce(10).mockResolvedValueOnce(3); // total, replied
      postAggregate.mockResolvedValue({ _sum: { impressions: 4200, trafficScore: 286.4 } });
      sentFindMany.mockResolvedValue([]); // no likes sample → avgLikes 0

      const res = await repo.getSentStats('org1', {});

      expect(res).toEqual({
        repliesCount: 10,
        responseRate: 30, // 3/10
        totalImpressions: 4200,
        totalTrafficScore: 286, // round(286.4)
        avgLikes: 0,
      });
      // All-time: the post filter is just the engage source, no date window.
      expect(sentCount.mock.calls[0][0].where.post).toEqual({ source: 'engage' });
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
      postAggregate.mockResolvedValue({ _sum: { impressions: 0, trafficScore: 0 } });
      sentFindMany.mockResolvedValue([]);

      // 'day' previously had no effect here (inline mapper only knew 'today');
      // now both endpoints route through the shared _engageDateWindow.
      await repo.getSentStats('org1', { date: 'day' });

      expect(sentCount.mock.calls[0][0].where.post.source).toBe('engage');
      expect(sentCount.mock.calls[0][0].where.post.publishDate.gte).toBeInstanceOf(Date);
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
        {} as any, {} as any, {} as any, {} as any, {} as any,
        {} as any, {} as any, {} as any,
        integration, // _integration
        post,         // _post
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
      const { repo, integrationFindFirst, integrationFindMany, postCreate } = buildXRepo();
      // Org has two live X accounts; the reply tweet's author handle matches one.
      integrationFindMany.mockResolvedValue([
        { id: 'other', profile: 'someoneelse', engageXReplyAccount: null },
        { id: 'author', profile: 'zhngyq310334', engageXReplyAccount: null },
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
        { id: 'other', profile: 'someoneelse', engageXReplyAccount: null },
        { id: 'brand', profile: 'brandhq', engageXReplyAccount: { engageEnabled: true } },
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
      expect(settings.engageAuthor).toEqual({ handle: 'externalguy', id: '42', name: 'External Guy' });
    });

    it('does NOT write engageAuthor when an integration authored the reply (integrationId is source of truth)', async () => {
      const { repo, integrationFindMany, postCreate } = buildXRepo();
      // The reply URL's author handle matches a connected account → integrationId set.
      integrationFindMany.mockResolvedValue([
        { id: 'author', profile: 'zhngyq310334', engageXReplyAccount: null },
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
  });

  describe('createManualRedditPost', () => {
    function buildRedditRepo() {
      const postCreate = vi.fn();
      const post = { model: { post: { create: postCreate } } } as any;
      const repo = new EngageRepository(
        {} as any, {} as any, {} as any, {} as any, {} as any,
        {} as any, {} as any, {} as any, {} as any,
        post, // _post
        {} as any
      );
      return { repo, postCreate };
    }

    it('writes a reddit-typed engage post and persists engageAuthor when supplied', async () => {
      const { repo, postCreate } = buildRedditRepo();
      postCreate.mockResolvedValue({ id: 'post1' });

      await repo.createManualRedditPost({
        organizationId: 'org1',
        content: 'reply',
        date: new Date(0),
        replyUrl: 'https://www.reddit.com/r/sub/comments/abc/title/def/',
        engageAuthor: { handle: 'bigbaffler', id: 't2_9', name: 'Big Baffler', avatarUrl: 'https://x/a.png' },
      });

      const data = postCreate.mock.calls[0][0].data;
      expect('integrationId' in data).toBe(false); // reddit never has an integration
      const settings = JSON.parse(data.settings);
      expect(settings.__type).toBe('reddit');
      expect(settings.engageAuthor).toEqual({
        handle: 'bigbaffler', id: 't2_9', name: 'Big Baffler', avatarUrl: 'https://x/a.png',
      });
    });

    it('omits engageAuthor from settings when not supplied', async () => {
      const { repo, postCreate } = buildRedditRepo();
      postCreate.mockResolvedValue({ id: 'post1' });

      await repo.createManualRedditPost({
        organizationId: 'org1',
        content: 'reply',
        date: new Date(0),
      });

      const settings = JSON.parse(postCreate.mock.calls[0][0].data.settings);
      expect(settings.__type).toBe('reddit');
      expect(settings.engageAuthor).toBeUndefined();
    });
  });

  describe('getEngageMetricsStats', () => {
    // Folds PUBLISHED engage replies into a per-platform snapshot: published /
    // withMetrics / missing / missingIntegration (X) / Σimpressions / Σtraffic.
    function buildStatsRepo() {
      const sentFindMany = vi.fn();
      const sentReply = { model: { engageSentReply: { findMany: sentFindMany } } } as any;
      const repo = new EngageRepository(
        {} as any, {} as any, {} as any, {} as any, {} as any,
        {} as any, {} as any,
        sentReply,    // _sentReply
        {} as any,    // _integration
        {} as any,    // _post
        {} as any, {} as any
      );
      return { repo, sentFindMany };
    }

    it('counts metrics presence, per-blocker missing breakdown, and totals per platform', async () => {
      const { repo, sentFindMany } = buildStatsRepo();
      const url = 'https://x.com/u/status/123';
      sentFindMany.mockResolvedValue([
        // X — one of each bucket
        { post: { impressions: 100, trafficScore: 2.4, integrationId: 'i1', releaseURL: url, releaseId: '123' }, opportunity: { platform: 'x' } }, // has_metrics
        { post: { impressions: null, trafficScore: null, integrationId: null, releaseURL: null, releaseId: null }, opportunity: { platform: 'x' } }, // no_release_url
        { post: { impressions: null, trafficScore: null, integrationId: null, releaseURL: url, releaseId: '123' }, opportunity: { platform: 'x' } }, // no_integration
        { post: { impressions: null, trafficScore: null, integrationId: 'i2', releaseURL: url, releaseId: null }, opportunity: { platform: 'x' } }, // no_release_id
        { post: { impressions: null, trafficScore: null, integrationId: 'i2', releaseURL: url, releaseId: '123' }, opportunity: { platform: 'x' } }, // syncable
        // Reddit — needs only a releaseURL
        { post: { impressions: 40, trafficScore: 7.6, integrationId: null, releaseURL: 'https://reddit.com/r/x/comments/a/b/c1', releaseId: null }, opportunity: { platform: 'reddit' } }, // has_metrics
        { post: { impressions: null, trafficScore: null, integrationId: null, releaseURL: null, releaseId: null }, opportunity: { platform: 'reddit' } }, // no_release_url
        { post: { impressions: null, trafficScore: null, integrationId: null, releaseURL: 'https://reddit.com/r/x/comments/a/b/c2', releaseId: null }, opportunity: { platform: 'reddit' } }, // syncable
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
      const sentReply = { model: { engageSentReply: { findMany: sentFindMany } } } as any;
      const integration = { model: { integration: { findMany: integrationFindMany } } } as any;
      const post = { model: { post: { update: postUpdate } } } as any;
      const repo = new EngageRepository(
        {} as any, {} as any, {} as any, {} as any, {} as any,
        {} as any, {} as any,
        sentReply,    // _sentReply
        integration,  // _integration
        post,         // _post
        {} as any, {} as any
      );
      return { repo, sentFindMany, integrationFindMany, postUpdate };
    }

    it('resolves by author handle and writes integrationId when executing', async () => {
      const { repo, sentFindMany, integrationFindMany, postUpdate } = buildBackfillRepo();
      sentFindMany.mockResolvedValue([
        { post: { id: 'post1', releaseURL: 'https://x.com/zhngyq310334/status/1' } },
      ]);
      integrationFindMany.mockResolvedValue([
        { id: 'author', profile: 'zhngyq310334', engageXReplyAccount: null },
      ]);

      const res = await repo.backfillXReplyIntegrations('org1', false);

      expect(postUpdate).toHaveBeenCalledWith({
        where: { id: 'post1' },
        data: { integrationId: 'author' },
      });
      expect(res).toMatchObject({ found: 1, filled: 1, unresolved: 0 });
      expect(res.items[0]).toEqual({ postId: 'post1', integrationId: 'author', matchedBy: 'handle' });
    });

    it('does not write in dry-run, but still reports what would be filled', async () => {
      const { repo, sentFindMany, integrationFindMany, postUpdate } = buildBackfillRepo();
      sentFindMany.mockResolvedValue([
        { post: { id: 'post1', releaseURL: 'https://x.com/someoneelse/status/1' } },
      ]);
      integrationFindMany.mockResolvedValue([
        { id: 'author', profile: 'someoneelse', engageXReplyAccount: null },
      ]);

      const res = await repo.backfillXReplyIntegrations('org1', true);

      expect(postUpdate).not.toHaveBeenCalled();
      expect(res).toMatchObject({ found: 1, filled: 1, unresolved: 0 });
      expect(res.items[0].matchedBy).toBe('handle');
    });

    it('counts replies as unresolved when the org has no usable X account', async () => {
      const { repo, sentFindMany, integrationFindMany, postUpdate } = buildBackfillRepo();
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
      const { repo, sentFindMany, integrationFindMany, postUpdate } = buildBackfillRepo();
      sentFindMany.mockResolvedValue([
        { post: { id: 'post1', releaseURL: 'https://x.com/externalguy/status/1' } },
      ]);
      // Org has a live X account, but it isn't the reply's author.
      integrationFindMany.mockResolvedValue([
        { id: 'brand', profile: 'brandhq', engageXReplyAccount: { engageEnabled: true } },
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
        {} as any, {} as any, {} as any,
        {} as any, {} as any, {} as any, {} as any, {} as any,
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
        {} as any,
        { model: { engageKeyword: { findFirst: keywordFindFirst, update: keywordUpdate } } } as any,
        {} as any, {} as any, {} as any,
        {} as any, {} as any, {} as any, {} as any, {} as any,
        {} as any,
        {} as any,
        { model: { engageKeywordInitialScan: { upsert: initialUpsert } } } as any
      );

      await repo.updateKeyword('org1', 'kw1', { enabled: true } as any);

      expect(initialUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { keywordId_platform: { keywordId: 'kw1', platform: 'reddit' } },
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
        { model: { engageKeyword: { findFirst: keywordFindFirst, update: keywordUpdate } } } as any,
        {} as any, {} as any, {} as any,
        {} as any, {} as any, {} as any, {} as any, {} as any,
        {} as any,
        {} as any,
        { model: { engageKeywordInitialScan: { upsert: initialUpsert } } } as any
      );

      await repo.updateKeyword('org1', 'kw1', { type: 'BRAND' } as any);

      expect(initialUpsert).not.toHaveBeenCalled();
    });
  });

  describe('addMonitoredChannel', () => {
    // (configId, platform, channelId) is unique — duplicate → 409.
    function buildChannelRepo() {
      const channelCreate = vi.fn();
      const channel = {
        model: { engageMonitoredChannel: { create: channelCreate } },
      } as any;
      const repo = new EngageRepository(
        {} as any, {} as any,
        channel, // _channel
        {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
        {} as any, {} as any
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
          channelId: 't5_x',
          channelName: 'r/football',
        } as any)
      ).rejects.toMatchObject({
        status: 409,
        message: 'Channel "r/football" already exists',
      });
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
        {} as any, {} as any, {} as any,
        trackedAccount, // _trackedAccount
        {} as any, {} as any, {} as any, {} as any, {} as any,
        {} as any, {} as any
      );
      return { repo, trackedCreate };
    }

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
  });
});

describe('EngageRepository.getOrgScanStatus', () => {
  // Cadence defaults (env unset): keyword 24h, channel/tracked 3h.
  const H = 3_600_000;

  it('derives keyword next = lastScanStartedAt + cadence; last = lastScannedAt', async () => {
    const { repo, channelFindMany, trackedFindMany, cursorFindMany } = buildRepo();
    const started = new Date('2026-06-01T00:00:00Z');
    const scanned = new Date('2026-06-01T00:05:00Z');
    channelFindMany.mockResolvedValue([]); // org monitors no subreddits
    trackedFindMany.mockResolvedValue([]); // org tracks no accounts
    cursorFindMany.mockImplementation(async ({ where }: any) =>
      where.scanType === 'keyword'
        ? [{ lastScanStartedAt: started, lastScannedAt: scanned, cooldownUntil: null }]
        : []
    );

    const st = await repo.getOrgScanStatus('org1');
    expect(st.keyword.lastScanAt).toEqual(scanned);
    expect(st.keyword.nextScanAt).toEqual(new Date(started.getTime() + 24 * H));
    // Scoped types the org hasn't configured report null.
    expect(st.channel).toEqual({ lastScanAt: null, nextScanAt: null });
    expect(st.tracked).toEqual({ lastScanAt: null, nextScanAt: null });
    // Overall folds across types.
    expect(st.lastScanAt).toEqual(scanned);
    expect(st.nextScanAt).toEqual(new Date(started.getTime() + 24 * H));
  });

  it('cooldownUntil pushes next scan beyond the cadence', async () => {
    const { repo, channelFindMany, trackedFindMany, cursorFindMany } = buildRepo();
    const started = new Date('2026-06-01T00:00:00Z');
    const cooldown = new Date('2026-06-05T00:00:00Z'); // far past started + 24h
    channelFindMany.mockResolvedValue([]);
    trackedFindMany.mockResolvedValue([]);
    cursorFindMany.mockImplementation(async ({ where }: any) =>
      where.scanType === 'keyword'
        ? [{ lastScanStartedAt: started, lastScannedAt: started, cooldownUntil: cooldown }]
        : []
    );

    const st = await repo.getOrgScanStatus('org1');
    expect(st.keyword.nextScanAt).toEqual(cooldown);
  });

  it('aggregates the org\'s channel cursors: latest last, earliest next', async () => {
    const { repo, channelFindMany, trackedFindMany, cursorFindMany } = buildRepo();
    channelFindMany.mockResolvedValue([{ channelId: 'a' }, { channelId: 'b' }]);
    trackedFindMany.mockResolvedValue([]);
    const aStart = new Date('2026-06-01T00:00:00Z'); // next = +3h
    const bStart = new Date('2026-06-01T01:00:00Z'); // next = +3h (later)
    const aScanned = new Date('2026-06-01T00:10:00Z');
    const bScanned = new Date('2026-06-01T01:10:00Z'); // latest completion
    cursorFindMany.mockImplementation(async ({ where }: any) =>
      where.scanType === 'channel'
        ? [
            { lastScanStartedAt: aStart, lastScannedAt: aScanned, cooldownUntil: null },
            { lastScanStartedAt: bStart, lastScannedAt: bScanned, cooldownUntil: null },
          ]
        : []
    );

    const st = await repo.getOrgScanStatus('org1');
    expect(st.channel.lastScanAt).toEqual(bScanned); // max of completions
    expect(st.channel.nextScanAt).toEqual(new Date(aStart.getTime() + 3 * H)); // earliest due
    // Queried exactly this org's subreddit ids.
    expect(cursorFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          scanType: 'channel',
          scanKey: { in: ['a', 'b'] },
        }),
      })
    );
  });

  it('lowercases tracked usernames for the cursor lookup', async () => {
    const { repo, channelFindMany, trackedFindMany, cursorFindMany } = buildRepo();
    channelFindMany.mockResolvedValue([]);
    trackedFindMany.mockResolvedValue([{ username: 'OpenAI' }, { username: 'Vercel' }]);
    cursorFindMany.mockResolvedValue([]);

    await repo.getOrgScanStatus('org1');
    expect(cursorFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          scanType: 'tracked',
          scanKey: { in: ['openai', 'vercel'] },
        }),
      })
    );
  });
});
