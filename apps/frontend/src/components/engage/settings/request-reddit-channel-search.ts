import { EXTENSION_MESSAGE } from '@gitroom/helpers/extension/brand';

/**
 * A community the user can add — the same shape the backend's search returns,
 * so the "Add" button that follows does not care which side answered.
 */
export interface RedditChannelResult {
  platform: 'reddit';
  channelId: string;
  channelName: string;
  audienceSize: number;
  metadata?: {
    description?: string;
    url?: string;
    avatar?: string | null;
  };
}

/**
 * Search Reddit communities through the browser extension.
 *
 * Only called when the BACKEND said it cannot: Reddit fronts its public JSON
 * with an anti-bot WAF, so the server reaches it only through a proxy whose
 * exit IP has to stay unblocked. When that route is down the extension can
 * still answer, because it reads Reddit as the user's own logged-in session.
 *
 * Rejects when no extension is installed — the caller distinguishes that from
 * "no results" so it can tell the user which of the two happened.
 */
export function requestRedditChannelSearch(
  query: string,
  timeoutMs = 30_000
): Promise<RedditChannelResult[]> {
  const requestId =
    globalThis.crypto?.randomUUID?.() ??
    `reddit-search-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      window.removeEventListener('message', onMessage);
      reject(
        new Error(
          'The browser extension did not answer. Install or enable it to search Reddit.'
        )
      );
    }, timeoutMs);

    const finish = () => {
      window.clearTimeout(timeout);
      window.removeEventListener('message', onMessage);
    };

    function onMessage(event: MessageEvent) {
      if (event.source !== window) return;
      if (event.origin !== window.location.origin) return;
      const data = event.data as {
        source?: string;
        action?: string;
        requestId?: string;
        ok?: boolean;
        results?: RedditChannelResult[];
        error?: string;
      };
      if (data?.source !== EXTENSION_MESSAGE.resultSource) return;
      if (data.action !== EXTENSION_MESSAGE.redditChannelSearchResult) return;
      if (data.requestId !== requestId) return;
      finish();
      if (!data.ok) {
        reject(new Error(data.error || 'The extension could not search Reddit'));
        return;
      }
      resolve(data.results ?? []);
    }

    window.addEventListener('message', onMessage);
    window.postMessage(
      {
        source: EXTENSION_MESSAGE.source,
        action: EXTENSION_MESSAGE.redditChannelSearch,
        requestId,
        query,
      },
      window.location.origin
    );
  });
}
