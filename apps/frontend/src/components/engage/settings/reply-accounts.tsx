'use client';

import { useCallback } from 'react';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useToaster } from '@gitroom/react/toaster/toaster';

const STRATEGIES = ['EXPERT_ANSWER', 'DATA_BACKED', 'EMPATHY_LED'];
const TIMEZONES = [
  'Asia/Shanghai',
  'Asia/Tokyo',
  'America/New_York',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Paris',
  'UTC',
];

interface Integration {
  id: string;
  name: string;
  picture?: string;
  providerIdentifier: string;
  engageXReplyAccount?: {
    engageEnabled: boolean;
    autoReplyEnabled: boolean;
    autoReplyTimeStart?: string;
    autoReplyTimeEnd?: string;
    autoReplyTimezone?: string;
    defaultStrategy: string;
  } | null;
}

export function ReplyAccounts() {
  const fetch = useFetch();
  const toaster = useToaster();

  const { data, mutate } = useSWR('/engage/reply-accounts', async (url) => {
    const res = await fetch(url);
    return res.json() as Promise<Integration[]>;
  });

  const update = useCallback(
    async (integrationId: string, patch: Record<string, unknown>) => {
      try {
        await fetch(`/engage/reply-accounts/${integrationId}`, {
          method: 'PATCH',
          body: JSON.stringify(patch),
        });
        mutate();
      } catch {
        toaster.show('Failed to update settings', 'warning');
      }
    },
    [fetch, mutate, toaster]
  );

  const accounts = data ?? [];

  if (accounts.length === 0) {
    return (
      <div className="text-center text-gray-500 text-sm py-8">
        <p>No X accounts connected.</p>
        <p className="text-xs mt-1">
          Connect an X account in{' '}
          <a href="/integrations" className="text-blue-400 hover:underline">
            Integrations
          </a>{' '}
          first.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-400">
        Your own X accounts used to send Engage replies. Configure auto-reply
        time windows per account.
      </p>

      {accounts.map((acc) => {
        const settings = acc.engageXReplyAccount;
        return (
          <div
            key={acc.id}
            className="bg-[#1a2035] rounded-lg p-5 border border-[#2d3748]"
          >
            {/* Account header */}
            <div className="flex items-center gap-3 mb-4">
              {acc.picture && (
                <img
                  src={acc.picture}
                  alt=""
                  className="w-10 h-10 rounded-full"
                />
              )}
              <div>
                <p className="text-white font-medium">{acc.name}</p>
                <p className="text-xs text-gray-500">@{acc.name}</p>
              </div>
              {/* Enable toggle */}
              <div className="ml-auto flex items-center gap-2">
                <span className="text-xs text-gray-400">Engage</span>
                <button
                  onClick={() =>
                    update(acc.id, {
                      engageEnabled: !(settings?.engageEnabled ?? true),
                    })
                  }
                  className={`text-sm font-medium ${
                    settings?.engageEnabled !== false
                      ? 'text-green-400'
                      : 'text-gray-600'
                  }`}
                >
                  {settings?.engageEnabled !== false ? 'ON' : 'OFF'}
                </button>
              </div>
            </div>

            {/* Auto-reply section */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-300">Auto-reply</span>
                <button
                  onClick={() =>
                    update(acc.id, {
                      autoReplyEnabled: !(settings?.autoReplyEnabled ?? false),
                    })
                  }
                  className={`text-xs font-medium ${
                    settings?.autoReplyEnabled
                      ? 'text-green-400'
                      : 'text-gray-600'
                  }`}
                >
                  {settings?.autoReplyEnabled ? 'ON' : 'OFF'}
                </button>
              </div>

              {settings?.autoReplyEnabled && (
                <div className="grid grid-cols-3 gap-3 pl-3 border-l-2 border-[#2d3748]">
                  <div>
                    <label htmlFor={`start-${acc.id}`} className="text-xs text-gray-500 block mb-1">
                      Start
                    </label>
                    <input
                      id={`start-${acc.id}`}
                      type="time"
                      value={settings.autoReplyTimeStart ?? '09:00'}
                      onChange={(e) =>
                        update(acc.id, { autoReplyTimeStart: e.target.value })
                      }
                      className="w-full bg-[#0f1219] border border-[#2d3748] text-white rounded px-2 py-1 text-sm"
                    />
                  </div>
                  <div>
                    <label htmlFor={`end-${acc.id}`} className="text-xs text-gray-500 block mb-1">
                      End
                    </label>
                    <input
                      id={`end-${acc.id}`}
                      type="time"
                      value={settings.autoReplyTimeEnd ?? '18:00'}
                      onChange={(e) =>
                        update(acc.id, { autoReplyTimeEnd: e.target.value })
                      }
                      className="w-full bg-[#0f1219] border border-[#2d3748] text-white rounded px-2 py-1 text-sm"
                    />
                  </div>
                  <div>
                    <label htmlFor={`tz-${acc.id}`} className="text-xs text-gray-500 block mb-1">
                      Timezone
                    </label>
                    <select
                      id={`tz-${acc.id}`}
                      value={settings.autoReplyTimezone ?? 'Asia/Shanghai'}
                      onChange={(e) =>
                        update(acc.id, { autoReplyTimezone: e.target.value })
                      }
                      className="w-full bg-[#0f1219] border border-[#2d3748] text-white rounded px-2 py-1 text-sm"
                    >
                      {TIMEZONES.map((tz) => (
                        <option key={tz} value={tz}>
                          {tz}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              )}

              {/* Default strategy */}
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-300">Default strategy</span>
                <select
                  value={settings?.defaultStrategy ?? 'EXPERT_ANSWER'}
                  onChange={(e) =>
                    update(acc.id, { defaultStrategy: e.target.value })
                  }
                  className="bg-[#0f1219] border border-[#2d3748] text-white rounded px-2 py-1 text-sm"
                >
                  {STRATEGIES.map((s) => (
                    <option key={s} value={s}>
                      {s.replace(/_/g, ' ')}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
