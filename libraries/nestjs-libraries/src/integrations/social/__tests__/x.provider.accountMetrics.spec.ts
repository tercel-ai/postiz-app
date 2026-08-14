import { describe, it, expect, beforeEach, vi } from 'vitest';

// Same preamble as x.provider.suspended.spec.ts: XProvider constructs a static
// PrismaClient and imports native deps at module load.
vi.mock('@prisma/client', () => {
  return {
    PrismaClient: class {
      integration = { findUnique: vi.fn(), update: vi.fn() };
      notifications = { create: vi.fn() };
    },
  };
});
vi.mock('twitter-api-v2', () => ({ TwitterApi: class {}, TweetV2: class {} }));
vi.mock('@gitroom/helpers/utils/read.or.fetch', () => ({ readOrFetch: vi.fn() }));
vi.mock('sharp', () => ({ default: vi.fn() }));
vi.mock('mime-types', () => ({ lookup: vi.fn() }));

import { XProvider } from '../x.provider';
import { RefreshToken } from '@gitroom/nestjs-libraries/integrations/social.abstract';

/**
 * `accountMetrics` mapping a 401 to RefreshToken is the trigger for the entire
 * reactive-refresh recovery in DataTicksService. Nothing downstream can tell
 * that this predicate is wrong: a miss falls through to `console.error` +
 * `return null`, which is exactly the pre-fix behaviour, so every other test in
 * the suite still passes while dead tokens are never refreshed or flagged.
 */
describe('XProvider.accountMetrics — token rejection', () => {
  let provider: XProvider;

  function stubClient(behaviour: () => Promise<unknown>) {
    vi.spyOn(provider as any, 'getClient').mockResolvedValue({
      v2: { me: vi.fn().mockImplementation(behaviour) },
    });
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.DISABLE_X_ANALYTICS;
    provider = new XProvider();
    // Redis-backed; irrelevant to the error mapping and unavailable in unit tests.
    vi.spyOn(provider as any, '_isRateLimited').mockResolvedValue(false);
    vi.spyOn(provider as any, '_setRateLimited').mockResolvedValue(undefined);
  });

  // twitter-api-v2 puts the HTTP status on `code`, but the two pre-existing 401
  // handlers in this file also read `data.status` and `status` — so all three
  // shapes must map to RefreshToken, or the fix is inert for the ones missed.
  it.each([
    ['code', { code: 401, data: { title: 'Unauthorized', status: 401, detail: 'Unauthorized' } }],
    ['data.status only', { data: { status: 401, title: 'Unauthorized' } }],
    ['status only', { status: 401 }],
  ])('throws RefreshToken when the 401 arrives on %s', async (_shape, err) => {
    stubClient(async () => {
      throw err;
    });

    await expect(provider.accountMetrics('int-1', 'dead-token')).rejects.toBeInstanceOf(
      RefreshToken
    );
  });

  // 403 suspension and 429 rate limiting are NOT dead tokens; they own earlier
  // branches and must keep resolving to null.
  it('returns null for a suspended account rather than forcing a reconnect', async () => {
    vi.spyOn(provider as any, '_safeFireSuspendedNotification').mockReturnValue(undefined);
    stubClient(async () => {
      throw {
        code: 403,
        data: {
          status: 403,
          detail: 'The user used for authentication is suspended',
          type: 'https://api.twitter.com/2/problems/user-suspended',
        },
      };
    });

    await expect(provider.accountMetrics('int-1', 'token')).resolves.toBeNull();
  });

  it('returns null when rate limited', async () => {
    stubClient(async () => {
      throw { code: 429, rateLimit: { reset: 1_700_000_000 } };
    });

    await expect(provider.accountMetrics('int-1', 'token')).resolves.toBeNull();
  });

  it('returns null for any other provider error', async () => {
    stubClient(async () => {
      throw { code: 500, data: { detail: 'Internal error' } };
    });

    await expect(provider.accountMetrics('int-1', 'token')).resolves.toBeNull();
  });

  it('returns the public metrics on success', async () => {
    stubClient(async () => ({
      data: {
        public_metrics: {
          followers_count: 42,
          following_count: 7,
          tweet_count: 100,
          listed_count: 3,
        },
      },
    }));

    await expect(provider.accountMetrics('int-1', 'token')).resolves.toEqual({
      followers: 42,
      following: 7,
      posts: 100,
      listed: 3,
    });
  });
});
