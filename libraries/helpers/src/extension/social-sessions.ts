// Page-side helper + shared types for the `aisee:social-sessions` bridge: the
// web app asks the extension which social platforms the BROWSER is currently
// logged into, and who the account is.
//
// How each platform is probed:
//   - X: cookies decide loggedIn/userId; the handle/name/avatar come from a
//     real BROWSER TAB (background x.com page, DOM read of X's own nav) —
//     never an X API call. Cached per account (twid), so the tab read happens
//     once per login/account-switch; the first probe after a login can take a
//     few seconds while that tab loads.
//   - Reddit: cookie decides loggedIn; identity from the session /api/me.json
//     read the reply poster already uses (10-min cache).
//   - aisee (our own platform): the extension's current session (explicit
//     extension login OR bridged from a logged-in frontend tab) — this one
//     DOES carry id/email/username, since it is our own auth.
// Emails for X/Reddit are never exposed to the browser session — only the
// aisee entry can carry one.
//
// The ping/pong presence probe stays a separate, instant, SW-free check —
// requestSocialSessions() below is the one way to get this snapshot.
//
// Both sides import these types: the extension SW builds `SocialSessions`, the
// web app consumes it, so the payload shape can never drift.

import { EXTENSION_MESSAGE } from './brand';

export interface XSessionInfo {
  loggedIn: boolean;
  /** Numeric X user id decoded from the `twid` cookie (e.g. "1234567890"). */
  userId?: string;
  /** Screen name (without @), read from x.com's own nav in a browser tab. */
  handle?: string;
  /** Display name, same tab read. */
  name?: string;
  avatarUrl?: string;
}

export interface RedditSessionInfo {
  loggedIn: boolean;
  /** Account fullname id, e.g. "t2_abc123". */
  id?: string;
  /** Reddit username (without the u/ prefix), from the session me.json read. */
  handle?: string;
  /** Display name (profile title), falls back to the handle. */
  name?: string;
  avatarUrl?: string;
}

export interface AiseeSessionInfo {
  loggedIn: boolean;
  id?: string;
  email?: string;
  username?: string;
}

export interface SocialSessions {
  x: XSessionInfo;
  reddit: RedditSessionInfo;
  /** The extension's aisee session (explicit login or bridged from a tab). */
  aisee: AiseeSessionInfo;
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
