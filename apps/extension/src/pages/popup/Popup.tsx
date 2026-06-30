import React, { useCallback, useEffect, useState } from 'react';
import { HistoryList } from '@gitroom/extension/pages/popup/components/HistoryList';
import { ClearHistoryPage } from '@gitroom/extension/pages/popup/components/ClearHistoryPage';
import { LoginForm } from '@gitroom/extension/pages/popup/components/LoginForm';
import { EngageScanPanel, checkPlatformLogin } from '@gitroom/extension/pages/popup/components/ScanPanel';
import { AuthUser, ACCESS_KEY } from '@gitroom/extension/utils/auth.service';
import {
  clearHistory,
  loadHistory,
  ClearRange,
  ReplyHistoryItem,
  STORAGE_KEY,
} from '@gitroom/extension/utils/reply.history';

export default function Popup() {
  const [history, setHistory] = useState<ReplyHistoryItem[]>([]);
  const [view, setView] = useState<'main' | 'clear' | 'scan'>('main');
  // undefined = checking, null = logged out, object = logged in
  const [user, setUser] = useState<AuthUser | null | undefined>(undefined);
  // null = still checking, true/false = result
  const [platformLogin, setPlatformLogin] = useState<{ x: boolean | null; reddit: boolean | null }>({ x: null, reddit: null });

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

  // Only check platform login after Aisee auth is confirmed — keeps the
  // cookies IPC calls off the critical path for initial popup rendering.
  useEffect(() => {
    if (!user) return;
    Promise.all([checkPlatformLogin('x'), checkPlatformLogin('reddit')])
      .then(([x, reddit]) => setPlatformLogin({ x, reddit }));
  }, [user]);

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

  const handleClear = useCallback(async (range: ClearRange) => {
    const next = await clearHistory(range);
    setHistory(next);
  }, []);

  if (user === undefined) return null; // still checking auth

  if (view === 'clear') {
    return (
      <ClearHistoryPage
        items={history}
        onClear={handleClear}
        onBack={() => setView('main')}
      />
    );
  }

  if (view === 'scan') {
    return (
      <div className="pz">
        <div className="pz-header">
          <button className="pz-back-btn" onClick={() => setView('main')}>←</button>
          <div className="pz-title" style={{ fontSize: 14 }}>Scan Automation</div>
        </div>
        <div style={{ padding: '12px 14px', overflowY: 'auto', maxHeight: 560 }}>
          <EngageScanPanel />
        </div>
      </div>
    );
  }

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
              {user.email}
            </span>
            <button
              className="pz-clear-btn"
              title="Scan automation panel"
              onClick={() => setView('scan')}
            >
              ⚙
            </button>
            <button className="pz-clear-btn" onClick={handleLogout}>
              Log out
            </button>
          </div>
        ) : (
          <div className="pz-sub">in-browser</div>
        )}
      </div>

      {user && (platformLogin.x === null || platformLogin.reddit === null) && (
        <div className="pz-platform-checking">Checking platform logins…</div>
      )}
      {user && (platformLogin.x === false || platformLogin.reddit === false) && (
        <div className="pz-platform-warn">
          {platformLogin.x === false && (
            <div className="pz-platform-warn-row">
              <span className="pz-platform-warn-label">𝕏 not logged in — scans won't run</span>
              <button className="pz-platform-login-btn" onClick={() => chrome.tabs.create({ url: 'https://x.com/i/flow/login' })}>
                Log in ↗
              </button>
            </div>
          )}
          {platformLogin.reddit === false && (
            <div className="pz-platform-warn-row">
              <span className="pz-platform-warn-label">Reddit not logged in — scans won't run</span>
              <button className="pz-platform-login-btn" onClick={() => chrome.tabs.create({ url: 'https://www.reddit.com/login/' })}>
                Log in ↗
              </button>
            </div>
          )}
        </div>
      )}

      {user ? (
        <HistoryList items={history} onClearPage={() => setView('clear')} />
      ) : (
        <LoginForm />
      )}
    </div>
  );
}
