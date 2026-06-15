import { fetchRequestUtil } from '@gitroom/extension/utils/request.util';
import { handlePostReply } from './post-reply';
import {
  login,
  logout,
  getAuthUser,
  bootstrapFromFrontendToken,
  handleAuthAlarm,
  reArmRefreshAlarmIfLoggedIn,
} from '@gitroom/extension/utils/auth.service';

const isDevelopment = process.env.NODE_ENV === 'development';

// Frontend origins that bootstrap a session from the shared refresh_token cookie
// (mirrors content_scripts.matches / host_permissions). After an extension login
// we nudge any of these tabs that are stuck on the login screen into the app.
const FRONTEND_TAB_MATCHES = [
  'http://localhost:3001/*', // aisee-agent local dev (3001, off the postiz backend's :3000)
  'http://192.168.110.98:4200/*',
  'https://app-dev.aisee.live/*',
  'https://app.aisee.live/*',
];

// Login-screen paths across the frontends: apps/frontend uses /auth/*, aisee-app
// uses /sign-in & /sign-up (both at the origin root). aisee-agent only runs
// standalone in local dev (localhost:3000/sign-in, also root); in prod it shares
// aisee-app's origin under /post and inherits its session, so no /post matching.
const LOGIN_PATH_RE = /^\/(auth|sign-in|sign-up)(\/|$)/;

// A frontend tab already open on its login screen won't re-check auth on its own,
// so it would sit on the login page even though the extension just established a
// session. Reload such tabs: apps/frontend's middleware (server) and aisee-app's
// client bootstrap then re-read the now-present refresh_token cookie and drop the
// user into the app.
function enterFrontendAuthTabs(): void {
  try {
    chrome.tabs.query({ url: FRONTEND_TAB_MATCHES }, (tabs) => {
      for (const tab of tabs || []) {
        if (!tab.id || !tab.url) continue;
        let path = '';
        try {
          path = new URL(tab.url).pathname;
        } catch {
          continue;
        }
        if (!LOGIN_PATH_RE.test(path)) continue;
        chrome.tabs.reload(tab.id);
        console.log('[aisee-auth] reloading login tab', tab.id, path);
      }
    });
  } catch (e) {
    console.log('[aisee-auth] enterFrontendAuthTabs error', e);
  }
}

// Logout the other way: after the extension revokes the shared refresh_token,
// drop the postiz `auth` cookie (apps/frontend's session lives there) on every
// frontend origin and reload ALL frontend tabs. apps/frontend's middleware then
// has neither cookie → login screen; aisee-app's client validates its leftover
// localStorage token against the (now-revoked) refresh session and logs out.
function logoutFrontendTabs(): void {
  for (const match of FRONTEND_TAB_MATCHES) {
    const origin = match.replace(/\/\*$/, '');
    try {
      chrome.cookies.remove({ url: `${origin}/`, name: 'auth' });
    } catch {
      /* no auth cookie on this origin (aisee uses localStorage) — ignore */
    }
  }
  try {
    chrome.tabs.query({ url: FRONTEND_TAB_MATCHES }, (tabs) => {
      for (const tab of tabs || []) {
        if (!tab.id) continue;
        // Ask the content-script auth bridge to drop the page's session token
        // (aisee localStorage `access_token` / non-httpOnly `auth` cookie) so the
        // reload below lands logged-out instead of re-bootstrapping the session.
        try {
          chrome.tabs.sendMessage(tab.id, { action: 'auth:clear' }, () => {
            // Swallow "no receiver" for tabs without the content script.
            void chrome.runtime.lastError;
            chrome.tabs.reload(tab.id!);
          });
        } catch {
          chrome.tabs.reload(tab.id);
        }
        console.log('[aisee-auth] logout-reloading frontend tab', tab.id);
      }
    });
  } catch (e) {
    console.log('[aisee-auth] logoutFrontendTabs error', e);
  }
}

// Re-arm the 20-day token-refresh alarm on SW/browser startup (alarms are
// cleared on extension reload/update) and run the silent refresh when it fires.
chrome.runtime.onStartup?.addListener(() => void reArmRefreshAlarmIfLoggedIn());
chrome.runtime.onInstalled?.addListener(() => void reArmRefreshAlarmIfLoggedIn());
void reArmRefreshAlarmIfLoggedIn();
chrome.alarms.onAlarm.addListener((alarm) => void handleAuthAlarm(alarm.name));

chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
  if (request.action === 'makeHttpRequest') {
    fetchRequestUtil(request).then((response) => {
      sendResponse(response);
    });
  }

  // ─── Standalone auth (extension login, no website needed) ─────────────────
  if (request.action === 'auth:login') {
    login(request.email, request.password)
      .then((user) => {
        sendResponse({ ok: true, user });
        // Refresh cookie is now set on this host → pull any open login tabs in.
        enterFrontendAuthTabs();
      })
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
  if (request.action === 'auth:logout') {
    logout()
      .then(() => {
        sendResponse({ ok: true });
        // Shared refresh token is now revoked + removed → log the websites out too.
        logoutFrontendTabs();
      })
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
  if (request.action === 'auth:state') {
    getAuthUser()
      .then((user) => sendResponse({ ok: true, user }))
      .catch(() => sendResponse({ ok: true, user: null }));
    return true;
  }
  // Content-script auth bridge: a frontend tab pushes its current page token
  // (aisee localStorage `access_token` or postiz `auth` cookie) so the popup
  // reflects the browser login; an empty token means the page logged out.
  if (request.action === 'auth:bootstrap') {
    bootstrapFromFrontendToken(request.token)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }

  // In-browser reply (Option A). payload: { platform, url, text, opportunityId? }
  if (request.action === 'postReply') {
    console.log('[aisee] postReply received', request.payload);
    handlePostReply(request.payload)
      .then((res) => {
        console.log('[aisee] postReply result', res);
        sendResponse(res);
      })
      .catch((e) => {
        console.error('[aisee] postReply error', e);
        sendResponse({ ok: false, error: String(e?.message || e) });
      });
    return true;
  }

  if (request.action === 'loadStorage') {
    chrome.storage.local.get([request.key], function (storage) {
      sendResponse(storage[request.key]);
    });
  }

  if (request.action === 'saveStorage') {
    chrome.storage.local.set({ [request.key]: request.value }, function () {
      sendResponse({ success: true });
    });
  }

  if (request.action === 'openTab') {
    chrome.tabs.create({ url: request.url }, function (tab) {
      sendResponse({ success: true, tabId: tab?.id });
    });
  }

  if (request.action === 'loadCookie') {
    chrome.cookies.get(
      {
        url: import.meta.env?.FRONTEND_URL || process?.env?.FRONTEND_URL,
        name: request.cookieName,
      },
      function (cookies) {
        sendResponse(cookies?.value);
      }
    );
  }

  return true;
});
