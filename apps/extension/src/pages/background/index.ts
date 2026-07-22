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
import { runScanLoop } from '@gitroom/extension/utils/executor/scan.runner';
import { runMetrics } from '@gitroom/extension/utils/executor/metrics.runner';
import {
  scanXKeywordFromPage,
  fetchXPostFromPage,
  scanXAccountFromPage,
} from '@gitroom/extension/utils/executor/x.collect';
import {
  scanRedditKeyword,
  fetchRedditPost,
  scanRedditUser,
} from '@gitroom/extension/utils/executor/reddit.collect';
import { fetchReplyMetrics } from '@gitroom/extension/utils/executor/metrics.reply';
import { fetchPostMetrics } from '@gitroom/extension/utils/executor/metrics.page';
import { reapOrphanXReadTab } from '@gitroom/extension/utils/executor/x.tab-reader';
import { backendCall } from '@gitroom/extension/utils/executor/api';
import { buildClaimTasksPayload } from '@gitroom/extension/utils/executor/claim-tasks.payload';
import { scanReddit } from '@gitroom/extension/utils/executor/scan.reddit';
import { scanX } from '@gitroom/extension/utils/executor/scan.x';
import { ENGAGE_EXTENSION_ACTION } from '@gitroom/extension/utils/executor/actions';
import { getSocialSessions } from '@gitroom/extension/utils/social-sessions';
import {
  ensureEngageScanAlarm,
  clearEngageScanAlarm,
  handleEngageAlarm,
} from '@gitroom/extension/utils/executor/scheduler';

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

// The exact origins where the auth bridge (bridge.ts) is injected, read from the
// built manifest so the probe always targets the SAME tabs the bridge runs in.
// `FRONTEND_TAB_MATCHES` above is a hand-maintained list used for reload/logout
// nudges; it can drift from the build-time `content_scripts.matches` (which come
// from `.env` FRONTEND_URL + postizAppHosts). Deriving the probe list from the
// manifest avoids querying the wrong tab set (which would silently return "no
// frontend tab" and leave a stale session).
function bridgeTabMatches(): string[] {
  try {
    const cs = chrome.runtime.getManifest().content_scripts || [];
    const bridge = cs.find((s) =>
      (s.js || []).some((j) => /bridge/.test(j))
    );
    if (bridge?.matches?.length) return bridge.matches;
  } catch {
    /* fall through to the hand-maintained list */
  }
  return FRONTEND_TAB_MATCHES;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// One probe round: ask every open frontend tab's content-script auth bridge for
// its live page session token (the aisee localStorage `access_token`, which the
// background cannot read itself). The bridge answers with the SAME reader it
// pushes with (`readPageToken`), so login and logout stay consistent — a direct
// `executeScript` localStorage read proved unreliable here (it missed the
// aisee-agent token and wrongly cleared the session).
//
// Resolves to: a non-empty token (logged in), '' (a tab answered logged-out),
// 'no-tab' (no frontend tab open), or 'no-answer' (tabs open but none replied in
// time — content script still loading, e.g. right after a logout redirect).
type ProbeResult = string | 'no-tab' | 'no-answer';
function probeOnce(): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: ProbeResult) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    setTimeout(() => done('no-answer'), 300);
    try {
      chrome.tabs.query({ url: bridgeTabMatches() }, (tabs) => {
        const list = (tabs || []).filter((t) => t.id != null);
        if (!list.length) return done('no-tab');
        let pending = list.length;
        let sawEmpty = false;
        for (const tab of list) {
          chrome.tabs.sendMessage(tab.id!, { action: 'auth:read' }, (resp) => {
            void chrome.runtime.lastError; // tab without the bridge / not loaded
            const token = resp?.token;
            if (typeof token === 'string' && token) return done(token); // logged in wins
            if (resp && token === '') sawEmpty = true; // bridge answered: logged out
            if (--pending === 0) done(sawEmpty ? '' : 'no-answer');
          });
        }
      });
    } catch {
      done('no-answer');
    }
  });
}

// Reconcile the cached session with the live browser session by probing open
// frontend tabs. Retries a few times when tabs are open but no bridge has
// answered yet — right after a logout *redirect* the new page's content script
// has not registered its `auth:read` handler on the first click, which otherwise
// left the stale session until a second click. Retrying lets a single click
// reflect the real state; the popup's session-storage listener is the final
// backstop for anything that lands later.
async function reconcileBrowserSession(): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await probeOnce();
    if (r === 'no-tab') return; // nothing to reconcile against
    if (r === '') return void (await bootstrapFromFrontendToken('')); // logged out
    if (r !== 'no-answer') return void (await bootstrapFromFrontendToken(r)); // logged in
    await delay(150); // tabs open but bridge not ready yet — let it load, retry
  }
}

// Re-arm the 20-day token-refresh alarm on SW/browser startup (alarms are
// cleared on extension reload/update) and run the silent refresh when it fires.
// Also (re)arm the periodic engage-scan alarm so the executor keeps fetching
// across SW restarts whenever a session exists.
function reArmAlarms(): void {
  void reArmRefreshAlarmIfLoggedIn();
  void ensureEngageScanAlarm();
  // The shared X read-tab's idle-close timer lives in this worker; if a prior
  // worker was killed mid-idle its tab would linger, so reap it on startup.
  void reapOrphanXReadTab();
}
chrome.runtime.onStartup?.addListener(reArmAlarms);
chrome.runtime.onInstalled?.addListener(reArmAlarms);
reArmAlarms();
chrome.alarms.onAlarm.addListener((alarm) => {
  // Engage-scan alarm is handled by the executor; everything else (token
  // refresh) by the auth handler — names never collide.
  void handleEngageAlarm(alarm.name).then((handled) => {
    if (!handled) void handleAuthAlarm(alarm.name);
  });
});

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
        // Session exists → start the background engage scan.
        void ensureEngageScanAlarm();
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
        // No session → stop background fetches.
        void clearEngageScanAlarm();
      })
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }

  // ─── Engage executor (demand-driven scan + metrics) ───────────────────────
  // Manual / programmatic triggers. From the SW or popup console:
  //   chrome.runtime.sendMessage({ action: 'engage:scan' })
  //   chrome.runtime.sendMessage({ action: 'engage:metrics', ids: ['<postId>'] })
  if (request.action === ENGAGE_EXTENSION_ACTION.runScan) {
    console.log('[aisee][scan] manual runScan triggered', new Date().toISOString());
    runScanLoop()
      .then((summary) => sendResponse({ ok: true, summary }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
  if (request.action === ENGAGE_EXTENSION_ACTION.runMetrics) {
    runMetrics(Array.isArray(request.ids) ? request.ids : [])
      .then((summary) => sendResponse({ ok: true, summary }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
  if (request.action === ENGAGE_EXTENSION_ACTION.fetchPostMetrics) {
    fetchPostMetrics(request.platform, request.releaseURL)
      .then((analytics) =>
        analytics?.length
          ? sendResponse({ ok: true, analytics })
          : sendResponse({ ok: false, error: 'No post metrics found' })
      )
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
  if (request.action === 'auth:state') {
    // Active re-check on popup open: reconcile the cache with the live browser
    // session first, so a browser logout (or login) reflects on the next click
    // without needing a page refresh.
    reconcileBrowserSession()
      .then(() => getAuthUser())
      .then((user) => sendResponse({ ok: true, user }))
      .catch(() => sendResponse({ ok: true, user: null }));
    return true;
  }
  // Content-script auth bridge: a frontend tab pushes its current page token
  // (aisee localStorage `access_token` or postiz `auth` cookie) so the popup
  // reflects the browser login; an empty token means the page logged out.
  if (request.action === 'auth:bootstrap') {
    bootstrapFromFrontendToken(request.token)
      .then(() => {
        sendResponse({ ok: true });
        // A non-empty token means the browser is logged in → ensure the scan
        // alarm; an empty token (logout) → clear it.
        if (request.token) void ensureEngageScanAlarm();
        else void clearEngageScanAlarm();
      })
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

  // ─── X browser-page collection (Options page) ────────────────────────────
  if (request.action === ENGAGE_EXTENSION_ACTION.scanXKeyword) {
    scanXKeywordFromPage(request.keyword)
      .then((tweets) => sendResponse({ ok: true, tweets }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
  if (request.action === ENGAGE_EXTENSION_ACTION.fetchXPost) {
    fetchXPostFromPage(request.id)
      .then((tweet) => sendResponse({ ok: true, tweet }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
  if (request.action === ENGAGE_EXTENSION_ACTION.scanXAccount) {
    scanXAccountFromPage(request.account, request.keywords ?? [])
      .then((tweets) => sendResponse({ ok: true, tweets }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }

  // ─── Collected-post ingestion (Options page ①②③) ─────────────────────────
  if (request.action === ENGAGE_EXTENSION_ACTION.ingestCollectedPosts) {
    backendCall('/engage/scan-posts/ingest', 'POST', { posts: request.posts })
      .then((r: any) => sendResponse({ ok: r.ok, accepted: r.data?.accepted ?? 0, keywordMatched: r.data?.keywordMatched, reason: r.data?.reason }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }

  if (request.action === ENGAGE_EXTENSION_ACTION.syncCollectedMetrics) {
    backendCall('/posts/sync-metrics', 'POST', {
      platform: request.platform,
      externalPostId: request.externalPostId,
      metrics: request.metrics,
    })
      .then((r: any) => sendResponse({ ok: r.ok, updated: r.data?.updated ?? false }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }

  // ─── Reddit browser-session collection (Options page) ────────────────────
  if (request.action === ENGAGE_EXTENSION_ACTION.scanRedditKeyword) {
    scanRedditKeyword(request.keyword)
      .then((posts) => sendResponse({ ok: true, posts }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
  if (request.action === ENGAGE_EXTENSION_ACTION.fetchRedditPost) {
    fetchRedditPost(request.urlOrId)
      .then((post) => sendResponse({ ok: true, post }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
  if (request.action === ENGAGE_EXTENSION_ACTION.scanRedditUser) {
    scanRedditUser(request.username, request.keywords ?? [])
      .then((posts) => sendResponse({ ok: true, posts }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }

  // ─── On-demand reply-metrics scrape (Replies page "Engagements") ─────────
  if (request.action === ENGAGE_EXTENSION_ACTION.fetchReplyMetrics) {
    fetchReplyMetrics(request.platform, request.releaseURL)
      .then((metrics) =>
        metrics
          ? sendResponse({ ok: true, metrics })
          : sendResponse({ ok: false, error: 'No metrics found for this reply' })
      )
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }

  // ─── Engage scan automation management (Options page) ───────────────────
  if (request.action === ENGAGE_EXTENSION_ACTION.loadConfig) {
    backendCall('/engage/config', 'GET')
      .then((r) => sendResponse({ ok: r.ok, data: r.data }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }

  // ─── Social platform session snapshot (page bridge) ──────────────────────
  if (request.action === ENGAGE_EXTENSION_ACTION.socialSessions) {
    getSocialSessions()
      .then((sessions) => sendResponse({ ok: true, sessions }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }

  // ─── Subscription plan (Popup header badge) ──────────────────────────────
  if (request.action === ENGAGE_EXTENSION_ACTION.loadSubscription) {
    backendCall('/user/subscription', 'GET')
      .then((r) => sendResponse({ ok: r.ok, data: r.data }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
  if (request.action === ENGAGE_EXTENSION_ACTION.claimTasks) {
    const want = Math.min(Math.max(1, request.want ?? 3), 5);
    const selectedUnits = Array.isArray(request.selectedUnits) ? request.selectedUnits : undefined;
    console.log('[aisee][scan] claimTasks', { want, selectedUnits: selectedUnits?.length ?? 0 });
    backendCall('/engage/scan-tasks/ingest', 'POST', buildClaimTasksPayload({ want, selectedUnits }))
      .then((r: any) =>
        sendResponse({ ok: r.ok, tasks: r.data?.nextTasks ?? [], accepted: 0 })
      )
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
  if (request.action === ENGAGE_EXTENSION_ACTION.executeTask) {
    const gate = () => Promise.resolve(true);
    const task = request.task;
    console.log('[aisee][scan] executeTask', task?.platform, task?.scanType, task?.scanKey);
    // Options and the alarm runner use the same production scanners so their
    // request fingerprints, cursor handling and parsing cannot drift apart.
    // Honour the server-resolved pacing exactly: the debug panel is used to
    // validate production task behaviour, including X maxPages scrolling.
    (task.platform === 'x' ? scanX(task, gate) : scanReddit(task, gate))
      .then((result) => sendResponse({ ok: true, result }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
  if (request.action === ENGAGE_EXTENSION_ACTION.releaseTask) {
    // Release a stuck lease (scan failed, cursor still SCANNING).
    // After release, select the unit and claim it again to immediately re-scan.
    backendCall('/engage/scan-tasks/release', 'POST', { taskId: request.taskId })
      .then((r: any) => sendResponse({ ok: r.ok, released: r.data?.released ?? false }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
  if (request.action === ENGAGE_EXTENSION_ACTION.ingestTask) {
    console.log('[aisee][scan] ingestTask', request.taskId, { posts: request.posts?.length, exhausted: request.exhausted });
    // Complete the task + claim next (want:1 is the minimum the backend allows).
    // The caller reads nextTasks from the response and shows them in the UI.
    backendCall('/engage/scan-tasks/ingest', 'POST', {
      completed: {
        taskId: request.taskId,
        posts: request.posts,
        nextCursor: request.nextCursor ?? null,
        exhausted: request.exhausted ?? true,
      },
      want: 1,
    })
      .then((r: any) =>
        sendResponse({
          ok: r.ok,
          accepted: r.data?.accepted ?? 0,
          nextTasks: r.data?.nextTasks ?? [],
        })
      )
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
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
