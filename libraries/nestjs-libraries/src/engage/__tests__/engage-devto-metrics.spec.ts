import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  parseDevtoCommentShortId,
  devtoCommentPermalink,
} from '@gitroom/nestjs-libraries/engage/devto-url';
import {
  buildReplyMetricsFromRaw,
  dispatchReplyMetricsSync,
  syncDevtoMetrics,
  REPLY_METRICS_PLATFORMS,
} from '@gitroom/nestjs-libraries/engage/engage-metrics-sync';
import { normalizeReplyMetrics } from '@gitroom/nestjs-libraries/engage/engage-metrics-stats';

/**
 * Dev.to reply metrics, end to end through the server-side path.
 *
 * The markup in `commentPage()` mirrors what dev.to actually serves at
 * /<author>/comment/<shortId>: the wrapper `comment-node-<numericId>` carrying a
 * `data-path` that ends in the SHORT id, and a like button keyed on the NUMERIC
 * id further down. The two ids are unrelated, which is the whole reason the
 * fetcher resolves one from the other instead of reading the count directly.
 */
function commentPage(
  entries: Array<{ nodeId: string; shortId: string; reactions: number }>,
  articleId?: string
): string {
  // Forem stamps the numeric article id on this page; it is what the reply
  // count is looked up with. Omitted here by default so a case that says
  // nothing about replies makes no second request at all.
  const header = articleId
    ? `<div id="article-show-container" data-article-id="${articleId}"></div>`
    : '';
  return (
    header +
    entries
      .map(
        (e) => `
<div
    id="comment-node-${e.nodeId}"
    class="comment single-comment-node root"
    data-comment-id="${e.nodeId}"
    data-path="/author/some-article-4n53/comments/${e.shortId}"
>
  <div class="comment__body">a reply</div>
  <button id="button-for-comment-${e.nodeId}" class="reaction-button">
    <span class="reactions-count">${e.reactions}</span>
  </button>
</div>`
      )
      .join('\n')
  );
}

/**
 * Serve the comment page and (when a tree is supplied) Forem's thread endpoint,
 * routed by URL the way the real fetches are. `tree: null` stands for the
 * endpoint being reachable but failing — the case that must still write the
 * reaction count it already has.
 */
function stubFetch(page: string, tree?: unknown | null) {
  const fetchMock = vi.fn(async (url: unknown) => {
    if (String(url).includes('/api/comments')) {
      if (tree === null || tree === undefined) {
        return { ok: false, status: 503, text: async () => '' };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify(tree) };
    }
    return { ok: true, status: 200, text: async () => page };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function freshDeps() {
  return {
    updatePostMetrics: vi.fn(),
    markAuthorReplied: vi.fn(),
    checkPostAnalytics: vi.fn(),
    warn: vi.fn(),
    log: vi.fn(),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseDevtoCommentShortId', () => {
  it('reads the id from a canonical comment permalink', () => {
    expect(
      parseDevtoCommentShortId('https://dev.to/tercelyi/comment/3e1fm')
    ).toBe('3e1fm');
  });

  it("reads the id from the article link dev.to's own Copy link produces", () => {
    expect(
      parseDevtoCommentShortId(
        'https://dev.to/aibughunter/the-real-reason-4n53#comment-3e1fm'
      )
    ).toBe('3e1fm');
  });

  it('tolerates a trailing slash, whitespace and a missing scheme', () => {
    expect(parseDevtoCommentShortId('  dev.to/tercelyi/comment/3e37f/  ')).toBe(
      '3e37f'
    );
  });

  it('returns null for an ARTICLE url — it names no comment', () => {
    expect(
      parseDevtoCommentShortId(
        'https://dev.to/aibughunter/the-real-reason-4n53'
      )
    ).toBeNull();
  });

  it('returns null for a look-alike host', () => {
    expect(
      parseDevtoCommentShortId('https://notdev.to/tercelyi/comment/3e1fm')
    ).toBeNull();
  });

  it('returns null for junk', () => {
    expect(parseDevtoCommentShortId('not a url')).toBeNull();
    expect(parseDevtoCommentShortId(null)).toBeNull();
    expect(parseDevtoCommentShortId('')).toBeNull();
  });

  it('builds the canonical permalink dev.to itself links to', () => {
    expect(devtoCommentPermalink('tercelyi', '3e1fm')).toBe(
      'https://dev.to/tercelyi/comment/3e1fm'
    );
  });
});

describe('syncDevtoMetrics', () => {
  const url = 'https://dev.to/tercelyi/comment/3e1fm';

  it('writes the reaction count and its traffic score', async () => {
    const deps = freshDeps();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () =>
          commentPage([{ nodeId: '1618080', shortId: '3e1fm', reactions: 7 }]),
      })
    );

    const out = await syncDevtoMetrics('post-1', url, deps as any);

    expect(out).toBe('written');
    const [postId, impressions, analytics, trafficScore] =
      deps.updatePostMetrics.mock.calls[0];
    expect(postId).toBe('post-1');
    // Deliberately not an estimate — dev.to publishes no reach for a comment.
    expect(impressions).toBe(0);
    // `reactions`, not `likes`: it is the label TRAFFIC_WEIGHTS.devto scores.
    expect((analytics as any)[0].label).toBe('reactions');
    expect((analytics as any)[0].data[0].total).toBe('7');
    expect(trafficScore).toBe(7);
  });

  it("reads OUR comment's count, not a neighbouring comment's", async () => {
    const deps = freshDeps();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () =>
          commentPage([
            { nodeId: '1111111', shortId: 'other1', reactions: 99 },
            { nodeId: '1618080', shortId: '3e1fm', reactions: 2 },
            { nodeId: '2222222', shortId: 'other2', reactions: 42 },
          ]),
      })
    );

    await syncDevtoMetrics('post-1', url, deps as any);

    const [, , analytics, trafficScore] = deps.updatePostMetrics.mock.calls[0];
    expect((analytics as any)[0].data[0].total).toBe('2');
    expect(trafficScore).toBe(2);
  });

  it('counts the direct replies to our comment and scores them at ×3', async () => {
    const deps = freshDeps();
    const fetchMock = stubFetch(
      commentPage(
        [{ nodeId: '1618080', shortId: '3e1fm', reactions: 2 }],
        '4489837'
      ),
      // Our comment sits one level down, with two direct replies of its own and
      // a grandchild that must NOT be counted — only DIRECT replies score.
      [
        {
          id_code: 'root1',
          children: [
            {
              id_code: '3e1fm',
              children: [
                {
                  id_code: 'kid1',
                  children: [{ id_code: 'grandkid', children: [] }],
                },
                { id_code: 'kid2', children: [] },
              ],
            },
          ],
        },
        {
          id_code: 'unrelated',
          children: [{ id_code: 'other', children: [] }],
        },
      ]
    );

    const out = await syncDevtoMetrics('post-1', url, deps as any);

    expect(out).toBe('written');
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://dev.to/api/comments?a_id=4489837'
    );
    const [, , analytics, trafficScore] = deps.updatePostMetrics.mock.calls[0];
    expect((analytics as any).map((a: any) => a.label)).toEqual([
      'reactions',
      'comments',
    ]);
    expect((analytics as any)[1].data[0].total).toBe('2');
    // reactions×1 + comments×3 — the same ratio Reddit's replies are scored on.
    expect(trafficScore).toBe(2 * 1 + 2 * 3);
  });

  it('still writes the reaction count when the thread endpoint fails', async () => {
    const deps = freshDeps();
    stubFetch(
      commentPage(
        [{ nodeId: '1618080', shortId: '3e1fm', reactions: 4 }],
        '4489837'
      ),
      null
    );

    const out = await syncDevtoMetrics('post-1', url, deps as any);

    expect(out).toBe('written');
    const [, , analytics, trafficScore] = deps.updatePostMetrics.mock.calls[0];
    // No `comments` series at all: unknown must not be persisted as none, which
    // a 0 would be — and would score as one too.
    expect((analytics as any).map((a: any) => a.label)).toEqual(['reactions']);
    expect(trafficScore).toBe(4);
    expect(deps.warn).toHaveBeenCalled();
  });

  it('omits the reply count when our comment is not in the thread tree', async () => {
    const deps = freshDeps();
    stubFetch(
      commentPage(
        [{ nodeId: '1618080', shortId: '3e1fm', reactions: 1 }],
        '4489837'
      ),
      [{ id_code: 'someone-else', children: [] }]
    );

    await syncDevtoMetrics('post-1', url, deps as any);

    const [, , analytics] = deps.updatePostMetrics.mock.calls[0];
    expect((analytics as any).map((a: any) => a.label)).toEqual(['reactions']);
  });

  it('records zero replies as a FACT when the tree says so', async () => {
    const deps = freshDeps();
    stubFetch(
      commentPage(
        [{ nodeId: '1618080', shortId: '3e1fm', reactions: 1 }],
        '4489837'
      ),
      [{ id_code: '3e1fm', children: [] }]
    );

    await syncDevtoMetrics('post-1', url, deps as any);

    const [, , analytics, trafficScore] = deps.updatePostMetrics.mock.calls[0];
    expect((analytics as any)[1].data[0].total).toBe('0');
    expect(trafficScore).toBe(1);
  });

  it('makes no thread request when the page carries no article id', async () => {
    const deps = freshDeps();
    const fetchMock = stubFetch(
      commentPage([{ nodeId: '1618080', shortId: '3e1fm', reactions: 6 }])
    );

    await syncDevtoMetrics('post-1', url, deps as any);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, , analytics] = deps.updatePostMetrics.mock.calls[0];
    expect((analytics as any).map((a: any) => a.label)).toEqual(['reactions']);
  });

  it("returns 'skipped' without fetching when the URL names no comment", async () => {
    const deps = freshDeps();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const out = await syncDevtoMetrics(
      'post-1',
      'https://dev.to/aibughunter/the-real-reason-4n53',
      deps as any
    );

    expect(out).toBe('skipped');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(deps.updatePostMetrics).not.toHaveBeenCalled();
  });

  it("returns 'empty' when the comment is no longer on the page", async () => {
    const deps = freshDeps();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () =>
          commentPage([{ nodeId: '1111111', shortId: 'other1', reactions: 9 }]),
      })
    );

    const out = await syncDevtoMetrics('post-1', url, deps as any);

    expect(out).toBe('empty');
    expect(deps.updatePostMetrics).not.toHaveBeenCalled();
  });

  it("returns 'unreachable' on a non-OK response, writing nothing", async () => {
    const deps = freshDeps();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue({ ok: false, status: 404, text: async () => '' })
    );

    const out = await syncDevtoMetrics('post-1', url, deps as any);

    expect(out).toBe('unreachable');
    expect(deps.updatePostMetrics).not.toHaveBeenCalled();
    expect(deps.warn).toHaveBeenCalled();
  });

  it("returns 'unreachable' when the fetch itself throws", async () => {
    const deps = freshDeps();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));

    const out = await syncDevtoMetrics('post-1', url, deps as any);

    expect(out).toBe('unreachable');
    expect(deps.updatePostMetrics).not.toHaveBeenCalled();
  });
});

describe('dispatchReplyMetricsSync — devto routing', () => {
  it('routes a devto reply to the dev.to fetcher', async () => {
    const deps = freshDeps();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () =>
          commentPage([{ nodeId: '1618080', shortId: '3e1fm', reactions: 1 }]),
      })
    );

    const out = await dispatchReplyMetricsSync(
      {
        id: 'reply-1',
        organizationId: 'org-1',
        post: {
          id: 'post-1',
          releaseURL: 'https://dev.to/tercelyi/comment/3e1fm',
        },
        opportunity: { platform: 'devto', authorUsername: 'aibughunter' },
      } as any,
      deps as any
    );

    expect(out).toBe('written');
    expect(deps.updatePostMetrics).toHaveBeenCalledTimes(1);
    // The X path must not be touched — that one costs an API call.
    expect(deps.checkPostAnalytics).not.toHaveBeenCalled();
  });

  it('lists devto among the platforms whose reply metrics exist at all', () => {
    expect(REPLY_METRICS_PLATFORMS).toContain('devto');
    expect(REPLY_METRICS_PLATFORMS).not.toContain('medium');
    expect(REPLY_METRICS_PLATFORMS).not.toContain('linkedin');
  });
});

describe('buildReplyMetricsFromRaw — devto (extension-sourced)', () => {
  it("relabels the extension's `likes` as `reactions` so it actually scores", () => {
    const built = buildReplyMetricsFromRaw({ platform: 'devto', likes: 4 });

    expect(built.analytics).toHaveLength(1);
    expect(built.analytics[0].label).toBe('reactions');
    expect(built.analytics[0].data[0].total).toBe('4');
    // reactions×1 — the shared TRAFFIC_WEIGHTS.devto weight, the same one the
    // article-level metrics use. A `likes` label would have scored 0 here.
    expect(built.trafficScore).toBe(4);
    expect(built.impressions).toBe(0);
  });

  it('carries a reply count through when the sender has one', () => {
    const built = buildReplyMetricsFromRaw({
      platform: 'devto',
      likes: 2,
      comments: 3,
    });

    expect(built.analytics.map((a) => a.label)).toEqual([
      'reactions',
      'comments',
    ]);
    expect(built.trafficScore).toBe(2 * 1 + 3 * 3);
  });

  it('omits the series entirely when the sender knows no reply count', () => {
    const built = buildReplyMetricsFromRaw({ platform: 'devto', likes: 2 });

    // Absent, not 0 — an extension that only reads reactions must not be made
    // to assert "no replies" on a comment that may well have some.
    expect(built.analytics.map((a) => a.label)).toEqual(['reactions']);
    expect(built.trafficScore).toBe(2);
  });

  it('coerces a missing / non-finite count to 0 rather than NaN', () => {
    expect(buildReplyMetricsFromRaw({ platform: 'devto' }).trafficScore).toBe(
      0
    );
    expect(
      buildReplyMetricsFromRaw({ platform: 'devto', likes: NaN }).impressions
    ).toBe(0);
  });

  it('produces the SAME shape the server-side fetcher persists', async () => {
    const deps = freshDeps();
    stubFetch(
      commentPage(
        [{ nodeId: '1618080', shortId: '3e1fm', reactions: 5 }],
        '4489837'
      ),
      [{ id_code: '3e1fm', children: [{ id_code: 'kid', children: [] }] }]
    );
    await syncDevtoMetrics(
      'post-1',
      'https://dev.to/tercelyi/comment/3e1fm',
      deps as any
    );
    const [, serverImpressions, serverAnalytics, serverTraffic] =
      deps.updatePostMetrics.mock.calls[0];

    const built = buildReplyMetricsFromRaw({
      platform: 'devto',
      likes: 5,
      comments: 1,
    });

    expect(built.impressions).toBe(serverImpressions);
    expect(built.trafficScore).toBe(serverTraffic);
    expect(built.analytics).toEqual(serverAnalytics);
  });
});

describe('normalizeReplyMetrics — devto', () => {
  it('reports reactions and NO invented reach', () => {
    const metrics = normalizeReplyMetrics(
      'devto',
      [
        {
          label: 'reactions',
          data: [{ total: '3', date: '2026-09-03' }],
          percentageChange: 0,
        },
      ],
      0,
      3
    );

    expect(metrics.reactions).toBe(3);
    expect(metrics.trafficScore).toBe(3);
    // A flat `impressions: 0` would read as "nobody saw it"; dev.to simply does
    // not say, so the field is absent.
    expect(metrics.impressions).toBeUndefined();
    expect(metrics.estReach).toBeUndefined();
  });

  it('reads the reply count back, and leaves it ABSENT when never written', () => {
    const withReplies = normalizeReplyMetrics(
      'devto',
      [
        {
          label: 'reactions',
          data: [{ total: '3', date: '2026-09-03' }],
          percentageChange: 0,
        },
        {
          label: 'comments',
          data: [{ total: '2', date: '2026-09-03' }],
          percentageChange: 0,
        },
      ],
      0,
      9
    );
    expect(withReplies.comments).toBe(2);

    const withoutReplies = normalizeReplyMetrics(
      'devto',
      [
        {
          label: 'reactions',
          data: [{ total: '3', date: '2026-09-03' }],
          percentageChange: 0,
        },
      ],
      0,
      3
    );
    // A 0 here would tell the reader "nobody replied" about a count that was
    // never read at all.
    expect(withoutReplies.comments).toBeUndefined();
  });

  it('falls back to a `likes` label from an older row', () => {
    const metrics = normalizeReplyMetrics(
      'devto',
      [
        {
          label: 'likes',
          data: [{ total: '2', date: '2026-09-03' }],
          percentageChange: 0,
        },
      ],
      0,
      0
    );

    expect(metrics.reactions).toBe(2);
  });
});
