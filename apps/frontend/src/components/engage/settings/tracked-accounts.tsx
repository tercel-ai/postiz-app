'use client';

import { useState, useCallback } from 'react';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useToaster } from '@gitroom/react/toaster/toaster';

interface TrackedAccount {
  id: string;
  platform: string;
  username: string;
  displayName?: string;
  picture?: string;
  categoryLabel?: string;
  enabled: boolean;
}

export function TrackedAccounts() {
  const fetch = useFetch();
  const toaster = useToaster();

  const { data, error, mutate } = useSWR('/engage/tracked-accounts', async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`engage/tracked-accounts returned ${res.status}`);
    return res.json() as Promise<TrackedAccount[]>;
  });

  const [username, setUsername] = useState('');
  const [category, setCategory] = useState('');

  const accounts = data ?? [];

  const addAccount = useCallback(async () => {
    const u = username.replace('@', '').trim();
    if (!u) return;
    try {
      const res = await fetch('/engage/tracked-accounts', {
        method: 'POST',
        body: JSON.stringify({ username: u, categoryLabel: category || undefined }),
      });
      if (!res.ok) {
        toaster.show('Failed (may already exist)', 'warning');
        return;
      }
      setUsername('');
      setCategory('');
      mutate();
      toaster.show('Account added', 'success');
    } catch {
      toaster.show('Failed (may already exist)', 'warning');
    }
  }, [username, category, fetch, mutate, toaster]);

  const removeAccount = useCallback(
    async (id: string) => {
      try {
        const res = await fetch(`/engage/tracked-accounts/${id}`, { method: 'DELETE' });
        if (!res.ok) {
          toaster.show('Failed to remove account', 'warning');
          return;
        }
        mutate();
      } catch {
        toaster.show('Failed to remove account', 'warning');
      }
    },
    [fetch, mutate, toaster]
  );

  const toggleAccount = useCallback(
    async (acc: TrackedAccount) => {
      try {
        const res = await fetch(`/engage/tracked-accounts/${acc.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ enabled: !acc.enabled }),
        });
        if (!res.ok) {
          toaster.show('Failed to update account', 'warning');
          return;
        }
        mutate();
      } catch {
        toaster.show('Failed to update account', 'warning');
      }
    },
    [fetch, mutate, toaster]
  );

  return (
    <div>
      {error && (
        <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded-lg flex items-center justify-between">
          <p className="text-sm text-red-400">Failed to load tracked accounts.</p>
          <button
            onClick={() => mutate()}
            className="text-xs text-blue-400 hover:text-blue-300"
          >
            Retry
          </button>
        </div>
      )}
      <p className="text-sm text-gray-400 mb-4">
        Track external X accounts checked every 3 hours. Posts from these accounts receive a +5 score bonus and appear first in the Signal Feed.
      </p>

      <div className="flex gap-2 mb-6">
        <input
          type="text"
          className="flex-1 bg-[#1e2536] border border-[#2d3748] text-white rounded-lg px-4 py-2 text-sm focus:outline-none focus:border-blue-500"
          placeholder="@username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addAccount()}
        />
        <input
          type="text"
          className="w-36 bg-[#1e2536] border border-[#2d3748] text-white rounded-lg px-3 py-2 text-sm"
          placeholder="Label (optional)"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        />
        <button
          onClick={addAccount}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors"
        >
          + Add
        </button>
      </div>

      <div className="space-y-2">
        {accounts.map((acc) => (
          <div
            key={acc.id}
            className="flex items-center gap-3 bg-[#1a2035] rounded-lg px-4 py-3"
          >
            {/* Real avatar when known (backfilled during scan), else initials */}
            {acc.picture ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={acc.picture}
                alt={acc.username}
                className="w-8 h-8 rounded-full object-cover shrink-0"
              />
            ) : (
              <div className="w-8 h-8 rounded-full bg-[#2d3748] flex items-center justify-center text-xs font-bold text-white uppercase shrink-0">
                {acc.username.slice(0, 2)}
              </div>
            )}
            <div className="flex-1 min-w-0">
              <span className="text-white text-sm">@{acc.username}</span>
              {acc.categoryLabel && (
                <span className="ml-2 text-xs bg-[#2d3748] text-gray-300 px-1.5 py-0.5 rounded">
                  {acc.categoryLabel}
                </span>
              )}
            </div>
            <span className="text-xs text-gray-500 uppercase">{acc.platform}</span>
            <button
              onClick={() => toggleAccount(acc)}
              className={`text-xs font-medium w-8 ${
                acc.enabled ? 'text-green-400' : 'text-gray-600'
              }`}
            >
              {acc.enabled ? 'ON' : 'OFF'}
            </button>
            <button
              onClick={() => removeAccount(acc.id)}
              className="text-gray-600 hover:text-red-400 text-lg leading-none"
            >
              ×
            </button>
          </div>
        ))}

        {accounts.length === 0 && (
          <p className="text-center text-gray-500 text-sm py-8">
            No tracked accounts yet. Add an X account to start monitoring.
          </p>
        )}
      </div>
    </div>
  );
}
