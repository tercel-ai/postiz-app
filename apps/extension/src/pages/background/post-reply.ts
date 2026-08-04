// Single entry point for in-browser replies (Option A). Both the debug popup
// and the Engage page (via the content-script bridge) converge here.

import { postRedditComment } from '@gitroom/extension/utils/reddit.poster';
import { postXReply } from './x.poster';
import { PostReplyPayload, ReplyResult } from '@gitroom/extension/utils/reply.types';
import { getValidAccessToken } from '@gitroom/extension/utils/auth.service';
import { notifyReply } from '@gitroom/extension/utils/notify';

async function postByPlatform(payload: PostReplyPayload): Promise<ReplyResult> {
  switch (payload.platform) {
    case 'reddit':
      return postRedditComment({ url: payload.url, text: payload.text });
    case 'x':
      return postXReply({ url: payload.url, text: payload.text });
    default:
      return { ok: false, error: `Unsupported platform: ${payload.platform}` };
  }
}

/** Read the Postiz `auth` JWT cookie from the frontend origin (httpOnly-safe). */
function readAuthToken(frontendOrigin: string): Promise<string | undefined> {
  if (!frontendOrigin) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    try {
      chrome.cookies.get({ url: frontendOrigin, name: 'auth' }, (c) =>
        resolve(c?.value || undefined)
      );
    } catch {
      resolve(undefined);
    }
  });
}

// Token priority:
//  1) token the page passed (aisee frontend: localStorage access_token)
//  2) the extension's own logged-in session (works with NO website open)
//  3) the postiz `auth` cookie on the frontend origin (legacy)
async function resolveBackendToken(
  payload: PostReplyPayload
): Promise<string | undefined> {
  return (
    payload.token ||
    (await getValidAccessToken()) ||
    (await readAuthToken(payload.frontendOrigin || ''))
  );
}

/**
 * Duplicate guard: ask the backend whether this sent reply already went out
 * (replyUrl backfilled, or state already PUBLISHED). Every send request posts
 * straight to the platform otherwise, so a reply whose earlier attempt DID post
 * but whose backfill failed (record stuck in DRAFT) would be re-posted verbatim
 * on the next click — the exact triple-comment incident this guards against.
 * Returns null when it cannot tell (no record id / no token / network error):
 * fail OPEN, because a probe failure is not evidence of a duplicate — but log
 * it, so an unverified send never looks like a verified one.
 */
async function checkAlreadyPublished(
  payload: PostReplyPayload
): Promise<{ replyUrl?: string } | null> {
  const base = payload.backendBase?.replace(/\/$/, '');
  if (!base || !payload.sentReplyId) return null;
  const token = await resolveBackendToken(payload);
  if (!token) {
    console.warn('[aisee] duplicate check skipped: no token — sending unverified');
    return null;
  }
  try {
    const res = await fetch(`${base}/engage/sent/${payload.sentReplyId}/status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      console.warn('[aisee] duplicate check HTTP', res.status, '— sending unverified');
      return null;
    }
    const data = (await res.json()) as { state?: string; replyUrl?: string };
    if (data?.replyUrl || data?.state === 'PUBLISHED') {
      return { replyUrl: data?.replyUrl || undefined };
    }
    return null;
  } catch (e) {
    console.warn('[aisee] duplicate check failed — sending unverified', e);
    return null;
  }
}

/** Closed-loop backfill: PATCH the permalink (+ real author) onto the record. */
async function backfillReplyUrl(
  payload: PostReplyPayload,
  permalink: string,
  author?: ReplyResult['author']
): Promise<boolean> {
  const base = payload.backendBase?.replace(/\/$/, '');
  if (!base || !payload.sentReplyId) return false;

  const token = await resolveBackendToken(payload);
  if (!token) {
    console.warn('[aisee] backfill skipped: no token (page / login / cookie)');
    return false;
  }

  try {
    // publish-reply (not reply-url): besides backfilling the permalink this flips
    // the saved DRAFT to PUBLISHED, claims the opportunity, and charges — the
    // commit point for the extension flow (nothing was committed at send time).
    const res = await fetch(
      `${base}/engage/sent/${payload.sentReplyId}/publish-reply`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        // author = the actual in-browser poster (X). Recorded as engageAuthor so
        // the record reflects who really posted, not the selected integration.
        // url is omitted when the platform confirmed the send but no permalink
        // could be captured — the backend still flips DRAFT→PUBLISHED (URL-less)
        // so the record never lingers as a re-sendable draft for a live reply.
        body: JSON.stringify({
          ...(permalink ? { url: permalink } : {}),
          ...(author ? { author } : {}),
        }),
      }
    );
    console.log('[aisee] backfill status', res.status);
    return res.ok;
  } catch (e) {
    console.error('[aisee] backfill failed', e);
    return false;
  }
}

export async function handlePostReply(
  payload: PostReplyPayload
): Promise<ReplyResult> {
  if (!payload || !payload.platform) {
    return { ok: false, error: 'Missing platform' };
  }

  // Pre-send duplicate guard — MUST run before any platform write.
  const already = await checkAlreadyPublished(payload);
  if (already) {
    const error =
      'This reply was already published' +
      (already.replyUrl ? ` (${already.replyUrl})` : '') +
      ' — skipped to avoid a duplicate. Refresh the Engage page to see it.';
    console.warn('[aisee] postReply blocked:', error);
    notifyReply({ ok: false, platform: payload.platform, error });
    return { ok: false, error };
  }

  const result = await postByPlatform(payload);

  // Closed loop: if this came from Engage (sentReplyId + backendBase) and the
  // platform confirmed the send, backfill the record from the background so the
  // loop completes even if the Engage tab is no longer focused. A missing
  // permalink is NOT a reason to skip: the reply is live, and leaving the DB
  // row in DRAFT is what invites a duplicate re-send — backfill URL-less
  // instead. `pending` (composer filled but the platform's own send never
  // confirmed) must NOT backfill: nothing is provably live yet.
  let finalResult = result;
  if (
    result.ok &&
    !result.pending &&
    payload.sentReplyId &&
    payload.backendBase
  ) {
    const backfilled = await backfillReplyUrl(
      payload,
      result.permalink || '',
      result.author
    );
    finalResult = { ...result, backfilled };
  }

  // Proactively notify the outcome (success + failure). The page toast only fires
  // when the Engage tab is open; this background notification is the reliable
  // signal — especially for X, which posts in a background tab.
  notifyReply({
    ok: !!finalResult.ok,
    pending: finalResult.pending,
    platform: payload.platform,
    error: finalResult.error,
  });

  return finalResult;
}
