// Local reply history for the debug popup. Stored in chrome.storage.local only.
// The real Engage reply flow does NOT use this — there the frontend records the
// reply server-side via the manual-reply + backfill-URL APIs. This is purely a
// dev/test convenience for posting to arbitrary URLs from the popup.

import { saveStorage } from '@gitroom/extension/utils/save.storage';
import { fetchStorage } from '@gitroom/extension/utils/load.storage';

export type ReplyStatus = 'sent' | 'pending' | 'failed';
export type ClearRange = 'all' | '1d' | '1w' | '1m';

export interface ReplyHistoryItem {
  id: string;
  platform: 'reddit' | 'x';
  targetUrl: string;
  content: string;
  permalink?: string;
  postId?: string;
  status: ReplyStatus;
  createdAt: number; // epoch ms
}

const STORAGE_KEY = 'postiz_reply_history';
const MAX_ITEMS = 500; // cap local storage growth

export async function loadHistory(): Promise<ReplyHistoryItem[]> {
  const raw = (await fetchStorage(STORAGE_KEY)) as ReplyHistoryItem[] | undefined;
  return Array.isArray(raw) ? raw : [];
}

/** Append newest-first to local storage. */
export async function appendHistory(
  item: ReplyHistoryItem
): Promise<ReplyHistoryItem[]> {
  const current = await loadHistory();
  const next = [item, ...current].slice(0, MAX_ITEMS);
  await saveStorage(STORAGE_KEY, next);
  return next;
}

/** Remove items older than the range locally. */
export async function clearHistory(
  range: ClearRange
): Promise<ReplyHistoryItem[]> {
  const current = await loadHistory();
  const cutoff = cutoffFor(range);
  const next =
    cutoff == null ? [] : current.filter((i) => i.createdAt >= cutoff);
  await saveStorage(STORAGE_KEY, next);
  return next;
}

function cutoffFor(range: ClearRange): number | null {
  const DAY = 24 * 60 * 60 * 1000;
  switch (range) {
    case '1d':
      return Date.now() - DAY;
    case '1w':
      return Date.now() - 7 * DAY;
    case '1m':
      return Date.now() - 30 * DAY;
    case 'all':
    default:
      return null; // null = clear everything
  }
}
