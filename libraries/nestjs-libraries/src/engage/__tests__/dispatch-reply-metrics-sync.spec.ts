import { describe, it, expect, vi } from 'vitest';
import { dispatchReplyMetricsSync } from '@gitroom/nestjs-libraries/engage/engage-metrics-sync';

/**
 * dispatchReplyMetricsSync is the single dispatch path shared by the event-driven
 * refresh, the admin resync, and the daily Temporal resync (extracted to kill a
 * 3-way duplicated reddit/x branch). The reddit/x *routing* calls the real leaf
 * fetchers (intra-module bindings — not mockable via the module export, and they
 * do network I/O), so it stays covered by the higher-level caller specs. What IS
 * deterministic and worth locking in is the consolidated GUARD contract: every
 * "no work to do" condition must return 'skipped' WITHOUT touching deps or the
 * network. That guard is the actual behavior this refactor merged from three
 * copies into one, so it's the regression surface that matters.
 */
describe('dispatchReplyMetricsSync — guard/skip contract', () => {
  function freshDeps() {
    return {
      updatePostMetrics: vi.fn(),
      markAuthorReplied: vi.fn(),
      checkPostAnalytics: vi.fn(),
      warn: vi.fn(),
      log: vi.fn(),
    };
  }

  function reply(overrides: any = {}) {
    return {
      id: 'reply-1',
      organizationId: 'org-1',
      post: { id: 'post-1', releaseURL: 'https://x.com/a/1' },
      opportunity: { platform: 'x', externalPostId: 't1', authorUsername: 'a' },
      ...overrides,
    };
  }

  it("returns 'skipped' and touches no deps when releaseURL is null", async () => {
    const deps = freshDeps();
    const out = await dispatchReplyMetricsSync(
      reply({ post: { id: 'post-1', releaseURL: null } }),
      deps as any
    );
    expect(out).toBe('skipped');
    expect(deps.checkPostAnalytics).not.toHaveBeenCalled();
    expect(deps.updatePostMetrics).not.toHaveBeenCalled();
  });

  it("returns 'skipped' when the post relation is null", async () => {
    const deps = freshDeps();
    const out = await dispatchReplyMetricsSync(reply({ post: null }), deps as any);
    expect(out).toBe('skipped');
    expect(deps.checkPostAnalytics).not.toHaveBeenCalled();
  });

  it("returns 'skipped' for an unrecognised platform (not reddit/x)", async () => {
    const deps = freshDeps();
    const out = await dispatchReplyMetricsSync(
      reply({ opportunity: { platform: 'youtube' } }),
      deps as any
    );
    expect(out).toBe('skipped');
    expect(deps.checkPostAnalytics).not.toHaveBeenCalled();
    expect(deps.updatePostMetrics).not.toHaveBeenCalled();
  });
});
