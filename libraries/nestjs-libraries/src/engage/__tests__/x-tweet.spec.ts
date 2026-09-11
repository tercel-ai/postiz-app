import { afterEach, describe, it, expect, vi } from 'vitest';
import { fetchXAuthorProfile, parseXTweetId } from '../x-tweet';

describe('parseXTweetId', () => {
  it.each([
    ['https://x.com/u/status/2061267353544146949?s=20', '2061267353544146949'],
    ['https://x.com/u/status/2061267353544146949', '2061267353544146949'],
    ['https://twitter.com/u/status/123?s=20&t=abc', '123'],
    ['https://mobile.twitter.com/u/status/456/', '456'],
    ['https://x.com/i/web/status/789', '789'],
    ['  x.com/u/status/321 ', '321'],
    ['https://x.com/u/statuses/999', '999'],
  ])('extracts the id from %s', (url, expected) => {
    expect(parseXTweetId(url)).toBe(expected);
  });

  it.each([
    'https://x.com/zhngyq310334',
    'https://x.com',
    'not a url',
    '',
    null,
    undefined,
  ])('returns null when there is no /status/<id>: %s', (url) => {
    expect(parseXTweetId(url as string)).toBeNull();
  });
});

describe('fetchXAuthorProfile — server X reads are gated', () => {
  const savedApi = process.env.X_API_ENABLED;
  const savedBearer = process.env.X_BEARER_TOKEN;
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (savedApi === undefined) delete process.env.X_API_ENABLED;
    else process.env.X_API_ENABLED = savedApi;
    if (savedBearer === undefined) delete process.env.X_BEARER_TOKEN;
    else process.env.X_BEARER_TOKEN = savedBearer;
  });

  it('makes NO network call and returns handle-only when the gate is off', async () => {
    delete process.env.X_API_ENABLED;
    process.env.X_BEARER_TOKEN = 'bearer-that-must-not-be-used';
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as any;

    await expect(
      fetchXAuthorProfile('https://x.com/someone/status/123')
    ).resolves.toEqual({ handle: 'someone' });

    // Same degraded shape the no-bearer path already returns — the caller stores
    // engageAuthor either way, so gating costs an avatar, never a failure.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('still parses nothing out of a non-status url while gated', async () => {
    delete process.env.X_API_ENABLED;
    await expect(fetchXAuthorProfile('https://x.com')).resolves.toBeNull();
  });

  it('reaches the API once the gate is explicitly opened', async () => {
    process.env.X_API_ENABLED = 'true';
    process.env.X_BEARER_TOKEN = 'bearer';
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: { id: '7', name: 'Some One', profile_image_url: 'http://img/a.jpg' },
      }),
    });
    globalThis.fetch = fetchSpy as any;

    const out = await fetchXAuthorProfile('https://x.com/someone/status/123');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ handle: 'someone', id: '7', name: 'Some One' });
  });
});
