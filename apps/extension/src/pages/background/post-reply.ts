// Single entry point for in-browser replies (Option A). Both the debug popup
// and the Engage page (via the content-script bridge) converge here.

import { postRedditComment } from '@gitroom/extension/utils/reddit.poster';
import { postXReply } from './x.poster';
import { PostReplyPayload, ReplyResult } from '@gitroom/extension/utils/reply.types';

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

/** Closed-loop backfill: PATCH the permalink onto the Engage sent-reply record. */
async function backfillReplyUrl(
  payload: PostReplyPayload,
  permalink: string
): Promise<boolean> {
  const base = payload.backendBase?.replace(/\/$/, '');
  if (!base || !payload.sentReplyId) return false;

  // Prefer the token the page passed (aisee frontend: localStorage access_token);
  // otherwise fall back to the postiz `auth` cookie on the frontend origin.
  const token =
    payload.token || (await readAuthToken(payload.frontendOrigin || ''));
  if (!token) {
    console.warn('[postiz] backfill skipped: no token (localStorage or cookie)');
    return false;
  }

  try {
    const res = await fetch(
      `${base}/engage/sent/${payload.sentReplyId}/reply-url`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ url: permalink }),
      }
    );
    console.log('[postiz] backfill status', res.status);
    return res.ok;
  } catch (e) {
    console.error('[postiz] backfill failed', e);
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
  if (
    result.ok &&
    result.permalink &&
    payload.sentReplyId &&
    payload.backendBase
  ) {
    const backfilled = await backfillReplyUrl(payload, result.permalink);
    return { ...result, backfilled };
  }

  return result;
}
