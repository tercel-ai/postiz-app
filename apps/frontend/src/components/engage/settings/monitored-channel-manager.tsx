'use client';

import { useState, useCallback } from 'react';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useToaster } from '@gitroom/react/toaster/toaster';

const PLATFORM_COLORS: Record<string, string> = {
  reddit: 'bg-orange-500/20 text-orange-400',
  youtube: 'bg-red-500/20 text-red-400',
  qq: 'bg-blue-500/20 text-blue-400',
  discord: 'bg-indigo-500/20 text-indigo-400',
};

const PLATFORMS = ['reddit', 'youtube', 'qq', 'discord'];

interface Channel {
  id: string;
  platform: string;
  channelId: string;
  channelName: string;
  audienceSize: number;
  enabled: boolean;
}

export function MonitoredChannelManager() {
  const fetch = useFetch();
  const toaster = useToaster();

  const { data, mutate } = useSWR('/engage/monitored-channels', async (url) => {
    const res = await fetch(url);
    return res.json() as Promise<Channel[]>;
  });

  const [showAdd, setShowAdd] = useState(false);
  const [searchPlatform, setSearchPlatform] = useState('reddit');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<
    Array<{
      channelId: string;
      channelName: string;
      audienceSize: number;
      platform: string;
    }>
  >([]);
  const [searching, setSearching] = useState(false);

  const channels = data ?? [];

  const handleSearch = useCallback(async () => {
    if (!searchQuery.trim()) return;
    setSearching(true);
    try {
      const res = await fetch('/engage/monitored-channels/search', {
        method: 'POST',
        body: JSON.stringify({ platform: searchPlatform, query: searchQuery }),
      });
      const results = await res.json();
      setSearchResults(results);
    } catch {
      toaster.show('Search failed', 'warning');
    } finally {
      setSearching(false);
    }
  }, [searchPlatform, searchQuery, fetch, toaster]);

  const addChannel = useCallback(
    async (ch: { channelId: string; channelName: string; audienceSize: number; platform: string }) => {
      try {
        await fetch('/engage/monitored-channels', {
          method: 'POST',
          body: JSON.stringify(ch),
        });
        mutate();
        setShowAdd(false);
        setSearchResults([]);
        setSearchQuery('');
        toaster.show('Channel added', 'success');
      } catch {
        toaster.show('Failed to add (may already exist)', 'warning');
      }
    },
    [fetch, mutate, toaster]
  );

  const toggleChannel = useCallback(
    async (ch: Channel) => {
      await fetch(`/engage/monitored-channels/${ch.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: !ch.enabled }),
      });
      mutate();
    },
    [fetch, mutate]
  );

  const removeChannel = useCallback(
    async (id: string) => {
      await fetch(`/engage/monitored-channels/${id}`, { method: 'DELETE' });
      mutate();
    },
    [fetch, mutate]
  );

  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <p className="text-sm text-gray-400">
          Subscribe to communities like r/SEO, YouTube channels, or QQ groups.
        </p>
        <button
          onClick={() => setShowAdd(!showAdd)}
          className="text-sm px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors"
        >
          + Add Channel
        </button>
      </div>

      {/* Add channel search */}
      {showAdd && (
        <div className="mb-6 p-4 bg-[#1a2035] rounded-lg border border-[#2d3748]">
          <div className="flex gap-2 mb-3">
            <select
              value={searchPlatform}
              onChange={(e) => {
                setSearchPlatform(e.target.value);
                setSearchResults([]);
              }}
              className="bg-[#0f1219] border border-[#2d3748] text-white rounded-lg px-3 py-2 text-sm"
            >
              {PLATFORMS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <input
              type="text"
              className="flex-1 bg-[#0f1219] border border-[#2d3748] text-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
              placeholder="Search..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            />
            <button
              onClick={handleSearch}
              disabled={searching}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 text-white rounded-lg text-sm"
            >
              {searching ? '...' : 'Search'}
            </button>
          </div>

          {searchResults.length > 0 && (
            <div className="space-y-1">
              {searchResults.map((r) => (
                <div
                  key={r.channelId}
                  className="flex items-center justify-between bg-[#0f1219] rounded-lg px-3 py-2"
                >
                  <div>
                    <span className="text-sm text-white">{r.channelName}</span>
                    <span className="text-xs text-gray-500 ml-2">
                      {r.audienceSize.toLocaleString()} members
                    </span>
                  </div>
                  <button
                    onClick={() => addChannel(r)}
                    className="text-xs text-blue-400 hover:text-blue-300"
                  >
                    + Add
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Channel grid */}
      <div className="grid grid-cols-2 gap-3">
        {channels.map((ch) => (
          <div
            key={ch.id}
            className="bg-[#1a2035] rounded-lg p-4 flex items-center justify-between"
          >
            <div className="flex items-center gap-3">
              <span
                className={`text-xs px-2 py-0.5 rounded font-medium ${
                  PLATFORM_COLORS[ch.platform] ?? 'bg-gray-500/20 text-gray-400'
                }`}
              >
                {ch.platform}
              </span>
              <div>
                <p className="text-sm text-white">{ch.channelName}</p>
                <p className="text-xs text-gray-500">
                  {ch.audienceSize.toLocaleString()} members
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => toggleChannel(ch)}
                className={`text-xs font-medium ${
                  ch.enabled ? 'text-green-400' : 'text-gray-600'
                }`}
              >
                {ch.enabled ? 'ON' : 'OFF'}
              </button>
              <button
                onClick={() => removeChannel(ch.id)}
                className="text-gray-600 hover:text-red-400 text-lg"
              >
                ×
              </button>
            </div>
          </div>
        ))}

        {channels.length === 0 && (
          <div className="col-span-2 text-center text-gray-500 text-sm py-8">
            No channels yet. Add a community to monitor.
          </div>
        )}
      </div>
    </div>
  );
}
