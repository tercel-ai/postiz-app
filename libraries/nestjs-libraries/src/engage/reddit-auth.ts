// Reddit app-only OAuth (client_credentials) token cache.
// Both backend and orchestrator are separate processes — each maintains its own cache.
// Token lifetime is 1 hour; we refresh 60 s before expiry.

interface TokenCache {
  token: string;
  expiresAt: number; // epoch ms
}

let _cache: TokenCache | null = null;

export async function getRedditToken(): Promise<string | null> {
  const clientId = process.env.REDDIT_CLIENT_ID;
  const clientSecret = process.env.REDDIT_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  if (_cache && _cache.expiresAt > Date.now() + 60_000) {
    return _cache.token;
  }

  try {
    const res = await fetch('https://www.reddit.com/api/v1/access_token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'AISEE-Engage/1.0',
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) return null;

    const data = (await res.json()) as { access_token: string; expires_in: number };
    const ttlMs = Number.isFinite(data.expires_in) ? data.expires_in * 1000 : 3_600_000;
    _cache = {
      token: data.access_token,
      expiresAt: Date.now() + ttlMs,
    };
    return _cache.token;
  } catch {
    return null;
  }
}

export function redditAuthHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'User-Agent': 'AISEE-Engage/1.0',
  };
}
