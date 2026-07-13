import React from 'react';
import { ENGAGE_EXTENSION_ACTION } from '@gitroom/extension/utils/executor/actions';
import { shouldAutoSyncConfigCache } from './scan-config-cache';

// ─── Types ────────────────────────────────────────────────────────────────────

interface InitialScan { platform: string; status: string; completedAt: string | null; error?: string | null }
interface KeywordScanCursor { platform: string; lastScannedAt: string | null; nextScanAt: string | null }
interface EngageCfgKeyword {
  id: string; keyword: string; enabled: boolean;
  weeklyHitCount?: number;
  scanCursors?: KeywordScanCursor[];
}
interface ScanCursorTiming { lastScannedAt: string | null; nextScanAt: string | null }
interface EngageCfgChannel {
  id: string; platform: string; channelId: string; channelName: string; enabled: boolean;
  lastScannedAt?: string | null;
  audienceSize?: number;
  // Real EngageScanCursor timing (source of truth); prefer over lastScannedAt,
  // which is a per-row field only the workflow writes.
  scanCursor?: ScanCursorTiming | null;
}
interface EngageCfgAccount {
  id: string; username: string; enabled: boolean;
  platform?: string;
  lastCheckedAt?: string | null;
  scanCursor?: ScanCursorTiming | null;
}
export interface EngageConfig {
  keywords: EngageCfgKeyword[];
  monitoredChannels: EngageCfgChannel[];
  trackedAccounts: EngageCfgAccount[];
  entitlement?: { limits?: { scanIntervalHours?: number }; plan?: string };
  scanIntervals?: { scanIntervalHours?: number; keywordHours?: number; channelHours?: number; trackedHours?: number };
  scanStatus?: {
    lastScanAt: string | null; nextScanAt: string | null;
    keyword?: { lastScanAt: string | null; nextScanAt: string | null };
    channel?:  { lastScanAt: string | null; nextScanAt: string | null };
    tracked?:  { lastScanAt: string | null; nextScanAt: string | null };
  };
}

export interface ScanTask {
  taskId: string;
  platform: 'x' | 'reddit';
  scanType: 'keyword' | 'channel' | 'tracked';
  scanKey: string;
  cursor: { lastSeenExternalId: string | null; lastSeenAt: string | null };
  pacing: { maxPages: number; pageSize: number; pageDelayMs: number; pageJitterMs: number; interUnitDelayMs: number; interUnitJitterMs: number; hourlyRequestCap: number };
  rawQuery?: string;
}
export interface ScanUnitSelector {
  platform: 'x' | 'reddit';
  scanType: 'keyword' | 'channel' | 'tracked';
  scanKey: string;
}
export interface SelectableScanUnit extends ScanUnitSelector {
  id: string;
  badge: string;
  label: string;
  lastScannedAt: string | null;
  nextScanAt: string | null;
  due: boolean;
}

interface ScanPost {
  platform: string; externalPostId: string; externalPostUrl: string;
  authorUsername: string; postContent: string; postPublishedAt: string;
  [key: string]: unknown;
}
interface ScanRunResult {
  posts: ScanPost[];
  nextCursor: { lastSeenExternalId: string | null; lastSeenAt: string | null };
  exhausted: boolean;
}

type TaskStatus = 'idle' | 'running' | 'done' | 'ingesting' | 'ingested' | 'err';
interface TaskState {
  status: TaskStatus; posts: ScanPost[];
  nextCursor: { lastSeenExternalId: string | null; lastSeenAt: string | null } | null;
  exhausted: boolean; accepted: number | null; err: string | null;
}

// ─── Storage helpers ──────────────────────────────────────────────────────────

const CONFIG_CACHE_KEY = 'engage_debug_config_cache';
interface ConfigCache { data: EngageConfig; syncedAt: number }
export const loadConfigCache = (): Promise<ConfigCache | null> =>
  new Promise((res) => chrome.storage.local.get([CONFIG_CACHE_KEY], (r) => res(r[CONFIG_CACHE_KEY] ?? null)));
export const saveConfigCache = (data: EngageConfig): Promise<void> =>
  new Promise((res) => chrome.storage.local.set({ [CONFIG_CACHE_KEY]: { data, syncedAt: Date.now() } }, () => res()));

const cacheKey = (t: ScanTask) => `engage_debug:${t.platform}:${t.scanType}:${t.scanKey}`;
const loadCache = (key: string): Promise<{ taskId: string; result: ScanRunResult } | null> =>
  new Promise((res) => chrome.storage.local.get([key], (r) => res(r[key] ?? null)));
const saveCache = (key: string, taskId: string, result: ScanRunResult): Promise<void> =>
  new Promise((res) => chrome.storage.local.set({ [key]: { taskId, result } }, () => res()));
const clearCache = (key: string): Promise<void> =>
  new Promise((res) => chrome.storage.local.remove([key], () => res()));

// ─── Utilities ────────────────────────────────────────────────────────────────

function sendMessage<T>(message: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (resp) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(err.message));
      resolve(resp as T);
    });
  });
}

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const diffMs = d.getTime() - Date.now();
  const absSec = Math.abs(diffMs / 1000);
  if (absSec < 60) return diffMs < 0 ? 'just now' : 'now';
  const absMins = Math.floor(absSec / 60);
  if (absMins < 60) return (diffMs < 0 ? '-' : '+') + absMins + 'm';
  const absHrs = Math.floor(absMins / 60);
  if (absHrs < 48) return (diffMs < 0 ? '-' : '+') + absHrs + 'h';
  return d.toLocaleDateString();
}
function fmtAbs(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function nextDue(lastAt: string | null | undefined, intervalHours: number): string | null {
  if (!lastAt) return null;
  return new Date(new Date(lastAt).getTime() + intervalHours * 3_600_000).toISOString();
}
function taskLabel(t: ScanTask) {
  const p = t.platform === 'x' ? '𝕏' : 'r/';
  const tp = t.scanType === 'keyword' ? 'KW' : t.scanType === 'channel' ? 'CH' : 'AC';
  return `${p} ${tp} · ${t.rawQuery ?? t.scanKey}`;
}
export function scanUnitSelectorKey(u: ScanUnitSelector): string {
  return `${u.platform}:${u.scanType}:${u.scanKey}`;
}
function normalizeScanKeyword(keyword: string): string {
  return keyword.trim().toLowerCase().replace(/\s+/g, ' ');
}
function normalizeScanUsername(platform: string, username: string): string {
  const trimmed = username.trim();
  if (platform === 'x' || platform === 'reddit') {
    return trimmed.replace(/^@/, '').replace(/^\/?u\//i, '').toLowerCase();
  }
  return trimmed;
}
function visiblePlatforms(filter: 'x' | 'reddit' | 'both'): Array<'x' | 'reddit'> {
  return filter === 'both' ? ['x', 'reddit'] : [filter];
}
function platformBadge(platform: 'x' | 'reddit', scanType: ScanUnitSelector['scanType']): string {
  const p = platform === 'x' ? '𝕏' : 'r/';
  const tp = scanType === 'keyword' ? 'KW' : scanType === 'channel' ? 'CH' : 'AC';
  return `${p} ${tp}`;
}
function isDue(lastScannedAt: string | null | undefined, nextScanAt: string | null | undefined, now: number): boolean {
  return !lastScannedAt || (nextScanAt ? new Date(nextScanAt).getTime() <= now : true);
}
export function buildSelectableScanUnits(
  config: EngageConfig | null,
  platformFilter: 'x' | 'reddit' | 'both',
  now: number = Date.now()
): SelectableScanUnit[] {
  if (!config) return [];
  const units: SelectableScanUnit[] = [];
  const platforms = visiblePlatforms(platformFilter);
  const intervalHours = config.scanIntervals?.scanIntervalHours ?? config.entitlement?.limits?.scanIntervalHours ?? 24;
  const chHours = config.scanIntervals?.channelHours ?? intervalHours;
  const trHours = config.scanIntervals?.trackedHours ?? intervalHours;

  for (const kw of config.keywords.filter((k) => k.enabled)) {
    const scanKey = normalizeScanKeyword(kw.keyword);
    if (!scanKey) continue;
    for (const platform of platforms) {
      const cur = (kw.scanCursors ?? []).find((c) => c.platform === platform);
      const unit: ScanUnitSelector = { platform, scanType: 'keyword', scanKey };
      units.push({
        ...unit,
        id: scanUnitSelectorKey(unit),
        badge: platformBadge(platform, 'keyword'),
        label: kw.keyword.trim(),
        lastScannedAt: cur?.lastScannedAt ?? null,
        nextScanAt: cur?.nextScanAt ?? null,
        due: isDue(cur?.lastScannedAt, cur?.nextScanAt, now),
      });
    }
  }

  if (platformFilter !== 'reddit') {
    for (const account of config.trackedAccounts.filter((a) => a.enabled && (!a.platform || a.platform === 'x'))) {
      const lastScannedAt = account.scanCursor?.lastScannedAt ?? account.lastCheckedAt ?? null;
      const nextScanAt = account.scanCursor?.nextScanAt ?? nextDue(lastScannedAt, trHours);
      const unit: ScanUnitSelector = {
        platform: 'x',
        scanType: 'tracked',
        scanKey: normalizeScanUsername('x', account.username),
      };
      units.push({
        ...unit,
        id: scanUnitSelectorKey(unit),
        badge: platformBadge('x', 'tracked'),
        label: account.username.startsWith('@') ? account.username : `@${account.username}`,
        lastScannedAt,
        nextScanAt,
        due: isDue(lastScannedAt, nextScanAt, now),
      });
    }
  }

  for (const channel of config.monitoredChannels.filter((c) => c.enabled)) {
    if (channel.platform !== 'x' && channel.platform !== 'reddit') continue;
    if (platformFilter !== 'both' && channel.platform !== platformFilter) continue;
    const platform = channel.platform;
    const lastScannedAt = channel.scanCursor?.lastScannedAt ?? channel.lastScannedAt ?? null;
    const nextScanAt = channel.scanCursor?.nextScanAt ?? nextDue(lastScannedAt, chHours);
    const unit: ScanUnitSelector = { platform, scanType: 'channel', scanKey: channel.channelId };
    units.push({
      ...unit,
      id: scanUnitSelectorKey(unit),
      badge: platformBadge(platform, 'channel'),
      label: channel.channelName || channel.channelId,
      lastScannedAt,
      nextScanAt,
      due: isDue(lastScannedAt, nextScanAt, now),
    });
  }

  return units;
}
function defaultState(): TaskState {
  return { status: 'idle', posts: [], nextCursor: null, exhausted: true, accepted: null, err: null };
}

// ─── Cookie / login helpers ───────────────────────────────────────────────────

function getCookie(url: string, name: string): Promise<chrome.cookies.Cookie | null> {
  return new Promise((resolve) => chrome.cookies.get({ url, name }, (c) => resolve(c ?? null)));
}

export async function checkPlatformLogin(platform: 'x' | 'reddit'): Promise<boolean> {
  if (platform === 'x') {
    return !!(
      (await getCookie('https://x.com', 'auth_token')) ??
      (await getCookie('https://twitter.com', 'auth_token'))
    );
  }
  // reddit_session is cleared on Reddit logout; token_v2 persists after logout
  // and is therefore NOT a reliable login indicator. Check reddit_session only.
  return !!(await getCookie('https://www.reddit.com', 'reddit_session'));
}

// ─── Component ────────────────────────────────────────────────────────────────

export function EngageScanPanel() {
  const [platform, setPlatform] = React.useState<'x' | 'reddit' | 'both'>('both');
  const [config, setConfig] = React.useState<EngageConfig | null>(null);
  const [syncedAt, setSyncedAt] = React.useState<number | null>(null);
  const [cfgBusy, setCfgBusy] = React.useState(false);
  const [cfgErr, setCfgErr] = React.useState<string | null>(null);
  const [tasks, setTasks] = React.useState<ScanTask[]>([]);
  const [claimBusy, setClaimBusy] = React.useState(false);
  const [claimErr, setClaimErr] = React.useState<string | null>(null);
  const [selectedUnitKeys, setSelectedUnitKeys] = React.useState<Set<string>>(() => new Set());
  const [states, setStates] = React.useState<Record<string, TaskState>>({});
  const autoSyncStartedRef = React.useRef(false);
  React.useEffect(() => {
    let alive = true;
    loadConfigCache().then((cached) => {
      if (!alive) return;
      if (cached) { setConfig(cached.data); setSyncedAt(cached.syncedAt); }
      if (!autoSyncStartedRef.current && shouldAutoSyncConfigCache(cached)) {
        autoSyncStartedRef.current = true;
        void loadConfig();
      }
    });
    return () => { alive = false; };
  }, []);

  const patch = (taskId: string, p: Partial<TaskState>) =>
    setStates((prev) => ({ ...prev, [taskId]: { ...(prev[taskId] ?? defaultState()), ...p } }));

  const selectableUnits = React.useMemo(
    () => buildSelectableScanUnits(config, platform),
    [config, platform]
  );

  React.useEffect(() => {
    const visible = new Set(selectableUnits.map((u) => u.id));
    setSelectedUnitKeys((prev) => {
      const next = new Set([...prev].filter((id) => visible.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [selectableUnits]);

  function toggleSelectedUnit(unitId: string, checked: boolean) {
    setSelectedUnitKeys((prev) => {
      const next = new Set(prev);
      if (checked) next.add(unitId);
      else next.delete(unitId);
      return next;
    });
  }

  async function loadConfig() {
    setCfgBusy(true); setCfgErr(null);
    try {
      const r = await sendMessage<{ ok: boolean; data?: EngageConfig; error?: string }>({ action: ENGAGE_EXTENSION_ACTION.loadConfig });
      if (!r.ok) throw new Error(r.error || 'failed');
      const data = r.data!;
      setConfig(data);
      await saveConfigCache(data);
      setSyncedAt(Date.now());
    } catch (e: any) { setCfgErr(String(e?.message || e)); }
    finally { setCfgBusy(false); }
  }

  async function claimTasks() {
    const selectedUnits = selectableUnits
      .filter((u) => selectedUnitKeys.has(u.id))
      .map(({ platform, scanType, scanKey }) => ({ platform, scanType, scanKey }));
    if (!selectedUnits.length) {
      setClaimErr('Select at least one scan unit first.');
      return;
    }
    setClaimBusy(true); setClaimErr(null);
    try {
      const r = await sendMessage<{ ok: boolean; tasks?: ScanTask[]; error?: string }>({
        action: ENGAGE_EXTENSION_ACTION.claimTasks,
        want: selectedUnits.length,
        selectedUnits,
      });
      if (!r.ok) throw new Error(r.error || 'failed');
      const all = r.tasks ?? [];
      const filtered = platform === 'both' ? all : all.filter((t) => t.platform === platform);
      const nextStates: Record<string, TaskState> = {};
      for (const t of filtered) {
        const cached = await loadCache(cacheKey(t));
        nextStates[t.taskId] = cached && cached.taskId === t.taskId
          ? { ...defaultState(), status: 'done', posts: cached.result.posts, nextCursor: cached.result.nextCursor, exhausted: cached.result.exhausted }
          : defaultState();
      }
      setTasks(filtered);
      setStates(nextStates);
    } catch (e: any) { setClaimErr(String(e?.message || e)); }
    finally { setClaimBusy(false); }
  }

  async function executeTask(t: ScanTask) {
    patch(t.taskId, { status: 'running', posts: [], err: null });
    try {
      const r = await sendMessage<{ ok: boolean; result?: ScanRunResult; error?: string }>({ action: ENGAGE_EXTENSION_ACTION.executeTask, task: t });
      if (!r.ok) throw new Error(r.error || 'failed');
      const res = r.result!;
      await saveCache(cacheKey(t), t.taskId, res);
      patch(t.taskId, { status: 'done', posts: res.posts, nextCursor: res.nextCursor, exhausted: res.exhausted });
    } catch (e: any) { patch(t.taskId, { status: 'err', err: String(e?.message || e) }); }
  }

  async function releaseTask(t: ScanTask) {
    patch(t.taskId, { status: 'idle', err: null, posts: [] });
    try {
      await sendMessage<{ ok: boolean }>({ action: ENGAGE_EXTENSION_ACTION.releaseTask, taskId: t.taskId });
    } catch (_) { /* ignore */ }
    setTasks((prev) => prev.filter((x) => x.taskId !== t.taskId));
    setStates((prev) => { const n = { ...prev }; delete n[t.taskId]; return n; });
  }

  async function ingestTask(t: ScanTask) {
    const st = states[t.taskId];
    if (!st || st.status !== 'done') return;
    patch(t.taskId, { status: 'ingesting', err: null });
    try {
      const r = await sendMessage<{ ok: boolean; accepted?: number; nextTasks?: ScanTask[]; error?: string }>({
        action: ENGAGE_EXTENSION_ACTION.ingestTask, taskId: t.taskId,
        posts: st.posts, nextCursor: st.nextCursor ?? undefined, exhausted: st.exhausted,
      });
      if (!r.ok) throw new Error(r.error || 'failed');
      await clearCache(cacheKey(t));
      patch(t.taskId, { status: 'ingested', accepted: r.accepted ?? 0 });
      const incoming = (r.nextTasks ?? []).filter((nt) => !tasks.some((e) => e.taskId === nt.taskId));
      if (incoming.length) {
        setTasks((prev) => [...prev, ...incoming]);
        setStates((prev) => { const np = { ...prev }; for (const nt of incoming) np[nt.taskId] = defaultState(); return np; });
      }
      void loadConfig();
    } catch (e: any) { patch(t.taskId, { status: 'err', err: String(e?.message || e) }); }
  }

  const syncAgo = syncedAt ? Math.round((Date.now() - syncedAt) / 60000) + 'm ago' : null;

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', fontSize: 13, color: '#111' }}>
      <style>{SCAN_CSS}</style>

      {/* Platform filter + sync */}
      <div className="sc-toolbar">
        {(['x', 'reddit', 'both'] as const).map((p) => (
          <button key={p} className={`sc-tab${platform === p ? ' sc-tab-active' : ''}`} onClick={() => setPlatform(p)}>
            {p === 'x' ? '𝕏' : p === 'reddit' ? 'Reddit' : 'All'}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        {syncAgo && <span className="sc-muted">{syncAgo}</span>}
        <button className="sc-sync-btn" onClick={loadConfig} disabled={cfgBusy}>
          {cfgBusy ? 'Syncing…' : config ? 'Re-sync' : 'Sync Config'}
        </button>
      </div>
      {cfgErr && <div className="sc-err">{cfgErr}</div>}

      {/* Status table */}
      {config ? (
        <div className="sc-table">
          <div className="sc-thead">
            <span></span><span>Scan Unit</span><span>Last</span><span>Status</span>
          </div>
          {selectableUnits.map((unit) => (
            <label key={unit.id} className="sc-row sc-row-select">
              <span className="sc-check">
                <input
                  type="checkbox"
                  checked={selectedUnitKeys.has(unit.id)}
                  onChange={(e) => toggleSelectedUnit(unit.id, e.target.checked)}
                />
              </span>
              <span className="sc-unit"><span className="sc-bp">{unit.badge}</span>{unit.label}</span>
              <span className="sc-t">{fmtAbs(unit.lastScannedAt)}</span>
              <span className={unit.due ? 'sc-due' : 'sc-cool'}>{unit.due ? 'Pending' : fmtTime(unit.nextScanAt)}</span>
            </label>
          ))}
          {selectableUnits.length === 0 && (
            <div className="sc-empty">No scan units (for current platform filter)</div>
          )}
        </div>
      ) : (
        !cfgBusy && <div className="sc-empty">Click "Sync Config" to load scan units.</div>
      )}

      {/* Claim controls */}
      <div className="sc-claim-bar">
        <span className="sc-muted">{selectedUnitKeys.size} selected</span>
        <button className="sc-claim-btn" onClick={claimTasks} disabled={claimBusy || selectedUnitKeys.size === 0}>
          {claimBusy ? 'Claiming…' : 'Claim Tasks'}
        </button>
      </div>
      {claimErr && <div className="sc-err">{claimErr}</div>}
      {tasks.length === 0 && !claimBusy && (
        <div className="sc-empty" style={{ marginTop: 4 }}>
          Select one or more scan units, then claim tasks.
        </div>
      )}

      {/* Task rows */}
      <div className="sc-tasks">
        {tasks.map((t) => {
          const st = states[t.taskId] ?? defaultState();
          return (
            <div key={t.taskId} className="sc-task">
              <div className="sc-task-label">{taskLabel(t)}</div>
              <div className="sc-task-actions">
                <button className="sc-btn-run"
                  disabled={st.status === 'running' || st.status === 'ingesting' || st.status === 'ingested'}
                  onClick={() => executeTask(t)}>
                  {st.status === 'running' ? 'Scanning…' : st.status === 'done' ? 'Re-scan' : 'Run'}
                </button>
                {st.status === 'done' && (
                  <button className="sc-btn-ingest" onClick={() => ingestTask(t)}>
                    Ingest ({st.posts.length})
                  </button>
                )}
                {st.status === 'ingesting' && <button disabled className="sc-btn-ingest">Ingesting…</button>}
                {st.status === 'ingested' && <span className="sc-ok">✓ {st.accepted}</span>}
                {st.status === 'err' && (
                  <button className="sc-btn-release" onClick={() => releaseTask(t)}>Release Lock</button>
                )}
              </div>
              {st.status === 'err' && <div className="sc-err sc-task-err">{st.err}</div>}
              {(st.status === 'done' || st.status === 'ingested') && st.posts.length > 0 && (
                <div className="sc-posts">
                  {st.posts.slice(0, 5).map((p) => (
                    <div key={p.externalPostId} className="sc-post">
                      <a href={p.externalPostUrl} target="_blank" rel="noreferrer">@{p.authorUsername}</a>
                      <span className="sc-post-time">{new Date(p.postPublishedAt).toLocaleString('en-US', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                      <div className="sc-post-text">{p.postContent.slice(0, 100)}{p.postContent.length > 100 ? '…' : ''}</div>
                    </div>
                  ))}
                  {st.posts.length > 5 && <div className="sc-muted">…and {st.posts.length - 5} more</div>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Styles (scoped to popup width ~352px usable) ─────────────────────────────

const SCAN_CSS = `
.sc-toolbar { display:flex; align-items:center; gap:6px; margin-bottom:10px; flex-wrap:wrap; }
.sc-tab { padding:3px 10px; border:1.5px solid #d0d0d0; border-radius:20px; background:#fff; color:#555; font-size:12px; cursor:pointer; transition:border-color 0.12s,background 0.12s,color 0.12s; }
.sc-tab:hover:not(.sc-tab-active) { border-color:#171817; color:#171817; }
.sc-tab-active { background:#c7ff18; border-color:#171817; color:#171817; font-weight:600; }
.sc-sync-btn { padding:4px 10px; border:1.5px solid #d0d0d0; border-radius:6px; background:#fff; color:#333; font-size:12px; cursor:pointer; transition:border-color 0.12s,background 0.12s; }
.sc-sync-btn:hover:not(:disabled) { border-color:#171817; background:#f6f8f2; }
.sc-sync-btn:disabled { color:#aaa; cursor:default; }
.sc-muted { font-size:11px; color:#999; }
.sc-err { color:#b42318; font-size:12px; margin:4px 0; }
.sc-empty { color:#888; font-size:12px; padding:8px 0; }

.sc-table { border:1px solid #e3e6ea; border-radius:8px; overflow:hidden; font-size:12px; margin-bottom:10px; }
.sc-thead { display:grid; grid-template-columns:24px 1fr 80px 60px; background:#f6f8f2; padding:5px 10px; font-weight:600; color:#555; font-size:11px; border-bottom:1px solid #e3e6ea; }
.sc-row { display:grid; grid-template-columns:24px 1fr 80px 60px; padding:6px 10px; border-bottom:1px solid #f0f0f0; align-items:center; }
.sc-row:last-child { border-bottom:0; }
.sc-row:hover { background:#fafdf4; }
.sc-row-select { cursor:pointer; }
.sc-check { display:flex; align-items:center; }
.sc-check input { margin:0; cursor:pointer; }
.sc-unit { display:flex; align-items:center; gap:5px; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
.sc-bp { font-size:10px; font-weight:700; background:#efffc0; color:#354600; border-radius:3px; padding:1px 4px; flex-shrink:0; }
.sc-t { color:#777; font-size:11px; }
.sc-due { font-size:11px; font-weight:600; color:#b42318; background:#fff0ed; border-radius:4px; padding:1px 5px; }
.sc-cool { font-size:11px; color:#354600; background:#efffc0; border-radius:4px; padding:1px 5px; }

.sc-claim-bar { display:flex; align-items:center; gap:6px; margin:10px 0 4px; flex-wrap:wrap; }
.sc-label { font-size:12px; color:#555; }
.sc-num { width:44px; padding:4px 6px; border:1.5px solid #d0d0d0; border-radius:6px; font-size:12px; outline:none; }
.sc-num:focus { border-color:#171817; box-shadow:0 0 0 3px #efffc0; }
.sc-claim-btn { padding:5px 14px; border:1.5px solid #171817; border-radius:6px; background:#c7ff18; color:#171817; font-size:12px; font-weight:600; cursor:pointer; margin-left:auto; transition:background 0.12s,transform 0.12s; }
.sc-claim-btn:hover:not(:disabled) { background:#b5f000; transform:translateY(-1px); }
.sc-claim-btn:disabled { background:#efffc0; border-color:#d0d7c8; color:#a6aa9f; cursor:default; }

.sc-tasks { display:flex; flex-direction:column; gap:8px; margin-top:8px; }
.sc-task { border:1px solid #dfe3da; border-radius:8px; padding:10px; display:flex; flex-direction:column; gap:5px; background:#fff; }
.sc-task-label { font-size:13px; font-weight:600; color:#171817; }
.sc-task-actions { display:flex; gap:6px; align-items:center; flex-wrap:wrap; }
.sc-btn-run { padding:4px 12px; border:1.5px solid #171817; border-radius:5px; background:#c7ff18; color:#171817; font-size:12px; font-weight:600; cursor:pointer; transition:background 0.12s; }
.sc-btn-run:hover:not(:disabled) { background:#b5f000; }
.sc-btn-run:disabled { background:#efffc0; border-color:#d0d7c8; color:#a6aa9f; cursor:default; }
.sc-btn-ingest { padding:4px 12px; border:1.5px solid #171817; border-radius:5px; background:#171817; color:#c7ff18; font-size:12px; font-weight:600; cursor:pointer; transition:opacity 0.12s; }
.sc-btn-ingest:hover:not(:disabled) { opacity:0.85; }
.sc-btn-ingest:disabled { background:#747970; border-color:#747970; color:#ccc; cursor:default; }
.sc-btn-release { padding:4px 12px; border:1.5px solid #b42318; border-radius:5px; background:#fff0ed; color:#b42318; font-size:12px; font-weight:600; cursor:pointer; }
.sc-btn-release:hover { background:#ffe4e0; }
.sc-ok { font-size:12px; color:#354600; font-weight:600; }
.sc-task-err { margin:0; }
.sc-posts { margin-top:4px; border-top:1px solid #dfe3da; padding-top:6px; display:flex; flex-direction:column; gap:5px; }
.sc-post { background:#f6f8f2; border-radius:5px; padding:6px 8px; font-size:12px; border:1px solid #dfe3da; }
.sc-post a { color:#506b00; text-decoration:none; font-weight:600; margin-right:6px; }
.sc-post a:hover { text-decoration:underline; }
.sc-post-time { color:#747970; font-size:11px; }
.sc-post-text { margin-top:3px; color:#333; white-space:pre-wrap; word-break:break-word; font-size:11px; line-height:1.4; }

.sc-login-row { display:flex; align-items:center; gap:6px; margin-bottom:10px; flex-wrap:wrap; }
.sc-login-chip { display:inline-flex; align-items:center; gap:5px; padding:3px 9px; border-radius:6px; font-size:11px; font-weight:600; border:1px solid transparent; }
.sc-login-chip.ok { background:#efffc0; color:#354600; border-color:#b3dc32; }
.sc-login-chip.warn { background:#fff0ed; color:#b42318; border-color:#ffd0c0; gap:7px; }
.sc-login-chip.checking { background:#f6f8f2; color:#747970; border-color:#dfe3da; }
.sc-login-link-btn { padding:2px 8px; border:1.5px solid #171817; border-radius:4px; background:#c7ff18; color:#171817; font-size:11px; font-weight:600; cursor:pointer; line-height:1.5; transition:background 0.12s; }
.sc-login-link-btn:hover { background:#b5f000; }
.sc-login-refresh-btn { padding:2px 7px; border:1.5px solid #dfe3da; border-radius:5px; background:#fff; color:#747970; font-size:13px; cursor:pointer; margin-left:auto; transition:border-color 0.12s,color 0.12s; }
.sc-login-refresh-btn:hover { border-color:#171817; color:#171817; }
`;
