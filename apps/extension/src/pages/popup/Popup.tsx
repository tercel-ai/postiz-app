import React, { FC, useCallback, useState } from 'react';

interface ReplyResult {
  ok: boolean;
  pending?: boolean;
  permalink?: string;
  message?: string;
  error?: string;
  detail?: unknown;
}

type Platform = 'reddit' | 'x';

/**
 * Debug console: simulates the data that Engage would send (url + text),
 * and drives the same background `postReply` path. Use this to verify the
 * in-browser reply flow before wiring it to the Engage UI.
 */
const DebugReplyConsole: FC = () => {
  const [platform, setPlatform] = useState<Platform>('reddit');
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<ReplyResult | null>(null);

  const submit = useCallback(async () => {
    setSending(true);
    setResult(null);
    try {
      const res: ReplyResult = await chrome.runtime.sendMessage({
        action: 'postReply',
        payload: { platform, url: url.trim(), text },
      });
      setResult(res || { ok: false, error: 'No response from background' });
    } catch (e: any) {
      setResult({ ok: false, error: String(e?.message || e) });
    } finally {
      setSending(false);
    }
  }, [platform, url, text]);

  const disabled = sending || !url.trim() || !text.trim();

  return (
    <div className="flex flex-col gap-3 p-4" style={{ width: 360 }}>
      <div className="text-lg font-semibold">Postiz · Reply Debug</div>
      <div className="text-xs opacity-70">
        Simulates Engage data. Posts as your logged-in {platform} session.
      </div>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Platform</span>
        <select
          className="border rounded px-2 py-1"
          value={platform}
          onChange={(e) => setPlatform(e.target.value as Platform)}
        >
          <option value="reddit">Reddit (posts on submit)</option>
          <option value="x">X (fills box — you click Reply)</option>
        </select>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Target URL</span>
        <input
          className="border rounded px-2 py-1"
          placeholder="https://www.reddit.com/r/sub/comments/<id>/..."
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Reply text</span>
        <textarea
          className="border rounded px-2 py-1"
          rows={4}
          placeholder="Your reply…"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </label>

      <button
        className="rounded px-3 py-2 text-white disabled:opacity-50"
        style={{ backgroundColor: '#612bd3' }}
        disabled={disabled}
        onClick={submit}
      >
        {sending ? 'Sending…' : 'Submit reply'}
      </button>

      {result && (
        <div
          className="text-sm rounded p-2"
          style={{
            backgroundColor: !result.ok
              ? '#fcebec'
              : result.pending
              ? '#fff7e6'
              : '#e7f6ec',
            color: !result.ok
              ? '#b91c1c'
              : result.pending
              ? '#92400e'
              : '#1a7f37',
          }}
        >
          {result.ok ? (
            <>
              <div className="font-medium">
                {result.pending ? '📝 Filled — awaiting your send' : '✅ Posted'}
              </div>
              {result.message && (
                <div className="break-all">{result.message}</div>
              )}
              {result.permalink && (
                <a
                  href={result.permalink}
                  target="_blank"
                  rel="noreferrer"
                  className="underline break-all"
                >
                  {result.permalink}
                </a>
              )}
            </>
          ) : (
            <>
              <div className="font-medium">❌ Failed</div>
              <div className="break-all">{result.error}</div>
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default function Popup() {
  return <DebugReplyConsole />;
}
