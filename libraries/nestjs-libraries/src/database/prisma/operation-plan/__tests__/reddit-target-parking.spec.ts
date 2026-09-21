import { describe, expect, it } from 'vitest';
import { resolveRedditTargets } from '../reddit-target-resolver';

// Covers the outcome that did not exist before: a Reddit post kept as PARKED
// rather than dropped. The distinction being tested throughout is
// "Reddit said no" (drop) versus "we could not ask" (park) — conflating the two
// is what used to make a dead proxy silently delete a plan's Reddit half.

const input = (overrides: Record<string, unknown> = {}) => ({
  key: 'c1:0',
  llmSubreddit: 'claudeai',
  title: 'Shipping an MCP server',
  llmFlairLabel: null,
  llmTitleTag: null,
  ...overrides,
});

/** A probe transport whose every endpoint answers the same way. */
const transport = (status: number, body: unknown) => async () => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(body),
});

const alive = {
  data: {
    subreddit_type: 'public',
    submission_type: 'self',
    children: [{ data: { created_utc: Math.floor(Date.now() / 1000) } }],
  },
};

describe('parking when the backend cannot ask Reddit', () => {
  it('parks every Tier-2 post without probing when egress is unavailable', async () => {
    let probes = 0;
    const { outputs } = await resolveRedditTargets(
      [input(), input({ key: 'c2:0' })],
      [],
      {
        backendReadAvailable: () => false,
        fetchPublic: async () => {
          probes += 1;
          return { ok: true, status: 200, text: async () => JSON.stringify(alive) };
        },
      }
    );

    expect(probes).toBe(0); // the whole point: no doomed network walk per post
    expect(outputs.every((o) => o.target === null)).toBe(true);
    expect(outputs.map((o) => o.pending?.reason)).toEqual([
      'egress-unavailable',
      'egress-unavailable',
    ]);
    expect(outputs[0].pending?.candidate).toBe('claudeai');
  });

  it('parks — not drops — when the probe cannot reach Reddit', async () => {
    const { outputs } = await resolveRedditTargets([input()], [], {
      backendReadAvailable: () => true,
      // A transport failure: no status, nothing learned.
      fetchPublic: async () => {
        throw new Error('ECONNRESET');
      },
    });

    expect(outputs[0].target).toBeNull();
    expect(outputs[0].pending?.reason).toBe('probe-unreachable');
    expect(outputs[0].pending?.candidate).toBe('claudeai');
  });

  it('parks when generation proposed no subreddit at all', async () => {
    const { outputs } = await resolveRedditTargets(
      [input({ llmSubreddit: null })],
      [],
      { backendReadAvailable: () => true, fetchPublic: transport(200, alive) }
    );

    expect(outputs[0].target).toBeNull();
    expect(outputs[0].pending?.reason).toBe('no-candidate');
    // Null candidate is the signal for the extension to SEARCH rather than probe.
    expect(outputs[0].pending?.candidate).toBeNull();
  });

  it('carries the tagged title and flair hint into the marker', async () => {
    const { outputs } = await resolveRedditTargets(
      [input({ llmTitleTag: '[D]', llmFlairLabel: 'Discussion' })],
      [],
      { backendReadAvailable: () => false }
    );

    // Tagged HERE so the extension writes back exactly the title the resolved
    // path would have produced.
    expect(outputs[0].pending?.title).toBe('[D] Shipping an MCP server');
    expect(outputs[0].pending?.flairLabel).toBe('Discussion');
  });
});

describe('dropping stays reserved for a positive verdict from Reddit', () => {
  it('drops a community Reddit says is link-only', async () => {
    const linkOnly = {
      data: {
        subreddit_type: 'public',
        submission_type: 'link',
        children: [{ data: { created_utc: Math.floor(Date.now() / 1000) } }],
      },
    };
    const { outputs } = await resolveRedditTargets([input()], [], {
      backendReadAvailable: () => true,
      fetchPublic: transport(200, linkOnly),
    });

    expect(outputs[0].target).toBeNull();
    // No marker: nothing for the extension to re-check, so the post goes.
    expect(outputs[0].pending).toBeUndefined();
  });

  it('drops a community that does not exist (404 is Reddit answering)', async () => {
    const { outputs } = await resolveRedditTargets([input()], [], {
      backendReadAvailable: () => true,
      fetchPublic: transport(404, {}),
    });

    expect(outputs[0].target).toBeNull();
    expect(outputs[0].pending).toBeUndefined();
  });
});

describe('the healthy path is unchanged', () => {
  it('resolves a valid Tier-2 candidate and reports it as discovered', async () => {
    const { outputs, discovered } = await resolveRedditTargets([input()], [], {
      backendReadAvailable: () => true,
      fetchPublic: transport(200, alive),
    });

    expect(outputs[0].pending).toBeUndefined();
    expect(outputs[0].target?.subreddit).toBe('claudeai');
    expect(discovered).toEqual([{ subreddit: 'claudeai' }]);
  });

  it('a monitored channel still wins without needing a reachable probe', async () => {
    // Tier 1 trusts curation: an unreachable probe keeps the channel, so a
    // project that monitors Reddit is unaffected by an egress outage entirely.
    const { outputs } = await resolveRedditTargets(
      [input()],
      [
        {
          channelId: 'mycommunity',
          channelName: 'mycommunity',
          audienceSize: 5000,
          enabled: true,
        },
      ],
      {
        backendReadAvailable: () => true,
        fetchPublic: async () => {
          throw new Error('ECONNRESET');
        },
      }
    );

    expect(outputs[0].target?.subreddit).toBe('mycommunity');
    expect(outputs[0].pending).toBeUndefined();
  });
});
