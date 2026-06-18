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

/** Closed-loop backfill: PATCH the permalink (+ real author) onto the record. */
async function backfillReplyUrl(
  payload: PostReplyPayload,
  permalink: string,
  author?: ReplyResult['author']
): Promise<boolean> {
  const base = payload.backendBase?.replace(/\/$/, '');
  if (!base || !payload.sentReplyId) return false;

  // Token priority:
  //  1) token the page passed (aisee frontend: localStorage access_token)
  //  2) the extension's own logged-in session (works with NO website open)
  //  3) the postiz `auth` cookie on the frontend origin (legacy)
  const token =
    payload.token ||
    (await getValidAccessToken()) ||
    (await readAuthToken(payload.frontendOrigin || ''));
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
        body: JSON.stringify({
          url: permalink,
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

  const result = await postByPlatform(payload);

  // Closed loop: if this came from Engage (sentReplyId + backendBase) and we
  // captured a permalink, backfill it onto the record from the background so the
  // loop completes even if the Engage tab is no longer focused.
  let finalResult = result;
  if (
    result.ok &&
    result.permalink &&
    payload.sentReplyId &&
    payload.backendBase
  ) {
    const backfilled = await backfillReplyUrl(
      payload,
      result.permalink,
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
