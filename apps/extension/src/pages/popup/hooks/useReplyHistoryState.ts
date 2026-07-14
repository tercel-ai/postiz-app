import { useCallback, useEffect, useState } from 'react';
import {
  clearHistory,
  loadHistory,
  ClearRange,
  ReplyHistoryItem,
  STORAGE_KEY,
} from '@gitroom/extension/utils/reply.history';

/** Shared reply-history state — used by both Popup and Panel. */
export function useReplyHistoryState() {
  const [history, setHistory] = useState<ReplyHistoryItem[]>([]);

  useEffect(() => {
    loadHistory().then(setHistory);

    // Live-refresh when the background / bridge writes a new reply while this
    // surface is open (e.g. an Engage reply posted from the page).
    const onChanged = (
      changes: { [k: string]: chrome.storage.StorageChange },
      area: string
    ) => {
      if (area === 'local' && changes[STORAGE_KEY]) {
        const next = changes[STORAGE_KEY].newValue;
        setHistory(Array.isArray(next) ? next : []);
      }
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);

  const handleClear = useCallback(async (range: ClearRange) => {
    const next = await clearHistory(range);
    setHistory(next);
  }, []);

  return { history, handleClear };
}
