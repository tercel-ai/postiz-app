import { describe, expect, it } from 'vitest';
import {
  applyResolvedRedditTarget,
  clearRedditTargetPending,
  readRedditTargetPending,
  REDDIT_TARGET_PENDING_KEY,
  settingsHavePendingRedditTarget,
} from '@gitroom/nestjs-libraries/engage/reddit-pending-target';

const parked = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    __type: 'reddit',
    contentId: 'D01',
    [REDDIT_TARGET_PENDING_KEY]: {
      candidate: 'claudeai',
      title: '[D] Shipping an MCP server',
      flairLabel: 'Discussion',
      reason: 'egress-unavailable',
      since: '2026-09-21T00:00:00.000Z',
    },
    ...extra,
  });

describe('reading the parked marker', () => {
  it('reads a well-formed marker', () => {
    const pending = readRedditTargetPending(parked());
    expect(pending).toEqual({
      candidate: 'claudeai',
      title: '[D] Shipping an MCP server',
      flairLabel: 'Discussion',
      reason: 'egress-unavailable',
      since: '2026-09-21T00:00:00.000Z',
    });
  });

  it('returns null for settings that carry no marker', () => {
    expect(readRedditTargetPending(JSON.stringify({ __type: 'reddit' }))).toBeNull();
    expect(settingsHavePendingRedditTarget(JSON.stringify({ __type: 'x' }))).toBe(false);
  });

  it('survives null, empty and unparseable settings', () => {
    expect(readRedditTargetPending(null)).toBeNull();
    expect(readRedditTargetPending('')).toBeNull();
    expect(readRedditTargetPending('{not json')).toBeNull();
    expect(readRedditTargetPending('"a string"')).toBeNull();
  });

  it('rejects a marker with no title — there would be nothing to submit', () => {
    const broken = JSON.stringify({
      [REDDIT_TARGET_PENDING_KEY]: { candidate: 'claudeai' },
    });
    expect(readRedditTargetPending(broken)).toBeNull();
  });

  it('tolerates a missing candidate — the resolver searches instead', () => {
    const noCandidate = JSON.stringify({
      [REDDIT_TARGET_PENDING_KEY]: { title: 'A post', reason: 'no-candidate' },
    });
    expect(readRedditTargetPending(noCandidate)?.candidate).toBeNull();
  });
});

describe('applying a resolution', () => {
  it('writes the subreddit and REMOVES the marker in one value', () => {
    const next = applyResolvedRedditTarget(parked(), {
      subreddit: 'claudeai',
      title: '[D] Shipping an MCP server',
      type: 'self',
    });
    const parsed = JSON.parse(next);

    expect(parsed[REDDIT_TARGET_PENDING_KEY]).toBeUndefined();
    expect(parsed.subreddit).toEqual([
      {
        value: {
          subreddit: 'claudeai',
          title: '[D] Shipping an MCP server',
          type: 'self',
          is_flair_required: false,
        },
      },
    ]);
    // A post can never be both parked and resolved — that is the whole point of
    // doing it in one write.
    expect(settingsHavePendingRedditTarget(next)).toBe(false);
  });

  it('preserves unrelated settings keys', () => {
    const next = applyResolvedRedditTarget(parked({ campaignId: 'c-1' }), {
      subreddit: 'claudeai',
      title: 'T',
      type: 'self',
    });
    const parsed = JSON.parse(next);
    expect(parsed.__type).toBe('reddit');
    expect(parsed.contentId).toBe('D01');
    expect(parsed.campaignId).toBe('c-1');
  });

  it('pins is_flair_required false even when a flair requirement was observed', () => {
    // The DTO makes `flair` ({id,name}) conditionally required on this field and
    // nothing can supply a flair id without OAuth, so a true here would make the
    // post fail validation on every later save. The observation rides in
    // flairRequired instead.
    const next = applyResolvedRedditTarget(parked(), {
      subreddit: 'machinelearning',
      title: 'T',
      type: 'self',
      flairLabel: 'Research',
      flairRequired: true,
    });
    const value = JSON.parse(next).subreddit[0].value;
    expect(value.is_flair_required).toBe(false);
    expect(value.flairRequired).toBe(true);
    expect(value.flairLabel).toBe('Research');
  });

  it('omits flair fields entirely when there are none', () => {
    const value = JSON.parse(
      applyResolvedRedditTarget(parked(), {
        subreddit: 'claudeai',
        title: 'T',
        type: 'self',
      })
    ).subreddit[0].value;
    expect('flairLabel' in value).toBe(false);
    expect('flairRequired' in value).toBe(false);
  });

  it('works from null settings', () => {
    const next = applyResolvedRedditTarget(null, {
      subreddit: 'claudeai',
      title: 'T',
      type: 'self',
    });
    expect(JSON.parse(next).subreddit[0].value.subreddit).toBe('claudeai');
  });
});

describe('clearing without resolving', () => {
  it('drops the marker and leaves no subreddit behind', () => {
    const next = clearRedditTargetPending(parked());
    const parsed = JSON.parse(next);
    expect(parsed[REDDIT_TARGET_PENDING_KEY]).toBeUndefined();
    expect(parsed.subreddit).toBeUndefined();
    expect(parsed.__type).toBe('reddit');
  });
});

describe('the publish-due guard contract', () => {
  it('the serialized marker contains the exact key the SQL filter matches', () => {
    // PostsRepository excludes parked posts with a raw `contains` on the
    // quoted key, because `settings` is a JSON string column. If this ever
    // stops holding, parked posts silently enter the publish queue and are
    // re-offered forever.
    expect(parked()).toContain(`"${REDDIT_TARGET_PENDING_KEY}"`);
    const resolved = applyResolvedRedditTarget(parked(), {
      subreddit: 'claudeai',
      title: 'T',
      type: 'self',
    });
    expect(resolved).not.toContain(`"${REDDIT_TARGET_PENDING_KEY}"`);
  });
});
