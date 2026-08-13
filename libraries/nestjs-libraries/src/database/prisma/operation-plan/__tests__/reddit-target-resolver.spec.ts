import { describe, it, expect, vi } from 'vitest';
import {
  applyTitleTag,
  normalizeSubreddit,
  probeSubreddit,
  resolveRedditTargets,
  MonitoredRedditChannel,
  REDDIT_ACTIVITY_WINDOW_MS,
  REDDIT_RULE_TTL_MS,
  isRuleObservationFresh,
} from '../reddit-target-resolver';

const NOW = 1_700_000_000_000; // fixed clock
const now = () => NOW;

// Build a fake public-GET keyed by a per-subreddit fixture. Each fixture may
// provide `about` (subreddit_type/submission_type) and `newestAgeMs` (age of the
// newest post). Missing about → 404; `unreachable` → non-JSON body (WAF).
type Fixture = {
  status?: number;
  about?: { subreddit_type?: string; submission_type?: string } | null;
  newestAgeMs?: number | null;
  unreachable?: boolean;
};
function fakeFetch(fixtures: Record<string, Fixture>) {
  return vi.fn(async (url: string) => {
    const name = decodeURIComponent(
      url.match(/\/r\/([^/]+)\//)?.[1] ?? ''
    ).toLowerCase();
    const fx = fixtures[name];
    if (!fx || fx.status === 404) {
      return { ok: false, status: 404, text: async () => 'not found' };
    }
    if (fx.unreachable) {
      return { ok: true, status: 200, text: async () => '<html>blocked</html>' };
    }
    if (url.includes('/about.json')) {
      if (fx.about === null || fx.about === undefined) {
        return { ok: false, status: 404, text: async () => 'gone' };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: fx.about }),
      };
    }
    // new.json
    const children =
      fx.newestAgeMs == null
        ? []
        : [{ data: { created_utc: (NOW - fx.newestAgeMs) / 1000 } }];
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: { children } }),
    };
  });
}

describe('normalizeSubreddit', () => {
  it('strips prefixes and lowercases', () => {
    expect(normalizeSubreddit('r/WebDev')).toBe('webdev');
    expect(normalizeSubreddit('/r/webdev/')).toBe('webdev');
    expect(normalizeSubreddit('  WebDev ')).toBe('webdev');
  });
  it('rejects invalid names', () => {
    expect(normalizeSubreddit(null)).toBeNull();
    expect(normalizeSubreddit('')).toBeNull();
    expect(normalizeSubreddit('has space')).toBeNull();
    expect(normalizeSubreddit('has-hyphen')).toBeNull(); // subreddits disallow hyphens
    expect(normalizeSubreddit('a')).toBeNull(); // below @MinLength(2)
  });
});

describe('probeSubreddit', () => {
  it('reports a healthy public self-post subreddit', async () => {
    const fetchPublic = fakeFetch({
      webdev: { about: { subreddit_type: 'public', submission_type: 'any' }, newestAgeMs: 3600_000 },
    });
    const p = await probeSubreddit('webdev', { fetchPublic, now });
    expect(p).toEqual({ reachable: true, exists: true, isPublic: true, allowsSelf: true, active48h: true });
  });

  it('marks a 404 as reachable-but-nonexistent', async () => {
    const p = await probeSubreddit('ghost', { fetchPublic: fakeFetch({}), now });
    expect(p).toMatchObject({ reachable: true, exists: false });
  });

  it('treats a WAF interstitial as unreachable', async () => {
    const fetchPublic = fakeFetch({ blocked: { unreachable: true } });
    const p = await probeSubreddit('blocked', { fetchPublic, now });
    expect(p.reachable).toBe(false);
  });

  it('flags link-only and private subreddits', async () => {
    const fetchPublic = fakeFetch({
      linksonly: { about: { subreddit_type: 'public', submission_type: 'link' }, newestAgeMs: 1000 },
      secret: { about: { subreddit_type: 'private', submission_type: 'any' }, newestAgeMs: 1000 },
    });
    expect((await probeSubreddit('linksonly', { fetchPublic, now })).allowsSelf).toBe(false);
    expect((await probeSubreddit('secret', { fetchPublic, now })).isPublic).toBe(false);
  });

  it('flags inactivity beyond the 48h window', async () => {
    const fetchPublic = fakeFetch({
      quiet: {
        about: { subreddit_type: 'public', submission_type: 'self' },
        newestAgeMs: REDDIT_ACTIVITY_WINDOW_MS + 60_000,
      },
    });
    expect((await probeSubreddit('quiet', { fetchPublic, now })).active48h).toBe(false);
  });
});

const channels = (...names: { name: string; audience?: number; enabled?: boolean }[]): MonitoredRedditChannel[] =>
  names.map((n) => ({
    channelId: n.name,
    channelName: n.name,
    audienceSize: n.audience ?? 0,
    enabled: n.enabled ?? true,
  }));

describe('resolveRedditTargets — Tier 1 (monitored channels)', () => {
  it('assigns curated channels, largest-audience-first, round-robin', async () => {
    const fetchPublic = fakeFetch({
      big: { about: { subreddit_type: 'public', submission_type: 'self' }, newestAgeMs: 1000 },
      small: { about: { subreddit_type: 'public', submission_type: 'self' }, newestAgeMs: 1000 },
    });
    const inputs = [
      { key: 'a', llmSubreddit: 'ignored', title: 'T1' },
      { key: 'b', llmSubreddit: null, title: 'T2' },
      { key: 'c', llmSubreddit: null, title: 'T3' },
    ];
    const { outputs, discovered } = await resolveRedditTargets(
      inputs,
      channels({ name: 'small', audience: 10 }, { name: 'big', audience: 999 }),
      { fetchPublic, now }
    );
    expect(outputs.map((o) => o.target?.subreddit)).toEqual(['big', 'small', 'big']);
    expect(outputs[0].target).toMatchObject({ type: 'self', is_flair_required: false, title: 'T1' });
    // Tier 1 never persists — the channels are already monitored.
    expect(discovered).toEqual([]);
  });

  it('drops a monitored channel that is now link-only or gone', async () => {
    const fetchPublic = fakeFetch({
      linksonly: { about: { subreddit_type: 'public', submission_type: 'link' }, newestAgeMs: 1000 },
    });
    const { outputs } = await resolveRedditTargets(
      [{ key: 'a', llmSubreddit: null, title: 'T' }],
      channels({ name: 'linksonly' }),
      { fetchPublic, now }
    );
    expect(outputs[0].target).toBeNull();
  });

  it('excludes unpostable channels from the pool without dropping posts (no round-robin onto a dead sub)', async () => {
    const fetchPublic = fakeFetch({
      dead: { about: { subreddit_type: 'public', submission_type: 'link' }, newestAgeMs: 1000 },
      good: { about: { subreddit_type: 'public', submission_type: 'self' }, newestAgeMs: 1000 },
    });
    const { outputs } = await resolveRedditTargets(
      [
        { key: 'a', llmSubreddit: null, title: 'T1' },
        { key: 'b', llmSubreddit: null, title: 'T2' },
        { key: 'c', llmSubreddit: null, title: 'T3' },
      ],
      channels({ name: 'dead', audience: 999 }, { name: 'good', audience: 1 }),
      { fetchPublic, now }
    );
    // Every post lands on the one postable channel; none dropped.
    expect(outputs.map((o) => o.target?.subreddit)).toEqual(['good', 'good', 'good']);
  });

  it('falls back to Tier 2 when every monitored channel is unpostable', async () => {
    const fetchPublic = fakeFetch({
      dead: { about: { subreddit_type: 'private', submission_type: 'any' }, newestAgeMs: 1000 },
      webdev: { about: { subreddit_type: 'public', submission_type: 'self' }, newestAgeMs: 1000 },
    });
    const { outputs, discovered } = await resolveRedditTargets(
      [{ key: 'a', llmSubreddit: 'webdev', title: 'T' }],
      channels({ name: 'dead' }),
      { fetchPublic, now }
    );
    // Monitored pool is empty after validation → Tier-2 validates the LLM value.
    expect(outputs[0].target?.subreddit).toBe('webdev');
    expect(discovered).toEqual([{ subreddit: 'webdev' }]);
  });

  it('keeps a monitored channel when the probe is unreachable (trust curation)', async () => {
    const fetchPublic = fakeFetch({ trusted: { unreachable: true } });
    const { outputs } = await resolveRedditTargets(
      [{ key: 'a', llmSubreddit: null, title: 'T' }],
      channels({ name: 'trusted' }),
      { fetchPublic, now }
    );
    expect(outputs[0].target?.subreddit).toBe('trusted');
  });
});

describe('resolveRedditTargets — Tier 2 (LLM proposal + validation)', () => {
  it('accepts a valid LLM subreddit and marks it for persistence', async () => {
    const fetchPublic = fakeFetch({
      webdev: { about: { subreddit_type: 'public', submission_type: 'self' }, newestAgeMs: 1000 },
    });
    const { outputs, discovered } = await resolveRedditTargets(
      [{ key: 'a', llmSubreddit: 'r/WebDev', title: 'Hello' }],
      [],
      { fetchPublic, now }
    );
    expect(outputs[0].target).toMatchObject({ subreddit: 'webdev', title: 'Hello', type: 'self' });
    expect(discovered).toEqual([{ subreddit: 'webdev' }]);
  });

  it('clamps an over-long title to Reddit’s 300-char ceiling', async () => {
    const fetchPublic = fakeFetch({
      webdev: { about: { subreddit_type: 'public', submission_type: 'self' }, newestAgeMs: 1000 },
    });
    const { outputs } = await resolveRedditTargets(
      [{ key: 'a', llmSubreddit: 'webdev', title: 'x'.repeat(500) }],
      [],
      { fetchPublic, now }
    );
    expect(outputs[0].target?.title).toHaveLength(300);
  });

  it('drops posts whose subreddit fails validation', async () => {
    const fetchPublic = fakeFetch({
      quiet: {
        about: { subreddit_type: 'public', submission_type: 'self' },
        newestAgeMs: REDDIT_ACTIVITY_WINDOW_MS + 1,
      },
    });
    const { outputs, discovered } = await resolveRedditTargets(
      [
        { key: 'missing', llmSubreddit: 'ghost', title: 'T' }, // 404
        { key: 'inactive', llmSubreddit: 'quiet', title: 'T' }, // stale
        { key: 'blank', llmSubreddit: null, title: 'T' }, // no proposal
      ],
      [],
      { fetchPublic, now }
    );
    expect(outputs.every((o) => o.target === null)).toBe(true);
    expect(discovered).toEqual([]);
  });

  it('probes each distinct subreddit once (memoized) and dedups discoveries', async () => {
    const fetchPublic = fakeFetch({
      webdev: { about: { subreddit_type: 'public', submission_type: 'self' }, newestAgeMs: 1000 },
    });
    const { discovered } = await resolveRedditTargets(
      [
        { key: 'a', llmSubreddit: 'webdev', title: 'T1' },
        { key: 'b', llmSubreddit: 'webdev', title: 'T2' },
      ],
      [],
      { fetchPublic, now }
    );
    expect(discovered).toEqual([{ subreddit: 'webdev' }]);
    // about.json + new.json = 2 calls total for the single distinct subreddit.
    expect(fetchPublic).toHaveBeenCalledTimes(2);
  });
});

describe('applyTitleTag', () => {
  it('prefixes the subreddit-required tag onto the title', () => {
    expect(applyTitleTag('Q&A: apcore vs MCP', '[D]')).toBe('[D] Q&A: apcore vs MCP');
  });

  it('leaves the title untouched when no tag was proposed', () => {
    expect(applyTitleTag('Plain title', null)).toBe('Plain title');
    expect(applyTitleTag('Plain title', '')).toBe('Plain title');
    expect(applyTitleTag('Plain title', '   ')).toBe('Plain title');
  });

  // A sweeper re-run resolves the same plan again; without this guard the title
  // would accumulate "[D] [D] [D] …" one prefix per recovery pass.
  it('is idempotent — never double-prefixes an already-tagged title', () => {
    expect(applyTitleTag('[D] Already tagged', '[D]')).toBe('[D] Already tagged');
    expect(applyTitleTag('Discussion [d] mid-title', '[D]')).toBe('Discussion [d] mid-title');
  });

  it('still clamps to Reddit’s 300-char title limit after tagging', () => {
    const tagged = applyTitleTag('x'.repeat(300), '[R]');
    expect(tagged.length).toBe(300);
    expect(tagged.startsWith('[R] ')).toBe(true);
  });
});

describe('resolveRedditTargets — community filing rules', () => {
  it('carries the flair label through and tags the reddit title only', async () => {
    const fetchPublic = fakeFetch({
      webdev: { about: { subreddit_type: 'public', submission_type: 'self' }, newestAgeMs: 1000 },
    });
    const { outputs } = await resolveRedditTargets(
      [
        {
          key: 'a',
          llmSubreddit: 'webdev',
          title: 'Ask me anything',
          llmFlairLabel: 'Discussion',
          llmTitleTag: '[D]',
        },
      ],
      [],
      { fetchPublic, now }
    );
    expect(outputs[0].target).toMatchObject({
      subreddit: 'webdev',
      title: '[D] Ask me anything',
      flairLabel: 'Discussion',
      // Still false: nothing here can READ the real requirement (needs OAuth).
      is_flair_required: false,
    });
  });

  it('omits flairLabel entirely when generation proposed none', async () => {
    const fetchPublic = fakeFetch({
      webdev: { about: { subreddit_type: 'public', submission_type: 'self' }, newestAgeMs: 1000 },
    });
    const { outputs } = await resolveRedditTargets(
      [{ key: 'a', llmSubreddit: 'webdev', title: 'T', llmFlairLabel: null, llmTitleTag: null }],
      [],
      { fetchPublic, now }
    );
    expect(outputs[0].target).not.toHaveProperty('flairLabel');
    expect(outputs[0].target?.title).toBe('T');
  });

  it('applies the rules on the Tier-1 (monitored channel) path too', async () => {
    const fetchPublic = fakeFetch({
      curated: { about: { subreddit_type: 'public', submission_type: 'self' }, newestAgeMs: 1000 },
    });
    const { outputs } = await resolveRedditTargets(
      [
        {
          key: 'a',
          llmSubreddit: null,
          title: 'Findings',
          llmFlairLabel: 'Research',
          llmTitleTag: '[R]',
        },
      ],
      channels({ name: 'curated', audience: 5 }),
      { fetchPublic, now }
    );
    expect(outputs[0].target).toMatchObject({
      subreddit: 'curated',
      title: '[R] Findings',
      flairLabel: 'Research',
    });
  });
});

// ─── Capability-informed flair resolution ────────────────────────────────────
//
// A subreddit's flair options can only be learned by PUBLISHING there (Reddit's
// flair endpoints answer USER_REQUIRED to unauthenticated callers), so these
// cover both states: the community has been observed, and it has not.
describe('resolveRedditTargets flair resolution', () => {
  const LIVE = {
    about: { subreddit_type: 'public', submission_type: 'self' },
    newestAgeMs: 60_000,
  };
  const channels: MonitoredRedditChannel[] = [
    { channelId: 'football', channelName: 'r/football', audienceSize: 100, enabled: true },
  ];
  const input = (flair: string | null) => [
    { key: 'k1', llmSubreddit: 'football', title: 'A title', llmFlairLabel: flair },
  ];
  const run = (flair: string | null, getCapability?: any) =>
    resolveRedditTargets(input(flair), channels, {
      now,
      fetchPublic: fakeFetch({ football: LIVE }),
      ...(getCapability ? { getCapability } : {}),
    });

  it('passes the generated label through unverified when nothing is known', async () => {
    const { outputs } = await run('Growth Marketing');
    expect(outputs[0].target).toMatchObject({
      flairLabel: 'Growth Marketing',
      is_flair_required: false,
    });
  });

  // The r/football option set, verbatim: the generated label matches on text
  // but the real option carries an emoji, so carrying REDDIT's text forward is
  // what lets the extension's exact-match pass hit.
  it("rewrites a match to Reddit's own label, emoji included", async () => {
    const { outputs } = await run('News', async () => ({
      flairs: [{ label: 'Redditch United' }, { label: '📰News' }, { label: '⇄ Transfer News' }],
    }));
    expect(outputs[0].target?.flairLabel).toBe('📰News');
  });

  // Sending a label that provably does not exist only makes the executor burn a
  // match attempt before the same hand-off.
  it('drops a label that is not in the known option set', async () => {
    const { outputs } = await run('Growth Marketing', async () => ({
      flairs: [{ label: 'Redditch United' }, { label: '📰News' }],
    }));
    expect(outputs[0].target).toBeTruthy();
    expect(outputs[0].target).not.toHaveProperty('flairLabel');
  });

  // is_flair_required is copied verbatim into settings.subreddit[].value, where
  // RedditSettingsDtoInner makes `flair` conditionally REQUIRED on it. Nothing
  // here can supply a flair (it is {id,name} and an id needs OAuth), so a `true`
  // would make the generated post fail CreatePostDto the moment it is saved.
  // The observed requirement lives on the capability record instead.
  it('never leaks an observed flairRequired into is_flair_required', async () => {
    const { outputs } = await run(null, async () => ({ flairRequired: true }));
    expect(outputs[0].target?.is_flair_required).toBe(false);
  });

  it('leaves is_flair_required false when the community was never observed', async () => {
    const { outputs } = await run(null, async () => ({}));
    expect(outputs[0].target?.is_flair_required).toBe(false);
  });

  // An empty list means "observed nothing usable", which must not be read as
  // "this community offers no flairs" and silently discard every label.
  it('treats an empty flair list as unknown, not as an empty option set', async () => {
    const { outputs } = await run('Discussion', async () => ({ flairs: [] }));
    expect(outputs[0].target?.flairLabel).toBe('Discussion');
  });

  it('memoizes the lookup across posts sharing a subreddit', async () => {
    const getCapability = vi.fn(async () => ({ flairs: [{ label: 'News' }] }));
    await resolveRedditTargets(
      [
        { key: 'a', llmSubreddit: 'football', title: 't1', llmFlairLabel: 'News' },
        { key: 'b', llmSubreddit: 'football', title: 't2', llmFlairLabel: 'News' },
        { key: 'c', llmSubreddit: 'football', title: 't3', llmFlairLabel: 'News' },
      ],
      channels,
      { now, fetchPublic: fakeFetch({ football: LIVE }), getCapability }
    );
    expect(getCapability).toHaveBeenCalledTimes(1);
  });

  // The lookup is an optional enrichment; a plan is still publishable without
  // it, so neither a rejection nor a synchronous throw may fail generation.
  it('degrades to unverified when the lookup rejects', async () => {
    const { outputs } = await run('Discussion', async () => {
      throw new Error('db down');
    });
    expect(outputs[0].target?.flairLabel).toBe('Discussion');
  });

  it('degrades to unverified when the dep throws synchronously', async () => {
    const { outputs } = await run('Discussion', () => {
      throw new Error('not implemented');
    });
    expect(outputs[0].target?.flairLabel).toBe('Discussion');
  });
});

// The observed posting RULE travels separately from is_flair_required (which
// must stay hard-false or the settings DTO demands a flair id nothing can
// supply). It is what lets the executor skip a submit it knows will bounce.
describe('resolveRedditTargets flairRequired passthrough', () => {
  const LIVE = {
    about: { subreddit_type: 'public', submission_type: 'self' },
    newestAgeMs: 60_000,
  };
  const channels: MonitoredRedditChannel[] = [
    { channelId: 'football', channelName: 'r/football', audienceSize: 100, enabled: true },
  ];
  const resolve = (capability: any) =>
    resolveRedditTargets(
      [{ key: 'k1', llmSubreddit: 'football', title: 'A title', llmFlairLabel: null }],
      channels,
      {
        now,
        fetchPublic: fakeFetch({ football: LIVE }),
        getCapability: async () => capability,
      }
    );
  const freshly = (ageMs: number) => new Date(NOW - ageMs).toISOString();

  it('forwards a freshly observed requirement', async () => {
    const { outputs } = await resolve({
      flairRequired: true,
      observedAt: freshly(24 * 60 * 60 * 1000),
    });
    expect(outputs[0].target?.flairRequired).toBe(true);
    // …without ever touching the DTO-validated field.
    expect(outputs[0].target?.is_flair_required).toBe(false);
  });

  // A rule is only ever learned as `true`, so without an expiry a community
  // whose mods later drop the requirement would be routed through the tab
  // forever. Lapsing costs one doomed submit, which re-stamps observedAt if the
  // rule still holds.
  it('drops a requirement observed longer ago than the TTL', async () => {
    const { outputs } = await resolve({
      flairRequired: true,
      observedAt: freshly(REDDIT_RULE_TTL_MS + 60_000),
    });
    expect(outputs[0].target).not.toHaveProperty('flairRequired');
  });

  it('drops a requirement with no or unparseable observedAt', async () => {
    for (const observedAt of [undefined, '', 'not a date']) {
      const { outputs } = await resolve({ flairRequired: true, observedAt });
      expect(outputs[0].target).not.toHaveProperty('flairRequired');
    }
  });

  it('omits the field entirely when nothing was observed', async () => {
    const { outputs } = await resolve({ flairs: [{ label: 'News' }] });
    expect(outputs[0].target).not.toHaveProperty('flairRequired');
  });
});

describe('isRuleObservationFresh', () => {
  it('accepts an observation inside the window and rejects one outside it', () => {
    expect(isRuleObservationFresh(new Date(NOW).toISOString(), NOW)).toBe(true);
    expect(
      isRuleObservationFresh(new Date(NOW - REDDIT_RULE_TTL_MS + 1000).toISOString(), NOW)
    ).toBe(true);
    expect(
      isRuleObservationFresh(new Date(NOW - REDDIT_RULE_TTL_MS - 1000).toISOString(), NOW)
    ).toBe(false);
  });

  it('rejects a missing or unparseable timestamp rather than treating it as fresh', () => {
    expect(isRuleObservationFresh(undefined, NOW)).toBe(false);
    expect(isRuleObservationFresh('', NOW)).toBe(false);
    expect(isRuleObservationFresh('yesterday', NOW)).toBe(false);
  });
});
