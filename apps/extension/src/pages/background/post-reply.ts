// Single entry point for in-browser replies (Option A). Both the debug popup
// and the Engage page (via the content-script bridge) converge here.

import { postRedditComment } from '@gitroom/extension/utils/reddit.poster';
import { postXReply } from './x.poster';
import { PostReplyPayload, ReplyResult } from '@gitroom/extension/utils/reply.types';

export async function handlePostReply(
  payload: PostReplyPayload
): Promise<ReplyResult> {
  if (!payload || !payload.platform) {
    return { ok: false, error: 'Missing platform' };
  }

  switch (payload.platform) {
    case 'reddit':
      return postRedditComment({ url: payload.url, text: payload.text });
    case 'x':
      return postXReply({ url: payload.url, text: payload.text });
    default:
      return { ok: false, error: `Unsupported platform: ${payload.platform}` };
  }
}
