import React, { FC, useState } from 'react';
import type { PublishQueueRow } from '@gitroom/extension/pages/popup/hooks/usePublishQueueState';

// Which clear operation the user picked. Only local publish HISTORY is
// clearable here (published / error / canceled rows). "Queued (not sent)" was
// removed: the queue is a transient buffer of DUE posts pulled from the DB, so
// clearing it wouldn't unschedule anything (the next poll re-pulls) — scheduling
// and cancellation live in the web app.
type SettledAction = 'settled-1w' | 'settled-1m' | 'settled-all';
type ClearAction = SettledAction;

const WEEK_MS = 604_800_000;
const MONTH_MS = 2_592_000_000;

// undefined window = "all history, regardless of age".
const SETTLED_WINDOW: Record<SettledAction, number | undefined> = {
  'settled-1w': WEEK_MS,
  'settled-1m': MONTH_MS,
  'settled-all': undefined,
};

const ACTIONS: { action: ClearAction; label: string }[] = [
  { action: 'settled-1w', label: 'Published history · older than 1 week' },
  { action: 'settled-1m', label: 'Published history · older than 1 month' },
  { action: 'settled-all', label: 'Published history · all' },
];

// Statuses that are done and safe to sweep as "history". Active rows
// (queued / publishing / sent) are deliberately excluded — mirrors isActive()
// in the service-worker queue.
const SETTLED_STATUSES = new Set(['published', 'error', 'canceled']);

// Best-effort settled time, mirroring settledTimestamp() in queue.ts so the
// preview counts match what the SW will actually remove.
function settledTimestamp(row: PublishQueueRow): number {
  const iso = row.state.publishedAt || row.state.publishAt;
  if (iso) {
    const t = Date.parse(iso);
    if (!Number.isNaN(t)) return t;
  }
  return row.dueAt || 0;
}

function matchCount(rows: PublishQueueRow[], action: ClearAction): number {
  const window = SETTLED_WINDOW[action];
  const cutoff = window != null ? Date.now() - window : Infinity;
  return rows.filter(
    (r) => SETTLED_STATUSES.has(r.state.status) && settledTimestamp(r) < cutoff
  ).length;
}

export const ClearQueuePage: FC<{
  rows: PublishQueueRow[];
  onClearSettled: (olderThanMs?: number) => Promise<void>;
  onBack: () => void;
}> = ({ rows, onClearSettled, onBack }) => {
  const [pending, setPending] = useState<ClearAction | null>(null);
  const pendingCount = pending ? matchCount(rows, pending) : 0;

  const handleConfirm = async () => {
    if (!pending) return;
    await onClearSettled(SETTLED_WINDOW[pending]);
    onBack();
  };

  return (
    <div className="pz">
      <div className="pz-header">
        <div className="pz-header-row">
          <button className="pz-back-btn" onClick={onBack}>←</button>
          <div className="pz-title">Clear Publish History</div>
        </div>
      </div>

      <div className="pz-clear-page">
        {pending ? (
          <div className="pz-confirm">
            <p className="pz-confirm-msg">
              {`Delete ${pendingCount} history record${pendingCount !== 1 ? 's' : ''}?`}
              <br />
              This cannot be undone.
            </p>
            <button className="pz-btn pz-btn-danger" onClick={handleConfirm}>
              Delete
            </button>
            <button className="pz-btn-ghost" onClick={() => setPending(null)}>
              Cancel
            </button>
          </div>
        ) : (
          ACTIONS.map((a) => {
            const n = matchCount(rows, a.action);
            return (
              <button
                key={a.action}
                className="pz-range-btn"
                disabled={n === 0}
                onClick={() => setPending(a.action)}
              >
                <span>{a.label}</span>
                <span className="pz-range-count">{n} records</span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
};
