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
    // Sanity-check: this fix is strictly additive. We did NOT touch handleErrors,
    // so suspended bodies still hit the existing generic 403 branch (with the
    // pre-existing message). This test pins that contract so a future regression
    // doesn't silently change classification — a separate PR can fix the misleading
    // 403 message if/when we want to surface the suspended state on the post detail
    // page as well as in the in-app notification.
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
      // Pre-existing (misleading) message — out of scope for this notification fix
      expect(result?.value).toContain('character limit');
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
      expect(result?.value).toContain('character limit');
    });
  });
});
