import { appendHistory } from '@gitroom/extension/utils/reply.history';
import { EXTENSION_MESSAGE } from '@gitroom/helpers/extension/brand';

const isNonEmptyString = (value: unknown): value is string => {
  return typeof value === 'string' && value.trim().length > 0;
};

/**
 * Engage → extension bridge (Option A). The web app posts:
 *   window.postMessage({
 *     source: EXTENSION_MESSAGE.source,            // 'aisee'
 *     action: EXTENSION_MESSAGE.engageReply,       // 'aisee:engage-reply'
 *     payload: { platform, url, text, opportunityId, sentReplyId, backendBase }
 *   }, window.location.origin)
 *
 * The background posts the reply in-browser and (when sentReplyId + backendBase
 * are present) backfills the permalink onto the sent-reply record itself, so the
 * loop completes without the page. We add frontendOrigin so the background knows
 * which origin to read the auth cookie from.
 */
export function installEngageReplyBridge() {
  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    if (event.origin !== window.location.origin) return;

    const data = event.data as
      | { source?: string; action?: string; payload?: unknown }
      | undefined;
    if (!data || data.source !== EXTENSION_MESSAGE.source) return;
    if (data.action !== EXTENSION_MESSAGE.engageReply) return;

    const payload = data.payload as Record<string, unknown> | undefined;
    if (
      !payload ||
      !isNonEmptyString(payload.platform) ||
      !isNonEmptyString(payload.url) ||
      !isNonEmptyString(payload.text)
    ) {
      return;
    }

    // Resolve the auth token from BOTH frontends: the aisee frontend keeps it in
    // localStorage('access_token'); postiz's own frontend uses the httpOnly
    // `auth` cookie (read in the background via frontendOrigin when absent here).
    let token: string | undefined;
    try {
      token = window.localStorage.getItem('access_token') || undefined;
    } catch {
      token = undefined;
    }

    let result: unknown;
    try {
      result = await chrome.runtime.sendMessage({
        action: 'postReply',
        payload: {
          ...payload,
          token,
          frontendOrigin: window.location.origin,
        },
      });
    } catch (e: any) {
      result = { ok: false, error: String(e?.message || e) };
    }

    // Record this Engage reply in the popup's local history (same list the
    // debug window shows), so it isn't limited to debug-window submissions.
    try {
      const r = result as {
        ok?: boolean;
        pending?: boolean;
        permalink?: string;
        postId?: string;
      };
      await appendHistory({
        id:
          (crypto as any)?.randomUUID?.() ??
          `${Date.now()}-${Math.round(Math.random() * 1e6)}`,
        platform: String(payload.platform) as 'reddit' | 'x',
        targetUrl: String(payload.url),
        content: String(payload.text),
        permalink: r?.permalink,
        postId: r?.postId,
        status: !r?.ok ? 'failed' : r?.pending ? 'pending' : 'sent',
        createdAt: Date.now(),
      });
    } catch {
      /* history is best-effort */
    }

    window.postMessage(
      {
        source: EXTENSION_MESSAGE.resultSource,
        action: EXTENSION_MESSAGE.engageReplyResult,
        opportunityId: payload.opportunityId,
        result,
      },
      window.location.origin
    );
  });
}
