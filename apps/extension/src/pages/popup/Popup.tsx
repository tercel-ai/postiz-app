import React, { useCallback, useEffect, useState } from 'react';
import { ComposeForm } from '@gitroom/extension/pages/popup/components/ComposeForm';
import { HistoryList } from '@gitroom/extension/pages/popup/components/HistoryList';
import { LoginForm } from '@gitroom/extension/pages/popup/components/LoginForm';
import { AuthUser, ACCESS_KEY } from '@gitroom/extension/utils/auth.service';
import {
  appendHistory,
  clearHistory,
  loadHistory,
  ClearRange,
  ReplyHistoryItem,
  STORAGE_KEY,
} from '@gitroom/extension/utils/reply.history';

export default function Popup() {
  const [history, setHistory] = useState<ReplyHistoryItem[]>([]);
  // undefined = checking, null = logged out, object = logged in
  const [user, setUser] = useState<AuthUser | null | undefined>(undefined);

  useEffect(() => {
    chrome.runtime
      .sendMessage({ action: 'auth:state' })
      .then((r) => setUser(r?.user ?? null))
      .catch(() => setUser(null));

    // Stay live while open: if the background clears or sets the bridged session
    // after our initial snapshot (e.g. the content-script bridge pushes an empty
    // token once a logging-out tab finishes navigating), reflect it immediately
    // instead of waiting for another click.
    const onSession = (
      changes: { [k: string]: chrome.storage.StorageChange },
      area: string
    ) => {
      if (area !== 'session' || !changes[ACCESS_KEY]) return;
      const next = changes[ACCESS_KEY].newValue as
        | { user?: AuthUser }
        | undefined;
      setUser(next?.user ?? null);
    };
    chrome.storage.onChanged.addListener(onSession);
    return () => chrome.storage.onChanged.removeListener(onSession);
  }, []);

  const handleLogout = useCallback(async () => {
    await chrome.runtime.sendMessage({ action: 'auth:logout' });
    setUser(null);
  }, []);

  useEffect(() => {
    loadHistory().then(setHistory);

    // Live-refresh when the background / bridge writes a new reply while the
    // popup is open (e.g. an Engage reply posted from the page).
    const onChanged = (
      changes: { [k: string]: chrome.storage.StorageChange },
      area: string
    ) => {
      if (area === 'local' && changes[STORAGE_KEY]) {
        const next = changes[STORAGE_KEY].newValue;
        setHistory(Array.isArray(next) ? next : []);
      }
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);

  const handleSubmitted = useCallback(async (item: ReplyHistoryItem) => {
    const next = await appendHistory(item);
    setHistory(next);
  }, []);

  const handleClear = useCallback(async (range: ClearRange) => {
    const next = await clearHistory(range);
    setHistory(next);
  }, []);

  if (user === undefined) return null; // still checking auth

  return (
    <div className="pz">
      <div className="pz-header">
        <div className="pz-logo">A</div>
        <div className="pz-title">Aisee · Reply</div>
        {user ? (
          <div
            style={{
              marginLeft: 'auto',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              minWidth: 0,
            }}
          >
            <span
              className="pz-sub"
              title={user.email}
              style={{
                marginLeft: 0,
                maxWidth: 160,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {user.username || user.email}
            </span>
            <button className="pz-clear-btn" onClick={handleLogout}>
              Log out
            </button>
          </div>
        ) : (
          <div className="pz-sub">in-browser</div>
        )}
      </div>

      {user ? (
        <>
          <ComposeForm onSubmitted={handleSubmitted} />
          <div className="pz-divider" />
          <HistoryList items={history} onClear={handleClear} />
        </>
      ) : (
        <LoginForm onLoggedIn={setUser} />
      )}
    </div>
  );
}
