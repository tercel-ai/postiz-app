'use client';

import { FC, useCallback, useEffect, useRef, useState } from 'react';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useToaster } from '@gitroom/react/toaster/toaster';

// Local-state time input — commits only on blur (or Enter) instead of firing a
// PATCH per keystroke. Prevents PATCH-spam when the user clicks the time
// spinner arrows.
//
// Focus-aware sync: when an unrelated SWR refetch returns a new settings object
// (e.g. user toggled timezone for the same account), the `value` prop changes.
// Without the focus guard, we'd overwrite the user's in-progress edits. The ref
// tracks focus so the effect only resyncs when the user is NOT typing.
const DeferredTimeInput: FC<{
  id: string;
  value: string;
  onCommit: (next: string) => void;
}> = ({ id, value, onCommit }) => {
  const [local, setLocal] = useState(value);
  const focusedRef = useRef(false);
  useEffect(() => {
    if (!focusedRef.current) setLocal(value);
  }, [value]);
  return (
    <input
      id={id}
      type="time"
      value={local}
      onChange={(e) => setLocal(e.target.value)}
      onFocus={() => { focusedRef.current = true; }}
      onBlur={() => {
        focusedRef.current = false;
        if (local !== value) onCommit(local);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
      className="w-full bg-[#0f1219] border border-[#2d3748] text-white rounded px-2 py-1 text-sm"
    />
  );
};

const STRATEGIES = [
  'EXPERT_ANSWER',
  'DATA_BACKED',
  'EMPATHY_LED',
  'CONTRARIAN',
  'QUESTION_LED',
  'QUICK_TAKE',
  'AMPLIFY',
];
const TIMEZONES = [
  'Asia/Shanghai',
  'Asia/Tokyo',
  'America/New_York',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Paris',
  'UTC',
];

// Platforms whose engage replies go out through a CONNECTED account, so
// "which account replies" is a real choice. Everything else replies through the
// extension's own browser session — no account is picked, which is why those
// platforms appear only in the per-platform policy block below.
const POLICY_PLATFORMS = ['reddit', 'x'] as const;

interface Integration {
  id: string;
  name: string;
  picture?: string;
  providerIdentifier: string;
  /** May Engage reply as this account, for this project. Defaults to true. */
  engageEnabled: boolean;
}

/** Per-(project, platform) reply policy — EngageConfig.replyPolicies. */
interface ReplyPolicy {
  autoReplyEnabled?: boolean;
  windowStart?: string;
  windowEnd?: string;
  timezone?: string;
  defaultStrategy?: string;
}

export function ReplyAccounts() {
  const fetch = useFetch();
  const toaster = useToaster();

  const { data, error, mutate } = useSWR('/engage/reply-accounts', async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`engage/reply-accounts returned ${res.status}`);
    return res.json() as Promise<Integration[]>;
  });

  // The per-platform policy lives on the Engage CONFIG, not on an account —
  // Reddit and friends reply through the browser session and have no account to
  // hang it off. Same reason it is read from /engage/config rather than here.
  const {
    data: config,
    error: configError,
    mutate: mutateConfig,
  } = useSWR('/engage/config', async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`engage/config returned ${res.status}`);
    return res.json() as Promise<{ replyPolicies?: Record<string, ReplyPolicy> }>;
  });

  const policies = config?.replyPolicies ?? {};

  const updatePolicy = useCallback(
    async (platform: string, patch: ReplyPolicy) => {
      // The column is replaced wholesale, so merge locally first — a partial
      // POST would drop every other platform's policy.
      const next = {
        ...policies,
        [platform]: { ...(policies[platform] ?? {}), ...patch },
      };
      try {
        const res = await fetch('/engage/config', {
          method: 'POST',
          body: JSON.stringify({ replyPolicies: next }),
        });
        if (!res.ok) {
          toaster.show('Failed to update reply policy', 'warning');
          return;
        }
        mutateConfig();
      } catch {
        toaster.show('Failed to update reply policy', 'warning');
      }
    },
    [fetch, mutateConfig, policies, toaster]
  );

  const update = useCallback(
    async (integrationId: string, patch: Record<string, unknown>) => {
      try {
        const res = await fetch(`/engage/reply-accounts/${integrationId}`, {
          method: 'PATCH',
          body: JSON.stringify(patch),
        });
        if (!res.ok) {
          toaster.show('Failed to update settings', 'warning');
          return;
        }
        mutate();
      } catch {
        toaster.show('Failed to update settings', 'warning');
      }
    },
    [fetch, mutate, toaster]
  );

  const accounts = data ?? [];

  if (error) {
    return (
      <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg flex items-center justify-between">
        <p className="text-sm text-red-400">Failed to load reply accounts.</p>
        <button
          onClick={() => mutate()}
          className="text-xs text-blue-400 hover:text-blue-300"
        >
          Retry
        </button>
      </div>
    );
  }

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
    <div className="space-y-6">
      {/* ── Per-platform reply policy ───────────────────────────────────── */}
      <div className="space-y-3">
        <p className="text-sm text-gray-400">
          Unattended replying, per platform. The project&apos;s operation plan
          decides how MANY replies a day; these decide where and when.
        </p>
        {configError && (
          <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg flex items-center justify-between">
            <p className="text-sm text-red-400">Failed to load reply policies.</p>
            <button
              onClick={() => mutateConfig()}
              className="text-xs text-blue-400 hover:text-blue-300"
            >
              Retry
            </button>
          </div>
        )}
        {POLICY_PLATFORMS.map((platform) => {
          const policy = policies[platform] ?? {};
          return (
            <div
              key={platform}
              className="p-3 bg-[#0f1219] border border-[#2d3748] rounded-lg space-y-3"
            >
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-300 capitalize">{platform}</span>
                <button
                  onClick={() =>
                    updatePolicy(platform, {
                      autoReplyEnabled: !policy.autoReplyEnabled,
                    })
                  }
                  className={`text-xs font-medium ${
                    policy.autoReplyEnabled ? 'text-green-400' : 'text-gray-600'
                  }`}
                >
                  {policy.autoReplyEnabled ? 'ON' : 'OFF'}
                </button>
              </div>

              {policy.autoReplyEnabled && (
                <div className="grid grid-cols-2 gap-3 pl-3 border-l-2 border-[#2d3748]">
                  <div>
                    <label
                      htmlFor={`start-${platform}`}
                      className="text-xs text-gray-500 block mb-1"
                    >
                      Start
                    </label>
                    <DeferredTimeInput
                      id={`start-${platform}`}
                      value={policy.windowStart ?? '09:00'}
                      onCommit={(next) => updatePolicy(platform, { windowStart: next })}
                    />
                  </div>
                  <div>
                    <label
                      htmlFor={`end-${platform}`}
                      className="text-xs text-gray-500 block mb-1"
                    >
                      End
                    </label>
                    <DeferredTimeInput
                      id={`end-${platform}`}
                      value={policy.windowEnd ?? '18:00'}
                      onCommit={(next) => updatePolicy(platform, { windowEnd: next })}
                    />
                  </div>
                  <div>
                    <label
                      htmlFor={`tz-${platform}`}
                      className="text-xs text-gray-500 block mb-1"
                    >
                      Timezone
                    </label>
                    <select
                      id={`tz-${platform}`}
                      value={policy.timezone ?? 'Asia/Shanghai'}
                      onChange={(e) =>
                        updatePolicy(platform, { timezone: e.target.value })
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
                  <div>
                    <label
                      htmlFor={`strategy-${platform}`}
                      className="text-xs text-gray-500 block mb-1"
                    >
                      Strategy
                    </label>
                    <select
                      id={`strategy-${platform}`}
                      value={policy.defaultStrategy ?? 'EXPERT_ANSWER'}
                      onChange={(e) =>
                        updatePolicy(platform, { defaultStrategy: e.target.value })
                      }
                      className="w-full bg-[#0f1219] border border-[#2d3748] text-white rounded px-2 py-1 text-sm"
                    >
                      {STRATEGIES.map((st) => (
                        <option key={st} value={st}>
                          {st}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* ── Which connected accounts may reply ──────────────────────────── */}
      <div className="space-y-3">
        <p className="text-sm text-gray-400">
          Connected accounts Engage may reply as. Only platforms that reply
          through an account appear here — everything else replies with your
          browser session.
        </p>
        {accounts.map((acc) => (
          <div
            key={acc.id}
            className="p-3 bg-[#0f1219] border border-[#2d3748] rounded-lg flex items-center gap-3"
          >
            {acc.picture && (
              <img
                src={acc.picture}
                alt=""
                className="w-8 h-8 rounded-full"
              />
            )}
            <div className="min-w-0">
              <p className="text-sm text-white truncate">{acc.name}</p>
              <p className="text-xs text-gray-500">{acc.providerIdentifier}</p>
            </div>
            <div className="ml-auto flex items-center gap-2">
              <span className="text-xs text-gray-400">Engage</span>
              <button
                onClick={() =>
                  update(acc.id, { engageEnabled: !acc.engageEnabled })
                }
                className={`text-sm font-medium ${
                  acc.engageEnabled ? 'text-green-400' : 'text-gray-600'
                }`}
              >
                {acc.engageEnabled ? 'ON' : 'OFF'}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
