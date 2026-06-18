// Authenticated calls from the service worker to the Postiz backend. Reuses the
// same transport as the rest of the extension (`fetchRequestUtil`, which
// prepends FRONTEND_URL — the backend API base — and tolerates empty bodies)
// and the auth session resolver (silent-refreshing access token).

import { fetchRequestUtil } from '@gitroom/extension/utils/request.util';
import { getValidAccessToken } from '@gitroom/extension/utils/auth.service';

export interface BackendResponse<T> {
  ok: boolean;
  status: number;
  data: T;
}

/** Thrown when no valid session is available — callers should bail quietly. */
export class NotAuthenticatedError extends Error {
  constructor() {
    super('Not authenticated: no valid access token');
    this.name = 'NotAuthenticatedError';
  }
}

export async function backendCall<T = unknown>(
  url: string,
  method: 'GET' | 'POST' | 'DELETE' | 'PATCH',
  body?: unknown
): Promise<BackendResponse<T>> {
  const auth = await getValidAccessToken();
  if (!auth) throw new NotAuthenticatedError();
  return (await fetchRequestUtil({
    url,
    method,
    auth,
    body: body == null ? undefined : JSON.stringify(body),
  })) as BackendResponse<T>;
}
