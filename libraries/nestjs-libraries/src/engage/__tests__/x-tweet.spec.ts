import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { checkXTweetAccessible } from '../x-tweet';

const VALID_URL = 'https://x.com/someone/status/1759999999999999999';

const fetchMock = vi.fn();

describe('checkXTweetAccessible', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    process.env.X_BEARER_TOKEN = 'test-bearer';
  });
  afterEach(() => vi.unstubAllGlobals());

  const res = (status: number, json: unknown, ok = status >= 200 && status < 300) => ({
    ok,
    status,
    json: async () => json,
  });

  it('returns "exists" when the tweet lookup returns data', async () => {
    fetchMock.mockResolvedValue(res(200, { data: { id: '1759999999999999999' } }));
    const r = await checkXTweetAccessible(VALID_URL);
    expect(r).toEqual({ status: 'exists' });
    expect(fetchMock.mock.calls[0][0]).toContain('/2/tweets/1759999999999999999');
  });

  it('returns "not_found" when the body carries only errors (deleted/missing)', async () => {
    fetchMock.mockResolvedValue(res(200, { errors: [{ title: 'Not Found Error' }] }));
    expect(await checkXTweetAccessible(VALID_URL)).toEqual({ status: 'not_found' });
  });

  it('returns "not_found" on a 404', async () => {
    fetchMock.mockResolvedValue(res(404, {}, false));
    expect(await checkXTweetAccessible(VALID_URL)).toEqual({ status: 'not_found' });
  });

  it('returns "not_found" when the URL has no /status/<id>', async () => {
    expect(await checkXTweetAccessible('https://x.com/someone')).toEqual({ status: 'not_found' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns "unverifiable" when no bearer token is configured', async () => {
    delete process.env.X_BEARER_TOKEN;
    const r = await checkXTweetAccessible(VALID_URL);
    expect(r).toEqual({ status: 'unverifiable', reason: 'X bearer token not configured' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns "unverifiable" on a 5xx / rate limit', async () => {
    fetchMock.mockResolvedValue(res(503, {}, false));
    expect(await checkXTweetAccessible(VALID_URL)).toEqual({ status: 'unverifiable', reason: 'HTTP 503' });
  });

  it('returns "unverifiable" when the fetch throws', async () => {
    fetchMock.mockRejectedValue(new Error('connect ETIMEDOUT'));
    const r = await checkXTweetAccessible(VALID_URL);
    expect(r.status).toBe('unverifiable');
    expect((r as any).reason).toContain('ETIMEDOUT');
  });

  it('returns "unverifiable" when the body is unparseable', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('invalid json');
      },
    });
    expect(await checkXTweetAccessible(VALID_URL)).toEqual({ status: 'unverifiable', reason: 'unparseable response' });
  });
});
