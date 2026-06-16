'use client';

import { FC, useState } from 'react';

// One past AI-generated reply draft for an opportunity (newest-first from the API).
// Mirrors the backend GenerationHistoryEntry (engage.repository.ts).
export interface GenerationHistoryEntry {
  content: string;
  length: 'short' | 'medium' | 'long';
  cost: number;
  strategy: string;
  brandStrength: number;
  mentions?: string[];
  billingTaskId: string;
  createdAt: string;
}

const LENGTH_LABEL: Record<string, string> = {
  short: '短',
  medium: '中',
  long: '长',
};

// Collapsed-by-default viewer for an opportunity's AI generation history. The user
// may regenerate a reply several times (each charges credits); this surfaces every
// version without spreading them across the card. Renders nothing when there is no
// history (the common case for older replies).
export const GenerationHistory: FC<{ history?: GenerationHistoryEntry[] }> = ({
  history,
}) => {
  const [open, setOpen] = useState(false);
  if (!history || history.length === 0) return null;

  return (
    <div className="mt-2">
      <button
        onClick={() => setOpen((o) => !o)}
        className="text-xs text-gray-400 hover:text-gray-200 transition-colors"
      >
        {open ? '▾' : '▸'} 生成历史 ({history.length})
      </button>

      {open && (
        <div className="mt-2 space-y-2 border-l border-[#2d3748] pl-3">
          {history.map((entry, i) => (
            <div
              key={entry.billingTaskId || i}
              className="bg-[#0f1219] rounded-lg p-2.5"
            >
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xs text-gray-500">
                  #{history.length - i}
                </span>
                <span className="text-xs bg-blue-900/40 text-blue-300 px-1.5 py-0.5 rounded">
                  {LENGTH_LABEL[entry.length] ?? entry.length}
                </span>
                <span className="text-xs text-gray-500" title="本次生成扣除的额度">
                  −{entry.cost} 额度
                </span>
                <span className="text-xs text-gray-600 ml-auto">
                  {new Date(entry.createdAt).toLocaleString()}
                </span>
              </div>
              <p className="text-xs text-gray-300 whitespace-pre-wrap break-words">
                {entry.content}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
