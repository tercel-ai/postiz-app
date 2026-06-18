const isDev = process.env.NODE_ENV === 'development';
export const sendRequest = (
  auth: string,
  url: string,
  method: 'GET' | 'POST' | 'DELETE' | 'PATCH',
  body?: string
) => {
  return chrome.runtime.sendMessage({
    action: 'makeHttpRequest',
    url,
    method,
    body,
    auth,
  });
};

export const fetchRequestUtil = async (request: any) => {
  // Backend API base (NestJS on api-post*). NOT FRONTEND_URL — that is the web
  // app (app*.aisee.live), which does not serve these routes; hitting it makes
  // backend calls fail (404 / redirect / "Failed to fetch").
  const backendBase =
    import.meta.env?.NEXT_PUBLIC_BACKEND_URL ||
    process?.env?.NEXT_PUBLIC_BACKEND_URL;
  const res = await fetch(
    backendBase + request.url,
    {
      method: request.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        // The auth cookie value is a JWT; the backend AuthMiddleware only reads
        // the Authorization header when it is prefixed with "Bearer ".
        ...(request.auth ? { Authorization: `Bearer ${request.auth}` } : {}),
      },
      ...(request.body ? { body: request.body } : {}),
    }
  );

  // Tolerate empty / non-JSON bodies (e.g. errors) without throwing.
  const text = await res.text().catch(() => '');
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { ok: res.ok, status: res.status, data };
};
