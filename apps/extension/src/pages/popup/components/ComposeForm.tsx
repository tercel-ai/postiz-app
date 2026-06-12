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
  const resultClass = !result?.ok ? 'fail' : result.pending ? 'pending' : 'ok';
  const resultTitle = !result?.ok
    ? '❌ Failed'
    : result.pending
    ? '📝 Filled — awaiting send'
    : '✅ Posted';

  return (
    <div className="pz-form">
      <div className="pz-row">
        <select
          className="pz-field pz-select"
          value={platform}
          onChange={(e) => setPlatform(e.target.value as Platform)}
        >
          <option value="reddit">Reddit</option>
          <option value="x">X</option>
        </select>
        <input
          className="pz-field pz-input"
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
        className="pz-field pz-textarea"
        placeholder="Your reply…"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />

      <button className="pz-btn" disabled={disabled} onClick={submit}>
        {sending ? 'Posting…' : platform === 'x' ? 'Post reply on X' : 'Post reply'}
      </button>

      {result && (
        <div className={`pz-result ${resultClass}`}>
          <div className="pz-result-title">{resultTitle}</div>
          {(result.message || result.error) && (
            <div>{result.message || result.error}</div>
          )}
          {result.permalink && (
            <a href={result.permalink} target="_blank" rel="noreferrer">
              {result.permalink}
            </a>
          )}
        </div>
      )}
    </div>
  );
};
