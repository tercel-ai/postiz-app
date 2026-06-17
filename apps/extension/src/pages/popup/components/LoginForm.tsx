import React, { FC, useCallback } from 'react';

// LOGIN_URL is injected at build time (pack-ext-dev / pack-ext-prod via LOGIN_URL= prefix).
// For local dev it falls back to FRONTEND_URL (from .env) + '/sign-in'.
const LOGIN_URL: string =
  import.meta.env.LOGIN_URL ||
  `${(import.meta.env.FRONTEND_URL as string | undefined) ?? ''}/sign-in`;

export const LoginForm: FC = () => {
  const openLogin = useCallback(() => {
    chrome.tabs.create({ url: LOGIN_URL });
  }, []);

  return (
    <div className="pz-form">
      <p className="pz-sub" style={{ marginBottom: 8 }}>
        Sign in to your Aisee account to get started.
      </p>
      <button className="pz-btn" onClick={openLogin}>
        Sign in
      </button>
    </div>
  );
};
