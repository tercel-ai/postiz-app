'use client';

import { useState } from 'react';
import { KeywordManager } from './keyword-manager';
import { MonitoredChannelManager } from './monitored-channel-manager';
import { TrackedAccounts } from './tracked-accounts';
import { ReplyAccounts } from './reply-accounts';
import clsx from 'clsx';

const TABS = [
  { id: 'keywords', label: 'Keywords' },
  { id: 'channels', label: 'Channels' },
  { id: 'tracked', label: 'Tracked Accounts' },
  { id: 'reply', label: 'Reply Accounts' },
];

export function EngageSettings() {
  const [tab, setTab] = useState('keywords');

  return (
    <div className="p-6 max-w-4xl">
      {/* Sub-tabs */}
      <div className="flex gap-1 mb-6 border-b border-[#1e2536]">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={clsx(
              'px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px',
              tab === t.id
                ? 'border-blue-500 text-white'
                : 'border-transparent text-gray-500 hover:text-gray-300'
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'keywords' && <KeywordManager />}
      {tab === 'channels' && <MonitoredChannelManager />}
      {tab === 'tracked' && <TrackedAccounts />}
      {tab === 'reply' && <ReplyAccounts />}
    </div>
  );
}
