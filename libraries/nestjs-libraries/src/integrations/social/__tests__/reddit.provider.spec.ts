import 'reflect-metadata'; // reddit.dto.ts uses class-validator decorators
import { describe, it, expect, vi, afterEach } from 'vitest';
import { RedditProvider } from '../reddit.provider';

// Regression guard: Reddit blocks the undici default User-Agent ("node") with
// HTTP 403. RedditProvider.fetch must inject a descriptive UA on every request.
describe('RedditProvider — User-Agent injection', () => {
  afterEach(() => vi.restoreAllMocks());

  function headersOf(spy: ReturnType<typeof vi.spyOn>): Record<string, string> {
    return (spy.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
  }

  it('injects a descriptive User-Agent and preserves caller headers', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));

    const provider = new RedditProvider();
    await provider.fetch('https://oauth.reddit.com/api/v1/me', {
      headers: { Authorization: 'Bearer token' },
    });

    expect(spy).toHaveBeenCalledOnce();
    const headers = headersOf(spy);
    expect(headers['User-Agent']).toBeTruthy();
    expect(headers['User-Agent']).not.toBe('node'); // the blocked undici default
    expect(headers['Authorization']).toBe('Bearer token');
  });

  it('uses a Reddit-compliant UA format on requests with no headers', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));

    const provider = new RedditProvider();
    await provider.fetch('https://www.reddit.com/api/v1/access_token', {
      method: 'POST',
    });

    // Format: <platform>:<app id>:<version> (by /u/<username>)
    expect(headersOf(spy)['User-Agent']).toMatch(/^[^:]+:[^:]+:.+\(by \/u\/.+\)$/);
  });
});

// Regression guard: engage.service.ts's scheduled/immediate reply flow used to
// pass Reddit opportunities through with X's settings shape, which post()'s
// subreddit-submission path can't read (no `subreddit` field) — it would throw
// deep in a Temporal activity. `settings.replyToId` routes to Reddit's own
// comment API instead, entirely bypassing the subreddit-submission path.
describe('RedditProvider.post — reply mode (replyToId)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('posts a comment via /api/comment when replyToId is set, skipping subreddit submission', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          json: {
            data: {
              things: [
                { data: { id: 'abc', permalink: '/r/test/comments/xyz/_/abc/' } },
              ],
            },
          },
        }),
        { status: 200 }
      )
    );

    const provider = new RedditProvider();
    const result = await provider.post('int-1', 'token-1', [
      { id: 'post-1', message: 'hello reply', settings: { replyToId: 'xyz' } } as any,
    ]);

    expect(spy).toHaveBeenCalledOnce();
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe('https://oauth.reddit.com/api/comment');
    const body = (init as RequestInit).body as URLSearchParams;
    expect(body.get('thing_id')).toBe('t3_xyz'); // bare id gets the t3_ prefix added
    expect(body.get('text')).toBe('hello reply');

    expect(result).toEqual([
      {
        postId: 'abc',
        releaseURL: 'https://www.reddit.com/r/test/comments/xyz/_/abc/',
        id: 'post-1',
        status: 'published',
      },
    ]);
  });

  it('does not re-prefix a replyToId that already carries a t1_/t3_ fullname', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          json: { data: { things: [{ data: { id: 'abc', permalink: '/p' } }] } },
        }),
        { status: 200 }
      )
    );

    const provider = new RedditProvider();
    await provider.post('int-1', 'token-1', [
      { id: 'post-1', message: 'hi', settings: { replyToId: 't1_xyz' } } as any,
    ]);

    const body = (spy.mock.calls[0][1] as RequestInit).body as URLSearchParams;
    expect(body.get('thing_id')).toBe('t1_xyz');
  });

  it('throws a clear error when Reddit rejects the reply', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          json: { errors: [['RATELIMIT', 'you are doing that too much', 'ratelimit']] },
        }),
        { status: 200 }
      )
    );

    const provider = new RedditProvider();
    await expect(
      provider.post('int-1', 'token-1', [
        { id: 'post-1', message: 'hi', settings: { replyToId: 'xyz' } } as any,
      ])
    ).rejects.toThrow(/Reddit rejected reply to t3_xyz/);
  });
});
