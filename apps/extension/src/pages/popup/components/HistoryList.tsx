import React, { FC, useState, useEffect } from 'react';
import { ReplyHistoryItem } from '@gitroom/extension/utils/reply.history';

const PAGE_SIZE = 5;
const PLATFORM_LABEL: Record<string, string> = { reddit: 'Reddit', x: 'X' };
const FILTERS = ['all', 'x', 'reddit'] as const;
type PlatformFilter = (typeof FILTERS)[number];

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
  const [filter, setFilter] = useState<PlatformFilter>('all');
  const [page, setPage] = useState(0);

  const filtered =
    filter === 'all' ? items : items.filter((i) => i.platform === filter);
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages - 1);
  const visible = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

  // Reset to page 0 when filter or items change
  useEffect(() => { setPage(0); }, [filter, items]);

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

      {/* Platform filter */}
      {items.length > 0 && (
        <div className="pz-filter-bar">
          {FILTERS.map((f) => {
            const count = f === 'all' ? items.length : items.filter((i) => i.platform === f).length;
            return (
              <button
                key={f}
                className={`pz-filter-btn${filter === f ? ' active' : ''}`}
                onClick={() => setFilter(f)}
                disabled={count === 0}
              >
                {f === 'all' ? 'All' : PLATFORM_LABEL[f] ?? f}
                <span className="pz-filter-count">{count}</span>
              </button>
            );
          })}
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="pz-empty">No {filter === 'all' ? '' : PLATFORM_LABEL[filter] + ' '}replies yet.</div>
      ) : (
        <>
          <div className="pz-list">
            {visible.map((item) => (
              <HistoryItemRow key={item.id} item={item} />
            ))}
          </div>

          {totalPages > 1 && (
            <div className="pz-pagination">
              <button
                className="pz-page-btn"
                disabled={currentPage === 0}
                onClick={() => setPage(currentPage - 1)}
              >
                ‹
              </button>
              <span className="pz-page-info">
                {currentPage + 1} / {totalPages}
              </span>
              <button
                className="pz-page-btn"
                disabled={currentPage >= totalPages - 1}
                onClick={() => setPage(currentPage + 1)}
              >
                ›
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
};
