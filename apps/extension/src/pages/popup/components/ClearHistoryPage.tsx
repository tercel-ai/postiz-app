import React, { FC, useState } from 'react';
import { ClearRange, ReplyHistoryItem } from '@gitroom/extension/utils/reply.history';

const RANGES: { range: ClearRange; label: string }[] = [
  { range: '1d', label: 'Older than 1 day' },
  { range: '1w', label: 'Older than 1 week' },
  { range: '1m', label: 'Older than 1 month' },
  { range: 'all', label: 'All records' },
];

function matchCount(items: ReplyHistoryItem[], range: ClearRange): number {
  if (range === 'all') return items.length;
  const ms = { '1d': 86_400_000, '1w': 604_800_000, '1m': 2_592_000_000 }[range];
  return items.filter((i) => Date.now() - i.createdAt > ms).length;
}

export const ClearHistoryPage: FC<{
  items: ReplyHistoryItem[];
  onClear: (range: ClearRange) => void;
  onBack: () => void;
}> = ({ items, onClear, onBack }) => {
  const [pending, setPending] = useState<ClearRange | null>(null);
  const pendingCount = pending ? matchCount(items, pending) : 0;

  const handleConfirm = () => {
    if (!pending) return;
    onClear(pending);
    onBack();
  };

  return (
    <div className="pz">
      <div className="pz-header">
        <div className="pz-header-row">
          <button className="pz-back-btn" onClick={onBack}>←</button>
          <div className="pz-title">Clear History</div>
        </div>
      </div>

      <div className="pz-clear-page">
        {pending ? (
          <div className="pz-confirm">
            <p className="pz-confirm-msg">
              Delete {pendingCount} record{pendingCount !== 1 ? 's' : ''}?<br />
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
          RANGES.map((r) => {
            const n = matchCount(items, r.range);
            return (
              <button
                key={r.range}
                className="pz-range-btn"
                disabled={n === 0}
                onClick={() => setPending(r.range)}
              >
                <span>{r.label}</span>
                <span className="pz-range-count">{n} records</span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
};
