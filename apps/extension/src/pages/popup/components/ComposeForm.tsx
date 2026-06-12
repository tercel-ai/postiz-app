import React, { FC, useCallback, useState } from 'react';
import { ReplyResult } from '@gitroom/extension/utils/reply.types';
import { ReplyHistoryItem } from '@gitroom/extension/utils/reply.history';

type Platform = 'reddit' | 'x';

const deriveStatus = (r: ReplyResult): ReplyHistoryItem['status'] => {
  if (!r.ok) return 'failed';
  if (r.pending) return 'pending';
  return 'sent';
};

export const ComposeForm: FC<{
  onSubmitted: (item: ReplyHistoryItem) => void;
}> = ({ onSubmitted }) => {
  const [platform, setPlatform] = useState<Platform>('reddit');
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<ReplyResult | null>(null);

  const submit = useCallback(async () => {
    setSending(true);
    setResult(null);
    const targetUrl = url.trim();
    try {
      const res: ReplyResult = await chrome.runtime.sendMessage({
        action: 'postReply',
        payload: { platform, url: targetUrl, text },
      });
      const safe = res || { ok: false, error: 'No response from background' };
      setResult(safe);

      onSubmitted({
        id:
          (crypto as any)?.randomUUID?.() ??
          `${Date.now()}-${Math.round(Math.random() * 1e6)}`,
        platform,
        targetUrl,
        content: text,
        permalink: safe.permalink,
        postId: safe.postId,
        status: deriveStatus(safe),
        createdAt: Date.now(),
      });

      if (safe.ok) setText('');
    } catch (e: any) {
      setResult({ ok: false, error: String(e?.message || e) });
    } finally {
      setSending(false);
    }
  }, [platform, url, text, onSubmitted]);

  const disabled = sending || !url.trim() || !text.trim();

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <div
          className="h-6 w-6 rounded-md flex items-center justify-center text-white text-xs font-bold"
          style={{ backgroundColor: '#612bd3' }}
        >
          P
        </div>
        <div className="text-sm font-semibold leading-tight">
          Postiz · Reply
        </div>
      </div>

      <div className="flex gap-2">
        <select
          className="border border-gray-300 rounded-md px-2 py-1.5 text-sm bg-white"
          value={platform}
          onChange={(e) => setPlatform(e.target.value as Platform)}
        >
          <option value="reddit">Reddit</option>
          <option value="x">X</option>
        </select>
        <input
          className="flex-1 border border-gray-300 rounded-md px-2 py-1.5 text-sm"
          placeholder={
            platform === 'reddit'
              ? 'reddit.com/r/…/comments/<id>/…'
              : 'x.com/<user>/status/<id>'
          }
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
      </div>

      <textarea
        className="border border-gray-300 rounded-md px-2 py-1.5 text-sm resize-none"
        rows={3}
        placeholder="Your reply…"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />

      <button
        className="rounded-md px-3 py-2 text-white text-sm font-medium transition-opacity disabled:opacity-40"
        style={{ backgroundColor: '#612bd3' }}
        disabled={disabled}
        onClick={submit}
      >
        {sending
          ? 'Sending…'
          : platform === 'x'
          ? 'Post reply on X'
          : 'Post reply'}
      </button>

      {result && (
        <div
          className="text-xs rounded-md px-2 py-1.5"
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
          <div className="font-medium">
            {!result.ok
              ? '❌ Failed'
              : result.pending
              ? '📝 Filled — awaiting your send'
              : '✅ Posted'}
          </div>
          {(result.message || result.error) && (
            <div className="break-all">{result.message || result.error}</div>
          )}
        </div>
      )}
    </div>
  );
};
