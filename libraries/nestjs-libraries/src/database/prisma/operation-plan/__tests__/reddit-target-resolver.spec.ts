import { describe, it, expect, vi } from 'vitest';
import {
  normalizeSubreddit,
  probeSubreddit,
  resolveRedditTargets,
  MonitoredRedditChannel,
  REDDIT_ACTIVITY_WINDOW_MS,
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
