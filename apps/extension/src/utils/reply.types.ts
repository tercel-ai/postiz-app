// Shared result shape for in-browser replies (Option A).

export interface ReplyResult {
  ok: boolean;
  // True when the reply was filled into the platform's composer but NOT yet
  // submitted — the user must review and click the platform's own send button.
  // Used by X (UI automation). Reddit posts directly, so pending is omitted.
  pending?: boolean;
  // Permalink of the published reply (Reddit). Absent when pending.
  permalink?: string;
  // Human-readable next step / hint shown in the UI.
  message?: string;
  error?: string;
  // Diagnostic detail surfaced in the debug window.
  detail?: unknown;
}

export interface PostReplyPayload {
  platform: 'reddit' | 'x';
  url: string;
  text: string;
  // Optional Engage context, echoed back so the caller can record the reply.
  opportunityId?: string;
}
