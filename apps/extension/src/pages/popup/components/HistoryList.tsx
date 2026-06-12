import React, { FC } from 'react';
import {
  ClearRange,
  ReplyHistoryItem,
} from '@gitroom/extension/utils/reply.history';

const STATUS_STYLE: Record<
  ReplyHistoryItem['status'],
  { bg: string; color: string; label: string }
> = {
  sent: { bg: '#e7f6ec', color: '#1a7f37', label: 'sent' },
  pending: { bg: '#fff7e6', color: '#92400e', label: 'pending' },
  failed: { bg: '#fcebec', color: '#b91c1c', label: 'failed' },
};

const PLATFORM_STYLE: Record<string, { bg: string; label: string }> = {
  reddit: { bg: '#ff4500', label: 'Reddit' },
  x: { bg: '#0f1419', label: 'X' },
};

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

const HistoryItemRow: FC<{ item: ReplyHistoryItem }> = ({ item }) => {
  const status = STATUS_STYLE[item.status];
  const platform = PLATFORM_STYLE[item.platform] ?? {
    bg: '#666',
    label: item.platform,
  };

  return (
    <div className="border border-gray-200 rounded-md p-2 flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <span
          className="text-[10px] font-bold text-white px-1.5 py-0.5 rounded"
          style={{ backgroundColor: platform.bg }}
        >
          {platform.label}
        </span>
        <span
          className="text-[10px] font-medium px-1.5 py-0.5 rounded"
          style={{ backgroundColor: status.bg, color: status.color }}
        >
          {status.label}
        </span>
        <span className="text-[10px] text-gray-400 ml-auto">
          {relativeTime(item.createdAt)}
        </span>
      </div>

      <div className="text-xs text-gray-800 line-clamp-2 break-words">
        {item.content}
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        {item.permalink ? (
          <a
            href={item.permalink}
            target="_blank"
            rel="noreferrer"
            className="text-[11px] underline"
            style={{ color: '#612bd3' }}
          >
            View reply ↗
          </a>
        ) : (
          <a
            href={item.targetUrl}
            target="_blank"
            rel="noreferrer"
            className="text-[11px] text-gray-400 underline"
          >
            View target ↗
          </a>
        )}
        {item.postId && (
          <span className="text-[10px] font-mono text-gray-400 break-all">
            {item.postId}
          </span>
        )}
      </div>
    </div>
  );
};

export const HistoryList: FC<{
  items: ReplyHistoryItem[];
  onClear: (range: ClearRange) => void;
}> = ({ items, onClear }) => {
  const clearButtons: { range: ClearRange; label: string }[] = [
    { range: '1d', label: '>1d' },
    { range: '1w', label: '>1w' },
    { range: '1m', label: '>1m' },
    { range: 'all', label: 'All' },
  ];

  return (
    <div className="flex flex-col gap-2 mt-1">
      <div className="flex items-center gap-1.5">
        <div className="text-xs font-semibold text-gray-600">
          History ({items.length})
        </div>
        <div className="ml-auto flex items-center gap-1">
          <span className="text-[10px] text-gray-400">clear</span>
          {clearButtons.map((b) => (
            <button
              key={b.range}
              className="text-[10px] px-1.5 py-0.5 rounded border border-gray-200 text-gray-500 hover:bg-gray-50"
              onClick={() => onClear(b.range)}
            >
              {b.label}
            </button>
          ))}
        </div>
      </div>

      {items.length === 0 ? (
        <div className="text-xs text-gray-400 py-3 text-center">
          No replies yet.
        </div>
      ) : (
        <div
          className="flex flex-col gap-1.5 overflow-y-auto"
          style={{ maxHeight: 280 }}
        >
          {items.map((item) => (
            <HistoryItemRow key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  );
};
