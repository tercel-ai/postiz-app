import React, { useState } from 'react';
import '@gitroom/extension/pages/options/Options.css';
import { ENGAGE_EXTENSION_ACTION } from '@gitroom/extension/utils/executor/actions';
import { EngageScanPanel } from '@gitroom/extension/pages/popup/components/ScanPanel';

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

interface RedditPost {
  platform: 'reddit';
  externalPostId: string;
  externalPostUrl: string;
  authorUsername: string;
  channelId?: string;
  channelName?: string;
  postContent: string;
  postPublishedAt: string;
  metricScore?: number;
  metricComments?: number;
  metricUpvoteRatio?: number;
}
interface RedditSearchResp { ok: boolean; posts?: RedditPost[]; error?: string }
interface RedditPostResp  { ok: boolean; post?: RedditPost | null; error?: string }

function RedditPostRow({ p }: { p: RedditPost }) {
  return (
    <div className="xdbg-row">
      <div className="xdbg-meta">
        <a href={p.externalPostUrl} target="_blank" rel="noreferrer">
          u/{p.authorUsername}
          {p.channelName && <span style={{ color: '#999', marginLeft: 6, fontWeight: 400 }}> · {p.channelName}</span>}
        </a>
        <span className="xdbg-date">{new Date(p.postPublishedAt).toLocaleString('zh-CN')}</span>
      </div>
      <div className="xdbg-text">{p.postContent.slice(0, 300)}{p.postContent.length > 300 ? '…' : ''}</div>
      <div className="xdbg-stats">
        ▲ {p.metricScore ?? 0} · 💬 {p.metricComments ?? 0}
        {p.metricUpvoteRatio != null && ` · ${Math.round(p.metricUpvoteRatio * 100)}% 赞同`}
      </div>
    </div>
  );
}

// ─── Section ④ is now in ScanPanel.tsx (shared with popup) ──────────────────

// Convert X Tweet display type → ScanIngestPost for backend ingestion
function tweetToIngestPost(t: Tweet): object {
  return {
    platform: 'x',
    externalPostId: t.id,
    externalPostUrl: `https://x.com/${t.authorUsername}/status/${t.id}`,
    authorUsername: t.authorUsername,
    postContent: t.text,
    postPublishedAt: t.createdAt,
    metricLikes: t.likes, metricReplies: t.replies, metricRetweets: t.retweets,
    metricQuotes: t.quotes, metricBookmarks: t.bookmarks, metricViews: t.views,
  };
}
// Convert Reddit display type → ScanIngestPost (already close; just rename fields)
function redditToIngestPost(p: RedditPost): object {
  return {
    platform: 'reddit',
    externalPostId: p.externalPostId,
    externalPostUrl: p.externalPostUrl,
    authorUsername: p.authorUsername,
    channelId: p.channelId,
    channelName: p.channelName,
    postContent: p.postContent,
    postPublishedAt: p.postPublishedAt,
    metricScore: p.metricScore,
    metricComments: p.metricComments,
    metricUpvoteRatio: p.metricUpvoteRatio,
  };
}

export default function Options() {
  // Platform switcher (X / Reddit) — shared across sections ①②③
  const [debugPlatform, setDebugPlatform] = useState<'x' | 'reddit'>('x');

  // ① keyword search
  const [keyword, setKeyword] = useState('');
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchErr, setSearchErr] = useState<string | null>(null);
  const [searchResults, setSearchResults] = useState<Tweet[]>([]);
  const [rSearchResults, setRSearchResults] = useState<RedditPost[]>([]);
  const [searched, setSearched] = useState(false);

  // ② single post fetch
  const [tweetId, setTweetId] = useState('');
  const [tweetBusy, setTweetBusy] = useState(false);
  const [tweetErr, setTweetErr] = useState<string | null>(null);
  const [tweet, setTweet] = useState<Tweet | null>(null);
  const [fetched, setFetched] = useState(false);
  // ② Reddit: post URL or ID
  const [rPostUrlOrId, setRPostUrlOrId] = useState('');
  const [rPostBusy, setRPostBusy] = useState(false);
  const [rPostErr, setRPostErr] = useState<string | null>(null);
  const [rPost, setRPost] = useState<RedditPost | null>(null);
  const [rPostFetched, setRPostFetched] = useState(false);

  // ③ account + keywords combined search
  const [akAccount, setAkAccount] = useState('');
  const [akKeywords, setAkKeywords] = useState('');
  const [akBusy, setAkBusy] = useState(false);
  const [akErr, setAkErr] = useState<string | null>(null);
  const [akResults, setAkResults] = useState<Tweet[]>([]);
  const [akSearched, setAkSearched] = useState(false);
  const [akQuery, setAkQuery] = useState('');
  // ③ Reddit: user + optional keywords
  const [rUserName, setRUserName] = useState('');
  const [rUserKeywords, setRUserKeywords] = useState('');
  const [rUserBusy, setRUserBusy] = useState(false);
  const [rUserErr, setRUserErr] = useState<string | null>(null);
  const [rUserResults, setRUserResults] = useState<RedditPost[]>([]);
  const [rUserSearched, setRUserSearched] = useState(false);

  // Ingest state: one slot per section (①②③)
  const [ing1Busy, setIng1Busy] = useState(false);
  const [ing1Result, setIng1Result] = useState<{ accepted: number; keywordMatched?: number; reason?: string } | null>(null);
  const [ing2Busy, setIng2Busy] = useState(false);
  const [ing2Result, setIng2Result] = useState<{ accepted: number; keywordMatched?: number; reason?: string } | null>(null);
  const [ing3Busy, setIng3Busy] = useState(false);
  const [ing3Result, setIng3Result] = useState<{ accepted: number; keywordMatched?: number; reason?: string } | null>(null);

  async function ingestPosts(
    posts: object[],
    setBusy: (v: boolean) => void,
    setResult: (v: { accepted: number; keywordMatched?: number; reason?: string } | null) => void
  ) {
    if (!posts.length) return;
    setBusy(true); setResult(null);
    try {
      const r = await sendMessage<{ ok: boolean; accepted?: number; keywordMatched?: number; reason?: string; error?: string }>({
        action: ENGAGE_EXTENSION_ACTION.ingestCollectedPosts, posts,
      });
      if (!r.ok) throw new Error(r.error || 'ingest failed');
      setResult({ accepted: r.accepted ?? 0, keywordMatched: r.keywordMatched, reason: r.reason });
    } catch (e: any) { setResult({ accepted: -1 }); console.error('[aisee][debug-ingest]', e); }
    finally { setBusy(false); }
  }

  async function syncPostMetrics(
    platform: string,
    externalPostId: string,
    metrics: Record<string, number>,
    setBusy: (v: boolean) => void,
    setResult: (v: { accepted: number; keywordMatched?: number; reason?: string } | null) => void
  ) {
    setBusy(true); setResult(null);
    try {
      const r = await sendMessage<{ ok: boolean; updated?: boolean; error?: string }>({
        action: ENGAGE_EXTENSION_ACTION.syncCollectedMetrics, platform, externalPostId, metrics,
      });
      if (!r.ok) throw new Error(r.error || 'sync failed');
      setResult({ accepted: r.updated ? 1 : 0, reason: r.updated ? undefined : 'no Post found with matching releaseURL' });
    } catch (e: any) { setResult({ accepted: -1, reason: String(e?.message || e) }); }
    finally { setBusy(false); }
  }

  // ─── X handlers ──────────────────────────────────────────────────────────
  const runSearch = async () => {
    if (!keyword.trim()) return;
    setSearchBusy(true); setSearchErr(null); setSearchResults([]); setSearched(false);
    try {
      const resp = await sendMessage<SearchResp>({ action: ENGAGE_EXTENSION_ACTION.scanXKeyword, keyword });
      if (!resp.ok) throw new Error(resp.error || 'failed');
      setSearchResults(resp.tweets ?? []); setSearched(true);
    } catch (e: any) { setSearchErr(String(e?.message || e)); }
    finally { setSearchBusy(false); }
  };

  const runTweet = async () => {
    if (!tweetId.trim()) return;
    setTweetBusy(true); setTweetErr(null); setTweet(null); setFetched(false);
    try {
      const resp = await sendMessage<TweetResp>({ action: ENGAGE_EXTENSION_ACTION.fetchXPost, id: tweetId });
      if (!resp.ok) throw new Error(resp.error || 'failed');
      setTweet(resp.tweet ?? null); setFetched(true);
    } catch (e: any) { setTweetErr(String(e?.message || e)); }
    finally { setTweetBusy(false); }
  };

  const runAccountKw = async () => {
    const handle = akAccount.replace(/^@/, '').trim();
    const kws = akKeywords.split(',').map((k) => k.trim()).filter(Boolean);
    if (!handle || !kws.length) return;
    setAkBusy(true); setAkErr(null); setAkResults([]); setAkSearched(false);
    const kwClause = kws.map((k) => (k.includes(' ') ? `"${k}"` : k)).join(' OR ');
    setAkQuery(`from:${handle} (${kwClause})`);
    try {
      const resp = await sendMessage<AccountKwResp>({
        action: ENGAGE_EXTENSION_ACTION.scanXAccount, account: handle, keywords: kws,
      });
      if (!resp.ok) throw new Error(resp.error || 'failed');
      setAkResults(resp.tweets ?? []); setAkSearched(true);
    } catch (e: any) { setAkErr(String(e?.message || e)); }
    finally { setAkBusy(false); }
  };

  // ─── Reddit handlers ──────────────────────────────────────────────────────
  const runRedditSearch = async () => {
    if (!keyword.trim()) return;
    setSearchBusy(true); setSearchErr(null); setRSearchResults([]); setSearched(false);
    try {
      const resp = await sendMessage<RedditSearchResp>({ action: ENGAGE_EXTENSION_ACTION.scanRedditKeyword, keyword });
      if (!resp.ok) throw new Error(resp.error || 'failed');
      setRSearchResults(resp.posts ?? []); setSearched(true);
    } catch (e: any) { setSearchErr(String(e?.message || e)); }
    finally { setSearchBusy(false); }
  };

  const runRedditPost = async () => {
    if (!rPostUrlOrId.trim()) return;
    setRPostBusy(true); setRPostErr(null); setRPost(null); setRPostFetched(false);
    try {
      const resp = await sendMessage<RedditPostResp>({ action: ENGAGE_EXTENSION_ACTION.fetchRedditPost, urlOrId: rPostUrlOrId.trim() });
      if (!resp.ok) throw new Error(resp.error || 'failed');
      setRPost(resp.post ?? null); setRPostFetched(true);
    } catch (e: any) { setRPostErr(String(e?.message || e)); }
    finally { setRPostBusy(false); }
  };

  const runRedditUser = async () => {
    const uname = rUserName.replace(/^u\//, '').trim();
    const kws = rUserKeywords.split(',').map((k) => k.trim()).filter(Boolean);
    if (!uname) return;
    setRUserBusy(true); setRUserErr(null); setRUserResults([]); setRUserSearched(false);
    try {
      const resp = await sendMessage<RedditSearchResp>({ action: ENGAGE_EXTENSION_ACTION.scanRedditUser, username: uname, keywords: kws });
      if (!resp.ok) throw new Error(resp.error || 'failed');
      setRUserResults(resp.posts ?? []); setRUserSearched(true);
    } catch (e: any) { setRUserErr(String(e?.message || e)); }
    finally { setRUserBusy(false); }
  };

  const isX = debugPlatform === 'x';

  return (
    <div className="xdbg">
      <style>{XDBG_CSS}</style>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
        <h1 style={{ margin: 0 }}>采集调试</h1>
        <div className="xdbg-platform-tabs">
          <button
            className={isX ? 'xdbg-tab-active' : 'xdbg-tab'}
            onClick={() => setDebugPlatform('x')}
          >𝕏 Twitter</button>
          <button
            className={!isX ? 'xdbg-tab-active' : 'xdbg-tab'}
            onClick={() => setDebugPlatform('reddit')}
          >Reddit</button>
        </div>
      </div>
      <p className="xdbg-hint">
        {isX
          ? '在后台标签页里让 x.com 自己发请求并拦截响应（需已登录 x.com）。'
          : '使用浏览器 session cookie 直接请求 Reddit 公开 API（需已登录 Reddit）。'}
      </p>

      {/* ① keyword search */}
      <section className="xdbg-card">
        <h2>① 关键字搜索（{isX ? 'SearchTimeline' : 'search.json sort=new'}）</h2>
        <div className="xdbg-controls">
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder={isX ? '输入关键字，例如 openai' : '输入关键字，例如 openai'}
            onKeyDown={(e) => e.key === 'Enter' && (isX ? runSearch() : runRedditSearch())}
          />
          <button onClick={isX ? runSearch : runRedditSearch} disabled={searchBusy || !keyword.trim()}>
            {searchBusy ? '搜索中…' : '搜索'}
          </button>
        </div>
        {searchErr && <div className="xdbg-err">错误：{searchErr}</div>}
        {searched && !searchErr && (() => {
          const count = isX ? searchResults.length : rSearchResults.length;
          const posts = isX ? searchResults.map(tweetToIngestPost) : rSearchResults.map(redditToIngestPost);
          return (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
              <div className="xdbg-count" style={{ margin: 0 }}>共 {count} 条</div>
              {count > 0 && (
                <button className="xdbg-ingest-btn" disabled={ing1Busy}
                  onClick={() => ingestPosts(posts, setIng1Busy, setIng1Result)}>
                  {ing1Busy ? '入库中…' : '入库'}
                </button>
              )}
              {ing1Result && (
                <span className="xdbg-ingest-result" title={ing1Result.reason}>
                  {ing1Result.accepted >= 0
                    ? `已入库 ${ing1Result.accepted} 条${ing1Result.keywordMatched !== undefined ? ` (关键词匹配 ${ing1Result.keywordMatched})` : ''}${ing1Result.reason ? ' ⚠️' : ''}`
                    : '入库失败'}
                  {ing1Result.reason && <div className="xdbg-ingest-reason">{ing1Result.reason}</div>}
                </span>
              )}
            </div>
          );
        })()}
        <div className="xdbg-list">
          {isX
            ? searchResults.map((t) => <TweetRow key={t.id} t={t} />)
            : rSearchResults.map((p) => <RedditPostRow key={p.externalPostId} p={p} />)}
        </div>
      </section>

      {/* ② single post fetch */}
      <section className="xdbg-card">
        {isX ? (
          <>
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
            {tweet && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
                <button className="xdbg-ingest-btn" disabled={ing2Busy}
                  onClick={() => syncPostMetrics('x', tweet.id, {
                    metricLikes: tweet.likes, metricReplies: tweet.replies,
                    metricRetweets: tweet.retweets, metricQuotes: tweet.quotes,
                    metricBookmarks: tweet.bookmarks, metricViews: tweet.views,
                  }, setIng2Busy, setIng2Result)}>
                  {ing2Busy ? '同步中…' : '同步指标'}
                </button>
                {ing2Result && (
                  <span className="xdbg-ingest-result" title={ing2Result.reason}>
                    {ing2Result.accepted >= 0 ? (ing2Result.accepted > 0 ? '已更新指标' : '未找到记录') : '同步失败'}
                    {ing2Result.reason && <div className="xdbg-ingest-reason">{ing2Result.reason}</div>}
                  </span>
                )}
              </div>
            )}
            <div className="xdbg-list">{tweet && <TweetRow t={tweet} />}</div>
          </>
        ) : (
          <>
            <h2>② 按帖子 URL 或 ID 取数</h2>
            <div className="xdbg-controls">
              <input
                value={rPostUrlOrId}
                onChange={(e) => setRPostUrlOrId(e.target.value)}
                placeholder="帖子完整 URL 或短 ID，例如 abc123"
                onKeyDown={(e) => e.key === 'Enter' && runRedditPost()}
              />
              <button onClick={runRedditPost} disabled={rPostBusy || !rPostUrlOrId.trim()}>
                {rPostBusy ? '获取中…' : '获取'}
              </button>
            </div>
            {rPostErr && <div className="xdbg-err">错误：{rPostErr}</div>}
            {rPostFetched && !rPostErr && !rPost && (
              <div className="xdbg-count">未取到数据（URL/ID 无效）</div>
            )}
            {rPost && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
                <button className="xdbg-ingest-btn" disabled={ing2Busy}
                  onClick={() => syncPostMetrics('reddit', rPost.externalPostId, {
                    metricScore: rPost.metricScore ?? 0,
                    metricComments: rPost.metricComments ?? 0,
                    metricUpvoteRatio: rPost.metricUpvoteRatio,
                  }, setIng2Busy, setIng2Result)}>
                  {ing2Busy ? '同步中…' : '同步指标'}
                </button>
                {ing2Result && (
                  <span className="xdbg-ingest-result" title={ing2Result.reason}>
                    {ing2Result.accepted >= 0 ? (ing2Result.accepted > 0 ? '已更新指标' : '未找到记录') : '同步失败'}
                    {ing2Result.reason && <div className="xdbg-ingest-reason">{ing2Result.reason}</div>}
                  </span>
                )}
              </div>
            )}
            <div className="xdbg-list">{rPost && <RedditPostRow p={rPost} />}</div>
          </>
        )}
      </section>

      {/* ③ account / user + keywords */}
      <section className="xdbg-card">
        {isX ? (
          <>
            <h2>③ 账号 + 关键词搜索（from:account keywords）</h2>
            <p className="xdbg-hint" style={{ marginBottom: 10 }}>
              组合查询：搜索某账号发的、包含指定关键词的推文。多个关键词用英文逗号分隔，例如 <code>xspace, xai</code>。
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
                disabled={akBusy || !akAccount.replace(/^@/, '').trim() || !akKeywords.trim()}
              >
                {akBusy ? '搜索中…' : '搜索'}
              </button>
            </div>
            {akQuery && (
              <div className="xdbg-query-preview">查询（Top）：<code>{akQuery}</code></div>
            )}
            {akErr && <div className="xdbg-err">错误：{akErr}</div>}
            {akSearched && !akErr && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
                <div className="xdbg-count" style={{ margin: 0 }}>共 {akResults.length} 条</div>
                {akResults.length > 0 && (
                  <button className="xdbg-ingest-btn" disabled={ing3Busy}
                    onClick={() => ingestPosts(akResults.map(tweetToIngestPost), setIng3Busy, setIng3Result)}>
                    {ing3Busy ? '入库中…' : '入库'}
                  </button>
                )}
                {ing3Result && (
                  <span className="xdbg-ingest-result" title={ing3Result.reason}>
                    {ing3Result.accepted >= 0 ? `已入库 ${ing3Result.accepted} 条${ing3Result.keywordMatched !== undefined ? ` (关键词匹配 ${ing3Result.keywordMatched})` : ''}` : '入库失败'}
                    {ing3Result.reason && <div className="xdbg-ingest-reason">{ing3Result.reason}</div>}
                  </span>
                )}
              </div>
            )}
            <div className="xdbg-list">
              {akResults.map((t) => <TweetRow key={t.id} t={t} />)}
            </div>
          </>
        ) : (
          <>
            <h2>③ 用户最近帖子（user/submitted + 关键词过滤）</h2>
            <p className="xdbg-hint" style={{ marginBottom: 10 }}>
              拉取指定用户的最近投稿，可选关键词做客户端过滤（逗号分隔）。
            </p>
            <div className="xdbg-controls" style={{ flexWrap: 'wrap', gap: 8 }}>
              <input
                value={rUserName}
                onChange={(e) => setRUserName(e.target.value)}
                placeholder="Reddit 用户名，例如 spez"
                style={{ flex: '1 1 160px', minWidth: 120 }}
                onKeyDown={(e) => e.key === 'Enter' && runRedditUser()}
              />
              <input
                value={rUserKeywords}
                onChange={(e) => setRUserKeywords(e.target.value)}
                placeholder="关键词（可选，逗号分隔）"
                style={{ flex: '2 1 240px', minWidth: 180 }}
                onKeyDown={(e) => e.key === 'Enter' && runRedditUser()}
              />
              <button onClick={runRedditUser} disabled={rUserBusy || !rUserName.replace(/^u\//, '').trim()}>
                {rUserBusy ? '搜索中…' : '搜索'}
              </button>
            </div>
            {rUserErr && <div className="xdbg-err">错误：{rUserErr}</div>}
            {rUserSearched && !rUserErr && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
                <div className="xdbg-count" style={{ margin: 0 }}>共 {rUserResults.length} 条</div>
                {rUserResults.length > 0 && (
                  <button className="xdbg-ingest-btn" disabled={ing3Busy}
                    onClick={() => ingestPosts(rUserResults.map(redditToIngestPost), setIng3Busy, setIng3Result)}>
                    {ing3Busy ? '入库中…' : '入库'}
                  </button>
                )}
                {ing3Result && (
                  <span className="xdbg-ingest-result" title={ing3Result.reason}>
                    {ing3Result.accepted >= 0 ? `已入库 ${ing3Result.accepted} 条${ing3Result.keywordMatched !== undefined ? ` (关键词匹配 ${ing3Result.keywordMatched})` : ''}` : '入库失败'}
                    {ing3Result.reason && <div className="xdbg-ingest-reason">{ing3Result.reason}</div>}
                  </span>
                )}
              </div>
            )}
            <div className="xdbg-list">
              {rUserResults.map((p) => <RedditPostRow key={p.externalPostId} p={p} />)}
            </div>
          </>
        )}
      </section>

      <EngageScanPanel />
    </div>
  );
}

const XDBG_CSS = `
:root { --ox-accent: #c7ff18; --ox-ink: #171817; --ox-accent-soft: #efffc0; --ox-border: #dfe3da; --ox-soft: #f6f8f2; --ox-muted: #747970; }
.xdbg { max-width: 820px; margin: 0 auto; padding: 24px 16px; font-family: system-ui, sans-serif; color: var(--ox-ink); }
.xdbg h1 { font-size: 20px; margin: 0 0 4px; }
.xdbg-hint { color: var(--ox-muted); font-size: 13px; margin: 0 0 20px; }
.xdbg-card { border: 1px solid var(--ox-border); border-radius: 10px; padding: 16px; margin-bottom: 20px; background: #fff; }
.xdbg-card h2 { font-size: 15px; margin: 0 0 12px; }
.xdbg-controls { display: flex; gap: 8px; align-items: center; }
.xdbg-controls input[type="text"], .xdbg-controls input:not([type]) { flex: 1; }
.xdbg-controls input { padding: 8px 10px; border: 1.5px solid var(--ox-border); border-radius: 8px; font-size: 14px; outline: none; transition: border-color 0.12s, box-shadow 0.12s; }
.xdbg-controls input:focus { border-color: var(--ox-ink); box-shadow: 0 0 0 3px var(--ox-accent-soft); }
.xdbg-controls input[type="number"] { width: 72px; }
.xdbg-controls button { padding: 8px 16px; border: 1.5px solid var(--ox-ink); border-radius: 8px; background: var(--ox-accent); color: var(--ox-ink); font-size: 14px; font-weight: 600; cursor: pointer; transition: background 0.12s, transform 0.12s; }
.xdbg-controls button:hover:not(:disabled) { background: #b5f000; transform: translateY(-1px); }
.xdbg-controls button:disabled { background: var(--ox-accent-soft); border-color: #d0d7c8; color: #a6aa9f; cursor: default; transform: none; }
.xdbg-err { margin-top: 10px; color: #b42318; font-size: 13px; }
.xdbg-count { margin-top: 10px; color: var(--ox-muted); font-size: 12px; }
.xdbg-list { margin-top: 10px; display: flex; flex-direction: column; gap: 10px; }
.xdbg-row { border: 1px solid var(--ox-border); border-radius: 8px; padding: 10px 12px; background: #fff; }
.xdbg-meta { display: flex; justify-content: space-between; font-size: 13px; }
.xdbg-meta a { color: #506b00; text-decoration: none; font-weight: 600; }
.xdbg-meta a:hover { text-decoration: underline; }
.xdbg-date { color: var(--ox-muted); font-size: 12px; }
.xdbg-text { margin: 6px 0; font-size: 14px; white-space: pre-wrap; word-break: break-word; }
.xdbg-stats { color: #555; font-size: 12px; }
.xdbg-query-preview { margin-top: 10px; font-size: 12px; color: #555; }
.xdbg-query-preview code { background: var(--ox-soft); padding: 2px 6px; border-radius: 4px; font-family: monospace; word-break: break-all; }
.xdbg-platform-tabs { display: flex; gap: 4px; }
.xdbg-tab { padding: 4px 14px; border-radius: 20px; border: 1.5px solid var(--ox-border); font-size: 13px; cursor: pointer; background: #fff; color: var(--ox-muted); transition: border-color 0.12s, background 0.12s, color 0.12s; }
.xdbg-tab:hover { border-color: var(--ox-ink); color: var(--ox-ink); }
.xdbg-tab-active { background: var(--ox-accent); border-color: var(--ox-ink); color: var(--ox-ink); font-weight: 600; }
.xdbg-ingest-btn { padding: 4px 14px; border: 1.5px solid var(--ox-ink); border-radius: 8px; background: var(--ox-ink); color: var(--ox-accent); font-size: 13px; font-weight: 600; cursor: pointer; flex-shrink: 0; transition: opacity 0.12s; }
.xdbg-ingest-btn:hover:not(:disabled) { opacity: 0.85; }
.xdbg-ingest-btn:disabled { background: var(--ox-muted); border-color: var(--ox-muted); color: #ccc; cursor: default; }
.xdbg-ingest-result { font-size: 12px; color: #354600; font-weight: 600; }
.xdbg-ingest-reason { font-size: 11px; color: #b45309; margin-top: 2px; }

/* ── Section ④ Engage Scan Panel (SCAN_CSS injected by EngageScanPanel) ── */
/* Full-width status table for the Options page (wider than popup's 352px) */
.eng-status-table { margin-top: 12px; border: 1px solid var(--ox-border); border-radius: 8px; overflow: hidden; font-size: 13px; }
.eng-status-hdr { display: grid; grid-template-columns: 1fr 130px 130px 80px; background: var(--ox-soft); padding: 6px 12px; font-weight: 600; color: var(--ox-muted); font-size: 12px; border-bottom: 1px solid var(--ox-border); }
.eng-status-row { display: grid; grid-template-columns: 1fr 130px 130px 80px; padding: 7px 12px; border-bottom: 1px solid #f0f0f0; align-items: center; }
.eng-status-row:last-child { border-bottom: 0; }
.eng-status-row:hover { background: #fafdf4; }
.eng-unit-name { display: flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 500; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.eng-badge-platform { font-size: 10px; font-weight: 700; background: var(--ox-accent-soft); color: #354600; border-radius: 4px; padding: 1px 5px; flex-shrink: 0; font-family: monospace; }
.eng-time-cell { color: var(--ox-muted); font-size: 12px; }
.eng-badge-due { font-size: 12px; font-weight: 600; color: #b42318; background: #fff0ed; border-radius: 4px; padding: 1px 7px; display: inline-block; }
.eng-badge-cool { font-size: 12px; color: #354600; background: var(--ox-accent-soft); border-radius: 4px; padding: 1px 7px; display: inline-block; }
.eng-task-row { border: 1px solid var(--ox-border); border-radius: 8px; padding: 12px; display: flex; flex-direction: column; gap: 6px; background: #fff; }
.eng-task-label { font-size: 14px; font-weight: 600; color: var(--ox-ink); }
.eng-task-meta { font-size: 12px; color: var(--ox-muted); }
.eng-task-id { font-family: monospace; font-size: 11px; background: var(--ox-soft); padding: 1px 5px; border-radius: 3px; }
.eng-task-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.eng-btn-run { padding: 5px 14px; border: 1.5px solid var(--ox-ink); border-radius: 6px; background: var(--ox-accent); color: var(--ox-ink); font-size: 13px; font-weight: 600; cursor: pointer; transition: background 0.12s; }
.eng-btn-run:hover:not(:disabled) { background: #b5f000; }
.eng-btn-run:disabled { background: var(--ox-accent-soft); border-color: #d0d7c8; color: #a6aa9f; cursor: default; }
.eng-btn-ingest { padding: 5px 14px; border: 1.5px solid var(--ox-ink); border-radius: 6px; background: var(--ox-ink); color: var(--ox-accent); font-size: 13px; font-weight: 600; cursor: pointer; transition: opacity 0.12s; }
.eng-btn-ingest:hover:not(:disabled) { opacity: 0.85; }
.eng-btn-ingest:disabled { background: var(--ox-muted); border-color: var(--ox-muted); color: #ccc; cursor: default; }
.eng-badge-ok { font-size: 13px; color: #354600; font-weight: 600; }
.eng-task-results { margin-top: 6px; border-top: 1px solid var(--ox-border); padding-top: 8px; }
.eng-post-list { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; }
.eng-post-row { background: var(--ox-soft); border: 1px solid var(--ox-border); border-radius: 6px; padding: 8px 10px; font-size: 13px; }
.eng-post-row a { color: #506b00; text-decoration: none; font-weight: 600; margin-right: 8px; }
.eng-post-row a:hover { text-decoration: underline; }
.eng-post-text { margin-top: 4px; color: #333; white-space: pre-wrap; word-break: break-word; font-size: 12px; line-height: 1.4; }
`;
