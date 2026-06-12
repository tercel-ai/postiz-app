// Shared result shape for in-browser replies (Option A).

export interface ReplyResult {
  ok: boolean;
  // True when the reply was filled into the platform's composer but NOT yet
  // submitted — the user must review and click the platform's own send button.
  // Used by X (UI automation). Reddit posts directly, so pending is omitted.
  pending?: boolean;
  // Permalink of the published reply (Reddit comment / X status). Absent when pending.
  permalink?: string;
  // Platform id of the published reply: Reddit fullname (t1_/t3_) or X tweet rest_id.
  postId?: string;
  // The ACTUAL poster (the in-browser session). For X we capture it from the
  // CreateTweet response; recorded server-side as Post.settings.engageAuthor.
  author?: {
    handle: string;
    id?: string;
    name?: string;
    avatarUrl?: string;
  };
  // Human-readable next step / hint shown in the UI.
  message?: string;
  error?: string;
  // True when the extension backfilled the permalink onto the Engage sent-reply
  // record (PATCH /engage/sent/:id/reply-url). Only set when sentReplyId +
  // backendBase were supplied.
  backfilled?: boolean;
  // Diagnostic detail surfaced in the debug window.
  detail?: unknown;
}

export interface PostReplyPayload {
  platform: 'reddit' | 'x';
  url: string;
  text: string;
  // Optional Engage context, echoed back so the caller can record the reply.
  opportunityId?: string;
  // Closed-loop backfill: when present, the background PATCHes the permalink
  // onto this sent-reply record using a Bearer token.
  sentReplyId?: string;
  backendBase?: string; // e.g. https://api-post.aisee.live
  // Auth token resolution supports BOTH frontends:
  //  - aisee frontend stores it in localStorage('access_token'); the bridge reads
  //    it and passes it here as `token`.
  //  - postiz's own frontend uses the httpOnly `auth` cookie; when `token` is
  //    absent the background reads that cookie from `frontendOrigin`.
  token?: string;
  frontendOrigin?: string; // origin to read the `auth` cookie from (fallback)
}
