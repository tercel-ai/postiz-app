import React, { useState } from 'react';
import '@gitroom/extension/pages/options/Options.css';

interface Tweet {
  id: string;
  text: string;
  createdAt: string;
  authorUsername: string;
  likes: number;
  replies: number;
  retweets: number;
  quotes: number;
  bookmarks: number;
  views: number;
}

interface SearchResp {
  ok: boolean;
  tweets?: Tweet[];
  error?: string;
}
interface TweetResp {
  ok: boolean;
  tweet?: Tweet | null;
  error?: string;
}

function sendMessage<T>(message: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (resp) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(err.message));
      resolve(resp as T);
    });
  });
}

function TweetRow({ t }: { t: Tweet }) {
  return (
    <div className="xdbg-row">
      <div className="xdbg-meta">
        <a
          href={'https://x.com/' + t.authorUsername + '/status/' + t.id}
          target="_blank"
          rel="noreferrer"
        >
          @{t.authorUsername}
        </a>
        <span className="xdbg-date">{t.createdAt}</span>
      </div>
      <div className="xdbg-text">{t.text}</div>
      <div className="xdbg-stats">
        ❤ {t.likes} · 🔁 {t.retweets} · 💬 {t.replies} · 🔖 {t.bookmarks} · 👁{' '}
        {t.views}
      </div>
    </div>
  );
}

interface AccountKwResp {
  ok: boolean;
  tweets?: Tweet[];
  error?: string;
}

// ─── Section ④ types ────────────────────────────────────────────────────────

interface EngageCfgKeyword { id: string; keyword: string; enabled: boolean }
interface EngageCfgChannel { id: string; platform: string; channelId: string; channelName: string; enabled: boolean }
interface EngageCfgAccount { id: string; username: string; enabled: boolean }
interface EngageConfig {
  keywords: EngageCfgKeyword[];
  monitoredChannels: EngageCfgChannel[];
  trackedAccounts: EngageCfgAccount[];
  entitlement?: { limits?: { scanIntervalHours?: number } };
  scanIntervals?: { scanIntervalHours?: number };
}

interface ScanTask {
  taskId: string;
  platform: 'x' | 'reddit';
  scanType: 'keyword' | 'channel' | 'tracked';
  scanKey: string;
  cursor: { lastSeenExternalId: string | null; lastSeenAt: string | null };
  pacing: { maxPages: number; pageSize: number; pageDelayMs: number; pageJitterMs: number; interUnitDelayMs: number; interUnitJitterMs: number; hourlyRequestCap: number };
  rawQuery?: string;
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

const cacheKey = (t: ScanTask) => `engage_debug:${t.platform}:${t.scanType}:${t.scanKey}`;
const loadCache = (key: string): Promise<{ taskId: string; result: ScanRunResult } | null> =>
  new Promise((res) => chrome.storage.local.get([key], (r) => res(r[key] ?? null)));
const saveCache = (key: string, taskId: string, result: ScanRunResult): Promise<void> =>
  new Promise((res) => chrome.storage.local.set({ [key]: { taskId, result } }, () => res()));
const clearCache = (key: string): Promise<void> =>
  new Promise((res) => chrome.storage.local.remove([key], () => res()));

function taskLabel(t: ScanTask) {
  const p = t.platform === 'x' ? '𝕏' : 'Reddit';
  const tp = t.scanType === 'keyword' ? '关键词' : t.scanType === 'channel' ? '频道' : '账号';
  return `${p} · ${tp} · ${t.rawQuery ?? t.scanKey}`;
}

function defaultState(): TaskState {
  return { status: 'idle', posts: [], nextCursor: null, exhausted: true, accepted: null, err: null };
}

function EngageScanPanel() {
  const [platform, setPlatform] = React.useState<'x' | 'reddit' | 'both'>('both');
  const [wantN, setWantN] = React.useState(3);
  const [config, setConfig] = React.useState<EngageConfig | null>(null);
  const [cfgBusy, setCfgBusy] = React.useState(false);
  const [cfgErr, setCfgErr] = React.useState<string | null>(null);
  const [tasks, setTasks] = React.useState<ScanTask[]>([]);
  const [claimBusy, setClaimBusy] = React.useState(false);
  const [claimErr, setClaimErr] = React.useState<string | null>(null);
  const [states, setStates] = React.useState<Record<string, TaskState>>({});

  const patch = (taskId: string, p: Partial<TaskState>) =>
    setStates((prev) => ({ ...prev, [taskId]: { ...(prev[taskId] ?? defaultState()), ...p } }));

  async function loadConfig() {
    setCfgBusy(true); setCfgErr(null);
    try {
      const r = await sendMessage<{ ok: boolean; data?: EngageConfig; error?: string }>({ action: 'engage:load-config' });
      if (!r.ok) throw new Error(r.error || 'failed');
      setConfig(r.data ?? null);
    } catch (e: any) { setCfgErr(String(e?.message || e)); }
    finally { setCfgBusy(false); }
  }

  async function claimTasks() {
    setClaimBusy(true); setClaimErr(null);
    try {
      const r = await sendMessage<{ ok: boolean; tasks?: ScanTask[]; error?: string }>({ action: 'engage:claim-tasks', want: wantN });
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
      const r = await sendMessage<{ ok: boolean; result?: ScanRunResult; error?: string }>({ action: 'engage:execute-task', task: t });
      if (!r.ok) throw new Error(r.error || 'failed');
      const res = r.result!;
      await saveCache(cacheKey(t), t.taskId, res);
      patch(t.taskId, { status: 'done', posts: res.posts, nextCursor: res.nextCursor, exhausted: res.exhausted });
    } catch (e: any) { patch(t.taskId, { status: 'err', err: String(e?.message || e) }); }
  }

  async function ingestTask(t: ScanTask) {
    const st = states[t.taskId];
    if (!st || st.status !== 'done') return;
    patch(t.taskId, { status: 'ingesting', err: null });
    try {
      const r = await sendMessage<{ ok: boolean; accepted?: number; nextTasks?: ScanTask[]; error?: string }>({
        action: 'engage:ingest-task', taskId: t.taskId,
        posts: st.posts, nextCursor: st.nextCursor ?? undefined, exhausted: st.exhausted,
      });
      if (!r.ok) throw new Error(r.error || 'failed');
      await clearCache(cacheKey(t));
      patch(t.taskId, { status: 'ingested', accepted: r.accepted ?? 0 });
      // Append newly-claimed tasks from the backend response (next in the loop).
      const incoming = (r.nextTasks ?? []).filter((nt) => !tasks.some((e) => e.taskId === nt.taskId));
      if (incoming.length) {
        setTasks((prev) => [...prev, ...incoming]);
        setStates((prev) => { const np = { ...prev }; for (const nt of incoming) np[nt.taskId] = defaultState(); return np; });
      }
    } catch (e: any) { patch(t.taskId, { status: 'err', err: String(e?.message || e) }); }
  }

  const intervalHours = config?.scanIntervals?.scanIntervalHours ?? config?.entitlement?.limits?.scanIntervalHours ?? null;
  const visChannels = platform === 'both' ? (config?.monitoredChannels ?? []) : (config?.monitoredChannels ?? []).filter((c) => c.platform === platform);
  const visAccounts = platform !== 'reddit' ? (config?.trackedAccounts ?? []) : [];

  return (
    <section className="xdbg-card">
      <h2>④ Engage 扫描管理（端到端调试）</h2>
      <p className="xdbg-hint" style={{ marginBottom: 10 }}>
        从后端领取待扫描任务 → 执行扫描 → 结果保存本地 → 手动入库。已过 cadence 冷却的单元才会被返回，天然防重扫。
      </p>

      <div className="xdbg-controls" style={{ flexWrap: 'wrap', gap: 8 }}>
        <span style={{ fontSize: 13, color: '#555' }}>平台：</span>
        {(['x', 'reddit', 'both'] as const).map((p) => (
          <button key={p} onClick={() => setPlatform(p)}
            style={{ padding: '4px 12px', background: platform === p ? '#1d9bf0' : '#eee', color: platform === p ? '#fff' : '#333', border: 0, borderRadius: 6, cursor: 'pointer', fontSize: 13 }}>
            {p === 'x' ? '𝕏 X' : p === 'reddit' ? 'Reddit' : '全部'}
          </button>
        ))}
        <button onClick={loadConfig} disabled={cfgBusy} style={{ marginLeft: 'auto', padding: '4px 14px', fontSize: 13, cursor: 'pointer' }}>
          {cfgBusy ? '加载中…' : '读取配置'}
        </button>
      </div>

      {cfgErr && <div className="xdbg-err">配置错误：{cfgErr}</div>}
      {config && (
        <div className="eng-config-box">
          {intervalHours != null && <div className="eng-cfg-row"><span className="eng-cfg-label">扫描间隔</span><span>{intervalHours}h</span></div>}
          <div className="eng-cfg-row">
            <span className="eng-cfg-label">关键词</span>
            <span>{config.keywords.filter((k) => k.enabled).map((k) => k.keyword).join('、') || '—'}</span>
          </div>
          {(platform === 'x' || platform === 'both') && (
            <div className="eng-cfg-row">
              <span className="eng-cfg-label">追踪账号 (X)</span>
              <span>{visAccounts.filter((a) => a.enabled).map((a) => `@${a.username}`).join('、') || '—'}</span>
            </div>
          )}
          {(platform === 'reddit' || platform === 'both') && (
            <div className="eng-cfg-row">
              <span className="eng-cfg-label">Reddit 频道</span>
              <span>{visChannels.filter((c) => c.enabled).map((c) => c.channelName || c.channelId).join('、') || '—'}</span>
            </div>
          )}
        </div>
      )}

      <div className="xdbg-controls" style={{ marginTop: 14, gap: 8 }}>
        <label style={{ fontSize: 13, color: '#555' }}>领取数量：</label>
        <input type="number" value={wantN} min={1} max={5}
          onChange={(e) => setWantN(Math.min(5, Math.max(1, Number(e.target.value))))}
          style={{ width: 52 }} />
        <button onClick={claimTasks} disabled={claimBusy}>
          {claimBusy ? '领取中…' : '领取待扫描任务'}
        </button>
      </div>
      {claimErr && <div className="xdbg-err">领取失败：{claimErr}</div>}
      {tasks.length === 0 && !claimBusy && (
        <div className="xdbg-count" style={{ marginTop: 8 }}>暂无任务（全部在 cadence 冷却期内，或尚未领取）</div>
      )}

      <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {tasks.map((t) => {
          const st = states[t.taskId] ?? defaultState();
          return (
            <div key={t.taskId} className="eng-task-row">
              <div className="eng-task-label">{taskLabel(t)}</div>
              <div className="eng-task-meta">
                <code className="eng-task-id">{t.taskId.slice(0, 14)}…</code>
                {t.cursor.lastSeenAt && <span style={{ marginLeft: 8, color: '#999' }}>cursor: {new Date(t.cursor.lastSeenAt).toLocaleString()}</span>}
              </div>
              <div className="eng-task-actions">
                <button onClick={() => executeTask(t)}
                  disabled={st.status === 'running' || st.status === 'ingesting' || st.status === 'ingested'}
                  className="eng-btn-run">
                  {st.status === 'running' ? '扫描中…' : st.status === 'done' ? '重新扫描' : '执行扫描'}
                </button>
                {st.status === 'done' && (
                  <button onClick={() => ingestTask(t)} className="eng-btn-ingest">入库（{st.posts.length} 条）</button>
                )}
                {st.status === 'ingesting' && <button disabled className="eng-btn-ingest">入库中…</button>}
                {st.status === 'ingested' && <span className="eng-badge-ok">✓ 已入库 · accepted: {st.accepted}</span>}
              </div>
              {st.err && <div className="xdbg-err" style={{ marginTop: 4 }}>{st.err}</div>}
              {(st.status === 'done' || st.status === 'ingested') && (
                <div className="eng-task-results">
                  <div className="xdbg-count">共 {st.posts.length} 条 · exhausted: {String(st.exhausted)}</div>
                  <div className="eng-post-list">
                    {st.posts.slice(0, 8).map((p) => (
                      <div key={p.externalPostId} className="eng-post-row">
                        <a href={p.externalPostUrl} target="_blank" rel="noreferrer">@{p.authorUsername}</a>
                        <span className="xdbg-date">{new Date(p.postPublishedAt).toLocaleString()}</span>
                        <div className="eng-post-text">{p.postContent.slice(0, 120)}{p.postContent.length > 120 ? '…' : ''}</div>
                      </div>
                    ))}
                    {st.posts.length > 8 && <div className="xdbg-count">…还有 {st.posts.length - 8} 条</div>}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

export default function Options() {
  const [keyword, setKeyword] = useState('');
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchErr, setSearchErr] = useState<string | null>(null);
  const [searchResults, setSearchResults] = useState<Tweet[]>([]);
  const [searched, setSearched] = useState(false);

  const [tweetId, setTweetId] = useState('');
  const [tweetBusy, setTweetBusy] = useState(false);
  const [tweetErr, setTweetErr] = useState<string | null>(null);
  const [tweet, setTweet] = useState<Tweet | null>(null);
  const [fetched, setFetched] = useState(false);

  // ③ account + keywords combined search
  const [akAccount, setAkAccount] = useState('');
  const [akKeywords, setAkKeywords] = useState('');
  const [akBusy, setAkBusy] = useState(false);
  const [akErr, setAkErr] = useState<string | null>(null);
  const [akResults, setAkResults] = useState<Tweet[]>([]);
  const [akSearched, setAkSearched] = useState(false);
  const [akQuery, setAkQuery] = useState('');

  const runSearch = async () => {
    if (!keyword.trim()) return;
    setSearchBusy(true);
    setSearchErr(null);
    setSearchResults([]);
    setSearched(false);
    try {
      const resp = await sendMessage<SearchResp>({
        action: 'xdebug:search',
        keyword,
      });
      if (!resp.ok) throw new Error(resp.error || 'failed');
      setSearchResults(resp.tweets ?? []);
      setSearched(true);
    } catch (e: any) {
      setSearchErr(String(e?.message || e));
    } finally {
      setSearchBusy(false);
    }
  };

  const runTweet = async () => {
    if (!tweetId.trim()) return;
    setTweetBusy(true);
    setTweetErr(null);
    setTweet(null);
    setFetched(false);
    try {
      const resp = await sendMessage<TweetResp>({
        action: 'xdebug:tweet',
        id: tweetId,
      });
      if (!resp.ok) throw new Error(resp.error || 'failed');
      setTweet(resp.tweet ?? null);
      setFetched(true);
    } catch (e: any) {
      setTweetErr(String(e?.message || e));
    } finally {
      setTweetBusy(false);
    }
  };

  const runAccountKw = async () => {
    const handle = akAccount.replace(/^@/, '').trim();
    const kws = akKeywords
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean);
    if (!handle || !kws.length) return;
    setAkBusy(true);
    setAkErr(null);
    setAkResults([]);
    setAkSearched(false);
    // Preview the effective query
    const kwClause = kws.map((k) => (k.includes(' ') ? `"${k}"` : k)).join(' OR ');
    setAkQuery(`from:${handle} (${kwClause})`);
    try {
      const resp = await sendMessage<AccountKwResp>({
        action: 'xdebug:search-account-kw',
        account: handle,
        keywords: kws,
      });
      if (!resp.ok) throw new Error(resp.error || 'failed');
      setAkResults(resp.tweets ?? []);
      setAkSearched(true);
    } catch (e: any) {
      setAkErr(String(e?.message || e));
    } finally {
      setAkBusy(false);
    }
  };

  return (
    <div className="container xdbg">
      <style>{XDBG_CSS}</style>
      <h1>X 采集调试</h1>
      <p className="xdbg-hint">
        在后台标签页里让 x.com 自己发请求并拦截响应（需已登录 x.com）。
        全程不经过任何服务器 API。
      </p>

      <section className="xdbg-card">
        <h2>① 关键字搜索（SearchTimeline）</h2>
        <div className="xdbg-controls">
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="输入关键字，例如 openai"
            onKeyDown={(e) => e.key === 'Enter' && runSearch()}
          />
          <button onClick={runSearch} disabled={searchBusy || !keyword.trim()}>
            {searchBusy ? '搜索中…' : '搜索'}
          </button>
        </div>
        {searchErr && <div className="xdbg-err">错误：{searchErr}</div>}
        {searched && !searchErr && (
          <div className="xdbg-count">共 {searchResults.length} 条</div>
        )}
        <div className="xdbg-list">
          {searchResults.map((t) => (
            <TweetRow key={t.id} t={t} />
          ))}
        </div>
      </section>

      <section className="xdbg-card">
        <h2>② 按帖子 ID 取数（TweetDetail）</h2>
        <div className="xdbg-controls">
          <input
            value={tweetId}
            onChange={(e) => setTweetId(e.target.value)}
            placeholder="帖子数字 ID 或粘贴链接"
            onKeyDown={(e) => e.key === 'Enter' && runTweet()}
          />
          <button onClick={runTweet} disabled={tweetBusy || !tweetId.trim()}>
            {tweetBusy ? '获取中…' : '获取'}
          </button>
        </div>
        {tweetErr && <div className="xdbg-err">错误：{tweetErr}</div>}
        {fetched && !tweetErr && !tweet && (
          <div className="xdbg-count">未取到数据（ID 无效或拦截超时）</div>
        )}
        <div className="xdbg-list">{tweet && <TweetRow t={tweet} />}</div>
      </section>

      <section className="xdbg-card">
        <h2>③ 账号 + 关键词搜索（from:account keywords）</h2>
        <p className="xdbg-hint" style={{ marginBottom: 10 }}>
          组合查询：搜索某账号发的、包含指定关键词的推文。
          多个关键词用英文逗号分隔，例如{' '}
          <code>xspace, xai</code>。
        </p>
        <div className="xdbg-controls" style={{ flexWrap: 'wrap', gap: 8 }}>
          <input
            value={akAccount}
            onChange={(e) => setAkAccount(e.target.value)}
            placeholder="X 账号，例如 elonmusk"
            style={{ flex: '1 1 160px', minWidth: 120 }}
            onKeyDown={(e) => e.key === 'Enter' && runAccountKw()}
          />
          <input
            value={akKeywords}
            onChange={(e) => setAkKeywords(e.target.value)}
            placeholder="关键词（逗号分隔），例如 xspace, xai"
            style={{ flex: '2 1 240px', minWidth: 180 }}
            onKeyDown={(e) => e.key === 'Enter' && runAccountKw()}
          />
          <button
            onClick={runAccountKw}
            disabled={
              akBusy ||
              !akAccount.replace(/^@/, '').trim() ||
              !akKeywords.trim()
            }
          >
            {akBusy ? '搜索中…' : '搜索'}
          </button>
        </div>
        {akQuery && (
          <div className="xdbg-query-preview">
            查询（Top）：<code>{akQuery}</code>
          </div>
        )}
        {akErr && <div className="xdbg-err">错误：{akErr}</div>}
        {akSearched && !akErr && (
          <div className="xdbg-count">共 {akResults.length} 条</div>
        )}
        <div className="xdbg-list">
          {akResults.map((t) => (
            <TweetRow key={t.id} t={t} />
          ))}
        </div>
      </section>

      <EngageScanPanel />
    </div>
  );
}

const XDBG_CSS = `
.xdbg { max-width: 820px; margin: 0 auto; padding: 24px 16px; font-family: system-ui, sans-serif; color: #111; }
.xdbg h1 { font-size: 20px; margin: 0 0 4px; }
.xdbg-hint { color: #666; font-size: 13px; margin: 0 0 20px; }
.xdbg-card { border: 1px solid #e3e3e3; border-radius: 10px; padding: 16px; margin-bottom: 20px; }
.xdbg-card h2 { font-size: 15px; margin: 0 0 12px; }
.xdbg-controls { display: flex; gap: 8px; align-items: center; }
.xdbg-controls input[type="text"], .xdbg-controls input:not([type]) { flex: 1; }
.xdbg-controls input { padding: 8px 10px; border: 1px solid #ccc; border-radius: 8px; font-size: 14px; }
.xdbg-controls input[type="number"] { width: 72px; }
.xdbg-controls button { padding: 8px 16px; border: 0; border-radius: 8px; background: #1d9bf0; color: #fff; font-size: 14px; cursor: pointer; }
.xdbg-controls button:disabled { background: #9bd2f5; cursor: default; }
.xdbg-err { margin-top: 10px; color: #c00; font-size: 13px; }
.xdbg-count { margin-top: 10px; color: #666; font-size: 12px; }
.xdbg-list { margin-top: 10px; display: flex; flex-direction: column; gap: 10px; }
.xdbg-row { border: 1px solid #eee; border-radius: 8px; padding: 10px 12px; }
.xdbg-meta { display: flex; justify-content: space-between; font-size: 13px; }
.xdbg-meta a { color: #1d9bf0; text-decoration: none; font-weight: 600; }
.xdbg-date { color: #999; font-size: 12px; }
.xdbg-text { margin: 6px 0; font-size: 14px; white-space: pre-wrap; word-break: break-word; }
.xdbg-stats { color: #555; font-size: 12px; }
.xdbg-query-preview { margin-top: 10px; font-size: 12px; color: #555; }
.xdbg-query-preview code { background: #f3f4f6; padding: 2px 6px; border-radius: 4px; font-family: monospace; word-break: break-all; }

/* ── Section ④ Engage Scan Panel ── */
.eng-config-box { margin-top: 12px; background: #f8f9fa; border-radius: 8px; padding: 10px 14px; display: flex; flex-direction: column; gap: 5px; }
.eng-cfg-row { display: flex; gap: 10px; font-size: 13px; }
.eng-cfg-label { color: #888; min-width: 90px; flex-shrink: 0; }
.eng-task-row { border: 1px solid #dde; border-radius: 8px; padding: 12px; display: flex; flex-direction: column; gap: 6px; }
.eng-task-label { font-size: 14px; font-weight: 600; color: #222; }
.eng-task-meta { font-size: 12px; color: #888; }
.eng-task-id { font-family: monospace; font-size: 11px; background: #f3f4f6; padding: 1px 5px; border-radius: 3px; }
.eng-task-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.eng-btn-run { padding: 5px 14px; border: 0; border-radius: 6px; background: #1d9bf0; color: #fff; font-size: 13px; cursor: pointer; }
.eng-btn-run:disabled { background: #9bd2f5; cursor: default; }
.eng-btn-ingest { padding: 5px 14px; border: 0; border-radius: 6px; background: #16a34a; color: #fff; font-size: 13px; cursor: pointer; }
.eng-btn-ingest:disabled { background: #86efac; cursor: default; }
.eng-badge-ok { font-size: 13px; color: #16a34a; font-weight: 600; }
.eng-task-results { margin-top: 6px; border-top: 1px solid #eee; padding-top: 8px; }
.eng-post-list { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; }
.eng-post-row { background: #f8f9fa; border-radius: 6px; padding: 8px 10px; font-size: 13px; }
.eng-post-row a { color: #1d9bf0; text-decoration: none; font-weight: 600; margin-right: 8px; }
.eng-post-text { margin-top: 4px; color: #333; white-space: pre-wrap; word-break: break-word; font-size: 12px; line-height: 1.4; }
`;
