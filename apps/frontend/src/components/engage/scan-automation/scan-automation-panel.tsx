'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import clsx from 'clsx';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useExtensionDetected } from '@gitroom/frontend/components/engage/signal-feed/use-extension-detected';
import {
  buildScanUnitRows,
  EngageScanAutomationConfig,
} from './scan-automation.model';
import { EngageScanRunSummary, requestEngageScan } from './request-engage-scan';

type PlatformFilter = 'all' | 'x' | 'reddit';

function formatAbsolute(value: string | null | undefined): string {
  if (!value) return 'Not scanned';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function formatRelative(value: string | null | undefined): string {
  if (!value) return 'due now';
  const minutes = Math.round((new Date(value).getTime() - Date.now()) / 60_000);
  if (Math.abs(minutes) < 1) return 'now';
  if (Math.abs(minutes) < 60) {
    return minutes > 0 ? `in ${minutes}m` : `${Math.abs(minutes)}m ago`;
  }
  const hours = Math.round(Math.abs(minutes) / 60);
  return minutes > 0 ? `in ${hours}h` : `${hours}h ago`;
}

function platformMark(platform: string): string {
  if (platform === 'x') return '𝕏';
  if (platform === 'reddit') return 'r/';
  return '•';
}

export function ScanAutomationPanel() {
  const fetch = useFetch();
  const { detected, version } = useExtensionDetected();
  const [filter, setFilter] = useState<PlatformFilter>('all');
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [summary, setSummary] = useState<EngageScanRunSummary | null>(null);

  const { data, error, isLoading, mutate } = useSWR<EngageScanAutomationConfig>(
    '/engage/config',
    async (url) => {
      const response = await fetch(url);
      if (!response.ok)
        throw new Error(`Engage config returned ${response.status}`);
      return response.json();
    },
    { refreshInterval: 60_000 }
  );

  const units = useMemo(() => buildScanUnitRows(data ?? {}), [data]);
  const visibleUnits = units.filter(
    (unit) => filter === 'all' || unit.platform === filter
  );
  const dueCount = units.filter((unit) => unit.due).length;
  const cadence =
    data?.scanIntervals?.scanIntervalHours ??
    data?.entitlement?.limits?.scanIntervalHours ??
    24;

  const run = async () => {
    setRunning(true);
    setRunError(null);
    setSummary(null);
    try {
      const result = await requestEngageScan();
      setSummary(result);
      await mutate();
    } catch (cause) {
      setRunError(cause instanceof Error ? cause.message : 'Scan failed');
    } finally {
      setRunning(false);
    }
  };

  return (
    <main className="min-h-full bg-[#0b0f14] text-[#e8edf2]">
      <section
        className="relative overflow-hidden border-b border-[#202a34] px-6 py-8 lg:px-10"
        style={{
          backgroundImage:
            'linear-gradient(rgba(56,189,248,.045) 1px, transparent 1px), linear-gradient(90deg, rgba(56,189,248,.045) 1px, transparent 1px)',
          backgroundSize: '28px 28px',
        }}
      >
        <div className="relative mx-auto flex max-w-6xl flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="mb-3 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.24em] text-cyan-400">
              <span className="h-1.5 w-1.5 rounded-full bg-cyan-400 shadow-[0_0_12px_#22d3ee]" />
              Browser-assisted collection
            </div>
            <h2 className="text-3xl font-semibold tracking-[-0.03em] text-white">
              Engage Scan Automation
            </h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-400">
              The extension wakes every 15 minutes. The server releases only due
              units, and X scans run inside a real browser page with your
              session.
            </p>
          </div>

          <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center">
            <div
              className={clsx(
                'flex items-center gap-2 border px-3 py-2 font-mono text-xs',
                detected === true
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                  : detected === false
                  ? 'border-amber-500/30 bg-amber-500/10 text-amber-300'
                  : 'border-slate-700 bg-slate-900 text-slate-400'
              )}
            >
              <span
                className={clsx(
                  'h-1.5 w-1.5 rounded-full',
                  detected === true
                    ? 'bg-emerald-400'
                    : detected === false
                    ? 'bg-amber-400'
                    : 'animate-pulse bg-slate-500'
                )}
              />
              {detected === true
                ? `Extension online${version ? ` · v${version}` : ''}`
                : detected === false
                ? 'Extension not detected'
                : 'Checking extension'}
            </div>
            <button
              type="button"
              onClick={run}
              disabled={running || detected !== true || data?.enabled === false}
              className="border border-cyan-300/50 bg-cyan-300 px-5 py-2.5 text-sm font-semibold text-[#071016] transition hover:bg-cyan-200 disabled:cursor-not-allowed disabled:border-slate-700 disabled:bg-slate-800 disabled:text-slate-500"
            >
              {running ? 'Running scan…' : 'Run due scans'}
            </button>
          </div>
        </div>
      </section>

      <div className="mx-auto max-w-6xl space-y-6 px-6 py-7 lg:px-10">
        {data?.enabled === false && (
          <div className="flex items-center justify-between border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
            <span>Engage automation is disabled for this workspace.</span>
            <Link href="/engage/settings" className="font-semibold underline">
              Open settings
            </Link>
          </div>
        )}

        {runError && (
          <div className="border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
            {runError}
          </div>
        )}

        {summary && (
          <div className="grid border border-emerald-500/25 bg-emerald-500/[0.06] sm:grid-cols-4">
            {[
              ['Units scanned', summary.units],
              ['Posts found', summary.posts],
              ['Accepted', summary.accepted],
              ['Stopped', summary.stoppedReason],
            ].map(([label, value]) => (
              <div
                key={label}
                className="border-b border-emerald-500/15 px-4 py-3 last:border-0 sm:border-b-0 sm:border-r"
              >
                <div className="font-mono text-[10px] uppercase tracking-widest text-emerald-400/70">
                  {label}
                </div>
                <div className="mt-1 text-lg font-semibold text-emerald-100">
                  {value}
                </div>
              </div>
            ))}
          </div>
        )}

        <section className="grid gap-px border border-[#202a34] bg-[#202a34] sm:grid-cols-2 lg:grid-cols-4">
          {[
            ['Cadence', `${cadence}h`, 'per scan unit'],
            ['Active units', units.length, 'keywords · accounts · channels'],
            [
              'Due now',
              dueCount,
              dueCount ? 'ready for browser scan' : 'all caught up',
            ],
            [
              'Last completed',
              formatRelative(data?.scanStatus?.lastScanAt),
              formatAbsolute(data?.scanStatus?.lastScanAt),
            ],
          ].map(([label, value, note]) => (
            <div key={label} className="bg-[#10161d] px-5 py-4">
              <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-slate-500">
                {label}
              </div>
              <div className="mt-2 text-2xl font-semibold tracking-tight text-white">
                {value}
              </div>
              <div className="mt-1 text-xs text-slate-500">{note}</div>
            </div>
          ))}
        </section>

        <section className="border border-[#202a34] bg-[#10161d]">
          <div className="flex flex-col gap-3 border-b border-[#202a34] px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h3 className="text-sm font-semibold text-white">Scan units</h3>
              <p className="mt-1 text-xs text-slate-500">
                Each platform and source has an independent cursor and due time.
              </p>
            </div>
            <div className="flex gap-1">
              {(['all', 'x', 'reddit'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setFilter(value)}
                  className={clsx(
                    'px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider transition',
                    filter === value
                      ? 'bg-slate-200 text-slate-950'
                      : 'text-slate-500 hover:bg-slate-800 hover:text-slate-200'
                  )}
                >
                  {value}
                </button>
              ))}
            </div>
          </div>

          {isLoading ? (
            <div className="px-5 py-12 text-center font-mono text-xs text-slate-500">
              Loading automation state…
            </div>
          ) : error ? (
            <div className="px-5 py-12 text-center text-sm text-rose-400">
              Failed to load scan automation state.
            </div>
          ) : visibleUnits.length === 0 ? (
            <div className="px-5 py-12 text-center text-sm text-slate-500">
              No active scan units for this filter.
            </div>
          ) : (
            <div className="divide-y divide-[#202a34]">
              {visibleUnits.map((unit) => (
                <div
                  key={unit.id}
                  className="grid gap-3 px-4 py-3 transition hover:bg-white/[0.025] sm:grid-cols-[48px_minmax(0,1fr)_150px_150px_90px] sm:items-center"
                >
                  <div className="font-mono text-sm font-semibold text-cyan-300">
                    {platformMark(unit.platform)}
                  </div>
                  <div className="min-w-0">
                    <div className="truncate text-sm text-slate-200">
                      {unit.label}
                    </div>
                    <div className="mt-0.5 font-mono text-[10px] uppercase tracking-wider text-slate-600">
                      {unit.type}
                    </div>
                  </div>
                  <div>
                    <div className="font-mono text-[9px] uppercase tracking-wider text-slate-600 sm:hidden">
                      Last scan
                    </div>
                    <div className="font-mono text-xs text-slate-400">
                      {formatAbsolute(unit.lastScannedAt)}
                    </div>
                  </div>
                  <div>
                    <div className="font-mono text-[9px] uppercase tracking-wider text-slate-600 sm:hidden">
                      Next due
                    </div>
                    <div className="font-mono text-xs text-slate-400">
                      {formatRelative(unit.nextScanAt)}
                    </div>
                  </div>
                  <div className="sm:text-right">
                    <span
                      className={clsx(
                        'inline-flex border px-2 py-1 font-mono text-[10px] uppercase tracking-wider',
                        unit.due
                          ? 'border-amber-400/30 bg-amber-400/10 text-amber-300'
                          : 'border-emerald-400/20 bg-emerald-400/[0.07] text-emerald-400'
                      )}
                    >
                      {unit.due ? 'Due' : 'Cooling'}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="grid gap-3 lg:grid-cols-4">
          {[
            [
              '01',
              '15-minute alarm',
              'The extension wakes without keeping a tab open.',
            ],
            [
              '02',
              'Server due gate',
              'Cadence and leases prevent premature or duplicate scans.',
            ],
            [
              '03',
              'Real browser page',
              'X creates its own request with the active browser session.',
            ],
            [
              '04',
              'Immediate ingest',
              'Each completed unit is parsed and submitted before the next.',
            ],
          ].map(([number, title, description]) => (
            <div key={number} className="border-l border-[#2b3947] px-4 py-2">
              <div className="font-mono text-[10px] text-cyan-500">
                {number}
              </div>
              <div className="mt-2 text-sm font-medium text-slate-200">
                {title}
              </div>
              <p className="mt-1 text-xs leading-5 text-slate-500">
                {description}
              </p>
            </div>
          ))}
        </section>
      </div>
    </main>
  );
}
