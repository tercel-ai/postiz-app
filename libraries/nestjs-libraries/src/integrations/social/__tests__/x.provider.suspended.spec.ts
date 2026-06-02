import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock @prisma/client BEFORE importing XProvider so the static prisma instance
// in XProvider doesn't try to connect to a real DB at import time.
vi.mock('@prisma/client', () => {
  return {
    PrismaClient: class {
      integration = {
        findUnique: vi.fn(),
        update: vi.fn(),
      };
      notifications = {
        create: vi.fn(),
      };
    },
  };
});

// Mock twitter-api-v2 — we never call it in these tests, but XProvider imports it.
vi.mock('twitter-api-v2', () => ({
  TwitterApi: class {},
  TweetV2: class {},
}));

// Mock readOrFetch and sharp which load native deps unrelated to this test
vi.mock('@gitroom/helpers/utils/read.or.fetch', () => ({
  readOrFetch: vi.fn(),
}));
vi.mock('sharp', () => ({ default: vi.fn() }));
vi.mock('mime-types', () => ({ lookup: vi.fn() }));

import { XProvider } from '../x.provider';

describe('XProvider — suspended account detection', () => {
  let provider: XProvider;

  beforeEach(() => {
    provider = new XProvider();
  });

  describe('_isUserSuspendedError', () => {
    const isSuspended = (err: any) =>
      (provider as any)._isUserSuspendedError(err);

    it('returns true for the canonical X user-suspended response', () => {
      const err = {
        code: 403,
        data: {
          detail: 'The user used for authentication is suspended',
          title: 'Forbidden',
          status: 403,
          type: 'https://api.twitter.com/2/problems/user-suspended',
        },
      };
      expect(isSuspended(err)).toBe(true);
    });

    it('returns true when type contains app-suspended', () => {
      const err = {
        code: 403,
        data: {
          type: 'https://api.twitter.com/2/problems/app-suspended',
        },
      };
      expect(isSuspended(err)).toBe(true);
    });

    it('returns true when only the detail string identifies suspension', () => {
      const err = {
        code: 403,
        data: {
          detail: 'The user used for authentication is suspended',
        },
      };
      expect(isSuspended(err)).toBe(true);
    });

    it('returns false for ordinary 403 (e.g. content policy)', () => {
      const err = {
        code: 403,
        data: {
          detail: 'You are not permitted to perform this action',
          type: 'https://api.twitter.com/2/problems/forbidden',
        },
      };
      expect(isSuspended(err)).toBe(false);
    });

    it('returns false for 401 invalid token', () => {
      const err = {
        code: 401,
        data: {
          detail: 'Invalid or expired token',
          type: 'https://api.twitter.com/2/problems/invalid-request',
        },
      };
      expect(isSuspended(err)).toBe(false);
    });

    it('returns false for rate limit 429', () => {
      const err = {
        code: 429,
        data: { detail: 'Too Many Requests' },
      };
      expect(isSuspended(err)).toBe(false);
    });

    it('returns false for null / undefined / non-object', () => {
      expect(isSuspended(null)).toBe(false);
      expect(isSuspended(undefined)).toBe(false);
      expect(isSuspended('string error')).toBe(false);
      expect(isSuspended({})).toBe(false);
    });

    it('returns false when err.data.type is not a string', () => {
      const err = { code: 403, data: { type: 12345 } };
      expect(isSuspended(err)).toBe(false);
    });
  });

  describe('handleErrors — pre-existing behavior preserved', () => {
    // Sanity-check: suspended (and other un-branched) 403 bodies fall through to
    // the generic 403 branch in handleErrors and classify as 'bad-body'. This
    // test pins that contract so a future regression doesn't silently change the
    // classification. (Surfacing the suspended state explicitly on the post
    // detail page would be a separate enhancement.)
    it('suspended bodies still classify as bad-body via the existing 403 branch', () => {
      const body = JSON.stringify({
        code: 403,
        data: {
          status: 403,
          type: 'https://api.twitter.com/2/problems/user-suspended',
          detail: 'The user used for authentication is suspended',
        },
      });

      const result = provider.handleErrors(body);
      expect(result?.type).toBe('bad-body');
      // Suspended bodies hit the generic 403 branch (no dedicated sub-branch),
      // which now returns the accurate "403 Forbidden / permission" message.
      expect(result?.value).toContain('403 Forbidden');
    });

    it('non-suspended 403 unchanged', () => {
      const body = JSON.stringify({
        code: 403,
        data: {
          status: 403,
          detail: 'You are not permitted to perform this action',
        },
      });
      const result = provider.handleErrors(body);
      expect(result?.type).toBe('bad-body');
      expect(result?.value).toContain('403 Forbidden');
    });
  });

  describe('handleErrors — 401 expired token', () => {
    it('returns refresh-token for twitter-api-v2 ApiResponseError code=401', () => {
      const body = JSON.stringify({
        name: 'ApiResponseError',
        message: 'Request failed with code 401',
        code: 401,
        data: { title: 'Unauthorized', status: 401, detail: 'Unauthorized' },
      });
      const result = provider.handleErrors(body);
      expect(result?.type).toBe('refresh-token');
    });

    it('returns refresh-token for "Request failed with code 401" message string', () => {
      const body = JSON.stringify({
        message: 'Request failed with code 401',
      });
      const result = provider.handleErrors(body);
      expect(result?.type).toBe('refresh-token');
    });

    it('does not match non-401 error codes', () => {
      const body = JSON.stringify({ code: 400, message: 'Bad Request' });
      const result = provider.handleErrors(body);
      expect(result?.type).not.toBe('refresh-token');
    });
  });

  // ---------------------------------------------------------------------------
  // _getUserInfo 401 → RefreshToken (regression for "Request failed with code 401"
  // unclear error and missing token-refresh trigger)
  // ---------------------------------------------------------------------------
  // Before the fix: _getUserInfo() at x.provider.ts:463-489 caught the
  // twitter-api-v2 ApiResponseError but only translated 403 → custom message.
  // For 401 it just `throw err` → the raw ApiResponseError ("Request failed
  // with code 401") propagated up through postSocial → Temporal wrapped it but
  // the type was NOT 'refresh_token' → workflow's reactive refresh path never
  // triggered → 5 retries with the same expired token → finally Post.error
  // ended up as the unclear "Request failed with code 401".
  //
  // After the fix: 401 is translated to `throw new RefreshToken(...)` with the
  // type='refresh_token' marker so the workflow can refresh and retry.
  describe('_getUserInfo — 401 translation (regression)', () => {
    it('throws RefreshToken (type=refresh_token) instead of raw ApiResponseError for 401', async () => {
      // Build a fake TwitterApi client whose .v2.me() throws the same shape
      // the real twitter-api-v2 library throws.
      const apiErr: any = new Error('Request failed with code 401');
      apiErr.name = 'ApiResponseError';
      apiErr.code = 401;
      apiErr.data = { title: 'Unauthorized', status: 401, detail: 'Unauthorized' };

      const fakeClient: any = {
        v2: {
          me: vi.fn().mockRejectedValue(apiErr),
        },
      };

      let thrown: any;
      try {
        await (provider as any)._getUserInfo(fakeClient);
      } catch (e) {
        thrown = e;
      }

      expect(thrown).toBeDefined();
      // The crucial property — without this, workflow won't recognize it as a
      // refreshable failure.
      expect(thrown.type).toBe('refresh_token');
      expect(thrown.name).toBe('ApplicationFailure');
      // User-facing message is clear, not the raw SDK string.
      expect(thrown.message).toBe(
        'X authentication has expired, please reconnect your account'
      );
      // Raw error details preserved in `details` for debugging.
      expect(thrown.details?.[0]).toBeDefined();
    });

    it('still throws the original error for non-401, non-403 statuses', async () => {
      const apiErr: any = new Error('Request failed with code 500');
      apiErr.code = 500;

      const fakeClient: any = {
        v2: { me: vi.fn().mockRejectedValue(apiErr) },
      };

      let thrown: any;
      try {
        await (provider as any)._getUserInfo(fakeClient);
      } catch (e) {
        thrown = e;
      }

      expect(thrown).toBe(apiErr); // exact same instance — not wrapped
      expect(thrown.type).toBeUndefined();
    });

    it('still throws clear suspended-account error for 403 (existing behavior preserved)', async () => {
      const suspendedErr: any = new Error('Forbidden');
      suspendedErr.code = 403;
      suspendedErr.data = {
        detail: 'The user used for authentication is suspended',
        title: 'Forbidden',
      };

      const fakeClient: any = {
        v2: { me: vi.fn().mockRejectedValue(suspendedErr) },
      };

      let thrown: any;
      try {
        await (provider as any)._getUserInfo(fakeClient);
      } catch (e) {
        thrown = e;
      }

      expect(thrown).toBeDefined();
      expect(thrown.message).toContain('suspended');
      // Not a RefreshToken — the user needs to take a different action.
      expect(thrown.type).toBeUndefined();
    });
  });
});
