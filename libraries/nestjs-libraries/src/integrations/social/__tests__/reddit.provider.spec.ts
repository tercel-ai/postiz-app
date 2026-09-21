import 'reflect-metadata'; // reddit.dto.ts uses class-validator decorators
import { describe, it, expect, vi, afterEach } from 'vitest';
import { RedditProvider } from '../reddit.provider';
import { REDDIT_BROWSER_UA } from '@gitroom/nestjs-libraries/engage/reddit-loid';

// The provider now attaches a loid cookie to every Reddit call, and minting one
// is a REAL network request through npm undici's request() — which spying on
// globalThis.fetch does not intercept. Left unmocked, every test here would sit
// on a live reddit.com call until it timed out. The constant is re-exported from
// the real module so the UA assertions still check the production value.
const TEST_LOID = 'loid=test-loid-value';
vi.mock('@gitroom/nestjs-libraries/engage/reddit-loid', async () => {
  const actual = await vi.importActual<
    typeof import('@gitroom/nestjs-libraries/engage/reddit-loid')
  >('@gitroom/nestjs-libraries/engage/reddit-loid');
  return {
    ...actual,
    getRedditLoidCookie: vi.fn(async () => TEST_LOID),
  };
});

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

// Reddit's anti-bot layer sits in FRONT of authentication: measured on this
// deployment, the same authenticated request is refused with an Imperva page
// without a loid cookie and answered with JSON with one. So the loid is not an
// optimisation on the publish path — without it every publish, comment and
// analytics call is turned away before Reddit reads the Bearer header.
describe('RedditProvider — loid cookie', () => {
  afterEach(() => vi.restoreAllMocks());

  function headersOf(spy: ReturnType<typeof vi.spyOn>): Record<string, string> {
    return (spy.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
  }

  it('attaches the loid to Reddit requests', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));

    await new RedditProvider().fetch('https://oauth.reddit.com/api/submit', {
      method: 'POST',
      headers: { Authorization: 'Bearer t' },
    });

    expect(headersOf(spy)['Cookie']).toBe(TEST_LOID);
    // The caller's own headers survive.
    expect(headersOf(spy)['Authorization']).toBe('Bearer t');
  });

  it('does NOT send the loid to a non-Reddit host', async () => {
    // uploadFileToReddit finishes by PUTting to the storage URL Reddit hands
    // back. A cookie minted for reddit.com has no business reaching a third
    // party, so "attach it to every Reddit call" must not become "attach it
    // everywhere".
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));

    await new RedditProvider().fetch('https://s3.amazonaws.com/some-bucket/x');

    expect(headersOf(spy)['Cookie']).toBeUndefined();
  });

  it('is not fooled by a hostname that merely ends in the brand', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));

    await new RedditProvider().fetch('https://notreddit.com/api');

    expect(headersOf(spy)['Cookie']).toBeUndefined();
  });

  it('appends to a caller-supplied Cookie instead of replacing it', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));

    await new RedditProvider().fetch('https://oauth.reddit.com/api/v1/me', {
      headers: { Cookie: 'session=abc' },
    });

    expect(headersOf(spy)['Cookie']).toBe(`session=abc; ${TEST_LOID}`);
  });
});

// Reddit's user-authorized API needs app credentials this deployment may simply
// not have. The guard exists so a missing credential fails with its real reason
// instead of a request that Reddit rejects opaquely — and, for account
// connection, before the user is walked through an OAuth flow that cannot
// complete.
describe('RedditProvider — missing app credentials', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  function withoutCredentials() {
    vi.stubEnv('REDDIT_CLIENT_ID', '');
    vi.stubEnv('REDDIT_CLIENT_SECRET', '');
  }

  it('refuses to build an auth URL, without contacting Reddit', async () => {
    withoutCredentials();
    const spy = vi.spyOn(globalThis, 'fetch');

    await expect(new RedditProvider().generateAuthUrl()).rejects.toThrow(
      /REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET are not configured/
    );
    // The point of guarding here rather than downstream: no link is produced,
    // so nobody is sent to Reddit to be told nothing useful.
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses to exchange an auth code, without contacting Reddit', async () => {
    withoutCredentials();
    const spy = vi.spyOn(globalThis, 'fetch');

    await expect(
      new RedditProvider().authenticate({ code: 'c', codeVerifier: 'v' })
    ).rejects.toThrow(/not configured/);
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses to refresh a token, without contacting Reddit', async () => {
    withoutCredentials();
    const spy = vi.spyOn(globalThis, 'fetch');

    await expect(new RedditProvider().refreshToken('rt')).rejects.toThrow(
      /not configured/
    );
    // Previously this sent Basic auth over the literal "undefined:undefined".
    expect(spy).not.toHaveBeenCalled();
  });

  it('still allows a token-bearing request through — the guard is not a kill switch', async () => {
    // The guard covers only the calls that READ the credentials. Everything that
    // publishes (post/comment/postAnalytics) goes through provider.fetch with an
    // already-issued accessToken, so an integration connected while the
    // credentials WERE configured has to keep working. Asserting on fetch itself
    // rather than on one publishing method keeps this independent of any single
    // method's argument shape.
    withoutCredentials();
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));

    await new RedditProvider().fetch('https://oauth.reddit.com/api/v1/me', {
      headers: { Authorization: 'Bearer existing-access-token' },
    });

    expect(spy).toHaveBeenCalledOnce();
    expect(
      (spy.mock.calls[0][1] as RequestInit).headers as Record<string, string>
    ).toMatchObject({ Authorization: 'Bearer existing-access-token' });
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
