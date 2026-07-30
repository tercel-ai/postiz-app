import React from 'react';
import type {
  PlatformLoginEntry,
  SessionPlatform,
} from '@gitroom/extension/utils/social-sessions';
import { usePlatformSessions } from '@gitroom/extension/pages/popup/hooks/usePlatformSessions';

interface PlatformRow {
  key: SessionPlatform;
  label: string;
  /** Opened when the platform is signed out. */
  loginUrl: string;
  /** Why no account name is shown even while signed in. */
  identityNote?: string;
}

// Types only are imported from the SW module (erased at build time); the row
// catalog lives here so the popup bundle never pulls the worker's probe code.
const PLATFORM_ROWS: PlatformRow[] = [
  { key: 'x', label: '𝕏 (Twitter)', loginUrl: 'https://x.com/i/flow/login' },
  { key: 'reddit', label: 'Reddit', loginUrl: 'https://www.reddit.com/login/' },
  {
    key: 'linkedin',
    label: 'LinkedIn',
    loginUrl: 'https://www.linkedin.com/login',
    identityNote: 'account resolved at publish time',
  },
  {
    key: 'medium',
    label: 'Medium',
    loginUrl: 'https://medium.com/m/signin',
  },
  {
    key: 'quora',
    label: 'Quora',
    loginUrl: 'https://www.quora.com/',
    identityNote: 'account readable only inside a Quora tab',
  },
  {
    key: 'hackernews',
    label: 'Hacker News',
    loginUrl: 'https://news.ycombinator.com/login',
  },
  { key: 'devto', label: 'dev.to', loginUrl: 'https://dev.to/enter' },
];

function accountLabel(entry: PlatformLoginEntry): string | null {
  if (entry.handle) return `@${entry.handle}`;
  if (entry.name) return entry.name;
  if (entry.id) return entry.id;
  return null;
}

function openTab(url: string): void {
  chrome.tabs.create({ url });
}

/**
 * "Platforms 3/6" — how many of the platforms the extension drives through the
 * browser are actually signed in. Click to expand: each signed-in row names the
 * account, each signed-out row offers a Log in button that opens that
 * platform's login page.
 *
 * Replaces the older banner, which warned about X and Reddit only and said
 * nothing at all when everything was fine.
 */
export function PlatformLoginBar() {
  const [open, setOpen] = React.useState(false);
  const { entries, detailed, busy, load } = usePlatformSessions(true);

  const byKey = React.useMemo(() => {
    const map: Partial<Record<string, PlatformLoginEntry>> = {};
    for (const e of entries || []) map[e.platform] = e;
    return map;
  }, [entries]);

  const signedIn = (entries || []).filter((e) => e.loggedIn).length;
  const total = PLATFORM_ROWS.length;
  const missing = entries ? total - signedIn : 0;

  const toggle = () => {
    const next = !open;
    setOpen(next);
    // Identity costs real work (a Reddit me.json read, an X background tab), so
    // it is paid only when the user asks to see who is signed in.
    if (next && !detailed) load(true);
  };

  return (
    <div className="pz-platforms">
      <button
        className="pz-platforms-toggle"
        onClick={toggle}
        title="Social platform logins in this browser"
      >
        <span className="pz-platforms-label">Platform logins</span>
        {entries ? (
          <span
            className={`pz-platforms-count${missing > 0 ? ' warn' : ' ok'}`}
          >
            {signedIn}/{total}
          </span>
        ) : (
          <span className="pz-platforms-count">…</span>
        )}
        <span className="pz-platforms-caret">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div className="pz-platforms-list">
          {busy && !detailed && (
            <div className="pz-platforms-hint">Reading accounts…</div>
          )}
          {PLATFORM_ROWS.map((row) => {
            const entry = byKey[row.key];
            const account = entry && entry.loggedIn ? accountLabel(entry) : null;
            return (
              <div className="pz-platform-row" key={row.key}>
                {entry?.avatarUrl ? (
                  <img
                    className="pz-platform-avatar"
                    src={entry.avatarUrl}
                    alt=""
                  />
                ) : (
                  <span
                    className={`pz-platform-dot${entry?.loggedIn ? ' on' : ' off'}`}
                  />
                )}
                <span className="pz-platform-name">{row.label}</span>
                {entry?.loggedIn ? (
                  <span
                    className="pz-platform-account"
                    title={account || row.identityNote || 'Signed in'}
                  >
                    {/* Until the detailed pass lands there is a session but no
                        name yet — "…" says loading, "signed in" says the name
                        is simply not obtainable (see identityNote). */}
                    {account || (detailed ? 'signed in' : '…')}
                  </span>
                ) : (
                  <button
                    className="pz-platform-login-btn"
                    onClick={() => openTab(row.loginUrl)}
                  >
                    Log in ↗
                  </button>
                )}
              </div>
            );
          })}
          <button
            className="pz-platforms-refresh"
            onClick={() => load(true)}
            disabled={busy}
          >
            {busy ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      )}
    </div>
  );
}
