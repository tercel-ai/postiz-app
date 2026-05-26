import { describe, it, expect, vi } from 'vitest';
import type { Dispatcher } from 'undici';
import { OriginRoutingDispatcher } from '../setup-dispatcher';

function fakeDispatcher() {
  const dispatch = vi.fn().mockReturnValue(true);
  return { dispatcher: { dispatch } as unknown as Dispatcher, dispatch };
}

describe('OriginRoutingDispatcher', () => {
  const handler = {} as Dispatcher.DispatchHandler;

  it('routes *.reddit.com to the reddit dispatcher', () => {
    const reddit = fakeDispatcher();
    const fallback = fakeDispatcher();
    const router = new OriginRoutingDispatcher(
      reddit.dispatcher,
      fallback.dispatcher
    );

    for (const origin of [
      'https://www.reddit.com',
      'https://oauth.reddit.com',
      new URL('https://www.reddit.com/api/v1/access_token'),
    ]) {
      router.dispatch({ origin, path: '/', method: 'GET' }, handler);
    }

    expect(reddit.dispatch).toHaveBeenCalledTimes(3);
    expect(fallback.dispatch).not.toHaveBeenCalled();
  });

  it('routes every other origin to the fallback dispatcher', () => {
    const reddit = fakeDispatcher();
    const fallback = fakeDispatcher();
    const router = new OriginRoutingDispatcher(
      reddit.dispatcher,
      fallback.dispatcher
    );

    for (const origin of [
      'https://api.twitter.com',
      'https://reddit.com.evil.example', // spoofed suffix — must NOT route to reddit
      new URL('https://example.com/x'),
    ]) {
      router.dispatch({ origin, path: '/', method: 'GET' }, handler);
    }

    expect(reddit.dispatch).not.toHaveBeenCalled();
    expect(fallback.dispatch).toHaveBeenCalledTimes(3);
  });

  it('returns the underlying dispatch result', () => {
    const reddit = fakeDispatcher();
    const fallback = fakeDispatcher();
    fallback.dispatch.mockReturnValue(false);
    const router = new OriginRoutingDispatcher(
      reddit.dispatcher,
      fallback.dispatcher
    );

    const result = router.dispatch(
      { origin: 'https://example.com', path: '/', method: 'GET' },
      handler
    );
    expect(result).toBe(false);
  });
});
