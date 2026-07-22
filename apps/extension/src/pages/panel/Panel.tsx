import React from 'react';
import { HistoryList } from '@gitroom/extension/pages/popup/components/HistoryList';
import { PublishQueueList } from '@gitroom/extension/pages/popup/components/PublishQueueList';
import { ClearHistoryPage } from '@gitroom/extension/pages/popup/components/ClearHistoryPage';
import { LoginForm } from '@gitroom/extension/pages/popup/components/LoginForm';
import { EngageScanPanel } from '@gitroom/extension/pages/popup/components/ScanPanel';
import { useAiseeSession } from '@gitroom/extension/pages/popup/hooks/useAiseeSession';
import { useReplyHistoryState } from '@gitroom/extension/pages/popup/hooks/useReplyHistoryState';
import { usePublishQueueState } from '@gitroom/extension/pages/popup/hooks/usePublishQueueState';

// The side panel's whole point is to survive being clicked away from (unlike
// the popup, which the browser tears down on blur). So EngageScanPanel must
// stay mounted AT ALL TIMES here, regardless of which view is showing — both
// "Scan Automation" and "Clear History" are shown/hidden with CSS, never a
// conditional-return view swap, which would unmount it and orphan an
// in-flight Run All loop exactly like the popup's old view switch used to.
export default function Panel() {
  const { user, platformLogin, planName, handleLogout } = useAiseeSession();
  const { history, handleClear } = useReplyHistoryState();
  const { rows: queueRows, publishNow, cancelTask } = usePublishQueueState();
  const [view, setView] = React.useState<'home' | 'scan'>('home');
  const [showClear, setShowClear] = React.useState(false);

  if (user === undefined) return null; // still checking auth

  return (
    <div className="pz" style={{ minHeight: '100vh' }}>
      <div className="pz-header">
        <div className="pz-header-row">
          <img className="pz-logo" src="/icon-32.png" alt="Aisee" />
          <div className="pz-title">Aisee</div>
          {user && (
            <div className="pz-header-actions">
              {view === 'scan' ? (
                <button className="pz-clear-btn" title="Back to home" onClick={() => setView('home')}>
                  ← Home
                </button>
              ) : (
                <button className="pz-clear-btn" title="Scan automation panel" onClick={() => setView('scan')}>
                  ⚙
                </button>
              )}
              <button className="pz-clear-btn" onClick={handleLogout}>
                Log out
              </button>
            </div>
          )}
        </div>
        {user && (
          <div className="pz-header-account">
            <span
              className="pz-sub"
              title={user.email}
              style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            >
              {user.email}
            </span>
            <span className="pz-plan-badge" title={planName || 'Free'}>
              {planName || 'Free'}
            </span>
          </div>
        )}
      </div>

      {user && view === 'home' && (platformLogin.x === null || platformLogin.reddit === null) && (
        <div className="pz-platform-checking">Checking platform logins…</div>
      )}
      {user && view === 'home' && (platformLogin.x === false || platformLogin.reddit === false) && (
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

      {!user && <LoginForm />}

      {user && (
        <div style={{ display: view === 'home' ? 'block' : 'none' }}>
          <PublishQueueList
            rows={queueRows}
            onPublishNow={publishNow}
            onCancel={cancelTask}
          />
          <HistoryList items={history} onClearPage={() => setShowClear(true)} />
        </div>
      )}

      {user && (
        <div style={{ display: view === 'scan' ? 'block' : 'none', padding: '12px 14px' }}>
          <EngageScanPanel />
        </div>
      )}

      {showClear && (
        <div style={{ position: 'fixed', inset: 0, background: '#fff', zIndex: 10, overflowY: 'auto' }}>
          <ClearHistoryPage items={history} onClear={handleClear} onBack={() => setShowClear(false)} />
        </div>
      )}
    </div>
  );
}
