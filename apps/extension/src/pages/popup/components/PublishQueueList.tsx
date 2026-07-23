import React, { FC, useState, useCallback } from 'react';
import type { PublishQueueRow } from '@gitroom/extension/pages/popup/hooks/usePublishQueueState';

const PAGE_SIZE = 5;
const PLATFORM_LABEL: Record<string, string> = {
  reddit: 'Reddit',
  x: 'X',
  linkedin: 'LinkedIn',
};

// Two buckets the user asked to distinguish: "not sent yet" (still in the
// queue) vs "sent" (settled, whatever the outcome).
const PENDING_STATUSES = new Set(['queued', 'publishing']);

const STATUS_LABEL: Record<string, string> = {
  queued: 'Queued',
  publishing: 'Publishing…',
  sent: 'Sent · syncing',
  published: 'Published',
  error: 'Failed',
  canceled: 'Canceled',
};

const FILTERS = ['all', 'pending', 'sent'] as const;
type QueueFilter = (typeof FILTERS)[number];
const FILTER_LABEL: Record<QueueFilter, string> = {
  all: 'All',
  pending: 'Not sent',
  sent: 'Sent',
};

function isPending(row: PublishQueueRow): boolean {
  return PENDING_STATUSES.has(row.state.status);
}

function rowText(row: PublishQueueRow): string {
  const body = (row.item.segments?.[0]?.text || '').trim();
  return body || '(no text)';
}

function formatDateTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleString();
}

function publishTimeLabel(row: PublishQueueRow): string {
  // Once the post actually went out, show the REAL send time (publishedAt) —
  // for an overdue or "Publish now" task this differs from the scheduled
  // publishDate, and showing the stale scheduled time would be misleading.
  if (row.state.publishedAt) {
    return `Posted · ${formatDateTime(row.state.publishedAt)}`;
  }
  // Not sent yet: show the intended publish time (item.publishDate, echoed as
  // state.publishAt). A still-queued future task is what the alarm fires on.
  const iso = row.item.publishDate || row.state.publishAt;
  if (!iso) return 'Publish: ASAP';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 'Publish: ASAP';
  const when = formatDateTime(iso);
  if (row.state.status === 'queued' && t > Date.now()) return `Scheduled · ${when}`;
  return `Publish · ${when}`;
}

const QueueRow: FC<{
  row: PublishQueueRow;
  onPublishNow: (taskId: string) => Promise<void>;
  onCancel: (taskId: string) => Promise<void>;
  onSync: (taskId: string) => Promise<void>;
  onRetry: (taskId: string) => Promise<void>;
  onRemove: (taskId: string) => Promise<void>;
}> = ({ row, onPublishNow, onCancel, onSync, onRetry, onRemove }) => {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { taskId, platform, status, segmentsTotal, segmentsPublished } = row.state;
  const publishTime = publishTimeLabel(row);

  const run = useCallback(
    async (fn: (id: string) => Promise<void>) => {
      setBusy(true);
      setErr(null);
      try {
        await fn(taskId);
      } catch (e: any) {
        setErr(String(e?.message || e));
      } finally {
        setBusy(false);
      }
    },
    [taskId]
  );

  return (
    <div className="pz-item">
      <div className="pz-item-top">
        <span className={`pz-badge ${platform}`}>
          {PLATFORM_LABEL[platform] ?? platform}
        </span>
        <span className={`pz-status ${status}`}>
          {STATUS_LABEL[status] ?? status}
        </span>
        {segmentsTotal > 1 && (
          <span className="pz-time" style={{ marginLeft: 0 }}>
            {segmentsPublished}/{segmentsTotal}
          </span>
        )}
        <span className="pz-time">{publishTime}</span>
      </div>

      {(row.item.title || '').trim() && (
        <div className="pz-content" style={{ fontWeight: 600, WebkitLineClamp: 1 }}>
          {(row.item.title || '').trim()}
        </div>
      )}
      <div className="pz-content">{rowText(row)}</div>

      {row.state.error && (
        <div className="pz-content" style={{ color: 'var(--pz-danger)' }}>
          {row.state.error}
        </div>
      )}
      {status === 'sent' && row.state.backfillError && (
        <div className="pz-content" style={{ color: '#92400e' }}>
          Not recorded in your dashboard yet: {row.state.backfillError}
        </div>
      )}

      <div className="pz-meta">
        {row.state.permalink && (
          <a
            className="pz-link"
            href={row.state.permalink}
            target="_blank"
            rel="noreferrer"
          >
            View post ↗
          </a>
        )}
        {status === 'queued' && (
          <>
            <button
              className="pz-mini-btn primary"
              disabled={busy}
              onClick={() => run(onPublishNow)}
            >
              Publish now
            </button>
            <button
              className="pz-mini-btn"
              disabled={busy}
              onClick={() => run(onCancel)}
            >
              Cancel
            </button>
          </>
        )}
        {status === 'sent' && (
          <button
            className="pz-mini-btn primary"
            disabled={busy}
            onClick={() => run(onSync)}
          >
            Sync
          </button>
        )}
        {status === 'error' && (
          <>
            {segmentsPublished === 0 && (
              <button
                className="pz-mini-btn primary"
                disabled={busy}
                onClick={() => run(onRetry)}
              >
                Retry
              </button>
            )}
            <button
              className="pz-mini-btn"
              disabled={busy}
              onClick={() => run(onRemove)}
            >
              Remove
            </button>
          </>
        )}
        {status === 'canceled' && (
          <button
            className="pz-mini-btn"
            disabled={busy}
            onClick={() => run(onRemove)}
          >
            Remove
          </button>
        )}
        {err && <span className="pz-queue-err">{err}</span>}
      </div>
    </div>
  );
};

export const PublishQueueList: FC<{
  rows: PublishQueueRow[];
  onPublishNow: (taskId: string) => Promise<void>;
  onCancel: (taskId: string) => Promise<void>;
  onSync: (taskId: string) => Promise<void>;
  onRetry: (taskId: string) => Promise<void>;
  onRemove: (taskId: string) => Promise<void>;
  onClear?: () => void;
  /** Rendered inside a parent tab bar: hide the internal title/clear header
   *  (the tab carries the label + count) and show an empty state instead of
   *  collapsing to nothing. */
  embedded?: boolean;
}> = ({
  rows,
  onPublishNow,
  onCancel,
  onSync,
  onRetry,
  onRemove,
  onClear,
  embedded,
}) => {
  const [filter, setFilter] = useState<QueueFilter>('all');
  const [page, setPage] = useState(0);

  // Pending first (the actionable ones), newest-enqueued first within each group.
  const ordered = [...rows].reverse().sort((a, b) => {
    const ap = isPending(a) ? 0 : 1;
    const bp = isPending(b) ? 0 : 1;
    return ap - bp;
  });
  const filtered = ordered.filter((r) =>
    filter === 'all' ? true : filter === 'pending' ? isPending(r) : !isPending(r)
  );
  const pendingCount = rows.filter(isPending).length;

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages - 1);
  const visible = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

  React.useEffect(() => {
    setPage(0);
  }, [filter, rows]);

  if (rows.length === 0) {
    return embedded ? (
      <div className="pz-history" style={{ paddingBottom: 8 }}>
        <div className="pz-empty">No posts in the queue.</div>
      </div>
    ) : null;
  }

  return (
    <div className="pz-history" style={{ paddingBottom: 8 }}>
      {!embedded && (
        <div className="pz-history-head">
          <div className="pz-history-title">
            Post Queue ({rows.length}
            {pendingCount > 0 ? `, ${pendingCount} not sent` : ''})
          </div>
          {onClear && (
            <button className="pz-clear-btn" onClick={onClear}>Clear ›</button>
          )}
        </div>
      )}

      <div className="pz-filter-bar" style={{ padding: 0 }}>
        {FILTERS.map((f) => {
          const count =
            f === 'all'
              ? rows.length
              : f === 'pending'
              ? pendingCount
              : rows.length - pendingCount;
          return (
            <button
              key={f}
              className={`pz-filter-btn${filter === f ? ' active' : ''}`}
              onClick={() => setFilter(f)}
              disabled={count === 0}
            >
              {FILTER_LABEL[f]}
              <span className="pz-filter-count">{count}</span>
            </button>
          );
        })}
      </div>

      {filtered.length === 0 ? (
        <div className="pz-empty">Nothing here.</div>
      ) : (
        <>
          <div className="pz-list">
            {visible.map((row) => (
              <QueueRow
                key={row.state.taskId}
                row={row}
                onPublishNow={onPublishNow}
                onCancel={onCancel}
                onSync={onSync}
                onRetry={onRetry}
                onRemove={onRemove}
              />
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
