// Proactive desktop notifications for in-browser Engage replies. The page-side
// toast only shows when the Engage tab is open and listening; the X reply runs
// in a background tab the user may have switched away from. A background
// notification is the reliable "it posted / it failed" signal regardless.
//
// Requires the "notifications" permission (added in the manifest). Fired from the
// background (handlePostReply) so it works even after the originating tab closes.

export interface NotifyReplyInput {
  ok: boolean;
  pending?: boolean;
  platform?: string;
  error?: string;
}

export function notifyReply(input: NotifyReplyInput): void {
  try {
    if (!chrome.notifications?.create) return;
    const iconUrl = chrome.runtime.getURL('icon-128.png');
    const platform = input.platform ? input.platform.toUpperCase() : '';
    const prefix = platform ? `${platform}: ` : '';

    let title: string;
    let message: string;
    let priority = 0;
    if (input.ok && input.pending) {
      // Filled into the composer but not auto-sent (X UI automation) — needs a click.
      title = 'Action needed to finish your reply';
      message = `${prefix}Draft filled — open the tab and click Reply to send.`;
      priority = 1;
    } else if (input.ok) {
      title = 'Reply posted';
      message = `${prefix}Your reply was posted successfully.`;
    } else {
      title = 'Reply failed';
      message = `${prefix}${input.error || 'Could not post the reply. Please try again.'}`;
      priority = 2;
    }

    chrome.notifications.create(`aisee-reply-${Date.now()}`, {
      type: 'basic',
      iconUrl,
      title,
      message,
      priority,
    });
  } catch (e) {
    console.warn('[aisee] notifyReply failed', e);
  }
}
