import { describe, it, expect, vi, beforeEach } from 'vitest';

const backendCall = vi.fn();
vi.mock('@gitroom/extension/utils/executor/api', () => ({
  backendCall: (...args: unknown[]) => backendCall(...args),
  NotAuthenticatedError: class NotAuthenticatedError extends Error {},
}));

import { reportRedditCapability } from '../reddit-capability';

const body = () => backendCall.mock.calls[0][2] as Record<string, unknown>;

describe('reportRedditCapability', () => {
  beforeEach(() => {
    backendCall.mockReset();
    backendCall.mockResolvedValue({ ok: true, status: 200, data: {} });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it('posts the observation to the capability endpoint', async () => {
    expect(
      await reportRedditCapability({ subreddit: 'football', flairs: ['📰News'] })
    ).toBe(true);
    expect(backendCall).toHaveBeenCalledWith(
      '/engage/monitored-channels/reddit/capability',
      'POST',
      { subreddit: 'football', flairs: [{ label: '📰News' }] }
    );
  });

  // The regression this file exists for. The server treats a present boolean as
  // authoritative, so an unobserved `false` erases a `true` learned from a real
  // rejection. redditPostRuleFromErrors returns a required boolean per rule, so
  // the rule Reddit did NOT cite arrives here as `false`.
  it('never forwards a false rule, even when a caller supplies one', async () => {
    await reportRedditCapability({
      subreddit: 'machinelearning',
      flairs: ['Research'],
      // Deliberately bypassing the `?: true` type — this mirrors an untyped or
      // future caller, which is why the runtime guard exists alongside the type.
      flairRequired: false as unknown as true,
      titleTagRequired: true,
    });
    expect(body()).not.toHaveProperty('flairRequired');
    expect(body().titleTagRequired).toBe(true);
  });

  it('forwards a rule that was actually cited', async () => {
    await reportRedditCapability({ subreddit: 'football', flairRequired: true });
    expect(body()).toMatchObject({ subreddit: 'football', flairRequired: true });
  });

  it('makes no request when nothing was observed', async () => {
    expect(await reportRedditCapability({ subreddit: 'football' })).toBe(false);
    expect(
      await reportRedditCapability({
        subreddit: 'football',
        flairs: ['', '   '],
        flairRequired: false as unknown as true,
      })
    ).toBe(false);
    expect(await reportRedditCapability({ subreddit: '  ', flairRequired: true })).toBe(
      false
    );
    expect(backendCall).not.toHaveBeenCalled();
  });

  // class-validator rejects the WHOLE body on one over-length label, so an
  // unclamped label would cost the entire snapshot rather than just itself.
  it('clamps labels to the server limits by length and by count', async () => {
    await reportRedditCapability({
      subreddit: 'football',
      flairs: [' x '.repeat(200), ...Array.from({ length: 150 }, (_, i) => `f${i}`)],
    });
    const flairs = body().flairs as { label: string }[];
    expect(flairs).toHaveLength(100);
    expect(flairs[0].label.length).toBe(128);
  });

  // Every call site `void`s this, so a rejection would be an unhandled promise
  // rejection in an MV3 service worker.
  it('resolves false instead of throwing when the backend call fails', async () => {
    backendCall.mockRejectedValueOnce(new Error('not authenticated'));
    await expect(
      reportRedditCapability({ subreddit: 'football', flairRequired: true })
    ).resolves.toBe(false);
  });

  it('resolves false and logs the backend reason on a non-2xx', async () => {
    backendCall.mockResolvedValueOnce({
      ok: false,
      status: 400,
      data: { message: ['flairs.0.label must be shorter than 128 characters'] },
    });
    expect(
      await reportRedditCapability({ subreddit: 'football', flairRequired: true })
    ).toBe(false);
    expect(console.warn).toHaveBeenCalledWith(
      '[aisee][reddit] capability report rejected',
      expect.objectContaining({ status: 400, reason: expect.anything() })
    );
  });
});
