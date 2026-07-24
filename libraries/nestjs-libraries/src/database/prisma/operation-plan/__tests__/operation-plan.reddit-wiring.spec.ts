import { describe, it, expect, vi, beforeEach } from 'vitest';

// Replace the resolver so this test exercises ONLY the service's wiring
// (mutation-apply + Tier-2 persistence), never the network.
const resolveRedditTargets = vi.fn();
vi.mock('../reddit-target-resolver', () => ({
  resolveRedditTargets: (...args: unknown[]) => resolveRedditTargets(...args),
}));

import { OperationPlanService } from '../operation-plan.service';

function makeService(engageRepository: any) {
  // Only _engageRepository + logger are used by _resolveAndAttachRedditTargets;
  // the rest are irrelevant to this seam.
  return new OperationPlanService(
    {} as any, // repo
    undefined, // aiseeClient
    undefined, // creditService
    undefined, // settingsService
    undefined, // openaiService
    engageRepository
  );
}

// Two content items: one reddit + x, one reddit-only.
function makeContentItems() {
  return [
    {
      contentId: 'D01',
      themeTitle: 'Theme one',
      platforms: [
        { id: 'x-1', platform: 'x', content: 'x post', subreddit: null },
        { id: 'r-1', platform: 'reddit', content: 'reddit post', subreddit: 'webdev' },
      ],
    },
    {
      contentId: 'D02',
      themeTitle: 'Theme two',
      platforms: [
        { id: 'r-2', platform: 'reddit', content: 'reddit post 2', subreddit: 'ghost' },
      ],
    },
  ] as any;
}

describe('_resolveAndAttachRedditTargets wiring', () => {
  beforeEach(() => resolveRedditTargets.mockReset());

  it('attaches targets, drops unresolved posts, prunes empty items, and persists discoveries', async () => {
    const listMonitoredChannels = vi.fn().mockResolvedValue([
      { platform: 'reddit', channelId: 'webdev', channelName: 'webdev', audienceSize: 5, enabled: true },
    ]);
    const getOrCreateConfig = vi.fn().mockResolvedValue({ id: 'config-1' });
    const addMonitoredChannel = vi.fn().mockResolvedValue({});
    const service = makeService({ listMonitoredChannels, getOrCreateConfig, addMonitoredChannel });

    resolveRedditTargets.mockResolvedValue({
      outputs: [
        // r-1 resolves; r-2 is dropped.
        { key: 'r-1:0', target: { subreddit: 'webdev', title: 'Theme one', type: 'self', is_flair_required: false } },
        { key: 'r-2:1', target: null },
      ],
      discovered: [{ subreddit: 'webdev' }],
    });

    const contentItems = makeContentItems();
    await (service as any)._resolveAndAttachRedditTargets('org-1', 'proj-1', contentItems);

    // Only reddit posts are fed to the resolver, titled by their owning item.
    expect(resolveRedditTargets).toHaveBeenCalledTimes(1);
    const inputs = resolveRedditTargets.mock.calls[0][0];
    expect(inputs).toEqual([
      { key: 'r-1:0', llmSubreddit: 'webdev', title: 'Theme one' },
      { key: 'r-2:1', llmSubreddit: 'ghost', title: 'Theme two' },
    ]);
    // Monitored channels (reddit-only) are passed through.
    expect(resolveRedditTargets.mock.calls[0][1]).toEqual([
      { channelId: 'webdev', channelName: 'webdev', audienceSize: 5, enabled: true },
    ]);

    // D01 keeps x + the resolved reddit post (now carrying redditTarget);
    // D02 (reddit-only, dropped) is pruned entirely.
    expect(contentItems).toHaveLength(1);
    expect(contentItems[0].contentId).toBe('D01');
    const platforms = contentItems[0].platforms;
    expect(platforms.map((p: any) => p.id)).toEqual(['x-1', 'r-1']);
    expect(platforms[1].redditTarget).toEqual({
      subreddit: 'webdev',
      title: 'Theme one',
      type: 'self',
      is_flair_required: false,
    });

    // Tier-2 discovery persisted back into the project's Engage config.
    expect(getOrCreateConfig).toHaveBeenCalledWith('org-1', 'proj-1');
    expect(addMonitoredChannel).toHaveBeenCalledWith('config-1', 'org-1', {
      platform: 'reddit',
      channelId: 'webdev',
      channelName: 'webdev',
    });
  });

  it('is a no-op when there are no reddit posts', async () => {
    const listMonitoredChannels = vi.fn();
    const service = makeService({ listMonitoredChannels });
    const contentItems = [
      { contentId: 'D01', themeTitle: 'T', platforms: [{ id: 'x-1', platform: 'x', content: 'c', subreddit: null }] },
    ] as any;

    await (service as any)._resolveAndAttachRedditTargets('org-1', 'proj-1', contentItems);

    expect(resolveRedditTargets).not.toHaveBeenCalled();
    expect(listMonitoredChannels).not.toHaveBeenCalled();
    expect(contentItems).toHaveLength(1);
  });

  it('does not throw when a discovery persist fails (best-effort)', async () => {
    const service = makeService({
      listMonitoredChannels: vi.fn().mockResolvedValue([]),
      getOrCreateConfig: vi.fn().mockResolvedValue({ id: 'config-1' }),
      addMonitoredChannel: vi.fn().mockRejectedValue(new Error('409 conflict')),
    });
    resolveRedditTargets.mockResolvedValue({
      outputs: [{ key: 'r-1:0', target: { subreddit: 'webdev', title: 'T', type: 'self', is_flair_required: false } }],
      discovered: [{ subreddit: 'webdev' }],
    });
    const contentItems = [
      { contentId: 'D01', themeTitle: 'T', platforms: [{ id: 'r-1', platform: 'reddit', content: 'c', subreddit: 'webdev' }] },
    ] as any;

    await expect(
      (service as any)._resolveAndAttachRedditTargets('org-1', 'proj-1', contentItems)
    ).resolves.toBeUndefined();
    expect(contentItems[0].platforms[0].redditTarget).toBeTruthy();
  });
});
