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
    <div className="flex flex-col gap-2" style={{ width: '100%' }}>
      <ComposeForm onSubmitted={handleSubmitted} />
      <div className="h-px bg-gray-200" />
      <HistoryList items={history} onClear={handleClear} />
    </div>
  );
}
