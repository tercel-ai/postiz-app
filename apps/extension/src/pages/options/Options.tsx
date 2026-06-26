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
.xdbg-date { color: #999; }
.xdbg-text { margin: 6px 0; font-size: 14px; white-space: pre-wrap; word-break: break-word; }
.xdbg-stats { color: #555; font-size: 12px; }
`;
