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

  if (!redditProxy) {
    if (generalProxy) {
      setGlobalDispatcher(new ProxyAgent(generalProxy));
    }
    return;
  }

  // Fallback = general proxy if configured, otherwise a direct Agent
  // (equivalent to undici's default global dispatcher).
  const fallback: Dispatcher = generalProxy
    ? new ProxyAgent(generalProxy)
    : new Agent();

  setGlobalDispatcher(
    new OriginRoutingDispatcher(new ProxyAgent(redditProxy), fallback)
  );
}
