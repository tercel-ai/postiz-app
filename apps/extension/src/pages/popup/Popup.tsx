import React, { useCallback, useState } from 'react';
import { HistoryList } from '@gitroom/extension/pages/popup/components/HistoryList';
import { PublishQueueList } from '@gitroom/extension/pages/popup/components/PublishQueueList';
import { ClearHistoryPage } from '@gitroom/extension/pages/popup/components/ClearHistoryPage';
import { ClearQueuePage } from '@gitroom/extension/pages/popup/components/ClearQueuePage';
import { LoginForm } from '@gitroom/extension/pages/popup/components/LoginForm';
import { EngageScanPanel } from '@gitroom/extension/pages/popup/components/ScanPanel';
import { useAiseeSession } from '@gitroom/extension/pages/popup/hooks/useAiseeSession';
import { useReplyHistoryState } from '@gitroom/extension/pages/popup/hooks/useReplyHistoryState';
import { usePublishQueueState } from '@gitroom/extension/pages/popup/hooks/usePublishQueueState';

export default function Popup() {
  const { user, platformLogin, planName, handleLogout } = useAiseeSession();
  const { history, handleClear } = useReplyHistoryState();
  const {
    rows: queueRows,
    publishNow,
    cancelTask,
    syncTask,
    retryTask,
    removeTask,
    clearSettled,
    clearQueued,
  } = usePublishQueueState();
  const [view, setView] = useState<'main' | 'clear' | 'clear-queue' | 'scan'>('main');
  const [tab, setTab] = useState<'queue' | 'replies'>('queue');

  // chrome.sidePanel is Chrome-only (this same bundle also ships for Firefox,
  // which has no equivalent API) — feature-detect rather than build-flag so
  // the button just doesn't render there.
  const hasSidePanel = typeof chrome !== 'undefined' && 'sidePanel' in chrome;
  const openSidePanel = useCallback(async () => {
    try {
      const win = await chrome.windows.getCurrent();
      if (win.id != null) {
        await chrome.sidePanel.open({ windowId: win.id });
        window.close();
      }
    } catch {
      // ignore — nothing sensible to show the user for a platform API failure here
    }
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

  if (view === 'clear-queue') {
    return (
      <ClearQueuePage
        rows={queueRows}
        onClearSettled={clearSettled}
        onClearQueued={clearQueued}
        onBack={() => setView('main')}
      />
    );
  }

  if (view === 'scan') {
    return (
      <div className="pz">
        <div className="pz-header">
          <div className="pz-header-row">
            <button className="pz-back-btn" onClick={() => setView('main')}>←</button>
            <div className="pz-title" style={{ fontSize: 14 }}>Scan Automation</div>
          </div>
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
        <div className="pz-header-row">
          <img className="pz-logo" src="/icon-32.png" alt="Aisee" />
          <div className="pz-title">Aisee</div>
          {user ? (
            <div className="pz-header-actions">
              {hasSidePanel && (
                <button
                  className="pz-clear-btn"
                  title="Open in side panel"
                  onClick={openSidePanel}
                >
                  ▤
                </button>
              )}
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
            <div className="pz-sub" style={{ marginLeft: 'auto' }}>in-browser</div>
          )}
        </div>
        {user && (
          <div className="pz-header-account">
            <span
              className="pz-sub"
              title={user.email}
              style={{
                flex: 1,
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {user.email}
            </span>
            <span className="pz-plan-badge" title={planName || 'Free'}>
              {planName || 'Free'}
            </span>
          </div>
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
        <>
          <div className="pz-tabs">
            <button
              className={`pz-tab${tab === 'queue' ? ' active' : ''}`}
              onClick={() => setTab('queue')}
            >
              Post Queue
              <span className="pz-tab-count">{queueRows.length}</span>
            </button>
            <button
              className={`pz-tab${tab === 'replies' ? ' active' : ''}`}
              onClick={() => setTab('replies')}
            >
              Engage Replies
              <span className="pz-tab-count">{history.length}</span>
            </button>
            <button
              className="pz-clear-btn"
              onClick={() => setView(tab === 'queue' ? 'clear-queue' : 'clear')}
            >
              Clear ›
            </button>
          </div>

          {tab === 'queue' ? (
            <PublishQueueList
              embedded
              rows={queueRows}
              onPublishNow={publishNow}
              onCancel={cancelTask}
              onSync={syncTask}
              onRetry={retryTask}
              onRemove={removeTask}
            />
          ) : (
            <HistoryList embedded items={history} onClearPage={() => setView('clear')} />
          )}
        </>
      ) : (
        <LoginForm />
      )}
    </div>
  );
}
