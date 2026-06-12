import React, { useCallback, useEffect, useState } from 'react';
import { ComposeForm } from '@gitroom/extension/pages/popup/components/ComposeForm';
import { HistoryList } from '@gitroom/extension/pages/popup/components/HistoryList';
import {
  appendHistory,
  clearHistory,
  loadHistory,
  ClearRange,
  ReplyHistoryItem,
} from '@gitroom/extension/utils/reply.history';

export default function Popup() {
  const [history, setHistory] = useState<ReplyHistoryItem[]>([]);

  useEffect(() => {
    loadHistory().then(setHistory);

    // Live-refresh when the background / bridge writes a new reply while the
    // popup is open (e.g. an Engage reply posted from the page).
    const onChanged = (
      changes: { [k: string]: chrome.storage.StorageChange },
      area: string
    ) => {
      if (area === 'local' && changes['postiz_reply_history']) {
        const next = changes['postiz_reply_history'].newValue;
        setHistory(Array.isArray(next) ? next : []);
      }
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);

  const handleSubmitted = useCallback(async (item: ReplyHistoryItem) => {
    const next = await appendHistory(item);
    setHistory(next);
  }, []);

  const handleClear = useCallback(async (range: ClearRange) => {
    const next = await clearHistory(range);
    setHistory(next);
  }, []);

  return (
    <div className="pz">
      <div className="pz-header">
        <div className="pz-logo">P</div>
        <div className="pz-title">Postiz · Reply</div>
        <div className="pz-sub">in-browser</div>
      </div>
      <ComposeForm onSubmitted={handleSubmitted} />
      <div className="pz-divider" />
      <HistoryList items={history} onClear={handleClear} />
    </div>
  );
}
