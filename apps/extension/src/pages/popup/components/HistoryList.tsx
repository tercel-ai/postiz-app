import React, { FC } from 'react';
import { ReplyHistoryItem } from '@gitroom/extension/utils/reply.history';

const PLATFORM_LABEL: Record<string, string> = { reddit: 'Reddit', x: 'X' };

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

const HistoryItemRow: FC<{ item: ReplyHistoryItem }> = ({ item }) => (
  <div className="pz-item">
    <div className="pz-item-top">
      <span className={`pz-badge ${item.platform}`}>
        {PLATFORM_LABEL[item.platform] ?? item.platform}
      </span>
      <span className={`pz-status ${item.status}`}>{item.status}</span>
      <span className="pz-time">{relativeTime(item.createdAt)}</span>
    </div>

    <div className="pz-content">{item.content}</div>

    <div className="pz-meta">
      {item.permalink ? (
        <a
          className="pz-link"
          href={item.permalink}
          target="_blank"
          rel="noreferrer"
        >
          View reply ↗
        </a>
      ) : (
        <a
          className="pz-link muted"
          href={item.targetUrl}
          target="_blank"
          rel="noreferrer"
        >
          View target ↗
        </a>
      )}
      {item.postId && <span className="pz-postid">{item.postId}</span>}
    </div>
  </div>
);

export const HistoryList: FC<{
  items: ReplyHistoryItem[];
  onClearPage: () => void;
}> = ({ items, onClearPage }) => {
  return (
    <div className="pz-history">
      <div className="pz-history-head">
        <div className="pz-history-title">History ({items.length})</div>
        {items.length > 0 && (
          <button className="pz-clear-btn" onClick={onClearPage}>
            Clear ›
          </button>
        )}
      </div>

      {items.length === 0 ? (
        <div className="pz-empty">No replies yet.</div>
      ) : (
        <div className="pz-list">
          {items.map((item) => (
            <HistoryItemRow key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  );
};
