import React, { FC, useCallback, useState } from 'react';
import { AuthUser } from '@gitroom/extension/utils/auth.service';

/**
 * Email + password login. The password is SHA-1 hashed in the background before
 * it's sent and is never stored — only the access token (in chrome.storage.session)
 * and the httpOnly refresh-token cookie are kept.
 */
export const LoginForm: FC<{ onLoggedIn: (user: AuthUser) => void }> = ({
  onLoggedIn,
}) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await chrome.runtime.sendMessage({
        action: 'auth:login',
        email: email.trim(),
        password,
      });
      if (res?.ok) {
        setPassword(''); // drop it from state immediately
        onLoggedIn(res.user);
      } else {
        setError(res?.error || 'Login failed');
      }
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }, [email, password, onLoggedIn]);

  const disabled = loading || !email.trim() || !password;

  return (
    <div className="pz-form">
      <input
        className="pz-field"
        type="email"
        autoComplete="username"
        placeholder="Email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && !disabled && submit()}
      />
      <input
        className="pz-field"
        type="password"
        autoComplete="current-password"
        placeholder="Password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && !disabled && submit()}
      />
      <button className="pz-btn" disabled={disabled} onClick={submit}>
        {loading ? 'Logging in…' : 'Log in'}
      </button>
      {error && (
        <div className="pz-result fail">
          <div className="pz-result-title">❌ Login failed</div>
          <div>{error}</div>
        </div>
      )}
    </div>
  );
};
