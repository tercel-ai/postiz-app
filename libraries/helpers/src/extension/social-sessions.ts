// Page-side helper + shared types for the `aisee:social-sessions` bridge: the
// web app asks the extension which social platforms the BROWSER is currently
// logged into, and gets back whatever identity the platform session exposes.
//
// What each platform can reveal (browser session only, no platform API keys):
//   - Reddit: /api/me.json → handle, t2_* id, display name, avatar. No email —
//     Reddit never exposes it to this endpoint.
//   - X: session cookies only (`auth_token` presence = logged in, `twid` =
//     numeric user id). No username/email — resolving them would require X
//     GraphQL calls from the service worker, which is forbidden (account-risk:
//     X data collection must go through a real browser tab).
//
// Both sides import these types: the extension SW builds `SocialSessions`, the
// web app consumes it, so the payload shape can never drift.

import { EXTENSION_MESSAGE } from './brand';

export interface XSessionInfo {
  loggedIn: boolean;
  /** Numeric X user id decoded from the `twid` cookie (e.g. "1234567890"). */
  userId?: string;
}

export interface RedditSessionInfo {
  loggedIn: boolean;
  /** Reddit username (without the u/ prefix). */
  handle?: string;
  /** Fullname id, e.g. "t2_abc123". */
  id?: string;
  /** Display name (profile title), falls back to the handle. */
  name?: string;
  avatarUrl?: string;
}

export interface SocialSessions {
  x: XSessionInfo;
  reddit: RedditSessionInfo;
}

/**
 * Ask the extension (via the bridge content script) for the browser's current
 * social platform sessions. Rejects when the extension is not installed / the
 * bridge is not active on this origin (timeout) or the snapshot fails.
 */
export function requestSocialSessions(
  timeoutMs = 10_000
): Promise<SocialSessions> {
  const requestId =
    globalThis.crypto?.randomUUID?.() ??
    `social-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      window.removeEventListener('message', onMessage);
      reject(
        new Error('The extension did not answer the social-sessions probe')
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
        sessions?: SocialSessions;
        error?: string;
      };
      if (data?.source !== EXTENSION_MESSAGE.resultSource) return;
      if (data.action !== EXTENSION_MESSAGE.socialSessionsResult) return;
      if (data.requestId !== requestId) return;
      finish();
      if (!data.ok || !data.sessions) {
        reject(
          new Error(data.error || 'The extension could not read the sessions')
        );
        return;
      }
      resolve(data.sessions);
    }

    window.addEventListener('message', onMessage);
    window.postMessage(
      {
        source: EXTENSION_MESSAGE.source,
        action: EXTENSION_MESSAGE.socialSessions,
        requestId,
      },
      window.location.origin
    );
  });
}
