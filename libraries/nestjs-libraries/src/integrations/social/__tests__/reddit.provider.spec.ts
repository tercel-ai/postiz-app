import 'reflect-metadata'; // reddit.dto.ts uses class-validator decorators
import { describe, it, expect, vi, afterEach } from 'vitest';
import { RedditProvider } from '../reddit.provider';
import { REDDIT_BROWSER_UA } from '@gitroom/nestjs-libraries/engage/reddit-loid';

// Regression guard: Reddit blocks the undici default User-Agent ("node") with
// HTTP 403, so RedditProvider.fetch must inject one on every request — and it
// must be the BROWSER string shared with the loid path, not the script-shaped
// format Reddit's docs recommend. See the second test for why the two differ.
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

  it('sends a BROWSER UA, not the script-shaped one Reddit documents', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));

    const provider = new RedditProvider();
    await provider.fetch('https://www.reddit.com/api/v1/access_token', {
      method: 'POST',
    });

    const ua = headersOf(spy)['User-Agent'];

    // This assertion is the INVERSE of what it used to be, deliberately.
    // Reddit's docs (and its own block page) ask for
    // `<platform>:<app id>:<version> (by /u/<username>)`, and that was the
    // default here. It is the wrong trade for this deployment: it announces the
    // caller as a script and names an account, which is what anti-abuse scoring
    // keys on — and a flag on that one account takes every org's publishing with
    // it. Reddit serves this infrastructure a WAF page regardless of UA, so the
    // documented format buys nothing and costs attributable identification.
    expect(ua).not.toMatch(/^[^:]+:[^:]+:.+\(by \/u\/.+\)$/);
    expect(ua).toMatch(/^Mozilla\/5\.0 /);
  });

  it('shares ONE UA definition with the loid path', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));

    const provider = new RedditProvider();
    await provider.fetch('https://oauth.reddit.com/api/v1/me');

    // The publishing path and the read path must present this server the same
    // way. Two copies of the string would let them drift, and the difference
    // would only ever show up as one of them getting blocked.
    expect(headersOf(spy)['User-Agent']).toBe(REDDIT_BROWSER_UA);
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
