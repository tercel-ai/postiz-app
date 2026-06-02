import { Agent, Dispatcher, ProxyAgent, setGlobalDispatcher } from 'undici';

/** True when the request origin's host is reddit.com or a subdomain of it. */
function isRedditOrigin(origin: Dispatcher.DispatchOptions['origin']): boolean {
  if (!origin) return false;
  // origin is a string or URL; new URL() accepts both.
  let host: string;
  try {
    host = new URL(origin as string | URL).hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === 'reddit.com' || host.endsWith('.reddit.com');
}

/** Connection-level error codes that mean the proxy itself was unreachable. */
const CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'ECONNRESET',
  'EAI_AGAIN',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/** True when an error indicates the proxy could not be reached (vs. an HTTP error). */
function isConnectionError(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string }; message?: string };
  const code = e?.code ?? e?.cause?.code;
  if (code && CONNECTION_ERROR_CODES.has(code)) return true;
  return /connect|tunnel|proxy|socket|ECONNREFUSED/i.test(e?.message ?? '');
}

/**
 * Wraps a primary dispatcher (a proxy) with a direct-connection fallback.
 *
 * If the primary fails with a connection-level error BEFORE any response byte is
 * delivered — the proxy is unreachable (ECONNREFUSED), times out, or the tunnel
 * errors — the request is transparently retried on the direct dispatcher. Once a
 * response has started (onHeaders/onData), the error is propagated as-is.
 *
 * IMPORTANT: only requests WITHOUT a body are retried. `fetch` wraps a request
 * body into a single-use object that cannot be re-dispatched, so POST/PUT bodies
 * would corrupt on replay. Body-bearing Reddit calls (only the loid mint) handle
 * their own proxy→direct fallback at the application layer (reddit-loid.ts).
 *
 * Why: Reddit data fetching works through a clean proxy, but if that proxy dies
 * the feature should degrade to a direct connection (which still works thanks to
 * the loid cookie) rather than failing every request.
 */
export class ProxyFallbackDispatcher extends Dispatcher {
  constructor(
    private readonly primary: Dispatcher,
    private readonly direct: Dispatcher,
    private readonly label = 'reddit'
  ) {
    super();
  }

  dispatch(
    opts: Dispatcher.DispatchOptions,
    handler: Dispatcher.DispatchHandler
  ): boolean {
    const canRetry = opts.body == null; // only no-body requests are replayable

    let started = false;
    let fellBack = false;

    const markStarted =
      (fn: ((...a: unknown[]) => unknown) | undefined) =>
      (...args: unknown[]): unknown => {
        started = true;
        return fn ? (fn as (...a: unknown[]) => unknown).apply(handler, args) : undefined;
      };

    const wrapped: Dispatcher.DispatchHandler = {
      onConnect: (...a: unknown[]) =>
        (handler.onConnect as ((...x: unknown[]) => void) | undefined)?.(...a),
      onHeaders: markStarted(handler.onHeaders as never) as never,
      onData: markStarted(handler.onData as never) as never,
      onUpgrade: markStarted(handler.onUpgrade as never) as never,
      onResponseStarted: markStarted(
        (handler as { onResponseStarted?: (...a: unknown[]) => unknown }).onResponseStarted
      ) as never,
      onComplete: (...a: unknown[]) =>
        (handler.onComplete as ((...x: unknown[]) => void) | undefined)?.(...a),
      onBodySent: (...a: unknown[]) =>
        (handler.onBodySent as ((...x: unknown[]) => void) | undefined)?.(...a),
      onError: (err: Error) => {
        if (!started && !fellBack && canRetry && isConnectionError(err)) {
          fellBack = true;
          console.warn(
            `[dispatcher] ${this.label} proxy unreachable (${(err as { code?: string })?.code ?? err?.message}); falling back to direct connection`
          );
          try {
            this.direct.dispatch(opts, handler);
            return;
          } catch (e) {
            handler.onError?.(e as Error);
            return;
          }
        }
        handler.onError?.(err);
      },
    } as Dispatcher.DispatchHandler;

    return this.primary.dispatch(opts, wrapped);
  }
}

/**
 * Per-origin routing dispatcher.
 *
 * Requests to *.reddit.com are sent through a dedicated proxy (REDDIT_PROXY);
 * every other request uses the general dispatcher (HTTPS_PROXY/HTTP_PROXY or a
 * direct connection).
 *
 * Why: Reddit's API IP-blocks data-center and commercial-VPN exit IPs. A
 * general proxy (e.g. a China-side Clash node) cannot reach Reddit, while a
 * clean server/residential IP can. Routing only Reddit traffic through the
 * clean proxy avoids forcing all outbound traffic through it.
 */
export class OriginRoutingDispatcher extends Dispatcher {
  constructor(
    private readonly redditDispatcher: Dispatcher,
    private readonly fallback: Dispatcher
  ) {
    super();
  }

  dispatch(
    opts: Dispatcher.DispatchOptions,
    handler: Dispatcher.DispatchHandler
  ): boolean {
    const target = isRedditOrigin(opts.origin)
      ? this.redditDispatcher
      : this.fallback;
    return target.dispatch(opts, handler);
  }

  // close()/destroy() are intentionally not overridden: this dispatcher is a
  // process-lifetime singleton, so the underlying agents are released when the
  // process exits. Delegating here would mean matching undici's overloaded
  // callback/promise signatures for no practical gain.
}

/**
 * Installs the global undici dispatcher based on env vars. Call once at process
 * startup (before any outbound fetch).
 *
 *   HTTPS_PROXY / HTTP_PROXY  general proxy for all non-Reddit traffic
 *   REDDIT_PROXY              dedicated proxy for *.reddit.com only
 *
 * Behaviour:
 *   - neither set  → leave undici default (direct connections)
 *   - only general → single global ProxyAgent (legacy behaviour)
 *   - REDDIT_PROXY → origin-routing dispatcher (reddit → REDDIT_PROXY, rest → general/direct)
 */
export function setupHttpDispatcher(): void {
  const generalProxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  const redditProxy = process.env.REDDIT_PROXY;

  const hasGeneral = !!generalProxy;
  const hasReddit = !!redditProxy;
  console.log(
    `[setupHttpDispatcher] generalProxy=${hasGeneral ? '(set)' : '(none)'} redditProxy=${hasReddit ? '(set)' : '(none)'}`
  );

  if (!redditProxy) {
    if (generalProxy) {
      setGlobalDispatcher(new ProxyAgent(generalProxy));
      console.log('[setupHttpDispatcher] global dispatcher → ProxyAgent (general)');
    }
    return;
  }

  // Routing fallback (for NON-reddit traffic): general proxy if configured,
  // otherwise a direct Agent (equivalent to undici's default global dispatcher).
  const direct = new Agent();
  const routingFallback: Dispatcher = generalProxy
    ? new ProxyAgent(generalProxy)
    : direct;

  // Reddit traffic goes through REDDIT_PROXY, but degrades to a direct
  // connection if that proxy is unreachable (the loid cookie keeps direct
  // working). This keeps Reddit discovery alive when the proxy dies instead of
  // failing every request.
  const redditDispatcher = new ProxyFallbackDispatcher(
    new ProxyAgent(redditProxy),
    direct,
    'reddit'
  );

  setGlobalDispatcher(
    new OriginRoutingDispatcher(redditDispatcher, routingFallback)
  );
  console.log(
    '[setupHttpDispatcher] global dispatcher → OriginRouting (reddit→proxy+direct-fallback, rest→' +
      (generalProxy ? 'general-proxy' : 'direct') +
      ')'
  );
}
