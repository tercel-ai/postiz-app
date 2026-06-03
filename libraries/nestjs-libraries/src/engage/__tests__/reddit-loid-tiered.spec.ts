/**
 * Unit tests for redditPublicGet's tiered proxy strategy. Uses fake undici
 * dispatchers (no network) and a stub header builder so the loid mint is not hit.
 */
import { describe, it, expect } from 'vitest';
import { Dispatcher } from 'undici';
import { redditPublicGet } from '../reddit-loid';

type Plan = (call: number) => { status: number; body?: string } | 'throw' | 'throw-proxy';

class FakeDispatcher extends Dispatcher {
  public calls = 0;
  constructor(private readonly plan: Plan) {
    super();
  }
  dispatch(_opts: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    const call = ++this.calls;
    const r = this.plan(call);
    queueMicrotask(() => {
      const h = handler as Record<string, (...a: unknown[]) => unknown>;
      if (r === 'throw') {
        const e = new Error('connect ECONNREFUSED 1.2.3.4:15127') as Error & { code?: string };
        e.code = 'ECONNREFUSED';
        h.onError?.(e);
        return;
      }
      if (r === 'throw-proxy') {
        // undici ProxyAgent's 407 rejection: a plain Error, no stable code.
        h.onError?.(new Error('Proxy response (407) !== 200 when HTTP Tunneling'));
        return;
      }
      try {
        h.onConnect?.(() => undefined);
        h.onHeaders?.(r.status, [], () => true, String(r.status));
        if (r.body) h.onData?.(Buffer.from(r.body));
        h.onComplete?.([]);
      } catch (e) {
        h.onError?.(e as Error);
      }
    });
    return true;
  }
}

const MAX_ATTEMPTS = 3; // injected so the test is independent of env defaults
const deps = (proxy: FakeDispatcher | null, direct: FakeDispatcher) => ({
  proxy,
  direct: direct as unknown as Dispatcher,
  buildHeaders: async () => ({}),
  log: () => undefined,
  maxAttempts: MAX_ATTEMPTS,
  backoffMs: 0,
});

describe('redditPublicGet — tiered proxy strategy', () => {
  it('returns immediately when the proxy succeeds (no fallback)', async () => {
    const proxy = new FakeDispatcher(() => ({ status: 200, body: 'ok' }));
    const direct = new FakeDispatcher(() => ({ status: 200, body: 'direct' }));
    const res = await redditPublicGet('https://www.reddit.com/x.json', {}, deps(proxy, direct));
    expect(res.status).toBe(200);
    expect(res.viaDirect).toBe(false);
    expect(await res.text()).toBe('ok');
    expect(proxy.calls).toBe(1);
    expect(direct.calls).toBe(0);
  });

  it('tier 2: rotates IP through the proxy on 403, succeeds on a later attempt', async () => {
    // 403, 403, then 200 — simulates landing on a clean exit IP on attempt 3.
    const proxy = new FakeDispatcher((c) => (c < 3 ? { status: 403, body: 'blocked' } : { status: 200, body: 'ok' }));
    const direct = new FakeDispatcher(() => ({ status: 200, body: 'direct' }));
    const res = await redditPublicGet('https://www.reddit.com/x.json', {}, deps(proxy, direct));
    expect(res.status).toBe(200);
    expect(res.viaDirect).toBe(false);
    expect(proxy.calls).toBe(3);
    expect(direct.calls).toBe(0);
  });

  it('tier 3: all proxy attempts blocked → falls back to direct', async () => {
    const proxy = new FakeDispatcher(() => ({ status: 403, body: 'blocked' }));
    const direct = new FakeDispatcher(() => ({ status: 200, body: 'direct-ok' }));
    const res = await redditPublicGet('https://www.reddit.com/x.json', {}, deps(proxy, direct));
    expect(res.status).toBe(200);
    expect(res.viaDirect).toBe(true);
    expect(await res.text()).toBe('direct-ok');
    expect(proxy.calls).toBe(MAX_ATTEMPTS); // exhausted all proxy attempts
    expect(direct.calls).toBe(1);
  });

  it('tier 1: proxy unreachable (connection error) → direct immediately, no proxy retries', async () => {
    const proxy = new FakeDispatcher(() => 'throw');
    const direct = new FakeDispatcher(() => ({ status: 200, body: 'direct-ok' }));
    const res = await redditPublicGet('https://www.reddit.com/x.json', {}, deps(proxy, direct));
    expect(res.status).toBe(200);
    expect(res.viaDirect).toBe(true);
    expect(proxy.calls).toBe(1); // stopped retrying the dead proxy
    expect(direct.calls).toBe(1);
  });

  it('tier 1: proxy 407 (CONNECT tunnel rejected) → direct immediately, no proxy retries', async () => {
    const proxy = new FakeDispatcher(() => 'throw-proxy');
    const direct = new FakeDispatcher(() => ({ status: 200, body: 'direct-ok' }));
    const res = await redditPublicGet('https://www.reddit.com/x.json', {}, deps(proxy, direct));
    expect(res.status).toBe(200);
    expect(res.viaDirect).toBe(true);
    expect(await res.text()).toBe('direct-ok');
    expect(proxy.calls).toBe(1); // did NOT keep retrying the auth-failing proxy
    expect(direct.calls).toBe(1);
  });

  it('uses the proxy first by default when a proxy is configured', async () => {
    const proxy = new FakeDispatcher(() => ({ status: 200, body: 'proxy-ok' }));
    const direct = new FakeDispatcher(() => ({ status: 200, body: 'direct-ok' }));
    const res = await redditPublicGet('https://www.reddit.com/x.json', {}, deps(proxy, direct));
    expect(res.status).toBe(200);
    expect(res.viaDirect).toBe(false);
    expect(await res.text()).toBe('proxy-ok');
    expect(proxy.calls).toBe(1);
    expect(direct.calls).toBe(0);
  });

  it('passes through a non-block error status (e.g. 404) without rotating or falling back', async () => {
    const proxy = new FakeDispatcher(() => ({ status: 404, body: 'not found' }));
    const direct = new FakeDispatcher(() => ({ status: 200, body: 'direct' }));
    const res = await redditPublicGet('https://www.reddit.com/x.json', {}, deps(proxy, direct));
    expect(res.status).toBe(404);
    expect(res.viaDirect).toBe(false);
    expect(proxy.calls).toBe(1);
    expect(direct.calls).toBe(0);
  });

  it('no proxy configured → single direct request', async () => {
    const direct = new FakeDispatcher(() => ({ status: 200, body: 'direct-only' }));
    const res = await redditPublicGet('https://www.reddit.com/x.json', {}, deps(null, direct));
    expect(res.status).toBe(200);
    expect(res.viaDirect).toBe(true);
    expect(direct.calls).toBe(1);
  });
});
