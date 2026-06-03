import { describe, it, expect, vi, beforeEach } from 'vitest';

// Force the public path (no app token) so the check goes through redditPublicGet,
// which we mock. reddit-auth.getRedditToken → null.
vi.mock('../reddit-auth', () => ({
  getRedditToken: vi.fn(async () => null),
  redditAuthHeaders: vi.fn(() => ({})),
}));

const redditPublicGet = vi.fn();
vi.mock('../reddit-loid', () => ({
  redditPublicGet: (...args: unknown[]) => redditPublicGet(...args),
}));

import { checkRedditCommentAccessible } from '../reddit-comment';

const VALID_URL =
  'https://www.reddit.com/r/OpenAI/comments/abc123/some_title/def456';

function publicResponse(ok: boolean, status: number, body: string) {
  return { ok, status, text: async () => body };
}

describe('checkRedditCommentAccessible', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns "exists" when /api/info returns the comment', async () => {
    redditPublicGet.mockResolvedValue(
      publicResponse(true, 200, JSON.stringify({ data: { children: [{ data: { id: 't1_def456' } }] } }))
    );
    const r = await checkRedditCommentAccessible(VALID_URL);
    expect(r).toEqual({ status: 'exists' });
    // It queried /api/info for the trailing comment id.
    expect(redditPublicGet.mock.calls[0][0]).toContain('id=t1_def456');
  });

  it('accepts Reddit share URLs with query parameters', async () => {
    redditPublicGet.mockResolvedValue(
      publicResponse(true, 200, JSON.stringify({ data: { children: [{ data: { id: 't1_opg17xr' } }] } }))
    );
    const r = await checkRedditCommentAccessible(
      'https://www.reddit.com/r/SEO/comments/1skxs73/comment/opg17xr/?utm_source=share&utm_medium=web3x'
    );
    expect(r).toEqual({ status: 'exists' });
    expect(redditPublicGet.mock.calls[0][0]).toContain('id=t1_opg17xr');
  });

  it('returns "not_found" when the comment resolves to no thing (empty children)', async () => {
    redditPublicGet.mockResolvedValue(
      publicResponse(true, 200, JSON.stringify({ data: { children: [] } }))
    );
    const r = await checkRedditCommentAccessible(VALID_URL);
    expect(r).toEqual({ status: 'not_found' });
  });

  it('returns "not_found" when the URL has no parseable comment id', async () => {
    const r = await checkRedditCommentAccessible('https://www.reddit.com/r/OpenAI/');
    expect(r).toEqual({ status: 'not_found' });
    expect(redditPublicGet).not.toHaveBeenCalled();
  });

  it('returns "unverifiable" on a non-2xx (e.g. WAF 403)', async () => {
    redditPublicGet.mockResolvedValue(publicResponse(false, 403, ''));
    const r = await checkRedditCommentAccessible(VALID_URL);
    expect(r).toEqual({ status: 'unverifiable', reason: 'HTTP 403' });
  });

  it('returns "unverifiable" when the fetch throws (network/timeout)', async () => {
    redditPublicGet.mockRejectedValue(new Error('connect ETIMEDOUT'));
    const r = await checkRedditCommentAccessible(VALID_URL);
    expect(r.status).toBe('unverifiable');
    expect((r as any).reason).toContain('ETIMEDOUT');
  });

  it('returns "unverifiable" on an unparseable body', async () => {
    redditPublicGet.mockResolvedValue(publicResponse(true, 200, '<html>blocked</html>'));
    const r = await checkRedditCommentAccessible(VALID_URL);
    expect(r).toEqual({ status: 'unverifiable', reason: 'unparseable response' });
  });
});
